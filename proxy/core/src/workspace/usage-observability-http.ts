/**
 * E2-15 HTTP seam — usage/observability routes (exclusive module).
 * Shared http.ts calls handleUsageObservabilityHttp before route_not_found.
 * principalId must already be authenticated — never trust body.principalId.
 */

import { UsageObservabilityStore } from "./usage-observability-store.ts";
import { ObservabilityError, type UsageQueryInput } from "./usage-observability-types.ts";
import { queryUsage } from "./usage-query.ts";
import { getUsageDetail, reloadUsageDetail } from "./usage-detail.ts";
import { exportUsage, type ExportFormat } from "./usage-export.ts";
import { planPrivateLogging, pauseOrRevokeLogging } from "./private-logging.ts";
import {
  listDestinationCatalog,
  planDestination,
  toPwaDestinationCard,
  type DestinationPlanInput,
} from "./observability-destinations.ts";
import { ObservabilityConsole } from "./observability-console.ts";
import {
  createSyntheticCollector,
  flushOutbox,
  type SyntheticCollector,
} from "./observability-delivery.ts";

export type UsageObservabilityHttpResult = {
  status: number;
  body: Record<string, unknown>;
};

/** Process-level store bind (mirrors getBoundAutomationService). */
let boundStore: UsageObservabilityStore | undefined;
let boundConsole: ObservabilityConsole | undefined;
/** Test-only synthetic collector; production flush refuses without it. */
let boundTestCollector: SyntheticCollector | undefined;

export function bindUsageObservabilityStore(store: UsageObservabilityStore): void {
  boundStore = store;
  if (!boundConsole) boundConsole = new ObservabilityConsole();
}

export function getBoundUsageObservabilityStore(): UsageObservabilityStore | undefined {
  return boundStore;
}

export function getBoundObservabilityConsole(): ObservabilityConsole {
  if (!boundConsole) boundConsole = new ObservabilityConsole();
  return boundConsole;
}

/** Tests only — wire synthetic collector for delivery flush. */
export function bindUsageObservabilityTestCollector(collector: SyntheticCollector | undefined): void {
  boundTestCollector = collector;
}

export function resetUsageObservabilityHttpBindings(): void {
  boundStore = undefined;
  boundConsole = undefined;
  boundTestCollector = undefined;
}

export type UsageObservabilityHttpDeps = {
  principalId: string;
  store?: UsageObservabilityStore;
  console?: ObservabilityConsole;
  /** When true, POST delivery/flush may use synthetic collector (tests). */
  allowSyntheticFlush?: boolean;
};

/**
 * Paths reserved for usage/observability (additive).
 * Returns the HTTP method the route accepts, or undefined if not ours.
 */
export function usageObservabilityMethod(path: string, method?: string): "GET" | "POST" | undefined {
  const bare = path.split("?")[0] ?? path;
  if (method === "POST") {
    if (
      bare === "/v1/workspace/usage/query" ||
      bare === "/v1/workspace/usage/detail" ||
      bare === "/v1/workspace/usage/detail/reload" ||
      bare === "/v1/workspace/usage/views" ||
      bare === "/v1/workspace/usage/export" ||
      bare === "/v1/workspace/observability/logging/plan" ||
      bare === "/v1/workspace/observability/logging/pause" ||
      bare === "/v1/workspace/observability/destinations/plan" ||
      bare === "/v1/workspace/observability/delivery/flush"
    ) {
      return "POST";
    }
  }
  if (method === "GET" || !method) {
    if (
      bare === "/v1/workspace/usage/query" ||
      bare === "/v1/workspace/usage/detail" ||
      bare === "/v1/workspace/usage/views" ||
      bare === "/v1/workspace/observability/logging" ||
      bare === "/v1/workspace/observability/destinations/catalog" ||
      bare === "/v1/workspace/observability/console" ||
      bare === "/v1/workspace/usage/capabilities" ||
      bare === "/v1/workspace/observability/capabilities"
    ) {
      return "GET";
    }
  }
  if (!method) {
    if (
      bare === "/v1/workspace/usage/detail/reload" ||
      bare === "/v1/workspace/usage/export" ||
      bare === "/v1/workspace/observability/logging/plan" ||
      bare === "/v1/workspace/observability/logging/pause" ||
      bare === "/v1/workspace/observability/destinations/plan" ||
      bare === "/v1/workspace/observability/delivery/flush"
    ) {
      return "POST";
    }
  }
  return undefined;
}

