import type { ProviderConfig, ProviderName } from "./types.ts";
import type { QuotaStatus } from "./quota-ledger.ts";
import { isLocalExperimentalProvider, isNamedExperimentalProvider, isUserDefinedProvider } from "./provider-registry.ts";
import { geminiPrivacyAccepted } from "./privacy.ts";
import { namedProviderRiskAccepted } from "./provider-risk.ts";
import { balanceBasisFromQuota, type BalanceBasis } from "./resilience-policy.ts";
import type { HealthState } from "./provider-health.ts";
import type { CircuitState } from "./circuit-breaker.ts";

/** A safe configuration/admission projection, not an upstream health or money balance probe. */
export function connectionStatus(id: ProviderName, config: ProviderConfig, options: {
  adapterPresent: boolean; cooldownMs: number; quota?: QuotaStatus; rejection?: { reason: string; retryAfterMs: number | null; sticky?: boolean };
  health?: HealthState; circuit?: CircuitState; quotaWarning?: string | null;
}) {
  const quota = options.quota;
  let reason: string | null = null;
  if (!config.configured) reason = "not_configured";
  else if (!config.enabled) reason = "disabled";
  else if (!options.adapterPresent) reason = "missing_adapter";
  else if (id === "gemini" && !geminiPrivacyAccepted(config.privacyAcceptedAt, config.privacyNoticeVersion)) reason = "privacy_consent_required";
  else if (isNamedExperimentalProvider(id) && !namedProviderRiskAccepted(id, config)) reason = "risk_consent_required";
  else if (options.rejection) reason = options.rejection.reason;
  else if (options.health === "unhealthy") reason = "unhealthy";
  else if (options.circuit === "open") reason = "circuit_open";
  else if (options.cooldownMs > 0) reason = "cooldown";
  else if (quota) {
    if (quota.providerRemaining?.requests === 0 || quota.providerRemaining?.tokens === 0) reason = "provider_rate_limit";
    else if (quota.minute.requestsUsed >= quota.minute.requestsLimit || quota.minute.tokensUsed >= quota.minute.tokensLimit) reason = "local_minute_limit";
    else if ((quota.day.requestsLimit !== undefined && quota.day.requestsUsed >= quota.day.requestsLimit)
      || (quota.day.tokensLimit !== undefined && quota.day.tokensUsed >= quota.day.tokensLimit)) reason = "local_day_limit";
  }
  const balanceBasis: BalanceBasis = balanceBasisFromQuota(quota?.basis);
  const retryAfterMs = options.rejection
    ? options.rejection.retryAfterMs
    : (options.cooldownMs > 0 ? options.cooldownMs : null);
  return {
    id,
    kind: isLocalExperimentalProvider(id) ? "local" : id === "custom" || isUserDefinedProvider(id) ? "custom" : "provider",
    supportLevel: id === "custom" || isUserDefinedProvider(id) ? "custom" : isLocalExperimentalProvider(id) || isNamedExperimentalProvider(id) ? "experimental" : "built_in",
    configured: config.configured, enabled: config.enabled,
    models: [...config.models], defaultModel: config.defaultModel,
    admission: {
      eligible: reason === null,
      reason,
      retryAfterMs,
      ...(options.rejection?.sticky ? { needsCorrection: true as const } : {}),
    },
    health: options.health ?? "not_checked",
    circuit: options.circuit ?? "closed",
    /** Never invent balances — always null unless a future reported source exists. */
    creditBalance: null,
    balanceBasis,
    ...(options.quotaWarning ? { quotaWarning: options.quotaWarning } : {}),
    ...(quota ? { quota, quotaAccounting: {
      scope: "provider_on_this_device" as const,
      counters: "local_admission_reservations" as const,
      tokens: "reserved_estimate" as const,
      limits: "configured_local_budgets" as const,
      persisted: true as const,
    } } : {}),
  };
}

/** Early warning when local budget approaches the configured ratio. Never invents balances. */
export function quotaEarlyWarning(quota: QuotaStatus | undefined, warnRatio: number): string | null {
  if (!quota || !(warnRatio > 0 && warnRatio < 1)) return null;
  const checks: Array<[number, number, string]> = [
    [quota.minute.requestsUsed, quota.minute.requestsLimit, "minute_requests"],
    [quota.minute.tokensUsed, quota.minute.tokensLimit, "minute_tokens"],
  ];
  if (quota.day.requestsLimit !== undefined) checks.push([quota.day.requestsUsed, quota.day.requestsLimit, "day_requests"]);
  if (quota.day.tokensLimit !== undefined) checks.push([quota.day.tokensUsed, quota.day.tokensLimit, "day_tokens"]);
  for (const [used, limit, label] of checks) {
    if (limit > 0 && used / limit >= warnRatio && used < limit) {
      return `approaching_${label}`;
    }
  }
  return null;
}
