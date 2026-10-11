/**
 * E2-19 W0 — egress / proxy pool schemas (PROPOSED → implemented).
 * License: MIT (sync-contract package). No credential URLs in public projections.
 */

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const EGRESS_PROXY_KINDS = new Set([
  "http",
  "https",
  "socks5",
  "vercel_relay",
  "cloudflare_relay",
  "deno_relay",
]);

const POOL_STRATEGIES = new Set(["fixed", "round_robin", "random"]);
const HEALTH_STATES = new Set([
  "unknown",
  "healthy",
  "degraded",
  "cooldown",
  "disabled",
]);
const BINDING_OWNERS = new Set(["connection", "provider", "device"]);
const TEST_JOB_STATES = new Set([
  "queued",
  "running",
  "succeeded",
  "failed",
  "cancelled",
]);

export const EGRESS_LIMITS = Object.freeze({
  maxPools: 32,
  maxProxies: 128,
  maxMembersPerPool: 32,
  maxConcurrentTests: 2,
  testTimeoutMs: 10_000,
  failuresBeforeCooldown: 3,
  cooldownMs: 60_000,
  maxEndpointUrlLength: 2048,
  maxNoProxyRules: 64,
});

export function isUuid(value) {
  return typeof value === "string" && UUID_RE.test(value);
}

function assert(cond, code) {
  if (!cond) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
}

/**
 * Reject userinfo, fragments, and require scheme matching kind.
 * Endpoint must be canonical (no bare hostnames without scheme for http/https/socks5).
 */
export function validateEndpointUrl(kind, endpointUrl) {
  assert(typeof endpointUrl === "string", "endpoint_url_invalid");
  assert(endpointUrl.length > 0 && endpointUrl.length <= EGRESS_LIMITS.maxEndpointUrlLength, "endpoint_url_invalid");
  assert(!endpointUrl.includes("#"), "endpoint_url_fragment_forbidden");
  let url;
  try {
    url = new URL(endpointUrl);
  } catch {
    assert(false, "endpoint_url_invalid");
  }
  assert(!url.username && !url.password, "endpoint_url_userinfo_forbidden");
  const protocol = url.protocol.replace(/:$/, "").toLowerCase();
  if (kind === "http") assert(protocol === "http", "endpoint_url_kind_mismatch");
  else if (kind === "https") assert(protocol === "https", "endpoint_url_kind_mismatch");
  else if (kind === "socks5") assert(protocol === "socks5" || protocol === "socks", "endpoint_url_kind_mismatch");
  else if (kind === "vercel_relay" || kind === "cloudflare_relay" || kind === "deno_relay") {
    assert(protocol === "https" || protocol === "http", "endpoint_url_kind_mismatch");
  } else {
    assert(false, "egress_proxy_kind_invalid");
  }
  // Require hostname present and not a universal wildcard.
  assert(!!url.hostname && url.hostname !== "*", "endpoint_url_invalid");
  return url.href;
}

/**
 * noProxy: exact host, leading-dot suffix, or CIDR. No free regex / universal *.
 */
export function validateNoProxyRules(rules) {
  assert(Array.isArray(rules), "no_proxy_invalid");
  assert(rules.length <= EGRESS_LIMITS.maxNoProxyRules, "no_proxy_too_many");
  const out = [];
  for (const rule of rules) {
    assert(typeof rule === "string" && rule.length > 0 && rule.length <= 253, "no_proxy_invalid");
    assert(rule !== "*" && rule !== "*.*", "no_proxy_universal_forbidden");
    // Reject regex-looking free patterns.
    assert(!/[()[\]{}|+?\\]/.test(rule), "no_proxy_regex_forbidden");
    const cidr = /^(\d{1,3}\.){3}\d{1,3}\/\d{1,2}$/;
    const host = /^(?:\*\.)?[A-Za-z0-9._-]+$|^\.[A-Za-z0-9._-]+$/;
    assert(cidr.test(rule) || host.test(rule), "no_proxy_invalid");
    if (rule.includes('/')) {
      const [address, prefix] = rule.split('/');
      assert(address.split('.').every(octet => /^(0|[1-9]\d{0,2})$/.test(octet) && Number(octet) <= 255)
        && Number(prefix) <= 32, 'no_proxy_invalid');
    }
    out.push(rule);
  }
  return out;
}

