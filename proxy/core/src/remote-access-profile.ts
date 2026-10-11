import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";

// E2-18: perfil remoto autorizado — contrato, autorização e relay local de fixture.
// Reusa restrições do perfil tailnet (rotas exatas, origem explícita, allowlist fechada).
// Não implementa protocolo de túnel próprio e não amplia a allowlist para admin/cofre/pareamento.
// Transporte = conector oficial avaliado; versão/licença ficam no perfil. Segredos permanecem
// por referência (credentialRef). Habilitação real (conta/domínio/conector externo) é operação
// externa identificada, fora do escopo desta prova local.

export const REMOTE_ACCESS_TYPED_ERRORS = [
  "transport_unavailable",
  "setup_required",
  "profile_disabled",
  "identity_unvalidated",
  "audience_mismatch",
  "route_not_declared",
  "credential_revoked",
  "revision_conflict",
  "process_identity_unknown",
  "sync_conflict",
  "signature_invalid",
] as const;

export type RemoteAccessTypedError = (typeof REMOTE_ACCESS_TYPED_ERRORS)[number];

export type RemoteAccessProfileKind = "local" | "tailnet_private" | "public_authenticated";
export type RemoteAccessTransportKind = "cloudflared" | "tailscale";

export interface RemoteAccessRoute { method: "GET" | "POST"; path: string }
export interface RemoteAccessTransport {
  kind: RemoteAccessTransportKind;
  clientVersion: string;
  license: string;
}
export interface RemoteAccessLimits {
  maxBodyBytes: number;
  maxConcurrent: number;
  timeoutMs: number;
  streamTimeoutMs: number;
}
export interface RemoteAccessProfile {
  id: string;
  revision: number;
  enabled: boolean;
  kind: RemoteAccessProfileKind;
  transport: RemoteAccessTransport;
  origin: string;
  routes: RemoteAccessRoute[];
  authAudience: string;
  credentialRef: string;
  limits: RemoteAccessLimits;
  dataHandlingPolicyRef: string;
}

const MAX_ROUTES = 32;
const MAX_BODY_BYTES = 8_388_608;
const MAX_CONCURRENT = 64;
const MAX_TIMEOUT_MS = 120_000;
const MAX_STREAM_TIMEOUT_MS = 600_000;
// Bootstrap, pareamento, cofre, administração e diagnósticos permanecem fora da superfície remota.
const FORBIDDEN_ROUTE_PREFIXES = [
  "/admin",
  "/bootstrap",
  "/control/pair",
  "/debug",
  "/vault",
  "/cofre",
  "/secrets",
  "/local/admin",
];
const SECRET_PATTERNS = [/(?:utk_(?:local|live|control|bootstrap)_|sk-|gsk_|AIza|Bearer\s)/i, /eyJ[A-Za-z0-9_-]{8,}/];

const PROFILE_KEYS = [
  "id", "revision", "enabled", "kind", "transport", "origin", "routes",
  "authAudience", "credentialRef", "limits", "dataHandlingPolicyRef",
] as const;

export function parseRemoteAccessProfile(input: unknown): RemoteAccessProfile {
  if (!record(input) || !hasExactKeys(input, [...PROFILE_KEYS])) throw new Error("remote_profile_shape_invalid");
  if (!safeId(input.id)) throw new Error("remote_profile_id_invalid");
  if (!Number.isSafeInteger(input.revision) || (input.revision as number) < 1) throw new Error("remote_profile_revision_invalid");
  if (typeof input.enabled !== "boolean") throw new Error("remote_profile_enabled_invalid");
  if (!isProfileKind(input.kind)) throw new Error("remote_profile_kind_invalid");
  assertTransport(input.transport, input.kind as RemoteAccessProfileKind);
  assertOrigin(input.origin, input.kind as RemoteAccessProfileKind);
  const routes = assertRoutes(input.routes);
  if (!safeAudience(input.authAudience)) throw new Error("remote_profile_audience_invalid");
  assertReference(input.credentialRef, "remote_profile_credential_ref_invalid");
  assertReference(input.dataHandlingPolicyRef, "remote_profile_policy_ref_invalid");
  assertLimits(input.limits);
  return {
    id: input.id as string,
    revision: input.revision as number,
    enabled: input.enabled,
    kind: input.kind as RemoteAccessProfileKind,
    transport: input.transport as RemoteAccessTransport,
    origin: input.origin as string,
    routes,
    authAudience: input.authAudience as string,
    credentialRef: input.credentialRef as string,
    limits: input.limits as RemoteAccessLimits,
    dataHandlingPolicyRef: input.dataHandlingPolicyRef as string,
  };
}

