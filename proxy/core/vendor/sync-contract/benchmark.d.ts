/** E2-22 W0 — model catalog / comparison / benchmark types. Distinct from instrument catalog. */

export declare const BENCHMARK_LIMITS: {
  readonly maxModelsPerComparison: 4;
  readonly pageDefault: 50;
  readonly pageMax: 200;
  readonly maxCasesFirstRun: 20;
};

export declare const BENCHMARK_ERROR_CODES: readonly [
  "benchmark_incompatible",
  "stale_observation",
  "benchmark_budget_exceeded",
  "benchmark_cancelled",
  "source_unavailable",
  "insufficient_samples",
];

export type ObservationKind = "probe" | "passive" | "active" | "external";
export type CostKnown = "known" | "estimated" | "unknown";
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "unknown"
  | "configured"
  | "unavailable";
export type ToolSupport = boolean | "unknown";

export interface ModelRef {
  providerId: string;
  modelId: string;
  revision?: string | null;
  accountRef?: string | null;
}

export interface ModelCard {
  providerId: string;
  modelId: string;
  revision: string | null;
  modalities: readonly string[];
  contextLimit?: number | null;
  toolSupport: ToolSupport;
  connectionState: ConnectionState;
  source: string;
  observedAt: string;
  [unknownKey: string]: unknown;
}

export interface BenchmarkDefinition {
  id: string;
  version: string;
  datasetHash: string;
  caseRefs: readonly string[];
  rubric: { version: string; [k: string]: unknown };
  sampleCount: number;
  parameters: Readonly<Record<string, unknown>>;
  budget: Readonly<{ maxCostMicros?: number; maxTokens?: number; [k: string]: unknown }>;
  deadline: string;
  privacyScope: string;
  [unknownKey: string]: unknown;
}

export interface Observation {
  kind: ObservationKind;
  modelRef: ModelRef;
  metric: string;
  value?: number | null;
  unit: string;
  measuredAt: string;
  window?: Readonly<Record<string, unknown>>;
  runRef?: string;
  sourceRef?: string;
  status: string;
  [unknownKey: string]: unknown;
}

export interface BenchmarkRun {
  id: string;
  definitionVersion: string;
  modelRefs: readonly ModelRef[];
  completedCases: number;
  total: number;
  perCaseState: Readonly<Record<string, unknown>>;
  costKnown: CostKnown;
  cancelledAt?: string;
  [unknownKey: string]: unknown;
}

export interface RankingView {
  filter: Readonly<Record<string, unknown>>;
  metric: string | Readonly<Record<string, unknown>>;
  weights?: Readonly<Record<string, number>>;
  cohort: string;
  method: string;
  sampleCount: number;
  sourceDate: string;
  exclusions: readonly string[];
  [unknownKey: string]: unknown;
}

export declare function parseModelCard(input: unknown): ModelCard;
export declare function parseBenchmarkDefinition(
  input: unknown,
  options?: { maxCases?: number },
): BenchmarkDefinition;
export declare function parseObservation(input: unknown): Observation;
export declare function parseBenchmarkRun(input: unknown): BenchmarkRun;
export declare function parseRankingView(input: unknown): RankingView;
export declare function clampBenchmarkPageSize(requested?: number | null): number;
export declare function assertActiveEvalReady(definition: unknown): BenchmarkDefinition;
export declare function isBenchmarkErrorCode(code: string): boolean;
export declare function definitionVersionForParameters(
  baseId: string,
  parameters: Record<string, unknown>,
  datasetHash: string,
): string;
