import { t } from "./i18n.ts";
/** Native-terminal provider onboarding. Secrets remain in this service and the existing OS vault.
 * Discovery contracts: ai.google.dev/api/models; platform.claude.com/docs/en/api/models/list;
 * docs.x.ai/developers/rest-api-reference/inference/models; huggingface.co/docs/inference-providers/hub-api.
 * No inference, static model-version guessing, browser session, or secondary credential store.
 */
import { ensureProviderEntry, ensureUserDefinedProviderEntry, loadConfig, updateConfig } from "../config.ts";
import { assertEndpointCredentialFree, assertProviderEndpointUrl, isLocalEndpointUrl } from "../endpoint-policy.ts";
import { localAdminRequest } from "../local-admin-client.ts";
import { enableProvider, normalizeProviderKey, revokeProvider } from "../provider-lifecycle.ts";
import { defaultProfileId } from "../connection-profiles.ts";
import { isCoreProvider, isNamedExperimentalProvider, isOptionalProvider, isUserDefinedProvider, NAMED_EXPERIMENTAL_DEFAULTS } from "../provider-registry.ts";
import { acceptNamedProviderRisk } from "../provider-risk.ts";
import { GEMINI_FREE_PRIVACY_NOTICE_VERSION } from "../privacy.ts";
import { providerNoticeText } from "./provider-notice-ui.ts";
import { PROVIDER_SETUP_CATALOG_PRESETS, type CatalogProviderSetupPreset } from "../provider-setup-catalog.ts";
import type { SecretStore } from "../secret-store.ts";
import type { ProviderConfig, ProviderName, ProxyConfig } from "../types.ts";

export interface ProviderSetupPreset {
  id: string;
  label: string;
  endpointUrl: string;
  protocol: "openai" | "gemini" | "anthropic";
  local: boolean;
  notice?: string;
  discovery?: CatalogProviderSetupPreset['discovery'];
  documentationUrl?: string;
  getKeyUrl?: string;
  modelIds?: readonly string[];
  modelsReviewedAt?: string;
  endpointRequired?: boolean;
  endpointPlaceholder?: string;
  endpointHostSuffix?: string;
  discoveryUrl?: string;
  discoveryFormat?: CatalogProviderSetupPreset['discoveryFormat'];
}

const LABELS: Record<string, string> = { deepseek: "DeepSeek", mistral: "Mistral", cerebras: "Cerebras", together: "Together AI", anthropic: "Anthropic", openrouter: "OpenRouter" };
export const PROVIDER_SETUP_PRESETS: readonly ProviderSetupPreset[] = Object.freeze([
  { id: "groq", label: "Groq", endpointUrl: "https://api.groq.com/openai/v1/chat/completions", protocol: "openai", local: false, getKeyUrl: "https://console.groq.com/keys" },
  { id: "gemini", label: "Google Gemini", endpointUrl: "https://generativelanguage.googleapis.com/v1beta/models", protocol: "gemini", local: false, documentationUrl: "https://ai.google.dev/gemini-api/docs/api-key", getKeyUrl: "https://aistudio.google.com/apikey", get notice() { return providerNoticeText("gemini"); } },
  ...Object.entries(NAMED_EXPERIMENTAL_DEFAULTS).map(([id, preset]) => ({ id, label: LABELS[id]!, endpointUrl: preset.endpointUrl,
    protocol: id === "anthropic" ? "anthropic" as const : "openai" as const, local: false,
    get notice() { return providerNoticeText(id); } })),
  { id: "custom-ovhcloud", label: "OVHcloud AI Endpoints", endpointUrl: "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/chat/completions", protocol: "openai", local: false },
  { id: "custom-openai", label: "OpenAI", endpointUrl: "https://api.openai.com/v1/chat/completions", protocol: "openai", local: false, getKeyUrl: "https://platform.openai.com/api-keys" },
  { id: "custom-xai", label: "xAI", endpointUrl: "https://api.x.ai/v1/chat/completions", protocol: "openai", local: false, getKeyUrl: "https://console.x.ai" },
  { id: "custom-huggingface", label: "Hugging Face", endpointUrl: "https://router.huggingface.co/v1/chat/completions", protocol: "openai", local: false, getKeyUrl: "https://huggingface.co/settings/tokens" },
  { id: "custom-nvidia", label: "NVIDIA NIM", endpointUrl: "https://integrate.api.nvidia.com/v1/chat/completions", protocol: "openai", local: false },
  ...PROVIDER_SETUP_CATALOG_PRESETS,
  { id: "ollama", label: "Ollama", endpointUrl: "http://127.0.0.1:11434/v1/chat/completions", protocol: "openai", local: true },
  { id: "vllm", label: "vLLM", endpointUrl: "http://127.0.0.1:8000/v1/chat/completions", protocol: "openai", local: true },
  { id: "custom", get label() { return t("provider_compatible"); }, endpointUrl: "", protocol: "openai", local: false },
] satisfies ProviderSetupPreset[]);