export function usageObservabilityQueryAllowed(url: URL): boolean {
  const p = url.pathname;
  if (p === "/v1/workspace/usage/query") {
    return [...url.searchParams.keys()].every((k) =>
      ["from", "to", "since", "until", "period", "limit", "groupBy", "projectId", "granularity", "cursor", "metrics", "dimensions", "timezone"].includes(k),
    );
  }
  if (p === "/v1/workspace/usage/detail") {
    return [...url.searchParams.keys()].every((k) => ["runId", "projectId", "after", "limit"].includes(k));
  }
  if (p === "/v1/workspace/usage/views") {
    return [...url.searchParams.keys()].every((k) => ["after", "limit"].includes(k));
  }
  if (p === "/v1/workspace/observability/logging") {
    return [...url.searchParams.keys()].every((k) => ["level", "severity", "limit", "since", "until", "after"].includes(k));
  }
  if (p === "/v1/workspace/observability/console") {
    return [...url.searchParams.keys()].every((k) => ["tail", "lines", "filter", "limit"].includes(k));
  }
  if (p === "/v1/workspace/observability/destinations/catalog") {
    return [...url.searchParams.keys()].every((k) => ["type"].includes(k));
  }
  if (p === "/v1/workspace/usage/capabilities" || p === "/v1/workspace/observability/capabilities") {
    return url.search === "";
  }
  return false;
}

export function isUsageObservabilityPath(path: string): boolean {
  return usageObservabilityMethod(path) !== undefined ||
    (path.split("?")[0] === "/v1/workspace/usage/query") ||
    (path.split("?")[0] === "/v1/workspace/usage/detail") ||
    (path.split("?")[0] === "/v1/workspace/usage/views");
}

