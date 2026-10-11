import { createCipheriv, createDecipheriv, createHmac, createHash, randomBytes } from "node:crypto";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { exactCachePath } from "./paths.ts";
import type { SecretStore } from "./secret-store.ts";
import type { ChatCompletionRequest, ProviderName } from "./types.ts";
import { ALL_PROVIDERS, isProvider } from "./provider-registry.ts";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { cancelStream } from "./stream-lifecycle.ts";

const CACHE_SCHEMA = "uptokey-exact-cache-v1";
const CACHE_TTL_MS = 24 * 60 * 60_000;
const CACHE_MAX_STATE_BYTES = 16 * 1024 * 1024;
const CACHE_MAX_BODY_BYTES = 256 * 1024;
const CACHE_MAX_ENTRIES = 30;
const HMAC_ACCOUNT = "local:cache-hmac-key";
const DATA_ACCOUNT = "local:cache-data-key";
type CacheEntry = { nonce: string; ciphertext: string; expiresAt: string };
type CacheState = { schema: typeof CACHE_SCHEMA; entries: Record<ProviderName, Record<string, CacheEntry>> };
type CachedPayload = { provider: ProviderName; expiresAt: string; status: 200; contentType: string; body: string };
const CACHE_PROVIDERS = ALL_PROVIDERS;
/** Bumped when key derivation changes; older entries simply miss and age out. */
const CACHE_KEY_VERSION = "exact-key-v2";
export const EXACT_CACHE_TTL_MS = CACHE_TTL_MS;
export type ExactCacheIneligibleReason = "temperature_not_zero" | "multiple_choices" | "non_canonical" | "scope_invalid";
export type ExactCacheLookup =
  | { status: "hit"; ageMs: number; response: Response }
  | { status: "miss" | "expired" | "corrupt" | "invalidating"; response?: undefined }
  | { status: "ineligible"; reason: ExactCacheIneligibleReason; response?: undefined };

export class ExactMatchCache {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly epochs = new Map<ProviderName, number>();
  private readonly invalidating = new Set<ProviderName>();
  private readonly secrets: SecretStore;
  private readonly path: string;
  private readonly now: () => number;
  private readonly writer: typeof writeJsonAtomic;
  private readonly authorizeWrite: ((tenantId: string) => void) | undefined;
  constructor(secrets: SecretStore, path = exactCachePath(), now: () => number = Date.now, writer: typeof writeJsonAtomic = writeJsonAtomic, options?: { authorizeWrite?: (tenantId: string) => void }) {
    this.secrets = secrets; this.path = path; this.now = now; this.writer = writer; this.authorizeWrite = options?.authorizeWrite;
  }

  async initialize(): Promise<void> { await this.serial(async () => { validateState(await this.load()); }); }

  get(tenantId: string, provider: ProviderName, request: ChatCompletionRequest, namespace = ""): Promise<Response | undefined> {
    return this.lookup(tenantId, provider, request, namespace).then((result) => result.response);
  }

  /** Closed-code lookup: a hit replays a stored inference body only; it never stands in for an effect or authorization. */
  lookup(tenantId: string, provider: ProviderName, request: ChatCompletionRequest, namespace = ""): Promise<ExactCacheLookup> {
    return this.serial(async () => {
      if (this.invalidating.has(provider)) return { status: "invalidating" as const };
      const eligibility = exactCacheEligibility(request);
      if (eligibility !== "eligible" || !validTenant(tenantId) || !validNamespace(namespace)) return { status: "ineligible" as const, reason: eligibility === "eligible" ? "scope_invalid" as const : eligibility };
      const keys = await this.keys(); const id = cacheId(keys.hmac, tenantId, provider, request, namespace); const state = await this.load(); const entry = state.entries[provider]?.[id];
      if (!entry) return { status: "miss" as const };
      try {
        const payload = openPayload(entry, keys.data, id);
        if (payload.provider !== provider || payload.expiresAt !== entry.expiresAt) throw new Error("exact_cache_entry_invalid");
        if (Date.parse(payload.expiresAt) <= this.now()) { delete state.entries[provider][id]; await this.save(state); return { status: "expired" as const }; }
        const bytes = fromBase64url(payload.body); const body = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
        const ageMs = Math.max(0, this.now() - (Date.parse(payload.expiresAt) - CACHE_TTL_MS));
        return { status: "hit" as const, ageMs, response: new Response(body, { status: payload.status, headers: { "content-type": payload.contentType, "cache-control": "no-store" } }) };
      } catch { delete state.entries[provider][id]; await this.save(state); return { status: "corrupt" as const }; }
    });
  }

