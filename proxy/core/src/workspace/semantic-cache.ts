/**
 * Stage 10 optional semantic cache (opt-in, default disabled).
 *
 * Only for declared reusable reads without effects, in the same
 * principal/project/policy, temporal source and compatible model version.
 * A similarity score only PROPOSES a candidate; deterministic predicates over
 * entities, dates, units, rights and freshness decide eligibility. Distance
 * alone never proves equivalence. Thresholds are calibrated per task over
 * labeled positive/negative examples; there is no universal default.
 *
 * No hit ever reuses an authorization, a write result or a job state.
 * No Redis/Qdrant is installed: like the provenance cache this is a volatile
 * in-memory index; the journal/store remain the durable source. A vector or
 * model-backed scorer (including a future TypeSafe-backed proposer) can be
 * injected, but deterministic predicates still decide, and no inference is
 * performed without explicit operator configuration.
 */

export type SemanticStatus = "disabled" | "ineligible" | "miss" | "expired" | "revoked" | "rejected" | "hit";
export type SemanticRejectReason =
  | "entities_differ" | "dates_differ" | "units_differ" | "rights_differ"
  | "freshness_exceeded" | "threshold_unmet" | "effect_not_reusable";

export type SemanticLookup =
  | { status: "hit"; ageMs: number; text: string; score: number; resultRef?:string }
  | { status: "rejected"; reason: SemanticRejectReason; score: number | null }
  | { status: "disabled" | "ineligible" | "miss" | "expired" | "revoked"; score?: undefined };

export interface SemanticCachePolicy {
  /** Explicit operator opt-in; false keeps the integral path without measurement. */
  readonly enabled: boolean;
  /** Calibrated per task over labeled examples; (0,1]. No universal default is assumed. */
  readonly minSimilarity: number;
  /** A candidate older than this relative to the query temporal source is refused. */
  readonly freshnessMs: number;
  readonly ttlMs: number;
  readonly maxEntries: number;
}

export interface SemanticContext {
  readonly principalId: string;
  readonly projectId: string;
  readonly operationId: string;
  readonly schemaDigest: string;
  readonly configRevision: string;
  readonly authContext: string;
  /** Temporal source of the query (e.g. market date); null when atemporal. */
  readonly temporalSource: string | null;
  readonly modelFamily: string;
  readonly modelVersionCompat: string;
  /** Only "reusable_read" is eligible; writes, jobs and approvals are ineligible. */
  readonly effect: "reusable_read" | "other";
}

export interface SemanticEntry extends SemanticContext {
  /** Opaque reference into a separate provenance-checked result store; never an approval. */
  readonly resultRef?:string;
  readonly normalizedText: string;
  readonly storedAt: number;
  readonly expiresAt: number;
  readonly revoked: boolean;
}

/** Similarity proposer. Default (absent) behaves as normalized-exact: 1 or null. */
export type SimilarityScorer = (queryNormalized: string, candidateNormalized: string) => number | null;

interface StoredEntry extends SemanticEntry {
  readonly signature: string;
}

const DATE = /\b\d{4}-\d{2}-\d{2}\b|\b\d{2}\/\d{2}\/\d{4}\b/g;
const NUMBER_UNIT = /\d[\d.,]*\s*(%|°[CF]?|[a-zA-Z]{1,6}\b|\$|€|£|¥|USD|BRL|EUR)/g;
const CURRENCY_AMOUNT = /(?:USD|BRL|EUR|R\$|\$|€|£|¥)\s*\d[\d.,]*/gi;
/** Glue words are not units: "5 is" or "120.00 for" must not become unit tokens. */
const UNIT_STOP_WORDS = new Set(["is", "in", "on", "at", "of", "for", "to", "a", "an", "the", "and", "or",
  "de", "da", "do", "das", "dos", "em", "no", "na", "nos", "nas", "por", "com", "conta", "e", "ou"]);
const ACCOUNT = /\b(?:conta|account|acct)[\s:]*[A-Za-z0-9.-]{4,}\b|\b[A-Z]{2}\d{2}[A-Z0-9]{11,30}\b/gi;
const PERSON_HINT = /"[^"]{2,60}"|\b[A-ZÀ-Ú][a-zà-ú]+ [A-ZÀ-Ú][a-zà-ú]+(?: [A-ZÀ-Ú][a-zà-ú]+)?\b/g;
const NEGATION = /n[ãa]o|nunca|jamais|never\b|not\b|n't\b|without\b/i;

