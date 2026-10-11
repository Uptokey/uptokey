/**
 * E2-15 — shared types for usage/observability (exclusive module).
 * Contracts proposed in 15-SPECS; no W0/sync-contract edits.
 */

export type UsageBasis = "provider_reported" | "estimated" | "model_tokenizer" | "heuristic" | "reserved_limit" | "unknown";
export type CostKind = "provider_reported" | "estimated_reference" | "confirmed_charge" | "absent";

export interface TokenCounts {
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  readonly cachedInputTokens: number | null;
  readonly reasoningTokens: number | null;
}

export interface CostField {
  readonly kind: CostKind;
  /** Micro-USD when known; null means absent/unknown — never fabricate zero. */
  readonly micros: string | null;
  readonly currency: "USD" | null;
}

export interface UsageRecord {
  readonly id: string;
  readonly principalId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly generationRef: string | null;
  readonly createdAt: string; // ISO UTC
  readonly provider: string;
  readonly model: string;
  readonly opaqueKeyId: string | null;
  readonly appId: string | null;
  readonly agentId: string | null;
  readonly sessionId: string | null;
  readonly status: "succeeded" | "failed" | "cancelled" | "unknown";
  readonly latencyMs: number | null;
  readonly ttftMs: number | null;
  readonly usage: TokenCounts & { readonly basis: UsageBasis };
  readonly cost: {
    readonly providerReported: CostField;
    readonly estimatedReference: CostField;
    readonly confirmedCharge: CostField;
  };
  readonly cacheHits: number | null;
  readonly cacheMisses: number | null;
  /** Content bodies are never on the default record; see PrivateLoggingPlan. */
  readonly contentCaptured: false;
}

export interface UsageQueryInput {
  readonly principalId: string;
  readonly projectId?: string;
  readonly timeRange: { readonly from: string; readonly to: string };
  readonly timezone: string;
  readonly metrics: readonly string[];
  readonly dimensions: readonly string[];
  readonly filters: readonly { readonly field: string; readonly op: "eq" | "in"; readonly value: string | readonly string[] }[];
  readonly granularity?: "hour" | "day" | "none";
  readonly cursor?: string | null;
  readonly limit?: number;
}

export interface UsageQueryRow {
  readonly dimensions: Readonly<Record<string, string | null>>;
  readonly metrics: Readonly<Record<string, number | null>>;
  readonly costKinds: Readonly<Record<string, CostKind>>;
}

export interface UsageQueryResult {
  readonly rows: readonly UsageQueryRow[];
  readonly totals: Readonly<Record<string, number | null>>;
  readonly coverage: {
    readonly observed: number;
    readonly included: number;
    readonly missingUsage: number;
    readonly estimatedOnly: number;
  };
  readonly measuredAt: string;
  readonly source: "local_store";
  readonly nextCursor: string | null;
}

export type DestinationMode = "local_export" | "openrouter_broadcast";
export type DestinationSupport =
  | "available"
  | "requires_credential"
  | "future_announced"
  | "parser_unknown"
  | "unavailable";

export interface DestinationCatalogEntry {
  readonly typeId: string;
  readonly displayName: string;
  readonly mode: DestinationMode;
  readonly protocol: "otlp_http_json" | "otlp_http_protobuf" | "openrouter_api" | "webhook" | "s3" | "unknown";
  readonly support: DestinationSupport;
  readonly sourceUrl: string;
  readonly notes: string;
}

export interface DestinationConfigPublic {
  readonly id: string;
  readonly typeId: string;
  readonly mode: DestinationMode;
  readonly enabled: boolean;
  readonly privacyMode: boolean;
  readonly sampleRate: number;
  readonly revision: number;
  readonly credentialRef: string | null;
  readonly filters: Readonly<Record<string, string>>;
  readonly status: "configured" | "disabled" | "error" | "testing" | "unavailable";
  readonly errorCode: string | null;
  /** Never contains secrets even if upstream echoed them. */
  readonly publicEndpointHint: string | null;
}

export type LoggingMode = "metadata" | "content";

export interface PrivateLoggingPlan {
  readonly id: string;
  readonly principalId: string;
  readonly scopeRef: string;
  readonly mode: LoggingMode;
  readonly expiresAt: string;
  readonly retentionDays: number;
  readonly maxBytes: number;
  readonly destinationRefs: readonly string[];
  readonly consentDigest: string;
  readonly applied: boolean;
  readonly paused: boolean;
  readonly revision: number;
}

export interface SavedUsageView {
  readonly id: string;
  readonly ownerPrincipalId: string;
  readonly name: string;
  readonly query: UsageQueryInput;
  readonly revision: number;
  readonly updatedAt: string;
}

export const E2_15_ERRORS = Object.freeze([
  "unauthorized",
  "scope_mismatch",
  "unsupported_metric",
  "invalid_range",
  "management_key_required",
  "logging_not_enabled_at_capture",
  "destination_unavailable",
  "revision_conflict",
  "export_partial",
  "limit_exceeded",
] as const);

export type E215ErrorCode = (typeof E2_15_ERRORS)[number];

export class ObservabilityError extends Error {
  readonly code: E215ErrorCode;
  constructor(code: E215ErrorCode, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "ObservabilityError";
  }
}

export const QUERY_LIMITS = Object.freeze({
  maxRangeDays: 31,
  maxRowsPerPage: 500,
  maxDimensions: 8,
  maxFilters: 32,
  exportMaxBytes: 10 * 1024 * 1024,
  metadataMaxPairs: 32,
  metadataMaxBytes: 4 * 1024,
  sampleMin: 0.0001,
  sampleMax: 1,
  loggingMaxEnableHours: 24,
  loggingDefaultRetentionDays: 7,
  loggingMaxBytesPerProfile: 100 * 1024 * 1024,
});
