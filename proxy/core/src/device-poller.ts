import type { ProxyConfig, ProviderName } from "./types.ts";
import type { SecretStore } from "./secret-store.ts";
import type { ControlIdentity } from "./control-capability.ts";
import { DEVICE_TOKEN_ACCOUNT } from "./device-cloud.ts";
import { ensureDeviceSyncKeypair, loadActiveSyncConfig, SyncEnvelopeApplier, type SignedSyncEnvelope } from "./sync-envelope.ts";
import { syncStatePath } from "./paths.ts";
import { updateConfig } from "./config.ts";
import { asDataRecord as object } from "@uptokey/sync-contract/plain-data";
import type { WebAuthnCounterCoordinator } from "./webauthn-counter.ts";
import { MAX_CONTROL_RESPONSE_BYTES, readBoundedJson } from "@uptokey/sync-contract/limits";
import { cancelStream } from "./stream-lifecycle.ts";
import { createDeadline } from "./deadline.ts";

export const DEVICE_POLL_INTERVAL_MS = 60_000;
type ApplyConfig = (signed: SignedSyncEnvelope, identity: ControlIdentity) => Promise<unknown>;
export type DeviceEntitlementObservation = {observedAt: string; status: "active" | "suspended"; revision: number; updatedAt?: string; nextBilledAt?: string; scheduledCancellationAt?: string};

export class DeviceConfigPoller {
  private entitlement?: DeviceEntitlementObservation;
  entitlementObservation(): DeviceEntitlementObservation | undefined { return this.entitlement ? {...this.entitlement} : undefined; }
  private timer?: ReturnType<typeof setTimeout>;
  private inFlight?: AbortController;
  private generation = 0;
  private stopped = true;
  private readonly controlPlaneOrigin: string; private readonly config: ProxyConfig; private readonly secrets: SecretStore; private readonly identity: ControlIdentity;
  private readonly options: { fetcher?: typeof fetch; applyConfig?: ApplyConfig; now?: () => Date; intervalMs?: number; requestTimeoutMs?: number; onRevoked?: () => Promise<void>; counterCoordinator?: WebAuthnCounterCoordinator; invalidateProviderCache?: (provider: ProviderName) => Promise<void> };
  constructor(controlPlaneOrigin: string, config: ProxyConfig, secrets: SecretStore, identity: ControlIdentity, options: { fetcher?: typeof fetch; applyConfig?: ApplyConfig; now?: () => Date; intervalMs?: number; requestTimeoutMs?: number; onRevoked?: () => Promise<void>; counterCoordinator?: WebAuthnCounterCoordinator; invalidateProviderCache?: (provider: ProviderName) => Promise<void> } = {}) { this.controlPlaneOrigin = controlPlaneOrigin; this.config = config; this.secrets = secrets; this.identity = identity; this.options = options; }

  start(): void { if (!this.stopped) return; this.stopped = false; this.generation += 1; void this.tick(this.generation); }
  stop(): void { this.entitlement = undefined; this.stopped = true; this.generation += 1; if (this.timer) clearTimeout(this.timer); this.timer = undefined; this.inFlight?.abort(); }

