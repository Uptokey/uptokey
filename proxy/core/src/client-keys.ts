import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";
import {
  CLIENT_KEY_MAX_KEYS,
  CLIENT_KEY_SCOPES,
  parseClientKeyPolicy,
  type ClientKeyPolicy,
  type ClientKeyScope,
  type ClientKeyView,
} from "@uptokey/sync-contract/client-keys";
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { readClientRegistration, type StoredClientRegistration } from "./workspace/client-registration.ts";
import { serialClientAuthority as serialMutation } from './client-authority-lock.ts';
import { sharedSinkAuthority } from './workspace/sink-authority.ts';
import {browserEnrollmentKey,isPublicPwaOrigin} from './workspace/browser-enrollment.ts';

export type ClientKeyError =
  | "token_invalid"
  | "token_expired"
  | "token_revoked"
  | "scope_denied"
  | "model_scope_denied"
  | "key_limit_exceeded"
  | "key_conflict"
  | "key_not_found"
  | "key_capacity_exceeded"
  | "client_key_invalid";

export interface ResolvedClient {
  kind: "admin" | "client";
  policy?: ClientKeyPolicy;
  clientId?: string;
  delegation?: ClientDelegation;
  /** Enrollment read under the same policy lock; absent never means an unrestricted grant. */
  registration?: StoredClientRegistration;
}

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CLIENT_TOKEN = /^utk_local_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.([A-Za-z0-9_-]{32})$/i;
const ADMIN_TOKEN = /^utk_local_[A-Za-z0-9_-]{32}$/;
const LEGACY_DEFAULT_SCOPES: ClientKeyScope[] = ["inference:chat", "inference:responses", "inference:messages", "models:read", "usage:read"];

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

const policyKey = (id: string) => `local:client-policy:${id}`;
const metaKey = (id: string) => `local:client-meta:${id}`;
const tokenKey = (id: string) => `local:client:${id}`;
const expiresKey = (id: string) => `local:client:${id}:expires`;
const opKey = (operationId: string) => `local:client-ops:${operationId}`;
const INDEX_KEY = "local:client-index";

function snapshotInput<T extends object>(input: T): T {
  if (!isDataRecord(input)) throw new Error("client_key_invalid");
  try { return JSON.parse(canonicalJson(Object.fromEntries(Object.entries(input).filter(([, value]) => value !== undefined)))) as T; }
  catch { throw new Error("client_key_invalid"); }
}

type ClientOperationKind = "create" | "update" | "rotate" | "revoke";
type ClientOperation = { schemaVersion: 1; kind: ClientOperationKind; clientId: string; revision: number; requestDigest: string };
function operationDigest(kind: ClientOperationKind, clientId: string | null, request: object): string {
  const { operationId: _operationId, ...fields } = request as Record<string, unknown>;
  return createHash("sha256").update(canonicalJson({ kind, clientId, request: fields })).digest("hex");
}
async function readOperation(secrets: SecretStore, operationId: string, kind: ClientOperationKind, requestDigest: string, clientId?: string): Promise<ClientOperation | undefined> {
  const raw = await secrets.get(opKey(operationId));
  if (raw === undefined) return undefined;
  let value: unknown;
  try { value = JSON.parse(raw); } catch { throw new Error("key_conflict"); }
  // Historical receipts lack the semantic binding. Preserve their bytes and
  // refuse ambiguous replay instead of claiming a requested restriction applied.
  if (!isDataRecord(value) || Object.keys(value).sort().join(",") !== "clientId,kind,requestDigest,revision,schemaVersion" ||
      value.schemaVersion !== 1 || value.kind !== kind || value.requestDigest !== requestDigest ||
      typeof value.clientId !== "string" || !UUID_V4.test(value.clientId) || (clientId !== undefined && value.clientId !== clientId) ||
      !Number.isSafeInteger(value.revision) || Number(value.revision) < 1) throw new Error("key_conflict");
  return value as ClientOperation;
}
async function saveOperation(secrets: SecretStore, operationId: string, operation: Omit<ClientOperation, "schemaVersion">): Promise<void> {
  await secrets.set(opKey(operationId), JSON.stringify({ schemaVersion: 1, ...operation }));
}

