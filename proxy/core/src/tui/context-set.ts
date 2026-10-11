/**
 * Uptokey TUI — inspectable context set.
 *
 * Files chosen by the person (via @, the file browser or an explicit
 * suggestion) stay in the context set until removed. Content is always read by
 * the core through the verified root, at add time (to validate and measure)
 * and again at dispatch (so the model sees the current version). The set keeps
 * only references and hashes in memory; content is not retained between turns.
 * A change of content between add and dispatch is reported, never hidden.
 */
import type { ContextReference } from "./conversations.ts";
import type { ProjectTextFile } from "./workspace.ts";
import { t } from "./i18n.ts";
import { selectedContextText, type ContextRange } from "./context-ranges.ts";
import { connectionText } from "./frontend/uptokey/integration-connections.ts";

export type ContextState = "reading" | "ready" | "missing" | "error" | "excluded";

export interface ContextEntry {
  id: string;
  relativePath: string;
  state: ContextState;
  sha256: string | null;
  byteLength: number;
  lines: number;
  language?: string;
  error?: string;
  /** Hash at dispatch differs from the hash when added. */
  changed: boolean;
  addedAt: number;
  ranges?: ContextRange[];
}

export interface DispatchSnapshot {
  references: ContextReference[];
  /** Data block appended to the user message (never persisted in the conversation). */
  block: string;
  bytes: number;
  notices: string[];
}

/** Aggregate content bound for one dispatch; larger sets are refused with a notice. */
export const CONTEXT_MAX_BYTES = 400 * 1024;

type Reader = (relativePath: string, signal?: AbortSignal) => Promise<ProjectTextFile | null>;

export class ContextSet {
  private items = new Map<string, ContextEntry>();
  private listeners = new Set<() => void>();
  private reader: Reader | null = null;
  private rootBindingId = "";
  private counter = 0;

