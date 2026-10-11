import type { ChatCompletionRequest } from "./types.ts";
import {
  DEFAULT_ESTIMATED_OUTPUT_TOKENS,
  TOKEN_CATALOG_VERSION,
  TOKEN_VERIFIER_ENGINE_ID,
  TOKENIZER_VECTOR_SET_ID,
  TOKENIZER_MATERIAL_CONTRACT,
  TOKENIZER_PROFILE_VERSION,
  estimateRequestTokens,
  measureRequestTokens,
  measureEmbeddingTokens,
  measureWithLocalTokenizer,
  resolveTokenizerEntry,
  resolveModelIdentity,
  listTokenizerCatalog,
  listTokenizerVectors,
  verifyTokenizerVectors,
  tokenizerArtifactDigest,
  hasMultimodalParts,
  tokenMetricsSnapshot,
  tokenCountCacheSize,
  resetTokenMetricsForTests,
  parseImageDimensions,
  TOKEN_LIMITS,
  normalizeModelId,
  uncoveredEnvelopeJson,
  describeTokenizerCapabilities,
  tokenizerArtifactProfile,
  tokenizerMaterialDigest,
  type TokenizerFamilyCapabilities,
  type TokenizerArtifactProfile,
  type TokenizerSpecialTokenProbe,
  type TiktokenRankMaterial,
  type CatalogTokenMeasurement,
  type TokenizerCatalogEntry,
  type TokenizerVector,
  type ModelIdentity,
  type TokenMeasurement,
  type TokenVerifier,
  type TokenBreakdown,
  type TokenizerStatus,
  type TokenConfidence,
  type TokenMetricsSnapshot,
  type MeasureOptions,
  type EmbeddingMeasurement,
  type LiveTokenizeResult,
} from "./token-catalog.ts";

export {
  DEFAULT_ESTIMATED_OUTPUT_TOKENS,
  TOKEN_CATALOG_VERSION,
  TOKEN_VERIFIER_ENGINE_ID,
  TOKENIZER_VECTOR_SET_ID,
  TOKEN_LIMITS,
  estimateRequestTokens,
  measureRequestTokens,
  measureEmbeddingTokens,
  measureWithLocalTokenizer,
  resolveTokenizerEntry,
  resolveModelIdentity,
  listTokenizerCatalog,
  listTokenizerVectors,
  verifyTokenizerVectors,
  tokenizerArtifactDigest,
  hasMultimodalParts,
  tokenMetricsSnapshot,
  tokenCountCacheSize,
  resetTokenMetricsForTests,
  parseImageDimensions,
  normalizeModelId,
  uncoveredEnvelopeJson,
  describeTokenizerCapabilities,
  tokenizerArtifactProfile,
  tokenizerMaterialDigest,
  type TokenizerFamilyCapabilities,
  type TokenizerArtifactProfile,
  type TokenizerSpecialTokenProbe,
  type TiktokenRankMaterial,
  type CatalogTokenMeasurement,
  type TokenizerCatalogEntry,
  type TokenizerVector,
  type ModelIdentity,
  type TokenMeasurement,
  type TokenVerifier,
  type TokenBreakdown,
  type TokenizerStatus,
  type TokenConfidence,
  type TokenMetricsSnapshot,
  type MeasureOptions,
  type EmbeddingMeasurement,
  type LiveTokenizeResult,
};

export interface TokenEstimate {
  input: number;
  output: number;
}

export interface DetailedTokenEstimate {
  /** Total accountable input tokens; null when nothing countable (never invented). */
  input: number | null;
  output: number;
  basis: import("@uptokey/sync-contract/workflow").TokenUsageBasis;
  source: string;
  version: string;
  reason: string | null;
  isMultimodal: boolean;
  /** Explicit trust state: verified | partial | heuristic | unknown | unavailable. */
  state: TokenizerStatus;
  confidence: TokenConfidence | null;
  model: string;
  catalogVersion: string;
  outputBasis: "declared_limit" | "default_estimate";
  /** Declared output budget only (null when undeclared); never provider-reported output. */
  outputLimit: number | null;
  identity: ModelIdentity;
  provider: string | null;
  modelRevision: string | null;
  tokenizerId: string;
  artifactDigest: string | null;
  flags: readonly string[];
  breakdown: TokenBreakdown | null;
  verifier: TokenMeasurement["verifier"];
}

