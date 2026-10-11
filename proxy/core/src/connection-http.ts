import type { Context, Hono } from "hono";
import { randomBytes } from "node:crypto";
import { readBoundedJson, MAX_LOCAL_CONTROL_REQUEST_BYTES } from "@uptokey/sync-contract/limits";
import { parseConnectionTestSpec, parseModelInstallSpec, parseOAuthStart } from "@uptokey/sync-contract/connections";
import type { ConnectionStatus, ConnectionSupportLevel } from "@uptokey/sync-contract/connections";
import type { SecretStore } from "./secret-store.ts";
import type { ProxyConfig } from "./types.ts";
import { isNamedExperimentalProvider, isResearchOnlyProvider, isUserDefinedProvider, isLocalExperimentalProvider } from "./provider-registry.ts";
import { type ConnectionProfileService, type StoredProfile } from "./connection-profiles.ts";
import { type ConnectionTestService, type TestJobSnapshot } from "./connection-tests.ts";
import { type InstallJobSnapshot, type ModelInstallJobService } from "./model-install-jobs.ts";
import { OAuthConnectionService } from "./oauth-connection.ts";

export interface ConnectionAuthorizer {
  canRead(c: Context): Promise<boolean>;
  canMutate(c: Context): Promise<boolean>;
}

export interface ConnectionRouteDeps {
  profiles: ConnectionProfileService;
  tests: ConnectionTestService;
  installs: ModelInstallJobService;
  oauth: OAuthConnectionService;
  secrets: SecretStore;
  getConfig: () => ProxyConfig;
  /** Admissão legada por provedor (projeção, nunca inventa execução). */
  getAdmission: () => Map<string, { eligible: boolean; reason: string | null }> | null;
  auth: ConnectionAuthorizer;
  checkRate: (key: string, limit: number, windowMs: number) => { ok: boolean; retryAfter: number };
  now?: () => number;
}

export type ConnectionRouteMode = "GET" | "POST" | "PATCH";

export interface ConnectionRouteMatch {
  method: ConnectionRouteMode;
  /** JSON obrigatório | corpo vazio obrigatório | leitura sem corpo. */
  body: "json" | "empty" | "none";
}

const UUID_SEG = "[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}";
const PROVIDER_SEG = "[A-Za-z0-9][A-Za-z0-9_-]{0,63}";

const DYNAMIC_ROUTES: Array<{ method: ConnectionRouteMode; body: ConnectionRouteMatch["body"]; pattern: RegExp }> = [
  { method: "GET", body: "none", pattern: /^\/local\/provider\/credits$/ },
  { method: "GET", body: "none", pattern: /^\/local\/provider\/setup\/presets$/ },
  { method: "POST", body: "json", pattern: /^\/local\/provider\/setup\/(?:prepare|commit|dispose)$/ },
  { method: "GET", body: "none", pattern: /^\/local\/connections$/ },
  { method: "POST", body: "json", pattern: /^\/local\/connections$/ },
  { method: "PATCH", body: "json", pattern: new RegExp(`^\\/local\\/connections\\/${UUID_SEG}$`) },
  { method: "POST", body: "json", pattern: new RegExp(`^\\/local\\/connections\\/${UUID_SEG}\\/(?:secret|revoke|refresh)$`) },
  { method: "POST", body: "json", pattern: /^\/local\/connection-tests$/ },
  { method: "GET", body: "none", pattern: new RegExp(`^\\/local\\/connection-tests\\/${UUID_SEG}$`) },
  { method: "POST", body: "empty", pattern: new RegExp(`^\\/local\\/connection-tests\\/${UUID_SEG}\\/cancel$`) },
  { method: "POST", body: "json", pattern: new RegExp(`^\\/local\\/oauth\\/${PROVIDER_SEG}\\/(?:start|callback)$`) },
  { method: "GET", body: "none", pattern: new RegExp(`^\\/local\\/oauth\\/return\\/${PROVIDER_SEG}$`) },
  { method: "POST", body: "json", pattern: /^\/local\/model-installs$/ },
  { method: "GET", body: "none", pattern: new RegExp(`^\\/local\\/model-installs\\/${UUID_SEG}$`) },
  { method: "POST", body: "empty", pattern: new RegExp(`^\\/local\\/model-installs\\/${UUID_SEG}\\/(?:cancel|resume)$`) },
];