/** BrowserSessionService owns this credential lease independently of key policy. */
async function hasBrowserSessionLease(secrets: SecretStore, clientId: string): Promise<boolean> {
  const registration = await readClientRegistration(secrets, clientId);
  if(registration?.audience === "pwa" && registration.enrolledVia === "browser-session")return true;
  if(!registration||registration.enrolledVia !== 'pairing'||!registration.browserOrigin||
    !(registration.audience === 'browser-extension'||registration.audience === 'pwa'&&isPublicPwaOrigin(registration.browserOrigin)))return false;
  const raw=await secrets.get('local:client:'+clientId+':workspace-key');
  if(!raw)return false;
  try{return await secrets.get(browserEnrollmentKey(registration.browserOrigin,JSON.parse(raw)))===clientId;}catch{return false;}
}

export interface ClientDelegation { ownerPrincipalId: string; workspaceId: string; memberId: string; projectIds: string[]; scopes: ClientKeyScope[]; expiresAt: string; }

interface ClientMeta {
  delegation?: ClientDelegation;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
  usageBasis: string;
}

/** Stored authority is either valid or refused. Corruption is never a legacy marker. */
function parseStoredPolicy(raw: string, clientId: string): ClientKeyPolicy | undefined {
  try {
    const policy = parseClientKeyPolicy(JSON.parse(raw));
    return policy.id === clientId ? policy : undefined;
  } catch { return undefined; }
}

function parseStoredMeta(raw: string | undefined): ClientMeta | undefined {
  if (raw === undefined) return undefined;
  try {
    const value: unknown = JSON.parse(raw);
    const date = (input: unknown): input is string => typeof input === "string" && Number.isFinite(Date.parse(input));
    const id = (input: unknown): input is string => typeof input === "string" && input.length >= 1 && input.length <= 200;
    if (!isDataRecord(value) || Object.keys(value).some(key => !["createdAt", "lastUsedAt", "revokedAt", "usageBasis", "delegation"].includes(key)) ||
      !date(value.createdAt) || !(value.lastUsedAt === null || date(value.lastUsedAt)) ||
      !(value.revokedAt === null || date(value.revokedAt)) || typeof value.usageBasis !== "string" || value.usageBasis.length < 1 || value.usageBasis.length > 80) return undefined;
    let delegation: ClientDelegation | undefined;
    if (Object.hasOwn(value, "delegation")) {
      const d = value.delegation;
      if (!isDataRecord(d) || Object.keys(d).some(key => !["ownerPrincipalId", "workspaceId", "memberId", "projectIds", "scopes", "expiresAt"].includes(key)) ||
        !id(d.ownerPrincipalId) || !id(d.workspaceId) || !id(d.memberId) || !date(d.expiresAt) ||
        !Array.isArray(d.projectIds) || d.projectIds.length < 1 || d.projectIds.length > 64 || !d.projectIds.every(id) ||
        !Array.isArray(d.scopes) || d.scopes.length < 1 || d.scopes.length > CLIENT_KEY_SCOPES.length ||
        !d.scopes.every(scope => typeof scope === "string" && (CLIENT_KEY_SCOPES as readonly string[]).includes(scope))) return undefined;
      delegation = { ownerPrincipalId: d.ownerPrincipalId, workspaceId: d.workspaceId, memberId: d.memberId, projectIds: [...d.projectIds], scopes: [...d.scopes] as ClientKeyScope[], expiresAt: d.expiresAt };
    }
    return { createdAt: value.createdAt, lastUsedAt: value.lastUsedAt as string | null, revokedAt: value.revokedAt as string | null, usageBasis: value.usageBasis, ...(delegation ? { delegation } : {}) };
  } catch { return undefined; }
}

async function readJson<T>(secrets: SecretStore, key: string): Promise<T | undefined> {
  const raw = await secrets.get(key);
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return undefined;
  }
}

async function readIndex(secrets: SecretStore): Promise<string[]> {
  const list = await readJson<string[]>(secrets, INDEX_KEY);
  return Array.isArray(list) ? list.filter((id) => typeof id === "string" && UUID_V4.test(id)) : [];
}

async function writeIndex(secrets: SecretStore, ids: string[]): Promise<void> {
  await secrets.set(INDEX_KEY, JSON.stringify(ids));
}

export function prefixMaskedFor(clientId: string): string {
  return `utk_local_${clientId.slice(0, 8)}\u2026${clientId.slice(-4)}`;
}