export interface DiscoveredSetupModel { id: string; name?: string }
export interface ProviderSetupResult { providerId: string; modelId: string; routingComboId: string; reloaded: true }
export interface PreparedProviderSetup {
  readonly providerId: string;
  readonly label: string;
  readonly endpointUrl: string;
  readonly models: readonly DiscoveredSetupModel[];
  readonly usesSavedKey: boolean;
  readonly notice?: string;
  readonly source?: "discovered" | "declared";
  commit(modelId: string, options: { acceptNotice: boolean }): Promise<ProviderSetupResult>;
  dispose(): void;
}
export interface ProviderSetupService {
  prepare(providerId: string, apiKey?: string, customEndpoint?: string, signal?: AbortSignal): Promise<PreparedProviderSetup>;
  prepareManual(providerId: string, apiKey: string | undefined, customEndpoint: string | undefined, modelId: string, signal?: AbortSignal): Promise<PreparedProviderSetup>;
  /** Explicit native action: revoke one saved connection, never every key for its provider. */
  disconnect(providerId: string, connectionId?: string, daemonUrl?: string, expectedRevision?: number): Promise<void>;
}
export interface ProviderSetupDependencies {
  secrets: SecretStore;
  loadConfig?: typeof loadConfig;
  updateConfig?: typeof updateConfig;
  fetch?: typeof fetch;
  reload?: () => Promise<void>;
  invalidate?: (providerId: string) => Promise<void>;
  timeoutMs?: number;
}

export class ProviderSetupError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.name = "ProviderSetupError"; this.code = code; }
}
const fail = (code: string): never => { throw new ProviderSetupError(code); };
const record = (v: unknown): Record<string, unknown> => v !== null && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
const MAX_DISCOVERY_BYTES = 8 * 1024 * 1024;
const MAX_DISCOVERED_MODELS = 2_000;
const MODEL_ID = /^[A-Za-z0-9._:/-]{1,200}$/;

// /models can contain embeddings, speech and image models without endpoint
// metadata. These documented Chat Completions families are a positive fallback,
// not a guess about every model beginning with "gpt". Unknown/fine-tuned models
// remain available through explicit manual entry (source: declared).
const OPENAI_CHAT_MODELS = new Set([
  'gpt-3.5-turbo','gpt-4','gpt-4-turbo','gpt-4-turbo-preview',
  'gpt-4o','gpt-4o-mini','chatgpt-4o-latest','gpt-4.1','gpt-4.1-mini','gpt-4.1-nano',
  'o1','o1-preview','o1-mini','o3','o3-mini','o4-mini',
  'gpt-5','gpt-5-mini','gpt-5-nano','gpt-5.1','gpt-5.2','gpt-5.4','gpt-5.4-mini','gpt-5.4-nano','gpt-5.5',
  'gpt-6-astra','gpt-6-luna','gpt-6.1-sol',
]);
function chatCatalogModel(provider: string, id: string, item: Record<string, unknown>): boolean {
  if (Array.isArray(item.supported_endpoints)) return item.supported_endpoints.some(endpoint => endpoint === 'chat/completions' || endpoint === '/v1/chat/completions' || endpoint === '/chat/completions');
  if (provider === 'custom-openai') return OPENAI_CHAT_MODELS.has(id) || OPENAI_CHAT_MODELS.has(id.replace(/-\d{4}-\d{2}-\d{2}$/, ''));
  if (provider === 'custom-deepinfra') {
    const tags = record(item.metadata).tags;
    if (!Array.isArray(tags)) return false;
    // Public /v1/models observed 2026-10-06: chat vs embed/image-gen/video-gen.
    return tags.includes('chat');
  }
  return true;
}

