/**
 * Uptokey TUI — Native authentication service.
 * Implements ECDSA P-256 key generation, challenge/response, and session management.
 * Keys are stored in the OS native secret store via NativeSecretStore.
 *
 * Flow: generate key → challenge → sign → complete → receive token.
 * This mirrors the browser session flow (BrowserSessionService) but uses
 * native key storage instead of IndexedDB.
 */
import { createSign, generateKeyPairSync, createPublicKey, createPrivateKey, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import { createOfficialSecretStore, assertSecretStoreBoundary, type SecretStore } from "../secret-store.ts";
import { approveLocalPairing } from "../local-admin-client.ts";
import type { TuiClient } from "./client.ts";
import { t } from "./i18n.ts";

export interface NativeKeyPair {
  publicJwk: { kty: "EC"; crv: "P-256"; x: string; y: string };
  privateKeyPem: string;
}

export interface SessionResult {
  token: string;
  clientId: string;
  expiresAt: string;
}

const TUI_KEY_ACCOUNT = "local:tui-native-key";
/** Paired TUI identity: audience tui, narrower scopes, same key signs plan consent. */
const TUI_CLIENT_ACCOUNT = "local:tui-client";
/** Written before key creation/pairing so interrupted enrollment is never legacy. */
const TUI_AUTH_MODE_ACCOUNT = "local:tui-auth-mode";
/** Explicit interactive choice only; legacy resolution keeps its original order. */
const TUI_PREFERRED_IDENTITY_ACCOUNT = "local:tui-preferred-identity";
const CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const PAIRED_TOKEN = /^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/;
let officialStore: SecretStore | undefined;
const keyInitializations = new WeakMap<SecretStore, Promise<NativeKeyPair>>();
const interactiveResolutions = new WeakMap<SecretStore, Promise<string | undefined>>();

function getOfficialStore(): SecretStore {
  if (!officialStore) {
    const candidate = createOfficialSecretStore();
    assertSecretStoreBoundary(candidate.securityBoundary());
    officialStore = candidate;
  }
  return officialStore;
}

/** Validate identity without repairing, replacing or publishing private material. */
export function parseNativeKeyPair(value: unknown): NativeKeyPair {
  try {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
    const entry = value as Record<string, unknown>;
    if (Object.keys(entry).some(key => !["publicJwk", "privateKeyPem"].includes(key)) ||
      typeof entry.privateKeyPem !== "string" || entry.privateKeyPem.length > 16_384) throw new Error();
    const key = createPrivateKey(entry.privateKeyPem);
    if (key.asymmetricKeyType !== "ec" || key.asymmetricKeyDetails?.namedCurve !== "prime256v1") throw new Error();
    const derived = createPublicKey(key).export({ format: "jwk" });
    const publicKey = entry.publicJwk as Record<string, unknown> | undefined;
    if (!publicKey || Array.isArray(publicKey) || typeof publicKey !== "object" ||
      Object.keys(publicKey).some(field => !["kty", "crv", "x", "y"].includes(field)) ||
      publicKey.kty !== "EC" || publicKey.crv !== "P-256" ||
      publicKey.x !== derived.x || publicKey.y !== derived.y) throw new Error();
    return { publicJwk: { kty: "EC", crv: "P-256", x: derived.x!, y: derived.y! }, privateKeyPem: entry.privateKeyPem };
  } catch { throw new Error("tui_native_key_invalid"); }
}

/** In-process single owner; failed reads/writes never become a request for a new identity. */
export async function loadOrCreateNativeKey(store: SecretStore): Promise<NativeKeyPair> {
  const existing = keyInitializations.get(store);
  if (existing) return existing;
  const pending = (async () => {
    const stored = await getStoredNativeKey(store);
    if (stored) return stored;
    const key = generateNativeKeyPair();
    try { await store.set(TUI_KEY_ACCOUNT, JSON.stringify(key)); }
    catch { throw new Error("tui_native_key_unavailable"); }
    return key;
  })();
  keyInitializations.set(store, pending);
  try { return await pending; }
  finally { if (keyInitializations.get(store) === pending) keyInitializations.delete(store); }
}

/**
 * Generate a new ECDSA P-256 key pair for TUI authentication.
 * The private key is PEM-encoded and should be stored in the native secret store.
 */
export function generateNativeKeyPair(): NativeKeyPair {
  const { publicKey, privateKey } = generateKeyPairSync("ec", {
    namedCurve: "P-256",
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });

  // Extract x, y coordinates from PEM
  const pubKeyObj = createPublicKey(publicKey);
  const jwk = pubKeyObj.export({ format: "jwk" });

  return {
    publicJwk: {
      kty: "EC",
      crv: "P-256",
      x: jwk.x as string,
      y: jwk.y as string,
    },
    privateKeyPem: privateKey,
  };
}

export async function getStoredNativeKey(store: SecretStore = getOfficialStore()): Promise<NativeKeyPair | null> {
  let raw: string | undefined;
  try { raw = await store.get(TUI_KEY_ACCOUNT); }
  catch { throw new Error("tui_native_key_unavailable"); }
  if (raw === undefined) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); }
  catch { throw new Error("tui_native_key_invalid"); }
  return parseNativeKeyPair(parsed);
}