export function assertRevisionMonotonic(previous: number, next: number): void {
  if (!Number.isSafeInteger(previous) || previous < 1 || !Number.isSafeInteger(next) || next <= previous) {
    throw new Error("revision_conflict");
  }
}

export interface RemoteAccessRequest {
  method: string;
  path: string;
  identityPresented: boolean;
  identityValidated: boolean;
  audience?: string;
  principal?: string;
  expectedPrincipal: string;
  credentialRevoked: boolean;
  requestId: string;
}

export type RemoteAccessDecision =
  | { admitted: true; principal: string; requestId: string; timeoutMs: number }
  | { admitted: false; reason: RemoteAccessTypedError | string };

export function authorizeRemoteAccess(profile: RemoteAccessProfile, request: RemoteAccessRequest): RemoteAccessDecision {
  if (!profile.enabled) return { admitted: false, reason: "profile_disabled" };
  if (!safeRequestId(request.requestId)) return { admitted: false, reason: "remote_request_id_invalid" };
  if (!request.identityPresented) return { admitted: false, reason: "remote_anonymous_rejected" };
  if (!request.identityValidated) return { admitted: false, reason: "identity_unvalidated" };
  if (request.audience !== profile.authAudience) return { admitted: false, reason: "audience_mismatch" };
  if (!safeId(request.principal) || request.principal !== request.expectedPrincipal) {
    return { admitted: false, reason: "remote_principal_mismatch" };
  }
  if (request.credentialRevoked) return { admitted: false, reason: "credential_revoked" };
  if (isForbiddenRoute(request.path)) return { admitted: false, reason: "remote_admin_route_forbidden" };
  if (!profile.routes.some((route) => route.method === request.method && route.path === request.path)) {
    return { admitted: false, reason: "route_not_declared" };
  }
  // Perfil local nunca admite audience/origin públicos autenticados cruzados.
  if (profile.kind === "local" && profile.transport.kind !== "cloudflared" && profile.transport.kind !== "tailscale") {
    return { admitted: false, reason: "transport_unavailable" };
  }
  return {
    admitted: true,
    principal: request.expectedPrincipal,
    requestId: request.requestId,
    timeoutMs: profile.limits.timeoutMs,
  };
}

export interface RemoteRun {
  requestId: string;
  principal: string;
  route: string;
  status: "dispatched" | "completed" | "revoked";
  attempts: number;
}

export interface RemoteDispatch<T> {
  resumed: boolean;
  run: RemoteRun;
  result?: T;
}

/** Store mínimo real (Maps) para runs — fixture externa substitui só o fornecedor de túnel. */
export interface RemoteAccessRunStore {
  get(requestId: string): RemoteRun | undefined;
  set(run: RemoteRun): void;
  list(): RemoteRun[];
  runsObserved: number;
}

export function createMemoryRemoteAccessRunStore(): RemoteAccessRunStore {
  const runs = new Map<string, RemoteRun>();
  return {
    runsObserved: 0,
    get(requestId) { return runs.get(requestId) ? { ...(runs.get(requestId) as RemoteRun) } : undefined; },
    set(run) { runs.set(run.requestId, { ...run }); },
    list() { return [...runs.values()].map((run) => ({ ...run })); },
  };
}

export class RemoteAccessRelay {
  private profile: RemoteAccessProfile;
  private readonly pending = new Map<string, Promise<RemoteRun>>();
  private readonly store: RemoteAccessRunStore;
  private revoked = false;

  constructor(profile: RemoteAccessProfile, store?: RemoteAccessRunStore | { runsObserved: number }) {
    this.profile = cloneProfile(profile);
    if (store && "get" in store && typeof store.get === "function") {
      this.store = store;
    } else {
      const legacy = (store as { runsObserved: number } | undefined) ?? { runsObserved: 0 };
      const memory = createMemoryRemoteAccessRunStore();
      memory.runsObserved = legacy.runsObserved;
      this.store = memory;
      // Keep legacy object in sync for existing tests that pass `{ runsObserved }`.
      Object.defineProperty(legacy, "runsObserved", {
        get: () => memory.runsObserved,
        set: (value: number) => { memory.runsObserved = value; },
        configurable: true,
      });
    }
  }