  async put(tenantId: string, provider: ProviderName, request: ChatCompletionRequest, response: Response, expectedEpoch = this.providerEpoch(provider), namespace = "", allowWrite?: () => Promise<boolean>): Promise<boolean> {
    const canWrite = async (): Promise<boolean> => {
      try { this.authorizeWrite?.(tenantId); } catch { /* no retention authority for this partition means no persistence */
        cancelStream(response.body, "exact_cache_write_not_allowed"); return false; }
      try { if (allowWrite === undefined || await allowWrite() === true) return true; } catch { /* no authority means no persistence */ }
      cancelStream(response.body, "exact_cache_write_not_allowed");
      return false;
    };
    if (exactCacheEligibility(request) !== "eligible" || !validTenant(tenantId) || !validNamespace(namespace) || response.status !== 200) { cancelStream(response.body); return false; }
    const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (contentType !== (request.stream === true ? "text/event-stream" : "application/json")) { cancelStream(response.body); return false; }
    if (!await canWrite()) return false;
    const body = await readCacheBodyBounded(response, CACHE_MAX_BODY_BYTES); if (!body) return false;
    if (!await canWrite()) return false;
    if (!validCacheBody(contentType, body)) return false;
    return this.serial(async () => {
      if (this.invalidating.has(provider) || expectedEpoch !== this.providerEpoch(provider)) return false;
      if (!await canWrite()) return false;
      const keys = await this.keys();
      if (!await canWrite()) return false;
      const id = cacheId(keys.hmac, tenantId, provider, request, namespace); const state = await this.load();
      if (!await canWrite()) return false;
      const expiresAt = new Date(this.now() + CACHE_TTL_MS).toISOString();
      state.entries[provider] ??= {};
      state.entries[provider][id] = sealPayload({ provider, expiresAt, status: 200, contentType, body: toBase64url(body) }, keys.data, id, expiresAt);
      const denied = new Error("exact_cache_write_not_allowed");
      try {
        evict(state);
        await this.save(state, async () => { if (!await canWrite()) throw denied; });
        return true;
      } catch (error) { if (error === denied) return false; throw error; }
    });
  }

  providerEpoch(provider: ProviderName): number { return this.epochs.get(provider) ?? 0; }
  invalidateProvider(provider: ProviderName): Promise<void> { return this.serial(async () => {
    this.epochs.set(provider, this.providerEpoch(provider) + 1);
    this.invalidating.add(provider);
    const state = await this.load();
    if (Object.keys(state.entries[provider] ?? {}).length > 0) { state.entries[provider] = {}; await this.save(state); }
    this.invalidating.delete(provider);
  }); }

  private async load(): Promise<CacheState> { const state = await readJson<unknown>(this.path, emptyState(), CACHE_MAX_STATE_BYTES); return validateState(state); }
  private save(state: CacheState, beforeCommit?: () => Promise<void>): Promise<void> { return this.writer(this.path, validateState(state), { maximum: CACHE_MAX_STATE_BYTES, ...(beforeCommit ? { beforeCommit } : {}) }); }
  private async keys(): Promise<{ hmac: Buffer; data: Buffer }> { return { hmac: await secretKey(this.secrets, HMAC_ACCOUNT), data: await secretKey(this.secrets, DATA_ACCOUNT) }; }
  private serial<T>(operation: () => Promise<T>): Promise<T> { const next = this.queue.then(operation, operation); this.queue = next.then(() => undefined, () => undefined); return next; }
}