  async pollOnce(signal?: AbortSignal): Promise<"updated" | "unchanged" | "revoked" | "suspended" | "unauthenticated"> {
    assertPollActive(signal);
    const token = await this.secrets.get(DEVICE_TOKEN_ACCOUNT);
    if (!token) { this.stop(); return "unauthenticated"; }
    assertPollActive(signal);
    if (!this.options.applyConfig) await this.recoverAppliedSyncState(signal);
    assertPollActive(signal);
    const deadline = createDeadline(this.options.requestTimeoutMs ?? 8_000); const requestSignal = signal ? AbortSignal.any([signal, deadline.signal]) : deadline.signal;
    let response: Response; let raw: unknown;
    try {
      try { response = await (this.options.fetcher ?? fetch)(new URL("/device/config", validatedOrigin(this.controlPlaneOrigin)), { headers: { authorization: `Bearer ${token}` }, cache: "no-store", redirect: "error", signal: requestSignal }); }
      catch { throw new Error(signal?.aborted ? "device_poll_cancelled" : deadline.signal.aborted ? "device_poll_timeout" : "device_poll_failed"); }
      assertPollActive(signal);
      if (![200, 401, 403, 410].includes(response.status)) { cancelStream(response.body); throw new Error("device_poll_failed"); }
      raw = await pollJson(response);
    } finally { deadline.clear(); }
    assertPollActive(signal);
    const now = (this.options.now ?? (() => new Date()))();
    if (response.status === 410) {
      const body = parseRevoked(raw); const persisted = await updateConfig((latest) => {
        latest.deviceRevokedAt = body.revokedAt ?? now.toISOString(); bindControlPlaneContact(latest, this.identity, now);
      }); Object.assign(this.config, persisted);
      await this.secrets.delete(DEVICE_TOKEN_ACCOUNT); this.stop(); if (this.options.onRevoked) await this.options.onRevoked(); return "revoked";
    }
    if (response.status === 401) { parseUnauthorized(raw); await this.secrets.delete(DEVICE_TOKEN_ACCOUNT); this.stop(); return "unauthenticated"; }
    if (response.status === 403) {
      const body = parseSuspended(raw);
      const persisted = await updateConfig((latest) => { latest.entitlementSuspendedAt = validTimestamp(body.entitlement.updatedAt) ?? now.toISOString(); latest.entitlementRevision = body.entitlement.revision; bindControlPlaneContact(latest, this.identity, now); }); Object.assign(this.config, persisted);
      assertPollActive(signal);
      this.entitlement = entitlementObservation(raw, now);
      return "suspended";
    }
    const body = parseActive(raw);
    let updated = false; let synced: unknown;
    if (body.config?.envelope && body.config.webauthnAssertion) {
      try {
        synced = await (this.options.applyConfig ?? this.applySigned.bind(this))({ envelope: body.config.envelope, webauthnAssertion: body.config.webauthnAssertion } as SignedSyncEnvelope, this.identity); assertPollActive(signal); updated = true;
      } catch (error) { if (!(error instanceof Error) || !/sync_(?:replay|downgrade)_rejected/.test(error.message)) throw error; }
    }
    const persisted = await updateConfig((latest) => { if (updated) { mergeSyncedConfig(latest, synced); latest.appliedConfigVersion = configEnvelopeVersion(body.config!.envelope); latest.appliedConfigTenantId = this.identity.tenantId; latest.appliedConfigDeviceId = this.identity.deviceId; } bindControlPlaneContact(latest, this.identity, now); latest.entitlementRevision = body.entitlement.revision; delete latest.deviceRevokedAt; delete latest.entitlementSuspendedAt; }); Object.assign(this.config, persisted);
    await this.invalidateDisabledProviderCaches(persisted);
    assertPollActive(signal);
    this.entitlement = entitlementObservation(raw, now);
    return updated ? "updated" : "unchanged";
  }

  private async applySigned(signed: SignedSyncEnvelope, identity: ControlIdentity): Promise<unknown> {
    const pair = await ensureDeviceSyncKeypair(this.secrets);
    return new SyncEnvelopeApplier(syncStatePath(), undefined, validateSyncedConfig, this.options.counterCoordinator).apply(signed, { tenantId: identity.tenantId, deviceId: identity.deviceId, recipientPrivateKey: pair.privateKey, credential: { id: identity.credential.id, publicKey: identity.credential.publicKey, transports: identity.credential.transports }, initialWebauthnCounter: identity.credential.counter, expectedOrigin: identity.expectedOrigin, expectedRPID: identity.expectedRPID, counterIdentity: identity });
  }

  private async recoverAppliedSyncState(signal?: AbortSignal): Promise<void> {
    const recovered = await loadActiveSyncConfig(syncStatePath(), { tenantId: this.identity.tenantId, deviceId: this.identity.deviceId }, validateSyncedConfig);
    assertPollActive(signal);
    const appliedMatchesIdentity = this.config.appliedConfigTenantId === this.identity.tenantId && this.config.appliedConfigDeviceId === this.identity.deviceId;
    if (!recovered || appliedMatchesIdentity && (this.config.appliedConfigVersion ?? 0) >= recovered.version) return;
    const persisted = await updateConfig((latest) => {
      const latestMatchesIdentity = latest.appliedConfigTenantId === this.identity.tenantId && latest.appliedConfigDeviceId === this.identity.deviceId;
      if (latestMatchesIdentity && (latest.appliedConfigVersion ?? 0) >= recovered.version) return;
      mergeSyncedConfig(latest, recovered.config); latest.appliedConfigVersion = recovered.version; latest.appliedConfigTenantId = this.identity.tenantId; latest.appliedConfigDeviceId = this.identity.deviceId;
    });
    Object.assign(this.config, persisted);
  }