/**
 * Legacy chars/4 heuristic for existing context and budget consumers. The compatible API name
 * does not promise an upper bound: text in some languages and media can cost more. Retains
 * deterministic Math.ceil(serialized.length / 4) behavior over the full serialized envelope.
 * Router quota reservation also consults the catalog. This is not the auditable subsystem entry
 * point — use detailedTokenEstimate/measureRequestTokens for state, provenance and breakdown.
 */
export function conservativeTokenEstimate(request: ChatCompletionRequest): TokenEstimate | undefined {
  const declaredOutputs = [request.max_tokens, request.max_completion_tokens].filter((value): value is number => value !== undefined);
  if (declaredOutputs.some((value) => !Number.isSafeInteger(value) || value < 1)) return undefined;
  const declaredOutput = declaredOutputs.length > 0 ? Math.max(...declaredOutputs) : undefined;
  let serialized: string;
  try { serialized = JSON.stringify(request); } catch { return undefined; }
  if (!serialized) return undefined;
  return {
    // Estimativa baseada na proporção padrão de ~4 caracteres por token (chars/4),
    // com teto mínimo de 1 token. Cobre mensagens completas, system prompt e tools.
    input: Math.max(1, Math.ceil(serialized.length / 4)),
    output: (declaredOutput as number | undefined) ?? DEFAULT_ESTIMATED_OUTPUT_TOKENS
  };
}

/**
 * Detailed estimation via the versioned, provider-aware catalog: real model tokenizers when
 * available (verified), separated text/media/uncountable accounting (partial), labeled
 * chars/4 fallback (heuristic), explicit unknown/unavailable — never a heuristic presented
 * as exact. Returns undefined only when the declared output budget is invalid.
 */
export function detailedTokenEstimate(request: ChatCompletionRequest, options?: MeasureOptions): DetailedTokenEstimate | undefined {
  const measured = measureRequestTokens(request, options);
  if (!measured) return undefined;
  return {
    input: measured.input,
    output: measured.output,
    basis: measured.basis,
    source: measured.source,
    version: measured.version,
    reason: measured.reason,
    isMultimodal: measured.isMultimodal,
    state: measured.state,
    confidence: measured.confidence,
    model: measured.model,
    catalogVersion: measured.catalogVersion,
    outputBasis: measured.outputBasis,
    outputLimit: measured.outputLimit,
    identity: measured.identity,
    provider: measured.provider,
    modelRevision: measured.modelRevision,
    tokenizerId: measured.tokenizerId,
    artifactDigest: measured.artifactDigest,
    flags: measured.flags,
    breakdown: measured.breakdown,
    verifier: measured.verifier,
  };
}

/** Additional reservation margin; the catalog already includes its known chat framing. */
const RESERVATION_FRAMING_TOKENS_PER_MESSAGE = 8;

export interface ReservationEstimate {
  /** Tokens to reserve against the provider budget (input + declared/default output). */
  readonly total: number;
  /**
   * Provenance of the value that set the reservation: the conservative chars/4 envelope, a real
   * model tokenizer over every counted part, or a catalog estimate (documented media formula,
   * heuristic text or envelope fields counted outside the catalog decomposition). A larger
   * reservation never promotes the label.
   */
  readonly basis: "conservative_chars" | "model_tokenizer" | "catalog_estimate";
  readonly state: TokenizerStatus | "heuristic";
  /** complete only when the catalog verified the whole prompt-bearing envelope. */
  readonly coverage: "complete" | "partial";
  /** Catalog reason propagated (limits, uncountable parts, framing); null when verified. */
  readonly reason: string | null;
  readonly tokenizerId: string | null;
  /** Catalog evidence remains separate from the trust state of the winning reservation. */
  readonly catalogBasis: TokenMeasurement["basis"] | null;
  readonly catalogState: TokenizerStatus | null;
  /** Catalog version the measurement came from; null when no catalog measurement was possible. */
  readonly catalogVersion: string | null;
  readonly source: string;
}

