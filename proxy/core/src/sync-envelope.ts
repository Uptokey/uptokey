import { createECDH, randomBytes } from "node:crypto";
import { Aes256Gcm, CipherSuite, DhkemP256HkdfSha256, HkdfSha256 } from "@hpke/core";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { verifyEnvelopeAssertion } from "@uptokey/sync-contract/server";
import type { EnvelopeCredential } from "@uptokey/sync-contract/server";
import type { SecretStore } from "./secret-store.ts";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import type { ControlIdentity } from "./control-capability.ts";
import type { WebAuthnCounterCoordinator } from "./webauthn-counter.ts";
import { isSyncEnvelope, SYNC_ALGORITHM, SYNC_SCHEMA_VERSION } from "@uptokey/sync-contract/envelope";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";

export { SYNC_ALGORITHM, SYNC_SCHEMA_VERSION };
const DEVICE_PRIVATE_KEY_ACCOUNT = "device:sync-private-p256";
const DEVICE_PUBLIC_KEY_ACCOUNT = "device:sync-public-p256";
const MAX_RECORDED_NONCES = 1_024;
export const SYNC_HPKE_SUITE = new CipherSuite({ kem: new DhkemP256HkdfSha256(), kdf: new HkdfSha256(), aead: new Aes256Gcm() });
const SYNC_HPKE_INFO = Buffer.from("uptokey-config-v2");

export interface SyncEnvelope {
  device_id: string;
  config_version: number;
  schema_version: number;
  algorithm: typeof SYNC_ALGORITHM;
  ephemeral_public_key: string;
  nonce: string;
  ciphertext: string;
  created_at: string;
}

export interface SignedSyncEnvelope { envelope: SyncEnvelope; webauthnAssertion: unknown; }

export interface DeviceSyncKeypair {
  privateKey: string;
  publicKey: string;
}

interface SyncState<T> {
  currentVersion: number;
  consumedNonces: string[];
  webauthnCounter?: number;
  activeConfig?: T;
  tenantId?: string;
  deviceId?: string;
}

let keypairSerial: Promise<void> = Promise.resolve();

export async function ensureDeviceSyncKeypair(secrets: SecretStore): Promise<DeviceSyncKeypair> {
  let result!: DeviceSyncKeypair;
  const task = keypairSerial.then(async () => { result = await ensureDeviceSyncKeypairOnce(secrets); });
  keypairSerial = task.catch(() => undefined); await task; return result;
}

async function ensureDeviceSyncKeypairOnce(secrets: SecretStore): Promise<DeviceSyncKeypair> {
  const existingPrivate = await secrets.get(DEVICE_PRIVATE_KEY_ACCOUNT);
  const existingPublic = await secrets.get(DEVICE_PUBLIC_KEY_ACCOUNT);
  if (existingPrivate) {
    const derivedPublic = deriveP256Public(existingPrivate);
    if (!derivedPublic || existingPublic !== undefined && existingPublic !== derivedPublic) throw new Error("device_sync_keypair_invalid");
    if (existingPublic === undefined) await secrets.set(DEVICE_PUBLIC_KEY_ACCOUNT, derivedPublic);
    return confirmStoredKeypair(secrets, { privateKey: existingPrivate, publicKey: derivedPublic });
  }
  if (existingPublic !== undefined) throw new Error("device_sync_keypair_invalid");
  const ecdh = createECDH("prime256v1");
  ecdh.generateKeys();
  const pair = { privateKey: encodeP256PrivateKey(ecdh.getPrivateKey()), publicKey: ecdh.getPublicKey("base64url") };
  await secrets.set(DEVICE_PRIVATE_KEY_ACCOUNT, pair.privateKey);
  await secrets.set(DEVICE_PUBLIC_KEY_ACCOUNT, pair.publicKey);
  return confirmStoredKeypair(secrets, pair);
}

