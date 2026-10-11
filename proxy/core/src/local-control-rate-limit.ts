const MAX_BUCKETS = 256;

interface Bucket { count: number; resetsAt: number }

export class LocalControlRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly now: () => number;
  private lastObserved = 0;
  constructor(now: () => number = performance.now.bind(performance)) { this.now = now; }

  take(key: string, limit: number, windowMs: number): { ok: true } | { ok: false; retryAfter: number } {
    const now = this.now();
    const conservativeRetry = Number.isSafeInteger(windowMs) && windowMs > 0 ? Math.max(1, Math.ceil(windowMs / 1_000)) : 60;
    if (!Number.isFinite(now) || now < 0 || now < this.lastObserved || !Number.isSafeInteger(limit) || limit < 1 || !Number.isSafeInteger(windowMs) || windowMs < 1 || !Number.isFinite(now + windowMs)) return { ok: false, retryAfter: conservativeRetry };
    this.lastObserved = now;
    this.prune(now);
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= MAX_BUCKETS) return { ok: false, retryAfter: conservativeRetry };
      bucket = { count: 0, resetsAt: now + windowMs };
      this.buckets.set(key, bucket);
    }
    if (bucket.count >= limit) return { ok: false, retryAfter: Math.max(1, Math.ceil((bucket.resetsAt - now) / 1_000)) };
    bucket.count += 1;
    return { ok: true };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) if (bucket.resetsAt <= now) this.buckets.delete(key);
  }
}