/**
 * Integração com o portão de origem/método do app: caminhos com :id não
 * constam das tabelas estáticas. Com `method`, só casa a entrada do método
 * pedido (GET e POST dividem o mesmo prefixo em /local/connections).
 * Retorna undefined para rotas desconhecidas.
 */
export function matchConnectionRoute(pathname: string, method?: string): ConnectionRouteMatch | undefined {
  for (const route of DYNAMIC_ROUTES) {
    if (method !== undefined && route.method !== method) continue;
    if (route.pattern.test(pathname)) return { method: route.method, body: route.body };
  }
  return undefined;
}

function errorStatus(code: string): number {
  switch (code) {
    case "connection_not_found": return 404;
    case "revision_conflict": return 409;
    case "oauth_scope_denied": return 403;
    case "oauth_attempt_expired": return 410;
    case "oauth_state_invalid":
    case "oauth_state_mismatch":
    case "oauth_callback_invalid":
    case "oauth_redirect_mismatch": return 400;
    case "credential_missing":
    case "provider_terms_unverified":
    case "test_budget_exceeded":
    case "endpoint_denied": return 422;
    case "runtime_unavailable": return 503;
    case "disk_space_insufficient": return 507;
    case "connection_limit_exceeded": return 429;
    case "multiconta_disabled": return 409;
    case "oauth_token_exchange_failed":
    case "provider_response_invalid": return 502;
    default: return 400;
  }
}

function toHttp(error: unknown): { type: string; status: number } {
  const code = error instanceof Error ? error.message : "invalid_request";
  const status = typeof (error as { status?: unknown })?.status === "number"
    ? (error as { status: number }).status
    : errorStatus(code);
  return { type: code, status };
}

function hasExactKeys(value: unknown, expected: readonly string[]): value is Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => keys.includes(key));
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/** Templates OAuth oficiais: endpoints fixos, cliente público do usuário (PKCE, sem segredo). */
export const OAUTH_TEMPLATES: Record<string, {
  issuer: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  allowedScopes: string[];
  termsUrl: string;
  useOidcNonce: boolean;
}> = {
  google: {
    issuer: "https://accounts.google.com",
    authorizationEndpoint: "https://accounts.google.com/o/oauth2/v2/auth",
    tokenEndpoint: "https://oauth2.googleapis.com/token",
    revocationEndpoint: "https://oauth2.googleapis.com/revoke",
    allowedScopes: ["openid", "email", "profile", "https://www.googleapis.com/auth/tasks.readonly", "https://www.googleapis.com/auth/tasks"],
    termsUrl: "https://developers.google.com/terms",
    useOidcNonce: true,
  },
  github: {
    issuer: "https://github.com",
    authorizationEndpoint: "https://github.com/login/oauth/authorize",
    tokenEndpoint: "https://github.com/login/oauth/access_token",
    allowedScopes: ["read:user", "user:email"],
    termsUrl: "https://docs.github.com/en/site-policy/github-terms/github-terms-of-service",
    useOidcNonce: false,
  },
  microsoft: {
    issuer: "https://login.microsoftonline.com",
    authorizationEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/authorize",
    tokenEndpoint: "https://login.microsoftonline.com/common/oauth2/v2.0/token",
    allowedScopes: ["openid", "profile", "email", "offline_access"],
    termsUrl: "https://www.microsoft.com/en-us/legal/terms-of-use",
    useOidcNonce: true,
  },
};

export const OAUTH_TERMS_CHECKED_AT = "2026-09-20";

function templateProviderId(template: string): string {
  return `oauth-${template}`;
}

function expectedReturnPath(template: string): string {
  return `/local/oauth/return/${template}`;
}

