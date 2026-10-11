import { assertEndpointCredentialFree, assertProviderEndpointUrl, isLocalEndpointUrl } from "./endpoint-policy.ts";
import { ensureProviderEntry } from "./config.ts";
import type { OptionalProviderName, ProxyConfig } from "./types.ts";
import { isNamedExperimentalProvider, NAMED_EXPERIMENTAL_DEFAULTS } from "./provider-registry.ts";

export const MAX_PROVIDER_MODEL_LENGTH = 200;

export function configureOptionalProvider(
  config: ProxyConfig,
  provider: OptionalProviderName,
  rawEndpointUrl: string,
  rawModel: string
): void {
  const endpointUrl = rawEndpointUrl.trim();
  const model = normalizeProviderModel(rawModel);
  assertProviderEndpointUrl(provider, endpointUrl);
  assertEndpointCredentialFree(endpointUrl);
  ensureProviderEntry(config, provider);
  const entry = config.providers[provider]!;
  entry.endpointUrl = endpointUrl;
  entry.models = [model];
  entry.defaultModel = model;
}

export function configureNamedExperimentalDefaults(
  config: ProxyConfig,
  provider: OptionalProviderName,
  rawModel?: string
): void {
  if (!isNamedExperimentalProvider(provider)) throw new Error("provider_not_named_experimental");
  const preset = NAMED_EXPERIMENTAL_DEFAULTS[provider];
  const model = rawModel ? normalizeProviderModel(rawModel) : preset.defaultModel;
  assertProviderEndpointUrl(provider, preset.endpointUrl);
  ensureProviderEntry(config, provider);
  const entry = config.providers[provider]!;
  entry.endpointUrl = preset.endpointUrl;
  if (rawModel) {
    entry.models = [model];
    entry.defaultModel = model;
  } else {
    entry.models = [...preset.models];
    entry.defaultModel = preset.defaultModel;
  }
}

export function normalizeProviderModel(rawModel: string): string {
  const model = rawModel.trim();
  if (model.length < 1 || model.length > MAX_PROVIDER_MODEL_LENGTH || !/^[A-Za-z0-9._:/-]+$/.test(model)) {
    throw new Error("provider_model_invalid");
  }
  return model;
}

export function optionalProviderReady(config: ProxyConfig, provider: OptionalProviderName): boolean {
  const entry = config.providers[provider];
  if (!entry?.endpointUrl) return false;
  if (provider === "custom" && entry.endpointUrl === "https://example.invalid/v1/chat/completions") return false;
  return entry.models.length > 0 && entry.models.includes(entry.defaultModel);
}

export function optionalProviderAllowsKeyless(config: ProxyConfig, provider: OptionalProviderName): boolean {
  const endpointUrl = config.providers[provider]?.endpointUrl;
  return provider === "ollama" || provider === "vllm" || typeof endpointUrl === "string" && isLocalEndpointUrl(endpointUrl);
}