  private async tick(generation: number): Promise<void> {
    if (this.stopped || generation !== this.generation) return;
    const controller = new AbortController(); this.inFlight = controller;
    try { await this.pollOnce(controller.signal); } catch { /* falha de rede não renova o grace e não altera configuração */ }
    finally { if (this.inFlight === controller) this.inFlight = undefined; }
    if (!this.stopped && generation === this.generation) this.timer = setTimeout(() => void this.tick(generation), this.options.intervalMs ?? DEVICE_POLL_INTERVAL_MS);
  }

  private async invalidateDisabledProviderCaches(config: ProxyConfig): Promise<void> {
    if (!this.options.invalidateProviderCache) return;
    for (const provider of ["groq", "gemini"] as const) if (!config.providers[provider].enabled) await this.options.invalidateProviderCache(provider);
  }
}

function bindControlPlaneContact(config: ProxyConfig, identity: ControlIdentity, now: Date): void {
  config.lastControlPlaneContact = now.toISOString(); config.lastControlPlaneContactTenantId = identity.tenantId; config.lastControlPlaneContactDeviceId = identity.deviceId; config.lastObservedWallClock = now.toISOString();
}

function mergeSyncedConfig(target: ProxyConfig, value: unknown): void {
  validateSyncedConfig(value);
  const input = value as { fallbackOrder?: unknown; providers?: unknown };
  if (input.fallbackOrder !== undefined) {
    if (!Array.isArray(input.fallbackOrder) || input.fallbackOrder.length !== 2 || new Set(input.fallbackOrder).size !== 2 || !input.fallbackOrder.every(isProvider)) throw new Error("synced_config_invalid");
    target.fallbackOrder = [...input.fallbackOrder];
  }
  if (input.providers !== undefined) {
    if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers)) throw new Error("synced_config_invalid");
    for (const provider of ["groq", "gemini"] as const) {
      const item = (input.providers as Record<string, unknown>)[provider]; if (item === undefined) continue;
      if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).some((key) => key !== "enabled") || typeof (item as { enabled?: unknown }).enabled !== "boolean") throw new Error("synced_config_invalid");
      target.providers[provider].enabled = (item as { enabled: boolean }).enabled;
    }
  }
}

export function validateSyncedConfig(value: unknown): void {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length === 0 || Object.keys(value).some((key) => key !== "fallbackOrder" && key !== "providers")) throw new Error("synced_config_invalid");
  const input = value as { fallbackOrder?: unknown; providers?: unknown };
  if (input.fallbackOrder !== undefined && (!Array.isArray(input.fallbackOrder) || input.fallbackOrder.length !== 2 || new Set(input.fallbackOrder).size !== 2 || !input.fallbackOrder.every(isProvider))) throw new Error("synced_config_invalid");
  if (input.providers !== undefined) {
    if (!input.providers || typeof input.providers !== "object" || Array.isArray(input.providers) || Object.keys(input.providers).sort().join(",") !== "gemini,groq") throw new Error("synced_config_invalid");
    for (const item of Object.values(input.providers)) if (!item || typeof item !== "object" || Array.isArray(item) || Object.keys(item).length !== 1 || Object.keys(item)[0] !== "enabled" || typeof (item as { enabled?: unknown }).enabled !== "boolean") throw new Error("synced_config_invalid");
  }
}

function isProvider(value: unknown): value is ProviderName { return value === "groq" || value === "gemini"; }
function validatedOrigin(value: string): URL { const url = new URL(value); const local = url.protocol === "http:" && ["127.0.0.1", "localhost"].includes(url.hostname); if ((!local && url.protocol !== "https:") || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("control_plane_origin_invalid"); return url; }
function validTimestamp(value: unknown): string | undefined { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)) ? value : undefined; }

