/**
 * B9-reparo (frente B) — mobilidade local-first real.
 *
 * Consumidor produtivo de VaultService sobre o transporte hospedado B8:
 * preferência explícita → identidade/dispositivo autorizado → cifra no
 * dispositivo (VK/DEK + HPKE do canal) → envelope opaco → CAS remoto →
 * confirmação/reconciliação local.
 *
 * Invariantes: chave BYOK, VK, frase de recuperação e plaintext nunca vão ao
 * servidor; bearer local e conta (Auth0) são autoridades distintas; sem
 * escrita remota em aparelho público/efêmero/desconhecido; PUT sem resposta
 * confirmada fica "pending_unconfirmed" (nunca "confirmed"); conflito preserva
 * as duas versões até resolução solicitada (sem last-write-wins); tombstone
 * e versões são monotônicos e réplica antiga é recusada; nada local é apagado
 * por confirmação incerta; revogação/encerramento cancela operações em voo e
 * descarta retornos tardios. Não reimplementa SyncDataStore (sync-data local
 * continua em workspace/http.ts).
 */
import { createHash, randomBytes } from "node:crypto";
import type { SecretStore } from "../secret-store.ts";
import type { VaultObjectEnvelope } from "../vault-crypto.ts";
import { VaultService, VaultError, type VaultOperation } from "./vault-service.ts";
import { HostedSyncClient, HostedTransportUncertainError, type HostedMode, type HostedResponse } from "./hosted-sync-client.ts";
import { sharedSinkAuthority, SinkAccessDeniedError, type SinkAuthority } from "./sink-authority.ts";

export type DeviceClass = "unknown" | "personal" | "public" | "ephemeral";
export interface MobilityPreference { readonly enabled: boolean; readonly deviceClass: DeviceClass; readonly revision: number }
export type ObjectSyncState = "local_only" | "pending_unconfirmed" | "confirmed" | "conflict" | "remote_tombstone";

interface ObjectState {
  confirmedVersion: number;
  confirmedDigest?: string;
  remoteState?: "live" | "tombstone";
  localDigest?: string;
  pending?: { targetVersion: number; digest: string };
  conflict?: { remoteVersion: number; remoteDigest: string };
}
interface PrincipalState {
  v: 1;
  preference: MobilityPreference;
  device?: { deviceId: string; enrolledAt: string };
  objects: Record<string, ObjectState>;
}

export type MobilityResult =
  | { state: "confirmed"; version: number }
  | { state: "pending_unconfirmed"; reason: string }
  | { state: "conflict"; localVersion: number; remoteVersion: number }
  | { state: "restored"; version: number }
  | { state: "unchanged"; version: number }
  | { state: "remote_tombstone"; version: number }
  | { state: "not_found" }
  | { state: "cancelled" }
  | { state: "refused"; code: string; status: number };

export class MobilityError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400) { super(code); this.code = code; this.status = status; this.name = "MobilityError"; }
}

const OBJECT_ID = /^[A-Za-z0-9_:-]{3,100}$/;
const MAX_PAYLOAD_BYTES = 16 * 1024;
const DEFAULT_PREFERENCE: MobilityPreference = { enabled: false, deviceClass: "unknown", revision: 0 };

class Cancelled extends Error { constructor() { super("mobility_cancelled"); } }

export interface MobilityServiceOptions {
  vault?: VaultService;
  hosted?: HostedSyncClient;
  sinkAuthority?: SinkAuthority;
  now?: () => number;
  /** Test seam: awaited between crypto and network steps. */
  checkpoint?: (step: "sealed" | "opened" | "before_network") => Promise<void>;
  /** Optional native account admission; no account is required for local work. */
  revalidate?:()=>Promise<void>;
}

export class MobilityService {
  private readonly secrets: Pick<SecretStore, "get" | "set" | "delete">;
  private readonly vault: VaultService;
  private readonly hosted: HostedSyncClient | undefined;
  private readonly sinks: SinkAuthority;
  private readonly now: () => number;
  private readonly checkpoint: MobilityServiceOptions["checkpoint"];
  private readonly revalidate: MobilityServiceOptions['revalidate'];
  private readonly generations = new Map<string, number>();
  private readonly controllers = new Map<string, Set<AbortController>>();
  private readonly serial = new Map<string, Promise<unknown>>();
  private readonly preferenceSerial = new Map<string, Promise<unknown>>();
  private readonly preferenceChanging = new Set<string>();
  private readonly unsubscribe: () => void;