/**
 * Sign a nonce using the private key (ECDSA P-256, SHA-256, IEEE P1363 encoding).
 */
export function signChallenge(privateKeyPem: string, nonce: string): string {
  const sign = createSign("SHA256");
  sign.update(nonce);
  const derSignature = sign.sign({ key: privateKeyPem, dsaEncoding: "ieee-p1363" });
  return derSignature.toString("base64url");
}

/**
 * Complete the native TUI authentication flow:
 * 1. Load or generate key pair
 * 2. Request challenge from core
 * 3. Sign the nonce
 * 4. Exchange signature for token
 */
export async function authenticateNative(
  client: TuiClient,
  loadKey: () => Promise<NativeKeyPair | null>,
  saveKey: (key: NativeKeyPair) => Promise<void>,
): Promise<SessionResult> {
  // Load or generate key
  let keyPair = await loadKey();
  if (keyPair === null) {
    keyPair = generateNativeKeyPair();
    await saveKey(keyPair);
  }
  keyPair = parseNativeKeyPair(keyPair);

  // Only sign the core's versioned challenge for this public key, never arbitrary text.
  const challenge = await client.requestNativeSession("challenge", { publicJwk: keyPair.publicJwk });
  if (!isDataRecord(challenge) || typeof challenge.challengeId !== "string" || !CLIENT_ID.test(challenge.challengeId) || typeof challenge.nonce !== "string") throw new Error("tui_auth_challenge_invalid");
  const keyId = createHash("sha256").update(JSON.stringify(keyPair.publicJwk)).digest("hex");
  const prefix = `uptokey-workspace-browser-v1:${challenge.challengeId}:${keyId}:`;
  const entropy = challenge.nonce.slice(prefix.length);
  if (!challenge.nonce.startsWith(prefix) || !/^[A-Za-z0-9_-]{43}$/.test(entropy) || Buffer.from(entropy, "base64url").toString("base64url") !== entropy) throw new Error("tui_auth_challenge_invalid");

  // Step 2: Sign the nonce
  const signature = signChallenge(keyPair.privateKeyPem, challenge.nonce);

  // Step 3: Complete authentication
  const completeStartedAt = Date.now();
  const result = await client.requestNativeSession("complete", { challengeId: challenge.challengeId, signature });
  if (!isDataRecord(result) || typeof result.clientId !== "string" || !CLIENT_ID.test(result.clientId) || typeof result.token !== "string" || !result.token.startsWith(`utk_local_${result.clientId}.`) || !/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/.test(result.token)) throw new Error("tui_auth_session_invalid");

  return {
    token: result.token,
    clientId: result.clientId,
    // Conservative local bound from the existing 24h protocol, not an observed server expiry.
    expiresAt: new Date(completeStartedAt + 86_400_000).toISOString(),
  };
}