async function pollJson(response: Response): Promise<unknown> { const parsed = await readBoundedJson(response, MAX_CONTROL_RESPONSE_BYTES); if (!parsed.ok) throw new Error(parsed.reason === "too_large" ? "device_poll_response_too_large" : "device_poll_response_invalid"); return parsed.value; }
function parseRevoked(value: unknown): { revokedAt?: string } { const item = object(value); if (!item || Object.keys(item).some((key) => key !== "status" && key !== "revokedAt") || item.status !== "revoked" || item.revokedAt !== undefined && !validTimestamp(item.revokedAt)) throw new Error("device_poll_response_invalid"); return item.revokedAt === undefined ? {} : { revokedAt: item.revokedAt as string }; }
function parseUnauthorized(value: unknown): void { const item = object(value), error = object(item?.error); if (!item || Object.keys(item).length !== 1 || !error || Object.keys(error).length !== 1 || error.type !== "unauthorized") throw new Error("device_poll_response_invalid"); }
/** Billing schedule fields are display metadata; they never replace the explicit entitlement status. */
function validEntitlementMetadata(value: Record<string, unknown>): boolean {
  const dates = ["updatedAt", "nextBilledAt", "scheduledCancellationAt"];
  return !(value.nextBilledAt !== undefined && value.scheduledCancellationAt !== undefined) &&
    !(value.status === "suspended" && (value.nextBilledAt !== undefined || value.scheduledCancellationAt !== undefined)) &&
    Object.keys(value).every(key => key === "status" || key === "revision" || dates.includes(key)) &&
    dates.every(key => value[key] === undefined || Boolean(validTimestamp(value[key])));
}
/** Called only after the full device response has passed validation and persistence. */
function entitlementObservation(raw: unknown, now: Date): DeviceEntitlementObservation {
  const value = (raw as {entitlement: Omit<DeviceEntitlementObservation,"observedAt">}).entitlement;
  return {observedAt:now.toISOString(),status:value.status,revision:value.revision,
    ...(value.updatedAt === undefined ? {} : {updatedAt:value.updatedAt}),
    ...(value.nextBilledAt === undefined ? {} : {nextBilledAt:value.nextBilledAt}),
    ...(value.scheduledCancellationAt === undefined ? {} : {scheduledCancellationAt:value.scheduledCancellationAt})};
}
function parseSuspended(value: unknown): { status: "suspended"; entitlement: { status: "suspended"; revision: number; updatedAt?: string } } { const item = object(value), entitlement = object(item?.entitlement); if (!item || Object.keys(item).sort().join(",") !== "entitlement,status" || item.status !== "suspended" || !entitlement || !validEntitlementMetadata(entitlement) || entitlement.status !== "suspended" || !safeRevision(entitlement.revision, 0) || entitlement.updatedAt !== undefined && !validTimestamp(entitlement.updatedAt)) throw new Error("device_poll_response_invalid"); return { status: "suspended", entitlement: { status: "suspended", revision: entitlement.revision, ...(entitlement.updatedAt === undefined ? {} : { updatedAt: entitlement.updatedAt as string }) } }; }
function parseActive(value: unknown): { status: "active"; entitlement: { status: "active"; revision: number }; config: { envelope: unknown; webauthnAssertion: unknown } | null } { const item = object(value), entitlement = object(item?.entitlement); if (!item || Object.keys(item).sort().join(",") !== "config,entitlement,status" || item.status !== "active" || !entitlement || !validEntitlementMetadata(entitlement) || !Object.hasOwn(entitlement, "revision") || !Object.hasOwn(entitlement, "status") || entitlement.status !== "active" || !safeRevision(entitlement.revision, 1) || entitlement.updatedAt !== undefined && !validTimestamp(entitlement.updatedAt) || item.config !== null && !validSignedConfig(item.config)) throw new Error("device_poll_response_invalid"); return { status: "active", entitlement: { status: "active", revision: entitlement.revision }, config: item.config as { envelope: unknown; webauthnAssertion: unknown } | null }; }
function validSignedConfig(value: unknown): boolean { const item = object(value); return Boolean(item && Object.keys(item).sort().join(",") === "envelope,webauthnAssertion" && object(item.envelope) && safeRevision(object(item.envelope)?.config_version, 1) && item.webauthnAssertion && typeof item.webauthnAssertion === "object"); }
function configEnvelopeVersion(value: unknown): number { const version = object(value)?.config_version; if (!safeRevision(version, 1)) throw new Error("device_poll_response_invalid"); return version; }
function safeRevision(value: unknown, minimum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum; }
function assertPollActive(signal?: AbortSignal): void { if (signal?.aborted) throw new Error("device_poll_cancelled"); }
