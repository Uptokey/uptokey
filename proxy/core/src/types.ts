import type { CoreProviderName, OptionalProviderName, ProviderName } from "./provider-registry.ts";
export type { CoreProviderName, OptionalProviderName, ProviderName } from "./provider-registry.ts";

export interface ChatCompletionRequest {
  model?: string;
  messages: Array<{ role: string; content: unknown }>;
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  max_completion_tokens?: number;
  uptokey_routing_combo?: string;
  uptokey_cost_mode?: "any" | "no_api_charge" | "economic" | "within_limit";
  uptokey_cost_limit_micros?: number;
  /** V4: the caller requires destinations declaring these input capabilities; no undeclared fallback. */
  /** Capabilities the destination must declare for the selected model (image/audio input, tools, json_schema). */
  uptokey_require_input?: Array<"image" | "audio" | "tools" | "json_schema">;
  [key: string]: unknown;
}

export interface ProviderBudget {
  rpm: number;
  tpm: number;
  rpd?: number;
  tpd?: number;
  source: "official_headers" | "account_user_input";
}

export interface ProviderConfig {
  name: ProviderName | string;
  enabled: boolean;
  configured: boolean;
  models: string[];
  defaultModel: string;
  budget: ProviderBudget;
  allowedFails: number;
  failureWindowMs: number;
  cooldownMs: number;
  max429Retries: number;
  baseBackoffMs: number;
  requestTimeoutMs: number;
  endpointUrl?: string;
  modelAliases?: Record<string, string>;
  maxContextTokens?: number;
  privacyAcceptedAt?: string;
  privacyNoticeVersion?: string;
  riskAcceptedAt?: string;
  riskNoticeVersion?: string;
}


export interface ResilienceConfig {
  /** When false, the router does not switch providers after a failure (still may retry 429 on the same provider). Default true. */
  autoFallbackEnabled?: boolean;
  /** Hard cap on total provider attempts (retries + fallbacks) per request. Default 3. */
  maxAttemptsPerRequest?: number;
  /** Local budget ratio (0–1) that emits an early warning before hard denial. Default 0.85. */
  quotaWarnRatio?: number;
  /** Transient retries (408/timeout) on the same provider before fallback. Default 1. */
  maxTransientRetries?: number;
}

export type RoutingMode = "fixed" | "cost" | "latency" | "balanced" | "quality" | "throughput" | "round_robin" | "auto";

export interface RoutingCombo {
  id: string;
  revision: number;
  name: string;
  mode: RoutingMode;
  modelOrder: string[];
  providerOrderByModel: Record<string, ProviderName[]>;
  allowModelFallback: boolean;
  allowProviderFallback: boolean;
  maxAttempts: number;
  /** Round-robin cursor: index of the next candidate to try. Persisted atomically by the store. */
  roundRobinCursor?: number;
  /** When true, session sticky provider prevails until health/quota prevents it. */
  sticky?: boolean;
  /** Optional per-combo cost ceiling in integer micro-USD; overrides global policy when set. */
  costCeilingMicros?: number;
  /** Optional per-combo latency policy. */
  latency?: { minSamples?: number; windowMs?: number };
  /** Optional per-combo retention policy. */
  retention?: { requireZdr?: boolean; denyDataCollection?: boolean };
}

/** Global routing policy (etapa 04). All fields optional; mode defaults to 'fixed'. Never adds candidates — only filters/reorders. */
export interface RoutingPolicyConfig {
  mode?: RoutingMode;
  /** Estimated-cost ceiling in integer micro-USD; priced candidates above it are excluded. Unpriced candidates are never excluded by the ceiling (unknown is not zero). */
  costCeilingMicros?: number;
  latency?: { minSamples?: number; windowMs?: number };
  retention?: { requireZdr?: boolean; denyDataCollection?: boolean };
}

/** PROPOSED E2-04: Versioned routing policy with candidates, limits, privacy, sticky and continuation. */
export interface RoutingPolicyV2 {
  schemaVersion: 2;
  id: string;
  revision: number;
  mode: RoutingMode;
  candidates: Candidate[];
  limits: Limits;
  privacy: Privacy;
  sticky?: { enabled: boolean; sessionId?: string };
  continuation?: { enabled: boolean; maxAdditionalTokens?: number };
}

/** PROPOSED E2-04: A routing candidate referencing model/provider/connection/endpoint/proxy. */
export interface Candidate {
  modelId: string;
  providerId: ProviderName;
  connectionId?: string;
  endpointId?: string;
  proxyPoolId?: string;
}

