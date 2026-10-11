import type { ProviderName, ProxyConfig } from "./types.ts";

export const LOCAL_MODEL_ALIAS_TAGS = ["local", "gemma", "qwen", "llama", "phi", "deepseek", "mistral"] as const;
export type LocalModelAliasTag = (typeof LOCAL_MODEL_ALIAS_TAGS)[number];

export type LocalModelAliasResolution =
  | { kind: "none" }
  | { kind: "resolved"; tag: LocalModelAliasTag; model: string; runtime: "ollama" | "vllm" }
  | { kind: "unresolved"; tag: LocalModelAliasTag };

/** Virtual alias ids exposed on /v1/models — resolve to a local runtime model, not cloud providers. */
export const LOCAL_VIRTUAL_ALIAS_IDS = ["@local", "@gemma", "@qwen", "@llama", "@phi", "@deepseek", "@mistral", "local", "gemma", "qwen", "llama", "phi", "deepseek", "mistral"] as const;

export function isLocalModelAlias(model?: string): boolean {
  if (typeof model !== "string") return false;
  return normalizeAliasTag(model) !== undefined;
}

function normalizeAliasTag(raw: string): LocalModelAliasTag | undefined {
  const stripped = raw.startsWith("@") ? raw.slice(1) : raw;
  const lower = stripped.toLowerCase();
  return (LOCAL_MODEL_ALIAS_TAGS as readonly string[]).includes(lower) ? lower as LocalModelAliasTag : undefined;
}

function localRuntimeReady(config: ProxyConfig, name: "ollama" | "vllm"): boolean {
  const entry = config.providers[name];
  return entry?.enabled === true && entry.configured === true;
}

function matchTagInModels(tag: Exclude<LocalModelAliasTag, "local">, models: readonly string[]): string | undefined {
  const needle = tag.toLowerCase();
  const ranked = models
    .filter((id) => {
      const lower = id.toLowerCase();
      return lower === needle || lower.startsWith(needle) || lower.includes(needle);
    })
    .sort((a, b) => a.length - b.length || a.localeCompare(b));
  return ranked[0];
}

/**
 * Resolve local family aliases (with or without @) against configured local runtimes only.
 * Cloud deepseek/mistral providers are unrelated to local tags that may share family names.
 */
export function resolveLocalModelAlias(model: string | undefined, config: ProxyConfig): LocalModelAliasResolution {
  if (typeof model !== "string") return { kind: "none" };
  const tag = normalizeAliasTag(model);
  if (!tag) return { kind: "none" };

  const order: Array<"ollama" | "vllm"> = ["ollama", "vllm"];

  if (tag === "local") {
    for (const runtime of order) {
      if (!localRuntimeReady(config, runtime)) continue;
      const entry = config.providers[runtime]!;
      return { kind: "resolved", tag, model: entry.defaultModel, runtime };
    }
    return { kind: "unresolved", tag };
  }

  for (const runtime of order) {
    if (!localRuntimeReady(config, runtime)) continue;
    const entry = config.providers[runtime]!;
    const match = matchTagInModels(tag, entry.models);
    if (match) return { kind: "resolved", tag, model: match, runtime };
  }

  for (const runtime of order) {
    if (!localRuntimeReady(config, runtime)) continue;
    const entry = config.providers[runtime]!;
    if (matchTagInModels(tag, [entry.defaultModel])) {
      return { kind: "resolved", tag, model: entry.defaultModel, runtime };
    }
  }

  return { kind: "unresolved", tag };
}

/** Prefer enabled+configured local runtimes (ollama then vllm), then the rest of the order. */
export function preferLocalRuntimesOrder(order: ProviderName[], config: ProxyConfig): ProviderName[] {
  const ready: ProviderName[] = [];
  for (const name of ["ollama", "vllm"] as const) {
    if (localRuntimeReady(config, name)) ready.push(name);
  }
  if (ready.length === 0) return order;
  const without = order.filter((name) => name !== "ollama" && name !== "vllm");
  return [...ready, ...without];
}

/** Local-only order for alias routing: ollama then vllm when ready; never cloud. */
export function localAliasProviderOrder(config: ProxyConfig): ProviderName[] {
  const order: ProviderName[] = [];
  for (const name of ["ollama", "vllm"] as const) {
    if (localRuntimeReady(config, name)) order.push(name);
  }
  return order;
}
