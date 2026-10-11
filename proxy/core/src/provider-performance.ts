/**
 * Per-provider latency and throughput tracker.
 * Records observed dispatch latency (TTFT and total) and tokens-per-second
 * for use by latency/throughput/quality routing modes.
 * Uses EWMA (exponentially weighted moving average) for recency-sensitive smoothing.
 */

import type { ProviderName } from "./types.ts";

export interface ProviderPerformanceSnapshot {
  provider: ProviderName;
  sampleCount: number;
  ttftMsEwma: number | null;
  totalLatencyMsEwma: number | null;
  tokensPerSecondEwma: number | null;
  successRate: number | null;
  lastSampleAt: number | null;
}

const MAX_SAMPLES = 64;
const EWMA_ALPHA = 0.3;

interface PerformanceEntry {
  ttftMsEwma: number | null;
  totalLatencyMsEwma: number | null;
  tokensPerSecondEwma: number | null;
  successes: number;
  failures: number;
  sampleCount: number;
  lastSampleAt: number;
}

export class ProviderPerformanceTracker {
  private readonly entries = new Map<ProviderName, PerformanceEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /**
   * Record a completed dispatch with observed latency and throughput.
   * ttftMs: time to first token (or first byte) in milliseconds.
   * totalLatencyMs: total dispatch duration in milliseconds.
   * outputTokens: tokens generated (if known) for throughput calculation.
   */
  recordSuccess(provider: ProviderName, ttftMs: number | null, totalLatencyMs: number | null, outputTokens: number | null): void {
    const entry = this.entries.get(provider) ?? {
      ttftMsEwma: null,
      totalLatencyMsEwma: null,
      tokensPerSecondEwma: null,
      successes: 0,
      failures: 0,
      sampleCount: 0,
      lastSampleAt: 0,
    };
    entry.successes += 1;
    entry.sampleCount = Math.min(MAX_SAMPLES, entry.sampleCount + 1);
    entry.lastSampleAt = this.now();

    if (ttftMs !== null && Number.isFinite(ttftMs) && ttftMs >= 0) {
      entry.ttftMsEwma = entry.ttftMsEwma === null ? ttftMs : EWMA_ALPHA * ttftMs + (1 - EWMA_ALPHA) * entry.ttftMsEwma;
    }
    if (totalLatencyMs !== null && Number.isFinite(totalLatencyMs) && totalLatencyMs > 0) {
      entry.totalLatencyMsEwma = entry.totalLatencyMsEwma === null ? totalLatencyMs : EWMA_ALPHA * totalLatencyMs + (1 - EWMA_ALPHA) * entry.totalLatencyMsEwma;
      if (outputTokens !== null && Number.isSafeInteger(outputTokens) && outputTokens > 0) {
        const tps = outputTokens / (totalLatencyMs / 1000);
        entry.tokensPerSecondEwma = entry.tokensPerSecondEwma === null ? tps : EWMA_ALPHA * tps + (1 - EWMA_ALPHA) * entry.tokensPerSecondEwma;
      }
    }
    this.entries.set(provider, entry);
  }

  recordFailure(provider: ProviderName): void {
    const entry = this.entries.get(provider) ?? {
      ttftMsEwma: null,
      totalLatencyMsEwma: null,
      tokensPerSecondEwma: null,
      successes: 0,
      failures: 0,
      sampleCount: 0,
      lastSampleAt: 0,
    };
    entry.failures += 1;
    this.entries.set(provider, entry);
  }

  get(provider: ProviderName): ProviderPerformanceSnapshot {
    const entry = this.entries.get(provider);
    if (!entry) {
      return { provider, sampleCount: 0, ttftMsEwma: null, totalLatencyMsEwma: null, tokensPerSecondEwma: null, successRate: null, lastSampleAt: null };
    }
    const total = entry.successes + entry.failures;
    return {
      provider,
      sampleCount: entry.sampleCount,
      ttftMsEwma: entry.ttftMsEwma,
      totalLatencyMsEwma: entry.totalLatencyMsEwma,
      tokensPerSecondEwma: entry.tokensPerSecondEwma,
      successRate: total > 0 ? entry.successes / total : null,
      lastSampleAt: entry.lastSampleAt || null,
    };
  }

  hasSufficientSamples(provider: ProviderName, minSamples: number): boolean {
    return (this.entries.get(provider)?.sampleCount ?? 0) >= minSamples;
  }

  clear(provider?: ProviderName): void {
    if (provider) this.entries.delete(provider);
    else this.entries.clear();
  }

  snapshot(): ProviderPerformanceSnapshot[] {
    return [...this.entries.keys()].map((p) => this.get(p));
  }
}
