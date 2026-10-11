import * as oauth from "oauth4webapi";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";
import { codeChallengeS256, generateCodeVerifier, generateOAuthState, generateOidcNonce, validateOAuthCallback } from "./oauth-pkce.ts";

export type OAuthConnectionState =
  | "connecting"
  | "active"
  | "refreshing"
  | "reauth_required"
  | "revoked";

export interface OAuthConnectionMeta {
  connectionId: string;
  principalId: string;
  providerId: string;
  accountSubjectHash: string;
  scopes: string[];
  expiresAt: string | null;
  revision: number;
  state: OAuthConnectionState;
  credentialRef: `oauth:${string}`;
  /** Opaque label for account picker — never raw email unless required. */
  accountLabel: string;
}

export interface OAuthProviderConfig {
  providerId: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  revocationEndpoint?: string;
  clientId: string;
  redirectUri: string;
  /** Officially supported scopes for this integration. */
  allowedScopes: string[];
  issuer?: string;
  useOidcNonce?: boolean;
  jwksUri?: string;
  microsoftTenantIssuer?: boolean;
}

interface AttemptRecord {
  attemptId: string;
  principalId: string;
  providerId: string;
  scopes: string[];
  redirectUri: string;
  state: string;
  codeVerifier: string;
  nonce: string | null;
  createdAt: number;
  expiresAt: number;
  consumed: boolean;
  provider:OAuthProviderConfig;
}

interface TokenBundle {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  scopes: string[];
  subject: string;
  meta?: OAuthConnectionMeta;
  provider?: OAuthProviderConfig;
}

export interface BeginConnectionResult {
  attemptId: string;
  authorizationUrl: string;
  expiresAt: string;
}

export interface EphemeralCredentialHandle {
  connectionId: string;
  accessToken: string;
  scopes: string[];
  expiresAt: string | null;
}

const ATTEMPT_TTL_MS = 10 * 60_000;
const ID = /^[A-Za-z0-9_-]{3,100}$/;

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function subjectHash(subject: string): string {
  return digest(`subject:${subject}`);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password;
  } catch {
    return false;
  }
}

/**
 * OAuth connection lifecycle: begin → complete → acquire → disconnect.
 * Adapters call acquireCredential only; they never refresh themselves.
 * Refresh has a single in-flight owner per connection (serialized lease).
 */
export class OAuthConnectionService {
  private readonly attempts = new Map<string, AttemptRecord>();
  private readonly connections = new Map<string, OAuthConnectionMeta>();
  private readonly refreshLocks = new Map<string, Promise<void>>();
  private readonly secrets: SecretStore;
  private readonly providers: Map<string, OAuthProviderConfig>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();
  readonly ready:Promise<void>;

  constructor(
    secrets: SecretStore,
    providers: OAuthProviderConfig[],
    fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.secrets = secrets;
    this.providers = new Map(providers.map((p) => [p.providerId, p]));
    this.fetchImpl = fetchImpl;
    this.now = now;
    this.ready=this.restore();
  }

  private async restore():Promise<void>{
    const raw=await this.secrets.get('oauth:connections-index');if(!raw)return;
    const ids:unknown=JSON.parse(raw);if(!Array.isArray(ids)||ids.some(id=>typeof id!=='string'||!/^oc_[A-Za-z0-9_-]+$/.test(id)))throw new Error('oauth_store_invalid');
    for(const id of ids){const value=await this.secrets.get(`oauth:${id}`);if(!value)continue;const stored=JSON.parse(value);const meta=stored.meta as OAuthConnectionMeta|undefined;
      if(!meta||meta.connectionId!==id||meta.credentialRef!==`oauth:${id}`||!safeId(meta.principalId)||!Array.isArray(meta.scopes)||!Number.isSafeInteger(meta.revision))throw new Error('oauth_store_invalid');
      if(meta.state==='refreshing'){meta.state='reauth_required';meta.revision++;await this.secrets.set(meta.credentialRef,JSON.stringify({...stored,meta}));}
      this.connections.set(id,meta);
    }
  }
  private async persist(meta:OAuthConnectionMeta,bundle?:TokenBundle):Promise<void>{
    const previous=bundle??await this.readBundle(meta.credentialRef);
    await this.secrets.set(meta.credentialRef,JSON.stringify(meta.state==='revoked'?{meta}:{...previous,meta}));
    await this.secrets.set('oauth:connections-index',JSON.stringify([...new Set([...this.connections.keys(),meta.connectionId])]));
  }