/**
 * Preserve an existing legacy admin identity until an explicit migration is implemented.
 * Never create an admin credential here; a new profile uses explicit pairing (audience tui).
 *
 * Order:
 *  1. `local:api-token` — existing administrative identity, never migrated silently.
 *  2. `local:tui-client` — paired tui identity; a 401/403 starts replacement pairing
 *     while preserving the record/marker until replacement commits.
 *  3. `local:tui-native-key` without a paired record or pairing marker — existing native profile keeps the
 *     browser-session renewal it already had (renaming the audience requires the explicit
 *     `uptokey client audience` transition owned by B9).
 *  4. New profile — explicit pairing with public key and administrative confirmation.
 */
export async function resolveToken(
  client: TuiClient,
  secrets: SecretStore = getOfficialStore(),
  show: (message: string) => void = () => {},
  signal?: AbortSignal,
): Promise<string | undefined> {
  // 1. Explicit administrative identity.
  let adminToken: string | undefined;
  try { adminToken = await secrets.get("local:api-token"); }
  catch { throw new Error("tui_native_key_unavailable"); }
  if (adminToken !== undefined) {
    if (!/^utk_local_[A-Za-z0-9_-]{32}$/.test(adminToken)) throw new Error("tui_legacy_identity_invalid");
    if (await client.authenticate(adminToken)) return adminToken;
    // Falling back would change the owner of projects/history without consent.
    throw new Error("tui_legacy_identity_unavailable");
  }

  // 2. Paired tui identity.
  let hadPairedRecord = false;
  let storedClient: string | undefined;
  let authMode: string | undefined;
  try { storedClient = await secrets.get(TUI_CLIENT_ACCOUNT); authMode = await secrets.get(TUI_AUTH_MODE_ACCOUNT); }
  catch { throw new Error("tui_native_key_unavailable"); }
  if (authMode !== undefined && authMode !== "pairing") throw new Error("tui_client_identity_invalid");
  if (storedClient !== undefined) {
    hadPairedRecord = true;
    let session: { clientId: string; token: string } | null = null;
    try { session = parseTuiClientSession(JSON.parse(storedClient)); } catch { session = null; }
    if (!session) throw new Error("tui_client_identity_invalid");
    let authStatus: number | undefined;
    const observeAuth = (status: number): void => { authStatus = status; };
    client.on("auth_error", observeAuth);
    let authenticated = false;
    try { authenticated = await client.authenticate(session.token); }
    finally { client.off("auth_error", observeAuth); }
    if (authenticated) return session.token;
    if (authStatus === undefined) {
      // Transport/health failure: keep the record and fail closed; never re-pair silently.
      throw new Error("tui_client_identity_unavailable");
    }
    // Keep the old identity until replacement commits; a failed enrollment must
    // not erase the durable distinction between pairing and a legacy profile.
    try { await secrets.set(TUI_AUTH_MODE_ACCOUNT, "pairing"); }
    catch { throw new Error("tui_native_key_unavailable"); }
  }

  // 3. Existing native profile without a paired record keeps its current renewal path.
  if (!hadPairedRecord && authMode !== "pairing") {
    const existingKey = await getStoredNativeKey(secrets);
    if (existingKey) {
      // Another resolver may have initialized a new pairing while this read was
      // pending. Its marker is committed before that key becomes visible.
      try { authMode = await secrets.get(TUI_AUTH_MODE_ACCOUNT); }
      catch { throw new Error("tui_native_key_unavailable"); }
      if (authMode !== undefined && authMode !== "pairing") throw new Error("tui_client_identity_invalid");
      if (authMode !== "pairing") {
        const result = await authenticateNative(client, async () => existingKey, async () => { throw new Error("tui_native_key_unavailable"); });
        return result.token;
      }
    }
  }

  // 4. New profile: explicit pairing; the same native key signs plan consent afterwards.
  try { await secrets.set(TUI_AUTH_MODE_ACCOUNT, "pairing"); }
  catch { throw new Error("tui_native_key_unavailable"); }
  const key = await loadOrCreateNativeKey(secrets);
  const session = await requestPairing(client, key, show, signal);
  try { await secrets.set(TUI_CLIENT_ACCOUNT, JSON.stringify({ clientId: session.clientId, token: session.token })); }
  catch { throw new Error("tui_native_key_unavailable"); }
  return session.token;
}

