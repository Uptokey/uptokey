import { LocalRuntimeRegistry } from "./registry.ts";
import { OllamaRuntimeAdapter, OpenAICompatibleLocalRuntimeAdapter, VllmRuntimeAdapter } from "./builtins.ts";

/** Runtimes locais em totalidade (visão do Autor 30/09): caminhos loopback padrão,
 *  configuráveis pela conexão local. Detecção falha fechada; nenhuma varredura de LAN. */
export const COMPAT_RUNTIME_DEFAULTS: ReadonlyArray<{ id: "lm-studio" | "jan" | "llama.cpp"; endpoint: string }> = [
  { id: "lm-studio", endpoint: "http://127.0.0.1:1234/v1/chat/completions" },
  { id: "jan", endpoint: "http://127.0.0.1:1337/v1/chat/completions" },
  { id: "llama.cpp", endpoint: "http://127.0.0.1:8080/v1/chat/completions" },
];

export function createDefaultLocalRuntimeRegistry(options: { ollamaEndpoint?: string; vllmEndpoint?: string } = {}): LocalRuntimeRegistry {
  const registry = new LocalRuntimeRegistry();
  registry.register(new OllamaRuntimeAdapter(options.ollamaEndpoint));
  registry.register(new VllmRuntimeAdapter(options.vllmEndpoint));
  for (const runtime of COMPAT_RUNTIME_DEFAULTS) {
    registry.register(new OpenAICompatibleLocalRuntimeAdapter(runtime.id, runtime.endpoint));
  }
  return registry;
}