/**
 * Quota reservation for the resolved provider request. chars/4 is not an upper bound (e.g. CJK
 * text tokenizes well above it), so when the provider-aware catalog counts the request
 * (verified/partial) the reservation is the larger of both, plus a conservative framing margin.
 * Envelope fields outside the catalog decomposition are counted with the same model tokenizer
 * when one exists (heuristic otherwise) and mark the coverage partial. Never lowers the
 * conservative value; tokenizer failure keeps it with its heuristic label.
 */
export function reservationTokenEstimate(request: ChatCompletionRequest, conservative: TokenEstimate): ReservationEstimate {
  const conservativeTotal = conservative.input + conservative.output;
  let measured: ReturnType<typeof measureRequestTokens>;
  try { measured = measureRequestTokens(request, { verify: "off" }); } catch { measured = undefined; }
  const provenance = { tokenizerId: measured?.tokenizerId ?? null, catalogBasis: measured?.basis ?? null, catalogState: measured?.state ?? null, catalogVersion: measured?.catalogVersion ?? null };
  if (!measured || measured.input === null || (measured.state !== "verified" && measured.state !== "partial")) {
    return { total: conservativeTotal, basis: "conservative_chars", state: "heuristic", coverage: "partial", reason: measured?.reason ?? null, source: "uptokey:conservative-chars4", ...provenance };
  }
  const extraJson = uncoveredEnvelopeJson(request);
  let extraTokens = 0;
  let extraByTokenizer = true;
  if (extraJson !== null) {
    let extra: ReturnType<typeof measureEmbeddingTokens>;
    try { extra = measureEmbeddingTokens(measured.model, extraJson, { verify: "off" }); } catch { extra = undefined; }
    extraTokens = extra?.input ?? Math.ceil(extraJson.length / 4);
    extraByTokenizer = extra?.basis === "model_tokenizer";
  }
  const coverage = measured.state === "verified" && extraJson === null ? "complete" : "partial";
  const framed = measured.input + extraTokens + RESERVATION_FRAMING_TOKENS_PER_MESSAGE * Math.max(1, request.messages.length);
  if (framed <= conservative.input) return { total: conservativeTotal, basis: "conservative_chars", state: "heuristic", coverage, reason: measured.reason, source: "uptokey:conservative-chars4", ...provenance };
  const hasEstimatedMedia = (measured.breakdown?.mediaCounted ?? 0) > 0;
  const basis = measured.basis === "model_tokenizer" && extraByTokenizer && !hasEstimatedMedia ? "model_tokenizer" : "catalog_estimate";
  // A raw encoding of extra JSON covers its text, not the provider's undocumented template.
  const state = coverage === "partial" ? "partial" : measured.state;
  return { total: framed + conservative.output, basis, state, coverage, reason: measured.reason, source: measured.source, ...provenance };
}

/* ------------------- coherent attempt accounting (one source for consumers) */

/**
 * Audit of the wire envelope actually handed to the adapter for one attempt.
 * `transformed` is true only when the adapter declares an envelope distinct
 * from the OpenAI-shaped request (e.g. Anthropic Messages); the raw envelope is
 * then recounted with the SAME model tokenizer resolved for the selected model
 * and only ever raises the reservation floor — a provider's count is never
 * reused for another provider's model.
 */
export interface AttemptWireAccounting {
  readonly transformed: boolean;
  /** Raw envelope tokens with the selected model tokenizer (chars/4 for heuristic families); null when no wire measurement ran. */
  readonly envelopeTokens: number | null;
  readonly envelopeBasis: TokenMeasurement["basis"] | null;
  readonly envelopeCoverage: "complete" | "partial";
}

/**
 * Single accounting record for one dispatch attempt: the reservation used for
 * quota plus the coverage, reason, tokenizer, catalog version and artifact
 * profile identity that produced it. Context fit, routing, gateway and
 * governance consume this same shape (via `planAttemptAccounting` /
 * `reservationTokenEstimate`) so no consumer keeps a private estimator.
 */
export interface AttemptAccounting {
  readonly reservation: ReservationEstimate;
  readonly coverage: "complete" | "partial";
  readonly reason: string | null;
  readonly tokenizerId: string | null;
  readonly catalogVersion: string | null;
  readonly catalogState: TokenizerStatus | null;
  /** v2 effective-material profile digest for verified tokenizer families; null otherwise. */
  readonly artifactProfileDigest: string | null;
  readonly wire: AttemptWireAccounting;
}