  /** E2-02: registro dinâmico de provedor oficial (endpoints fixos do template). */
  upsertProvider(config: OAuthProviderConfig): void {
    if (!config || typeof config.providerId !== "string" || !ID.test(config.providerId)) {
      throw new Error("oauth_provider_invalid");
    }
    this.providers.set(config.providerId, config);
  }

  /** E2-02: localiza tentativa pendente pelo state (callback loopback sem attemptId). */
  lookupAttemptId(providerId: string, state: string): string | undefined {
    if (typeof state !== "string" || state.length < 16) return undefined;
    for (const attempt of this.attempts.values()) {
      if (attempt.providerId !== providerId || attempt.consumed) continue;
      if (attempt.state.length !== state.length) continue;
      if (same(attempt.state, state)) return attempt.attemptId;
    }
    return undefined;
  }

  listConnections(principalId: string): OAuthConnectionMeta[] {
    return [...this.connections.values()]
      .filter((c) => c.principalId === principalId && c.state !== "revoked")
      .map((c) => ({ ...c, scopes: [...c.scopes] }));
  }

  getConnection(connectionId: string): OAuthConnectionMeta | undefined {
    const c = this.connections.get(connectionId);
    return c ? { ...c, scopes: [...c.scopes] } : undefined;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  async beginConnection(providerId: string, scopes: string[], principalContext: { principalId: string }): Promise<BeginConnectionResult> {
    await this.ready;
    const provider = this.providers.get(providerId);
    if (!provider) throw Object.assign(new Error("oauth_provider_unknown"), { code: "oauth_provider_unknown" });
    if (!safeId(principalContext.principalId)) throw new Error("oauth_principal_invalid");
    if (!Array.isArray(scopes) || scopes.length < 1 || scopes.some((s) => !provider.allowedScopes.includes(s))) {
      throw Object.assign(new Error("oauth_scope_denied"), { code: "oauth_scope_denied" });
    }
    const attemptId = `oa_${randomBytes(12).toString("base64url")}`;
    const state = generateOAuthState();
    const codeVerifier = await generateCodeVerifier();
    const challenge = await codeChallengeS256(codeVerifier);
    const nonce = provider.useOidcNonce ? generateOidcNonce() : null;
    const created = this.now();
    const expiresAt = created + ATTEMPT_TTL_MS;
    this.attempts.set(attemptId, {
      attemptId,
      principalId: principalContext.principalId,
      providerId,
      scopes: [...scopes],
      redirectUri: provider.redirectUri,
      state,
      codeVerifier,
      nonce,
      createdAt: created,
      expiresAt,
      consumed: false,
      provider:{...provider,allowedScopes:[...provider.allowedScopes]},
    });
    const url = new URL(provider.authorizationEndpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", provider.clientId);
    url.searchParams.set("redirect_uri", provider.redirectUri);
    url.searchParams.set("scope", scopes.join(" "));
    url.searchParams.set("state", state);
    url.searchParams.set("code_challenge", challenge);
    url.searchParams.set("code_challenge_method", "S256");
    if (nonce) url.searchParams.set("nonce", nonce);
    return { attemptId, authorizationUrl: url.toString(), expiresAt: new Date(expiresAt).toISOString() };
  }

  async completeConnection(attemptId: string, callback: { url: string } | { code: string; state: string }): Promise<OAuthConnectionMeta> {
    await this.ready;
    return this.exclusive(async () => {
      const attempt = this.attempts.get(attemptId);
      if (!attempt || attempt.consumed) throw Object.assign(new Error("oauth_attempt_invalid"), { code: "oauth_attempt_invalid" });
      if (attempt.expiresAt <= this.now()) {
        this.attempts.delete(attemptId);
        throw Object.assign(new Error("oauth_attempt_expired"), { code: "oauth_attempt_expired" });
      }
      const provider = attempt.provider;
      if (!provider) throw Object.assign(new Error("oauth_provider_unknown"), { code: "oauth_provider_unknown" });

      let code: string;
      let state: string;
      if ("url" in callback) {
        if (!isHttpUrl(callback.url)) throw Object.assign(new Error("oauth_callback_invalid"), { code: "oauth_callback_invalid" });
        const parsed = new URL(callback.url);
        if (parsed.origin + parsed.pathname !== new URL(provider.redirectUri).origin + new URL(provider.redirectUri).pathname) {
          throw Object.assign(new Error("oauth_redirect_mismatch"), { code: "oauth_redirect_mismatch" });
        }
        try {
          const params = validateOAuthCallback({
            issuer: provider.issuer ?? new URL(provider.authorizationEndpoint).origin,
            authorizationEndpoint: provider.authorizationEndpoint,
            tokenEndpoint: provider.tokenEndpoint,
            clientId: provider.clientId,
            callbackUrl: parsed,
            expectedState: attempt.state,
          });
          code = params.get("code") ?? "";
          state = params.get("state") ?? attempt.state;
        } catch (error) {
          const msg = error instanceof Error ? error.message : "";
          if (/state/i.test(msg)) throw Object.assign(new Error("oauth_state_mismatch"), { code: "oauth_state_mismatch" });
          throw Object.assign(new Error("oauth_callback_invalid"), { code: "oauth_callback_invalid", cause: error });
        }
      } else {
        code = callback.code;
        state = callback.state;
        if (!code || !state || !same(state, attempt.state)) {
          throw Object.assign(new Error("oauth_state_mismatch"), { code: "oauth_state_mismatch" });
        }
      }
      if (!code) {
        throw Object.assign(new Error("oauth_callback_invalid"), { code: "oauth_callback_invalid" });
      }

      attempt.consumed = true;
      this.attempts.delete(attemptId);

      const tokenResponse = await this.fetchImpl(provider.tokenEndpoint, {
        method: "POST",redirect:"error",signal:AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code,
          redirect_uri: attempt.redirectUri,
          client_id: provider.clientId,
          code_verifier: attempt.codeVerifier,
        }).toString(),
      });
      if (!tokenResponse.ok) throw Object.assign(new Error("oauth_token_exchange_failed"), { code: "oauth_token_exchange_failed" });
      const body = await tokenResponse.clone().json() as Record<string, unknown>;
      let verifiedSubject:string|undefined;
      if(attempt.nonce){
        if(!provider.issuer||!provider.jwksUri||typeof body.id_token!=='string')throw new Error('oauth_id_token_required');
        let issuer=provider.issuer;
        if(provider.microsoftTenantIssuer){
          let claims;try{claims=JSON.parse(Buffer.from(body.id_token.split('.')[1]??'','base64url').toString('utf8'));}catch{throw new Error('oauth_id_token_invalid');}
          if(typeof claims.tid!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(claims.tid))throw new Error('oauth_issuer_mismatch');
          issuer=`https://login.microsoftonline.com/${claims.tid}/v2.0`;
        }
        const as={issuer,token_endpoint:provider.tokenEndpoint,jwks_uri:provider.jwksUri};
        const validated=await oauth.processAuthorizationCodeResponse(as,{client_id:provider.clientId},tokenResponse,{expectedNonce:attempt.nonce,requireIdToken:true});
        await oauth.validateApplicationLevelSignature(as,tokenResponse,{[oauth.customFetch]:this.fetchImpl,signal:AbortSignal.timeout(10000)});
        verifiedSubject=oauth.getValidatedIdTokenClaims(validated)?.sub;
        if(!verifiedSubject)throw new Error('oauth_id_token_invalid');
      }
      const accessToken = typeof body.access_token === "string" ? body.access_token : "";
      const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : null;
      const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null;
      const grantedScope = typeof body.scope === "string" ? body.scope.split(/\s+/).filter(Boolean) : [...attempt.scopes];
      const subject = verifiedSubject ?? (typeof body.subject === "string" ? body.subject : typeof body.sub === "string" ? body.sub : `acct_${digest(accessToken).slice(0, 16)}`);
      if (!accessToken) throw Object.assign(new Error("oauth_token_invalid"), { code: "oauth_token_invalid" });
      // Only granted scopes become durable — reduced grant must not invent missing scopes.
      const scopes = grantedScope.filter((s) => attempt.scopes.includes(s) || provider.allowedScopes.includes(s));
      const narrowed = scopes.filter((s) => attempt.scopes.includes(s));
      const finalScopes = narrowed;
      if (finalScopes.length < 1) throw Object.assign(new Error("oauth_scope_denied"), { code: "oauth_scope_denied" });

      if (provider.issuer && typeof body.iss === "string" && body.iss !== provider.issuer) {
        throw Object.assign(new Error("oauth_issuer_mismatch"), { code: "oauth_issuer_mismatch" });
      }
      if (attempt.nonce && typeof body.nonce === "string" && body.nonce !== attempt.nonce) {
        throw Object.assign(new Error("oauth_nonce_mismatch"), { code: "oauth_nonce_mismatch" });
      }

      const connectionId = `oc_${randomBytes(12).toString("base64url")}`;
      const credentialRef = `oauth:${connectionId}` as const;
      const expiresAtMs = expiresIn !== null ? this.now() + Math.floor(expiresIn * 1000) : null;
      const bundle: TokenBundle = {
        accessToken,
        refreshToken,
        expiresAt: expiresAtMs,
        scopes: finalScopes,
        subject,
        provider,
      };
      const meta: OAuthConnectionMeta = {
        connectionId,
        principalId: attempt.principalId,
        providerId: attempt.providerId,
        accountSubjectHash: subjectHash(subject),
        scopes: finalScopes,
        expiresAt: expiresAtMs !== null ? new Date(expiresAtMs).toISOString() : null,
        revision: 1,
        state: "active",
        credentialRef,
        accountLabel: `account-${subjectHash(subject).slice(0, 8)}`,
      };
      await this.persist(meta,bundle);
      this.connections.set(connectionId, meta);
      return { ...meta, scopes: [...meta.scopes] };
    });
  }