const LOCAL_NETWORK_CODES = new Set(["ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH", "ENOTFOUND", "EAI_AGAIN", "ETIMEDOUT", "UND_ERR_CONNECT_TIMEOUT"]);
/** Only transport evidence denotes an unreachable runtime. HTTP/protocol and
 * unknown failures retain their own errors; exception messages are never exposed. */
function localTransportUnreachable(error: unknown): boolean {
  if (!(error instanceof TypeError)) return false;
  const cause = error.cause;
  if (!(cause instanceof Error)) return false;
  const code = (cause as Error & {code?: unknown}).code;
  return typeof code === "string" && LOCAL_NETWORK_CODES.has(code);
}

function resolvePreset(providerId: string, config: ProxyConfig, customEndpoint?: string): ProviderSetupPreset {
  const known = PROVIDER_SETUP_PRESETS.find((p) => p.id === providerId);
  if (!known && !isUserDefinedProvider(providerId)) return fail("provider_unknown");
  const stored = (config.providers as Record<string, ProviderConfig>)[providerId]?.endpointUrl;
  const preset: ProviderSetupPreset = known ?? { id: providerId, label: providerId, endpointUrl: "", protocol: "openai", local: false };
  let endpoint = preset.id === "custom" || !known || preset.endpointRequired ? customEndpoint?.trim() || stored || "" : preset.endpointUrl;
  if (known && preset.id !== "custom" && !preset.endpointRequired && customEndpoint && customEndpoint.trim() !== preset.endpointUrl) return fail("provider_endpoint_fixed");
  if (!endpoint || endpoint.includes("example.invalid")) return fail("provider_endpoint_required");
  if (preset.endpointRequired) {
    let host: URL;
    try { host = new URL(endpoint); } catch { return fail('endpoint_url_invalid'); }
    assertEndpointCredentialFree(endpoint);
    const suffix = '.' + preset.endpointHostSuffix;
    const workspace = host.hostname.endsWith(suffix) ? host.hostname.slice(0, -suffix.length) : '';
    if (host.protocol !== 'https:' || host.port || host.search || host.hash || !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(workspace)
      || !['/', '/compatible-mode/v1', '/compatible-mode/v1/', '/compatible-mode/v1/chat/completions'].includes(host.pathname)) return fail('provider_endpoint_fixed');
    host.pathname = '/compatible-mode/v1/chat/completions'; endpoint = host.href;
  }
  if (preset.protocol === "openai") {
    let parsed: URL;
    try { parsed = new URL(endpoint); } catch { return fail("endpoint_url_invalid"); }
    if (!parsed.pathname.endsWith("/chat/completions")) parsed.pathname = `${parsed.pathname.replace(/\/(?:models)?$/, "").replace(/\/$/, "")}/chat/completions`;
    endpoint = parsed.href;
  }
  assertEndpointCredentialFree(endpoint);
  assertProviderEndpointUrl(providerId, endpoint);
  return { ...preset, get label() { return preset.id === "custom" ? t("provider_compatible") : preset.label; }, get notice() { return providerNoticeText(preset.id); }, endpointUrl: endpoint, local: isLocalEndpointUrl(endpoint) };
}

async function boundedJson(response: Response, signal: AbortSignal, limit = MAX_DISCOVERY_BYTES): Promise<unknown> {
  if (!response.body) return fail("provider_models_invalid");
  const reader = response.body.getReader();
  const buffers: Uint8Array[] = []; let size = 0;
  const abort = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", abort, { once: true });
  try {
    for (;;) {
      if (signal.aborted) return fail("provider_discovery_cancelled");
      const { done, value } = await reader.read();
      if (signal.aborted) return fail("provider_discovery_cancelled");
      if (done) break;
      size += value.byteLength;
      if (size > limit) return fail("provider_models_too_large");
      buffers.push(value);
    }
    try { return JSON.parse(Buffer.concat(buffers).toString("utf8")); }
    catch { return fail("provider_models_invalid"); }
  } finally { signal.removeEventListener("abort", abort); void reader.cancel().catch(() => undefined); reader.releaseLock(); }
}

