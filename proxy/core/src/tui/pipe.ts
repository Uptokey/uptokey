/**
 * Uptokey TUI — non-interactive (batch/pipe) mode.
 *
 *   echo "explique src/index.ts" | uptokey tui --pipe --cwd <pasta>
 *   (automação: UPTOKEY_TUI_TOKEN=<credencial pareada> fornece a identidade explicitamente)
 *
 * Reuses the same controller as the interactive TUI (identity, exact project
 * binding, @ context read by the core, canonical conversation). It never
 * pairs silently or waits for an invisible dialog, never applies changes
 * (proposals are reported, not written) and never retries a send.
 *
 * stdout: JSONL, contract version 1 (one event per line, UTF-8).
 * stderr: short sanitized diagnostics.
 *
 * Exit codes:
 *   0 success · 1 model/upstream error · 2 invalid input (empty or too large)
 *   3 local service unavailable · 4 identity/pairing required · 5 interrupted
 */
import { TuiClient, discoverCoreUrl } from "./client.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

export const PIPE_CONTRACT_VERSION = 1;
export const PIPE_MAX_INPUT_BYTES = 1_048_576;

export interface JsonlEvent {
  version: 1;
  type: "meta" | "text" | "proposal" | "notice" | "error" | "done";
  timestamp: string;
  data: string;
  model?: string;
  conversationId?: string;
  requestId?: string;
  code?: string;
}

export interface PipeIo {
  stdin: AsyncIterable<Buffer | string>;
  out: (line: string) => void;
  err: (line: string) => void;
  signal?: AbortSignal;
}

const defaultIo = (): PipeIo => ({
  stdin: process.stdin,
  out: (line) => { process.stdout.write(line, "utf8"); },
  err: (line) => { process.stderr.write(line, "utf8"); },
});

