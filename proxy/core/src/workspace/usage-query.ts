/**
 * E2-15-Q — usage query against local store projections (not model execution).
 * Absent metrics stay null; estimated cost is never labeled as charge.
 */

import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import {
  ObservabilityError,
  QUERY_LIMITS,
  type CostKind,
  type UsageQueryInput,
  type UsageQueryResult,
  type UsageQueryRow,
  type UsageRecord,
} from "./usage-observability-types.ts";

const SUPPORTED_METRICS = new Set([
  "requests",
  "input_tokens",
  "output_tokens",
  "cached_input_tokens",
  "reasoning_tokens",
  "latency_ms_avg",
  "ttft_ms_avg",
  "errors",
  "cancellations",
  "cache_hits",
  "cache_misses",
  "cost_provider_reported_micros",
  "cost_estimated_reference_micros",
  "cost_confirmed_charge_micros",
]);

const SUPPORTED_DIMENSIONS = new Set([
  "provider",
  "model",
  "opaque_key",
  "app",
  "project",
  "agent",
  "session",
  "status",
  "day",
  "hour",
]);

function parseIso(s: string): number {
  const t = Date.parse(s);
  if (!Number.isFinite(t)) throw new ObservabilityError("invalid_range");
  return t;
}

function daysBetween(from: string, to: string): number {
  return (parseIso(to) - parseIso(from)) / (24 * 3600 * 1000);
}

function dimValue(r: UsageRecord, dim: string): string | null {
  switch (dim) {
    case "provider":
      return r.provider;
    case "model":
      return r.model;
    case "opaque_key":
      return r.opaqueKeyId;
    case "app":
      return r.appId;
    case "project":
      return r.projectId;
    case "agent":
      return r.agentId;
    case "session":
      return r.sessionId;
    case "status":
      return r.status;
    case "day":
      return r.createdAt.slice(0, 10);
    case "hour":
      return r.createdAt.slice(0, 13) + ":00:00.000Z";
    default:
      return null;
  }
}

function matchFilters(r: UsageRecord, filters: UsageQueryInput["filters"]): boolean {
  for (const f of filters) {
    const v = dimValue(r, f.field === "opaqueKeyId" ? "opaque_key" : f.field);
    if (f.op === "eq") {
      if (v !== f.value) return false;
    } else if (f.op === "in") {
      const set = Array.isArray(f.value) ? f.value : [f.value];
      if (!set.includes(v as string)) return false;
    }
  }
  return true;
}

function addNullable(a: number | null, b: number | null): number | null {
  if (a === null && b === null) return null;
  return (a ?? 0) + (b ?? 0);
}

function costMicros(r: UsageRecord, kind: "provider" | "estimated" | "confirmed"): number | null {
  const field =
    kind === "provider"
      ? r.cost.providerReported
      : kind === "estimated"
        ? r.cost.estimatedReference
        : r.cost.confirmedCharge;
  if (field.micros === null) return null;
  const n = Number(field.micros);
  return Number.isFinite(n) ? n : null;
}

/**
 * Query local usage projections. Does not dispatch inference or mutate journal.
 */