async function confirmStoredKeypair(secrets: SecretStore, expected: DeviceSyncKeypair): Promise<DeviceSyncKeypair> {
  const storedPrivate = await secrets.get(DEVICE_PRIVATE_KEY_ACCOUNT); const storedPublic = await secrets.get(DEVICE_PUBLIC_KEY_ACCOUNT);
  if (storedPrivate !== expected.privateKey || storedPublic !== expected.publicKey || deriveP256Public(storedPrivate) !== storedPublic) throw new Error("device_sync_keypair_invalid");
  return expected;
}

export function encodeP256PrivateKey(value: Uint8Array): string {
  if (!(value instanceof Uint8Array) || value.byteLength < 1 || value.byteLength > 32) throw new Error("device_sync_keypair_invalid");
  const encoded = Buffer.alloc(32); Buffer.from(value).copy(encoded, 32 - value.byteLength); return encoded.toString("base64url");
}

function deriveP256Public(privateKey: unknown): string | undefined {
  if (typeof privateKey !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(privateKey)) return undefined;
  try {
    const decoded = Buffer.from(privateKey, "base64url"); if (decoded.length !== 32) return undefined;
    const ecdh = createECDH("prime256v1"); ecdh.setPrivateKey(decoded); const publicKey = ecdh.getPublicKey("base64url");
    return /^[A-Za-z0-9_-]{87}$/.test(publicKey) && Buffer.from(publicKey, "base64url").length === 65 ? publicKey : undefined;
  } catch { return undefined; }
}

export async function sealConfig(
  config: unknown,
  context: { tenantId: string; deviceId: string; configVersion: number; recipientPublicKey: string; createdAt?: Date }
): Promise<SyncEnvelope> {
  assertNonSecretConfig(config);
  if (!Number.isSafeInteger(context.configVersion) || context.configVersion <= 0) throw new Error("sync_invalid_version");
  if (!safeId(context.tenantId) || !safeId(context.deviceId) || !canonicalBase64url(context.recipientPublicKey, 65)) throw new Error("sync_context_invalid");
  const createdAt = context.createdAt ?? new Date(); if (!validDate(createdAt)) throw new Error("sync_created_at_invalid");
  const nonce = randomBytes(12).toString("base64url");
  const aad = syncAad(context.tenantId, context.deviceId, context.configVersion, SYNC_SCHEMA_VERSION, nonce);
  const recipientKey = await SYNC_HPKE_SUITE.kem.importKey("raw", toArrayBuffer(Buffer.from(context.recipientPublicKey, "base64url")), true);
  const { ct, enc } = await SYNC_HPKE_SUITE.seal({ recipientPublicKey: recipientKey, info: SYNC_HPKE_INFO }, Buffer.from(canonicalJson(config)), aad);
  return {
    device_id: context.deviceId,
    config_version: context.configVersion,
    schema_version: SYNC_SCHEMA_VERSION,
    algorithm: SYNC_ALGORITHM,
    ephemeral_public_key: Buffer.from(enc).toString("base64url"),
    nonce,
    ciphertext: Buffer.from(ct).toString("base64url"),
    created_at: createdAt.toISOString()
  };
}

export class SyncEnvelopeApplier<T = unknown> {
  private serial: Promise<void> = Promise.resolve();
  private readonly statePath: string;
  private readonly assertionVerifier: typeof verifyEnvelopeAssertion;
  private readonly configValidator?: (value: unknown) => void;
  private readonly counterCoordinator?: WebAuthnCounterCoordinator;
  constructor(statePath: string, assertionVerifier: typeof verifyEnvelopeAssertion = verifyEnvelopeAssertion, configValidator?: (value: unknown) => void, counterCoordinator?: WebAuthnCounterCoordinator) { this.statePath = statePath; this.assertionVerifier = assertionVerifier; this.configValidator = configValidator; this.counterCoordinator = counterCoordinator; }