export async function migrateLegacyClient(secrets: SecretStore, clientId: string): Promise<ClientKeyPolicy | undefined> {
  return serialMutation(secrets, `client:${clientId}`, () => migrateLegacyClientLocked(secrets, clientId));
}
async function migrateLegacyClientLocked(secrets: SecretStore, clientId: string): Promise<ClientKeyPolicy | undefined> {
  if (!UUID_V4.test(clientId)) return undefined;
  const token = await secrets.get(tokenKey(clientId));
  if (!token || parseClientTokenFormat(token) !== clientId) return undefined;
  const existing = await secrets.get(policyKey(clientId));
  if (existing !== undefined) return parseStoredPolicy(existing, clientId);
  // A managed record that lost its policy must be recovered explicitly, never widened.
  if (await secrets.get(metaKey(clientId)) !== undefined) return undefined;
  const indexRaw = await secrets.get(INDEX_KEY);
  let index: string[] = [];
  if (indexRaw !== undefined) {
    try {
      const parsed: unknown = JSON.parse(indexRaw);
      if (!Array.isArray(parsed) || !parsed.every(id => typeof id === "string" && UUID_V4.test(id)) || parsed.includes(clientId)) return undefined;
      index = parsed;
    } catch { return undefined; }
  }
  const expiresAt = await secrets.get(expiresKey(clientId));
  if (expiresAt !== undefined && !Number.isFinite(Date.parse(expiresAt))) return undefined;
  // A signed first-party session renews its lease independently of optional policy limits.
  // Do not copy the first 24h lease into a permanent policy expiry. Existing policies above
  // are never rewritten: an explicit limit always retains its original authority.
  let renewableSession = false;
  try {
    renewableSession = await hasBrowserSessionLease(secrets, clientId);
  } catch { return undefined; }
  const policy = parseClientKeyPolicy({
    schemaVersion: 1,
    id: clientId,
    revision: 1,
    label: "cliente legado",
    principalId: "local",
    projectIds: [],
    providerIds: [],
    modelIds: [],
    scopes: LEGACY_DEFAULT_SCOPES,
    expiresAt: renewableSession ? null : expiresAt ?? null,
    enabled: true,
  });
  await secrets.set(policyKey(clientId), JSON.stringify(policy));
  await secrets.set(metaKey(clientId), JSON.stringify({
      createdAt: new Date().toISOString(),
      lastUsedAt: null,
      revokedAt: null,
      usageBasis: "local_device_estimate",
  } satisfies ClientMeta));
  if (!index.includes(clientId)) await writeIndex(secrets, [...index, clientId]);
  return policy;
}

export async function loadClientPolicy(secrets: SecretStore, clientId: string): Promise<{ policy: ClientKeyPolicy; meta: ClientMeta } | undefined> {
  return serialMutation(secrets, `client:${clientId}`, () => loadClientPolicyLocked(secrets, clientId));
}
async function loadClientPolicyLocked(secrets: SecretStore, clientId: string): Promise<{ policy: ClientKeyPolicy; meta: ClientMeta } | undefined> {
  if (!UUID_V4.test(clientId)) return undefined;
  const raw = await secrets.get(policyKey(clientId));
  const policy = raw === undefined ? await migrateLegacyClientLocked(secrets, clientId) : parseStoredPolicy(raw, clientId);
  if (!policy) return undefined;
  const meta = parseStoredMeta(await secrets.get(metaKey(clientId)));
  if (!meta) return undefined;
  return { policy, meta };
}

export async function clientKeyView(secrets: SecretStore, clientId: string): Promise<ClientKeyView | undefined> {
  return serialMutation(secrets, `client:${clientId}`, () => clientKeyViewLocked(secrets, clientId));
}
async function clientKeyViewLocked(secrets: SecretStore, clientId: string): Promise<ClientKeyView | undefined> {
  const loaded = await loadClientPolicyLocked(secrets, clientId);
  if (!loaded) return undefined;
  return {
    ...loaded.policy,
    prefixMasked: prefixMaskedFor(clientId),
    createdAt: loaded.meta.createdAt,
    lastUsedAt: loaded.meta.lastUsedAt,
    revokedAt: loaded.meta.revokedAt,
    usageBasis: loaded.meta.usageBasis,
  };
}

export function isAdminTokenFormat(token: string): boolean {
  return ADMIN_TOKEN.test(token);
}

export function parseClientTokenFormat(token: string): string | undefined {
  return CLIENT_TOKEN.exec(token)?.[1]?.toLowerCase();
}

