/**
 * Stage 10 efficiency projection. In-memory, metadata-only, bounded; the journal and receipts remain the
 * source of truth for runs and usage. Provider-side prompt caching is reported separately by receipts
 * (`cachedInputTokens`) and is never folded into these Uptokey cache counters.
 */
export type ExactCacheLookupStatus = "hit" | "miss" | "expired" | "corrupt" | "invalidating" | "ineligible";
export type LatencyClass = "exact_cache_hit" | "live_dispatch";

export interface LatencySummary { readonly count: number; readonly p50Ms: number | null; readonly p95Ms: number | null; }
export interface EfficiencyMetrics {
  readonly schemaVersion: 1;
  readonly basis: "process_local_since_start";
  readonly exactCache: {
    readonly enabled: boolean;
    readonly lookups: Readonly<Record<ExactCacheLookupStatus, number>>;
    readonly writes: number;
    readonly lastHitAgeSeconds: number | null;
    /** Uptokey cache hits only; a hit is not a new provider call and carries no new measured charge. */
    readonly providerCallsAvoided: number;
  };
  readonly latency: Readonly<Record<LatencyClass, LatencySummary>>;
}

const SAMPLE_LIMIT = 256;
const STATUSES: readonly ExactCacheLookupStatus[] = ["hit", "miss", "expired", "corrupt", "invalidating", "ineligible"];

export class EfficiencyRecorder {
  private readonly lookups = Object.fromEntries(STATUSES.map((status) => [status, 0])) as Record<ExactCacheLookupStatus, number>;
  private readonly samples: Record<LatencyClass, number[]> = { exact_cache_hit: [], live_dispatch: [] };
  private lastHitAgeMs: number | null = null;

  recordLookup(status: ExactCacheLookupStatus): void {
    if (!STATUSES.includes(status)) return;
    this.lookups[status] = saturatingIncrement(this.lookups[status]);
  }

  recordLatency(kind: LatencyClass, ms: number, hitAgeMs?: number): void {
    if (!Number.isFinite(ms) || ms < 0) return;
    const ring = this.samples[kind];
    ring.push(ms);
    if (ring.length > SAMPLE_LIMIT) ring.shift();
    if (kind === "exact_cache_hit" && hitAgeMs !== undefined && Number.isFinite(hitAgeMs) && hitAgeMs >= 0) this.lastHitAgeMs = hitAgeMs;
  }

  snapshot(enabled: boolean, writes: number): EfficiencyMetrics {
    return {
      schemaVersion: 1,
      basis: "process_local_since_start",
      exactCache: {
        enabled,
        lookups: { ...this.lookups },
        writes: Number.isSafeInteger(writes) && writes >= 0 ? writes : 0,
        lastHitAgeSeconds: this.lastHitAgeMs === null ? null : Math.floor(this.lastHitAgeMs / 1000),
        providerCallsAvoided: this.lookups.hit,
      },
      latency: { exact_cache_hit: summarize(this.samples.exact_cache_hit), live_dispatch: summarize(this.samples.live_dispatch) },
    };
  }
}

function summarize(values: readonly number[]): LatencySummary {
  if (values.length === 0) return { count: 0, p50Ms: null, p95Ms: null };
  const sorted = [...values].sort((a, b) => a - b);
  const at = (q: number) => Math.round(sorted[Math.min(sorted.length - 1, Math.ceil(q * sorted.length) - 1)]! * 10) / 10;
  return { count: values.length, p50Ms: at(0.5), p95Ms: at(0.95) };
}
function saturatingIncrement(value: number): number { return value >= Number.MAX_SAFE_INTEGER ? value : value + 1; }