/** PROPOSED E2-04: Aggregate limits for a routing policy. */
export interface Limits {
  maxAttempts: number;
  maxElapsedMs: number;
  maxCostMicros: string | null;
  maxOutputTokens: number;
}

/** PROPOSED E2-04: Privacy requirements for candidate eligibility. */
export interface Privacy {
  requireZdr: boolean;
  denyDataCollection: boolean;
  allowedRegions: string[];
  requireParameters: boolean;
}

/** PROPOSED E2-04: Score evidence for quality/latency/throughput ranking. */
export interface ScoreEvidence {
  source: string;
  sourceRevision: string;
  measuredAt: string;
  expiresAt: string;
  sampleCount: number;
  taskClass: string;
  ttftMs: number | null;
  tokensPerSecond: number | null;
  qualityScore: number | null;
  tariffRef: string | null;
}

/** PROPOSED E2-04: Continuation plan for resuming an interrupted response. */
export interface ContinuationPlan {
  runId: string;
  parentAttemptId: string;
  partialArtifactId: string;
  partialHash: string;
  contextSnapshotId: string;
  nextCandidate: Candidate;
  maxAdditionalTokens: number;
  operationId: string;
  digest: string;
}

/** Versioned local evidence about a provider/model retention posture. Evidence is observed metadata, never a guarantee about the remote service. */
export interface RetentionEvidence {
  id: string;
  version: number;
  provider: ProviderName;
  /** When present, the entry applies only to this exact model; otherwise it is a provider-wide entry. */
  model?: string;
  zdr: "yes" | "no" | "unknown";
  dataCollection: "denied" | "allowed" | "unknown";
  /** True only when the official request parameter (e.g. data_collection) is documented for this route. */
  supportsDataCollectionParam?: boolean;
  sourceUrl: string;
  checkedAt: string;
  validUntil?: string;
}

/** Versioned routing decision evidence for continuation and audit. */
export interface RoutingAttempt {
  provider: ProviderName;
  model?: string;
  endpointId?: string;
  comboId?: string;
  comboRevision?: number;
  chosenReason?: string;
  exclusions: string[];
  streamingPartialRef?: string;
  inputTokenCount?: number;
  outputTokenCount?: number;
  costMicros?: number;
  latencyMs?: number;
  qualityScore?: number;
  timestamp: string;
}

/** Local evidence about provider/model retention posture, tied to a specific routing attempt. */
export interface AttemptEvidence {
  id: string;
  version: number;
  provider: ProviderName;
  model?: string;
  zdr: "yes" | "no" | "unknown";
  dataCollection: "denied" | "allowed" | "unknown";
  supportsDataCollectionParam?: boolean;
  sourceUrl: string;
  checkedAt: string;
  validUntil?: string;
}

/** Config-provided tariff observation; same field shape as the W0 ReferenceTariff (micros as decimal strings). */
/** F1: billed unit of a tariff. Token rates are per million; media rates are per image/second/character. */
export type TariffUnit = "million_tokens" | "image" | "second" | "character";
export interface TariffSnapshotEntry {
  id: string;
  version: number;
  provider: string;
  model: string;
  accessMode: "public" | "byok" | "local" | "hosted";
  currency: "USD";
  unit: TariffUnit;
  /** Token rates; per-unit tariffs carry "0" here and never price tokens. */
  inputMicrosPerMillion: string;
  outputMicrosPerMillion: string;
  cachedInputMicrosPerMillion: string | null;
  /** Explicit realtime audio token rates; same source and validity as this text tariff. */
  realtimeAudioRates?: { inputMicrosPerMillion: string; outputMicrosPerMillion: string; cachedInputMicrosPerMillion: string };
  /** Per-unit tariffs only: micro-USD per image, second or character. */
  unitMicros?: string;
  /** Optional billing dimension (e.g. image size/quality, video resolution); absent = any variant. */
  variant?: string;
  sourceUrl: string;
  checkedAt: string;
  validFrom: string;
  validUntil: string | null;
  comparisonBasis: "same_service" | "explicit_alternative";
}