export interface TuiPairingChoice {
  audience: "tui";
  publicKeyFingerprint: string;
  adminAvailable: boolean;
  /** Choosing this identity does not transfer projects or history from the old owner. */
  ownerChange: boolean;
}

export interface InteractiveTokenOptions {
  /** Must present an explicit human choice before enrollment or administrative approval. */
  confirmPairing: (choice: TuiPairingChoice) => Promise<boolean>;
  secrets?: SecretStore;
  show?: (message: string) => void;
  signal?: AbortSignal;
}

/** Interactive opt-in to the paired, W5-capable identity; no implicit legacy migration. */
export async function resolveInteractiveToken(client: TuiClient, options: InteractiveTokenOptions): Promise<string | undefined> {
  const secrets = options.secrets ?? getOfficialStore();
  const pending = interactiveResolutions.get(secrets);
  if (pending) return pending;
  const resolution = resolveInteractiveIdentity(client, secrets, options);
  interactiveResolutions.set(secrets, resolution);
  try { return await resolution; }
  finally { if (interactiveResolutions.get(secrets) === resolution) interactiveResolutions.delete(secrets); }
}

async function resolveInteractiveIdentity(client: TuiClient, secrets: SecretStore, options: InteractiveTokenOptions): Promise<string | undefined> {
  const { signal, confirmPairing } = options, show = options.show ?? (() => {});
  signal?.throwIfAborted();
  let preference: string | undefined, admin: string | undefined, stored: string | undefined;
  try { preference = await secrets.get(TUI_PREFERRED_IDENTITY_ACCOUNT); admin = await secrets.get("local:api-token"); stored = await secrets.get(TUI_CLIENT_ACCOUNT); }
  catch { throw new Error("tui_native_key_unavailable"); }
  if (preference !== undefined && preference !== "paired") throw new Error("tui_client_identity_invalid");
  if (admin !== undefined && !/^utk_local_[A-Za-z0-9_-]{32}$/.test(admin)) throw new Error("tui_legacy_identity_invalid");
  let paired: { clientId: string; token: string } | null = null;
  if (stored !== undefined) {
    try { paired = parseTuiClientSession(JSON.parse(stored)); } catch { /* preserve invalid record */ }
    if (!paired) throw new Error("tui_client_identity_invalid");
  }
  const existingKey = await getStoredNativeKey(secrets);
  if ((paired || preference) && !existingKey) throw new Error("tui_native_key_missing");
  if (preference && !paired) throw new Error("tui_client_identity_invalid");
  let pairedValid = false;
  if (paired) {
    let status: number | undefined;
    const observe = (value: number) => { status = value; };
    client.on("auth_error", observe);
    try { pairedValid = await client.authenticate(paired.token); }
    finally { client.off("auth_error", observe); }
    if (!pairedValid && status === undefined) throw new Error("tui_client_identity_unavailable");
    if (pairedValid && (preference === "paired" || admin === undefined)) return paired.token;
  }
  const key = existingKey ?? generateNativeKeyPair();
  const fingerprint = createHash("sha256").update(JSON.stringify(key.publicJwk)).digest("hex");
  const accepted = await confirmPairing({ audience: "tui", publicKeyFingerprint: fingerprint, adminAvailable: admin !== undefined, ownerChange: admin !== undefined || existingKey !== null });
  signal?.throwIfAborted();
  if (!accepted) {
    if (preference) return undefined; // Never switch an explicitly selected principal back to admin.
    if (admin !== undefined) return resolveToken(client, secrets, show, signal);
    if (paired) return pairedValid ? paired.token : undefined;
    // Declining an interrupted/revoked enrollment must not restart pairing.
    let mode: string | undefined;
    try { mode = await secrets.get(TUI_AUTH_MODE_ACCOUNT); }
    catch { throw new Error("tui_native_key_unavailable"); }
    if (mode !== undefined && mode !== "pairing") throw new Error("tui_client_identity_invalid");
    return existingKey && mode === undefined
      ? (await authenticateNative(client, async () => existingKey, async () => { throw new Error("tui_native_key_unavailable"); })).token
      : undefined;
  }
  // A slow confirmation cannot authorize a different stored identity or credential.
  let currentAdmin: string | undefined, currentClient: string | undefined, currentPreference: string | undefined;
  try { currentAdmin = await secrets.get("local:api-token"); currentClient = await secrets.get(TUI_CLIENT_ACCOUNT); currentPreference = await secrets.get(TUI_PREFERRED_IDENTITY_ACCOUNT); }
  catch { throw new Error("tui_native_key_unavailable"); }
  const currentKey = await getStoredNativeKey(secrets);
  if (currentAdmin !== admin || currentClient !== stored || currentPreference !== preference ||
    (currentKey?.privateKeyPem ?? null) !== (existingKey?.privateKeyPem ?? null)) throw new Error("tui_pairing_context_changed");
  if (pairedValid && paired) {
    try { await secrets.set(TUI_PREFERRED_IDENTITY_ACCOUNT, "paired"); }
    catch { throw new Error("tui_native_key_unavailable"); }
    return paired.token;
  }
  try {
    await secrets.set(TUI_AUTH_MODE_ACCOUNT, "pairing");
    if (!existingKey) await secrets.set(TUI_KEY_ACCOUNT, JSON.stringify(key));
  } catch { throw new Error("tui_native_key_unavailable"); }
  const approve = admin === undefined ? undefined : async (challenge: PairingApprovalHint) => {
    signal?.throwIfAborted();
    // The canonical admin helper owns approval semantics. Its transport is pinned
    // to this client's validated loopback endpoint, never to a provider or Origin.
    await approveLocalPairing("/local/pair/approve", admin, { id: challenge.id, userCode: challenge.userCode, audience: "tui" }, (async (_input: RequestInfo | URL, init?: RequestInit) => {
      const target = new URL("/local/pair/approve", client.url), headers = new Headers(init?.headers);
      headers.set("host", target.host);
      return fetch(target, { ...init, headers, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), ...(signal ? [signal] : [])]) });
    }) as unknown as typeof fetch);
  };
  const session = await requestPairing(client, key, show, signal, approve);
  signal?.throwIfAborted();
  try { await secrets.set(TUI_CLIENT_ACCOUNT, JSON.stringify(session)); }
  catch { throw new Error("tui_native_key_unavailable"); }
  if (!await client.authenticate(session.token)) throw new Error("tui_client_identity_unavailable");
  signal?.throwIfAborted();
  try { await secrets.set(TUI_PREFERRED_IDENTITY_ACCOUNT, "paired"); }
  catch { throw new Error("tui_native_key_unavailable"); }
  show(t("tui_identity_registered"));
  return session.token;
}

