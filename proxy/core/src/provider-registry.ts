/** Presets internos de ProviderName — fonte única para schema, router, cache, ledger e CLI.
 * Providers `custom-<slug>` continuam extensíveis sem exigir uma nova versão. */
export const CORE_PROVIDERS = ["groq", "gemini"] as const;
export const LOCAL_EXPERIMENTAL_PROVIDERS = ["ollama", "vllm"] as const;
// Presets remotos auditados apenas para uso user-managed (tier 3). Eles não são
// providers oficiais e permanecem default-OFF. OpenRouter entra como BYOK upstream
// (gateway de API/créditos do usuário), não como produto concorrente hospedado.
// Additional compatible presets use custom-* identities from the setup catalog.
export const NAMED_EXPERIMENTAL_PROVIDERS = ["deepseek", "mistral", "cerebras", "together", "anthropic", "openrouter"] as const;
export const RESEARCH_ONLY_PROVIDERS = [] as const;
export const CUSTOM_PROVIDERS = ["custom"] as const;
export const OPTIONAL_PROVIDERS = [...LOCAL_EXPERIMENTAL_PROVIDERS, ...NAMED_EXPERIMENTAL_PROVIDERS, ...CUSTOM_PROVIDERS] as const;
export const ALL_PROVIDERS = [...CORE_PROVIDERS, ...OPTIONAL_PROVIDERS] as const;

/** Maximum number of providers (preset + user-defined) allowed in config. */
export const MAX_PROVIDERS = 32;

/** User-defined provider name pattern: custom-<slug> where slug is 1-50 lowercase alphanumeric+hyphen. */
const USER_DEFINED_PATTERN = /^custom-[a-z0-9][a-z0-9-]{0,49}$/;
export function isUserDefinedProvider(value: unknown): value is string {
  return typeof value === "string" && USER_DEFINED_PATTERN.test(value) && !value.endsWith("-");
}

export type CoreProviderName = (typeof CORE_PROVIDERS)[number];
export type OptionalProviderName = (typeof OPTIONAL_PROVIDERS)[number];
export type NamedExperimentalProviderName = (typeof NAMED_EXPERIMENTAL_PROVIDERS)[number];
export type ResearchOnlyProviderName = (typeof RESEARCH_ONLY_PROVIDERS)[number];
export type ProviderName = (typeof ALL_PROVIDERS)[number];

export const NAMED_EXPERIMENTAL_DEFAULTS: Record<NamedExperimentalProviderName, {
  endpointUrl: string;
  models: string[];
  defaultModel: string;
  warning?: string;
}> = {
  deepseek: {
    endpointUrl: "https://api.deepseek.com/chat/completions",
    models: ["deepseek-chat", "deepseek-reasoner"],
    defaultModel: "deepseek-chat"
  },
  mistral: {
    endpointUrl: "https://api.mistral.ai/v1/chat/completions",
    models: ["mistral-small-latest", "mistral-large-latest"],
    defaultModel: "mistral-small-latest"
  },
  cerebras: {
    endpointUrl: "https://api.cerebras.ai/v1/chat/completions",
    models: ["llama3.1-8b", "llama3.3-70b"],
    defaultModel: "llama3.1-8b"
  },
  together: {
    endpointUrl: "https://api.together.xyz/v1/chat/completions",
    models: ["meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"],
    defaultModel: "meta-llama/Meta-Llama-3.1-8B-Instruct-Turbo"
  },
  anthropic: {
    endpointUrl: "https://api.anthropic.com/v1/messages",
    models: ["claude-sonnet-4-20250514", "claude-3-5-haiku-20241022", "claude-opus-4-20250514"],
    defaultModel: "claude-sonnet-4-20250514"
  },
  openrouter: {
    endpointUrl: "https://openrouter.ai/api/v1/chat/completions",
    models: [
      "openai/gpt-4o-mini",
      "google/gemini-2.0-flash-001",
      "anthropic/claude-3.5-sonnet",
      "meta-llama/llama-3.1-8b-instruct"
    ],
    defaultModel: "openai/gpt-4o-mini",
    warning: "User-managed BYOK gateway; configure additional model ids in the provider entry as needed."
  }
};

export function isCoreProvider(value: unknown): value is CoreProviderName {
  return value === "groq" || value === "gemini";
}

export function isOptionalProvider(value: unknown): value is OptionalProviderName {
  return typeof value === "string" && (OPTIONAL_PROVIDERS as readonly string[]).includes(value);
}

export function isNamedExperimentalProvider(value: unknown): value is NamedExperimentalProviderName {
  return typeof value === "string" && (NAMED_EXPERIMENTAL_PROVIDERS as readonly string[]).includes(value);
}

export function isResearchOnlyProvider(value: unknown): value is ResearchOnlyProviderName {
  return typeof value === "string" && (RESEARCH_ONLY_PROVIDERS as readonly string[]).includes(value);
}

export function isProvider(value: unknown): value is ProviderName {
  return typeof value === "string" && ((ALL_PROVIDERS as readonly string[]).includes(value) || isUserDefinedProvider(value));
}

export type LocalExperimentalProviderName = (typeof LOCAL_EXPERIMENTAL_PROVIDERS)[number];

export function isLocalExperimentalProvider(value: unknown): value is LocalExperimentalProviderName {
  return typeof value === "string" && (LOCAL_EXPERIMENTAL_PROVIDERS as readonly string[]).includes(value);
}
