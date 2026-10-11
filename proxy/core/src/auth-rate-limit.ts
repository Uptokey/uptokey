export const AUTH_FAILURE_LIMIT = 10;
export const AUTH_FAILURE_WINDOW_MS = 60_000;

export interface AuthRateDecision {
  allowed: boolean;
  retryAfterSeconds?: number;
}

/**
 * Limite global porque o daemon aceita somente loopback: IP de origem seria sempre local e
 * criaria uma falsa separação entre processos. Guarda apenas timestamps de falhas, nunca token.
 */
export class LocalAuthRateLimiter {
  private failures: number[] = [];
  private readonly limit: number;
  private readonly windowMs: number;
  private readonly now: () => number;
  private lastObserved = 0;

  constructor(limit = AUTH_FAILURE_LIMIT, windowMs = AUTH_FAILURE_WINDOW_MS, now: () => number = performance.now.bind(performance)) {
    this.limit = limit;
    this.windowMs = windowMs;
    this.now = now;
  }

  recordFailure(): AuthRateDecision {
    const current = this.now();
    const retryAfterSeconds = Number.isSafeInteger(this.windowMs) && this.windowMs > 0 ? Math.max(1, Math.ceil(this.windowMs / 1_000)) : 60;
    if (!Number.isFinite(current) || current < 0 || current < this.lastObserved || !Number.isSafeInteger(this.limit) || this.limit < 1 || !Number.isSafeInteger(this.windowMs) || this.windowMs < 1 || !Number.isFinite(current + this.windowMs)) return { allowed: false, retryAfterSeconds };
    this.lastObserved = current;
    this.prune(current);
    if (this.failures.length < this.limit + 1) this.failures.push(current);
    if (this.failures.length <= this.limit) return { allowed: true };
    const oldestFailure = this.failures[0] ?? current;
    const retryAfterMs = Math.max(1, oldestFailure + this.windowMs - current);
    return { allowed: false, retryAfterSeconds: Math.ceil(retryAfterMs / 1_000) };
  }

  private prune(current: number): void {
    const cutoff = current - this.windowMs;
    this.failures = this.failures.filter((timestamp) => timestamp > cutoff);
  }
}