/** Authenticate bearer without touching provider. Returns resolved principal or typed error. */
export async function resolveBearer(secrets: SecretStore, supplied: string | undefined, now = Date.now()): Promise<{ ok: true; resolved: ResolvedClient } | { ok: false; error: Extract<ClientKeyError, "token_invalid" | "token_expired" | "token_revoked"> }> {
  if (!supplied || !Number.isFinite(now)) return { ok: false, error: "token_invalid" };
  if (isAdminTokenFormat(supplied) && !CLIENT_TOKEN.test(supplied)) {
    const expected = await secrets.get("local:api-token");
    if (expected && safeEqual(supplied, expected)) return { ok: true, resolved: { kind: "admin" } };
    return { ok: false, error: "token_invalid" };
  }
  const clientId = parseClientTokenFormat(supplied);
  if (!clientId) return { ok: false, error: "token_invalid" };
  // Token, policy and lease must be one process-local authorization snapshot.
  // A rotation cannot splice the old token into a newly broadened policy.
  return serialMutation(secrets, `client:${clientId}`, async () => {
  const expected = await secrets.get(tokenKey(clientId));
  if (!expected || !safeEqual(expected.startsWith('sha256:') ? 'sha256:'+createHash('sha256').update(supplied).digest('hex') : supplied, expected)) {
    // Revoked keys lose their token immediately; still report revoked, not invalid.
    const prior = await loadClientPolicyLocked(secrets, clientId);
    if (prior && (prior.meta.revokedAt || !prior.policy.enabled)) return { ok: false, error: "token_revoked" };
    return { ok: false, error: "token_invalid" };
  }
  const loaded = await loadClientPolicyLocked(secrets, clientId);
  if (!loaded) return { ok: false, error: "token_invalid" };
  if(expected.startsWith("sha256:")&&!loaded.meta.delegation)return {ok:false,error:"token_invalid"};
  if (loaded.meta.revokedAt || !loaded.policy.enabled) return { ok: false, error: "token_revoked" };
  // The enrollment expiry and the scoped policy can each narrow validity; neither extends the other.
  const credentialExpiry = await secrets.get(expiresKey(clientId));
  if (credentialExpiry !== undefined) {
    const expiryMs = Date.parse(credentialExpiry);
    if (!Number.isFinite(expiryMs)) return { ok: false, error: "token_invalid" };
    if (expiryMs <= now) return { ok: false, error: "token_expired" };
  } else {
    try {
      if (await hasBrowserSessionLease(secrets, clientId)) return { ok: false, error: "token_invalid" };
    } catch { return { ok: false, error: "token_invalid" }; }
  }
  if (loaded.policy.expiresAt && Date.parse(loaded.policy.expiresAt) <= now) return { ok: false, error: "token_expired" };
  const registration = await readClientRegistration(secrets, clientId);
  return { ok: true, resolved: { kind: "client", policy: loaded.policy, clientId, ...(registration ? {registration} : {}), ...(loaded.meta.delegation ? {delegation:loaded.meta.delegation} : {}) } };
  });
}

const ROUTE_SCOPE: Array<{ prefix: string; scope: ClientKeyScope }> = [
  { prefix: "/v1/chat/completions", scope: "inference:chat" },
  { prefix: "/v1/completions", scope: "inference:chat" },
  { prefix: "/v1/responses", scope: "inference:responses" },
  { prefix: "/v1/messages/count_tokens", scope: "inference:messages" },
  { prefix: "/v1/messages", scope: "inference:messages" },
  { prefix: "/v1/models", scope: "models:read" },
  { prefix: "/v1/usage", scope: "usage:read" },
];

export function requiredScopeFor(path: string): ClientKeyScope | undefined {
  for (const entry of ROUTE_SCOPE) {
    if (path === entry.prefix || path.startsWith(entry.prefix + "/") || path.startsWith(entry.prefix + "?")) return entry.scope;
  }
  return undefined;
}

export function checkRouteScope(resolved: ResolvedClient, path: string): ClientKeyError | undefined {
  if (resolved.kind === "admin") return undefined;
  const required = requiredScopeFor(path);
  if (!required) return undefined;
  if (!resolved.policy?.scopes.includes(required)) return "scope_denied";
  return undefined;
}

export function checkModelScope(resolved: ResolvedClient, model: string | undefined): ClientKeyError | undefined {
  if (resolved.kind === "admin") return undefined;
  const allowed = resolved.policy?.modelIds ?? [];
  if (!allowed.length || !model) return undefined;
  if (!allowed.includes(model)) return "model_scope_denied";
  return undefined;
}