  constructor(secrets: Pick<SecretStore, "get" | "set" | "delete">, options: MobilityServiceOptions = {}) {
    this.secrets = secrets;
    this.sinks = options.sinkAuthority ?? sharedSinkAuthority();
    this.vault = options.vault ?? new VaultService(secrets as SecretStore, { sinkPolicy: this.sinks,...(options.revalidate?{revalidate:options.revalidate}:{}) });
    this.hosted = options.hosted;
    this.now = options.now ?? Date.now;
    this.checkpoint = options.checkpoint;
    this.revalidate=options.revalidate;
    // Revogação/rotação/encerramento de sessão cancelam operações em voo.
    this.unsubscribe = this.sinks.onEnd((event) => {
      if (event.principalId) this.cancel(event.principalId);
      if (event.credentialId) for (const principal of [...this.generations.keys()]) if (principal.endsWith(`_${event.credentialId}`)) this.cancel(principal);
    });
  }

  dispose(): void { this.unsubscribe(); for (const principal of this.controllers.keys()) this.cancel(principal); }

  /** Cancela operações pendentes; retornos tardios são descartados sem escrita local. */
  cancel(principalId: string): void {
    this.generations.set(principalId, (this.generations.get(principalId) ?? 0) + 1);
    for (const controller of this.controllers.get(principalId) ?? []) controller.abort();
    this.controllers.get(principalId)?.clear();
  }

  remoteAvailability(): { available: boolean; reason?: string } {
    if (!this.hosted) return { available: false, reason: "hosted_transport_unconfigured" };
    return this.hosted.availability();
  }

  async status(principalId: string): Promise<{ preference: MobilityPreference; enrolled: boolean; remote: { available: boolean; reason?: string }; remoteWriteAllowed: boolean; objects: Record<string, { sync: ObjectSyncState; confirmedVersion: number }> }> {
    const state = await this.load(principalId);
    const objects: Record<string, { sync: ObjectSyncState; confirmedVersion: number }> = {};
    for (const [id, object] of Object.entries(state.objects).sort(([a], [b]) => a.localeCompare(b))) objects[id] = { sync: syncState(object), confirmedVersion: object.confirmedVersion };
    return { preference: state.preference, enrolled: state.device !== undefined, remote: this.remoteAvailability(), remoteWriteAllowed: this.remoteWriteAllowed(principalId, state), objects };
  }