/** Only bounded, documented machine codes cross the error boundary. Provider
 * messages, project names, key contents and other body fields never leave it. */
async function discoveryFailure(response: Response, preset: ProviderSetupPreset, signal: AbortSignal): Promise<never> {
  let code = response.status === 401 ? 'provider_key_rejected'
    : response.status === 403 ? 'provider_access_denied'
    : response.status === 429 ? 'provider_discovery_rate_limited'
    : response.status === 404 || response.status === 405 ? 'provider_discovery_unsupported'
    : response.status >= 500 ? 'provider_service_unavailable' : 'provider_discovery_failed';
  if (preset.discoveryFormat === 'dashscope' && response.status === 401) code = 'provider_region_or_key_rejected';
  if (preset.protocol === 'gemini' && [400, 401, 402, 403, 429].includes(response.status)) {
    try {
      const error = record(record(await boundedJson(response, signal, 16_384)).error);
      const details = Array.isArray(error.details) ? error.details.slice(0, 32) : [];
      const reasons = new Set(details.map(record)
        .filter(item => item['@type'] === 'type.googleapis.com/google.rpc.ErrorInfo')
        .map(item => item.reason));
      if (reasons.has('API_KEY_INVALID') || reasons.has('API_KEY_EXPIRED')) code = 'provider_key_rejected';
      else if (reasons.has('SERVICE_DISABLED')) code = 'provider_service_disabled';
      else if (reasons.has('BILLING_DISABLED') || response.status === 402) code = 'provider_billing_required';
      else if (['API_KEY_SERVICE_BLOCKED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'API_KEY_IP_ADDRESS_BLOCKED', 'API_KEY_ANDROID_APP_BLOCKED', 'API_KEY_IOS_APP_BLOCKED'].some(reason => reasons.has(reason))) code = 'provider_key_restricted';
      else if (error.status === 'PERMISSION_DENIED') code = 'provider_access_denied';
      else if (error.status === 'FAILED_PRECONDITION') code = 'provider_setup_required';
    } catch {
      if (signal.aborted) return fail('provider_discovery_cancelled');
      // Malformed/oversized errors retain the HTTP classification, not content.
    }
  } else await response.body?.cancel().catch(() => undefined);
  return fail(code);
}

async function discover(preset: ProviderSetupPreset, key: string, fetcher: typeof fetch, signal: AbortSignal): Promise<DiscoveredSetupModel[]> {
  const url = new URL(preset.discoveryUrl ?? preset.endpointUrl);
  if (url.origin !== new URL(preset.endpointUrl).origin) return fail('provider_endpoint_fixed');
  if (preset.protocol === "anthropic") { url.pathname = "/v1/models"; url.searchParams.set("limit", "100"); }
  else if (preset.protocol === "gemini") url.searchParams.set("pageSize", "1000");
  else if (preset.discoveryFormat === 'dashscope') {
    url.pathname = '/api/v1/models'; url.searchParams.set('capabilities', 'TG'); url.searchParams.set('page_no', '1'); url.searchParams.set('page_size', '100'); url.searchParams.set('language', 'en-US');
  } else if (!preset.discoveryUrl) url.pathname = url.pathname.replace(/\/chat\/completions\/?$/, "/models");
  if (preset.id === 'custom-siliconflow') { url.searchParams.set('type', 'text'); url.searchParams.set('sub_type', 'chat'); }
  const headers: Record<string, string> = { accept: "application/json" };
  if (key) {
    if (preset.protocol === "gemini") headers["x-goog-api-key"] = key;
    else if (preset.protocol === "anthropic") { headers["x-api-key"] = key; headers["anthropic-version"] = "2023-06-01"; }
    else headers.authorization = `Bearer ${key}`;
  }
  // OpenRouter /models is public and cannot validate a supplied key. Use its
  // official read-only key endpoint; no credits or account payload leave this function.
  if (preset.id === "openrouter") {
    const validation = await fetcher("https://openrouter.ai/api/v1/key", { method: "GET", redirect: "error", headers, signal });
    if (!validation.ok) return discoveryFailure(validation, preset, signal);
    const data = record(await boundedJson(validation, signal)).data;
    if (!data || typeof data !== "object" || Array.isArray(data)) return fail("provider_models_invalid");
  }
  if (preset.id === 'custom-deepinfra') {
    // /models is public. Authenticate with the documented read-only endpoint
    // first; the bounded account payload is discarded, never persisted/returned.
    const validation = await fetcher('https://api.deepinfra.com/v1/me', {method:'GET', redirect:'error', headers, signal});
    if (!validation.ok) return discoveryFailure(validation, preset, signal);
    const uid = record(await boundedJson(validation, signal, 65_536)).uid;
    if (typeof uid !== 'string' || !uid.trim() || uid.length > 256 || /[\x00-\x1f\x7f-\x9f]/.test(uid)) return fail('provider_models_invalid');
  }
  const models = new Map<string, DiscoveredSetupModel>(); const cursors = new Set<string>(); let received = 0;
  for (let page = 0; page < 256; page++) {
    const response = await fetcher(url, { method: "GET", redirect: "error", headers, signal });
    if (!response.ok) return discoveryFailure(response, preset, signal);
    const body = await boundedJson(response, signal); const obj = record(body);
    const output = record(obj.output);
    const entries = preset.discoveryFormat === 'dashscope' ? output.models : preset.protocol === "gemini" ? obj.models : Array.isArray(body) ? body : obj.data;
    if (!Array.isArray(entries)) return fail("provider_models_invalid");
    received += entries.length;
    for (const raw of entries) {
      const item = record(raw);
      if (preset.protocol === "gemini" && (!Array.isArray(item.supportedGenerationMethods) || !item.supportedGenerationMethods.includes("generateContent"))) continue;
      if (preset.id === "together" && typeof item.type === "string" && item.type !== "chat" && item.type !== "language") continue;
      // OVH's unified catalog also contains audio/image/embedding endpoints.
      // Its explicit zero output-token limit rules those out of chat without
      // guessing a model's purpose from its name or making a billed request.
      if (preset.id === "custom-ovhcloud" && item.max_completion_tokens === 0) continue;
      const architecture = record(item.architecture);
      if (Array.isArray(architecture.output_modalities) && !architecture.output_modalities.includes("text")) continue;
      if (preset.discoveryFormat === 'dashscope') {
        const modalities = record(item.inference_metadata).response_modality;
        if (Array.isArray(modalities) && !modalities.includes('Text')) continue;
        if (Array.isArray(item.capabilities) && !item.capabilities.includes('TG')) continue;
        if (!Array.isArray(item.capabilities) && !(Array.isArray(modalities) && modalities.includes('Text'))) continue;
        if (record(item.model_info).max_output_tokens === 0) continue;
      }
      const rawId = preset.discoveryFormat === 'dashscope' ? item.model : preset.protocol === "gemini" ? item.name : item.id;
      const id = typeof rawId === "string" ? rawId.replace(preset.protocol === "gemini" ? /^models\// : /^$/, "") : "";
      if (!MODEL_ID.test(id) || key && id.includes(key)) continue;
      // Meta's catalog includes other modalities and Contributor models, whose
      // selected tier permits training on submitted content. This standard-tier
      // coding preset offers only the documented standard text models returned
      // by the account; a broad /models response never opts into another tier.
      if (preset.id === 'custom-meta' && !preset.modelIds?.includes(id)) continue;
      if (!chatCatalogModel(preset.id, id, item)) continue;
      const rawName = item.displayName ?? item.display_name ?? item.name;
      const name = typeof rawName === "string" && !(key && rawName.includes(key)) ? rawName.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "").slice(0, 160) : undefined;
      models.set(id, Object.freeze({ id, ...(name && name !== id ? { name } : {}) }));
      if (models.size >= MAX_DISCOVERED_MODELS) break;
    }
    if (models.size >= MAX_DISCOVERED_MODELS) break;
    if (preset.discoveryFormat === 'dashscope') {
      if (!Number.isSafeInteger(output.total) || (output.total as number) < received || output.page_no !== page + 1) return fail('provider_models_invalid');
      if (received >= (output.total as number)) break;
      if (!entries.length) return fail('provider_models_invalid');
      if (page === 31) return fail('provider_models_too_large');
      url.searchParams.set('page_no', String(page + 2)); continue;
    }
    const next = preset.protocol === "gemini" ? obj.nextPageToken : preset.protocol === "anthropic" && obj.has_more === true ? obj.last_id : undefined;
    if (typeof next !== "string" || !next) break;
    if (next.length > 2048 || cursors.has(next)) return fail("provider_models_invalid");
    cursors.add(next);
    url.searchParams.set(preset.protocol === "gemini" ? "pageToken" : "after_id", next);
    if (page === 31) return fail("provider_models_too_large");
  }
  if (!models.size) return fail("provider_models_empty");
  return [...models.values()];
}

export function createProviderSetupService(deps: ProviderSetupDependencies): ProviderSetupService {
  const fetcher = deps.fetch ?? fetch; const readConfig = deps.loadConfig ?? loadConfig; const writeConfig = deps.updateConfig ?? updateConfig;
  const timeoutMs = deps.timeoutMs ?? 15_000;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) throw new Error("provider_setup_timeout_invalid");
  const reload = deps.reload ?? (async () => {
    const token = await deps.secrets.get("local:api-token");
    if (!token) return fail("provider_reload_required");
    try { if (await localAdminRequest("/local/config/reload", token, undefined, fetcher) !== 204) return fail("provider_reload_failed"); }
    catch { return fail("provider_reload_failed"); }
  });
  async function prepare(providerId: string, apiKey?: string, customEndpoint?: string, signal?: AbortSignal, manualModel?: string): Promise<PreparedProviderSetup> {
      let key = "";
      try {
        if (signal?.aborted) return fail("provider_discovery_cancelled");
        const config = await readConfig(); const preset = resolvePreset(providerId, config, customEndpoint);
        if (manualModel !== undefined) {
          if (!MODEL_ID.test(manualModel)) return fail("provider_model_invalid");
          if (preset.id === 'custom-meta' && !preset.modelIds?.includes(manualModel)) return fail('provider_model_invalid');
        }
        const providedKey = apiKey?.trim() ?? "";
        const priorEndpoint = (config.providers as Record<string, ProviderConfig>)[providerId]?.endpointUrl;
        // A saved key belongs to its configured destination; changing endpoints requires
        // explicit key entry instead of silently forwarding an existing credential.
        if (!providedKey && priorEndpoint && priorEndpoint !== preset.endpointUrl && !preset.local) return fail("provider_key_required");
        key = providedKey || await deps.secrets.get(`provider:${providerId}`) || "";
        const usesSavedKey = !providedKey && Boolean(key);
        if (!key && !preset.local) return fail("provider_key_required");
        key = normalizeProviderKey(key, providerId as ProviderName, preset.local);
        if (key && (preset.endpointUrl.includes(key) || manualModel?.includes(key))) return fail("provider_credential_in_metadata");
        const timeout = new AbortController(); const timer = setTimeout(() => timeout.abort(), timeoutMs);
        const discoverySignal = signal ? AbortSignal.any([signal, timeout.signal]) : timeout.signal;
        let models: DiscoveredSetupModel[];
        try {
          if (manualModel !== undefined) models = [{ id: manualModel }];
          else if (preset.discovery === 'manual') return fail('provider_discovery_unsupported');
          else if (preset.discovery === 'catalog') {
            // These official model identifiers are offered for selection, not
            // presented as a successful authentication or live discovery. No
            // billed inference or undocumented /models probe is used at setup.
            models = (preset.modelIds ?? []).filter(id => MODEL_ID.test(id) && !(key && id.includes(key))).map(id => Object.freeze({id}));
            if (!models.length) return fail('provider_models_empty');
          } else models = await discover(preset, key, fetcher, discoverySignal);
        }
        catch (error) {
          if (signal?.aborted) return fail("provider_discovery_cancelled");
          if (timeout.signal.aborted) return fail("provider_discovery_timeout");
          if (error instanceof ProviderSetupError) throw error;
          if (preset.local && localTransportUnreachable(error)) return fail("provider_runtime_unreachable");
          if (!preset.local && error instanceof TypeError) return fail('provider_network_unreachable');
          return fail("provider_discovery_failed");
        } finally { clearTimeout(timer); }
        const discoveredIds = new Set(models.map((model) => model.id));
        let disposed = false; let committing = false; let savedModel: string | undefined;
        const dispose = () => { disposed = true; key = ""; signal?.removeEventListener("abort", dispose); };
        signal?.addEventListener("abort", dispose, { once: true });
        const routingComboId = `tui-${providerId}`;
        return {
          providerId, get label() { return preset.label; }, endpointUrl: preset.endpointUrl, models: Object.freeze(models), usesSavedKey, get notice() { return preset.notice; }, source: manualModel === undefined && preset.discovery !== 'catalog' ? "discovered" : "declared",
          dispose,
          async commit(modelId, options) {
            if (disposed || signal?.aborted) return fail("provider_setup_expired");
            if (committing) return fail("provider_setup_busy");
            if (!discoveredIds.has(modelId)) return fail("provider_model_not_discovered");
            if (!options.acceptNotice) return fail("provider_notice_required");
            committing = true;
            try {
              if (!savedModel) {
                const updater: typeof updateConfig = (mutator) => writeConfig((current) => {
                  if (disposed || signal?.aborted) return fail("provider_setup_expired");
                  if (isOptionalProvider(providerId)) ensureProviderEntry(current, providerId);
                  else if (isUserDefinedProvider(providerId)) ensureUserDefinedProviderEntry(current, providerId);
                  else if (!isCoreProvider(providerId)) return fail("provider_unknown");
                  const entry = (current.providers as Record<string, ProviderConfig>)[providerId]!;
                  // Registry permits 256 enabled model ids. Discovery stays complete in the picker;
                  // selecting a newly discovered model adds it without dropping configured models.
                  const existing = entry.configured ? entry.models.filter((id) => id !== modelId) : [];
                  entry.models = [modelId, ...existing.slice(0, 255)]; entry.defaultModel = modelId;
                  if (!isCoreProvider(providerId)) entry.endpointUrl = preset.endpointUrl;
                  if (isNamedExperimentalProvider(providerId)) acceptNamedProviderRisk(entry, providerId);
                  if (providerId === "gemini") { entry.privacyAcceptedAt = new Date().toISOString(); entry.privacyNoticeVersion = GEMINI_FREE_PRIVACY_NOTICE_VERSION; }
                  mutator(current);
                  if (!current.fallbackOrder.includes(providerId as ProviderName)) current.fallbackOrder.push(providerId as ProviderName);
                  current.routingCombos ??= {};
                  current.routingCombos[routingComboId] = { id: routingComboId, revision: (current.routingCombos[routingComboId]?.revision ?? 0) + 1,
                    name: `${preset.label} · TUI`, mode: "fixed", modelOrder: [modelId], providerOrderByModel: { [modelId]: [providerId as ProviderName] },
                    allowModelFallback: false, allowProviderFallback: false, maxAttempts: 3 };
                });
                await enableProvider(providerId as ProviderName, key, deps.secrets, updater,
                  deps.invalidate ? { invalidateProvider: (id) => deps.invalidate!(id) } : undefined, preset.local);
                savedModel = modelId; key = "";
              } else if (savedModel !== modelId) {
                // A failed reload keeps this picker open. Another explicit choice
                // changes the saved destination without enabling the provider again
                // or rewriting the credential already held by the native vault.
                if (!preset.local && !await deps.secrets.get(`provider:${providerId}`)) return fail("provider_key_required");
                await writeConfig((current) => {
                  if (disposed || signal?.aborted) return fail("provider_setup_expired");
                  const entry = (current.providers as Record<string, ProviderConfig>)[providerId];
                  if (!entry?.configured || !entry.enabled || !isCoreProvider(providerId) && entry.endpointUrl !== preset.endpointUrl) return fail("provider_setup_expired");
                  const existing = entry.models.filter((id) => id !== modelId);
                  entry.models = [modelId, ...existing.slice(0, 255)]; entry.defaultModel = modelId;
                  current.routingCombos ??= {};
                  current.routingCombos[routingComboId] = { id: routingComboId, revision: (current.routingCombos[routingComboId]?.revision ?? 0) + 1,
                    name: `${preset.label} · TUI`, mode: "fixed", modelOrder: [modelId], providerOrderByModel: { [modelId]: [providerId as ProviderName] },
                    allowModelFallback: false, allowProviderFallback: false, maxAttempts: 3 };
                });
                savedModel = modelId;
              }
              await reload();
              dispose();
              return { providerId, modelId, routingComboId, reloaded: true };
            } catch (error) {
              if (error instanceof ProviderSetupError) throw error;
              return fail("provider_save_failed");
            } finally { committing = false; }
          },
        };
      } catch (error) {
        key = "";
        if (error instanceof ProviderSetupError) throw error;
        const safeCodes = ["provider_key_invalid", "endpoint_credentials_forbidden", "endpoint_url_invalid", "endpoint_https_required", "endpoint_protocol_forbidden", "endpoint_provider_forbidden"];
        return fail(error instanceof Error && safeCodes.includes(error.message) ? error.message : "provider_setup_failed");
      }
  }
  return {
    prepare,
    prepareManual: (providerId, apiKey, customEndpoint, modelId, signal) => prepare(providerId, apiKey, customEndpoint, signal, modelId.trim()),
    async disconnect(providerId, connectionId = providerId, daemonUrl = "http://127.0.0.1:21435", expectedRevision) {
      // This vault's existing native manager/reload owns the default local daemon only.
      // Never mutate its files while the terminal is attached to a different daemon.
      if (daemonUrl !== "http://127.0.0.1:21435") return fail("provider_disconnect_unavailable");
      if (!isCoreProvider(providerId) && !isOptionalProvider(providerId) && !isUserDefinedProvider(providerId)) return fail("provider_unknown");
      if (connectionId !== providerId && !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(connectionId)) return fail("provider_connection_not_found");
      // The frontend's scoped TUI token is never upgraded. The native setup service already owns this vault.
      const admin = await deps.secrets.get("local:api-token");
      if (!admin || !/^utk_local_[A-Za-z0-9_-]{32}$/.test(admin)) return fail("provider_disconnect_unavailable");
      async function request(path: string, body?: unknown): Promise<Record<string, unknown>> {
        const signal = AbortSignal.timeout(5_000);
        try {
          const response = await fetcher(new URL(path, "http://127.0.0.1:21435"), { method: body === undefined ? "GET" : "POST", redirect: "error", signal,
            headers: { authorization: `Bearer ${admin}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
            ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
          const value = record(await boundedJson(response, signal, 262_144));
          if (response.status === 409) return fail("provider_connection_conflict");
          if (!response.ok) return fail("provider_disconnect_failed");
          return value;
        } catch (error) { if (error instanceof ProviderSetupError) throw error; return fail("provider_disconnect_failed"); }
      }
      const listed = await request("/local/connections");
      const profiles = (Array.isArray(listed.connections) ? listed.connections : []).map(record);
      const resolvedId = connectionId === providerId ? defaultProfileId(providerId) : connectionId;
      const row = profiles.find(item => item.id === resolvedId);
      if (connectionId === providerId && !row) {
        // A legacy target may not widen into a provider-wide revoke when saved accounts exist.
        if (profiles.some(item => item.providerId === providerId)) return fail("provider_connection_conflict");
        try {
          await revokeProvider(providerId, deps.secrets, writeConfig, deps.invalidate ? { invalidateProvider: id => deps.invalidate!(id) } : undefined);
          await reload();
          return;
        } catch { return fail("provider_disconnect_failed"); }
      }
      if (!row || row.providerId !== providerId || !Number.isSafeInteger(row.revision)) return fail("provider_connection_not_found");
      // Confirmation is bound to the displayed credential revision, not a replacement key found later.
      if (!Number.isSafeInteger(expectedRevision) || row.revision !== expectedRevision) return fail("provider_connection_conflict");
      const result = await request(`/local/connections/${encodeURIComponent(resolvedId)}/revoke`, { revision: expectedRevision });
      if (result.revoked !== true || result.providerId !== providerId) return fail("provider_disconnect_failed");
    },
  };
}