  async acquireCredential(connectionId: string, requiredScopes: string[], signal?: AbortSignal): Promise<EphemeralCredentialHandle> {
    await this.ready;
    if (signal?.aborted) throw Object.assign(new Error("oauth_aborted"), { code: "oauth_aborted" });
    const meta = this.connections.get(connectionId);
    if (!meta || meta.state === "revoked") throw Object.assign(new Error("oauth_connection_revoked"), { code: "oauth_connection_revoked" });
    if (meta.state === "reauth_required") throw Object.assign(new Error("oauth_reauth_required"), { code: "oauth_reauth_required" });
    if (!requiredScopes.every((s) => meta.scopes.includes(s))) {
      throw Object.assign(new Error("oauth_scope_denied"), { code: "oauth_scope_denied" });
    }

    let bundle = await this.readBundle(meta.credentialRef);
    if (!bundle) throw Object.assign(new Error("oauth_credential_missing"), { code: "oauth_credential_missing" });

    const needsRefresh = bundle.expiresAt !== null && bundle.expiresAt <= this.now() + 30_000;
    if (needsRefresh) {
      await this.refreshExclusive(connectionId);
      const fresh = this.connections.get(connectionId);
      if (!fresh || fresh.state === "revoked") throw Object.assign(new Error("oauth_connection_revoked"), { code: "oauth_connection_revoked" });
      if (fresh.state === "reauth_required") throw Object.assign(new Error("oauth_reauth_required"), { code: "oauth_reauth_required" });
      bundle = await this.readBundle(fresh.credentialRef);
      if (!bundle) throw Object.assign(new Error("oauth_credential_missing"), { code: "oauth_credential_missing" });
    }

    if(signal?.aborted)throw new Error("oauth_aborted");
    const current=this.connections.get(connectionId);
    if(!current||current.state==='revoked')throw new Error('oauth_connection_revoked');
    if(current.state==='reauth_required')throw new Error('oauth_reauth_required');
    if(!requiredScopes.every(scope=>bundle.scopes.includes(scope)))throw new Error("oauth_scope_denied");
    // Ephemeral handle — caller must not serialize into PWA/storage.
    return {
      connectionId,
      accessToken: bundle.accessToken,
      scopes: [...bundle.scopes],
      expiresAt: bundle.expiresAt !== null ? new Date(bundle.expiresAt).toISOString() : null,
    };
  }