export function checkOutputLimit(resolved: ResolvedClient, maxTokens: number | undefined): ClientKeyError | undefined {
  if (resolved.kind === "admin") return undefined;
  const cap = resolved.policy?.limits?.maxOutputTokens;
  if (cap !== undefined && maxTokens !== undefined && maxTokens > cap) return "key_limit_exceeded";
  return undefined;
}

export async function recordClientUse(secrets: SecretStore, clientId: string): Promise<void> {
  return serialMutation(secrets, `client:${clientId}`, async () => {
  const meta = parseStoredMeta(await secrets.get(metaKey(clientId)));
  if (!meta) return; // Observability must not repair or recreate security metadata.
  meta.lastUsedAt = new Date().toISOString();
  await secrets.set(metaKey(clientId), JSON.stringify(meta));
  });
}

/** Per-key RPM + concurrency governor (in-memory; survives per process). */
export class ClientKeyGovernor {
  private readonly rpm = new Map<string, number[]>();
  private readonly concurrent = new Map<string, number>();

  checkRpm(policy: ClientKeyPolicy, now = Date.now()): boolean {
    const cap = policy.limits?.requestsPerMinute;
    if (cap === undefined) return true;
    const window = (this.rpm.get(policy.id) ?? []).filter((t) => now - t < 60_000);
    if (window.length >= cap) {
      this.rpm.set(policy.id, window);
      return false;
    }
    window.push(now);
    this.rpm.set(policy.id, window);
    return true;
  }

  tryAcquireConcurrent(policy: ClientKeyPolicy): (() => void) | undefined {
    const cap = policy.limits?.maxConcurrent;
    if (cap === undefined) return () => undefined;
    const active = this.concurrent.get(policy.id) ?? 0;
    if (active >= cap) return undefined;
    this.concurrent.set(policy.id, active + 1);
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.concurrent.set(policy.id, Math.max(0, (this.concurrent.get(policy.id) ?? 1) - 1));
    };
  }
}

export interface CreateKeyInput {
  retentionMode?: ClientKeyPolicy["retentionMode"];
  delegation?: ClientDelegation;
  label: string;
  scopes: ClientKeyScope[];
  projectIds?: string[];
  providerIds?: string[];
  modelIds?: string[];
  expiresAt?: string | null;
  limits?: ClientKeyPolicy["limits"];
  operationId: string;
  principalId?: string;
}

export async function createClientKey(
  secrets: SecretStore,
  input: CreateKeyInput,
): Promise<{ policy: ClientKeyPolicy; view: ClientKeyView; token: string }> {
  input = snapshotInput(input);
  const normalized = parseClientKeyPolicy({schemaVersion:1,id:"00000000-0000-4000-8000-000000000000",revision:1,
    label:input.label,principalId:input.principalId ?? "local",projectIds:input.projectIds ?? [],providerIds:input.providerIds ?? [],modelIds:input.modelIds ?? [],
    scopes:input.scopes,expiresAt:input.expiresAt ?? null,enabled:true,...(input.limits ? {limits:input.limits} : {}),
    ...(input.retentionMode !== undefined ? {retentionMode:input.retentionMode} : {})});
  const requestDigest = operationDigest("create", null, {...normalized,retentionMode:normalized.retentionMode ?? "standard",delegation:input.delegation ?? null});
  return serialMutation(secrets, `operation:${input.operationId}`, () => serialMutation(secrets, "create-index", () => createClientKeyLocked(secrets,input,requestDigest)));
}
async function createClientKeyLocked(secrets: SecretStore, input: CreateKeyInput, requestDigest: string): Promise<{ policy: ClientKeyPolicy; view: ClientKeyView; token: string }> {
  const seen = await readOperation(secrets, input.operationId, "create", requestDigest);
  if (seen) {
    if (input.delegation) throw new Error("reveal_unavailable");
    return serialMutation(secrets, `client:${seen.clientId}`, async () => {
      const token = await secrets.get(tokenKey(seen.clientId));
      const view = await clientKeyViewLocked(secrets, seen.clientId);
      const loaded = await loadClientPolicyLocked(secrets, seen.clientId);
      if(token?.startsWith('sha256:'))throw new Error('reveal_unavailable');
      if (token && view && loaded && view.revision === seen.revision && loaded.policy.revision === seen.revision) return { policy: loaded.policy, view, token };
      throw new Error("key_conflict");
    });
  }
  const index = await readIndex(secrets);
  if (index.length >= CLIENT_KEY_MAX_KEYS) throw new Error("key_capacity_exceeded");
  if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80) throw new Error("client_key_invalid");
  const clientId = randomUUID();
  const token = `utk_local_${clientId}.${randomBytes(24).toString("base64url")}`;
  const now = new Date().toISOString();
  const policy = parseClientKeyPolicy({
    schemaVersion: 1,
    id: clientId,
    revision: 1,
    label: input.label,
    principalId: input.principalId ?? "local",
    projectIds: input.projectIds ?? [],
    providerIds: input.providerIds ?? [],
    modelIds: input.modelIds ?? [],
    scopes: input.scopes,
    expiresAt: input.expiresAt ?? null,
    enabled: true,
    ...(input.retentionMode !== undefined ? { retentionMode: input.retentionMode } : {}),
    ...(input.limits ? { limits: input.limits } : {}),
  });
  // A delegated key is unusable until its mandatory binding and policy are durable.
  if (policy.expiresAt) await secrets.set(expiresKey(clientId), policy.expiresAt);
  await secrets.set(policyKey(clientId), JSON.stringify(policy));
  await secrets.set(metaKey(clientId), JSON.stringify({ createdAt: now, lastUsedAt: null, revokedAt: null, usageBasis: "local_device_estimate", ...(input.delegation ? {delegation:input.delegation} : {}) } satisfies ClientMeta));
  await secrets.set(tokenKey(clientId), input.delegation ? "sha256:"+createHash("sha256").update(token).digest("hex") : token);
  await writeIndex(secrets, [...index, clientId]);
  await saveOperation(secrets,input.operationId,{kind:"create",clientId,revision:1,requestDigest});
  const view = (await clientKeyView(secrets, clientId))!;
  return { policy, view, token };
}