/** Public read-only pricing projection; excludes credentials and account balances. */
export interface CandidatePricingEvidence {
  provider: ProviderName;
  model: string;
  accessMode: TariffSnapshotEntry['accessMode'];
  classification: 'local' | 'free_documented' | 'priced' | 'unknown';
  observationStatus: 'local' | 'current' | 'missing' | 'not_yet_valid' | 'expired';
  tariff: Omit<TariffSnapshotEntry, 'provider' | 'model' | 'accessMode' | 'comparisonBasis'> | null;
}

export interface ProxyConfig {
  efficiencyPolicy?: import('./efficiency-policy.ts').EfficiencyPolicy;
  fallbackOrder: ProviderName[];
  routingCombos?: Record<string, RoutingCombo>;
  activeRoutingComboId?: string;
  routingPolicy?: RoutingPolicyConfig;
  retentionEvidence?: RetentionEvidence[];
  tariffSnapshot?: TariffSnapshotEntry[];
  /** Local metadata destination only; exporting still requires explicit CLI opt-in. Keys stay in the existing vault. */
  workspaceTelemetry?: { kind: 'langfuse'; endpoint: string };
  resilience?: ResilienceConfig;
  providers: Record<CoreProviderName, ProviderConfig> & Partial<Record<OptionalProviderName, ProviderConfig>>;
  lastControlPlaneContact?: string;
  lastControlPlaneContactTenantId?: string;
  lastControlPlaneContactDeviceId?: string;
  lastObservedWallClock?: string;
  deviceRevokedAt?: string;
  entitlementSuspendedAt?: string;
  entitlementRevision?: number;
  appliedConfigVersion?: number;
  appliedConfigTenantId?: string;
  appliedConfigDeviceId?: string;
}

export interface DispatchBudgetAttempt {
  id: string;
  provider: ProviderName;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costMicros: string | null;
  accessMode: "local" | "byok";
  /** Server-resolved profile association, never supplied by an inference request. */
  commercialAccount?: { providerId: string; accountId: string };
  /** Price fixed at admission, applied only to validated reported usage. */
  priceUsage(input: number, output: number): string | null;
}
export interface DispatchBudgetReservation {
  /** Revalidate account observation immediately before dispatch after asynchronous preparation. */
  validate?(): Promise<void>;
  compensate(): Promise<void>;
  settle(input: number | null, output: number | null): Promise<void>;
  /** Internal provider adapter only: validated multimodal cost, bounded by the acquired reservation. */
  settleCost?(costMicros: string): Promise<void>;
}
export interface DispatchContext {
  requestId: string;
  /** Opaque SHA-256 of server-derived principal, resource and current policy. No partition means no local generation cache. */
  cachePartition?: string;
  /** Server-owned live retention authority; never accepted from inference JSON/headers. */
  allowCache?: () => Promise<boolean>;
  tenantId?: string;
  sessionId?: string;
  /** Server-owned provider boundary; omitted preserves routing, empty denies all. */
  allowedProviders?: readonly ProviderName[];
  /** Workflow executor owns retries and accounts for each upstream attempt. */
  disableRetries?: boolean;
  accountRef?: string;
  /**
   * Server-owned retention authority for this dispatch. `ephemeral` forbids durable
   * accounting side effects (calibration persistence); quota counters stay local metadata.
   * Never accepted from inference JSON/headers.
   */
  retentionMode?: "standard" | "ephemeral";
  /** Server-owned governance admission, never deserialized from a request. */
  reserveBudget?: (attempt: DispatchBudgetAttempt) => Promise<DispatchBudgetReservation | undefined>;
}

export interface DispatchOptions {
  /** Server-owned opt-in. Adapters admit this only on their verified official endpoint. */
  providerPromptCache?: boolean;
  proxyEndpoint?: string;
  /** Server-resolved hop credential; never forwarded inside a CONNECT tunnel. */
  proxyAuthorization?: string;
  /** Server-owned revision check immediately before dispatch/retry. */
  proxyAuthorityValid?: () => boolean;
  usedDirect?: boolean;
}

export interface ProviderAdapter {
  name: ProviderName | string;
  dispatch(request: ChatCompletionRequest, apiKey: string, signal: AbortSignal, requestTimeoutMs?: number, options?: DispatchOptions): Promise<Response>;
  /**
   * Exact JSON body `dispatch` sends for this request when it differs from the OpenAI-shaped
   * request (e.g. Anthropic Messages). Deterministic and side-effect free; the router recounts
   * it with the selected model's own tokenizer for that attempt. Omit when the body IS the request.
   */
  wireEnvelope?(request: ChatCompletionRequest, options?: DispatchOptions): unknown;
}