/**
 * temperature 0 is a precondition, not proof of determinism: n>1 asks for distinct samples and is never replayed.
 * Tool proposals in a cached body remain proposals; execution still requires the workspace approval path.
 */
export function exactCacheEligibility(request: ChatCompletionRequest): "eligible" | ExactCacheIneligibleReason {
  try { if (canonicalJson(request) === "") return "non_canonical"; } catch { return "non_canonical"; }
  if (request.temperature !== 0) return "temperature_not_zero";
  const n = (request as { n?: unknown }).n;
  if (n !== undefined && n !== 1) return "multiple_choices";
  return "eligible";
}
/** Rollback flag for stage 10: default on (existing behaviour); "off"/"0"/"false" disables new lookups and writes. */
export function exactCacheEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  const value = env.UPTOKEY_EXACT_CACHE?.trim().toLowerCase();
  return value === undefined || value === "" || !["off", "0", "false"].includes(value);
}
function validNamespace(value: string): boolean { return value.length <= 512 && !value.includes(String.fromCharCode(0)); }
function validTenant(value: string): boolean { return /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function emptyState(): CacheState {
  const entries = {} as CacheState["entries"];
  for (const provider of CACHE_PROVIDERS) entries[provider] = {};
  return { schema: CACHE_SCHEMA, entries };
}

function validateState(value: unknown): CacheState {
  if (!record(value) || Object.keys(value).sort().join(",") !== "entries,schema" || value.schema !== CACHE_SCHEMA || !record(value.entries) || !validCacheProviderKeys(value.entries)) throw new Error("exact_cache_state_invalid");
  for (const provider of CACHE_PROVIDERS) if (!record(value.entries[provider])) value.entries[provider] = {};
  let count = 0;
  for (const provider of Object.keys(value.entries)) {
    const entries = value.entries[provider]; if (!record(entries)) throw new Error("exact_cache_state_invalid");
    for (const [id, entry] of Object.entries(entries)) { count += 1; if (!/^[0-9a-f]{64}$/.test(id) || !record(entry) || Object.keys(entry).sort().join(",") !== "ciphertext,expiresAt,nonce" || typeof entry.nonce !== "string" || !/^[A-Za-z0-9_-]{16}$/.test(entry.nonce) || typeof entry.ciphertext !== "string" || !/^[A-Za-z0-9_-]{22,470000}$/.test(entry.ciphertext) || typeof entry.expiresAt !== "string" || !validTimestamp(entry.expiresAt)) throw new Error("exact_cache_state_invalid"); }
  }
  if (count > CACHE_MAX_ENTRIES) throw new Error("exact_cache_state_invalid"); return value as CacheState;
}

async function secretKey(secrets: SecretStore, account: string): Promise<Buffer> { let encoded = await secrets.get(account); if (!encoded) { encoded = randomBytes(32).toString("base64url"); await secrets.set(account, encoded); } const key = Buffer.from(encoded, "base64url"); if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("exact_cache_key_invalid"); return key; }
function cacheId(key: Buffer, tenantId: string, provider: ProviderName, request: ChatCompletionRequest, namespace: string): string { const normalized = canonicalJson(request); const digest = createHash("sha256").update(normalized).digest("hex"); const model = typeof request.model === "string" ? request.model : ""; return createHmac("sha256", key).update(`${CACHE_KEY_VERSION}\0${tenantId}\0${provider}\0${model}\0${namespace}\0${digest}`).digest("hex"); }
function sealPayload(payload: CachedPayload, key: Buffer, id: string, expiresAt: string): CacheEntry { const nonce = randomBytes(12); const cipher = createCipheriv("aes-256-gcm", key, nonce); cipher.setAAD(Buffer.from(id, "hex")); const ciphertext = Buffer.concat([cipher.update(JSON.stringify(payload)), cipher.final(), cipher.getAuthTag()]); return { nonce: nonce.toString("base64url"), ciphertext: ciphertext.toString("base64url"), expiresAt }; }
function openPayload(entry: CacheEntry, key: Buffer, id: string): CachedPayload { const combined = Buffer.from(entry.ciphertext, "base64url"); if (combined.length < 17) throw new Error("exact_cache_entry_invalid"); const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(entry.nonce, "base64url"), { authTagLength: 16 }); decipher.setAAD(Buffer.from(id, "hex")); decipher.setAuthTag(combined.subarray(-16)); const value = JSON.parse(Buffer.concat([decipher.update(combined.subarray(0, -16)), decipher.final()]).toString("utf8")) as unknown; if (!record(value) || Object.keys(value).sort().join(",") !== "body,contentType,expiresAt,provider,status" || !isProvider(value.provider) || value.status !== 200 || (value.contentType !== "application/json" && value.contentType !== "text/event-stream") || typeof value.body !== "string" || !/^[A-Za-z0-9_-]*$/.test(value.body) || typeof value.expiresAt !== "string" || !validTimestamp(value.expiresAt)) throw new Error("exact_cache_entry_invalid"); return value as CachedPayload; }