  private async refreshExclusive(connectionId: string): Promise<void> {
    const existing = this.refreshLocks.get(connectionId);
    if (existing) {
      await existing;
      return;
    }
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    this.refreshLocks.set(connectionId, gate);
    try {
      await this.performRefresh(connectionId);
    } finally {
      this.refreshLocks.delete(connectionId);
      release();
    }
  }

  private async requireReauth(connectionId:string,revision:number){await this.exclusive(async()=>{const meta=this.connections.get(connectionId);if(!meta||meta.state==='revoked'||meta.revision!==revision)return;const next={...meta,state:'reauth_required' as const};await this.persist(next);this.connections.set(connectionId,next);});}

  private async performRefresh(connectionId: string): Promise<void> {
    const meta = this.connections.get(connectionId);
    if (!meta || meta.state === "revoked") return;
    if (meta.state === "reauth_required") return;

    const initialBundle=await this.readBundle(meta.credentialRef);
    const provider = initialBundle?.provider ?? this.providers.get(meta.providerId);
    if (!provider) {
      await this.requireReauth(connectionId,meta.revision);
      return;
    }

    const refreshRevision=meta.revision;
    // Persist the rotation boundary before contacting the provider; restart requires reauthorization.
    const admitted=await this.exclusive(async()=>{
      const current=this.connections.get(connectionId);
      if(!current||current.state==='revoked'||current.state==='reauth_required'||current.revision!==refreshRevision)return false;
      const next={...current,state:'refreshing' as const};
      await this.persist(next);this.connections.set(connectionId,next);return true;
    });
    if(!admitted)return;

    const bundle = await this.readBundle(meta.credentialRef);
    if (!bundle?.refreshToken) {
      await this.requireReauth(connectionId,meta.revision);
      return;
    }

    // Simulate crash window: if process dies after provider rotates and before persist,
    // caller sees reauth_required — never restore the old refresh token blindly.
    let response: Response;
    try {
      response = await this.fetchImpl(provider.tokenEndpoint, {
        method: "POST",redirect:"error",signal:AbortSignal.timeout(10000),
        headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
        body: new URLSearchParams({
          grant_type: "refresh_token",
          refresh_token: bundle.refreshToken,
          client_id: provider.clientId,
        }).toString(),
      });
    } catch {
      await this.requireReauth(connectionId,meta.revision);
      return;
    }

    if (!response.ok) {
      await this.requireReauth(connectionId,meta.revision);
      return;
    }

    // Revocation during refresh: delayed success must not reactivate.
    const still = this.connections.get(connectionId);
    if (!still || still.state === "revoked" || still.revision !== refreshRevision) {
      return;
    }

    const body = await response.json() as Record<string, unknown>;
    const accessToken = typeof body.access_token === "string" ? body.access_token : "";
    const refreshToken = typeof body.refresh_token === "string" ? body.refresh_token : bundle.refreshToken;
    const expiresIn = typeof body.expires_in === "number" && Number.isFinite(body.expires_in) ? body.expires_in : null;
    if (!accessToken) {
      await this.requireReauth(connectionId,refreshRevision);
      return;
    }

    const expiresAtMs = expiresIn !== null ? this.now() + Math.floor(expiresIn * 1000) : null;
    const nextBundle: TokenBundle = {
      accessToken,
      refreshToken,
      expiresAt: expiresAtMs,
      scopes:typeof body.scope==="string"?body.scope.split(/\s+/).filter(scope=>bundle.scopes.includes(scope)):bundle.scopes,
      subject: bundle.subject,
      provider,
    };
    await this.exclusive(async()=>{
      const current=this.connections.get(connectionId);
      if(!current||current.state==='revoked'||current.revision!==refreshRevision)return;
      const next={...current,scopes:[...nextBundle.scopes],revision:current.revision+1,state:'active' as const,expiresAt:expiresAtMs!==null?new Date(expiresAtMs).toISOString():null};
      await this.persist(next,nextBundle);this.connections.set(connectionId,next);
    });
  }

