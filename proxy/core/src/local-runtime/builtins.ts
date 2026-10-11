import { GenericOpenAIAdapter } from "../adapters.ts";
import { discoverLocalModels } from "../local-model-discovery.ts";
import { discoverVllmModels } from "../vllm-model-discovery.ts";
import { isLocalHostname } from "../endpoint-policy.ts";
import type { LocalRuntimeAdapter } from "./adapter.ts";
import type { LocalRuntimeCapabilities, LocalRuntimeModel, LocalRuntimeStatus } from "./types.ts";

const chatCaps: LocalRuntimeCapabilities = { chat: true, streaming: true, embeddings: false, vision: false, audio: false, toolCalling: false, modelPull: false };

export class OllamaRuntimeAdapter extends GenericOpenAIAdapter implements LocalRuntimeAdapter {
  readonly id = "ollama" as const;
  constructor(endpointUrl = "http://127.0.0.1:11434/v1/chat/completions") { super("ollama", endpointUrl); }
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
    const result = await discoverLocalModels(signal, fetch, this.endpointUrl);
    return { runtime: this.id, available: result.status === "available", endpoint: this.endpointUrl, error: result.status === "available" ? undefined : result.status };
  }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> {
    const result = await discoverLocalModels(signal, fetch, this.endpointUrl);
    return result.models.map((model) => ({ id: model.name, runtime: this.id, sizeBytes: model.sizeBytes, capabilities: { ...chatCaps }, metadataBasis: "partial" as const }));
  }
}

export class VllmRuntimeAdapter extends GenericOpenAIAdapter implements LocalRuntimeAdapter {
  readonly id = "vllm" as const;
  constructor(endpointUrl = "http://127.0.0.1:8000/v1/chat/completions") { super("vllm", endpointUrl); }
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
    const result = await discoverVllmModels(this.endpointUrl, signal);
    return { runtime: this.id, available: result.status === "available", endpoint: this.endpointUrl, error: result.status === "available" ? undefined : result.status };
  }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> {
    const result = await discoverVllmModels(this.endpointUrl, signal);
    return result.models.map((model) => ({ id: model.id, runtime: this.id, capabilities: { ...chatCaps }, metadataBasis: "unknown" as const }));
  }
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
  async detect(signal?: AbortSignal): Promise<LocalRuntimeStatus> {
    const result = await discoverVllmModels(this.endpointUrl, signal);
    return { runtime: this.id, available: result.status === "available", endpoint: this.endpointUrl, error: result.status === "available" ? undefined : result.status };
  }
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus> { return this.detect(signal); }
  async capabilities(_model?: string, _signal?: AbortSignal): Promise<LocalRuntimeCapabilities> { return { ...chatCaps }; }
  async listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]> {
    const result = await discoverVllmModels(this.endpointUrl, signal);
    return result.models.map((model) => ({ id: model.id, runtime: this.id, capabilities: { ...chatCaps }, metadataBasis: "unknown" as const }));
  }
}
