import { defaultConfig, ensureProviderEntry, ensureUserDefinedProviderEntry, updateConfig } from "./config.ts";
import type { SecretStore } from "./secret-store.ts";
import type { OptionalProviderName, ProviderName, ProxyConfig } from "./types.ts";
import { configureOptionalProvider, optionalProviderAllowsKeyless } from "./provider-profile.ts";
import { ALL_PROVIDERS, isNamedExperimentalProvider, isOptionalProvider, isUserDefinedProvider, OPTIONAL_PROVIDERS } from "./provider-registry.ts";
import { acceptNamedProviderRisk, namedProviderRiskAccepted } from "./provider-risk.ts";
import { assertEndpointCredentialFree, assertProviderEndpointUrl } from "./endpoint-policy.ts";
import { isLocalEndpointUrl } from "./endpoint-policy.ts";
import { normalizeProviderModel } from "./provider-profile.ts";

type ConfigUpdater = (mutator: (config: ProxyConfig) => void) => Promise<ProxyConfig>;
type CacheInvalidator = { invalidateProvider(provider: ProviderName): Promise<void> };
let lifecycleQueue: Promise<unknown> = Promise.resolve();
export const MAX_PROVIDER_KEY_LENGTH = 512;

export function enableProvider(provider: ProviderName, rawKey: string, secrets: SecretStore, updater: ConfigUpdater = updateConfig, cache?: CacheInvalidator, allowKeyless = provider === "ollama" || provider === "vllm"): Promise<void> {
  return enableProviderPrepared(provider, rawKey, secrets, updater, cache, allowKeyless);
}

export function configureAndEnableOptionalProvider(provider: OptionalProviderName, endpointUrl: string, model: string, rawKey: string, secrets: SecretStore, updater: ConfigUpdater = updateConfig, cache?: CacheInvalidator, acceptProviderRisk = false): Promise<void> {
  if (isNamedExperimentalProvider(provider) && !acceptProviderRisk) return Promise.reject(new Error("provider_risk_consent_required"));
  const candidate = structuredClone(defaultConfig);
  configureOptionalProvider(candidate, provider, endpointUrl, model);
  const allowKeyless = optionalProviderAllowsKeyless(candidate, provider);
  return discoverModels(endpointUrl, rawKey).then((discovered) => enableProviderPrepared(provider, rawKey, secrets, updater, cache, allowKeyless, (config) => {
    configureOptionalProvider(config, provider, endpointUrl, model);
    if (discovered.length) { const entry = config.providers[provider]!; entry.models = [...new Set([model, ...discovered])]; entry.defaultModel = model; }
    if (isNamedExperimentalProvider(provider)) {
      if (!acceptProviderRisk) throw new Error("provider_risk_consent_required");
      acceptNamedProviderRisk(config.providers[provider]!, provider);
    }
  }));
}

export function configureAndEnableUserDefinedProvider(name: string, endpointUrl: string, model: string, rawKey: string, secrets: SecretStore, updater: ConfigUpdater = updateConfig, cache?: CacheInvalidator): Promise<void> {
  if (!isUserDefinedProvider(name)) return Promise.reject(new Error("provider_name_invalid"));
  assertProviderEndpointUrl(name, endpointUrl.trim());
  assertEndpointCredentialFree(endpointUrl.trim());
  normalizeProviderModel(model);
  const allowKeyless = isLocalEndpointUrl(endpointUrl.trim());
  return discoverModels(endpointUrl, rawKey).then((discovered) => enableProviderPrepared(name as ProviderName, rawKey, secrets, updater, cache, allowKeyless, (config) => {
    ensureUserDefinedProviderEntry(config, name);
    const entry = (config.providers as Record<string, typeof config.providers.groq>)[name]!;
    entry.endpointUrl = endpointUrl.trim();
    const normalized = normalizeProviderModel(model);
    entry.models = [...new Set([normalized, ...discovered])];
    entry.defaultModel = normalized;
  }));
}

/** Discover the provider's real OpenAI-compatible model ids after key entry.
 * Failure is non-fatal: the explicitly entered model remains usable. */
async function discoverModels(endpointUrl: string, rawKey: string): Promise<string[]> {
  const key = rawKey.trim();
  if (!key) return [];
  try {
    const url = new URL(endpointUrl);
    url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
    if (!url.pathname.endsWith("/models")) url.pathname = `${url.pathname.replace(/\/$/, "")}/models`;
    const response = await fetch(url, { method: "GET", headers: { authorization: `Bearer ${key}`, accept: "application/json" }, signal: AbortSignal.timeout(12_000) });
    if (!response.ok) return [];
    const body = await response.json() as { data?: Array<{ id?: unknown }> };
    if (!Array.isArray(body.data)) return [];
    return body.data.map((item) => typeof item?.id === "string" ? item.id.trim() : "")
      .filter((id) => /^[A-Za-z0-9._:/-]{1,200}$/.test(id)).slice(0, 2_000);
  } catch { return []; }
}