  bind(reader: Reader, rootBindingId: string): void {
    const changedRoot = this.rootBindingId && this.rootBindingId !== rootBindingId;
    this.reader = reader;
    this.rootBindingId = rootBindingId;
    if (changedRoot) this.clear();
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void { for (const listener of this.listeners) listener(); }

  entries(): ContextEntry[] {
    return [...this.items.values()].sort((a, b) => a.addedAt - b.addedAt);
  }

  get size(): number { return this.items.size; }

  has(relativePath: string): boolean {
    return [...this.items.values()].some((e) => e.relativePath === normalize(relativePath));
  }

  /** Adds a file (idempotent per path) and validates it through the core. */
  async add(relativePath: string, signal?: AbortSignal, ranges?: ContextRange[]): Promise<ContextEntry> {
    const path = normalize(relativePath);
    const existing = [...this.items.values()].find((e) => e.relativePath === path);
    if (existing && existing.state !== "error" && existing.state !== "missing") {
      // An explicit full-file choice expands a prior selection; a later selection keeps an existing full choice.
      if (!ranges) delete existing.ranges;
      if (!ranges || !existing.ranges) {
        if (existing.state === "excluded") { existing.state = "ready"; this.emit(); }
        return existing;
      }
    }
    const entry: ContextEntry = existing ?? { id: `ctx-${++this.counter}`, relativePath: path, state: "reading", sha256: null, byteLength: 0, lines: 0, changed: false, addedAt: Date.now() };
    if (ranges) entry.ranges = ranges;
    else delete entry.ranges;
    entry.state = "reading"; entry.error = undefined;
    this.items.set(entry.id, entry);
    this.emit();
    if (!this.reader) { entry.state = "error"; entry.error = t("ctx_err_no_project"); this.emit(); return entry; }
    try {
      const file = await this.reader(path, signal);
      if (!file) { entry.state = "missing"; entry.error = t("ctx_err_file_not_found", { path: "" }).replace(/:\s*$/, ""); }
      else {
        if (entry.ranges) selectedContextText(file.text, entry.ranges);
        entry.state = "ready"; entry.sha256 = file.sha256; entry.byteLength = file.byteLength;
        entry.lines = file.text ? file.text.split("\n").length : 0; entry.language = file.language;
      }
    } catch (error) {
      entry.state = "error";
      entry.error = describeReadError(error instanceof Error ? error.message : "read_failed");
    }
    this.emit();
    return entry;
  }

  remove(idOrPath: string): boolean {
    const target = this.items.get(idOrPath) ?? [...this.items.values()].find((e) => e.relativePath === normalize(idOrPath));
    if (!target) return false;
    this.items.delete(target.id);
    this.emit();
    return true;
  }

  /** Keeps the entry visible but out of the next dispatch. */
  toggleExcluded(id: string): void {
    const entry = this.items.get(id);
    if (!entry) return;
    entry.state = entry.state === "excluded" ? (entry.sha256 ? "ready" : "error") : "excluded";
    this.emit();
  }

  clear(): void {
    if (!this.items.size) return;
    this.items.clear();
    this.emit();
  }

  /**
   * Re-reads every included file through the core and builds the data block for
   * this dispatch. The returned references are what gets persisted.
   */
  async snapshotForDispatch(signal?: AbortSignal): Promise<DispatchSnapshot> {
    const notices: string[] = [];
    const references: ContextReference[] = [];
    const sections: string[] = [];
    let bytes = 0;
    if (!this.reader) return { references, block: "", bytes, notices };
    for (const entry of this.entries()) {
      if (entry.state === "excluded" || entry.state === "reading") continue;
      signal?.throwIfAborted();
      let file: ProjectTextFile | null;
      try { file = await this.reader(entry.relativePath, signal); }
      catch (error) {
        entry.state = "error"; entry.error = describeReadError(error instanceof Error ? error.message : "read_failed");
        notices.push(t("ctx_notice_read_failed", { path: entry.relativePath, error: entry.error ?? "" }));
        if (entry.ranges) { this.emit(); throw new Error("attachment_read"); }
        continue;
      }
      if (!file) { entry.state = "missing"; entry.error = t("ctx_err_file_not_found", { path: "" }).replace(/:\s*$/, ""); notices.push(t("ctx_notice_file_missing", { path: entry.relativePath })); if (entry.ranges) { this.emit(); throw new Error("attachment_read"); } continue; }
      let content = file.text;
      try { if (entry.ranges) content = selectedContextText(file.text, entry.ranges); }
      catch { entry.state = "error"; entry.error = connectionText("attachment_read"); this.emit(); throw new Error("attachment_read"); }
      const dispatchBytes = Buffer.byteLength(content);
      if (entry.sha256 && entry.sha256 !== file.sha256) { entry.changed = true; notices.push(t("ctx_notice_file_changed", { path: entry.relativePath })); }
      if (bytes + dispatchBytes > CONTEXT_MAX_BYTES) { if (entry.ranges) throw new Error("attachment_size"); notices.push(t("ctx_err_too_large", { path: entry.relativePath, size: CONTEXT_MAX_BYTES })); continue; }
      bytes += dispatchBytes;
      entry.state = "ready"; entry.sha256 = file.sha256; entry.byteLength = file.byteLength; entry.lines = file.text.split("\n").length;
      references.push({ rootBindingId: this.rootBindingId, relativePath: entry.relativePath, sha256: file.sha256, byteLength: file.byteLength, ...(entry.ranges ? { ranges: entry.ranges } : {}) });
      const fence = content.includes("```") ? "~~~~" : "```";
      sections.push(`${entry.relativePath} (sha256 ${file.sha256.slice(0, 12)})\n${fence}${file.language ?? ""}\n${content}${content.endsWith("\n") ? "" : "\n"}${fence}`);
    }
    this.emit();
    const block = sections.length
      ? `${t("ctx_header_data_block", { path: "" })}\n\n${sections.join("\n\n")}`
      : "";
    return { references, block, bytes, notices };
  }
}

function normalize(path: string): string {
  return path.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

export function describeReadError(code: string): string {
  switch (code) {
    case "context_range_invalid": return connectionText("attachment_read");
    case "project_path_protected": return t("ctx_err_path_protected", { path: "" }).replace(/^:\s*|:\s*$/g, "");
    case "project_file_not_text": return t("ctx_err_not_text", { path: "" }).replace(/^:\s*|:\s*$/g, "");
    case "project_file_too_large": return t("ctx_err_too_large", { path: "", size: "256 KiB" }).replace(/^:\s*|:\s*$/g, "");
    case "project_file_not_regular": return t("ctx_err_not_regular", { path: "" }).replace(/^:\s*|:\s*$/g, "");
    case "project_path_traversal_forbidden": return t("ctx_err_traversal", { path: "" }).replace(/^:\s*|:\s*$/g, "");
    case "project_root_revoked": return t("ctx_err_root_revoked", { path: "" }).replace(/^:\s*|:\s*$/g, "");
    default: return code;
  }
}