/** Strict projection of the paired identity; invalid tokens are never repaired. */
export function parseTuiClientSession(value: unknown): { clientId: string; token: string } | null {
  if (!isDataRecord(value)) return null;
  if (typeof value.clientId !== "string" || !CLIENT_ID.test(value.clientId)) return null;
  if (typeof value.token !== "string" || !PAIRED_TOKEN.test(value.token)) return null;
  if (!value.token.startsWith(`utk_local_${value.clientId}.`)) return null;
  return { clientId: value.clientId, token: value.token };
}

export interface PairingApprovalHint {
  id: string;
  userCode: string;
  expiresAt: string;
}

/**
 * Explicit pairing for a new TUI profile (audience tui). The challenge is approved
 * administratively; consume carries the public key bound to that approval. Errors are
 * surfaced per structured code and never escalate to another audience.
 */
export async function requestPairing(
  client: TuiClient,
  key: NativeKeyPair,
  show: (message: string) => void,
  signal?: AbortSignal,
  /** Provided only after resolveInteractiveToken receives affirmative human confirmation. */
  approve?: (challenge: PairingApprovalHint) => Promise<void>,
): Promise<{ clientId: string; token: string }> {
  signal?.throwIfAborted();
  const challengeResponse = await client.postPairing("/local/pair/challenge", { clientName: "Uptokey TUI", audience: "tui" });
  if (challengeResponse.status === 429) throw new Error("tui_pairing_rate_limited");
  if (challengeResponse.status !== 201 || !isDataRecord(challengeResponse.value)) throw new Error("tui_pairing_challenge_failed");
  const challenge = challengeResponse.value;
  if (typeof challenge.id !== "string" || !CLIENT_ID.test(challenge.id)
    || typeof challenge.userCode !== "string" || !/^[A-Fa-f0-9]{8}$/.test(challenge.userCode)
    || typeof challenge.expiresAt !== "string") throw new Error("tui_pairing_challenge_invalid");
  const expiresAt = Date.parse(challenge.expiresAt);
  if (!Number.isFinite(expiresAt)) throw new Error("tui_pairing_challenge_invalid");
  if (approve) await approve({ id: challenge.id, userCode: challenge.userCode, expiresAt: challenge.expiresAt });
  else show(t("tui_pairing_approval_needed", { id: challenge.id, userCode: challenge.userCode }));
  const deadline = Math.min(expiresAt, Date.now() + 5 * 60_000);
  let waitMs = approve ? 0 : 2_000;
  for (;;) {
    signal?.throwIfAborted();
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("tui_pairing_expired");
    try { await delay(Math.min(waitMs, remaining), undefined, signal ? { signal } : undefined); }
    catch { signal?.throwIfAborted(); throw new Error("tui_pairing_cancelled"); }
    const consumed = await client.postPairing("/local/pair/consume", { id: challenge.id, publicJwk: key.publicJwk });
    if (consumed.status === 200) {
      const session = parseTuiClientSession(consumed.value);
      if (!session) throw new Error("tui_pairing_session_invalid");
      return session;
    }
    if (consumed.status === 409) { waitMs = Math.min(Math.max(2_000, waitMs * 2), 15_000); continue; }
    if (consumed.status === 429) { waitMs = Math.max(waitMs, 5_000); continue; }
    if (consumed.status === 400) {
      const type = isDataRecord(consumed.value) && isDataRecord(consumed.value.error) ? consumed.value.error.type : undefined;
      // The approved challenge is kept server-side: retry consume with the key.
      if (type === "pairing_key_required") { waitMs = 2_000; continue; }
      throw new Error("tui_pairing_invalid");
    }
    if (consumed.status === 404) throw new Error("tui_pairing_invalid_or_expired");
    throw new Error(`tui_pairing_failed_${consumed.status}`);
  }
}