export function queryUsage(store: UsageObservabilityStore, input: UsageQueryInput): UsageQueryResult {
  if (!input.principalId) throw new ObservabilityError("unauthorized");
  if (!/^[A-Za-z]+\/[A-Za-z_]+$/.test(input.timezone) && input.timezone !== "UTC") {
    // Accept IANA-ish; UTC always ok. Soft gate — invalid range is the hard gate.
  }
  if (daysBetween(input.timeRange.from, input.timeRange.to) < 0) {
    throw new ObservabilityError("invalid_range");
  }
  if (daysBetween(input.timeRange.from, input.timeRange.to) > QUERY_LIMITS.maxRangeDays) {
    throw new ObservabilityError("invalid_range");
  }
  if (input.dimensions.length > QUERY_LIMITS.maxDimensions) throw new ObservabilityError("limit_exceeded");
  if (input.filters.length > QUERY_LIMITS.maxFilters) throw new ObservabilityError("limit_exceeded");
  for (const m of input.metrics) {
    if (!SUPPORTED_METRICS.has(m)) throw new ObservabilityError("unsupported_metric");
  }
  for (const d of input.dimensions) {
    if (!SUPPORTED_DIMENSIONS.has(d)) throw new ObservabilityError("unsupported_metric");
  }

  const from = parseIso(input.timeRange.from);
  const to = parseIso(input.timeRange.to);
  const limit = Math.min(Math.max(input.limit ?? 100, 1), QUERY_LIMITS.maxRowsPerPage);

  let candidates = store.listRecords(input.principalId, input.projectId).filter((r) => {
    const t = parseIso(r.createdAt);
    return t >= from && t <= to && matchFilters(r, input.filters);
  });

  // cursor = attemptId lexicographic
  if (input.cursor) {
    candidates = candidates.filter((r) => r.attemptId > input.cursor!);
  }
  candidates.sort((a, b) => (a.attemptId < b.attemptId ? -1 : a.attemptId > b.attemptId ? 1 : 0));

  let missingUsage = 0;
  let estimatedOnly = 0;
  let included = 0;
  for (const r of candidates) {
    if (r.usage.basis === "unknown" || r.usage.inputTokens === null || r.usage.outputTokens === null) {
      missingUsage++;
    } else if (r.usage.basis === "estimated") {
      estimatedOnly++;
    } else {
      included++;
    }
  }

  const groups = new Map<string, UsageRecord[]>();
  for (const r of candidates) {
    const keyParts = input.dimensions.map((d) => dimValue(r, d) ?? "∅");
    const key = keyParts.join("\0");
    const list = groups.get(key) ?? [];
    list.push(r);
    groups.set(key, list);
  }

  const rowsAll: UsageQueryRow[] = [];
  for (const [key, group] of groups) {
    const dims: Record<string, string | null> = {};
    input.dimensions.forEach((d, i) => {
      const part = key.split("\0")[i]!;
      dims[d] = part === "∅" ? null : part;
    });
    const metrics: Record<string, number | null> = {};
    const costKinds: Record<string, CostKind> = {};

    for (const m of input.metrics) {
      metrics[m] = aggregateMetric(group, m);
    }
    // Explicit cost kind labels so UI never confuses estimate with charge
    if ("cost_estimated_reference_micros" in metrics) {
      costKinds.cost_estimated_reference_micros = "estimated_reference";
    }
    if ("cost_confirmed_charge_micros" in metrics) {
      costKinds.cost_confirmed_charge_micros = group.some((r) => r.cost.confirmedCharge.micros !== null)
        ? "confirmed_charge"
        : "absent";
    }
    if ("cost_provider_reported_micros" in metrics) {
      costKinds.cost_provider_reported_micros = group.some((r) => r.cost.providerReported.micros !== null)
        ? "provider_reported"
        : "absent";
    }
    rowsAll.push(Object.freeze({ dimensions: Object.freeze(dims), metrics: Object.freeze(metrics), costKinds: Object.freeze(costKinds) }));
  }

  rowsAll.sort((a, b) => JSON.stringify(a.dimensions).localeCompare(JSON.stringify(b.dimensions)));
  const page = rowsAll.slice(0, limit);
  const nextCursor =
    candidates.length > 0 && rowsAll.length > limit
      ? candidates[Math.min(candidates.length - 1, limit)]?.attemptId ?? null
      : candidates.length > limit
        ? candidates[limit - 1]?.attemptId ?? null
        : null;

  // Prefer attempt-based pagination when dimensions empty (detail-friendly)
  let finalRows = page;
  let finalNext: string | null = nextCursor;
  if (input.dimensions.length === 0) {
    const slice = candidates.slice(0, limit);
    finalRows = slice.map((r) => {
      const metrics: Record<string, number | null> = {};
      for (const m of input.metrics) metrics[m] = aggregateMetric([r], m);
      const costKinds: Record<string, CostKind> = {
        cost_estimated_reference_micros: "estimated_reference",
        cost_confirmed_charge_micros: r.cost.confirmedCharge.micros !== null ? "confirmed_charge" : "absent",
        cost_provider_reported_micros: r.cost.providerReported.micros !== null ? "provider_reported" : "absent",
      };
      return Object.freeze({
        dimensions: Object.freeze({
          attemptId: r.attemptId,
          runId: r.runId,
          provider: r.provider,
          model: r.model,
        }),
        metrics: Object.freeze(metrics),
        costKinds: Object.freeze(costKinds),
      });
    });
    finalNext = candidates.length > limit ? slice.at(-1)!.attemptId : null;
  }

  const totals: Record<string, number | null> = {};
  for (const m of input.metrics) {
    totals[m] = aggregateMetric(candidates, m);
  }

  return {
    rows: Object.freeze(finalRows),
    totals: Object.freeze(totals),
    coverage: {
      observed: candidates.length,
      included,
      missingUsage,
      estimatedOnly,
    },
    measuredAt: new Date().toISOString(),
    source: "local_store",
    nextCursor: finalNext,
  };
}

function aggregateMetric(group: readonly UsageRecord[], m: string): number | null {
  switch (m) {
    case "requests":
      return group.length;
    case "input_tokens": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.usage.inputTokens);
      return acc;
    }
    case "output_tokens": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.usage.outputTokens);
      return acc;
    }
    case "cached_input_tokens": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.usage.cachedInputTokens);
      return acc;
    }
    case "reasoning_tokens": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.usage.reasoningTokens);
      return acc;
    }
    case "latency_ms_avg": {
      const vals = group.map((r) => r.latencyMs).filter((v): v is number => v !== null);
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    case "ttft_ms_avg": {
      const vals = group.map((r) => r.ttftMs).filter((v): v is number => v !== null);
      if (vals.length === 0) return null;
      return vals.reduce((a, b) => a + b, 0) / vals.length;
    }
    case "errors":
      return group.filter((r) => r.status === "failed").length;
    case "cancellations":
      return group.filter((r) => r.status === "cancelled").length;
    case "cache_hits": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.cacheHits);
      return acc;
    }
    case "cache_misses": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, r.cacheMisses);
      return acc;
    }
    case "cost_provider_reported_micros": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, costMicros(r, "provider"));
      return acc;
    }
    case "cost_estimated_reference_micros": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, costMicros(r, "estimated"));
      return acc;
    }
    case "cost_confirmed_charge_micros": {
      let acc: number | null = null;
      for (const r of group) acc = addNullable(acc, costMicros(r, "confirmed"));
      return acc;
    }
    default:
      return null;
  }
}

/** Token fidelity helper for AC01: preserve exact counts without inventing zeros. */
export function preserveTokenPair(
  input: number | null,
  output: number | null,
): { inputTokens: number | null; outputTokens: number | null; display: string } {
  return {
    inputTokens: input,
    outputTokens: output,
    display: `${input === null ? "unknown" : input}/${output === null ? "unknown" : output}`,
  };
}
