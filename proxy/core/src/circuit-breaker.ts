/** Per-connection circuit breaker: closed → open → half-open → closed. */

export type CircuitState = "closed" | "open" | "half_open";

export interface CircuitBreakerOptions {
  failureThreshold: number;
  cooldownMs: number;
  halfOpenSuccesses?: number;
}

interface BreakerEntry {
  state: CircuitState;
  failures: number;
  openedAt: number;
  halfOpenSuccesses: number;
}

export class CircuitBreakerRegistry {
  private readonly breakers = new Map<string, BreakerEntry>();
  private readonly now: () => number;

  constructor(now: () => number = () => Date.now()) {
    this.now = now;
  }

  /** Stable key: provider id + optional endpoint. */
  key(connectionId: string, endpoint = ""): string {
    return endpoint ? `${connectionId}@@${endpoint}` : connectionId;
  }

  state(connectionId: string, endpoint = "", options: CircuitBreakerOptions): CircuitState {
    const entry = this.breakers.get(this.key(connectionId, endpoint));
    if (!entry) return "closed";
    if (entry.state === "open") {
      if (this.now() - entry.openedAt >= options.cooldownMs) {
        entry.state = "half_open";
        entry.halfOpenSuccesses = 0;
        return "half_open";
      }
      return "open";
    }
    return entry.state;
  }

  /** True when the connection may receive traffic (closed or half-open probe). */
  allow(connectionId: string, endpoint = "", options: CircuitBreakerOptions): boolean {
    return this.state(connectionId, endpoint, options) !== "open";
  }

  recordSuccess(connectionId: string, endpoint = "", options: CircuitBreakerOptions, at?: number): void {
    const id = this.key(connectionId, endpoint);
    const entry = this.breakers.get(id);
    if (!entry) return;
    if (entry.state === "half_open") {
      entry.halfOpenSuccesses += 1;
      const need = options.halfOpenSuccesses ?? 1;
      if (entry.halfOpenSuccesses >= need) {
        this.breakers.delete(id);
      }
      return;
    }
    entry.failures = 0;
    entry.state = "closed";
  }

  recordFailure(connectionId: string, endpoint = "", options: CircuitBreakerOptions, at?: number): void {
    const ts = at ?? this.now();
    const id = this.key(connectionId, endpoint);
    const entry = this.breakers.get(id) ?? { state: "closed" as CircuitState, failures: 0, openedAt: 0, halfOpenSuccesses: 0 };
    if (entry.state === "half_open") {
      entry.state = "open";
      entry.openedAt = ts;
      entry.failures = options.failureThreshold;
      this.breakers.set(id, entry);
      return;
    }
    entry.failures += 1;
    if (entry.failures >= options.failureThreshold) {
      entry.state = "open";
      entry.openedAt = ts;
    }
    this.breakers.set(id, entry);
  }

  remainingCooldownMs(connectionId: string, endpoint = "", options: CircuitBreakerOptions): number {
    const entry = this.breakers.get(this.key(connectionId, endpoint));
    if (!entry || entry.state !== "open") return 0;
    return Math.max(0, Math.ceil(options.cooldownMs - (this.now() - entry.openedAt)));
  }

  reset(connectionId: string, endpoint = ""): void {
    this.breakers.delete(this.key(connectionId, endpoint));
  }
}
