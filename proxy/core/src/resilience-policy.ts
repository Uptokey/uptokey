import type { ProxyConfig } from "./types.ts";

/** Runtime knobs for automatic fallback / attempt caps / quota warnings. */
export interface ResiliencePolicy {
  autoFallbackEnabled: boolean;
  maxAttemptsPerRequest: number;
  /** 0–1 ratio of local budget use that triggers an early warning (never a hard fail). */
  quotaWarnRatio: number;
  /** Max transient retries on the same provider (408/timeout) before falling back. */
  maxTransientRetries: number;
}

const DEFAULTS: ResiliencePolicy = {
  autoFallbackEnabled: true,
  maxAttemptsPerRequest: 3,
  quotaWarnRatio: 0.85,
  maxTransientRetries: 1,
};

export function resolveResiliencePolicy(config?: ProxyConfig, env: NodeJS.ProcessEnv = process.env): ResiliencePolicy {
  const fromConfig = config?.resilience;
  let autoFallbackEnabled = fromConfig?.autoFallbackEnabled ?? DEFAULTS.autoFallbackEnabled;
  const flag = env.UPTOKEY_AUTO_FALLBACK;
  if (flag === "0" || flag === "false" || flag === "off" || flag === "no") autoFallbackEnabled = false;
  if (flag === "1" || flag === "true" || flag === "on" || flag === "yes") autoFallbackEnabled = true;

  let maxAttemptsPerRequest = fromConfig?.maxAttemptsPerRequest ?? DEFAULTS.maxAttemptsPerRequest;
  const attemptsEnv = env.UPTOKEY_MAX_ATTEMPTS;
  if (attemptsEnv && /^\d+$/.test(attemptsEnv)) {
    const parsed = Number(attemptsEnv);
    if (Number.isSafeInteger(parsed) && parsed >= 1 && parsed <= 32) maxAttemptsPerRequest = parsed;
  }

  let quotaWarnRatio = fromConfig?.quotaWarnRatio ?? DEFAULTS.quotaWarnRatio;
  const warnEnv = env.UPTOKEY_QUOTA_WARN_RATIO;
  if (warnEnv && /^\d(?:\.\d+)?$/.test(warnEnv)) {
    const parsed = Number(warnEnv);
    if (Number.isFinite(parsed) && parsed > 0 && parsed < 1) quotaWarnRatio = parsed;
  }

  let maxTransientRetries = fromConfig?.maxTransientRetries ?? DEFAULTS.maxTransientRetries;
  const retryEnv = env.UPTOKEY_TRANSIENT_RETRIES;
  if (retryEnv && /^\d+$/.test(retryEnv)) {
    const parsed = Number(retryEnv);
    if (Number.isSafeInteger(parsed) && parsed >= 0 && parsed <= 5) maxTransientRetries = parsed;
  }

  return { autoFallbackEnabled, maxAttemptsPerRequest, quotaWarnRatio, maxTransientRetries };
}

export type BalanceBasis = "reported" | "estimated" | "unknown";

/** Map ledger basis to the public reported/estimated/unknown vocabulary. Never invent balances. */
export function balanceBasisFromQuota(basis: string | undefined): BalanceBasis {
  if (basis === "provider_headers_plus_local_ledger") return "reported";
  if (basis === "local_device_estimate") return "estimated";
  return "unknown";
}

export interface AttemptRecord {
  provider: string;
  reason: string;
  action?: string;
  status?: number;
}

export interface ResilienceOutcome {
  provider_used: string | null;
  provider_failed: string | null;
  switch_reason: string | null;
  final_status: "ok" | "partial" | "exhausted" | "fail_fast" | "cancelled" | "disabled_fallback";
  attempts: AttemptRecord[];
  tokens: { basis: BalanceBasis; input?: number; output?: number; total?: number };
  cost: null;
  warnings: string[];
  partial_content: string | null;
}

export function emptyOutcome(overrides: Partial<ResilienceOutcome> = {}): ResilienceOutcome {
  return {
    provider_used: null,
    provider_failed: null,
    switch_reason: null,
    final_status: "exhausted",
    attempts: [],
    tokens: { basis: "unknown" },
    cost: null,
    warnings: [],
    partial_content: null,
    ...overrides,
  };
}
