/**
 * E2-22 W0 — model catalog / comparison / benchmark schemas (PROPOSED → implemented).
 * License: MIT (sync-contract package). Distinct from catalog.js (instrument ranking).
 * Unknown fields preserved; never coerce unknown → unsupported / 0.
 */

export const BENCHMARK_LIMITS = Object.freeze({
  maxModelsPerComparison: 4,
  pageDefault: 50,
  pageMax: 200,
  maxCasesFirstRun: 20,
});

export const BENCHMARK_ERROR_CODES = Object.freeze([
  "benchmark_incompatible",
  "stale_observation",
  "benchmark_budget_exceeded",
  "benchmark_cancelled",
  "source_unavailable",
  "insufficient_samples",
]);

const OBSERVATION_KINDS = new Set(["probe", "passive", "active", "external"]);
const COST_KNOWNS = new Set(["known", "estimated", "unknown"]);
const CONNECTION_STATES = new Set([
  "connected",
  "disconnected",
  "unknown",
  "configured",
  "unavailable",
]);

function assert(cond, code) {
  if (!cond) {
    const err = new Error(code);
    err.code = code;
    throw err;
  }
}

function isPlainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isIso(value) {
  if (typeof value !== "string") return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function isFinitePositiveNumber(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isNonNegFinite(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function preserveUnknown(input, knownKeys) {
  const extras = {};
  for (const [k, v] of Object.entries(input)) {
    if (!knownKeys.has(k)) extras[k] = v;
  }
  return extras;
}

/**
 * ModelCard — catalog projection + connection. Unknown modality/tool stays unknown.
 */
export function parseModelCard(input) {
  assert(isPlainObject(input), "model_card_invalid");
  assert(typeof input.providerId === "string" && input.providerId.length > 0, "model_card_provider_invalid");
  assert(typeof input.modelId === "string" && input.modelId.length > 0, "model_card_model_invalid");
  const revision = input.revision == null ? null : String(input.revision);
  assert(Array.isArray(input.modalities), "model_card_modalities_invalid");
  const modalities = input.modalities.map((m) => {
    assert(typeof m === "string", "model_card_modalities_invalid");
    return m;
  });
  let contextLimit;
  if ("contextLimit" in input) {
    if (input.contextLimit === null || input.contextLimit === "unknown") {
      contextLimit = null;
    } else {
      assert(Number.isInteger(input.contextLimit) && input.contextLimit > 0, "model_card_context_invalid");
      contextLimit = input.contextLimit;
    }
  }
  let toolSupport;
  if ("toolSupport" in input) {
    if (input.toolSupport === "unknown" || input.toolSupport === null) {
      toolSupport = "unknown";
    } else {
      assert(typeof input.toolSupport === "boolean", "model_card_tool_support_invalid");
      toolSupport = input.toolSupport;
    }
  } else {
    toolSupport = "unknown";
  }
  const connectionState = input.connectionState ?? "unknown";
  assert(CONNECTION_STATES.has(connectionState), "model_card_connection_invalid");
  assert(typeof input.source === "string" && input.source.length > 0, "model_card_source_invalid");
  assert(isIso(input.observedAt), "model_card_observed_at_invalid");

  const known = new Set([
    "providerId",
    "modelId",
    "revision",
    "modalities",
    "contextLimit",
    "toolSupport",
    "connectionState",
    "source",
    "observedAt",
  ]);
  return Object.freeze({
    providerId: input.providerId,
    modelId: input.modelId,
    revision,
    modalities: Object.freeze([...modalities]),
    ...(contextLimit !== undefined ? { contextLimit } : {}),
    toolSupport,
    connectionState,
    source: input.source,
    observedAt: input.observedAt,
    ...preserveUnknown(input, known),
  });
}

/**
 * BenchmarkDefinition — versioned cases + finite budget/deadline for active eval.
 */
export function parseBenchmarkDefinition(input, options = {}) {
  assert(isPlainObject(input), "benchmark_definition_invalid");
  assert(typeof input.id === "string" && input.id.length > 0, "benchmark_definition_id_invalid");
  assert(typeof input.version === "string" && input.version.length > 0, "benchmark_definition_version_invalid");
  assert(typeof input.datasetHash === "string" && input.datasetHash.length > 0, "benchmark_definition_dataset_invalid");
  assert(Array.isArray(input.caseRefs), "benchmark_definition_cases_invalid");
  const maxCases = options.maxCases ?? BENCHMARK_LIMITS.maxCasesFirstRun;
  assert(input.caseRefs.length >= 1 && input.caseRefs.length <= maxCases, "benchmark_definition_cases_invalid");
  for (const ref of input.caseRefs) {
    assert(typeof ref === "string" && ref.length > 0, "benchmark_definition_case_ref_invalid");
  }
  assert(isPlainObject(input.rubric), "benchmark_definition_rubric_invalid");
  assert(typeof input.rubric.version === "string" && input.rubric.version.length > 0, "benchmark_definition_rubric_invalid");
  assert(Number.isInteger(input.sampleCount) && input.sampleCount >= 1, "benchmark_definition_sample_invalid");
  assert(isPlainObject(input.parameters), "benchmark_definition_parameters_invalid");
  assert(isPlainObject(input.budget), "benchmark_definition_budget_invalid");
  assert(isFinitePositiveNumber(input.budget.maxCostMicros) || isFinitePositiveNumber(input.budget.maxTokens), "benchmark_definition_budget_invalid");
  assert(isIso(input.deadline), "benchmark_definition_deadline_invalid");
  assert(typeof input.privacyScope === "string" && input.privacyScope.length > 0, "benchmark_definition_privacy_invalid");

  // Active eval requires finite budget + deadline (already checked).
  const known = new Set([
    "id",
    "version",
    "datasetHash",
    "caseRefs",
    "rubric",
    "sampleCount",
    "parameters",
    "budget",
    "deadline",
    "privacyScope",
  ]);
  return Object.freeze({
    id: input.id,
    version: input.version,
    datasetHash: input.datasetHash,
    caseRefs: Object.freeze([...input.caseRefs]),
    rubric: Object.freeze({ ...input.rubric }),
    sampleCount: input.sampleCount,
    parameters: Object.freeze({ ...input.parameters }),
    budget: Object.freeze({ ...input.budget }),
    deadline: input.deadline,
    privacyScope: input.privacyScope,
    ...preserveUnknown(input, known),
  });
}

/**
 * Observation — probe | passive | active | external. value may be null (unknown ≠ 0).
 */
export function parseObservation(input) {
  assert(isPlainObject(input), "observation_invalid");
  assert(OBSERVATION_KINDS.has(input.kind), "observation_kind_invalid");
  assert(isPlainObject(input.modelRef), "observation_model_ref_invalid");
  assert(typeof input.modelRef.providerId === "string" && input.modelRef.providerId.length > 0, "observation_model_ref_invalid");
  assert(typeof input.modelRef.modelId === "string" && input.modelRef.modelId.length > 0, "observation_model_ref_invalid");
  assert(typeof input.metric === "string" && input.metric.length > 0, "observation_metric_invalid");
  // value optional / null ok — never coerce to 0
  let value = undefined;
  if ("value" in input) {
    if (input.value === null) value = null;
    else {
      assert(typeof input.value === "number" && Number.isFinite(input.value), "observation_value_invalid");
      value = input.value;
    }
  }
  assert(typeof input.unit === "string" && input.unit.length > 0, "observation_unit_invalid");
  assert(isIso(input.measuredAt), "observation_measured_at_invalid");
  if (input.window != null) {
    assert(isPlainObject(input.window), "observation_window_invalid");
  }
  if (input.runRef != null) assert(typeof input.runRef === "string", "observation_run_ref_invalid");
  if (input.sourceRef != null) assert(typeof input.sourceRef === "string", "observation_source_ref_invalid");
  assert(typeof input.status === "string" && input.status.length > 0, "observation_status_invalid");

  // Probe metrics must never be labeled as generation speed (enforced by metric naming convention).
  if (input.kind === "probe") {
    assert(
      input.metric === "endpoint_latency_ms" ||
        input.metric === "availability" ||
        input.metric.startsWith("probe_"),
      "observation_probe_metric_invalid",
    );
  }

  const known = new Set([
    "kind",
    "modelRef",
    "metric",
    "value",
    "unit",
    "measuredAt",
    "window",
    "runRef",
    "sourceRef",
    "status",
  ]);
  return Object.freeze({
    kind: input.kind,
    modelRef: Object.freeze({ ...input.modelRef }),
    metric: input.metric,
    ...(value !== undefined ? { value } : {}),
    unit: input.unit,
    measuredAt: input.measuredAt,
    ...(input.window != null ? { window: Object.freeze({ ...input.window }) } : {}),
    ...(input.runRef != null ? { runRef: input.runRef } : {}),
    ...(input.sourceRef != null ? { sourceRef: input.sourceRef } : {}),
    status: input.status,
    ...preserveUnknown(input, known),
  });
}

/**
 * BenchmarkRun — progress + cost honesty; cancelledAt optional.
 */
export function parseBenchmarkRun(input) {
  assert(isPlainObject(input), "benchmark_run_invalid");
  assert(typeof input.id === "string" && input.id.length > 0, "benchmark_run_id_invalid");
  assert(typeof input.definitionVersion === "string" && input.definitionVersion.length > 0, "benchmark_run_definition_invalid");
  assert(Array.isArray(input.modelRefs), "benchmark_run_models_invalid");
  assert(
    input.modelRefs.length >= 1 && input.modelRefs.length <= BENCHMARK_LIMITS.maxModelsPerComparison,
    "benchmark_run_models_invalid",
  );
  assert(Number.isInteger(input.completedCases) && input.completedCases >= 0, "benchmark_run_progress_invalid");
  assert(Number.isInteger(input.total) && input.total >= 1, "benchmark_run_progress_invalid");
  assert(input.completedCases <= input.total, "benchmark_run_progress_invalid");
  assert(isPlainObject(input.perCaseState), "benchmark_run_per_case_invalid");
  assert(COST_KNOWNS.has(input.costKnown), "benchmark_run_cost_invalid");
  if (input.cancelledAt != null) assert(isIso(input.cancelledAt), "benchmark_run_cancelled_at_invalid");

  const known = new Set([
    "id",
    "definitionVersion",
    "modelRefs",
    "completedCases",
    "total",
    "perCaseState",
    "costKnown",
    "cancelledAt",
  ]);
  return Object.freeze({
    id: input.id,
    definitionVersion: input.definitionVersion,
    modelRefs: Object.freeze(input.modelRefs.map((r) => Object.freeze({ ...r }))),
    completedCases: input.completedCases,
    total: input.total,
    perCaseState: Object.freeze({ ...input.perCaseState }),
    costKnown: input.costKnown,
    ...(input.cancelledAt != null ? { cancelledAt: input.cancelledAt } : {}),
    ...preserveUnknown(input, known),
  });
}

/**
 * RankingView — NO implicit global ranking; cohort + method required.
 */
export function parseRankingView(input) {
  assert(isPlainObject(input), "ranking_view_invalid");
  assert(isPlainObject(input.filter), "ranking_view_filter_invalid");
  assert(isPlainObject(input.metric) || typeof input.metric === "string", "ranking_view_metric_invalid");
  if (input.weights != null) assert(isPlainObject(input.weights), "ranking_view_weights_invalid");
  assert(typeof input.cohort === "string" && input.cohort.length > 0, "ranking_view_cohort_invalid");
  assert(typeof input.method === "string" && input.method.length > 0, "ranking_view_method_invalid");
  assert(Number.isInteger(input.sampleCount) && input.sampleCount >= 0, "ranking_view_sample_invalid");
  assert(isIso(input.sourceDate), "ranking_view_source_date_invalid");
  assert(Array.isArray(input.exclusions), "ranking_view_exclusions_invalid");
  // Forbid implicit global: cohort must not be empty/"global" without method
  assert(input.cohort !== "implicit_global", "ranking_view_no_implicit_global");

  const known = new Set([
    "filter",
    "metric",
    "weights",
    "cohort",
    "method",
    "sampleCount",
    "sourceDate",
    "exclusions",
  ]);
  return Object.freeze({
    filter: Object.freeze({ ...input.filter }),
    metric: typeof input.metric === "string" ? input.metric : Object.freeze({ ...input.metric }),
    ...(input.weights != null ? { weights: Object.freeze({ ...input.weights }) } : {}),
    cohort: input.cohort,
    method: input.method,
    sampleCount: input.sampleCount,
    sourceDate: input.sourceDate,
    exclusions: Object.freeze([...input.exclusions]),
    ...preserveUnknown(input, known),
  });
}

/** Pagination defaults: 50 / max 200. */
export function clampBenchmarkPageSize(requested) {
  if (requested == null) return BENCHMARK_LIMITS.pageDefault;
  assert(Number.isInteger(requested) && requested >= 1, "benchmark_page_invalid");
  return Math.min(requested, BENCHMARK_LIMITS.pageMax);
}

/** Active eval gate: finite budget + deadline required. */
export function assertActiveEvalReady(definition) {
  const def = parseBenchmarkDefinition(definition);
  const budgetOk =
    isFinitePositiveNumber(def.budget.maxCostMicros) || isFinitePositiveNumber(def.budget.maxTokens);
  assert(budgetOk, "benchmark_definition_budget_invalid");
  assert(isIso(def.deadline), "benchmark_definition_deadline_invalid");
  assert(Date.parse(def.deadline) > Date.now() - 60_000, "benchmark_definition_deadline_invalid");
  return def;
}

export function isBenchmarkErrorCode(code) {
  return BENCHMARK_ERROR_CODES.includes(code);
}

/** Parameter change → new definition version helper (hash of params). */
export function definitionVersionForParameters(baseId, parameters, datasetHash) {
  const payload = JSON.stringify({
    baseId,
    parameters: sortKeys(parameters),
    datasetHash,
  });
  // Simple stable fingerprint (not crypto); callers may replace with sha256.
  let h = 0;
  for (let i = 0; i < payload.length; i++) h = (Math.imul(31, h) + payload.charCodeAt(i)) | 0;
  return `${baseId}@${(h >>> 0).toString(16)}`;
}

function sortKeys(obj) {
  if (!isPlainObject(obj)) return obj;
  const out = {};
  for (const k of Object.keys(obj).sort()) out[k] = obj[k];
  return out;
}
