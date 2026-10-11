import { isLocalHostname } from "./endpoint-policy.ts";

export type VllmDiscoveredModel = { id: string; estimatedSizeBytes: null };

const DEFAULT_VLLM_MODELS_URL = "http://127.0.0.1:8000/v1/models";
const MODEL_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/;

/** Derive OpenAI models list URL from a configured chat-completions endpoint (or any URL on the same origin). */
export function vllmModelsUrlFromEndpoint(endpointUrl: string | undefined): string {
  if (!endpointUrl) return DEFAULT_VLLM_MODELS_URL;
  try {
    const parsed = new URL(endpointUrl);
    if ((parsed.protocol !== "http:" && parsed.protocol !== "https:") || parsed.username || parsed.password || !isLocalHostname(parsed.hostname)) {
      return DEFAULT_VLLM_MODELS_URL;
    }
    parsed.pathname = "/v1/models";
    parsed.search = "";
    parsed.hash = "";
    return parsed.href;
  } catch {
    return DEFAULT_VLLM_MODELS_URL;
  }
}

/** OpenAI-compatible model list for a local vLLM server. Fail-closed; no downloads. */
export async function discoverVllmModels(
  endpointUrl?: string,
  signal?: AbortSignal,
  fetcher: typeof fetch = fetch
): Promise<{ status: "available" | "unreachable" | "invalid_response"; runtime: "vllm"; models: VllmDiscoveredModel[] }> {
  const url = vllmModelsUrlFromEndpoint(endpointUrl);
  let response: Response;
  try {
    response = await fetcher(url, {
      method: "GET",
      redirect: "error",
      headers: { Accept: "application/json" },
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
    });
  } catch {
    return { status: "unreachable", runtime: "vllm", models: [] };
  }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    return { status: "unreachable", runtime: "vllm", models: [] };
  }
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let text = "";
    let bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512_000) throw new Error("oversized");
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    const list = Array.isArray(data?.data) ? data.data : Array.isArray(data?.models) ? data.models : null;
    if (!list || list.length > 200) throw new Error("invalid");
    const models = new Map<string, VllmDiscoveredModel>();
    for (const item of list) {
      const id = typeof item?.id === "string" ? item.id : typeof item?.name === "string" ? item.name : null;
      if (!id || !MODEL_ID_RE.test(id)) throw new Error("invalid");
      models.set(id, { id, estimatedSizeBytes: null });
    }
    return { status: "available", runtime: "vllm", models: [...models.values()] };
  } catch {
    return { status: "invalid_response", runtime: "vllm", models: [] };
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
