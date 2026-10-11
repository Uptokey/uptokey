/** Local health tracking from observed dispatches — never invents upstream availability. */

export type HealthState = "healthy" | "degraded" | "unhealthy" | "not_checked";

export interface HealthSnapshot {
  state: HealthState;
  consecutiveFailures: number;
  consecutiveSuccesses: number;
  lastFailureAt: number | null;
  lastSuccessAt: number | null;
  /** When unhealthy, skip until this time (ms since epoch via now()). */
  skipUntil: number;
}

interface HealthEntry extends HealthSnapshot {}

export class ProviderHealthTracker {
  private readonly entries = new Map<string, HealthEntry>();
  private readonly now: () => number;
  private readonly unhealthyAfter: number;
  private readonly recoverAfter: number;
  private readonly skipMs: number;

  constructor(now: () => number = () => Date.now(), options?: { unhealthyAfter?: number; recoverAfter?: number; skipMs?: number }) {
    this.now = now;
    this.unhealthyAfter = options?.unhealthyAfter ?? 3;
    this.recoverAfter = options?.recoverAfter ?? 1;
    this.skipMs = options?.skipMs ?? 30_000;
  }

  get(connectionId: string): HealthSnapshot {
    const entry = this.entries.get(connectionId);
    if (!entry) {
      return { state: "not_checked", consecutiveFailures: 0, consecutiveSuccesses: 0, lastFailureAt: null, lastSuccessAt: null, skipUntil: 0 };
    }
    if (entry.state === "unhealthy" && this.now() >= entry.skipUntil) {
      // Allow a probe: surface as degraded so callers can deprioritize but not hard-skip forever.
      return { ...entry, state: "degraded", skipUntil: 0 };
    }
    return { ...entry };
  }

  /** Unhealthy providers should be skipped until skipUntil; degraded may be deprioritized. */
  shouldSkip(connectionId: string): boolean {
    const snap = this.get(connectionId);
    return snap.state === "unhealthy" && this.now() < snap.skipUntil;
  }

  recordSuccess(connectionId: string, at?: number): void {
    const ts = at ?? this.now();
    const prev = this.entries.get(connectionId);
    const consecutiveSuccesses = (prev?.consecutiveSuccesses ?? 0) + 1;
    const recovered = consecutiveSuccesses >= this.recoverAfter;
    this.entries.set(connectionId, {
      state: recovered ? "healthy" : (prev?.state === "unhealthy" || prev?.state === "degraded" ? "degraded" : "healthy"),
      consecutiveFailures: 0,
      consecutiveSuccesses,
      lastFailureAt: prev?.lastFailureAt ?? null,
      lastSuccessAt: ts,
      skipUntil: 0,
    });
  }

  recordFailure(connectionId: string, at?: number): void {
    const ts = at ?? this.now();
    const prev = this.entries.get(connectionId);
    const consecutiveFailures = (prev?.consecutiveFailures ?? 0) + 1;
    const unhealthy = consecutiveFailures >= this.unhealthyAfter;
    this.entries.set(connectionId, {
      state: unhealthy ? "unhealthy" : "degraded",
      consecutiveFailures,
      consecutiveSuccesses: 0,
      lastFailureAt: ts,
      lastSuccessAt: prev?.lastSuccessAt ?? null,
      skipUntil: unhealthy ? ts + this.skipMs : 0,
    });
  }

  clear(connectionId: string): void {
    this.entries.delete(connectionId);
  }
}
