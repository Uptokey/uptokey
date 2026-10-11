export type InstalledModel = {name: string; sizeBytes: number; digest?: string};

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