  async setPreference(principalId: string, input: unknown): Promise<MobilityPreference> {
    if (!input || typeof input !== "object" || Array.isArray(input)) throw new MobilityError("mobility_preference_invalid");
    const record = input as Record<string, unknown>;
    if (Object.keys(record).some((key) => !["enabled", "deviceClass", "expectedRevision"].includes(key))) throw new MobilityError("mobility_preference_invalid");
    if (typeof record.enabled !== "boolean" || !["unknown", "personal", "public", "ephemeral"].includes(record.deviceClass as string) || !Number.isSafeInteger(record.expectedRevision)) throw new MobilityError("mobility_preference_invalid");
    // Policy changes have a short, separate decision lock. Never wait behind a
    // network operation before invalidating its authority. Invalid CAS is inert.
    const previous = this.preferenceSerial.get(principalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(async () => {
      const observed = await this.load(principalId);
      if (observed.preference.revision !== record.expectedRevision) throw new MobilityError("mobility_preference_conflict", 409);
      this.preferenceChanging.add(principalId);
      this.cancel(principalId);
      try {
        return await this.exclusive(principalId, async () => {
          // Reload after cancelled operations unwind: preserve their pending WAL.
          const state = await this.load(principalId);
          if (state.preference.revision !== record.expectedRevision) throw new MobilityError("mobility_preference_conflict", 409);
          const next: MobilityPreference = { enabled: record.enabled as boolean, deviceClass: record.deviceClass as DeviceClass, revision: state.preference.revision + 1 };
          state.preference = next;
          if (next.deviceClass !== "personal") delete state.device;
          await this.save(principalId, state);
          return next;
        });
      } finally { this.preferenceChanging.delete(principalId); }
    });
    this.preferenceSerial.set(principalId, run.catch(() => undefined));
    return run;
  }

  async enroll(principalId: string): Promise<{ deviceId: string; channelId: string }> {
    return this.exclusive(principalId, async () => {
      const state = await this.load(principalId);
      this.assertRemoteWrite(principalId, state, false);
      const channelId = await this.vault.hostedChannelId();
      if (!state.device) state.device = { deviceId: `dev-${randomBytes(12).toString("hex")}`, enrolledAt: new Date(this.now()).toISOString() };
      await this.save(principalId, state);
      return { deviceId: state.device.deviceId, channelId };
    });
  }

  /** Escrita local: nunca marca sincronizado. */
  async writeLocal(principalId: string, objectId: string, payload: Uint8Array): Promise<{ sync: ObjectSyncState; digest: string }> {
    assertObject(objectId, payload);
    return this.exclusive(principalId, async () => {
      this.sinks.assertSinkAllowed(principalId, "vault:objects");
      const state = await this.load(principalId);
      const object = state.objects[objectId] ?? { confirmedVersion: 0 };
      await this.sealLocal(principalId, state, "local", objectId, payload);
      object.localDigest = digest(payload);
      state.objects[objectId] = object;
      await this.save(principalId, state);
      return { sync: syncState(object), digest: object.localDigest };
    });
  }

  async readLocal(principalId: string, objectId: string): Promise<{ payload: Uint8Array; sync: ObjectSyncState; confirmedVersion: number } | undefined> {
    if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
    const state = await this.load(principalId);
    const object = state.objects[objectId];
    if (!object?.localDigest) return undefined;
    const payload = await this.openLocal(principalId, state, "local", objectId);
    return { payload, sync: syncState(object), confirmedVersion: object.confirmedVersion };
  }

  async push(principalId: string, objectId: string, signal?: AbortSignal): Promise<MobilityResult> {
    if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
    return this.exclusive(principalId, () => this.withOperation(principalId, signal, async (op) => {
      const state = await this.load(principalId);
      this.assertRemoteWrite(principalId, state, true);
      const object = state.objects[objectId];
      if (!object?.localDigest) throw new MobilityError("mobility_local_missing", 404);
      if (object.conflict) return conflictResult(object);
      if (object.pending) {
        const reconciled = await this.reconcilePending(principalId, state, objectId, object, op);
        if (reconciled) return reconciled;
      }
      if (object.localDigest === object.confirmedDigest && object.remoteState === "live") return { state: "confirmed", version: object.confirmedVersion } as MobilityResult;
      const expected = object.confirmedVersion;
      const target = expected + 1;
      const payload = await this.openLocal(principalId, state, "local", objectId);
      op.check();
      const envelope = await this.sealHosted(principalId, state, objectId, target, payload);
      await this.checkpoint?.("sealed");
      op.check();
      // Write-ahead: tentativa registrada antes da rede; resultado incerto continua pendente.
      object.pending = { targetVersion: target, digest: digest(payload) };
      await this.save(principalId, state);
      await this.checkpoint?.("before_network");
      op.check();
      let response: HostedResponse;
      try {
        response = await this.hosted!.request("sync", objectId, "PUT", { envelope, expectedVersion: expected, deviceId: state.device!.deviceId }, this.mode(principalId, state), op.signal);
      } catch (error) {
        if (error instanceof HostedTransportUncertainError) return op.cancelled() ? { state: "cancelled" } : { state: "pending_unconfirmed", reason: error.message };
        throw error;
      }
      // Retorno tardio após revogação/encerramento: descartado sem confirmar localmente.
      if (op.cancelled()) return { state: "cancelled" };
      if (response.ok) {
        const version = response.body.version;
        if (version !== target) return { state: "pending_unconfirmed", reason: "hosted_version_unexpected" };
        object.confirmedVersion = target;
        object.confirmedDigest = object.pending.digest;
        object.remoteState = "live";
        delete object.pending;
        await this.save(principalId, state);
        return { state: "confirmed", version: target };
      }
      if (response.status === 409 && response.code === "hosted_sync_conflict") {
        delete object.pending;
        await this.save(principalId, state);
        return this.captureRemote(principalId, state, objectId, object, op);
      }
      if (response.status >= 500 || response.status === 429) return { state: "pending_unconfirmed", reason: response.code };
      delete object.pending;
      await this.save(principalId, state);
      return { state: "refused", code: response.code, status: response.status };
    }));
  }

  async pull(principalId: string, objectId: string, signal?: AbortSignal): Promise<MobilityResult> {
    if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
    return this.exclusive(principalId, () => this.withOperation(principalId, signal, async (op) => {
      const state = await this.load(principalId);
      this.assertRemoteRead(principalId, state);
      const object = state.objects[objectId] ?? { confirmedVersion: 0 };
      state.objects[objectId] = object;
      if (object.conflict) return conflictResult(object);
      if (object.pending) {
        const reconciled = await this.reconcilePending(principalId, state, objectId, object, op);
        if (reconciled && reconciled.state !== "confirmed") return reconciled;
      }
      const response = await this.remoteGet(principalId, state, objectId, op);
      if ("state" in response) return response;
      if (!response.ok) {
        if (response.status === 404) return { state: "not_found" };
        return { state: "refused", code: response.code, status: response.status };
      }
      const version = response.body.version;
      if (typeof version !== "number" || !Number.isSafeInteger(version) || version < 1) return { state: "refused", code: "hosted_response_invalid", status: 502 };
      if (version < object.confirmedVersion) return { state: "refused", code: "mobility_replay_refused", status: 409 };
      const unpushed = object.localDigest !== undefined && object.localDigest !== object.confirmedDigest;
      if (response.body.state === "tombstone") {
        if (version === object.confirmedVersion && object.remoteState === "tombstone") return { state: "remote_tombstone", version };
        if (version === object.confirmedVersion) return { state: "refused", code: "mobility_replay_refused", status: 409 };
        if (unpushed) {
          object.conflict = { remoteVersion: version, remoteDigest: "tombstone" };
          await this.save(principalId, state);
          return conflictResult(object);
        }
        // Tombstone remoto não apaga o dado local: apenas registra a revisão.
        object.confirmedVersion = version;
        object.remoteState = "tombstone";
        await this.save(principalId, state);
        return { state: "remote_tombstone", version };
      }
      if (response.body.state !== "live") return { state: "refused", code: "hosted_response_invalid", status: 502 };
      let payload: Uint8Array;
      try {
        payload = await this.openHosted(principalId, state, objectId, version, response.body.envelope);
      } catch (error) {
        if (error instanceof VaultError && error.code === "hosted_envelope_invalid") return { state: "refused", code: error.code, status: 403 };
        throw error;
      }
      await this.checkpoint?.("opened");
      op.check();
      const remoteDigest = digest(payload);
      if (version === object.confirmedVersion) {
        if (object.confirmedDigest !== undefined && remoteDigest !== object.confirmedDigest) return { state: "refused", code: "mobility_envelope_mismatch", status: 409 };
        return { state: "unchanged", version };
      }
      if (unpushed && remoteDigest !== object.localDigest) {
        await this.sealLocal(principalId, state, "remote", objectId, payload);
        op.check();
        object.conflict = { remoteVersion: version, remoteDigest };
        await this.save(principalId, state);
        return conflictResult(object);
      }
      await this.sealLocal(principalId, state, "local", objectId, payload);
      op.check();
      object.localDigest = remoteDigest;
      object.confirmedDigest = remoteDigest;
      object.confirmedVersion = version;
      object.remoteState = "live";
      await this.save(principalId, state);
      return { state: "restored", version };
    }));
  }

  /** DELETE com CAS: cria tombstone remoto; o dado local permanece. */
  async remove(principalId: string, objectId: string, signal?: AbortSignal): Promise<MobilityResult> {
    if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
    return this.exclusive(principalId, () => this.withOperation(principalId, signal, async (op) => {
      const state = await this.load(principalId);
      this.assertRemoteWrite(principalId, state, true);
      const object = state.objects[objectId];
      if (!object || object.confirmedVersion < 1) return { state: "not_found" } as MobilityResult;
      if (object.conflict) return conflictResult(object);
      if (object.pending || object.localDigest !== object.confirmedDigest) throw new MobilityError("mobility_unpushed_changes", 409);
      let response: HostedResponse;
      try {
        response = await this.hosted!.request("sync", objectId, "DELETE", { expectedVersion: object.confirmedVersion }, this.mode(principalId, state), op.signal);
      } catch (error) {
        if (error instanceof HostedTransportUncertainError) return op.cancelled() ? { state: "cancelled" } : { state: "pending_unconfirmed", reason: error.message };
        throw error;
      }
      if (op.cancelled()) return { state: "cancelled" };
      if (response.ok && typeof response.body.version === "number" && response.body.version > object.confirmedVersion) {
        object.confirmedVersion = response.body.version;
        object.remoteState = "tombstone";
        await this.save(principalId, state);
        return { state: "remote_tombstone", version: object.confirmedVersion };
      }
      if (!response.ok && response.status === 409 && response.code === "hosted_sync_conflict") return this.captureRemote(principalId, state, objectId, object, op);
      return response.ok ? { state: "refused", code: "hosted_response_invalid", status: 502 } : { state: "refused", code: response.code, status: response.status };
    }));
  }

  /** Resolução solicitada e determinística; sem ela as duas versões permanecem. */
  async resolve(principalId: string, objectId: string, choice: unknown, signal?: AbortSignal): Promise<MobilityResult> {
    if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
    if (choice !== "keep_local" && choice !== "take_remote") throw new MobilityError("mobility_resolution_invalid");
    const outcome = await this.exclusive(principalId, async (): Promise<"push" | MobilityResult> => {
      const state = await this.load(principalId);
      const object = state.objects[objectId];
      if (!object?.conflict) throw new MobilityError("mobility_conflict_absent", 409);
      const { remoteVersion, remoteDigest } = object.conflict;
      if (choice === "keep_local") {
        this.assertRemoteWrite(principalId, state, true);
        object.confirmedVersion = remoteVersion;
        object.confirmedDigest = remoteDigest === "tombstone" ? undefined : remoteDigest;
        object.remoteState = remoteDigest === "tombstone" ? "tombstone" : "live";
        delete object.conflict;
        await this.save(principalId, state);
        return "push";
      }
      if (remoteDigest === "tombstone") {
        object.confirmedVersion = remoteVersion;
        object.confirmedDigest = object.localDigest;
        object.remoteState = "tombstone";
      } else {
        const payload = await this.openLocal(principalId, state, "remote", objectId);
        await this.sealLocal(principalId, state, "local", objectId, payload);
        object.localDigest = remoteDigest;
        object.confirmedDigest = remoteDigest;
        object.confirmedVersion = remoteVersion;
        object.remoteState = "live";
      }
      delete object.conflict;
      await this.save(principalId, state);
      await this.writeValue(this.key(principalId, `remote:${objectId}`),undefined);
      return { state: remoteDigest === "tombstone" ? "remote_tombstone" : "restored", version: remoteVersion } as MobilityResult;
    });
    if (outcome !== "push") return outcome;
    const pushed = await this.push(principalId, objectId, signal);
    if (pushed.state === "confirmed") await this.writeValue(this.key(principalId, `remote:${objectId}`),undefined);
    return pushed;
  }

  /** Recuperação remota solicitada pelo usuário: só aparelho pessoal; a frase volta uma vez e não é persistida. */
  async createRemoteRecovery(principalId: string, input: { rotate?: boolean } = {}, signal?: AbortSignal): Promise<{ recoveryPhrase: string; version: number; vaultKeyFingerprint: string } | MobilityResult> {
    return this.exclusive(principalId, () => this.withOperation(principalId, signal, async (op) => {
      const state = await this.load(principalId);
      this.assertRemoteWrite(principalId, state, true);
      const recoveryId = this.recoveryId();
      const current = await this.remoteRequest(principalId, state, "recovery", recoveryId, "GET", undefined, op);
      if ("state" in current) return current;
      if (!current.ok && current.status !== 404) return { state: "refused", code: current.code, status: current.status };
      const expected = current.ok && typeof current.body.version === "number" ? current.body.version : 0;
      const consent = this.issue(principalId, input.rotate === true ? "vault:recovery:rotate" : "vault:recovery:create", `recovery:${principalId}`, state);
      const created = await this.vault.createRecovery({ principalId, consent, policyRevision: policyRevision(state), rotate: input.rotate === true });
      op.check();
      let envelope: unknown;
      try { envelope = JSON.parse(created.envelope); } catch { throw new MobilityError("recovery_envelope_not_portable", 409); }
      const put = await this.remoteRequest(principalId, state, "recovery", recoveryId, "PUT", { envelope, expectedVersion: expected, deviceId: state.device!.deviceId }, op);
      if ("state" in put) return put;
      if (!put.ok) return put.status === 409 ? { state: "conflict", localVersion: expected, remoteVersion: put.currentVersion ?? expected } : { state: "refused", code: put.code, status: put.status };
      return { recoveryPhrase: created.recoveryPhrase, version: put.body.version as number, vaultKeyFingerprint: created.vaultKeyFingerprint };
    }));
  }

  async restoreRemoteRecovery(principalId: string, input: { recoveryPhrase: string; replace?: boolean }, signal?: AbortSignal): Promise<{ restored: true; vaultKeyFingerprint: string; replaced: boolean } | MobilityResult> {
    if (!input || typeof input.recoveryPhrase !== "string" || input.recoveryPhrase.length < 8 || input.recoveryPhrase.length > 1024) throw new MobilityError("recovery_phrase_invalid");
    return this.exclusive(principalId, () => this.withOperation(principalId, signal, async (op) => {
      const state = await this.load(principalId);
      this.assertRemoteWrite(principalId, state, false);
      if (!this.hosted) return { state: "refused", code: "hosted_transport_unconfigured", status: 503 };
      const response = await this.remoteRequest(principalId, state, "recovery", this.recoveryId(), "GET", undefined, op);
      if ("state" in response) return response;
      if (!response.ok) return response.status === 404 ? { state: "not_found" } : { state: "refused", code: response.code, status: response.status };
      if (response.body.state !== "live") return { state: "not_found" };
      op.check();
      const consent = this.issue(principalId, "vault:recovery:restore", `recovery:${principalId}`, state);
      const replaceConsent = input.replace === true ? this.issue(principalId, "vault:recovery:replace", `recovery:${principalId}`, state) : undefined;
      const restored = await this.vault.restoreRecovery({ principalId, envelope: JSON.stringify(response.body.envelope), recoveryPhrase: input.recoveryPhrase, consent, policyRevision: policyRevision(state), ...(replaceConsent ? { replaceConsent } : {}) });
      return { restored: true, vaultKeyFingerprint: restored.vaultKeyFingerprint, replaced: restored.replaced };
    }));
  }

  // ---- internos ---------------------------------------------------------

  private recoveryId(): string { return "vault-recovery-default"; }

  private async reconcilePending(principalId: string, state: PrincipalState, objectId: string, object: ObjectState, op: Operation): Promise<MobilityResult | undefined> {
    const pending = object.pending!;
    const response = await this.remoteGet(principalId, state, objectId, op);
    if ("state" in response) return response;
    if (!response.ok) {
      if (response.status === 404 && object.confirmedVersion === 0) { delete object.pending; await this.save(principalId, state); return undefined; }
      return { state: "pending_unconfirmed", reason: response.code };
    }
    const version = response.body.version as number;
    if (version === object.confirmedVersion) { delete object.pending; await this.save(principalId, state); return undefined; }
    if (version === pending.targetVersion && response.body.state === "live") {
      let payload: Uint8Array | undefined;
      try { payload = await this.openHosted(principalId, state, objectId, version, response.body.envelope); } catch { payload = undefined; }
      op.check();
      if (payload && digest(payload) === pending.digest) {
        object.confirmedVersion = version;
        object.confirmedDigest = pending.digest;
        object.remoteState = "live";
        delete object.pending;
        await this.save(principalId, state);
        return { state: "confirmed", version };
      }
    }
    delete object.pending;
    await this.save(principalId, state);
    return this.captureFrom(principalId, state, objectId, object, response, op);
  }

  private async captureRemote(principalId: string, state: PrincipalState, objectId: string, object: ObjectState, op: Operation): Promise<MobilityResult> {
    const response = await this.remoteGet(principalId, state, objectId, op);
    if ("state" in response) return response;
    if (!response.ok) return { state: "refused", code: response.code, status: response.status };
    return this.captureFrom(principalId, state, objectId, object, response, op);
  }

  private async captureFrom(principalId: string, state: PrincipalState, objectId: string, object: ObjectState, response: Extract<HostedResponse, { ok: true }>, op: Operation): Promise<MobilityResult> {
    const version = response.body.version as number;
    if (!Number.isSafeInteger(version) || version < object.confirmedVersion) return { state: "refused", code: "mobility_replay_refused", status: 409 };
    if (response.body.state === "tombstone") {
      object.conflict = { remoteVersion: version, remoteDigest: "tombstone" };
      await this.save(principalId, state);
      return conflictResult(object);
    }
    let payload: Uint8Array;
    try { payload = await this.openHosted(principalId, state, objectId, version, response.body.envelope); }
    catch (error) {
      if (error instanceof VaultError && error.code === "hosted_envelope_invalid") return { state: "refused", code: error.code, status: 403 };
      throw error;
    }
    op.check();
    const remoteDigest = digest(payload);
    if (remoteDigest === object.localDigest) {
      object.confirmedVersion = version;
      object.confirmedDigest = remoteDigest;
      object.remoteState = "live";
      await this.save(principalId, state);
      return { state: "confirmed", version };
    }
    await this.sealLocal(principalId, state, "remote", objectId, payload);
    op.check();
    object.conflict = { remoteVersion: version, remoteDigest };
    await this.save(principalId, state);
    return conflictResult(object);
  }

  private async remoteGet(principalId: string, state: PrincipalState, objectId: string, op: Operation): Promise<HostedResponse | Extract<MobilityResult, { state: "cancelled" | "pending_unconfirmed" }>> {
    return this.remoteRequest(principalId, state, "sync", objectId, "GET", undefined, op);
  }

  private async remoteRequest(principalId: string, state: PrincipalState, kind: "sync" | "recovery", objectId: string, method: "GET" | "PUT" | "DELETE", body: unknown, op: Operation): Promise<HostedResponse | Extract<MobilityResult, { state: "cancelled" | "pending_unconfirmed" }>> {
    if (!this.hosted) return { ok: false, status: 503, code: "hosted_transport_unconfigured" };
    try {
      const response = await this.hosted.request(kind, objectId, method, body, this.mode(principalId, state), op.signal);
      if (op.cancelled()) return { state: "cancelled" };
      return response;
    } catch (error) {
      if (error instanceof HostedTransportUncertainError) return op.cancelled() ? { state: "cancelled" } : { state: "pending_unconfirmed", reason: error.message };
      throw error;
    }
  }

  /** Headers de modo derivados só da política local efetiva. */
  private mode(principalId: string, state: PrincipalState): HostedMode {
    return {
      publicDevice: state.preference.deviceClass !== "personal",
      ephemeral: state.preference.deviceClass === "ephemeral" || this.sinks.isEphemeral(principalId),
    };
  }

  private remoteWriteAllowed(principalId: string, state: PrincipalState): boolean {
    return state.preference.enabled && state.preference.deviceClass === "personal" && !this.sinks.isEphemeral(principalId) && this.remoteAvailability().available;
  }

  private assertRemoteWrite(principalId: string, state: PrincipalState, requireEnrollment: boolean): void {
    if (!state.preference.enabled) throw new MobilityError("mobility_preference_disabled", 409);
    if (state.preference.deviceClass === "ephemeral" || this.sinks.isEphemeral(principalId)) throw new MobilityError("ephemeral_mode_persistence_blocked", 403);
    if (state.preference.deviceClass !== "personal") throw new MobilityError("public_device_remote_write_refused", 403);
    this.sinks.assertSinkAllowed(principalId, "cloud:sync_upload");
    if (requireEnrollment && !state.device) throw new MobilityError("mobility_device_not_enrolled", 409);
    if (requireEnrollment && !this.hosted) throw new MobilityError("hosted_transport_unconfigured", 503);
  }

  private assertRemoteRead(principalId: string, state: PrincipalState): void {
    if (!state.preference.enabled) throw new MobilityError("mobility_preference_disabled", 409);
    if (state.preference.deviceClass === "ephemeral" || this.sinks.isEphemeral(principalId)) throw new MobilityError("ephemeral_mode_persistence_blocked", 403);
    if (!this.hosted) throw new MobilityError("hosted_transport_unconfigured", 503);
  }

  private issue(principalId: string, operation: VaultOperation, resourceScope: string, state: PrincipalState): string {
    return this.vault.consentAuthority().issue({ principalId, operation, resourceScope, policyRevision: policyRevision(state) }).token;
  }

  private async sealHosted(principalId: string, state: PrincipalState, objectId: string, version: number, payload: Uint8Array): Promise<unknown> {
    const channelId = await this.vault.hostedChannelId();
    const consent = this.issue(principalId, "vault:hosted:push", `hosted:${channelId}`, state);
    return (await this.vault.sealHostedObject({ principalId, objectId, version, payload, consent, policyRevision: policyRevision(state) })).envelope;
  }

  private async openHosted(principalId: string, state: PrincipalState, objectId: string, version: number, envelope: unknown): Promise<Uint8Array> {
    const channelId = await this.vault.hostedChannelId();
    const consent = this.issue(principalId, "vault:hosted:pull", `hosted:${channelId}`, state);
    return this.vault.openHostedObject({ principalId, objectId, version, envelope, consent, policyRevision: policyRevision(state) });
  }

  private async sealLocal(principalId: string, state: PrincipalState, slot: "local" | "remote", objectId: string, payload: Uint8Array): Promise<void> {
    const scope = `mobility-local:${principalHash(principalId)}`;
    const consent = this.issue(principalId, "vault:object:seal", scope, state);
    const envelope = await this.vault.sealObject({ principalId, resourceScope: scope, objectId: `${slot}:${objectId}`, payload, consent, policyRevision: policyRevision(state) });
    await this.writeValue(this.key(principalId, `${slot}:${objectId}`), JSON.stringify(envelope));
  }

  private async openLocal(principalId: string, state: PrincipalState, slot: "local" | "remote", objectId: string): Promise<Uint8Array> {
    const raw = await this.secrets.get(this.key(principalId, `${slot}:${objectId}`));
    if (!raw) throw new MobilityError("mobility_local_missing", 404);
    const scope = `mobility-local:${principalHash(principalId)}`;
    const consent = this.issue(principalId, "vault:object:open", scope, state);
    return this.vault.openObject({ principalId, resourceScope: scope, envelope: JSON.parse(raw) as VaultObjectEnvelope, consent, policyRevision: policyRevision(state), objectId: `${slot}:${objectId}` });
  }

  private key(principalId: string, suffix: string): string { return `mobility:v1:${principalHash(principalId)}:${suffix}`; }

  private async load(principalId: string): Promise<PrincipalState> {
    const raw = await this.secrets.get(this.key(principalId, "state"));
    if (!raw) return { v: 1, preference: { ...DEFAULT_PREFERENCE }, objects: {} };
    const parsed = JSON.parse(raw) as PrincipalState;
    if (parsed?.v !== 1 || !parsed.preference || typeof parsed.objects !== "object") throw new MobilityError("mobility_state_invalid", 500);
    return parsed;
  }

  private async save(principalId: string, state: PrincipalState): Promise<void> {
    await this.writeValue(this.key(principalId, "state"), JSON.stringify(state));
  }

  private async writeValue(key:string,value:string|undefined):Promise<void>{
    await this.revalidate?.();const previous=await this.secrets.get(key);await this.revalidate?.();
    try{if(value===undefined)await this.secrets.delete(key);else await this.secrets.set(key,value);await this.revalidate?.();}
    catch(error){
      // Operations are serialized per principal; compensate only our own bytes.
      // A previously written pending transfer survives a rejected confirmation.
      if(await this.secrets.get(key)===value){if(previous===undefined)await this.secrets.delete(key);else await this.secrets.set(key,previous);}
      throw error;
    }
  }

  private async exclusive<T>(principalId: string, task: () => Promise<T>): Promise<T> {
    const previous = this.serial.get(principalId) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(task);
    this.serial.set(principalId, run.catch(() => undefined));
    return run;
  }

  private async withOperation<T>(principalId: string, external: AbortSignal | undefined, task: (op: Operation) => Promise<T>): Promise<T | { state: "cancelled" }> {
    const generation = this.generations.get(principalId) ?? 0;
    this.generations.set(principalId, generation);
    const controller = new AbortController();
    const set = this.controllers.get(principalId) ?? new Set<AbortController>();
    this.controllers.set(principalId, set);
    set.add(controller);
    const onExternal = () => controller.abort();
    external?.addEventListener("abort", onExternal, { once: true });
    if (external?.aborted) controller.abort();
    const op: Operation = {
      signal: controller.signal,
      cancelled: () => controller.signal.aborted || this.preferenceChanging.has(principalId) || (this.generations.get(principalId) ?? 0) !== generation,
      check: () => { if (op.cancelled()) throw new Cancelled(); },
    };
    try {
      op.check();
      const result = await task(op);
      op.check();
      return result;
    } catch (error) {
      if (error instanceof Cancelled) return { state: "cancelled" };
      if (error instanceof SinkAccessDeniedError && op.cancelled()) return { state: "cancelled" };
      throw error;
    } finally {
      set.delete(controller);
      external?.removeEventListener("abort", onExternal);
    }
  }
}

interface Operation { signal: AbortSignal; cancelled(): boolean; check(): void }

function syncState(object: ObjectState): ObjectSyncState {
  if (object.conflict) return "conflict";
  if (object.pending) return "pending_unconfirmed";
  if (object.remoteState === "tombstone") return "remote_tombstone";
  if (object.confirmedVersion > 0 && object.localDigest !== undefined && object.localDigest === object.confirmedDigest) return "confirmed";
  return "local_only";
}

function conflictResult(object: ObjectState): MobilityResult {
  return { state: "conflict", localVersion: object.confirmedVersion, remoteVersion: object.conflict!.remoteVersion };
}

function policyRevision(state: PrincipalState): string { return `mobility:${state.preference.revision}`; }
function principalHash(principalId: string): string { return createHash("sha256").update(principalId).digest("hex").slice(0, 32); }
function digest(payload: Uint8Array): string { return createHash("sha256").update(payload).digest("hex"); }
function assertObject(objectId: string, payload: Uint8Array): void {
  if (!OBJECT_ID.test(objectId)) throw new MobilityError("mobility_object_id_invalid");
  if (!(payload instanceof Uint8Array) || payload.byteLength < 1 || payload.byteLength > MAX_PAYLOAD_BYTES) throw new MobilityError("mobility_payload_invalid", 413);
}