export function parseEgressProxy(input) {
  assert(input && typeof input === "object", "egress_proxy_invalid");
  assert(input.schemaVersion === 1, "egress_proxy_schema_version");
  assert(isUuid(input.id), "egress_proxy_id_invalid");
  assert(Number.isInteger(input.revision) && input.revision >= 1, "egress_proxy_revision_invalid");
  assert(typeof input.label === "string" && input.label.length >= 1 && input.label.length <= 128, "egress_proxy_label_invalid");
  assert(EGRESS_PROXY_KINDS.has(input.kind), "egress_proxy_kind_invalid");
  const endpointUrl = validateEndpointUrl(input.kind, input.endpointUrl);
  assert(typeof input.enabled === "boolean", "egress_proxy_enabled_invalid");
  if (input.credentialRef != null) {
    assert(typeof input.credentialRef === "string" && input.credentialRef.length > 0, "egress_proxy_credential_ref_invalid");
  }
  if (input.operatorLabel != null) {
    assert(typeof input.operatorLabel === "string" && input.operatorLabel.length <= 256, "egress_proxy_operator_label_invalid");
  }
  if (input.retentionEvidence != null) {
    assert(typeof input.retentionEvidence === "string" && input.retentionEvidence.length <= 1024, "egress_proxy_retention_invalid");
  }
  return {
    schemaVersion: 1,
    id: input.id,
    revision: input.revision,
    label: input.label,
    kind: input.kind,
    endpointUrl,
    enabled: input.enabled,
    credentialRef: input.credentialRef ?? null,
    operatorLabel: input.operatorLabel ?? null,
    retentionEvidence: input.retentionEvidence ?? null,
  };
}

/** Public list projection — never returns credentialRef. */
export function projectEgressProxyPublic(proxy) {
  const p = parseEgressProxy(proxy);
  return {
    schemaVersion: p.schemaVersion,
    id: p.id,
    revision: p.revision,
    label: p.label,
    kind: p.kind,
    endpointUrl: maskEndpointUrl(p.endpointUrl),
    enabled: p.enabled,
    hasCredential: Boolean(p.credentialRef),
    operatorLabel: p.operatorLabel,
    retentionEvidence: p.retentionEvidence,
  };
}

export function maskEndpointUrl(endpointUrl) {
  try {
    const u = new URL(endpointUrl);
    return `${u.protocol}//${u.hostname}${u.port ? `:${u.port}` : ""}${u.pathname === "/" ? "" : u.pathname}`;
  } catch {
    return "[invalid]";
  }
}

export function parseProxyPool(input) {
  assert(input && typeof input === "object", "proxy_pool_invalid");
  assert(isUuid(input.id), "proxy_pool_id_invalid");
  assert(Number.isInteger(input.revision) && input.revision >= 1, "proxy_pool_revision_invalid");
  assert(Array.isArray(input.memberIds), "proxy_pool_members_invalid");
  assert(input.memberIds.length >= 1 && input.memberIds.length <= EGRESS_LIMITS.maxMembersPerPool, "proxy_pool_members_invalid");
  for (const id of input.memberIds) assert(isUuid(id), "proxy_pool_member_id_invalid");
  assert(POOL_STRATEGIES.has(input.strategy), "proxy_pool_strategy_invalid");
  assert(typeof input.strict === "boolean", "proxy_pool_strict_invalid");
  assert(typeof input.allowDirectFallback === "boolean", "proxy_pool_fallback_invalid");
  // Mutual exclusion: strict + allowDirectFallback is invalid.
  assert(!(input.strict && input.allowDirectFallback), "proxy_pool_strict_fallback_conflict");
  const healthPolicy = input.healthPolicy ?? {
    failuresBeforeCooldown: EGRESS_LIMITS.failuresBeforeCooldown,
    cooldownMs: EGRESS_LIMITS.cooldownMs,
  };
  assert(Number.isInteger(healthPolicy.failuresBeforeCooldown) && healthPolicy.failuresBeforeCooldown >= 1, "proxy_pool_health_policy_invalid");
  assert(Number.isInteger(healthPolicy.cooldownMs) && healthPolicy.cooldownMs >= 0, "proxy_pool_health_policy_invalid");
  const noProxy = validateNoProxyRules(input.noProxy ?? []);
  return {
    id: input.id,
    revision: input.revision,
    memberIds: [...input.memberIds],
    strategy: input.strategy,
    strict: input.strict,
    allowDirectFallback: input.allowDirectFallback,
    healthPolicy,
    noProxy,
  };
}

export function parseProxyBinding(input) {
  assert(input && typeof input === "object", "proxy_binding_invalid");
  assert(BINDING_OWNERS.has(input.ownerKind), "proxy_binding_owner_kind_invalid");
  assert(typeof input.ownerId === "string" && input.ownerId.length > 0, "proxy_binding_owner_id_invalid");
  if (input.poolId != null) assert(isUuid(input.poolId), "proxy_binding_pool_id_invalid");
  assert(typeof input.inherit === "boolean", "proxy_binding_inherit_invalid");
  assert(Number.isInteger(input.expectedRevision) && input.expectedRevision >= 0, "proxy_binding_expected_revision_invalid");
  return {
    ownerKind: input.ownerKind,
    ownerId: input.ownerId,
    poolId: input.poolId ?? null,
    inherit: input.inherit,
    expectedRevision: input.expectedRevision,
  };
}