export async function listClientKeys(secrets: SecretStore, limit = 100, cursor?: string): Promise<{ keys: ClientKeyView[]; nextCursor: string | null }> {
  const capped = Math.max(1, Math.min(100, limit));
  const index = (await readIndex(secrets)).sort();
  let start = 0;
  if (cursor) {
    const at = index.indexOf(cursor);
    start = at >= 0 ? at + 1 : 0;
  }
  const page = index.slice(start, start + capped);
  const keys: ClientKeyView[] = [];
  for (const id of page) {
    const view = await clientKeyView(secrets, id);
    if (view) keys.push(view);
  }
  const nextCursor = start + page.length < index.length ? page[page.length - 1]! : null;
  return { keys, nextCursor };
}

export interface UpdateKeyInput {
  retentionMode?: ClientKeyPolicy["retentionMode"];
  expectedRevision: number;
  operationId: string;
  label?: string;
  projectIds?: string[];
  providerIds?: string[];
  modelIds?: string[];
  scopes?: ClientKeyScope[];
  expiresAt?: string | null;
  enabled?: boolean;
  limits?: ClientKeyPolicy["limits"] | null;
}

export async function updateClientKey(secrets: SecretStore, clientId: string, input: UpdateKeyInput): Promise<ClientKeyView> {
  input = snapshotInput(input);
  const requestDigest = operationDigest("update",clientId,input);
  const view = await serialMutation(secrets, `operation:${input.operationId}`, () => serialMutation(secrets, `client:${clientId}`, () => updateClientKeyLocked(secrets,clientId,input,requestDigest)));
  // B9-reparo C: a committed policy change ends sink authority; the next authenticated request re-admits it.
  sharedSinkAuthority().endCredential(clientId, view.enabled === false ? 'credential_revoked' : 'credential_changed');
  return view;
}
async function updateClientKeyLocked(secrets: SecretStore, clientId: string, input: UpdateKeyInput, requestDigest: string): Promise<ClientKeyView> {
  const seen = await readOperation(secrets, input.operationId, "update", requestDigest, clientId);
  if (seen) {
    const view = await clientKeyViewLocked(secrets, clientId);
    if (view && view.revision >= seen.revision) return view;
    throw new Error("key_conflict");
  }
  const loaded = await loadClientPolicyLocked(secrets, clientId);
  if (!loaded) throw new Error("key_not_found");
  if (loaded.policy.revision !== input.expectedRevision) throw new Error("key_conflict");
  if (loaded.meta.revokedAt) throw new Error("key_not_found");
  // Do not let an edit of label/scopes/limits erase or extend a signed session's lease.
  // Resolve its owner before any writes; an invalid registration is not a regular key.
  const renewableSession = await hasBrowserSessionLease(secrets, clientId);
  const next = parseClientKeyPolicy({
    ...loaded.policy,
    revision: loaded.policy.revision + 1,
    label: input.label ?? loaded.policy.label,
    projectIds: input.projectIds ?? [...loaded.policy.projectIds],
    providerIds: input.providerIds ?? [...loaded.policy.providerIds],
    modelIds: input.modelIds ?? [...loaded.policy.modelIds],
    scopes: input.scopes ?? [...loaded.policy.scopes],
    expiresAt: input.expiresAt !== undefined ? input.expiresAt : loaded.policy.expiresAt,
    enabled: input.enabled ?? loaded.policy.enabled,
    ...(input.retentionMode !== undefined ? { retentionMode: input.retentionMode } : {}),
    ...(input.limits !== undefined ? (input.limits === null ? {} : { limits: input.limits }) : (loaded.policy.limits ? { limits: loaded.policy.limits } : {})),
  });
  await secrets.set(policyKey(clientId), JSON.stringify(next));
  if (!renewableSession) {
    if (next.expiresAt) await secrets.set(expiresKey(clientId), next.expiresAt);
    else await secrets.delete(expiresKey(clientId));
  }
  await saveOperation(secrets,input.operationId,{kind:"update",clientId,revision:next.revision,requestDigest});
  return (await clientKeyViewLocked(secrets, clientId))!;
}

