import { Hono } from "hono";
import type { ProxyConfig } from "./types.ts";
import type { SecretStore } from "./secret-store.ts";
import { ControlCapabilityService } from "./control-capability.ts";
import type { QuotaLedger } from "./quota-ledger.ts";
import { MAX_LOCAL_CONTROL_REQUEST_BYTES, readBoundedJson } from "@uptokey/sync-contract/limits";
import { createHash } from "node:crypto";
import { isDataRecord as isJsonObject } from "@uptokey/sync-contract/plain-data";
import { LocalControlRateLimiter } from "./local-control-rate-limit.ts";
import { geminiPrivacyAccepted } from "./privacy.ts";
import { normalizeClientName } from "./client-name.ts";
import { canonicalHttpsOrigin, canonicalMagicDnsName } from "./tailnet-address.mjs";

export const TAILNET_PAIRING_ATTEMPT_LIMIT = 60;
export const TAILNET_PAIRING_ATTEMPT_WINDOW_MS = 60_000;
export const TAILNET_PAIRING_CREATION_LIMIT = 10;
export const TAILNET_PAIRING_CREATION_WINDOW_MS = 60_000;
export const TAILNET_PAIRING_CONSUME_FAILURE_LIMIT = 20;
export const TAILNET_PAIRING_CONSUME_FAILURE_WINDOW_MS = 60_000;
export const TAILNET_PAIRING_APPROVED_ATTEMPT_LIMIT = 5;
export const TAILNET_PAIRING_APPROVED_ATTEMPT_WINDOW_MS = 60_000;
export const TAILNET_STATUS_AUTH_FAILURE_LIMIT = 20;
export const TAILNET_STATUS_AUTH_FAILURE_WINDOW_MS = 60_000;
const TAILNET_ROUTE_METHODS = new Map<string, "GET" | "POST">([
  ["/control/pair/challenge", "POST"], ["/control/pair/consume", "POST"], ["/control/status", "GET"]
]);