export async function handleUsageObservabilityHttp(
  method: string,
  pathname: string,
  input: unknown,
  deps: UsageObservabilityHttpDeps,
): Promise<UsageObservabilityHttpResult | null> {
  const bare = pathname.split("?")[0] ?? pathname;
  if (!isUsageObservabilityPath(bare) && usageObservabilityMethod(bare) === undefined) {
    // Double-check owned paths that accept multiple methods
    if (!ownedPath(bare)) return null;
  }
  if (!ownedPath(bare)) return null;

  const store = deps.store ?? boundStore;
  if (!store) {
    return { status: 503, body: { error: { type: "observability_unbound" } } };
  }
  const principalId = deps.principalId;
  const console = deps.console ?? getBoundObservabilityConsole();

  try {
    if (method === "GET" && (bare === "/v1/workspace/usage/capabilities" || bare === "/v1/workspace/observability/capabilities")) {
      return {
        status: 200,
        body: {
          id: "observability",
          hash: "#uso",
          query: true,
          detail: true,
          export: true,
          privateLoggingDefaultOff: true,
          destinationsCatalog: true,
          contractRevision: "e2-15.1",
          estimatedIsNotCharge: true,
          absentIsNotZero: true,
        },
      };
    }

    // E2-15-Q query
    if ((method === "GET" || method === "POST") && bare === "/v1/workspace/usage/query") {
      const q = buildQueryInput(asRecord(input), principalId);
      const result = queryUsage(store, q);
      return { status: 200, body: { ...result, rows: [...result.rows] } };
    }

    // E2-15-D detail
    if ((method === "GET" || method === "POST") && bare === "/v1/workspace/usage/detail") {
      const body = asRecord(input);
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!runId) throw new ObservabilityError("invalid_range", "runId_required");
      const detail = getUsageDetail(store, {
        principalId,
        runId,
        contentPolicyRef: typeof body.contentPolicyRef === "string" ? body.contentPolicyRef : null,
        cursor: typeof body.cursor === "string" ? body.cursor : null,
      });
      return {
        status: 200,
        body: {
          runId: detail.runId,
          receipts: [...detail.receipts],
          io: detail.io,
          estimatesIdentified: detail.estimatesIdentified,
          source: detail.source,
        },
      };
    }

    if (method === "POST" && bare === "/v1/workspace/usage/detail/reload") {
      const body = asRecord(input);
      const runId = typeof body.runId === "string" ? body.runId : "";
      if (!runId) throw new ObservabilityError("invalid_range", "runId_required");
      const reloaded = reloadUsageDetail(store, {
        principalId,
        runId,
        contentPolicyRef: typeof body.contentPolicyRef === "string" ? body.contentPolicyRef : null,
      });
      return {
        status: 200,
        body: {
          detail: {
            runId: reloaded.detail.runId,
            receipts: [...reloaded.detail.receipts],
            io: reloaded.detail.io,
            estimatesIdentified: reloaded.detail.estimatesIdentified,
            source: reloaded.detail.source,
          },
          inferenceDispatches: reloaded.inferenceDispatches,
          outboxLen: reloaded.outboxLen,
          reInferred: false,
        },
      };
    }

    // Views
    if (method === "GET" && bare === "/v1/workspace/usage/views") {
      return { status: 200, body: { views: store.listViews(principalId) } };
    }
    if (method === "POST" && bare === "/v1/workspace/usage/views") {
      const body = asRecord(input);
      const name = typeof body.name === "string" ? body.name : "";
      if (!name) throw new ObservabilityError("invalid_range", "name_required");
      const query = buildQueryInput(asRecord(body.query ?? body), principalId);
      const view = store.saveView({
        ownerPrincipalId: principalId,
        name,
        query,
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        id: typeof body.id === "string" ? body.id : undefined,
      });
      return { status: 201, body: { view } };
    }

    // E2-15-X export
    if (method === "POST" && bare === "/v1/workspace/usage/export") {
      const body = asRecord(input);
      const format = coerceFormat(body.format);
      const query = body.query ? buildQueryInput(asRecord(body.query), principalId) : undefined;
      const result = exportUsage(store, {
        principalId,
        query,
        viewRef: typeof body.viewRef === "string" ? body.viewRef : undefined,
        format,
        destinationRef: typeof body.destinationRef === "string" ? body.destinationRef : null,
        interruptAfterRows: typeof body.interruptAfterRows === "number" ? body.interruptAfterRows : undefined,
        maxBytes: typeof body.maxBytes === "number" ? body.maxBytes : undefined,
      });
      // Never return management keys; body is formula-safe CSV/JSON
      return {
        status: result.status === "partial" ? 206 : 200,
        body: {
          artifactRef: result.artifactRef,
          format: result.format,
          status: result.status,
          rowCount: result.rowCount,
          byteLength: result.byteLength,
          sha256: result.sha256,
          body: result.body,
          errorCode: result.errorCode,
        },
      };
    }

    // E2-15-L private logging
    if (method === "GET" && bare === "/v1/workspace/observability/logging") {
      const plans = store.listLoggingPlans(principalId).map((p) => ({
        id: p.id,
        scopeRef: p.scopeRef,
        mode: p.mode,
        expiresAt: p.expiresAt,
        retentionDays: p.retentionDays,
        applied: p.applied,
        paused: p.paused,
        revision: p.revision,
        destinationRefs: [...p.destinationRefs],
        // default I/O off signal
        contentIoDefault: "off" as const,
      }));
      return { status: 200, body: { plans, contentIoDefault: "off" } };
    }
    if (method === "POST" && bare === "/v1/workspace/observability/logging/plan") {
      const body = asRecord(input);
      const plan = planPrivateLogging(store, {
        principalId,
        scopeRef: typeof body.scopeRef === "string" ? body.scopeRef : "",
        mode: body.mode === "content" ? "content" : "metadata",
        expiresAt: typeof body.expiresAt === "string" ? body.expiresAt : "",
        retentionDays: typeof body.retentionDays === "number" ? body.retentionDays : undefined,
        destinationRefs: Array.isArray(body.destinationRefs)
          ? body.destinationRefs.filter((x): x is string => typeof x === "string")
          : [],
        consentToken: typeof body.consentToken === "string" ? body.consentToken : "",
        contentConsent: body.contentConsent === true,
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        id: typeof body.id === "string" ? body.id : undefined,
      });
      return {
        status: 201,
        body: {
          plan: {
            id: plan.id,
            scopeRef: plan.scopeRef,
            mode: plan.mode,
            expiresAt: plan.expiresAt,
            retentionDays: plan.retentionDays,
            applied: plan.applied,
            paused: plan.paused,
            revision: plan.revision,
            destinationRefs: [...plan.destinationRefs],
            consentDigest: plan.consentDigest,
          },
        },
      };
    }
    if (method === "POST" && bare === "/v1/workspace/observability/logging/pause") {
      const body = asRecord(input);
      const result = pauseOrRevokeLogging(store, {
        principalId,
        planId: typeof body.planId === "string" ? body.planId : "",
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : 0,
        purgeLocal: body.purgeLocal === true,
      });
      return {
        status: 200,
        body: {
          plan: {
            id: result.plan.id,
            paused: result.plan.paused,
            applied: result.plan.applied,
            revision: result.plan.revision,
          },
          purgedBodies: result.purgedBodies,
          remoteDelete: result.remoteDelete,
        },
      };
    }

    // E2-15-BR/B destinations
    if (method === "GET" && bare === "/v1/workspace/observability/destinations/catalog") {
      const catalog = listDestinationCatalog().map((e) => ({
        typeId: e.typeId,
        displayName: e.displayName,
        mode: e.mode,
        protocol: e.protocol,
        support: e.support,
        sourceUrl: e.sourceUrl,
        notes: e.notes,
      }));
      const configured = store.listDestinations().map((d) => toPwaDestinationCard(d));
      return { status: 200, body: { catalog, configured } };
    }
    if (method === "POST" && bare === "/v1/workspace/observability/destinations/plan") {
      const body = asRecord(input);
      const action = coerceDestinationAction(body.action);
      const planInput: DestinationPlanInput = {
        action,
        principalId,
        expectedRevision: typeof body.expectedRevision === "number" ? body.expectedRevision : undefined,
        destinationId: typeof body.destinationId === "string" ? body.destinationId : undefined,
        typeId: typeof body.typeId === "string" ? body.typeId : "",
        mode: body.mode === "openrouter_broadcast" ? "openrouter_broadcast" : "local_export",
        credentialRef: typeof body.credentialRef === "string" ? body.credentialRef : null,
        // managementKey accepted server-side only when present — never echoed
        managementKey: typeof body.managementKey === "string" ? body.managementKey : null,
        filters: isRecord(body.filters)
          ? Object.fromEntries(
              Object.entries(body.filters).filter(([, v]) => typeof v === "string") as [string, string][],
            )
          : undefined,
        privacyMode: body.privacyMode === true,
        sampleRate: typeof body.sampleRate === "number" ? body.sampleRate : undefined,
        enabled: typeof body.enabled === "boolean" ? body.enabled : undefined,
      };
      const result = planDestination(store, planInput);
      const publicConfig = result.publicConfig
        ? scrubSecrets({ ...toPwaDestinationCard(result.publicConfig), revision: result.publicConfig.revision })
        : null;
      const response = scrubSecrets({
        planId: result.planId,
        receiptRef: result.receiptRef,
        destinationId: result.destinationId,
        status: result.status,
        errorCode: result.errorCode,
        publicConfig,
        broadcastEnabled: result.broadcastEnabled,
        testDoesNotEnable: action === "test" ? true : undefined,
      });
      return { status: 200, body: response };
    }

    // Console cursor
    if (method === "GET" && bare === "/v1/workspace/observability/console") {
      const body = asRecord(input);
      const after = typeof body.after === "string" || typeof body.after === "number"
        ? Number(body.after)
        : 0;
      const limit = typeof body.limit === "number" ? body.limit : 32;
      const page = console.readAfter(store, Number.isFinite(after) ? after : 0, limit);
      return {
        status: 200,
        body: {
          events: page.events,
          nextCursor: page.nextCursor,
          done: page.done,
        },
      };
    }

    // Delivery flush — synthetic collector only in tests
    if (method === "POST" && bare === "/v1/workspace/observability/delivery/flush") {
      const allow = deps.allowSyntheticFlush === true || boundTestCollector !== undefined;
      if (!allow || !boundTestCollector) {
        return {
          status: 403,
          body: {
            error: {
              type: "synthetic_flush_forbidden",
              message: "delivery flush to synthetic collector is test-only",
            },
          },
        };
      }
      const stats = flushOutbox(store, boundTestCollector);
      return { status: 200, body: { ...stats, collector: "synthetic" } };
    }

    return { status: 404, body: { error: { type: "observability_route_not_found" } } };
  } catch (err) {
    if (err instanceof ObservabilityError) {
      return { status: statusFor(err.code), body: { error: { type: err.code } } };
    }
    return { status: 500, body: { error: { type: "observability_internal" } } };
  }
}