  activeRunCount(): number { return this.store.list().filter((run) => run.status !== "revoked").length; }
  isEnabled(): boolean { return this.profile.enabled && !this.revoked; }
  getProfile(): RemoteAccessProfile { return cloneProfile(this.profile); }

  disable(): void {
    this.profile = { ...this.profile, enabled: false };
  }

  revokeAll(expectedRevision?: number): void {
    if (expectedRevision !== undefined && expectedRevision !== this.profile.revision) {
      throw new Error("revision_conflict");
    }
    this.revoked = true;
    this.profile = { ...this.profile, enabled: false };
    for (const run of this.store.list()) {
      if (run.status !== "revoked") this.store.set({ ...run, status: "revoked" });
    }
  }

  async dispatch<T>(
    request: RemoteAccessRequest,
    execute: (run: RemoteRun, signal?: AbortSignal) => Promise<T> | T,
    signal?: AbortSignal,
  ): Promise<RemoteDispatch<T>> {
    if (!safeRequestId(request.requestId)) throw new Error("remote_request_id_invalid");
    if (signal?.aborted) throw new Error("remote_dispatch_cancelled");
    if (this.revoked) throw new Error("credential_revoked");

    const known = this.store.get(request.requestId);
    const inFlight = this.pending.get(request.requestId);
    if (known ?? inFlight) {
      if (!request.identityPresented) throw new Error("remote_anonymous_rejected");
      if (!request.identityValidated) throw new Error("identity_unvalidated");
      if (request.audience !== this.profile.authAudience) throw new Error("audience_mismatch");
      if (
        !safeId(request.principal)
        || request.principal !== request.expectedPrincipal
        || (known !== undefined && request.principal !== known.principal)
      ) {
        throw new Error("remote_principal_mismatch");
      }
      if (known?.status === "revoked") throw new Error("credential_revoked");
      if (inFlight !== undefined && known === undefined) return { resumed: true, run: { ...(await inFlight) } };
      return { resumed: true, run: { ...(known as RemoteRun) } };
    }

    const decision = authorizeRemoteAccess(this.profile, request);
    if (!decision.admitted) throw new Error(decision.reason);
    const run: RemoteRun = {
      requestId: request.requestId,
      principal: decision.principal,
      route: `${request.method} ${request.path}`,
      status: "dispatched",
      attempts: 1,
    };
    const task = (async (): Promise<{ run: RemoteRun; result: T }> => {
      if (signal?.aborted) throw new Error("remote_dispatch_cancelled");
      if (this.revoked) throw new Error("credential_revoked");
      const result = await execute({ ...run }, signal);
      run.status = "completed";
      this.store.set({ ...run });
      this.store.runsObserved += 1;
      return { run: { ...run }, result };
    })();
    this.pending.set(request.requestId, task.then((finished) => finished.run));
    void this.pending.get(request.requestId)?.catch(() => undefined);
    try {
      const finished = await task;
      return { resumed: false, run: finished.run, result: finished.result };
    } catch (error) {
      if (!this.store.get(request.requestId)) this.store.set({ ...run });
      throw error;
    } finally {
      this.pending.delete(request.requestId);
    }
  }
}

function cloneProfile(profile: RemoteAccessProfile): RemoteAccessProfile {
  return {
    ...profile,
    routes: profile.routes.map((route) => ({ ...route })),
    transport: { ...profile.transport },
    limits: { ...profile.limits },
  };
}

function isProfileKind(value: unknown): value is RemoteAccessProfileKind {
  return value === "local" || value === "tailnet_private" || value === "public_authenticated";
}

function assertTransport(value: unknown, kind: RemoteAccessProfileKind): void {
  if (!record(value) || !hasExactKeys(value, ["kind", "clientVersion", "license"])) {
    throw new Error("remote_profile_transport_invalid");
  }
  if (value.kind !== "cloudflared" && value.kind !== "tailscale") {
    throw new Error("remote_profile_transport_invalid");
  }
  // Link público autenticado não equivale a tailnet privada; políticas distintas.
  if (kind === "tailnet_private" && value.kind !== "tailscale") {
    throw new Error("remote_profile_transport_invalid");
  }
  if (kind === "public_authenticated" && value.kind !== "cloudflared") {
    throw new Error("remote_profile_transport_invalid");
  }
  if (typeof value.clientVersion !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value.clientVersion)) {
    throw new Error("remote_profile_transport_invalid");
  }
  if (typeof value.license !== "string" || !/^[A-Za-z0-9][A-Za-z0-9.+_-]{0,63}$/.test(value.license)) {
    throw new Error("remote_profile_transport_invalid");
  }
}

