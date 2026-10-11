import { configPath } from "./paths.ts";
import { assertEfficiencyPolicy } from './efficiency-policy.ts';
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import type { ProviderConfig, ProviderName, ProxyConfig, RoutingCombo } from "./types.ts";
import { ALL_PROVIDERS, isOptionalProvider, isProvider, isUserDefinedProvider, MAX_PROVIDERS, NAMED_EXPERIMENTAL_DEFAULTS, OPTIONAL_PROVIDERS, type OptionalProviderName } from "./provider-registry.ts";
import { GEMINI_FREE_PRIVACY_NOTICE_VERSION } from "./privacy.ts";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { withConfigFileLock } from "./config-file-lock.ts";
import { assertProviderEndpointUrl } from "./endpoint-policy.ts";
import { isNamedExperimentalProvider } from "./provider-registry.ts";
import { parseLangfuseEndpoint } from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";

const groq: ProviderConfig = {
  name: "groq",
  enabled: false,
  configured: false,
  models: ["openai/gpt-oss-20b", "openai/gpt-oss-120b"],
  defaultModel: "openai/gpt-oss-20b",
  budget: { rpm: 30, rpd: 1_000, tpm: 8_000, tpd: 200_000, source: "official_headers" },
  allowedFails: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  max429Retries: 2,
  baseBackoffMs: 250,
  requestTimeoutMs: 60_000
};

const gemini: ProviderConfig = {
  name: "gemini",
  enabled: false,
  configured: false,
  models: ["gemini-2.5-flash"],
  defaultModel: "gemini-2.5-flash",
  budget: { rpm: 1, tpm: 1_000, source: "account_user_input" },
  allowedFails: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  max429Retries: 2,
  baseBackoffMs: 500,
  requestTimeoutMs: 60_000,
  privacyNoticeVersion: GEMINI_FREE_PRIVACY_NOTICE_VERSION
};

// SPEC-011 §4.1/§4.2: providers opcionais entram no schema apenas quando
// configurados pelo usuário — defaultConfig continua Groq+Gemini (default OFF,
// §9.6). Ollama é nível 2 (experimental); custom é nível 3 (responsabilidade
// do usuário). O endpoint é validado por política, não por confiança.
const ollamaDefaults: ProviderConfig = {
  name: "ollama",
  enabled: false,
  configured: false,
  models: ["llama3.2"],
  defaultModel: "llama3.2",
  budget: { rpm: 600, tpm: 1_000_000, source: "account_user_input" },
  allowedFails: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  max429Retries: 0,
  baseBackoffMs: 250,
  requestTimeoutMs: 120_000,
  endpointUrl: "http://127.0.0.1:11434/v1/chat/completions"
};

const vllmDefaults: ProviderConfig = {
  name: "vllm",
  enabled: false,
  configured: false,
  models: ["default"],
  defaultModel: "default",
  budget: { rpm: 600, tpm: 1_000_000, source: "account_user_input" },
  allowedFails: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  max429Retries: 0,
  baseBackoffMs: 250,
  requestTimeoutMs: 120_000,
  endpointUrl: "http://127.0.0.1:8000/v1/chat/completions"
};

const customDefaults: ProviderConfig = {
  name: "custom",
  enabled: false,
  configured: false,
  models: ["custom-model"],
  defaultModel: "custom-model",
  budget: { rpm: 600, tpm: 1_000_000, source: "account_user_input" },
  allowedFails: 3,
  failureWindowMs: 60_000,
  cooldownMs: 30_000,
  max429Retries: 0,
  baseBackoffMs: 250,
  requestTimeoutMs: 60_000,
  endpointUrl: "https://example.invalid/v1/chat/completions"
};

function namedExperimentalDefaults(provider: keyof typeof NAMED_EXPERIMENTAL_DEFAULTS): ProviderConfig {
  const preset = NAMED_EXPERIMENTAL_DEFAULTS[provider];
  return {
    name: provider,
    enabled: false,
    configured: false,
    models: [...preset.models],
    defaultModel: preset.defaultModel,
    budget: { rpm: 60, tpm: 100_000, source: "account_user_input" },
    allowedFails: 3,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    max429Retries: 1,
    baseBackoffMs: 250,
    requestTimeoutMs: 60_000,
    endpointUrl: preset.endpointUrl
  };
}