export function createTailnetControlApp(options: { expectedHost: string; allowedOrigin: string; config: ProxyConfig; secrets: SecretStore; capabilities: ControlCapabilityService; openBootstrapEnvelope: (envelope: unknown, context: { tenantId: string; deviceId: string; controlOrigin: string }) => Promise<string>; ledger?: QuotaLedger; rateLimiter?: LocalControlRateLimiter }) {
  const expectedHost = validateTailnetExpectedHost(options.expectedHost);
  const allowedOrigin = validateTailnetAllowedOrigin(options.allowedOrigin);
  const app = new Hono();
  app.onError((_error, c) => { c.header("Cache-Control", "no-store"); return c.json({ error: { type: "tailnet_control_unavailable" } }, 503); });
  const rateLimiter = options.rateLimiter ?? new LocalControlRateLimiter();
  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store"); c.header("Vary", "Origin, Access-Control-Request-Method, Access-Control-Request-Headers, Access-Control-Request-Private-Network");
    if (c.req.header("host") !== expectedHost) return c.json({ error: { type: "host_rejected" } }, 421);
    const origin = c.req.header("origin");
    if (origin !== allowedOrigin) return c.json({ error: { type: "origin_rejected" } }, 403);
    const requestUrl = new URL(c.req.url);
    if (requestUrl.search || /%2f|%5c|\.\.|\/\//i.test(requestUrl.pathname)) return c.json({ error: { type: "path_rejected" } }, 400);
    if (c.req.method === "OPTIONS") {
      const requestedMethod = c.req.header("access-control-request-method")?.toUpperCase();
      const requestedHeaders = (c.req.header("access-control-request-headers") ?? "").toLowerCase().split(",").map((value) => value.trim()).filter(Boolean);
      const preflight = requestedMethod ? allowedPreflight(requestUrl.pathname, requestedMethod, requestedHeaders) : undefined;
      if (!preflight) return c.body(null, 403);
      corsPreflight(c, origin, preflight);
      if (c.req.header("access-control-request-private-network") === "true") c.header("Access-Control-Allow-Private-Network", "true");
      return c.body(null, 204);
    }
    corsOrigin(c, origin);
    const expectedMethod = TAILNET_ROUTE_METHODS.get(requestUrl.pathname);
    if (!expectedMethod) return c.json({ error: { type: "route_not_found" } }, 404);
    if (c.req.method !== expectedMethod) { c.header("Allow", expectedMethod); return c.json({ error: { type: "method_not_allowed" } }, 405); }
    if (expectedMethod === "POST" && c.req.header("content-type") !== "application/json") return c.json({ error: { type: "unsupported_media_type" } }, 415);
    if (expectedMethod === "GET" && (c.req.raw.body !== null || c.req.header("content-type") !== undefined)) return c.json({ error: { type: "invalid_request" } }, 400);
    await next();
  });

  app.post("/control/pair/challenge", async (c) => {
    const attemptRate = rateLimiter.take("pair:challenge:attempt", TAILNET_PAIRING_ATTEMPT_LIMIT, TAILNET_PAIRING_ATTEMPT_WINDOW_MS);
    if (!attemptRate.ok) { c.header("Retry-After", String(attemptRate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value as { clientName?: string; tenantId?: string; deviceId?: string; rpID?: string; bootstrapEnvelope?: unknown; bootstrapToken?: unknown; credential?: { id: string; publicKey: string; counter: number; transports?: string[] } };
    if (!isJsonObject(body)) return c.json({ error: { type: "invalid_request" } }, 400);
    if (body.bootstrapToken !== undefined) return c.json({ error: { type: "control_plaintext_bootstrap_rejected" } }, 400);
    const bootstrapIdentityFields = body.rpID !== undefined || body.credential !== undefined;
    if (!hasExactKeys(body, bootstrapIdentityFields
      ? ["clientName", "tenantId", "deviceId", "bootstrapEnvelope", "rpID", "credential"]
      : ["clientName", "tenantId", "deviceId", "bootstrapEnvelope"])
      || !safeClientName(body.clientName) || !safeId(body.tenantId) || !safeId(body.deviceId)
      || !isJsonObject(body.bootstrapEnvelope) || (bootstrapIdentityFields && (typeof body.rpID !== "string" || !isJsonObject(body.credential)))) {
      return c.json({ error: { type: "pairing_identity_required" } }, 400);
    }
    if (!options.capabilities.pairingConfigured()) return c.json({ error: { type: "control_pairing_not_configured" } }, 403);
    const creationRate = rateLimiter.take("pair:challenge:creation", TAILNET_PAIRING_CREATION_LIMIT, TAILNET_PAIRING_CREATION_WINDOW_MS);
    if (!creationRate.ok) { c.header("Retry-After", String(creationRate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
    try {
      const bootstrapToken = await options.openBootstrapEnvelope(body.bootstrapEnvelope, { tenantId: body.tenantId, deviceId: body.deviceId, controlOrigin: `https://${expectedHost}` });
      return c.json(options.capabilities.create(allowedOrigin, body.clientName, body.tenantId, body.deviceId, body.credential, body.rpID, bootstrapToken), 201);
    }
    catch (error) {
      const type = error instanceof Error ? error.message : undefined;
      if (type === "control_pairing_capacity_exceeded") { c.header("Retry-After", "300"); return c.json({ error: { type } }, 429); }
      if (type && PUBLIC_PAIRING_ERRORS.has(type)) return c.json({ error: { type } }, 403);
      return c.json({ error: { type: "pairing_unavailable" } }, 503);
    }
  });

  app.post("/control/pair/consume", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value as { id?: string; assertion?: unknown };
    if (!isJsonObject(body) || !hasExactKeys(body, ["id", "assertion"]) || !isUuidV4(body.id) || !validAssertion(body.assertion)) return c.json({ error: { type: "invalid_request" } }, 400);
    if (!options.capabilities.isApprovedPending(body.id, allowedOrigin)) {
      const failureRate = rateLimiter.take("pair:consume:failure", TAILNET_PAIRING_CONSUME_FAILURE_LIMIT, TAILNET_PAIRING_CONSUME_FAILURE_WINDOW_MS);
      if (!failureRate.ok) { c.header("Retry-After", String(failureRate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
      return c.json({ error: { type: "pairing_pending_or_expired" } }, 409);
    }
    const approvedRate = rateLimiter.take(`pair:consume:approved:${createHash("sha256").update(body.id).digest("base64url")}`, TAILNET_PAIRING_APPROVED_ATTEMPT_LIMIT, TAILNET_PAIRING_APPROVED_ATTEMPT_WINDOW_MS);
    if (!approvedRate.ok) { c.header("Retry-After", String(approvedRate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
    try {
      const result = await options.capabilities.consume(body.id, allowedOrigin, body.assertion);
      if (result) return c.json(result);
      return c.json({ error: { type: "pairing_pending_or_expired" } }, 409);
    } catch { return c.json({ error: { type: "pairing_persistence_failed" } }, 503); }
  });

  app.get("/control/status", async (c) => {
    const supplied = parseCapabilityBearer(c.req.header("authorization"));
    const capabilityIdentity = options.capabilities.authorizeContext(supplied, allowedOrigin, "GET", "/control/status");
    if (!capabilityIdentity) {
      const failureRate = rateLimiter.take("status:auth:failure", TAILNET_STATUS_AUTH_FAILURE_LIMIT, TAILNET_STATUS_AUTH_FAILURE_WINDOW_MS);
      if (!failureRate.ok) { c.header("Retry-After", String(failureRate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    const rate = rateLimiter.take(`status:${createHash("sha256").update(supplied!).digest("base64url")}`, 60, 60_000);
    if (!rate.ok) { c.header("Retry-After", String(rate.retryAfter)); return c.json({ error: { type: "local_control_rate_limited" } }, 429); }
    try {
      const staleEpoch = options.config.appliedConfigTenantId !== undefined && (options.config.appliedConfigTenantId !== capabilityIdentity.tenantId || options.config.appliedConfigDeviceId !== capabilityIdentity.deviceId)
        || options.config.lastControlPlaneContactTenantId !== undefined && (options.config.lastControlPlaneContactTenantId !== capabilityIdentity.tenantId || options.config.lastControlPlaneContactDeviceId !== capabilityIdentity.deviceId);
      const groqEnabled = staleEpoch ? false : options.config.providers.groq.enabled;
      const geminiEnabled = staleEpoch ? false : options.config.providers.gemini.enabled;
      const response: unknown = {
        status: "ok", proxyVersion: "0.1.0", accessState: options.config.deviceRevokedAt ? "revoked" : options.config.entitlementSuspendedAt ? "suspended" : "active", providers: {
          groq: { configured: options.config.providers.groq.configured, enabled: groqEnabled },
          gemini: {
            configured: options.config.providers.gemini.configured,
            enabled: geminiEnabled,
            privacyNoticePending: !staleEpoch && !geminiPrivacyAccepted(options.config.providers.gemini.privacyAcceptedAt, options.config.providers.gemini.privacyNoticeVersion)
          }
        },
        appliedConfigVersion: staleEpoch ? null : options.config.appliedConfigVersion ?? null, lastControlPlaneContact: staleEpoch ? null : options.config.lastControlPlaneContact ?? null,
        ...(options.ledger ? { quota: options.ledger.status({ groq: options.config.providers.groq.budget, gemini: options.config.providers.gemini.budget }).map(({ provider, basis, minute, providerRemaining }) => ({
          provider, basis, minute,
          ...(providerRemaining ? { providerRemaining: { ...(providerRemaining.requests !== undefined ? { requests: providerRemaining.requests } : {}), ...(providerRemaining.tokens !== undefined ? { tokens: providerRemaining.tokens } : {}) } } : {})
        })) } : {})
      };
      if (!validStatusProjection(response)) throw new Error("tailnet_status_invalid");
      return c.json(response);
    } catch { return c.json({ error: { type: "status_unavailable" } }, 503); }
  });

  return app;
}

const PUBLIC_PAIRING_ERRORS = new Set(["control_bootstrap_envelope_rejected", "control_bootstrap_token_rejected", "control_pairing_request_rejected", "control_pairing_not_configured", "control_identity_rejected"]);

function validStatusProjection(value: unknown): boolean {
  if (!isJsonObject(value) || !hasExactKeys(value, value.quota === undefined ? ["status", "proxyVersion", "accessState", "providers", "appliedConfigVersion", "lastControlPlaneContact"] : ["status", "proxyVersion", "accessState", "providers", "appliedConfigVersion", "lastControlPlaneContact", "quota"]) || value.status !== "ok" || value.proxyVersion !== "0.1.0" || !["active", "suspended", "revoked"].includes(value.accessState as string)) return false;
  if (value.appliedConfigVersion !== null && (!Number.isSafeInteger(value.appliedConfigVersion) || (value.appliedConfigVersion as number) < 1)) return false;
  if (value.lastControlPlaneContact !== null && !canonicalIso(value.lastControlPlaneContact)) return false;
  if (!isJsonObject(value.providers) || !hasExactKeys(value.providers, ["groq", "gemini"]) || !validProviderProjection(value.providers.groq, false) || !validProviderProjection(value.providers.gemini, true)) return false;
  if (value.quota === undefined) return true;
  if (!Array.isArray(value.quota) || value.quota.length > 2) return false;
  const seen = new Set<string>();
  for (const entry of value.quota) {
    if (!isJsonObject(entry) || !hasExactKeys(entry, entry.providerRemaining === undefined ? ["provider", "basis", "minute"] : ["provider", "basis", "minute", "providerRemaining"]) || !["groq", "gemini"].includes(entry.provider as string) || seen.has(entry.provider as string)) return false;
    seen.add(entry.provider as string);
    if (!["provider_headers_plus_local_ledger", "local_device_estimate"].includes(entry.basis as string) || !validMinute(entry.minute)) return false;
    if (entry.providerRemaining !== undefined && (entry.provider !== "groq" || !validRemaining(entry.providerRemaining))) return false;
  }
  return true;
}

function validProviderProjection(value: unknown, gemini: boolean): boolean { return isJsonObject(value) && hasExactKeys(value, gemini ? ["configured", "enabled", "privacyNoticePending"] : ["configured", "enabled"]) && typeof value.configured === "boolean" && typeof value.enabled === "boolean" && (!gemini || typeof value.privacyNoticePending === "boolean"); }
function validMinute(value: unknown): boolean { return isJsonObject(value) && hasExactKeys(value, ["requestsUsed", "requestsLimit", "tokensUsed", "tokensLimit"]) && nonNegativeInteger(value.requestsUsed) && positiveInteger(value.requestsLimit) && nonNegativeInteger(value.tokensUsed) && positiveInteger(value.tokensLimit); }
function validRemaining(value: unknown): boolean { return isJsonObject(value) && Object.keys(value).length > 0 && Object.keys(value).every((key) => ["requests", "tokens"].includes(key)) && (value.requests === undefined || nonNegativeInteger(value.requests)) && (value.tokens === undefined || nonNegativeInteger(value.tokens)); }
function nonNegativeInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) >= 0; }
function positiveInteger(value: unknown): boolean { return Number.isSafeInteger(value) && (value as number) > 0; }
function canonicalIso(value: unknown): boolean { if (typeof value !== "string") return false; const parsed = Date.parse(value); return Number.isFinite(parsed) && new Date(parsed).toISOString() === value; }

export function validateTailnetAllowedOrigin(value: string): string {
  if (!canonicalHttpsOrigin(value)) throw new Error("tailnet_dashboard_origin_invalid");
  return value;
}

export function validateTailnetExpectedHost(value: string): string {
  let url: URL;
  try { url = new URL(`https://${value}`); } catch { throw new Error("tailnet_expected_host_invalid"); }
  if (value !== url.host || url.port !== "21436" || !canonicalMagicDnsName(url.hostname) || url.pathname !== "/" || url.search || url.hash || url.username || url.password) throw new Error("tailnet_expected_host_invalid");
  return url.host;
}

function corsOrigin(c: { header(name: string, value: string): void }, origin: string): void {
  c.header("Access-Control-Allow-Origin", origin);
}

function corsPreflight(c: { header(name: string, value: string): void }, origin: string, preflight: { method: string; header: string }): void {
  corsOrigin(c, origin);
  c.header("Access-Control-Allow-Methods", preflight.method);
  c.header("Access-Control-Allow-Headers", preflight.header);
  c.header("Access-Control-Max-Age", "300");
}

function allowedPreflight(path: string, method: string, headers: string[]): { method: string; header: string } | undefined {
  const header = path === "/control/status" && method === "GET" ? "authorization"
    : ["/control/pair/challenge", "/control/pair/consume"].includes(path) && method === "POST" ? "content-type" : undefined;
  return header !== undefined && headers.length === 1 && headers[0] === header ? { method, header } : undefined;
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  const keys = Object.keys(value).sort();
  return keys.length === expected.length && keys.every((key, index) => key === [...expected].sort()[index]);
}
function safeClientName(value: unknown): value is string { return normalizeClientName(value) !== undefined; }
function safeId(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function isUuidV4(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function validAssertion(value: unknown): boolean { return typeof value === "string" ? value.length > 0 : isJsonObject(value); }
function parseCapabilityBearer(value: string | undefined): string | undefined {
  const match = value?.match(/^Bearer (utk_control_[A-Za-z0-9_-]{43})$/i);
  return match?.[1];
}