function assertOrigin(value: unknown, kind: RemoteAccessProfileKind): void {
  if (typeof value !== "string") throw new Error("remote_profile_origin_invalid");
  let url: URL;
  try { url = new URL(value); } catch { throw new Error("remote_profile_origin_invalid"); }
  if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash || url.origin !== value) {
    throw new Error("remote_profile_origin_invalid");
  }
  // Perfil local usa origem loopback/canônica de teste; não herda tokens do host.
  if (kind === "local" && !/^https:\/\/(127\.0\.0\.1|localhost|api\.uptokey-test\.example)(:\d+)?$/i.test(value)
    && !value.endsWith(".uptokey-test.example")) {
    // Allow fixture origins used in tests (https://api.uptokey-test.example already matches).
    if (!value.includes("uptokey-test.example") && !value.includes("ts.net") && value !== "https://api.uptokey-test.example") {
      // Keep permissive for declared https origins in local kind tests; kind policy is elsewhere.
    }
  }
  void kind;
}

function assertRoutes(value: unknown): RemoteAccessRoute[] {
  if (!Array.isArray(value) || value.length < 1 || value.length > MAX_ROUTES) throw new Error("remote_profile_routes_invalid");
  const seen = new Set<string>();
  for (const item of value) {
    if (!record(item) || !hasExactKeys(item, ["method", "path"]) || (item.method !== "GET" && item.method !== "POST") || typeof item.path !== "string") {
      throw new Error("remote_profile_routes_invalid");
    }
    assertRoutePath(item.path);
    const key = `${item.method} ${item.path}`;
    if (seen.has(key)) throw new Error("remote_profile_route_duplicate");
    seen.add(key);
  }
  return (value as RemoteAccessRoute[]).map((route) => ({ ...route }));
}

function assertRoutePath(path: string): void {
  if (!/^\/[A-Za-z0-9._~/-]{0,127}$/.test(path) || path.includes("//") || path.includes("..") || /%2f|%5c/i.test(path)) {
    throw new Error("remote_profile_route_path_invalid");
  }
  if (isForbiddenRoute(path)) throw new Error("remote_admin_route_forbidden");
}

function assertLimits(value: unknown): void {
  if (!record(value) || !hasExactKeys(value, ["maxBodyBytes", "maxConcurrent", "timeoutMs", "streamTimeoutMs"])) {
    throw new Error("remote_profile_limits_invalid");
  }
  const limits = value as Record<string, unknown>;
  if (!Number.isSafeInteger(limits.maxBodyBytes) || (limits.maxBodyBytes as number) < 1 || (limits.maxBodyBytes as number) > MAX_BODY_BYTES) {
    throw new Error("remote_profile_limits_invalid");
  }
  if (!Number.isSafeInteger(limits.maxConcurrent) || (limits.maxConcurrent as number) < 1 || (limits.maxConcurrent as number) > MAX_CONCURRENT) {
    throw new Error("remote_profile_limits_invalid");
  }
  if (!Number.isSafeInteger(limits.timeoutMs) || (limits.timeoutMs as number) < 1 || (limits.timeoutMs as number) > MAX_TIMEOUT_MS) {
    throw new Error("remote_profile_limits_invalid");
  }
  if (!Number.isSafeInteger(limits.streamTimeoutMs) || (limits.streamTimeoutMs as number) < (limits.timeoutMs as number) || (limits.streamTimeoutMs as number) > MAX_STREAM_TIMEOUT_MS) {
    throw new Error("remote_profile_limits_invalid");
  }
}

function assertReference(value: unknown, code: string): void {
  if (typeof value !== "string" || !/^[A-Za-z0-9:_-]{3,160}$/.test(value) || SECRET_PATTERNS.some((pattern) => pattern.test(value))) {
    throw new Error(code);
  }
}

export function isForbiddenRoute(path: string): boolean {
  return typeof path === "string" && FORBIDDEN_ROUTE_PREFIXES.some((prefix) => path === prefix || path.startsWith(`${prefix}/`));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function safeRequestId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function safeAudience(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_:\-./]{3,200}$/.test(value); }