function ownedPath(bare: string): boolean {
  return (
    bare === "/v1/workspace/usage/capabilities" ||
    bare === "/v1/workspace/observability/capabilities" ||
    bare === "/v1/workspace/usage/query" ||
    bare === "/v1/workspace/usage/detail" ||
    bare === "/v1/workspace/usage/detail/reload" ||
    bare === "/v1/workspace/usage/views" ||
    bare === "/v1/workspace/usage/export" ||
    bare === "/v1/workspace/observability/logging" ||
    bare === "/v1/workspace/observability/logging/plan" ||
    bare === "/v1/workspace/observability/logging/pause" ||
    bare === "/v1/workspace/observability/destinations/catalog" ||
    bare === "/v1/workspace/observability/destinations/plan" ||
    bare === "/v1/workspace/observability/console" ||
    bare === "/v1/workspace/observability/delivery/flush"
  );
}

function statusFor(code: string): number {
  switch (code) {
    case "unauthorized":
      return 403;
    case "revision_conflict":
      return 409;
    case "destination_unavailable":
      return 404;
    case "management_key_required":
    case "scope_mismatch":
    case "unsupported_metric":
    case "invalid_range":
    case "limit_exceeded":
    case "logging_not_enabled_at_capture":
    case "export_partial":
      return 400;
    default:
      return 400;
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function buildQueryInput(body: Record<string, unknown>, principalId: string): UsageQueryInput {
  const from = isRecord(body.timeRange) && typeof body.timeRange.from === "string"
    ? body.timeRange.from
    : typeof body.from === "string" ? body.from : "";
  const to = isRecord(body.timeRange) && typeof body.timeRange.to === "string"
    ? body.timeRange.to
    : typeof body.to === "string" ? body.to : "";
  const timeRange = { from, to };
  const metrics = Array.isArray(body.metrics)
    ? body.metrics.filter((m): m is string => typeof m === "string")
    : ["requests", "input_tokens", "output_tokens"];
  const dimensions = Array.isArray(body.dimensions)
    ? body.dimensions.filter((d): d is string => typeof d === "string")
    : [];
  const filters = Array.isArray(body.filters)
    ? body.filters
        .filter(isRecord)
        .map((f) => ({
          field: typeof f.field === "string" ? f.field : "",
          op: f.op === "in" ? ("in" as const) : ("eq" as const),
          value: (Array.isArray(f.value)
            ? f.value.filter((x): x is string => typeof x === "string")
            : typeof f.value === "string"
              ? f.value
              : "") as string | readonly string[],
        }))
    : [];
  return {
    principalId, // owner from auth — ignore body.principalId
    projectId: typeof body.projectId === "string" ? body.projectId : undefined,
    timeRange,
    timezone: typeof body.timezone === "string" ? body.timezone : "UTC",
    metrics,
    dimensions,
    filters,
    granularity:
      body.granularity === "hour" || body.granularity === "day" || body.granularity === "none"
        ? body.granularity
        : undefined,
    cursor: typeof body.cursor === "string" ? body.cursor : null,
    limit: typeof body.limit === "number" ? body.limit : undefined,
  };
}

function coerceFormat(v: unknown): ExportFormat {
  if (v === "json" || v === "otlp_artifact_ref") return v;
  return "csv";
}

function coerceDestinationAction(
  v: unknown,
): DestinationPlanInput["action"] {
  const allowed = ["create", "update", "test", "enable", "disable", "delete"] as const;
  return allowed.includes(v as (typeof allowed)[number]) ? (v as (typeof allowed)[number]) : "test";
}

/** Strip any accidental secret-shaped keys from PWA-bound payloads. */
function scrubSecrets(payload: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(payload)) {
    if (/management[_-]?key|secret|password|token|api[_-]?key/i.test(k)) continue;
    if (v && typeof v === "object" && !Array.isArray(v)) {
      out[k] = scrubSecrets(v as Record<string, unknown>);
    } else {
      out[k] = v;
    }
  }
  const s = JSON.stringify(out);
  if (/management[_-]?key|or-mgmt|sk-or-/i.test(s)) {
    return JSON.parse(s.replace(/("(?:management[_-]?key|or-mgmt)[^"]*"\s*:\s*)"[^"]*"/gi, '$1"[redacted]"'));
  }
  return out;
}

// Re-export collector helper for tests wiring through this module
export { createSyntheticCollector };
