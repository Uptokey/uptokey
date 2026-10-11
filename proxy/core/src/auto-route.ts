import type { ProviderName, ProxyConfig } from "./types.ts";
import { isProvider } from "./provider-registry.ts";

/** Virtual model ids resolved by the proxy — never sent upstream as model names. */
export const VIRTUAL_MODELS = ["auto", "uptokey-auto", "uptokey-fast", "uptokey-coder"] as const;
export type VirtualModelId = (typeof VIRTUAL_MODELS)[number];

const FAST_PREFERENCE = ["groq", "cerebras", "together", "mistral", "gemini", "deepseek", "anthropic", "ollama", "vllm", "openrouter", "custom*"] as const;
const CODER_PREFERENCE = ["ollama", "vllm", "deepseek", "anthropic", "groq", "together", "cerebras", "mistral", "gemini", "openrouter", "custom*"] as const;

export function isVirtualModel(model?: string): boolean {
  return typeof model === "string" && (VIRTUAL_MODELS as readonly string[]).includes(model);
}

/**
 * Reorder fallbackOrder for virtual models.
 * Membership stays within fallbackOrder except auto/uptokey-auto may prepend local runtimes
 * (ollama then vllm) when enabled+configured but absent from the order.
 */
export function resolveAutoProviderOrder(config: ProxyConfig, model?: string): ProviderName[] {
  const members: ProviderName[] = [];
  for (const name of config.fallbackOrder) {
    if (isProvider(name) && !members.includes(name)) members.push(name);
  }

  const virtual = typeof model === "string" ? model : undefined;
  if (virtual === "auto" || virtual === "uptokey-auto") {
    // Prepend in reverse so ollama ends up first, then vllm.
    for (const local of ["vllm", "ollama"] as const) {
      const entry = config.providers[local];
      if (entry?.enabled === true && entry.configured === true && !members.includes(local)) {
        members.unshift(local);
      }
    }
  }

  const preference =
    virtual === "uptokey-fast" ? FAST_PREFERENCE
    : virtual === "uptokey-coder" ? CODER_PREFERENCE
    : (["ollama", "vllm"] as const);

  const ranked = [...members].sort((a, b) => {
    const diff = preferenceRank(a, preference) - preferenceRank(b, preference);
    if (diff !== 0) return diff;
    return members.indexOf(a) - members.indexOf(b);
  });

  const ready: ProviderName[] = [];
  const rest: ProviderName[] = [];
  for (const name of ranked) {
    const entry = config.providers[name];
    if (entry?.enabled === true && entry.configured === true) ready.push(name);
    else rest.push(name);
  }
  return [...ready, ...rest];
}

/** When virtual, callers should pass undefined so provider.defaultModel is used. */
export function resolveRequestModel(requested: string | undefined, virtual: boolean): string | undefined {
  return virtual ? undefined : requested;
}

function preferenceRank(name: ProviderName, preference: readonly string[]): number {
  for (let i = 0; i < preference.length; i += 1) {
    const pref = preference[i]!;
    if (pref === "custom*") {
      if (name === "custom" || (typeof name === "string" && name.startsWith("custom-"))) return i;
    } else if (name === pref) return i;
  }
  return preference.length;
}