  /**
   * Test/recovery hook: mark connection as needing reauth after a crash that lost
   * the rotated refresh token (never replay the previous refresh token).
   */
  markRefreshLost(connectionId: string): void {
    const meta = this.connections.get(connectionId);
    if (!meta || meta.state === "revoked") return;
    meta.state = "reauth_required";
    this.connections.set(connectionId, meta);
  }

  async disconnect(connectionId: string, expectedRevision: number): Promise<OAuthConnectionMeta & {remoteRevocation:"skipped"|"ok"|"failed"}> {
    await this.ready;
    return this.exclusive(async () => {
      const meta = this.connections.get(connectionId);
      if (!meta) throw Object.assign(new Error("oauth_connection_not_found"), { code: "oauth_connection_not_found" });
      if (meta.revision !== expectedRevision) {
        throw Object.assign(new Error("oauth_revision_conflict"), { code: "oauth_revision_conflict", status: 409 });
      }
      const original=await this.readBundle(meta.credentialRef);
      meta.state = "revoked";
      meta.revision += 1;
      this.connections.set(connectionId, meta);
      await this.persist(meta);

      const provider = original?.provider ?? this.providers.get(meta.providerId);
      let remote: "skipped" | "ok" | "failed" = "skipped";
      if (provider?.revocationEndpoint && original) {
        // Best-effort remote revoke; local state already revoked.
        remote = "failed";
        try {
          const res = await this.fetchImpl(provider.revocationEndpoint, { method: "POST",redirect:"error",signal:AbortSignal.timeout(10000),headers:{"content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({token:original.refreshToken??original.accessToken,token_type_hint:original.refreshToken?"refresh_token":"access_token",client_id:provider.clientId}).toString() });
          remote = res.ok ? "ok" : "failed";
        } catch {
          remote = "failed";
        }
      }
      return { ...meta, scopes: [...meta.scopes],remoteRevocation:remote };
    });
  }

  private async readBundle(ref: string): Promise<TokenBundle | null> {
    const raw = await this.secrets.get(ref);
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw) as TokenBundle;
      if (typeof parsed.accessToken !== "string") return null;
      return parsed;
    } catch {
      return null;
    }
  }

  /** Canary: refresh tokens must never appear in UI/export payloads. */
  static assertNoRefreshLeak(payload: unknown): void {
    const text = JSON.stringify(payload);
    if (/"refreshToken"\s*:/.test(text) || text.includes("refresh_token")) {
      throw new Error("oauth_refresh_leaked");
    }
  }
}