function enableProviderPrepared(provider: ProviderName, rawKey: string, secrets: SecretStore, updater: ConfigUpdater, cache: CacheInvalidator | undefined, allowKeyless: boolean, prepareConfig?: (config: ProxyConfig) => void): Promise<void> {
  return exclusive(async () => {
    const key = normalizeProviderKey(rawKey, provider, allowKeyless);
    const account = `provider:${provider}`;
    const previous = await secrets.get(account);
    if (key === "") await secrets.delete(account); else await secrets.set(account, key);
    try {
      await cache?.invalidateProvider(provider);
      await updater((config) => {
        prepareConfig?.(config);
        if (isOptionalProvider(provider)) ensureProviderEntry(config, provider);
        else if (isUserDefinedProvider(provider)) ensureUserDefinedProviderEntry(config, provider);
        if (isNamedExperimentalProvider(provider) && !namedProviderRiskAccepted(provider, config.providers[provider]!)) throw new Error("provider_risk_consent_required");
        const entry = (config.providers as Record<string, typeof config.providers.groq>)[provider];
        if (entry) { entry.configured = true; entry.enabled = true; }
      });
    } catch (configError) {
      try { if (previous === undefined) await secrets.delete(account); else await secrets.set(account, previous); }
      catch (rollbackError) { throw new AggregateError([configError, rollbackError], "provider_enable_rollback_failed"); }
      throw configError;
    }
  });
}

export function normalizeProviderKey(rawKey: string, provider: ProviderName | string, allowKeyless = provider === "ollama" || provider === "vllm"): string {
  const key = rawKey.trim();
  if (allowKeyless && key === "") return "";
  const supportedCharacters = /^[A-Za-z0-9._-]+$/.test(key)
    || provider === 'custom-meta' && /^LLM\|[0-9]{1,32}\|[A-Za-z0-9._-]{8,}$/.test(key);
  if (key.length < 20 || key.length > MAX_PROVIDER_KEY_LENGTH || !supportedCharacters) throw new Error("provider_key_invalid");
  if (provider === "groq" && !key.startsWith("gsk_")) throw new Error("provider_key_invalid");
  // Reject recognizable credentials from a different named provider before
  // touching the native secret store. Custom OpenAI-compatible endpoints stay
  // permissive because their vendors may use arbitrary key prefixes.
  if (provider === "gemini" && (/^gsk_/i.test(key) || /^sk(?:-ant|-proj)?-/i.test(key))) throw new Error("provider_key_invalid");
  if (provider === "anthropic" && !/^sk-ant-/i.test(key) && /^gsk_/i.test(key)) throw new Error("provider_key_invalid");
  return key;
}

export function revokeProvider(provider: ProviderName | string, secrets: SecretStore, updater: ConfigUpdater = updateConfig, cache?: CacheInvalidator): Promise<void> {
  return exclusive(async () => {
    await updater((config) => {
      if (isOptionalProvider(provider)) ensureProviderEntry(config, provider);
      const entry = (config.providers as Record<string, typeof config.providers.groq>)[provider];
      if (entry) entry.enabled = false;
    });
    await cache?.invalidateProvider(provider as ProviderName);
    await secrets.delete(`provider:${provider}`);
    await updater((config) => {
      if (isOptionalProvider(provider)) ensureProviderEntry(config, provider);
      const entry = (config.providers as Record<string, typeof config.providers.groq>)[provider];
      if (entry) entry.configured = false;
    });
  });
}

export async function reconcileProviderPresence(config: ProxyConfig, secrets: SecretStore, updater: ConfigUpdater = updateConfig, cache?: CacheInvalidator): Promise<ProxyConfig> {
  const presence: Partial<Record<string, boolean>> = {
    groq: Boolean(await secrets.get("provider:groq")),
    gemini: Boolean(await secrets.get("provider:gemini"))
  };
  for (const provider of OPTIONAL_PROVIDERS) {
    if (!config.providers[provider]) continue;
    if (optionalProviderAllowsKeyless(config, provider) && config.providers[provider]!.enabled) presence[provider] = true;
    else presence[provider] = Boolean(await secrets.get(`provider:${provider}`));
  }
  // User-defined providers
  for (const key of Object.keys(config.providers)) {
    if (!isUserDefinedProvider(key)) continue;
    const entry = (config.providers as Record<string, typeof config.providers.groq>)[key];
    if (!entry) continue;
    const endpointUrl = entry.endpointUrl;
    const allowKeyless = typeof endpointUrl === "string" && isLocalEndpointUrl(endpointUrl);
    if (allowKeyless && entry.enabled) presence[key] = true;
    else presence[key] = Boolean(await secrets.get(`provider:${key}`));
  }
  const allNames = [...ALL_PROVIDERS, ...Object.keys(config.providers).filter(isUserDefinedProvider)];
  for (const provider of allNames) {
    const entry = (config.providers as Record<string, typeof config.providers.groq>)[provider];
    if (entry && (!presence[provider] || !entry.enabled)) await cache?.invalidateProvider(provider as ProviderName);
  }
  const needsWrite = allNames.some((provider) => {
    const entry = (config.providers as Record<string, typeof config.providers.groq>)[provider];
    return entry !== undefined && entry.configured !== Boolean(presence[provider]);
  });
  if (!needsWrite) return config;
  const updated = await updater((current) => {
    for (const provider of allNames) {
      const entry = (current.providers as Record<string, typeof current.providers.groq>)[provider];
      if (entry) entry.configured = Boolean(presence[provider]);
    }
  });
  Object.assign(config, updated);
  return config;
}

function exclusive<T>(operation: () => Promise<T>): Promise<T> {
  const next = lifecycleQueue.then(operation, operation);
  lifecycleQueue = next.then(() => undefined, () => undefined);
  return next;
}