export async function rotateClientKey(secrets: SecretStore, clientId: string, expectedRevision: number, operationId: string): Promise<{ view: ClientKeyView; token: string }> {
  const requestDigest = operationDigest("rotate",clientId,{expectedRevision});
  const rotated = await serialMutation(secrets, `operation:${operationId}`, () => serialMutation(secrets, `client:${clientId}`, () => rotateClientKeyLocked(secrets,clientId,expectedRevision,operationId,requestDigest)));
  sharedSinkAuthority().endCredential(clientId, 'credential_changed');
  return rotated;
}
async function rotateClientKeyLocked(secrets: SecretStore, clientId: string, expectedRevision: number, operationId: string, requestDigest: string): Promise<{ view: ClientKeyView; token: string }> {
  const seen = await readOperation(secrets, operationId, "rotate", requestDigest, clientId);
  if (seen) {
    const view = await clientKeyViewLocked(secrets, clientId);
    const token = await secrets.get(tokenKey(clientId));
    if(token?.startsWith('sha256:'))throw new Error('reveal_unavailable');
    if (view && token && view.revision === seen.revision) return { view, token };
    throw new Error("key_conflict");
  }
  const loaded = await loadClientPolicyLocked(secrets, clientId);
  if (!loaded) throw new Error("key_not_found");
  if (loaded.meta.revokedAt || !loaded.policy.enabled) throw new Error("key_not_found");
  if (loaded.policy.revision !== expectedRevision) throw new Error("key_conflict");
  const token = `utk_local_${clientId}.${randomBytes(24).toString("base64url")}`;
  const previous = await secrets.get(tokenKey(clientId));
  try {
    await secrets.set(tokenKey(clientId), loaded.meta.delegation ? "sha256:"+createHash("sha256").update(token).digest("hex") : token);
    const next = parseClientKeyPolicy({ ...loaded.policy, revision: loaded.policy.revision + 1 });
    await secrets.set(policyKey(clientId), JSON.stringify(next));
  } catch (error) {
    if (previous) {
      try {
        await secrets.set(tokenKey(clientId), previous);
      } catch (rollbackError) {
        throw new AggregateError([error, rollbackError], "client_rotation_rollback_failed");
      }
    }
    throw error;
  }
  await saveOperation(secrets,operationId,{kind:"rotate",clientId,revision:loaded.policy.revision+1,requestDigest});
  return { view: (await clientKeyViewLocked(secrets, clientId))!, token };
}

