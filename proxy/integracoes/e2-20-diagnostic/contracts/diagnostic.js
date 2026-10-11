/**
 * E2-20 W0 lab contract stubs — diagnostic MITM ops.
 * Lab-only under 20-work/contracts/. Mirrors proposed W0 shape; NOT merged into
 * shared @uptokey/sync-contract until sole ownership / product PR.
 * schemaVersion: 1 | status: proposed_lab
 */

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1"]);

export const DIAGNOSTIC_SCHEMA_VERSION = 1;
export const DIAGNOSTIC_PACKAGE_ID = "E2-20";
export const DIAGNOSTIC_CONTRACT_STATUS = "proposed_lab";

export const DIAGNOSTIC_LIMITS = Object.freeze({
  maxSessionTtlMs: 15 * 60 * 1000,
  maxOrigins: 5,
  maxConnections: 16,
  maxBodyBytes: 1 * 1024 * 1024,
  maxTotalBytes: 50 * 1024 * 1024,
  maxRetentionHours: 24,
  maxAliasMapEntries: 16,
  maxExportCursor: 1_000_000,
});

export const DIAGNOSTIC_ERROR_CODES = Object.freeze({
  diagnostic_disabled: "diagnostic_disabled",
  ownership_scope_unverified: "ownership_scope_unverified",
  target_not_authorized: "target_not_authorized",
  backend_unavailable: "backend_unavailable",
  port_conflict: "port_conflict",
  certificate_untrusted: "certificate_untrusted",
  pinned_client_unsupported: "pinned_client_unsupported",
  collection_not_authorized: "collection_not_authorized",
  scope_expired: "scope_expired",
  process_identity_unknown: "process_identity_unknown",
  restore_conflict: "restore_conflict",
  plan_invalid: "plan_invalid",
  revision_mismatch: "revision_mismatch",
  wildcard_origin_forbidden: "wildcard_origin_forbidden",
  insecure_skip_verify_forbidden: "insecure_skip_verify_forbidden",
  uncertain_state: "uncertain_state",
});

export const DIAGNOSTIC_COLLECT_POLICIES = Object.freeze(["off", "redacted"]);
export const DIAGNOSTIC_MODES = Object.freeze(["explicit", "reverse"]);
export const DIAGNOSTIC_SESSION_STATES = Object.freeze([
  "idle",
  "active",
  "stopping",
  "stopped",
  "needs_attention",
]);

/** Stable W0-shaped operation ids (lab proposal). */
export const DIAGNOSTIC_OPERATIONS = Object.freeze([
  "diagnostic.discover",
  "diagnostic.plan",
  "diagnostic.start",
  "diagnostic.certificate.inspect",
  "diagnostic.route.plan",
  "diagnostic.observe",
  "diagnostic.export",
  "diagnostic.stop",
]);

function assert(cond, code) {
  if (!cond) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
}

function isPlainObject(v) {
  return v != null && typeof v === "object" && !Array.isArray(v);
}

export function isLoopbackHost(host) {
  const h = String(host || "")
    .split(":")[0]
    .toLowerCase()
    .replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(h);
}