export async function readCacheBodyBounded(response: Response, maximum: number, timeoutMs = 10_000): Promise<Uint8Array | undefined> {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > CACHE_MAX_BODY_BYTES || !Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 120_000) { cancelStream(response.body); return undefined; }
  const body = response.body; if (!body) return new Uint8Array();
  const reader = body.getReader(); const chunks: Uint8Array[] = []; let size = 0; const deadline = Symbol("cache_body_timeout"); let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<typeof deadline>((resolve) => { timer = setTimeout(() => resolve(deadline), timeoutMs); });
  try {
    while (true) {
      const part = await Promise.race([reader.read(), timeout]);
      if (part === deadline) { cancelStream(reader, "cache_body_timeout"); return undefined; }
      const { done, value } = part; if (done) break; size += value.byteLength;
      if (size > maximum) { cancelStream(reader, "cache_body_too_large"); return undefined; }
      chunks.push(value);
    }
  } finally { if (timer !== undefined) clearTimeout(timer); try { reader.releaseLock(); } catch { /* cancelamento pendente mantém o lock no runtime, nunca o caller */ } }
  const result = new Uint8Array(size); let offset = 0; for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.byteLength; } return result;
}
function evict(state: CacheState): void { const all = (Object.keys(state.entries) as ProviderName[]).flatMap((provider) => Object.entries(state.entries[provider]).map(([id, entry]) => ({ provider, id, expires: Date.parse(entry.expiresAt) }))).sort((a, b) => a.expires - b.expires); while (all.length > CACHE_MAX_ENTRIES) { const oldest = all.shift()!; delete state.entries[oldest.provider][oldest.id]; } }
function validCacheProviderKeys(entries: Record<string, unknown>): boolean {
  const names = Object.keys(entries);
  if (!names.includes("groq") || !names.includes("gemini")) return false;
  return names.every((name) => isProvider(name));
}
function toBase64url(value: Uint8Array): string { return Buffer.from(value).toString("base64url"); }
function fromBase64url(value: string): Uint8Array { return new Uint8Array(Buffer.from(value, "base64url")); }
function validTimestamp(value: string): boolean { const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }
function validCacheBody(contentType: string, body: Uint8Array): boolean {
  if (body.byteLength === 0) return false;
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(body);
    if (contentType === "application/json") { JSON.parse(text); return true; }
    const lines = text.split(/\r?\n/).filter((line) => line.length > 0); let jsonFrames = 0;
    if (lines.length < 2 || lines.at(-1)?.trim() !== "data: [DONE]") return false;
    for (const line of lines.slice(0, -1)) { if (!line.startsWith("data:")) return false; const payload = line.slice(5).trimStart(); if (!payload || payload === "[DONE]") return false; JSON.parse(payload); jsonFrames += 1; }
    return jsonFrames > 0;
  } catch { return false; }
}