export async function revokeClientKey(secrets: SecretStore, clientId: string, expectedRevision: number, operationId: string): Promise<ClientKeyView> {
  const requestDigest = operationDigest("revoke",clientId,{expectedRevision});
  const revoked = await serialMutation(secrets, `operation:${operationId}`, () => serialMutation(secrets, `client:${clientId}`, () => revokeClientKeyLocked(secrets,clientId,expectedRevision,operationId,requestDigest)));
  // B9-reparo C: in-flight calls and late callbacks of the revoked credential lose every sink.
  sharedSinkAuthority().endCredential(clientId, 'credential_revoked');
  return revoked;
}
async function revokeClientKeyLocked(secrets: SecretStore, clientId: string, expectedRevision: number, operationId: string, requestDigest: string): Promise<ClientKeyView> {
  const seen = await readOperation(secrets, operationId, "revoke", requestDigest, clientId);
  if (seen) {
    const view = await clientKeyViewLocked(secrets,clientId);
    if (view && view.revokedAt && view.revision >= seen.revision) return view;
    throw new Error("key_conflict");
  }
  const loaded = await loadClientPolicyLocked(secrets, clientId);
  if (!loaded) throw new Error("key_not_found");
  if (loaded.policy.revision !== expectedRevision) throw new Error("key_conflict");
  if (loaded.meta.revokedAt) return (await clientKeyViewLocked(secrets, clientId))!;
  const next = parseClientKeyPolicy({ ...loaded.policy, revision: loaded.policy.revision + 1, enabled: false });
  await secrets.set(policyKey(clientId), JSON.stringify(next));
  // Immediate effect: new requests fail without touching provider.
  await secrets.delete(tokenKey(clientId));
  await secrets.delete(expiresKey(clientId));
  const meta: ClientMeta = { ...loaded.meta, revokedAt: new Date().toISOString() };
  await secrets.set(metaKey(clientId), JSON.stringify(meta));
  await saveOperation(secrets,operationId,{kind:"revoke",clientId,revision:next.revision,requestDigest});
  return (await clientKeyViewLocked(secrets, clientId))!;
}

/** Snapshot a previously approved browser identity. A proof never enrolls an unknown client. */
export async function pairedBrowserSessionAuthority(secrets:SecretStore,clientId:string,origin:string,publicKey:string,now=Date.now()):Promise<string> {
 return serialMutation(secrets,'client:'+clientId,()=>pairedBrowserSessionAuthorityLocked(secrets,clientId,origin,publicKey,now));
}
async function pairedBrowserSessionAuthorityLocked(secrets:SecretStore,clientId:string,origin:string,publicKey:string,now:number):Promise<string> {
 const registration=await readClientRegistration(secrets,clientId);
 const audience=isPublicPwaOrigin(origin)?'pwa':'browser-extension';
 if(registration?.audience!==audience||registration.enrolledVia!=='pairing'||registration.browserOrigin!==origin)throw Error('browser_enrollment_rejected');
 const storedKey=await secrets.get('local:client:'+clientId+':workspace-key');
 const token=await secrets.get(tokenKey(clientId));
 if(storedKey!==publicKey||!token||parseClientTokenFormat(token)!==clientId||await secrets.get(browserEnrollmentKey(origin,JSON.parse(publicKey)))!==clientId)throw Error('browser_enrollment_rejected');
 const loaded=await loadClientPolicyLocked(secrets,clientId);
 if(!loaded||loaded.meta.revokedAt||loaded.meta.delegation||!loaded.policy.enabled||loaded.policy.retentionMode==='ephemeral'||loaded.policy.expiresAt&&Date.parse(loaded.policy.expiresAt)<=now)throw Error('browser_enrollment_rejected');
 return createHash('sha256').update(JSON.stringify([registration,loaded.policy,publicKey])).digest('hex');
}
/** Rotate a short-lived bearer under the same lock as policy edits and revocation. */
export async function renewPairedBrowserSession(secrets:SecretStore,clientId:string,origin:string,publicKey:string,expectedAuthority:string,now=Date.now()):Promise<{token:string;clientId:string}> {
 return serialMutation(secrets,'client:'+clientId,async()=>{
  const authority=await pairedBrowserSessionAuthorityLocked(secrets,clientId,origin,publicKey,now);
  if(authority!==expectedAuthority)throw Error('browser_authority_changed');
  const token='utk_local_'+clientId+'.'+randomBytes(24).toString('base64url');
  // A failed final write leaves the replacement expired. No prior token is revived.
  await secrets.set(expiresKey(clientId),new Date(0).toISOString());
  await secrets.set(tokenKey(clientId),token);
  await secrets.set(expiresKey(clientId),new Date(now+12*60*60*1000).toISOString());
  return {token,clientId};
 });
}
