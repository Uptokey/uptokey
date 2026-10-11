export type LocalRuntimeId = "ollama" | "vllm" | "llama.cpp" | "lm-studio" | "localai" | "jan" | "custom";

export interface LocalRuntimeCapabilities {
  chat: boolean;
  streaming: boolean;
  embeddings: boolean;
  vision: boolean;
  audio: boolean;
  toolCalling: boolean;
  modelPull: boolean;
}

export interface LocalRuntimeModel {
  id: string;
  runtime: LocalRuntimeId;
  sizeBytes?: number;
  capabilities: LocalRuntimeCapabilities;
  metadataBasis: "reported" | "partial" | "unknown";
}

export interface LocalRuntimeStatus {
  runtime: LocalRuntimeId;
  available: boolean;
  endpoint: string;
  version?: string;
  error?: string;
}