export function assertExactLoopbackOrigins(origins) {
  assert(Array.isArray(origins), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(origins.length >= 1, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(origins.length <= DIAGNOSTIC_LIMITS.maxOrigins, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  for (const o of origins) {
    assert(typeof o === "string" && o.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
    assert(o !== "*" && !o.includes("*"), DIAGNOSTIC_ERROR_CODES.wildcard_origin_forbidden);
    const host = o.split(":")[0];
    assert(isLoopbackHost(host), DIAGNOSTIC_ERROR_CODES.target_not_authorized);
  }
  return origins.map(String);
}

export function assertNoInsecureSkipVerify(payload) {
  if (!isPlainObject(payload)) return;
  assert(
    payload.insecureSkipVerify !== true &&
      payload.rejectUnauthorized !== false &&
      payload.tlsInsecure !== true,
    DIAGNOSTIC_ERROR_CODES.insecure_skip_verify_forbidden
  );
}

/** Capability catalog entry (W0-shaped). */
export function describeDiagnosticCapability(operationId) {
  assert(DIAGNOSTIC_OPERATIONS.includes(operationId), "unknown_operation");
  const base = {
    schemaVersion: DIAGNOSTIC_SCHEMA_VERSION,
    packageId: DIAGNOSTIC_PACKAGE_ID,
    contractStatus: DIAGNOSTIC_CONTRACT_STATUS,
    operationId,
    version: "0.1.0-lab",
    handler: "lab.W5DiagnosticAdapter",
    providerRequirements: ["local_loopback", "opt_in_feature_flag"],
    configurationObserved: {
      defaultEnabled: false,
      osCaMutation: false,
      dnsMutation: false,
      globalProxy: false,
    },
    state: "available_lab",
    effectsAdmitted: [],
    policy: {
      collectPolicies: [...DIAGNOSTIC_COLLECT_POLICIES],
      modes: [...DIAGNOSTIC_MODES],
      limits: { ...DIAGNOSTIC_LIMITS },
    },
    integrationOrigin: "expansao-2/20-work/contracts",
    integrationRevision: "lab-proposed",
    supportProof: "lab_harness_and_unit_tests",
    ui: {
      shellRegion: "conexoes.diagnostico_avancado",
      i18nKeyPrefix: "diag.advanced",
      icon: "stethoscope",
      deferredProductUi: true,
    },
  };

  const byOp = {
    "diagnostic.discover": {
      inputModalities: ["json"],
      outputModalities: ["json"],
      effectsAdmitted: [],
      summary: "Report support/version; zero capture",
    },
    "diagnostic.plan": {
      inputModalities: ["json"],
      outputModalities: ["json"],
      effectsAdmitted: ["plan_materialize"],
      summary: "Build revisable plan with explicit destinations/effects",
    },
    "diagnostic.start": {
      inputModalities: ["json"],
      outputModalities: ["json", "receipt"],
      effectsAdmitted: ["bind_loopback_proxy", "session_ca_ephemeral"],
      summary: "Start approved plan; idempotent by requestId",
    },
    "diagnostic.certificate.inspect": {
      inputModalities: ["json"],
      outputModalities: ["json"],
      effectsAdmitted: [],
      summary: "Fingerprint/issuer/validity/scope; never private key",
    },
    "diagnostic.route.plan": {
      inputModalities: ["json"],
      outputModalities: ["json"],
      effectsAdmitted: ["route_diff_propose"],
      summary: "Alias/route diff within granted destinations only",
    },
    "diagnostic.observe": {
      inputModalities: ["json"],
      outputModalities: ["json"],
      effectsAdmitted: [],
      summary: "Cursor-based observation of authorized records",
    },
    "diagnostic.export": {
      inputModalities: ["json"],
      outputModalities: ["json", "artifact_ref"],
      effectsAdmitted: ["artifact_export_authorized"],
      summary: "Export authorized records + manifesto; canary-gated",
    },
    "diagnostic.stop": {
      inputModalities: ["json"],
      outputModalities: ["json", "receipt"],
      effectsAdmitted: ["stop_capture", "destroy_session_ca"],
      summary: "Stop/revoke; destroy session CA; no OS trust touch",
    },
  };

  return { ...base, ...byOp[operationId], effectsAdmitted: byOp[operationId].effectsAdmitted };
}

export function listDiagnosticCapabilities() {
  return DIAGNOSTIC_OPERATIONS.map(describeDiagnosticCapability);
}

export function parseDiscoverInput(input = {}) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assertNoInsecureSkipVerify(input);
  return {
    platform: typeof input.platform === "string" ? input.platform : "lab",
    mode: DIAGNOSTIC_MODES.includes(input.mode) ? input.mode : "explicit",
    localAppRef: typeof input.localAppRef === "string" ? input.localAppRef : null,
  };
}

export function parseDiscoverOutput(output) {
  assert(isPlainObject(output), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(output.capture === false, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(output.dnsMutation === false, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(output.globalTrust === false, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  return {
    support: String(output.support || ""),
    version: String(output.version || ""),
    license: String(output.license || ""),
    configurationRequired: Array.isArray(output.configurationRequired)
      ? output.configurationRequired.map(String)
      : [],
    capture: false,
    dnsMutation: false,
    globalTrust: false,
  };
}

export function parsePlanInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assertNoInsecureSkipVerify(input);
  assert(typeof input.appRef === "string" && input.appRef.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(
    typeof input.ownershipEvidenceRef === "string" && input.ownershipEvidenceRef.length > 0,
    DIAGNOSTIC_ERROR_CODES.ownership_scope_unverified
  );
  const origins = assertExactLoopbackOrigins(input.origins);
  const mode = DIAGNOSTIC_MODES.includes(input.mode) ? input.mode : "explicit";
  const collectPolicy = DIAGNOSTIC_COLLECT_POLICIES.includes(input.collectPolicy)
    ? input.collectPolicy
    : input.collectPolicyRef === "redacted"
      ? "redacted"
      : "off";
  let expiresAt = input.expiresAt;
  if (expiresAt != null) {
    const t = Date.parse(expiresAt);
    assert(!Number.isNaN(t), DIAGNOSTIC_ERROR_CODES.plan_invalid);
    expiresAt = new Date(t).toISOString();
  }
  const limits = {
    ttlMs: Math.min(
      Number(input.limits?.ttlMs) > 0 ? Number(input.limits.ttlMs) : DIAGNOSTIC_LIMITS.maxSessionTtlMs,
      DIAGNOSTIC_LIMITS.maxSessionTtlMs
    ),
    maxOrigins: DIAGNOSTIC_LIMITS.maxOrigins,
    maxConnections: DIAGNOSTIC_LIMITS.maxConnections,
    maxBodyBytes: DIAGNOSTIC_LIMITS.maxBodyBytes,
    maxTotalBytes: DIAGNOSTIC_LIMITS.maxTotalBytes,
  };
  return {
    appRef: input.appRef,
    ownershipEvidenceRef: input.ownershipEvidenceRef,
    origins,
    mode,
    collectPolicy,
    collectPolicyRef: typeof input.collectPolicyRef === "string" ? input.collectPolicyRef : collectPolicy,
    expiresAt,
    limits,
  };
}

export function parsePlanOutput(output) {
  assert(isPlainObject(output), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof output.planRef === "string" && output.planRef.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assertExactLoopbackOrigins(output.origins || []);
  assert(typeof output.confidence === "number", DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(Array.isArray(output.effectsExplicit), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  return {
    planRef: output.planRef,
    revision: Number.isInteger(output.revision) && output.revision >= 1 ? output.revision : 1,
    origins: output.origins.map(String),
    mode: output.mode,
    collectPolicy: output.collectPolicy,
    confidence: output.confidence,
    effectsExplicit: output.effectsExplicit.map(String),
    destinations: Array.isArray(output.destinations) ? output.destinations.map(String) : [...output.origins],
    expiresAt: output.expiresAt || null,
    limits: output.limits || { ...DIAGNOSTIC_LIMITS },
    osCaMutation: false,
    dnsMutation: false,
  };
}

export function parseStartInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assertNoInsecureSkipVerify(input);
  assert(
    typeof input.approvedPlanRef === "string" && input.approvedPlanRef.length > 0,
    DIAGNOSTIC_ERROR_CODES.plan_invalid
  );
  assert(typeof input.requestId === "string" && input.requestId.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  return {
    approvedPlanRef: input.approvedPlanRef,
    requestId: input.requestId,
  };
}

export function parseCertificateInspectInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof input.sessionRef === "string" && input.sessionRef.length > 0, DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
  return { sessionRef: input.sessionRef };
}

export function parseCertificateInspectOutput(output) {
  assert(isPlainObject(output), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  if (output.error) {
    return { error: String(output.error) };
  }
  assert(typeof output.fingerprint === "string" && output.fingerprint.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(output.privateKeyExported === false, DIAGNOSTIC_ERROR_CODES.collection_not_authorized);
  const blob = JSON.stringify(output);
  assert(!/BEGIN .*PRIVATE KEY/.test(blob), DIAGNOSTIC_ERROR_CODES.collection_not_authorized);
  return {
    fingerprint: output.fingerprint,
    issuer: String(output.issuer || ""),
    validity: output.validity || null,
    scope: String(output.scope || "session_test_client_only"),
    trustState: String(output.trustState || "ephemeral_uninstalled"),
    privateKeyExported: false,
  };
}

export function parseRoutePlanInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof input.sessionRef === "string" && input.sessionRef.length > 0, DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
  assert(Number.isInteger(input.expectedRevision) && input.expectedRevision >= 1, DIAGNOSTIC_ERROR_CODES.revision_mismatch);
  assert(isPlainObject(input.aliasMap), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  const entries = Object.entries(input.aliasMap);
  assert(entries.length <= DIAGNOSTIC_LIMITS.maxAliasMapEntries, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  const granted = Array.isArray(input.grantedDestinations) ? input.grantedDestinations.map(String) : null;
  for (const [alias, dest] of entries) {
    assert(typeof alias === "string" && alias.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
    assert(typeof dest === "string" && dest.length > 0, DIAGNOSTIC_ERROR_CODES.plan_invalid);
    assert(!alias.includes("*") && !dest.includes("*"), DIAGNOSTIC_ERROR_CODES.wildcard_origin_forbidden);
    const destHost = dest.split(":")[0];
    assert(isLoopbackHost(destHost), DIAGNOSTIC_ERROR_CODES.target_not_authorized);
    if (granted) {
      assert(
        granted.some((g) => g === dest || g.split(":")[0] === destHost),
        DIAGNOSTIC_ERROR_CODES.target_not_authorized
      );
    }
  }
  return {
    sessionRef: input.sessionRef,
    expectedRevision: input.expectedRevision,
    aliasMap: Object.fromEntries(entries),
    grantedDestinations: granted,
  };
}

export function parseObserveExportInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof input.sessionRef === "string" && input.sessionRef.length > 0, DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
  const cursor = input.cursor == null ? 0 : Number(input.cursor);
  assert(Number.isInteger(cursor) && cursor >= 0 && cursor <= DIAGNOSTIC_LIMITS.maxExportCursor, DIAGNOSTIC_ERROR_CODES.plan_invalid);
  return {
    sessionRef: input.sessionRef,
    cursor,
    format: typeof input.format === "string" ? input.format : "json",
    manifesto: input.manifesto === true,
  };
}

export function parseObserveExportOutput(output) {
  assert(isPlainObject(output), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  if (output.error) {
    return {
      error: String(output.error),
      detail: output.detail || null,
      records: [],
      droppedCount: Number(output.droppedCount) || 0,
      collectionState: output.collectionState || "off",
    };
  }
  assert(Array.isArray(output.records), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof output.droppedCount === "number", DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(DIAGNOSTIC_COLLECT_POLICIES.includes(output.collectionState), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  const blob = JSON.stringify(output);
  assert(!/BEGIN .*PRIVATE KEY/.test(blob), DIAGNOSTIC_ERROR_CODES.collection_not_authorized);
  return {
    records: output.records,
    droppedCount: output.droppedCount,
    collectionState: output.collectionState,
    nextCursor: typeof output.nextCursor === "number" ? output.nextCursor : output.records.length,
    artifactRef: output.artifactRef ?? null,
  };
}

export function parseStopInput(input) {
  assert(isPlainObject(input), DIAGNOSTIC_ERROR_CODES.plan_invalid);
  assert(typeof input.sessionRef === "string" && input.sessionRef.length > 0, DIAGNOSTIC_ERROR_CODES.diagnostic_disabled);
  if (input.expectedRevision != null) {
    assert(Number.isInteger(input.expectedRevision) && input.expectedRevision >= 1, DIAGNOSTIC_ERROR_CODES.revision_mismatch);
  }
  return {
    sessionRef: input.sessionRef,
    expectedRevision: input.expectedRevision ?? null,
    reason: typeof input.reason === "string" ? input.reason : "user_stop",
  };
}