export async function runPipe(opts: {
  port?: number;
  model?: string;
  project?: string;
  cwd?: string;
  temporary?: boolean;
  external?: boolean;
  /** Test seam: identity resolution (defaults to the stored TUI identity, never pairing). */
  resolveIdentity?: (client: TuiClient) => Promise<string | undefined>;
  baseUrl?: string;
}, io: PipeIo = defaultIo()): Promise<number> {
  const emit = (event: Omit<JsonlEvent, "version" | "timestamp">) => io.out(`${JSON.stringify({ version: PIPE_CONTRACT_VERSION, timestamp: new Date().toISOString(), ...event })}\n`);
  const diag = (message: string) => io.err(`uptokey: ${sanitizeForDisplay(message).replace(/\n/g, " ")}\n`);
  const url = opts.baseUrl ?? discoverCoreUrl(opts.port);

  // 1. Service and identity first: nothing is read or sent without them.
  const probe = new TuiClient({ baseUrl: url });
  let token: string | undefined;
  try {
    if ((await probe.health()).status !== "ok") { emit({ type: "error", data: "core_unavailable", code: "core_unavailable" }); diag(`serviço local indisponível em ${url}`); return 3; }
    token = await (opts.resolveIdentity ?? storedIdentity)(probe);
  } catch (error) {
    emit({ type: "error", data: "identity_unavailable", code: "identity_unavailable" });
    diag(`identidade da TUI indisponível (${error instanceof Error ? error.message : "erro"}); execute \`uptokey tui\` interativamente para parear`);
    return 4;
  } finally { probe.destroy(); }
  if (!token) {
    emit({ type: "error", data: "pairing_required", code: "pairing_required" });
    diag("nenhuma identidade da TUI pareada; execute `uptokey tui` interativamente e aprove o pareamento");
    return 4;
  }

  // 2. Bounded stdin (UTF-8), with cancellation.
  const chunks: Buffer[] = [];
  let size = 0;
  try {
    for await (const chunk of io.stdin) {
      if (io.signal?.aborted) { emit({ type: "error", data: "interrupted", code: "interrupted" }); return 5; }
      const buf = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk;
      size += buf.byteLength;
      if (size > PIPE_MAX_INPUT_BYTES) { emit({ type: "error", data: "input_too_large", code: "input_too_large" }); diag(`entrada maior que ${PIPE_MAX_INPUT_BYTES} bytes`); return 2; }
      chunks.push(buf);
    }
  } catch { /* closed/broken input: use what arrived */ }
  const input = new TextDecoder("utf-8").decode(Buffer.concat(chunks)).trim();
  if (!input) { emit({ type: "error", data: "empty_input", code: "empty_input" }); return 2; }

  // 3. Same controller as the interactive client, headless.
  const { TuiController } = await import("./controller.ts");
  const controller = new TuiController({
    cwd: opts.cwd ?? process.cwd(), baseUrl: url, token,
    ...(opts.project ? { projectHint: opts.project } : {}),
    ...(opts.model ? { model: opts.model } : {}),
    temporary: opts.temporary === true,
    ...(opts.external ? { processingPolicy: "external_allowed" as const } : {}),
  });
  const notices: string[] = [];
  controller.on("delta", (text: string) => emit({ type: "text", data: text }));
  try {
    const onAbort = () => controller.cancel();
    io.signal?.addEventListener("abort", onAbort, { once: true });
    await controller.start();
    if (controller.state.connection !== "authenticated") {
      emit({ type: "error", data: "identity_rejected", code: "identity_rejected" });
      return 4;
    }
    const model = controller.state.selectedModel || "auto";
    emit({ type: "meta", data: JSON.stringify({ core: url, model, project: controller.view.binding?.projectName ?? null, contract: PIPE_CONTRACT_VERSION }), model });
    await controller.submit(input);
    io.signal?.removeEventListener("abort", onAbort);
    const conversationId = controller.state.activeConversation?.id;
    for (const item of controller.items()) {
      if (item.kind === "notice") { notices.push(item.text); emit({ type: "notice", data: item.text, code: item.level }); }
    }
    const proposal = controller.view.proposal;
    if (proposal) emit({ type: "proposal", data: JSON.stringify({ files: proposal.files.map((f) => ({ path: f.path, added: f.added, removed: f.removed, created: f.before === null })), applied: false }), ...(conversationId ? { conversationId } : {}) });
    const last = controller.state.messages.at(-1);
    if (io.signal?.aborted || last?.interrupted === "cancelled") { emit({ type: "error", data: "interrupted", code: "interrupted" }); return 5; }
    if (!last || last.role !== "assistant" || last.interrupted) {
      emit({ type: "error", data: "response_incomplete", code: "response_incomplete", ...(conversationId ? { conversationId } : {}) });
      diag(notices.at(-1) ?? "resposta incompleta");
      return 1;
    }
    emit({ type: "done", data: "", model, ...(conversationId ? { conversationId } : {}) });
    return 0;
  } catch (error) {
    emit({ type: "error", data: error instanceof Error ? error.message.slice(0, 200) : "pipe_failed", code: "pipe_failed" });
    return 1;
  } finally {
    controller.dispose();
  }
}

/**
 * Existing TUI identity only. `UPTOKEY_TUI_TOKEN` (explicit headless automation,
 * e.g. CI) takes precedence and is never read from files or logged; otherwise
 * the stored administrative/paired/native identity. Never starts a pairing.
 */
async function storedIdentity(client: TuiClient): Promise<string | undefined> {
  const explicit = process.env.UPTOKEY_TUI_TOKEN;
  if (explicit !== undefined) {
    if (!/^utk_local_[A-Za-z0-9_.-]{32,120}$/.test(explicit)) throw new Error("tui_token_env_invalid");
    return await client.authenticate(explicit) ? explicit : undefined;
  }
  const { storedTuiToken } = await import("./auth.ts");
  return storedTuiToken(client);
}