  async apply(signed: SignedSyncEnvelope, context: { tenantId: string; deviceId: string; recipientPrivateKey: string; credential: Omit<EnvelopeCredential, "counter">; initialWebauthnCounter: number; expectedOrigin: string | string[]; expectedRPID: string | string[]; counterIdentity?: ControlIdentity }): Promise<T> {
    assertSignedSyncEnvelope(signed); assertOpenContext(context); if (!safeUint32(context.initialWebauthnCounter)) throw new Error("sync_context_invalid");
    let result!: T;
    const operation = this.serial.then(async () => {
      const state = await readJson<SyncState<T>>(this.statePath, { currentVersion: 0, consumedNonces: [] });
      validateSyncState(state);
      if (state.activeConfig !== undefined) this.configValidator?.(state.activeConfig);
      const envelope = signed.envelope;
      const identityChanged = state.tenantId !== undefined && (state.tenantId !== context.tenantId || state.deviceId !== context.deviceId);
      const priorVersion = identityChanged ? 0 : state.currentVersion;
      const priorNonces = identityChanged ? [] : state.consumedNonces;
      const priorCounter = identityChanged ? 0 : state.webauthnCounter ?? 0;
      if (priorNonces.includes(envelope.nonce)) throw new Error("sync_replay_rejected");
      if (envelope.config_version <= priorVersion) throw new Error("sync_downgrade_rejected");
      const execute = async (sharedCounter: number) => {
        const expectedCounter = Math.max(priorCounter, context.initialWebauthnCounter, sharedCounter);
        const newCounter = await this.assertionVerifier({ assertion: signed.webauthnAssertion, credential: { ...context.credential, counter: expectedCounter }, tenantId: context.tenantId, envelope: envelope as unknown as Record<string, unknown>, expectedOrigin: context.expectedOrigin, expectedRPID: context.expectedRPID });
        if (!safeUint32(newCounter) || newCounter < expectedCounter || expectedCounter > 0 && newCounter === expectedCounter) throw new Error("webauthn_counter_regression");
        result = await openConfig<T>(envelope, context); assertNonSecretConfig(result); this.configValidator?.(result);
        await writeJsonAtomic(this.statePath, { currentVersion: envelope.config_version, consumedNonces: [...priorNonces, envelope.nonce].slice(-MAX_RECORDED_NONCES), webauthnCounter: newCounter, activeConfig: result, tenantId: context.tenantId, deviceId: context.deviceId } satisfies SyncState<T>);
        return { result: undefined, nextCounter: newCounter };
      };
      if (this.counterCoordinator && context.counterIdentity) await this.counterCoordinator.run(context.counterIdentity, execute);
      else await execute(context.initialWebauthnCounter);
    });
    this.serial = operation.catch(() => undefined);
    await operation;
    return result;
  }
}

export async function loadActiveSyncConfig<T>(statePath: string, expected: { tenantId: string; deviceId: string }, configValidator?: (value: unknown) => void): Promise<{ version: number; config: T } | undefined> {
  const state = await readJson<SyncState<T>>(statePath, { currentVersion: 0, consumedNonces: [] });
  validateSyncState(state);
  if (state.currentVersion === 0 || state.activeConfig === undefined || state.tenantId !== expected.tenantId || state.deviceId !== expected.deviceId) return undefined;
  configValidator?.(state.activeConfig);
  return { version: state.currentVersion, config: structuredClone(state.activeConfig) };
}

export async function openConfig<T>(
  envelope: SyncEnvelope,
  context: { tenantId: string; deviceId: string; recipientPrivateKey: string }
): Promise<T> {
  assertSyncEnvelope(envelope); assertOpenContext(context);
  if (envelope.device_id !== context.deviceId) throw new Error("sync_wrong_device");
  try {
    const recipientKey = await SYNC_HPKE_SUITE.kem.importKey("raw", toArrayBuffer(Buffer.from(context.recipientPrivateKey, "base64url")), false);
    const aad = syncAad(context.tenantId, context.deviceId, envelope.config_version, envelope.schema_version, envelope.nonce);
    const plaintext = await SYNC_HPKE_SUITE.open({ recipientKey, enc: toArrayBuffer(Buffer.from(envelope.ephemeral_public_key, "base64url")), info: SYNC_HPKE_INFO }, Buffer.from(envelope.ciphertext, "base64url"), aad);
    return JSON.parse(Buffer.from(plaintext).toString("utf8")) as T;
  } catch {
    throw new Error("sync_ciphertext_rejected");
  }
}