function parseReturnUri(value: unknown, template: string): string {
  if (typeof value !== "string") throw Object.assign(new Error("endpoint_denied"), { status: 422 });
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw Object.assign(new Error("endpoint_denied"), { status: 422 });
  }
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost";
  if (url.protocol !== "http:" || !loopback || url.port !== "21435") {
    throw Object.assign(new Error("endpoint_denied"), { status: 422 });
  }
  if (url.pathname !== expectedReturnPath(template) || url.search || url.hash || url.username || url.password) {
    throw Object.assign(new Error("endpoint_denied"), { status: 422 });
  }
  return url.toString();
}

function supportLevelFor(profile: StoredProfile): ConnectionSupportLevel {
  if (profile.providerId.startsWith("oauth-")) return "experimental";
  if (profile.providerId === "custom" || isUserDefinedProvider(profile.providerId)) return "custom";
  if (isResearchOnlyProvider(profile.providerId)) return "research";
  if (isLocalExperimentalProvider(profile.providerId) || isNamedExperimentalProvider(profile.providerId)) return "experimental";
  return "built_in";
}

function admissionToStatus(reason: string | null): ConnectionStatus {
  if (reason === null) return "healthy";
  switch (reason) {
    case "not_configured": return "unconfigured";
    case "disabled": return "disabled";
    case "missing_adapter": return "unknown";
    case "privacy_consent_required":
    case "risk_consent_required": return "degraded";
    default: return "degraded";
  }
}

async function unauthorized(c: Context): Promise<Response> {
  return c.json({ error: { type: "unauthorized" } }, 401);
}

async function rateLimited(c: Context, retryAfter: number): Promise<Response> {
  c.header("Retry-After", String(retryAfter));
  return c.json({ error: { type: "local_provider_rate_limited" } }, 429);
}