export function normalizeSemanticText(text: string): string {
  return text.normalize("NFC").replace(/\s+/g, " ").trim().toLowerCase();
}

function extractUnits(normalized: string): string[] {
  const found = new Set<string>();
  const pattern = new RegExp(NUMBER_UNIT.source, "g");
  for (const match of normalized.matchAll(pattern)) {
    const unit = (match[1] ?? "").toLowerCase();
    if (/^[a-z]+$/.test(unit) && UNIT_STOP_WORDS.has(unit)) continue;
    found.add(match[0]);
  }
  return [...found].sort();
}

function signatureOf(normalized: string): string {
  const sorted = (matches: RegExpMatchArray | null): string[] => [...new Set(matches ?? [])].sort();
  const dates = sorted(normalized.match(new RegExp(DATE.source, "gi")));
  const units = extractUnits(normalized);
  const amounts = sorted(normalized.match(new RegExp(CURRENCY_AMOUNT.source, "gi")));
  const accounts = sorted(normalized.match(new RegExp(ACCOUNT.source, "gi")));
  const persons = sorted(normalized.match(PERSON_HINT));
  const negated = NEGATION.test(normalized) ? ["negated"] : [];
  return JSON.stringify({ dates, units, amounts, accounts, persons, negated });
}

function rightsEqual(a: SemanticContext, b: SemanticContext): boolean {
  return a.principalId === b.principalId && a.projectId === b.projectId &&
    a.operationId === b.operationId && a.schemaDigest === b.schemaDigest &&
    a.configRevision === b.configRevision && a.authContext === b.authContext &&
    a.modelFamily === b.modelFamily && a.modelVersionCompat === b.modelVersionCompat;
}

/** Rollback flag for stage 10: default off (integral path); "on" enables the opt-in policy. */
export function semanticCacheEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.UPTOKEY_SEMANTIC_CACHE?.trim().toLowerCase() === "on";
}

export class SemanticCache {
  private readonly entries = new Map<string, StoredEntry>();
  private readonly lookups: Record<SemanticStatus, number> = { disabled: 0, ineligible: 0, miss: 0, expired: 0, revoked: 0, rejected: 0, hit: 0 };
  private sequence = 0;

  /** Metadata-only counters for stage 06 presentation; never a routing decision. */
  metrics(): { lookups: Readonly<Record<SemanticStatus, number>>; size: number } {
    return Object.freeze({ lookups: Object.freeze({ ...this.lookups }), size: this.entries.size });
  }

  private count(status: SemanticStatus): void {
    if (this.lookups[status] < Number.MAX_SAFE_INTEGER) this.lookups[status] += 1;
  }

