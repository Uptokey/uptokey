import { isLocalEndpointUrl } from "../endpoint-policy.ts";
import type { ProxyConfig } from "../types.ts";

export const OLLAMA_STARTER_MODEL = "qwen3:0.6b";
export const OLLAMA_STARTER_CONTROL = "ollama-openai-effort-v1";

export function hasOllamaStarterControl(config: ProxyConfig, model: unknown): boolean {
  const ollama = config.providers.ollama;
  return model === OLLAMA_STARTER_MODEL && ollama?.enabled === true && ollama.configured === true
    && ollama.models.includes(OLLAMA_STARTER_MODEL) && typeof ollama.endpointUrl === "string"
    && isLocalEndpointUrl(ollama.endpointUrl);
}

export function isOllamaStarterEffort(value: unknown): value is "none" | "high" {
  return value === "none" || value === "high";
}
