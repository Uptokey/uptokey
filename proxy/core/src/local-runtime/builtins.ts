import { GenericOpenAIAdapter } from "../adapters.ts";
import { discoverLocalModels } from "../local-model-discovery.ts";
import { discoverVllmModels } from "../vllm-model-discovery.ts";
import { isLocalHostname } from "../endpoint-policy.ts";
import type { LocalRuntimeAdapter, LocalRuntimeInventory } from "./adapter.ts";
import type { LocalRuntimeCapabilities, LocalRuntimeId, LocalRuntimeModel, LocalRuntimeStatus } from "./types.ts";

const chatCaps: LocalRuntimeCapabilities = { chat: true, streaming: true, embeddings: false, vision: false, audio: false, toolCalling: false, modelPull: false };

async function compatibleInventory(runtime: LocalRuntimeId, endpoint: string, signal?: AbortSignal): Promise<LocalRuntimeInventory> {
  const result = await discoverVllmModels(endpoint, signal);
  const available = result.status === "available";
  return {
    status: { runtime, available, endpoint, error: available ? undefined : result.status },
    models: result.models.map(model => ({ id: model.id, runtime, capabilities: { ...chatCaps }, metadataBasis: "unknown" })),
  };
}

export class OllamaRuntimeAdapter extends GenericOpenAIAdapter implements LocalRuntimeAdapter {
  readonly id = "ollama" as const;
  constructor(endpointUrl = "http://127.0.0.1:11434/v1/chat/completions") { super("ollama", endpointUrl); }
  async inventory(signal?: AbortSignal): Promise<LocalRuntimeInventory> {
    const result = await discoverLocalModels(signal, fetch, this.endpointUrl);
    const available = result.status === "available";
    return {
      status: { runtime: this.id, available, endpoint: this.endpointUrl, error: available ? undefined : result.status },
      models: result.models.map(model => ({ id: model.name, runtime: this.id, sizeBytes: model.sizeBytes, digest: model.digest, capabilities: { ...chatCaps }, metadataBasis: "partial" })),
    };
  }
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return (await this.inventory(signal)).status; }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> { return (await this.inventory(signal)).models; }
}

export class VllmRuntimeAdapter extends GenericOpenAIAdapter implements LocalRuntimeAdapter {
  readonly id = "vllm" as const;
  constructor(endpointUrl = "http://127.0.0.1:8000/v1/chat/completions") { super("vllm", endpointUrl); }
  inventory(signal?: AbortSignal): Promise<LocalRuntimeInventory> { return compatibleInventory(this.id, this.endpointUrl, signal); }
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return (await this.inventory(signal)).status; }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> { return (await this.inventory(signal)).models; }
}

/** Adapter for any loopback server implementing OpenAI /v1/models and chat completions. */
export class OpenAICompatibleLocalRuntimeAdapter extends GenericOpenAIAdapter implements LocalRuntimeAdapter {
  readonly id: LocalRuntimeAdapter["id"];
  constructor(runtime: Exclude<LocalRuntimeAdapter["id"], "ollama" | "vllm">, endpointUrl: string) {
    let parsed: URL;
    try { parsed = new URL(endpointUrl); } catch { throw new Error("local_endpoint_invalid"); }
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || !isLocalHostname(parsed.hostname)) throw new Error("local_endpoint_remote_forbidden");
    super(runtime, endpointUrl);
    this.id = runtime;
  }
  inventory(signal?: AbortSignal): Promise<LocalRuntimeInventory> { return compatibleInventory(this.id, this.endpointUrl, signal); }
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return (await this.inventory(signal)).status; }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> { return (await this.inventory(signal)).models; }
}