const bytesOf = (text: string): number => new TextEncoder().encode(text).length;

/**
 * Plans the coherent accounting for one attempt. `wireEnvelope` is the exact
 * JSON body the adapter is about to send (omit it for non-transforming
 * adapters). Deterministic and side-effect free: callers reserve
 * `reservation.total`. The reservation never decreases and its label never
 * improves because of a larger value.
 */
export function planAttemptAccounting(
  request: ChatCompletionRequest,
  conservative: TokenEstimate,
  wireEnvelope?: unknown,
): AttemptAccounting {
  const reservation = reservationTokenEstimate(request, conservative);
  const entry = resolveTokenizerEntry(typeof request.model === "string" ? request.model : "");
  let artifactProfileDigest: string | null = null;
  if (entry.status === "verified" && entry.encoding) {
    try { artifactProfileDigest = tokenizerArtifactProfile(entry.encoding, entry.tokenizerName, entry.version).profileDigest; }
    catch { artifactProfileDigest = null; }
  }
  let wire: AttemptWireAccounting = { transformed: false, envelopeTokens: null, envelopeBasis: null, envelopeCoverage: reservation.coverage };
  if (wireEnvelope !== undefined && wireEnvelope !== request) {
    let serialized: string | undefined;
    try { serialized = JSON.stringify(wireEnvelope); } catch { serialized = undefined; }
    if (serialized !== undefined && serialized.length > 0 && bytesOf(serialized) <= TOKEN_LIMITS.maxSerializedRequestBytes) {
      let envelope: ReturnType<typeof measureEmbeddingTokens>;
      try { envelope = measureEmbeddingTokens(typeof request.model === "string" ? request.model : "", serialized, { verify: "off" }); } catch { envelope = undefined; }
      const envelopeTokens = envelope?.input ?? Math.ceil(serialized.length / 4);
      const envelopeBasis = envelope?.basis ?? null;
      const wireTotal = envelopeTokens + conservative.output;
      if (wireTotal > reservation.total) {
        // The transformed envelope is the actual provider payload: raise the floor with its
        // raw count under the selected model tokenizer. The reservation label is never
        // promoted (wire templates are undocumented → state/coverage partial), so the
        // precision loss from switching envelopes is visible instead of relabeled.
        return {
          reservation: { ...reservation, total: wireTotal, state: "partial", coverage: "partial" },
          coverage: "partial",
          reason: reservation.reason,
          tokenizerId: reservation.tokenizerId ?? envelope?.tokenizerId ?? null,
          catalogVersion: reservation.catalogVersion,
          catalogState: reservation.catalogState,
          artifactProfileDigest,
          wire: { transformed: true, envelopeTokens, envelopeBasis, envelopeCoverage: "partial" },
        };
      }
      wire = { transformed: true, envelopeTokens, envelopeBasis, envelopeCoverage: "partial" };
    } else {
      wire = { transformed: true, envelopeTokens: null, envelopeBasis: null, envelopeCoverage: "partial" };
    }
  }
  return {
    reservation,
    coverage: reservation.coverage,
    reason: reservation.reason,
    tokenizerId: reservation.tokenizerId,
    catalogVersion: reservation.catalogVersion,
    catalogState: reservation.catalogState,
    artifactProfileDigest,
    wire,
  };
}

/* --------------------------- reservation settlement (pure, no billing) */

export type ReservationSettlementStatus =
  | "reconciled"
  | "no-usage"
  | "duplicate"
  | "cancelled-unknown"
  | "interrupted-unknown";

/**
 * Provider-reported observation for one reservation key. Categories keep each
 * provider's semantics (prompt/completion, input/output, cache, reasoning) and
 * are never summed across overlapping meanings here.
 */
export interface ReportedObservation {
  readonly key: string;
  readonly outcome: "complete" | "interrupted" | "cancelled";
  readonly reportedInput: number | null;
  readonly reportedOutput: number | null;
  readonly cachedInput?: number | null;
  readonly reasoningOutput?: number | null;
}

export interface ReservationSettlement {
  readonly key: string;
  readonly status: ReservationSettlementStatus;
  /** Reserved total carried for audit; never presented as billed consumption. */
  readonly reservedTotal: number;
  readonly reportedInput: number | null;
  readonly reportedOutput: number | null;
  readonly cachedInput: number | null;
  readonly reasoningOutput: number | null;
  /** Reconciled consumption: reported values only, null whenever unknown. */
  readonly reconciledInput: number | null;
  readonly reconciledOutput: number | null;
  readonly note: string;
}