export function registerConnectionRoutes(app: Hono, deps: ConnectionRouteDeps): void {
  const { profiles, tests, installs, oauth, auth } = deps;
  const now = deps.now ?? Date.now;
  // Providers configured after the first listing (e.g. through the TUI) become connections too: the migration runs
  // again whenever the configured providers change; it never touches profiles that already exist.
  let migratedFor: string | undefined;

  async function ensureMigrated(): Promise<void> {
    const config = deps.getConfig();
    const key = JSON.stringify(Object.entries(config.providers ?? {}).map(([id, item]) => [id, (item as { configured?: unknown })?.configured === true, (item as { endpointUrl?: unknown })?.endpointUrl ?? null]));
    if (migratedFor === key) return;
    try {
      await profiles.migrateFromLegacy(config);
      migratedFor = key;
    } catch {
      migratedFor = undefined;
    }
  }

  async function views() {
    await ensureMigrated();
    await oauth.ready;
    const admission = deps.getAdmission();
    return profiles.projectViews(async (profile) => {
      const supportLevel = supportLevelFor(profile);
      if (profile.accessMode === "oauth") {
        const binding = await profiles.oauthBinding(profile.id);
        const meta = binding ? oauth.getConnection(binding) : undefined;
        if (!meta) return { supportLevel, status: "unknown" as const };
        if (meta.state === "revoked") return { supportLevel, status: "expired" as const };
        if (meta.state === "reauth_required") return { supportLevel, status: "expired" as const };
        if (meta.state === "refreshing" || meta.state === "connecting") return { supportLevel, status: "degraded" as const };
      }
      if (profile.accessMode !== "local" && !(await profiles.credentialPresent(profile))) {
        return { supportLevel, status: "unauthenticated" as const };
      }
      const entry = admission?.get(profile.providerId);
      if (!entry) return { supportLevel, status: "unknown" as const };
      return { supportLevel, status: admissionToStatus(entry.reason) };
    });
  }

  async function viewOf(id: string) {
    const list = await views();
    return list.find((v) => v.id === id);
  }

  app.get("/local/connections", async (c) => {
    if (!(await auth.canRead(c))) return unauthorized(c);
    try {
      return c.json({ schemaVersion: 1, observedAt: new Date(now()).toISOString(), connections: await views() });
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/connections", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connections-mutate", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as Record<string, unknown>;
    if (typeof body !== "object" || body === null || Array.isArray(body)) return c.json({ error: { type: "invalid_request" } }, 400);
    const { secret, operationId, ...profileInput } = body;
    try {
      if (operationId !== undefined && !isUuid(operationId)) throw Object.assign(new Error("connection_invalid_profile"), { status: 400 });
      // OAuth nasce pelo fluxo oficial, nunca por POST direto com segredo.
      if ((profileInput as { accessMode?: unknown }).accessMode === "oauth") {
        throw Object.assign(new Error("provider_terms_unverified"), { status: 422 });
      }
      if (secret !== undefined && typeof secret !== "string") throw Object.assign(new Error("connection_invalid_profile"), { status: 400 });
      // Guarda de namespace: o cliente nunca escolhe credentialRef.
      if ("credentialRef" in profileInput) throw Object.assign(new Error("connection_invalid_profile"), { status: 400 });
      const created = await profiles.create(profileInput, typeof secret === "string" ? secret : undefined, operationId as string | undefined);
      const view = await viewOf(created.id);
      return c.json(view, 201);
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.patch("/local/connections/:id", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connections-mutate", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: { type: "connection_not_found" } }, 404);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      await profiles.update(id, parsed.value);
      return c.json(await viewOf(id));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/connections/:id/secret", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connections-mutate", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: { type: "connection_not_found" } }, 404);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as { revision?: unknown; secret?: unknown; operationId?: unknown };
    if (!hasExactKeys(body, ["revision", "secret"]) && !hasExactKeys(body, ["revision", "secret", "operationId"])) {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    try {
      if (!Number.isSafeInteger(body.revision)) throw Object.assign(new Error("connection_invalid_profile"), { status: 400 });
      await profiles.updateSecret(id, body.revision as number, body.secret as string, body.operationId as string | undefined);
      return c.json(await viewOf(id));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/connections/:id/revoke", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connections-mutate", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: { type: "connection_not_found" } }, 404);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as { revision?: unknown };
    if (!hasExactKeys(body, ["revision"]) || !Number.isSafeInteger(body.revision)) {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    try {
      await oauth.ready;
      const profile = await profiles.get(id);
      if (!profile) return c.json({ error: { type: "connection_not_found" } }, 404);
      let remote: "skipped" | "unknown" | "ok" | "failed" = "skipped";
      if (profile.accessMode === "oauth") {
        const binding = await profiles.oauthBinding(id);
        const meta = binding ? oauth.getConnection(binding) : undefined;
        if (meta) {
          try {
            remote = (await oauth.disconnect(binding!, meta.revision)).remoteRevocation;
          } catch {
            throw new Error("oauth_revoke_unconfirmed");
          }
        } else if (binding) {
          // Processo reiniciado: meta em memória perdida; associação local sai, remoto incerto.
          remote = "unknown";
        }
        await profiles.unbindOAuth(id);
      }
      const result = await profiles.revoke(id, body.revision as number);
      // Testes e instalações da conexão revogada não recebem novos despachos.
      return c.json({ revoked: result.revoked, providerId: result.providerId, remote });
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/connections/:id/refresh", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connections-mutate", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: { type: "connection_not_found" } }, 404);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as { revision?: unknown };
    if (!hasExactKeys(body, ["revision"]) || !Number.isSafeInteger(body.revision)) {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    try {
      await oauth.ready;
      const profile = await profiles.get(id);
      if (!profile || profile.accessMode !== "oauth") return c.json({ error: { type: "connection_not_found" } }, 404);
      if (profile.revision !== (body.revision as number)) return c.json({ error: { type: "revision_conflict" } }, 409);
      const binding = await profiles.oauthBinding(id);
      const meta = binding ? oauth.getConnection(binding) : undefined;
      if (!meta) return c.json({ error: { type: "connection_not_found" } }, 404);
      // Reidrata o provedor a partir do registro persistido (reinício perde o mapa em memória).
      const registration = await profiles.getOAuthProvider(profile.providerId);
      if (!registration) return c.json({ error: { type: "provider_terms_unverified" } }, 422);
      oauth.upsertProvider({
        providerId: registration.providerId,
        authorizationEndpoint: registration.authorizationEndpoint,
        tokenEndpoint: registration.tokenEndpoint,
        ...(registration.revocationEndpoint ? { revocationEndpoint: registration.revocationEndpoint } : {}),
        clientId: registration.clientId,
        redirectUri: registration.redirectUri,
        allowedScopes: [...registration.allowedScopes],
        issuer: registration.issuer,
        useOidcNonce: registration.templateId === "google" || registration.templateId === "microsoft",
        ...(registration.templateId==="google"?{jwksUri:"https://www.googleapis.com/oauth2/v3/certs"}:registration.templateId==="microsoft"?{jwksUri:"https://login.microsoftonline.com/common/discovery/v2.0/keys",microsoftTenantIssuer:true}:{}),
      });
      // Single-flight por conexão dentro do serviço; revogação invalida refresh em trânsito.
      // O handle efêmero é descartado: tokens nunca voltam ao browser.
      await oauth.acquireCredential(binding!, [...meta.scopes]);
      return c.json(await viewOf(id));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/connection-tests", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-connection-tests", 10, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const spec = parseConnectionTestSpec(parsed.value);
      void spec;
      const job = await tests.start(parsed.value);
      return c.json(job, 201);
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.get("/local/connection-tests/:id", async (c) => {
    if (!(await auth.canRead(c))) return unauthorized(c);
    const job = await tests.get(c.req.param("id"));
    if (!job) return c.json({ error: { type: "connection_not_found" } }, 404);
    return c.json(job satisfies TestJobSnapshot as unknown as Record<string, unknown>);
  });

  app.post("/local/connection-tests/:id/cancel", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    try {
      return c.json(await tests.cancel(c.req.param("id")));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.post("/local/oauth/:template/start", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-oauth-start", 10, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const template = c.req.param("template");
    const preset = OAUTH_TEMPLATES[template!];
    if (!preset) return c.json({ error: { type: "provider_terms_unverified" } }, 422);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as { clientId?: unknown; redirectUri?: unknown; scopes?: unknown; operationId?: unknown };
    if (body === null || typeof body !== "object" || Array.isArray(body)) return c.json({ error: { type: "invalid_request" } }, 400);
    if ("clientSecret" in body || "client_secret" in body) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const start = parseOAuthStart({ providerId: templateProviderId(template!), scopes: body.scopes, operationId: body.operationId });
      if (typeof body.clientId !== "string" || !/^[A-Za-z0-9._\-~]{1,200}$/.test(body.clientId)) {
        throw Object.assign(new Error("connection_invalid_oauth"), { status: 400 });
      }
      const redirectUri = parseReturnUri(body.redirectUri, template!);
      const providerId = start.providerId;
      oauth.upsertProvider({
        providerId,
        authorizationEndpoint: preset.authorizationEndpoint,
        tokenEndpoint: preset.tokenEndpoint,
        ...(preset.revocationEndpoint ? { revocationEndpoint: preset.revocationEndpoint } : {}),
        clientId: body.clientId,
        redirectUri,
        allowedScopes: preset.allowedScopes,
        issuer: preset.issuer,
        useOidcNonce: preset.useOidcNonce,
        ...(template==="google"?{jwksUri:"https://www.googleapis.com/oauth2/v3/certs"}:template==="microsoft"?{jwksUri:"https://login.microsoftonline.com/common/discovery/v2.0/keys",microsoftTenantIssuer:true}:{}),
      });
      await profiles.registerOAuthProvider({
        templateId: template!,
        providerId,
        clientId: body.clientId,
        redirectUri,
        authorizationEndpoint: preset.authorizationEndpoint,
        tokenEndpoint: preset.tokenEndpoint,
        ...(preset.revocationEndpoint ? { revocationEndpoint: preset.revocationEndpoint } : {}),
        issuer: preset.issuer,
        allowedScopes: [...preset.allowedScopes],
        termsUrl: preset.termsUrl,
        termsCheckedAt: OAUTH_TERMS_CHECKED_AT,
      });
      const begun = await oauth.beginConnection(providerId, start.scopes, { principalId: "local-device" });
      return c.json({ ...begun, providerId, termsUrl: preset.termsUrl }, 201);
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  async function completeOAuth(template:string,code:string,state:string){
    const providerId = templateProviderId(template);
    const attemptId = oauth.lookupAttemptId(providerId, state);
    if (!attemptId) throw Object.assign(new Error("oauth_state_invalid"), { status: 400 });
    const meta = await oauth.completeConnection(attemptId, { code: code, state: state });
    // Callback correto conecta uma vez: replay/state trocado/escopo extra falham antes de persistir.
    const created = await profiles.create({
      schemaVersion: 1,
      revision: 1,
      providerId,
      label: `Conta ${template} ${meta.accountLabel.slice(-4)}`,
      accessMode: "oauth",
      enabled: true,
      modelIds: [],
      credentialRef: meta.credentialRef,
    });
    await profiles.bindOAuth(created.id, meta.connectionId);
    return viewOf(created.id);
  }

  app.post("/local/oauth/:template/callback", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-oauth-callback", 20, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const template = c.req.param("template");
    if (!OAUTH_TEMPLATES[template!]) return c.json({ error: { type: "provider_terms_unverified" } }, 422);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    const body = parsed.value as { code?: unknown; state?: unknown };
    if (!hasExactKeys(body, ["code", "state"]) || typeof body.code !== "string" || typeof body.state !== "string") {
      return c.json({ error: { type: "invalid_request" } }, 400);
    }
    try {
      return c.json(await completeOAuth(template!,body.code,body.state),201);
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.get("/local/oauth/return/:template", async (c) => {
    const template = c.req.param("template");
    if (!OAUTH_TEMPLATES[template!]) return c.json({ error: { type: "provider_terms_unverified" } }, 422);
    const nonce = randomBytes(16).toString("base64url");
    c.header("Content-Security-Policy", `default-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'; script-src 'nonce-${nonce}'; style-src 'nonce-${nonce}'; connect-src 'self'`);
    c.header("X-Content-Type-Options", "nosniff");
    c.header("X-Frame-Options", "DENY");
    c.header("Referrer-Policy", "no-referrer");
    c.header("Cache-Control", "no-store");
    const params=new URL(c.req.url).searchParams;
    const code=params.get('code'),state=params.get('state');
    if(!code||!state||params.getAll('code').length!==1||params.getAll('state').length!==1)return c.html('<p>Retorno inválido. Inicie novamente a conexão no Uptokey.</p>',400);
    const rate=deps.checkRate('localhost-oauth-return',20,60000);if(!rate.ok)return rateLimited(c,rate.retryAfter);
    try{
      // State is a one-time capability created only by the authenticated start route;
      // PKCE and the exact registered redirect bind this browser navigation to that attempt.
      await completeOAuth(template!,code,state);
      return c.html('<!doctype html><html lang="pt-BR"><meta charset="utf-8"><title>Uptokey</title><p>Conta conectada. Feche esta aba e atualize as conexões no Uptokey.</p></html>');
    }catch(error){const mapped=toHttp(error);return c.html('<p>Não foi possível conectar. Volte ao Uptokey e inicie uma nova autorização.</p>',mapped.status as 400);}

  });

  app.post("/local/model-installs", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    const rate = deps.checkRate("localhost-model-installs", 10, 60_000);
    if (!rate.ok) return rateLimited(c, rate.retryAfter);
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      const spec = parseModelInstallSpec(parsed.value);
      void spec;
      const job = await installs.start(parsed.value);
      return c.json(job satisfies InstallJobSnapshot as unknown as Record<string, unknown>, 201);
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  app.get("/local/model-installs/:id", async (c) => {
    if (!(await auth.canRead(c))) return unauthorized(c);
    const job = await installs.get(c.req.param("id"));
    if (!job) return c.json({ error: { type: "connection_not_found" } }, 404);
    return c.json(job satisfies InstallJobSnapshot as unknown as Record<string, unknown>);
  });

  app.post("/local/model-installs/:id/cancel", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    try {
      return c.json(await installs.cancel(c.req.param("id")));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });

  // E2-02: retomada explícita após interrupção; parcial nunca vira `ready` sozinho.
  app.post("/local/model-installs/:id/resume", async (c) => {
    if (!(await auth.canMutate(c))) return unauthorized(c);
    try {
      return c.json(await installs.resume(c.req.param("id")));
    } catch (error) {
      const mapped = toHttp(error);
      return c.json({ error: { type: mapped.type } }, mapped.status as 400);
    }
  });
}