export function ensureProviderEntry(config: ProxyConfig, provider: OptionalProviderName): void {
  if (config.providers[provider]) return;
  if (provider === "ollama") config.providers[provider] = structuredClone(ollamaDefaults);
  else if (provider === "vllm") config.providers[provider] = structuredClone(vllmDefaults);
  else if (provider === "custom") config.providers[provider] = structuredClone(customDefaults);
  else config.providers[provider] = namedExperimentalDefaults(provider);
}

export function userDefinedProviderDefaults(name: string): ProviderConfig {
  return {
    name,
    enabled: false,
    configured: false,
    models: ["default"],
    defaultModel: "default",
    budget: { rpm: 60, tpm: 100_000, source: "account_user_input" as const },
    allowedFails: 3,
    failureWindowMs: 60_000,
    cooldownMs: 30_000,
    max429Retries: 1,
    baseBackoffMs: 250,
    requestTimeoutMs: 60_000,
    endpointUrl: "https://example.invalid/v1/chat/completions"
  };
}

export function ensureUserDefinedProviderEntry(config: ProxyConfig, name: string): void {
  if (!isUserDefinedProvider(name)) throw new Error("provider_name_invalid");
  if (config.providers[name as OptionalProviderName]) return;
  if (Object.keys(config.providers).length >= MAX_PROVIDERS) throw new Error("provider_limit_exceeded");
  (config.providers as Record<string, ProviderConfig>)[name] = userDefinedProviderDefaults(name);
}

let configQueue: Promise<unknown> = Promise.resolve();

export const defaultConfig: ProxyConfig = {
  fallbackOrder: ["groq", "gemini"],
  providers: { groq, gemini }
};

export async function loadConfig(): Promise<ProxyConfig> {
  const config = migrateLegacyConfigured(await readJson<unknown>(configPath(), structuredClone(defaultConfig)));
  assertProxyConfig(config);
  return config;
}

export async function saveConfig(config: ProxyConfig): Promise<void> {
  assertProxyConfig(config);
  const snapshot = structuredClone(config);
  await exclusive(async () => { await writeJsonAtomic(configPath(), snapshot); });
}

export async function updateConfig(mutator: (config: ProxyConfig) => void): Promise<ProxyConfig> {
  return exclusive(async () => {
    const config = await loadConfig();
    mutator(config); assertProxyConfig(config);
    await writeJsonAtomic(configPath(), config);
    return structuredClone(config);
  });
}

async function exclusive<T>(operation: () => Promise<T>): Promise<T> { const guarded = () => withConfigFileLock(configPath(), operation); const next = configQueue.then(guarded, guarded); configQueue = next.then(() => undefined, () => undefined); return next; }