export function parseProxyHealth(input) {
  assert(input && typeof input === "object", "proxy_health_invalid");
  assert(isUuid(input.memberId), "proxy_health_member_id_invalid");
  assert(HEALTH_STATES.has(input.state), "proxy_health_state_invalid");
  if (input.lastTestAt != null) assert(typeof input.lastTestAt === "string", "proxy_health_last_test_invalid");
  if (input.latencyMs != null) assert(Number.isFinite(input.latencyMs) && input.latencyMs >= 0, "proxy_health_latency_invalid");
  if (input.nextEligibleAt != null) assert(typeof input.nextEligibleAt === "string", "proxy_health_next_eligible_invalid");
  if (input.reason != null) assert(typeof input.reason === "string", "proxy_health_reason_invalid");
  return {
    memberId: input.memberId,
    state: input.state,
    lastTestAt: input.lastTestAt ?? null,
    latencyMs: input.latencyMs ?? null,
    nextEligibleAt: input.nextEligibleAt ?? null,
    reason: input.reason ?? null,
  };
}

export function parseEgressReceipt(input) {
  assert(input && typeof input === "object", "egress_receipt_invalid");
  assert(typeof input.attemptId === "string" && input.attemptId.length > 0, "egress_receipt_attempt_invalid");
  if (input.poolId != null) assert(isUuid(input.poolId), "egress_receipt_pool_invalid");
  if (input.poolRevision != null) assert(Number.isInteger(input.poolRevision), "egress_receipt_revision_invalid");
  if (input.memberId != null) assert(isUuid(input.memberId), "egress_receipt_member_invalid");
  assert(typeof input.finalHost === "string" && input.finalHost.length > 0, "egress_receipt_host_invalid");
  // Never allow credential-bearing endpoint in receipt.
  assert(!input.finalHost.includes("@"), "egress_receipt_credential_leak");
  assert(typeof input.transportKind === "string", "egress_receipt_transport_invalid");
  assert(typeof input.usedDirect === "boolean", "egress_receipt_direct_invalid");
  assert(typeof input.reason === "string", "egress_receipt_reason_invalid");
  return {
    attemptId: input.attemptId,
    poolId: input.poolId ?? null,
    poolRevision: input.poolRevision ?? null,
    memberId: input.memberId ?? null,
    finalHost: input.finalHost,
    transportKind: input.transportKind,
    usedDirect: input.usedDirect,
    reason: input.reason,
  };
}

export function parseProxyTestJob(input) {
  assert(input && typeof input === "object", "proxy_test_job_invalid");
  assert(isUuid(input.id), "proxy_test_job_id_invalid");
  assert(Array.isArray(input.memberIds) && input.memberIds.length >= 1, "proxy_test_job_members_invalid");
  for (const id of input.memberIds) assert(isUuid(id), "proxy_test_job_member_invalid");
  assert(typeof input.approvedTargetId === "string" && input.approvedTargetId.length > 0, "proxy_test_job_target_invalid");
  assert(typeof input.operationId === "string" && input.operationId.length > 0, "proxy_test_job_operation_invalid");
  assert(TEST_JOB_STATES.has(input.state), "proxy_test_job_state_invalid");
  assert(Number.isInteger(input.cursor) && input.cursor >= 0, "proxy_test_job_cursor_invalid");
  return {
    id: input.id,
    memberIds: [...input.memberIds],
    approvedTargetId: input.approvedTargetId,
    operationId: input.operationId,
    state: input.state,
    cursor: input.cursor,
  };
}

export const EGRESS_ERROR_CODES = Object.freeze({
  pool_not_found: 404,
  pool_in_use: 409,
  pool_revision_conflict: 409,
  proxy_auth_failed: 407,
  proxy_unavailable: 503,
  proxy_tls_failed: 502,
  egress_destination_denied: 403,
  strict_pool_unavailable: 503,
  relay_terms_unverified: 422,
  proxy_test_cancelled: 409,
  proxy_not_found: 404,
  proxy_in_use: 409,
  proxy_revision_conflict: 409,
});

export {
  EGRESS_PROXY_KINDS,
  POOL_STRATEGIES,
  HEALTH_STATES,
  BINDING_OWNERS,
  TEST_JOB_STATES,
};
