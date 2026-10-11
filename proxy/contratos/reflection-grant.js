/** Reflection grant wire contract v1. Pure ESM; no network, storage, secrets or authorization.
 *
 * C7 — a single W5 consent on /aplicar covers the write plan AND up to
 * `maxAttempts` coder reflection retries within `ttlMs` and a hard token
 * ceiling. The grant is the durable witness of that coverage: it carries the
 * consent reference and the exact budget. When the budget or deadline is
 * exhausted, a new consent (new W5) is required — no implicit renewal.
 */
import { canonicalJson } from './canonical.js';

export const REFLECTION_GRANT_VERSION = 1;
export const REFLECTION_LIMITS = Object.freeze({
  maxAttempts: 3,
  maxTokensPerAttempt: 4096,
  totalTokenCeiling: 12288,
  ttlMs: 300_000, // 5 minutes from consent
});

export class ReflectionGrantError extends Error {
  constructor(code = 'reflection_grant_invalid') { super(code); this.name = 'ReflectionGrantError'; this.code = code; }
}
function fail(code) { throw new ReflectionGrantError(code); }
const integer = (v, max = Number.MAX_SAFE_INTEGER, min = 0) => Number.isSafeInteger(v) && v >= min && v <= max;
function isoDate(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const time = Date.parse(v); return Number.isFinite(time) && new Date(time).toISOString() === v;
}

/** Mints a grant bound to one W5 consent. `now`/`issuedAt` must be ISO; expiry is issuedAt + ttlMs. */
export function createReflectionGrant(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('reflection_grant_invalid');
  const keys = Object.keys(input).sort().join(',');
  if (keys !== 'consentRef,issuedAt') fail('reflection_grant_invalid');
  const { consentRef, issuedAt } = input;
  if (typeof consentRef !== 'string' || consentRef.length < 8 || consentRef.length > 200) fail('reflection_grant_invalid');
  if (!isoDate(issuedAt)) fail('reflection_grant_invalid');
  const expiresAt = new Date(Date.parse(issuedAt) + REFLECTION_LIMITS.ttlMs).toISOString();
  return Object.freeze({
    schemaVersion: REFLECTION_GRANT_VERSION,
    maxAttempts: REFLECTION_LIMITS.maxAttempts,
    maxTokensPerAttempt: REFLECTION_LIMITS.maxTokensPerAttempt,
    totalTokenCeiling: REFLECTION_LIMITS.totalTokenCeiling,
    consentRef,
    issuedAt,
    expiresAt,
  });
}

const GRANT_KEYS = 'consentRef,expiresAt,issuedAt,maxAttempts,maxTokensPerAttempt,schemaVersion,totalTokenCeiling';

/** Validates a grant received over the wire or from storage. Throws on any deviation. */
export function parseReflectionGrant(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) fail('reflection_grant_invalid');
  if (Object.keys(input).sort().join(',') !== GRANT_KEYS) fail('reflection_grant_invalid');
  if (input.schemaVersion !== REFLECTION_GRANT_VERSION) fail('reflection_grant_invalid');
  for (const key of ['maxAttempts', 'maxTokensPerAttempt', 'totalTokenCeiling']) {
    if (input[key] !== REFLECTION_LIMITS[key]) fail('reflection_grant_invalid');
  }
  if (typeof input.consentRef !== 'string' || input.consentRef.length < 8 || input.consentRef.length > 200) fail('reflection_grant_invalid');
  if (!isoDate(input.issuedAt) || !isoDate(input.expiresAt)) fail('reflection_grant_invalid');
  if (Date.parse(input.expiresAt) !== Date.parse(input.issuedAt) + REFLECTION_LIMITS.ttlMs) fail('reflection_grant_invalid');
  return Object.freeze({ ...input });
}

/** True when the grant is still within its validity window. */
export function reflectionGrantActive(grant, now = new Date().toISOString()) {
  return isoDate(now) && Date.parse(now) < Date.parse(grant.expiresAt);
}

/**
 * Pure budget predicate for usage accumulated under one grant.
 * `usage.attempts`, `usage.inputTokens` and `usage.outputTokens` must all fit.
 */
export function reflectionGrantCovers(grant, usage) {
  if (!usage || typeof usage !== 'object') return false;
  if (!integer(usage.attempts, grant.maxAttempts)) return false;
  if (!integer(usage.inputTokens, grant.totalTokenCeiling)) return false;
  if (!integer(usage.outputTokens, grant.totalTokenCeiling)) return false;
  return usage.inputTokens + usage.outputTokens <= grant.totalTokenCeiling;
}

/** Canonical JSON of the grant, for journal/reciprocity records. */
export function reflectionGrantDigest(grant) {
  return canonicalJson(parseReflectionGrant(grant));
}
