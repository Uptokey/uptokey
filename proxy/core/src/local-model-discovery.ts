import { readBoundedJson } from "@uptokey/sync-contract/limits";
import { ollamaLocalModelReference } from "./adapters.ts";
import { inferenceFetch } from "./streaming-transport.ts";

export type InstalledModel = {name: string; sizeBytes: number; digest?: string};
export const DEFAULT_OLLAMA_CHAT_ENDPOINT = "http://127.0.0.1:11434/v1/chat/completions";
export function isOllamaChatCandidateId(value: string | null): value is string {
  return value !== null && value.length <= 200 && /^[A-Za-z0-9][A-Za-z0-9._/-]*(?::[A-Za-z0-9._-]+)?$/.test(value);
}

const directOllamaFetch = (url: URL, init: RequestInit) => inferenceFetch(url, init, false, true);

/** Runtime hint only. Match it against the current installed digest before use. */
export async function runningDefaultOllamaModels(signal: AbortSignal, fetcher = directOllamaFetch): Promise<ReadonlyMap<string, string>> {
  const models = new Map<string, string>();
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(350)]);
  try {
    const response = await fetcher(new URL("/api/ps", DEFAULT_OLLAMA_CHAT_ENDPOINT), {
      redirect: "error", credentials: "omit", signal: deadline,
    });
    if (!response.ok) { void response.body?.cancel().catch(() => {}); return models; }
    const parsed = await readBoundedJson(response, 128 * 1024, 350);
    if (!parsed.ok || deadline.aborted) return models;
    const rows = (parsed.value as { models?: unknown } | null)?.models;
    if (!Array.isArray(rows) || rows.length > 64) return models;
    const usefulUntil = Date.now() + 2000;
    for (const row of rows) {
      if (typeof row?.name !== "string" || !isOllamaChatCandidateId(row.name) || typeof row.digest !== "string" ||
          !/^[a-f0-9]{64}$/i.test(row.digest) || typeof row.expires_at !== "string" || !(Date.parse(row.expires_at) > usefulUntil)) continue;
      models.set(row.name, row.digest.toLowerCase());
    }
  } catch { /* An unavailable runtime hint leaves the normal ranking intact. */ }
  return models;
}

/** Confirms local chat support without loading the model or sending a prompt. */
export async function verifyDefaultOllamaChat(modelId: string, signal: AbortSignal, fetcher = directOllamaFetch): Promise<boolean> {
  return await probeDefaultOllamaChat(modelId, signal, fetcher) === "verified";
}

export async function probeDefaultOllamaChat(modelId: string, signal: AbortSignal, fetcher = directOllamaFetch): Promise<"verified" | "retryable" | "rejected"> {
  if (!isOllamaChatCandidateId(modelId)) return "rejected";
  const model = ollamaLocalModelReference(modelId);
  if (!model) return "rejected";
  const deadline = AbortSignal.any([signal, AbortSignal.timeout(1500)]);
  try {
    const response = await fetcher(new URL("/api/show", DEFAULT_OLLAMA_CHAT_ENDPOINT), {
      method: "POST", redirect: "error", credentials: "omit", signal: deadline,
      headers: { "content-type": "application/json" }, body: JSON.stringify({ model, verbose: false }),
    });
    if (!response.ok) {
      void response.body?.cancel().catch(() => {});
      return response.status >= 500 || [404, 408, 429].includes(response.status) ? "retryable" : "rejected";
    }
    const parsed = await readBoundedJson(response, 256 * 1024, 1500);
    if (deadline.aborted) return "retryable";
    if (!parsed.ok || !parsed.value || typeof parsed.value !== "object") return "rejected";
    const details = parsed.value as Record<string, unknown>;
    return Array.isArray(details.capabilities) && details.capabilities.includes("completion") &&
      !details.capabilities.includes("image") && typeof details.template === "string" && details.template.trim().length > 0 &&
      (details.remote_host === undefined || details.remote_host === "") && (details.remote_model === undefined || details.remote_model === "")
      ? "verified" : "rejected";
  } catch { return "retryable"; }
}

/** Discovers tags from a configured loopback Ollama endpoint. */
export async function discoverLocalModels(signal?: AbortSignal, fetcher: typeof fetch = fetch, endpoint = "http://127.0.0.1:11434"): Promise<{status: "available" | "unreachable" | "invalid_response"; models: InstalledModel[]}> {
  let base: URL;
  try {
    base = new URL(endpoint);
    if (base.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(base.hostname)) throw new Error("non-loopback");
    // Adapters store a chat-completions URL; discovery lives at the runtime root.
    if (base.pathname.endsWith("/v1/chat/completions")) base.pathname = base.pathname.slice(0, -"/v1/chat/completions".length);
  } catch { return {status: "unreachable", models: []}; }
  base.pathname = `${base.pathname.replace(/\/$/, "")}/api/tags`;
  let response: Response;
  try {
    response = await fetcher(base.toString(), {
      method: "GET", redirect: "error", headers: {Accept: "application/json"},
      signal: AbortSignal.any([AbortSignal.timeout(3000), ...(signal ? [signal] : [])]),
    });
  } catch {return {status: "unreachable", models: []};}
  if (!response.ok || !response.body) {await response.body?.cancel().catch(() => {}); return {status: "unreachable", models: []};}
  const reader = response.body.getReader();
  try {
    const decoder = new TextDecoder();
    let text = "", bytes = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      bytes += part.value.byteLength;
      if (bytes > 512_000) throw new Error("oversized");
      text += decoder.decode(part.value, {stream: true});
    }
    text += decoder.decode();
    const data = JSON.parse(text);
    if (!Array.isArray(data?.models) || data.models.length > 200) throw new Error("invalid");
    const models = new Map<string, InstalledModel>();
    for (const item of data.models) {
      if (typeof item?.name !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(item.name) || !Number.isSafeInteger(item.size) || item.size < 0) throw new Error("invalid");
      if (item.digest !== undefined && (typeof item.digest !== "string" || !/^[a-fA-F0-9]{64}$/.test(item.digest))) throw new Error("invalid");
      models.set(item.name, {name: item.name, sizeBytes: item.size, ...(item.digest === undefined ? {} : {digest: item.digest.toLowerCase()})});
    }
    return {status: "available", models: [...models.values()]};
  } catch {return {status: "invalid_response", models: []};}
  finally {await reader.cancel().catch(() => {}); reader.releaseLock();}
}
