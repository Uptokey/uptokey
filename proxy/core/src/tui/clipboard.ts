/** Explicit user-requested clipboard export. Model output is data on stdin, never executable code. */
import { spawn } from "node:child_process";
import { basename, join } from "node:path";
import { setTimeout as delay } from 'node:timers/promises';
import { sanitizeForDisplay } from "./sanitize.ts";
import type { TranscriptItem } from "./transcript.ts";
import { t } from "./i18n.ts";

export type ClipboardScope = "response" | "conversation";
export type ClipboardWriter = (text: string) => Promise<void>;

/** Closed fenced block, without renderer chrome or fences. An offset chooses
 * the block under the source selection; otherwise use the last response block. */
export function transcriptCodeBlockText(items: readonly TranscriptItem[], point?: { itemId: string; offset: number }): string | null {
  const item = point ? items.find(item => item.id === point.itemId) : [...items].reverse().find(item => item.kind === "assistant" && item.text.trim());
  if (!item || item.kind !== "assistant" && item.kind !== "user") return null;
  const source = sanitizeForDisplay(item.text);
  let opening: { marker: string; size: number; from: number; content: number } | null = null;
  let offset = 0, last: string | null = null;
  for (const line of source.split("\n")) {
    const fence = /^\s*(`{3,}|~{3,})(.*)$/.exec(line);
    if (fence && !opening) opening = { marker: fence[1]![0]!, size: fence[1]!.length, from: offset, content: offset + line.length + 1 };
    else if (opening && fence && fence[1]![0] === opening.marker && fence[1]!.length >= opening.size && !fence[2]!.trim()) {
      const text = source.slice(opening.content, offset).replace(/\n$/, "");
      if (point && point.offset >= opening.from && point.offset <= offset + line.length) return text;
      last = text; opening = null;
    }
    offset += line.length + 1;
  }
  return point ? null : last;
}

/** Copy source Markdown, including code fences and text outside the visible viewport. */
export function transcriptClipboardText(items: readonly TranscriptItem[], scope: ClipboardScope = "response"): string {
  if (scope === "response") {
    for (let index = items.length - 1; index >= 0; index--) {
      const item = items[index]!;
      if (item.kind === "assistant" && item.text.trim().length > 0) return sanitizeForDisplay(item.text);
    }
    return "";
  }
  return items.flatMap(item => (item.kind === "assistant" || item.kind === "user") && item.text.trim().length > 0
    ? [`## ${item.kind === "user" ? t("speaker_user") : "Uptokey"}\n\n${sanitizeForDisplay(item.text)}`] : []).join("\n\n");
}

export interface ClipboardCommand { executable: string; args: string[] }
export type ClipboardErrorCode = 'clipboard_busy' | 'clipboard_permission_denied' | 'clipboard_timeout' | 'clipboard_write_failed' | 'clipboard_unavailable';

export class ClipboardWriteError extends Error {
  readonly code: ClipboardErrorCode;
  readonly backend: string;
  readonly exitCode: number | null;
  readonly elapsedMs: number;
  constructor(code: ClipboardErrorCode, backend: string, exitCode: number | null, elapsedMs: number) {
    super(code); this.name = 'ClipboardWriteError';
    this.code = code; this.backend = backend; this.exitCode = exitCode; this.elapsedMs = elapsedMs;
  }
}

/** No shell interpolation and no third-party clipboard dependency. */
export function clipboardCommands(platform: NodeJS.Platform, env: NodeJS.ProcessEnv): ClipboardCommand[] {
  if (platform === "win32") return [{
    executable: join(env.SystemRoot || env.SYSTEMROOT || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe"),
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-STA", "-Command",
      "$ErrorActionPreference='Stop'; try { [Console]::InputEncoding=[System.Text.UTF8Encoding]::new($false); Set-Clipboard -Value ([Console]::In.ReadToEnd()) } catch { $e=$_.Exception; while($null -ne $e) { [Console]::Error.WriteLine(('UPTOKEY_CLIPBOARD_HRESULT:{0}' -f $e.HResult)); $e=$e.InnerException }; exit 1 }"],
  }];
  if (platform === "darwin") return [{ executable: "/usr/bin/pbcopy", args: [] }];
  return [
    ...(env.WAYLAND_DISPLAY ? [{ executable: "wl-copy", args: ["--type", "text/plain;charset=utf-8"] }] : []),
    { executable: "xclip", args: ["-selection", "clipboard"] },
    { executable: "xsel", args: ["--clipboard", "--input"] },
  ];
}

/** Carries only a fixed error code and process metadata, never copied text/stderr. */
export function runClipboardCommand(command: ClipboardCommand, text: string): Promise<void> {
  const started = Date.now(), backend = basename(command.executable);
  return new Promise<void>((resolve, reject) => {
    const spawnFailure = (error: unknown) => {
      const code = (error as NodeJS.ErrnoException)?.code;
      return new ClipboardWriteError(code === 'ENOENT' ? 'clipboard_unavailable'
        : ['EACCES', 'EPERM'].includes(code ?? '') ? 'clipboard_permission_denied' : 'clipboard_write_failed', backend, null, Date.now() - started);
    };
    let child: ReturnType<typeof spawn>;
    try { child = spawn(command.executable, command.args, { windowsHide: true, shell: false, stdio: ["pipe", "ignore", "pipe"] }); }
    catch (error) { reject(spawnFailure(error)); return; }
    let diagnostic = '', settled = false;
    const finish = (error?: ClipboardWriteError) => {
      if (settled) return;
      settled = true; clearTimeout(timer); error ? reject(error) : resolve();
    };
    const fail = (code: ClipboardWriteError['code'], exitCode: number | null = null) => finish(new ClipboardWriteError(code, backend, exitCode, Date.now() - started));
    const timer = setTimeout(() => { child.kill(); fail('clipboard_timeout'); }, 5000);
    child.stderr!.on('data', chunk => { if (diagnostic.length < 2048) diagnostic += String(chunk).slice(0, 2048 - diagnostic.length); });
    child.once("error", error => finish(spawnFailure(error)));
    child.once("close", code => {
      if (code === 0) { finish(); return; }
      const codes = [...diagnostic.matchAll(/(?:^|\r?\n)UPTOKEY_CLIPBOARD_HRESULT:(-?\d+)(?=\r?\n|$)/g)].map(match => Number(match[1]));
      // CLIPBRD_E_CANT_OPEN is the precise transient clipboard-ownership failure.
      fail(codes.includes(-2147221040) ? 'clipboard_busy' : codes.includes(-2147024891) ? 'clipboard_permission_denied' : 'clipboard_write_failed', code);
    });
    child.stdin!.on("error", () => { /* process close/error owns the outcome */ });
    child.stdin!.end(Buffer.from(text, "utf8"));
  });
}

export const writeClipboard: ClipboardWriter = async text => {
  for (const command of clipboardCommands(process.platform, process.env)) {
    try {
      try { await runClipboardCommand(command, text); }
      catch (error) {
        if (!(error instanceof ClipboardWriteError) || error.code !== 'clipboard_busy') throw error;
        // Retry only the exact native ownership conflict, never permissions,
        // unavailable executables or unknown errors. Same bytes, at most twice.
        await delay(120);
        await runClipboardCommand(command, text);
      }
      return;
    } catch (error) {
      if (error instanceof ClipboardWriteError && error.code === 'clipboard_unavailable') continue;
      throw error;
    }
  }
  throw new ClipboardWriteError('clipboard_unavailable', 'none', null, 0);
};