export function assertProxyConfig(value: unknown): asserts value is ProxyConfig {
  if (!record(value) || !validTopLevelKeys(value)) throw new Error("proxy_config_invalid");
  if(value.efficiencyPolicy!==undefined)assertEfficiencyPolicy(value.efficiencyPolicy);
  if (!Array.isArray(value.fallbackOrder) || value.fallbackOrder.length < 2 || value.fallbackOrder.length > MAX_PROVIDERS || new Set(value.fallbackOrder).size !== value.fallbackOrder.length || !value.fallbackOrder.every(providerName)) throw new Error("proxy_config_invalid");
  if (!record(value.providers) || !validProviderKeySet(value.providers)) throw new Error("proxy_config_invalid");
  for (const name of value.fallbackOrder) if (!Object.hasOwn(value.providers, name)) throw new Error("proxy_config_invalid");
  validateProvider(value.providers.groq, "groq", "official_headers"); validateProvider(value.providers.gemini, "gemini", "account_user_input");
  for (const optional of OPTIONAL_PROVIDERS) if (value.providers[optional] !== undefined) validateProvider(value.providers[optional], optional, "account_user_input");
  for (const key of Object.keys(value.providers)) if (isUserDefinedProvider(key)) validateProvider(value.providers[key], key, "account_user_input");
  validateResilience(value.resilience);
  validateRoutingCombos(value as unknown as ProxyConfig);
  validateRoutingPolicy(value.routingPolicy);
  validateRetentionEvidence(value.retentionEvidence);
  validateTariffSnapshot(value.tariffSnapshot);
  if (value.workspaceTelemetry !== undefined) {
    if (!record(value.workspaceTelemetry) || keys(value.workspaceTelemetry) !== "endpoint,kind" || value.workspaceTelemetry.kind !== "langfuse") throw new Error("proxy_config_invalid");
    try { parseLangfuseEndpoint(value.workspaceTelemetry.endpoint); } catch { throw new Error("proxy_config_invalid"); }
  }
  for (const field of ["lastControlPlaneContact", "lastObservedWallClock", "deviceRevokedAt", "entitlementSuspendedAt"] as const) if (value[field] !== undefined && !validTimestamp(value[field])) throw new Error("proxy_config_invalid");
  const contactFields = [value.lastControlPlaneContact, value.lastControlPlaneContactTenantId, value.lastControlPlaneContactDeviceId];
  if (contactFields.some((field) => field !== undefined) && (contactFields.some((field) => field === undefined) || !validTimestamp(value.lastControlPlaneContact) || !identityPart(value.lastControlPlaneContactTenantId) || !identityPart(value.lastControlPlaneContactDeviceId))) throw new Error("proxy_config_invalid");
  if (value.entitlementRevision !== undefined && !boundedInteger(value.entitlementRevision, 0, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
  const appliedFields = [value.appliedConfigVersion, value.appliedConfigTenantId, value.appliedConfigDeviceId];
  if (appliedFields.some((field) => field !== undefined) && (appliedFields.some((field) => field === undefined) || !boundedInteger(value.appliedConfigVersion, 1, Number.MAX_SAFE_INTEGER) || !identityPart(value.appliedConfigTenantId) || !identityPart(value.appliedConfigDeviceId))) throw new Error("proxy_config_invalid");
}

const CORE_PROVIDER_KEYS = ["name", "enabled", "configured", "models", "defaultModel", "budget", "allowedFails", "failureWindowMs", "cooldownMs", "max429Retries", "baseBackoffMs", "requestTimeoutMs", "privacyAcceptedAt", "privacyNoticeVersion", "riskAcceptedAt", "riskNoticeVersion"];

function validProviderKeySet(providers: Record<string, unknown>): boolean {
  const names = Object.keys(providers);
  if (!names.includes("groq") || !names.includes("gemini")) return false;
  if (names.length > MAX_PROVIDERS) return false;
  return names.every((name) => name === "groq" || name === "gemini" || isOptionalProvider(name) || isUserDefinedProvider(name));
}

function validateProvider(value: unknown, expectedName: ProviderName | string, expectedSource: "official_headers" | "account_user_input"): void {
  const optional = isOptionalProvider(expectedName);
  const userDefined = isUserDefinedProvider(expectedName);
  const needsEndpoint = optional || userDefined;
  const allowedKeys = needsEndpoint ? [...CORE_PROVIDER_KEYS, "endpointUrl", "modelAliases", "maxContextTokens"] : [...CORE_PROVIDER_KEYS, "modelAliases", "maxContextTokens"];
  if (!record(value) || Object.keys(value).some((key) => !allowedKeys.includes(key)) || Object.keys(value).some((key) => value[key] === undefined)) throw new Error("proxy_config_invalid");
  if (value.name !== expectedName || typeof value.enabled !== "boolean" || typeof value.configured !== "boolean" || !Array.isArray(value.models) || value.models.length < 1 || value.models.length > 256 || !value.models.every(modelName) || new Set(value.models).size !== value.models.length || typeof value.defaultModel !== "string" || !value.models.includes(value.defaultModel)) throw new Error("proxy_config_invalid");
  if (!record(value.budget) || Object.keys(value.budget).some((key) => !["rpm", "tpm", "rpd", "tpd", "source"].includes(key)) || value.budget.source !== expectedSource || !positiveLimit(value.budget.rpm) || !positiveLimit(value.budget.tpm) || value.budget.rpd !== undefined && !positiveLimit(value.budget.rpd) || value.budget.tpd !== undefined && !positiveLimit(value.budget.tpd)) throw new Error("proxy_config_invalid");
  if (!boundedInteger(value.allowedFails, 1, 100) || !boundedInteger(value.failureWindowMs, 1_000, 86_400_000) || !boundedInteger(value.cooldownMs, 100, 86_400_000) || !boundedInteger(value.max429Retries, 0, 10) || !boundedInteger(value.baseBackoffMs, 50, 60_000) || !boundedInteger(value.requestTimeoutMs, 1_000, 120_000)) throw new Error("proxy_config_invalid");
  if (needsEndpoint) {
    if (typeof value.endpointUrl !== "string") throw new Error("proxy_config_invalid");
    assertProviderEndpointUrl(expectedName, value.endpointUrl);
    if (value.privacyAcceptedAt !== undefined || value.privacyNoticeVersion !== undefined) throw new Error("proxy_config_invalid");
    if (isNamedExperimentalProvider(expectedName)) {
      if (value.riskAcceptedAt !== undefined && !validTimestamp(value.riskAcceptedAt)) throw new Error("proxy_config_invalid");
      if (value.riskNoticeVersion !== undefined && (typeof value.riskNoticeVersion !== "string" || value.riskNoticeVersion.length > 100)) throw new Error("proxy_config_invalid");
      if ((value.riskAcceptedAt === undefined) !== (value.riskNoticeVersion === undefined)) throw new Error("proxy_config_invalid");
    } else if (value.riskAcceptedAt !== undefined || value.riskNoticeVersion !== undefined) throw new Error("proxy_config_invalid");
  }
  if (value.modelAliases !== undefined) {
    if (!record(value.modelAliases) || Object.keys(value.modelAliases).length > 64) throw new Error("proxy_config_invalid");
    for (const [alias, target] of Object.entries(value.modelAliases)) if (!modelName(alias) || !modelName(target) || !(value.models as string[]).includes(target)) throw new Error("proxy_config_invalid");
  }
  if (value.maxContextTokens !== undefined && !boundedInteger(value.maxContextTokens, 1_024, 10_000_000)) throw new Error("proxy_config_invalid");
  if (expectedName === "groq" && (value.privacyAcceptedAt !== undefined || value.privacyNoticeVersion !== undefined || value.riskAcceptedAt !== undefined || value.riskNoticeVersion !== undefined) || expectedName === "gemini" && (value.privacyAcceptedAt !== undefined && !validTimestamp(value.privacyAcceptedAt) || value.privacyNoticeVersion !== undefined && (typeof value.privacyNoticeVersion !== "string" || !/^gemini-free-\d{4}-\d{2}-\d{2}-v\d+$/.test(value.privacyNoticeVersion)) || value.riskAcceptedAt !== undefined || value.riskNoticeVersion !== undefined)) throw new Error("proxy_config_invalid");
}

function validTopLevelKeys(value: Record<string, unknown>): boolean { return Object.keys(value).every((key) => ["efficiencyPolicy", "fallbackOrder", "providers", "routingCombos", "activeRoutingComboId", "routingPolicy", "retentionEvidence", "tariffSnapshot", "resilience", "workspaceTelemetry", "lastControlPlaneContact", "lastControlPlaneContactTenantId", "lastControlPlaneContactDeviceId", "lastObservedWallClock", "deviceRevokedAt", "entitlementSuspendedAt", "entitlementRevision", "appliedConfigVersion", "appliedConfigTenantId", "appliedConfigDeviceId"].includes(key)) && Object.hasOwn(value, "fallbackOrder") && Object.hasOwn(value, "providers"); }

function validateResilience(value: unknown): void {
  if (value === undefined) return;
  if (!record(value) || Object.keys(value).some((key) => !["autoFallbackEnabled", "maxAttemptsPerRequest", "quotaWarnRatio", "maxTransientRetries"].includes(key))) throw new Error("proxy_config_invalid");
  if (value.autoFallbackEnabled !== undefined && typeof value.autoFallbackEnabled !== "boolean") throw new Error("proxy_config_invalid");
  if (value.maxAttemptsPerRequest !== undefined && !boundedInteger(value.maxAttemptsPerRequest, 1, 32)) throw new Error("proxy_config_invalid");
  if (value.quotaWarnRatio !== undefined && (typeof value.quotaWarnRatio !== "number" || !Number.isFinite(value.quotaWarnRatio) || value.quotaWarnRatio <= 0 || value.quotaWarnRatio >= 1)) throw new Error("proxy_config_invalid");
  if (value.maxTransientRetries !== undefined && !boundedInteger(value.maxTransientRetries, 0, 5)) throw new Error("proxy_config_invalid");
}

function validateRoutingCombos(value: ProxyConfig): void {
  if (value.activeRoutingComboId !== undefined && (!routingId(value.activeRoutingComboId) || value.routingCombos?.[value.activeRoutingComboId] === undefined)) throw new Error("proxy_config_invalid");
  if (value.routingCombos === undefined) return;
  if (!record(value.routingCombos) || Object.keys(value.routingCombos).length > 32) throw new Error("proxy_config_invalid");
  for (const [id, combo] of Object.entries(value.routingCombos)) {
    if (!routingId(id) || !record(combo) || combo.id !== id) throw new Error("proxy_config_invalid");
    validateRoutingCombo(combo as unknown as RoutingCombo, value);
  }
}

function validateRoutingCombo(combo: RoutingCombo, config: ProxyConfig): void {
  const allowedKeys = ["id", "revision", "name", "mode", "modelOrder", "providerOrderByModel", "allowModelFallback", "allowProviderFallback", "maxAttempts", "roundRobinCursor", "sticky", "costCeilingMicros", "latency", "retention"];
  if (Object.keys(combo).some((key) => !allowedKeys.includes(key))) throw new Error("proxy_config_invalid");
  if (!boundedInteger(combo.revision, 1, Number.MAX_SAFE_INTEGER) || typeof combo.name !== "string" || combo.name.length < 1 || combo.name.length > 80) throw new Error("proxy_config_invalid");
  if (!["fixed", "cost", "latency", "balanced", "quality", "throughput", "round_robin", "auto"].includes(combo.mode)) throw new Error("proxy_config_invalid");
  if (!Array.isArray(combo.modelOrder) || combo.modelOrder.length < 1 || combo.modelOrder.length > 32 || !combo.modelOrder.every(modelName) || new Set(combo.modelOrder).size !== combo.modelOrder.length) throw new Error("proxy_config_invalid");
  if (typeof combo.allowModelFallback !== "boolean" || typeof combo.allowProviderFallback !== "boolean" || !boundedInteger(combo.maxAttempts, 1, 8)) throw new Error("proxy_config_invalid");
  if (!record(combo.providerOrderByModel) || Object.keys(combo.providerOrderByModel).length !== combo.modelOrder.length) throw new Error("proxy_config_invalid");
  for (const model of combo.modelOrder) {
    const providers = combo.providerOrderByModel[model];
    if (!Array.isArray(providers) || providers.length < 1 || providers.length > MAX_PROVIDERS || new Set(providers).size !== providers.length || !providers.every(providerName)) throw new Error("proxy_config_invalid");
    for (const provider of providers) if (!Object.hasOwn(config.providers, provider)) throw new Error("proxy_config_invalid");
  }
  if (combo.roundRobinCursor !== undefined && !boundedInteger(combo.roundRobinCursor, 0, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
  if (combo.sticky !== undefined && typeof combo.sticky !== "boolean") throw new Error("proxy_config_invalid");
  if (combo.costCeilingMicros !== undefined && !boundedInteger(combo.costCeilingMicros, 0, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
  if (combo.latency !== undefined) {
    if (!record(combo.latency) || Object.keys(combo.latency).some((key) => !["minSamples", "windowMs"].includes(key))) throw new Error("proxy_config_invalid");
    if (combo.latency.minSamples !== undefined && !boundedInteger(combo.latency.minSamples, 1, 100)) throw new Error("proxy_config_invalid");
    if (combo.latency.windowMs !== undefined && !boundedInteger(combo.latency.windowMs, 1_000, 86_400_000)) throw new Error("proxy_config_invalid");
  }
  if (combo.retention !== undefined) {
    if (!record(combo.retention) || Object.keys(combo.retention).some((key) => !["requireZdr", "denyDataCollection"].includes(key))) throw new Error("proxy_config_invalid");
    if (combo.retention.requireZdr !== undefined && typeof combo.retention.requireZdr !== "boolean") throw new Error("proxy_config_invalid");
    if (combo.retention.denyDataCollection !== undefined && typeof combo.retention.denyDataCollection !== "boolean") throw new Error("proxy_config_invalid");
  }
}

function validateRoutingPolicy(value: unknown): void {
  if (value === undefined) return;
  if (!record(value) || Object.keys(value).some((key) => !["mode", "costCeilingMicros", "latency", "retention"].includes(key))) throw new Error("proxy_config_invalid");
  if (value.mode !== undefined && !["fixed", "cost", "latency", "balanced", "quality", "throughput", "round_robin", "auto"].includes(value.mode as string)) throw new Error("proxy_config_invalid");
  if (value.costCeilingMicros !== undefined && !boundedInteger(value.costCeilingMicros, 0, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
  if (value.latency !== undefined) {
    if (!record(value.latency) || Object.keys(value.latency).some((key) => !["minSamples", "windowMs"].includes(key))) throw new Error("proxy_config_invalid");
    if (value.latency.minSamples !== undefined && !boundedInteger(value.latency.minSamples, 1, 100)) throw new Error("proxy_config_invalid");
    if (value.latency.windowMs !== undefined && !boundedInteger(value.latency.windowMs, 1_000, 86_400_000)) throw new Error("proxy_config_invalid");
  }
  if (value.retention !== undefined) {
    if (!record(value.retention) || Object.keys(value.retention).some((key) => !["requireZdr", "denyDataCollection"].includes(key))) throw new Error("proxy_config_invalid");
    if (value.retention.requireZdr !== undefined && typeof value.retention.requireZdr !== "boolean") throw new Error("proxy_config_invalid");
    if (value.retention.denyDataCollection !== undefined && typeof value.retention.denyDataCollection !== "boolean") throw new Error("proxy_config_invalid");
  }
}

function validateRetentionEvidence(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64) throw new Error("proxy_config_invalid");
  const allowedKeys = ["id", "version", "provider", "model", "zdr", "dataCollection", "supportsDataCollectionParam", "sourceUrl", "checkedAt", "validUntil"];
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).some((key) => !allowedKeys.includes(key)) || Object.keys(entry).some((key) => entry[key] === undefined)) throw new Error("proxy_config_invalid");
    if (!routingId(entry.id) || !boundedInteger(entry.version, 1, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
    if (!providerName(entry.provider)) throw new Error("proxy_config_invalid");
    if (entry.model !== undefined && !modelName(entry.model)) throw new Error("proxy_config_invalid");
    if (!["yes", "no", "unknown"].includes(entry.zdr as string)) throw new Error("proxy_config_invalid");
    if (!["denied", "allowed", "unknown"].includes(entry.dataCollection as string)) throw new Error("proxy_config_invalid");
    if (entry.supportsDataCollectionParam !== undefined && typeof entry.supportsDataCollectionParam !== "boolean") throw new Error("proxy_config_invalid");
    if (!sourceUrl(entry.sourceUrl) || !validTimestamp(entry.checkedAt)) throw new Error("proxy_config_invalid");
    if (entry.validUntil !== undefined && !validTimestamp(entry.validUntil)) throw new Error("proxy_config_invalid");
  }
}

function validateTariffSnapshot(value: unknown): void {
  if (value === undefined) return;
  if (!Array.isArray(value) || value.length > 64) throw new Error("proxy_config_invalid");
  const allowedKeys = ["id", "version", "provider", "model", "accessMode", "currency", "unit", "inputMicrosPerMillion", "outputMicrosPerMillion", "cachedInputMicrosPerMillion", "realtimeAudioRates", "unitMicros", "variant", "sourceUrl", "checkedAt", "validFrom", "validUntil", "comparisonBasis"];
  for (const entry of value) {
    if (!record(entry) || Object.keys(entry).some((key) => !allowedKeys.includes(key)) || Object.keys(entry).some((key) => entry[key] === undefined)) throw new Error("proxy_config_invalid");
    if (!routingId(entry.id) || !boundedInteger(entry.version, 1, Number.MAX_SAFE_INTEGER)) throw new Error("proxy_config_invalid");
    if (typeof entry.provider !== "string" || !/^[a-z0-9][a-z0-9._-]{0,63}$/.test(entry.provider)) throw new Error("proxy_config_invalid");
    if (!modelName(entry.model)) throw new Error("proxy_config_invalid");
    if (!["public", "byok", "local", "hosted"].includes(entry.accessMode as string)) throw new Error("proxy_config_invalid");
    if (entry.currency !== "USD" || !["million_tokens", "image", "second", "character"].includes(entry.unit as string)) throw new Error("proxy_config_invalid");
    if (!microsAmount(entry.inputMicrosPerMillion) || !microsAmount(entry.outputMicrosPerMillion)) throw new Error("proxy_config_invalid");
    if (entry.cachedInputMicrosPerMillion !== null && !microsAmount(entry.cachedInputMicrosPerMillion)) throw new Error("proxy_config_invalid");
    if (entry.realtimeAudioRates !== undefined) {
      const audio = entry.realtimeAudioRates;
      if (entry.unit !== "million_tokens" || !record(audio) || keys(audio) !== "cachedInputMicrosPerMillion,inputMicrosPerMillion,outputMicrosPerMillion"
        || !microsAmount(audio.inputMicrosPerMillion) || !microsAmount(audio.outputMicrosPerMillion) || !microsAmount(audio.cachedInputMicrosPerMillion)) throw new Error("proxy_config_invalid");
    }
    // F1: per-unit tariffs carry their own rate and never price tokens; token tariffs carry no unit rate.
    if (entry.unit === "million_tokens") {
      if (entry.unitMicros !== undefined || entry.variant !== undefined) throw new Error("proxy_config_invalid");
    } else if (!microsAmount(entry.unitMicros) || entry.inputMicrosPerMillion !== "0" || entry.outputMicrosPerMillion !== "0" || entry.cachedInputMicrosPerMillion !== null
      || entry.variant !== undefined && (typeof entry.variant !== "string" || !/^[A-Za-z0-9][A-Za-z0-9x._\/:-]{0,63}$/.test(entry.variant))) throw new Error("proxy_config_invalid");
    if (!sourceUrl(entry.sourceUrl) || !validTimestamp(entry.checkedAt) || !validTimestamp(entry.validFrom)) throw new Error("proxy_config_invalid");
    if (entry.validUntil !== null && !validTimestamp(entry.validUntil)) throw new Error("proxy_config_invalid");
    if (!["same_service", "explicit_alternative"].includes(entry.comparisonBasis as string)) throw new Error("proxy_config_invalid");
  }
}

function migrateLegacyConfigured(value: unknown): unknown {
  if (!record(value) || !record(value.providers)) return value;
  const copy = structuredClone(value);
  if (!record(copy.providers)) return value;
  const contactEpochFields = [copy.lastControlPlaneContact, copy.lastControlPlaneContactTenantId, copy.lastControlPlaneContactDeviceId];
  if (contactEpochFields.some((field) => field !== undefined) && contactEpochFields.some((field) => field === undefined)) {
    delete copy.lastControlPlaneContact; delete copy.lastControlPlaneContactTenantId; delete copy.lastControlPlaneContactDeviceId; delete copy.lastObservedWallClock;
  }
  for (const provider of ["groq", "gemini"] as const) {
    const item = copy.providers[provider];
    if (record(item)) {
      if (!Object.hasOwn(item, "configured") && typeof item.enabled === "boolean") item.configured = item.enabled;
      if (!Object.hasOwn(item, "requestTimeoutMs")) item.requestTimeoutMs = defaultConfig.providers[provider].requestTimeoutMs;
    }
  }
  return copy;
}
function keys(value: Record<string, unknown>): string { return Object.keys(value).sort().join(","); }
function providerName(value: unknown): value is ProviderName { return isProvider(value); }
function modelName(value: unknown): value is string { return typeof value === "string" && value.length >= 1 && value.length <= 200 && /^[A-Za-z0-9._:/-]+$/.test(value); }
function routingId(value: unknown): value is string { return typeof value === "string" && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value); }
function identityPart(value: unknown): value is string { return typeof value === "string" && /^[A-Za-z0-9_-]{3,100}$/.test(value); }
function positiveLimit(value: unknown): value is number { return boundedInteger(value, 1, 1_000_000_000); }
function boundedInteger(value: unknown, minimum: number, maximum: number): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= minimum && value <= maximum; }
function validTimestamp(value: unknown): value is string { return typeof value === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) && Number.isFinite(Date.parse(value)); }
function sourceUrl(value: unknown): value is string { return typeof value === "string" && value.length >= 9 && value.length <= 2048 && value.startsWith("https://"); }
function microsAmount(value: unknown): value is string { return typeof value === "string" && /^\d{1,30}$/.test(value); }