  put(context: SemanticContext, text: string, now = Date.now(), ttlMs = 300_000, maxEntries = 512,resultRef?:string): void {
    if (context.effect !== "reusable_read" || typeof text !== "string" || !text.trim() || !Number.isFinite(now) ||
        !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || ttlMs > 86_400_000 ||
        !Number.isSafeInteger(maxEntries) || maxEntries <= 0 || maxEntries > 4096) {
      throw new Error("semantic_cache_entry_invalid");
    }
    const normalized = normalizeSemanticText(text);
    const key = `entry-${this.sequence += 1}`;
    this.entries.set(key, { ...context, ...(resultRef?{resultRef}:{}),normalizedText: normalized, signature: signatureOf(normalized), storedAt: now, expiresAt: now + ttlMs, revoked: false });
    while (this.entries.size > maxEntries) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  revokeAll(): void {
    for (const [key, entry] of this.entries) this.entries.set(key, { ...entry, revoked: true });
  }

  lookup(
    queryText: string,
    context: SemanticContext,
    policy: SemanticCachePolicy,
    now = Date.now(),
    scorer?: SimilarityScorer,
  ): SemanticLookup {
    const result = this.evaluate(queryText, context, policy, now, scorer);
    this.count(result.status);
    return result;
  }

  private evaluate(
    queryText: string,
    context: SemanticContext,
    policy: SemanticCachePolicy,
    now: number,
    scorer?: SimilarityScorer,
  ): SemanticLookup {
    if (!policy.enabled) return { status: "disabled" };
    if (context.effect !== "reusable_read") return { status: "ineligible" };
    if (!Number.isFinite(now) || !Number.isSafeInteger(policy.ttlMs) || !Number.isSafeInteger(policy.freshnessMs) ||
        !(policy.minSimilarity > 0) || !(policy.minSimilarity <= 1) || !Number.isSafeInteger(policy.maxEntries) ||
        policy.ttlMs <= 0 || policy.freshnessMs <= 0 || policy.maxEntries <= 0) {
      return { status: "ineligible" };
    }
    if (typeof queryText !== "string" || !queryText.trim()) return { status: "ineligible" };
    const normalized = normalizeSemanticText(queryText);
    const signature = signatureOf(normalized);
    let best: { entry: StoredEntry; score: number } | undefined;
    for (const entry of this.entries.values()) {
      if (now >= entry.expiresAt) continue;
      if (entry.revoked) continue;
      if (!rightsEqual(context, entry)) continue;
      if (!temporalCompatible(context.temporalSource, entry.temporalSource, policy.freshnessMs, now)) continue;
      const score = scorer ? scorer(normalized, entry.normalizedText) : (entry.normalizedText === normalized ? 1 : null);
      if (score === null || !(score >= 0) || !(score <= 1)) continue;
      if (score >= policy.minSimilarity && (!best || score > best.score)) best = { entry, score };
    }
    if (!best) {
      // Distinguish absence from refusal within the same rights scope:
      // revocation and TTL beat any similarity score; a below-threshold or
      // entity-differing candidate is a rejection, not a silent miss.
      for (const entry of this.entries.values()) {
        if (!rightsEqual(context, entry)) continue;
        if (now >= entry.expiresAt) return { status: "expired" };
        if (entry.revoked) return { status: "revoked" };
      }
      const near = this.nearestRefusal(normalized, signature, context, policy, now, scorer);
      return near ?? { status: "miss" };
    }
    // Revocation/TTL already beat the score above; entities decide now.
    const refusal = refuseOnEntities(signature, best.entry.signature);
    if (refusal) return { status: "rejected", reason: refusal, score: best.score };
    return { status: "hit", ageMs: Math.max(0, now - best.entry.storedAt), text: best.entry.normalizedText, score: best.score,...(best.entry.resultRef?{resultRef:best.entry.resultRef}:{}) };
  }

  private nearestRefusal(
    normalized: string, signature: string, context: SemanticContext,
    policy: SemanticCachePolicy, now: number, scorer?: SimilarityScorer,
  ): SemanticLookup | undefined {
    for (const entry of this.entries.values()) {
      if (now >= entry.expiresAt || entry.revoked || !rightsEqual(context, entry)) continue;
      if (!temporalCompatible(context.temporalSource, entry.temporalSource, policy.freshnessMs, now)) {
        return { status: "rejected", reason: "freshness_exceeded", score: null };
      }
      const score = scorer ? scorer(normalized, entry.normalizedText) : (entry.normalizedText === normalized ? 1 : null);
      if (score !== null && score < policy.minSimilarity) return { status: "rejected", reason: "threshold_unmet", score };
      const refusal = refuseOnEntities(signature, entry.signature);
      if (refusal) return { status: "rejected", reason: refusal, score };
    }
    return undefined;
  }
}

function temporalCompatible(query: string | null, candidate: string | null, freshnessMs: number, now: number): boolean {
  if (query === null && candidate === null) return true;
  if (query === null || candidate === null) return false;
  if (query !== candidate) return false;
  const at = Date.parse(query);
  return Number.isFinite(at) && now - at <= freshnessMs;
}

function refuseOnEntities(querySignature: string, candidateSignature: string): SemanticRejectReason | undefined {
  if (querySignature === candidateSignature) return undefined;
  const query = JSON.parse(querySignature) as Record<string, string[]>;
  const candidate = JSON.parse(candidateSignature) as Record<string, string[]>;
  // Deterministic priority: dates, then identity-bearing entities, then measurements.
  if (JSON.stringify(query.dates) !== JSON.stringify(candidate.dates)) return "dates_differ";
  if (JSON.stringify(query.accounts) !== JSON.stringify(candidate.accounts) ||
      JSON.stringify(query.persons) !== JSON.stringify(candidate.persons) ||
      JSON.stringify(query.negated) !== JSON.stringify(candidate.negated)) return "entities_differ";
  if (JSON.stringify(query.units) !== JSON.stringify(candidate.units) ||
      JSON.stringify(query.amounts) !== JSON.stringify(candidate.amounts)) return "units_differ";
  return "entities_differ";
}