/**
 * Existing TUI identity for non-interactive use (pipe/batch): explicit paired
 * preference first, otherwise the legacy order. Never starts a pairing and
 * never waits for an approval that nobody can see; returns undefined instead.
 */
export async function storedTuiToken(client: TuiClient, secrets: SecretStore = getOfficialStore()): Promise<string | undefined> {
  const preference = await secrets.get(TUI_PREFERRED_IDENTITY_ACCOUNT);
  if (preference !== undefined) {
    if (preference !== "paired") throw new Error("tui_client_identity_invalid");
    if (!await getStoredNativeKey(secrets)) throw new Error("tui_native_key_missing");
    const raw = await secrets.get(TUI_CLIENT_ACCOUNT);
    let session: { clientId: string; token: string } | null = null;
    try { session = parseTuiClientSession(JSON.parse(raw ?? "null")); } catch { /* preserve invalid record */ }
    if (!session) throw new Error("tui_client_identity_invalid");
    return await client.authenticate(session.token) ? session.token : undefined;
  }
  const admin = await secrets.get("local:api-token");
  if (admin !== undefined) return /^utk_local_[A-Za-z0-9_-]{32}$/.test(admin) && await client.authenticate(admin) ? admin : undefined;
  const stored = await secrets.get(TUI_CLIENT_ACCOUNT);
  if (stored !== undefined) {
    let session: { clientId: string; token: string } | null = null;
    try { session = parseTuiClientSession(JSON.parse(stored)); } catch { session = null; }
    return session && await client.authenticate(session.token) ? session.token : undefined;
  }
  const mode = await secrets.get(TUI_AUTH_MODE_ACCOUNT);
  if (mode === "pairing") return undefined;
  const key = await getStoredNativeKey(secrets);
  if (!key) return undefined;
  return (await authenticateNative(client, async () => key, async () => { throw new Error("tui_native_key_unavailable"); })).token;
}
