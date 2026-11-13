/** Process-local, bounded observations. Never transfers evidence between models. */
import type { ProviderName } from "./types.ts";

export interface ProviderPerformanceSnapshot {
  provider: ProviderName;
  model: string;
  sampleCount: number;
  ttftSampleCount: number;
  latencySampleCount: number;
  throughputSampleCount: number;
  ttftMsEwma: number | null;
  totalLatencyMsEwma: number | null;
  tokensPerSecondEwma: number | null;
  successRate: number | null;
  lastSampleAt: number | null;
}

export const DEFAULT_PERFORMANCE_WINDOW_MS = 60_000;
// Config accepts latency.minSamples through 100, globally and per combo.
const MAX_SAMPLES = 100;
const MAX_DESTINATIONS = 512;
const EWMA_ALPHA = 0.3;
type Sample = { at: number; success: boolean; ttft: number | null; latency: number | null; throughput: number | null };
type Entry = { provider: ProviderName; model: string; samples: Sample[] };
const ewma = (previous: number | null, value: number) => previous === null ? value : EWMA_ALPHA * value + (1 - EWMA_ALPHA) * previous;

export class ProviderPerformanceTracker {
  private readonly entries = new Map<string, Entry>();
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }

  /** Called only after a consumed response completes; unknown values remain null. */
  recordSuccess(provider: ProviderName, model: string, ttftMs: number | null, totalLatencyMs: number | null, outputTokens: number | null): void {
    const latency = totalLatencyMs !== null && Number.isFinite(totalLatencyMs) && totalLatencyMs > 0 ? totalLatencyMs : null;
    this.record(provider, model, {
      at: this.now(), success: true,
      ttft: ttftMs !== null && Number.isFinite(ttftMs) && ttftMs >= 0 ? ttftMs : null,
      latency,
      throughput: latency !== null && outputTokens !== null && Number.isSafeInteger(outputTokens) && outputTokens > 0 ? outputTokens / (latency / 1000) : null,
    });
  }

  recordFailure(provider: ProviderName, model: string, at = this.now()): void {
    this.record(provider, model, { at, success: false, ttft: null, latency: null, throughput: null });
  }

  private record(provider: ProviderName, model: string, sample: Sample): void {
    const key = JSON.stringify([provider, model]);
    const entry = this.entries.get(key) ?? { provider, model, samples: [] };
    entry.samples.push(sample);
    if (entry.samples.length > MAX_SAMPLES) entry.samples.shift();
    this.entries.delete(key);
    this.entries.set(key, entry);
    if (this.entries.size > MAX_DESTINATIONS) this.entries.delete(this.entries.keys().next().value!);
  }

  get(provider: ProviderName, model: string, windowMs = DEFAULT_PERFORMANCE_WINDOW_MS): ProviderPerformanceSnapshot {
    const result: ProviderPerformanceSnapshot = { provider, model, sampleCount: 0, ttftSampleCount: 0, latencySampleCount: 0, throughputSampleCount: 0, ttftMsEwma: null, totalLatencyMsEwma: null, tokensPerSecondEwma: null, successRate: null, lastSampleAt: null };
    const now = this.now();
    const samples = (this.entries.get(JSON.stringify([provider, model]))?.samples ?? [])
      .filter(sample => Number.isFinite(windowMs) && windowMs > 0 && now >= sample.at && now - sample.at < windowMs);
    for (const sample of samples) {
      result.lastSampleAt = sample.at;
      if (!sample.success) continue;
      result.sampleCount++;
      if (sample.ttft !== null) { result.ttftSampleCount++; result.ttftMsEwma = ewma(result.ttftMsEwma, sample.ttft); }
      if (sample.latency !== null) { result.latencySampleCount++; result.totalLatencyMsEwma = ewma(result.totalLatencyMsEwma, sample.latency); }
      if (sample.throughput !== null) { result.throughputSampleCount++; result.tokensPerSecondEwma = ewma(result.tokensPerSecondEwma, sample.throughput); }
    }
    result.successRate = samples.length > 0 ? result.sampleCount / samples.length : null;
    return result;
  }

  hasSufficientSamples(provider: ProviderName, model: string, minSamples: number, windowMs = DEFAULT_PERFORMANCE_WINDOW_MS): boolean {
    return this.get(provider, model, windowMs).sampleCount >= minSamples;
  }

  clear(provider?: ProviderName): void {
    if (!provider) this.entries.clear();
    else for (const [key, entry] of this.entries) if (entry.provider === provider) this.entries.delete(key);
  }

  snapshot(): ProviderPerformanceSnapshot[] {
    return [...this.entries.values()].map(entry => this.get(entry.provider, entry.model));
  }
}
