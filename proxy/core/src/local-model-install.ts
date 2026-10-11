export type ModelInstallProgress = {
  stage: "downloading" | "verifying" | "finishing" | "complete";
  completedBytes?: number;
  totalBytes?: number;
};

/** Registry identifiers only: no URL, port, shell syntax or additional flags. */
export function validInstallModel(value: unknown): value is string {
  return typeof value === "string" && value.length <= 200 &&
    /^(?:[A-Za-z0-9][A-Za-z0-9_-]*\/)?[A-Za-z0-9][A-Za-z0-9_.-]*(?::[A-Za-z0-9][A-Za-z0-9_.-]*)?$/.test(value);
}

/** Download through the installed local Ollama daemon. Never starts inference or edits routing. */
export async function installLocalModel(model: string, options: {
  confirmed: boolean;
  signal?: AbortSignal;
  onProgress?: (progress: ModelInstallProgress) => void;
  fetcher?: typeof fetch;
  endpointUrl?: string;
  /** Bounds connection/headers only; established transfers have no duration cap. */
  headerTimeoutMs?: number;
}): Promise<void> {
  if (!validInstallModel(model)) throw new Error("invalid_model");
  if (options.confirmed !== true) throw new Error("confirmation_required");
  const signal = options.signal ?? new AbortController().signal;
  const headerTimeoutMs = options.headerTimeoutMs ?? 30_000;
  if (!Number.isSafeInteger(headerTimeoutMs) || headerTimeoutMs <= 0 || headerTimeoutMs > 2_147_483_647) throw new Error("invalid_install_response");
  let endpoint: URL;
  try {
    endpoint = new URL(options.endpointUrl ?? "http://127.0.0.1:11434");
    if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) throw new Error("non-loopback");
    if (endpoint.pathname.endsWith("/v1/chat/completions")) endpoint.pathname = endpoint.pathname.slice(0, -"/v1/chat/completions".length);
    endpoint.pathname = `${endpoint.pathname.replace(/\/$/, "")}/api/pull`;
  } catch { throw new Error("ollama_endpoint_invalid"); }
  let response: Response;
  const headerDeadline = new AbortController();
  const headerTimer = setTimeout(() => headerDeadline.abort(), headerTimeoutMs);
  headerTimer.unref();
  try {
    signal.throwIfAborted();
    response = await (options.fetcher ?? fetch)(endpoint.toString(), {
      method: "POST", redirect: "error", signal: AbortSignal.any([signal, headerDeadline.signal]),
      headers: {"Content-Type": "application/json", Accept: "application/x-ndjson"},
      body: JSON.stringify({model, stream: true}),
    });
  } catch { throw new Error(signal.aborted ? "install_interrupted" : "ollama_unreachable"); }
  finally { clearTimeout(headerTimer); }
  if (!response.ok || !response.body) {
    await response.body?.cancel().catch(() => {});
    throw new Error(response.status === 404 ? "model_not_found" : "install_failed");
  }
  const reader = response.body.getReader();
  const cancel = () => { void reader.cancel().catch(() => {}); };
  signal.addEventListener("abort", cancel, {once: true});
  const decoder = new TextDecoder("utf-8", {fatal: true});
  let buffer = "";
  let success = false;
  const layers = new Map<string, {completed: number; total: number}>();
  let completedBytes = 0, totalBytes = 0;
  const accept = (line: string) => {
    if (!line.trim()) return;
    if (line.length > 16_384 || success) throw new Error("invalid_install_response");
    let value: Record<string, unknown>;
    try { value = JSON.parse(line); } catch { throw new Error("invalid_install_response"); }
    if (!value || typeof value !== "object" || Array.isArray(value) || value.error) throw new Error("install_failed");
    if (typeof value.status !== "string" || value.status.length > 200) throw new Error("invalid_install_response");
    const stage = value.status === "success" ? "complete" : value.status.startsWith("verifying") ? "verifying" :
      value.status.startsWith("pulling") ? "downloading" : "finishing";
    const progress: ModelInstallProgress = {stage};
    if (value.total !== undefined || value.completed !== undefined) {
      if (!Number.isSafeInteger(value.total) || (value.total as number) < 0 ||
          (value.completed !== undefined && (!Number.isSafeInteger(value.completed) || (value.completed as number) < 0 || (value.completed as number) > (value.total as number)))) throw new Error("invalid_install_response");
      if (value.digest !== undefined && (typeof value.digest !== "string" || !/^sha256:[a-fA-F0-9]{64}$/.test(value.digest))) throw new Error("invalid_install_response");
      const key = typeof value.digest === "string" ? value.digest.toLowerCase() : "untagged";
      const previous = layers.get(key);
      const total = value.total as number;
      const completed = (value.completed ?? previous?.completed ?? 0) as number;
      if (previous && (total !== previous.total || completed < previous.completed)) throw new Error("invalid_install_response");
      if (!previous && layers.size >= 1024) throw new Error("invalid_install_response");
      completedBytes += completed - (previous?.completed ?? 0);
      totalBytes += total - (previous?.total ?? 0);
      if (!Number.isSafeInteger(completedBytes) || !Number.isSafeInteger(totalBytes)) throw new Error("invalid_install_response");
      layers.set(key, {completed, total});
      progress.totalBytes = totalBytes;
      progress.completedBytes = completedBytes;
    }
    success = stage === "complete";
    if (!success) options.onProgress?.(progress);
  };
  try {
    for (;;) {
      signal.throwIfAborted();
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.value && part.value.byteLength > 1_048_576) throw new Error("invalid_install_response");
      buffer += decoder.decode(part.value, {stream: !part.done});
      let end: number;
      while ((end = buffer.indexOf("\n")) !== -1) {
        accept(buffer.slice(0, end)); buffer = buffer.slice(end + 1);
      }
      if (buffer.length > 16_384) throw new Error("invalid_install_response");
      if (part.done) { accept(buffer); break; }
    }
    if (!success) throw new Error("install_incomplete");
    options.onProgress?.({stage: "complete"});
  } catch (error) {
    if (signal.aborted) throw new Error("install_interrupted");
    if (error instanceof Error && ["install_failed", "install_incomplete", "invalid_install_response"].includes(error.message)) throw error;
    throw new Error("install_failed");
  } finally { signal.removeEventListener("abort", cancel); await reader.cancel().catch(() => {}); reader.releaseLock(); }
}
