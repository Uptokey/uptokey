export type RejectionReason = "provider_auth_rejected" | "provider_credit_exhausted" | "provider_forbidden";

export interface RejectionObservation {
  reason: RejectionReason;
  /** Milliseconds until a temporary block expires; null when sticky (needs user correction). */
  retryAfterMs: number | null;
  /** True when the key/credentials must be fixed before this connection is tried again. */
  sticky: boolean;
}

/** Short-lived evidence from actual requests, not an account balance estimate. */
export class ProviderRejections {
  private observations = new Map<string, { reason: RejectionReason; until: number | null; endpoint: string; sticky: boolean }>();
  private readonly now: () => number;
  private readonly ttlMs: number;
  constructor(now: () => number, ttlMs = 300_000) { this.now = now; this.ttlMs = ttlMs; }

  record(id: string, status: number, endpoint = "") {
    let reason: RejectionReason | undefined;
    if (status === 401) reason = "provider_auth_rejected";
    if (status === 403) reason = "provider_forbidden";
    // DeepSeek documents 402 as insufficient balance. Do not generalize to custom services.
    if (status === 402 && id === "deepseek" && (!endpoint || endpoint === "https://api.deepseek.com/chat/completions")) reason = "provider_credit_exhausted";
    if (!reason) return;
    // Hard auth failures stay invalid until the user reconfigures the key (clear via invalidateProviderCache).
    const sticky = reason === "provider_auth_rejected" || reason === "provider_forbidden";
    this.observations.set(id, {
      reason,
      until: sticky ? null : this.now() + this.ttlMs,
      endpoint,
      sticky,
    });
  }

  get(id: string, endpoint = ""): RejectionObservation | undefined {
    const observation = this.observations.get(id);
    if (!observation) return undefined;
    if (endpoint !== observation.endpoint) { this.clear(id); return undefined; }
    if (observation.sticky || observation.until === null) {
      return { reason: observation.reason, retryAfterMs: null, sticky: true };
    }
    const retryAfterMs = Math.ceil(observation.until - this.now());
    if (retryAfterMs <= 0) { this.clear(id); return undefined; }
    return { reason: observation.reason, retryAfterMs, sticky: false };
  }

  clear(id: string) { this.observations.delete(id); }
}
