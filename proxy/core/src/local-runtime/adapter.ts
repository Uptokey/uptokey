import type { LocalRuntimeCapabilities, LocalRuntimeId, LocalRuntimeModel, LocalRuntimeStatus } from "./types.ts";

export interface LocalRuntimeAdapter {
  readonly id: LocalRuntimeId;
  readonly endpointUrl: string;
  detect(signal?: AbortSignal): Promise<LocalRuntimeStatus>;
  health(signal?: AbortSignal): Promise<LocalRuntimeStatus>;
  capabilities(model?: string, signal?: AbortSignal): Promise<LocalRuntimeCapabilities>;
  listModels(signal?: AbortSignal): Promise<LocalRuntimeModel[]>;
  pullModel?(model: string, signal?: AbortSignal): Promise<void>;
  removeModel?(model: string, signal?: AbortSignal): Promise<void>;
  startModel?(model: string, signal?: AbortSignal): Promise<void>;
  stopModel?(model: string, signal?: AbortSignal): Promise<void>;
}
