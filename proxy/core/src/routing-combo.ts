import type { ChatCompletionRequest, ProviderName, ProxyConfig, RoutingCombo } from "./types.ts";
import { isProvider } from "./provider-registry.ts";
import { isVirtualModel } from "./auto-route.ts";

export interface RoutingCandidate {
  provider: ProviderName;
  model?: string;
  comboId?: string;
  comboRevision?: number;
}

export interface RoutingComboDecision {
  combo?: RoutingCombo;
  candidates: RoutingCandidate[];
  maxAttempts?: number;
  error?: "routing_combo_not_found" | "routing_combo_model_unavailable" | "routing_combo_empty" | "routing_policy_invalid" | "revision_conflict";
}

/**
 * Pure function: resolve combo candidates without side effects.
 * Round-robin rotation is applied using the provided cursor value;
 * the caller (Router) owns cursor advancement atomically.
 */
export function resolveRoutingComboDecision(config: ProxyConfig, request: ChatCompletionRequest, roundRobinCursor?: number): RoutingComboDecision {
  const comboId = typeof request.uptokey_routing_combo === "string" ? request.uptokey_routing_combo : config.activeRoutingComboId;
  if (comboId === undefined) return { candidates: [] };
  const combo = config.routingCombos?.[comboId];
  if (!combo) return { candidates: [], error: "routing_combo_not_found" };

  const requested = typeof request.model === "string" && !isVirtualModel(request.model) ? request.model : undefined;
  const models = modelsForCombo(combo, requested);
  if (models.length === 0) return { combo, candidates: [], maxAttempts: combo.maxAttempts, error: "routing_combo_model_unavailable" };

  const baseCandidates = collectCandidates(combo, models);
  if (baseCandidates.length === 0) return { combo, candidates: [], maxAttempts: combo.maxAttempts, error: "routing_combo_empty" };

  const candidates = combo.mode === "round_robin"
    ? rotateCandidates(baseCandidates, roundRobinCursor ?? 0)
    : baseCandidates;

  return { combo, candidates, maxAttempts: combo.maxAttempts };
}

function collectCandidates(combo: RoutingCombo, models: string[]): RoutingCandidate[] {
  const result: RoutingCandidate[] = [];
  const seen = new Set<string>();
  for (const model of models) {
    const providers = combo.providerOrderByModel[model] ?? [];
    const orderedProviders = combo.allowProviderFallback ? providers : providers.slice(0, 1);
    for (const provider of orderedProviders) {
      if (!isProvider(provider)) continue;
      const key = `${provider}\u0000${model}`;
      if (seen.has(key)) continue;
      seen.add(key);
      result.push({ provider, model, comboId: combo.id, comboRevision: combo.revision });
    }
  }
  return result;
}

function rotateCandidates(candidates: RoutingCandidate[], cursor: number): RoutingCandidate[] {
  if (candidates.length <= 1) return candidates;
  const idx = ((cursor % candidates.length) + candidates.length) % candidates.length;
  return [...candidates.slice(idx), ...candidates.slice(0, idx)];
}

function modelsForCombo(combo: RoutingCombo, requested?: string): string[] {
  if (requested !== undefined) {
    if (!combo.modelOrder.includes(requested)) return combo.allowModelFallback ? [...combo.modelOrder] : [];
    if (!combo.allowModelFallback) return [requested];
    return [requested, ...combo.modelOrder.filter((model) => model !== requested)];
  }
  return combo.allowModelFallback ? [...combo.modelOrder] : combo.modelOrder.slice(0, 1);
}