/**
 * Structural membership test for previously settled keys. Respects the
 * `ReadonlySet` contract (`has`) for local, cross-realm and structural
 * implementations without relying on `instanceof Set` (realm-bound), and
 * accepts a plain/readonly array through `Array.isArray` (also realm-safe).
 * Unknown shapes are treated as an empty history, never as a duplicate.
 */
function seenKeysContain(seenKeys: ReadonlySet<string> | readonly string[] | undefined, key: string): boolean {
  if (!seenKeys) return false;
  if (typeof (seenKeys as { readonly has?: unknown }).has === 'function') {
    return (seenKeys as ReadonlySet<string>).has(key);
  }
  return Array.isArray(seenKeys) ? seenKeys.includes(key) : false;
}

/**
 * Settles one quota reservation against one provider observation without
 * touching the ledger, money or billing. Pure and idempotent with the caller:
 * pass previously settled keys via `seenKeys` (a `ReadonlySet` — local,
 * cross-realm or structural — or an array) and the same observation can never
 * settle twice. Absence of usage is never zero and cancellation never proves
 * zero provider-side consumption — both settle to null reconciled values with
 * an explicit status instead of an invented quantity.
 */
export function settleReservationEstimate(
  reservation: Pick<ReservationEstimate, "total">,
  observation: ReportedObservation | null,
  seenKeys?: ReadonlySet<string> | readonly string[],
): ReservationSettlement {
  const reservedTotal = reservation.total;
  if (observation === null) {
    return {
      key: "", status: "no-usage", reservedTotal,
      reportedInput: null, reportedOutput: null, cachedInput: null, reasoningOutput: null,
      reconciledInput: null, reconciledOutput: null,
      note: "absence-of-usage-is-not-zero: no provider observation; nothing billable inferred",
    };
  }
  const seen = seenKeysContain(seenKeys, observation.key);
  // Every echoed count is validated: an invalid provider value (negative, fractional,
  // unsafe, or a sub-category exceeding its parent) becomes null, never a settled number.
  const validCount = (value: number | null | undefined): value is number =>
    typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  const input = validCount(observation.reportedInput) ? observation.reportedInput : null;
  const output = validCount(observation.reportedOutput) ? observation.reportedOutput : null;
  const cached = validCount(observation.cachedInput) && (input === null || observation.cachedInput <= input) ? observation.cachedInput : null;
  const reasoning = validCount(observation.reasoningOutput) && (output === null || observation.reasoningOutput <= output) ? observation.reasoningOutput : null;
  const base = {
    key: observation.key, reservedTotal,
    reportedInput: input, reportedOutput: output,
    cachedInput: cached, reasoningOutput: reasoning,
  };
  if (typeof observation.key !== "string" || observation.key.length === 0) {
    return { ...base, key: "", status: "no-usage", reconciledInput: null, reconciledOutput: null, note: "invalid-observation-ignored: empty key" };
  }
  if (seen) {
    return { ...base, status: "duplicate", reconciledInput: null, reconciledOutput: null, note: "duplicate-observation: already settled; not applied twice" };
  }
  if (observation.outcome === "cancelled") {
    return { ...base, status: "cancelled-unknown", reconciledInput: null, reconciledOutput: null, note: "cancelled: provider-side consumption unproven; reconciled stays null" };
  }
  if (observation.outcome === "interrupted") {
    if (input !== null && output !== null) {
      return { ...base, status: "reconciled", reconciledInput: input, reconciledOutput: output, note: "interrupted-with-partial-usage: reported values only" };
    }
    return { ...base, status: "interrupted-unknown", reconciledInput: null, reconciledOutput: null, note: "interrupted-without-usage: reconciled stays null" };
  }
  if (input === null || output === null) {
    return { ...base, status: "no-usage", reconciledInput: null, reconciledOutput: null, note: "complete-without-parseable-usage: reconciled stays null" };
  }
  return { ...base, status: "reconciled", reconciledInput: input, reconciledOutput: output, note: "reconciled-to-provider-reported; reservation kept for audit" };
}