export function assertSyncEnvelope(value: unknown): asserts value is SyncEnvelope {
  if (!isSyncEnvelope(value)) throw new Error("sync_envelope_invalid");
}

function assertSignedSyncEnvelope(value: unknown): asserts value is SignedSyncEnvelope { if (!record(value) || Object.keys(value).sort().join(",") !== "envelope,webauthnAssertion") throw new Error("sync_envelope_invalid"); assertSyncEnvelope(value.envelope); }
function assertOpenContext(value: { tenantId: string; deviceId: string; recipientPrivateKey: string }): void { if (!safeId(value.tenantId) || !safeId(value.deviceId) || !canonicalBase64url(value.recipientPrivateKey, 32)) throw new Error("sync_context_invalid"); }
function canonicalBase64url(value: unknown, bytes: number): value is string { if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false; const decoded = Buffer.from(value, "base64url"); return decoded.length === bytes && decoded.toString("base64url") === value; }
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function validDate(value: unknown): value is Date { return value instanceof Date && Number.isFinite(value.getTime()); }

function toArrayBuffer(view: Uint8Array): ArrayBuffer {
  return view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength) as ArrayBuffer;
}

function syncAad(tenantId: string, deviceId: string, configVersion: number, schemaVersion: number, nonce: string): Buffer {
  return Buffer.from(canonicalJson({ tenant_id: tenantId, device_id: deviceId, config_version: configVersion, schema_version: schemaVersion, nonce }));
}

function assertNonSecretConfig(value: unknown): void {
  const serialized = canonicalJson(value);
  if (/"(?:api[_-]?key|byok|secret|provider[_-]?token|prompt|completion)"\s*:/i.test(serialized)) throw new Error("sync_forbidden_config_field");
  if (/(?:gsk_|AIza|sk-|utk_(?:local|live)_)[A-Za-z0-9._-]{8,}/.test(serialized)) throw new Error("sync_secret_pattern_detected");
}

function validateSyncState(value: unknown): asserts value is SyncState<unknown> {
  if (!record(value) || Object.keys(value).some((key) => !["currentVersion", "consumedNonces", "webauthnCounter", "activeConfig", "tenantId", "deviceId"].includes(key)) || !safeNonnegative(value.currentVersion)
    || !Array.isArray(value.consumedNonces) || value.consumedNonces.length > MAX_RECORDED_NONCES || value.consumedNonces.some((nonce) => typeof nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(nonce)) || new Set(value.consumedNonces).size !== value.consumedNonces.length
    || value.webauthnCounter !== undefined && !safeUint32(value.webauthnCounter)
    || (value.tenantId === undefined) !== (value.deviceId === undefined)
    || value.tenantId !== undefined && (!safeIdentityPart(value.tenantId) || !safeIdentityPart(value.deviceId))) throw new Error("sync_state_invalid");
  if (value.currentVersion === 0) { if (value.consumedNonces.length !== 0 || value.webauthnCounter !== undefined || value.activeConfig !== undefined || value.tenantId !== undefined || value.deviceId !== undefined) throw new Error("sync_state_invalid"); return; }
  if (value.consumedNonces.length === 0 || value.webauthnCounter === undefined || value.activeConfig === undefined || value.tenantId === undefined || value.deviceId === undefined) throw new Error("sync_state_invalid");
  assertNonSecretConfig(value.activeConfig);
  if (Buffer.byteLength(canonicalJson(value.activeConfig), "utf8") > 64 * 1_024) throw new Error("sync_state_invalid");
}

function safeNonnegative(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
function safeUint32(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff; }
function safeIdentityPart(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
