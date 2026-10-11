/** Native file editing for the model: exact edits, whole-file writes and moves become one canonical
 * ChangeSet each, applied by the governed project writer (W5 plan, signed approval, receipt). The TUI never
 * writes to disk itself. After a write the LSP diagnostics of the touched files return to the model, so it can
 * correct its own errors in the same turn. */
import { randomUUID } from "node:crypto";
import { computeProjectChangeSetDigest } from "@uptokey/sync-contract/project-agent";
import type { TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor, NativeToolExecutionContext } from "./conversations.ts";
import type { NativeDiagnosticsResult } from "./native-coding-tools.ts";
import { executeNativeApprovedPlan, type NativePlanHost } from "./native-web-tools.ts";
import { sha256Text } from "./change-proposal.ts";
import { diffLines, diffStats, splitLines, unifiedDiff } from "./line-diff.ts";
import { t } from "./i18n.ts";
import type { ProjectTextFile } from "./workspace.ts";

const MAX_EDITS = 50;
const MAX_CONTENT_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 30;

export const NATIVE_WRITE_TOOLS: readonly TuiFunctionTool[] = [
  { type: "function", function: {
    name: "edit_file",
    description: "Edit an existing project file by exact replacement. Each old_string must match the current file exactly once (include enough surrounding lines to be unique) unless replace_all is true. All edits of one call are applied together, in order, as one write; if any edit fails nothing is written. Read the file first. Returns the receipt and the LSP diagnostics of the file after the write.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Path relative to the project root." },
      edits: { type: "array", minItems: 1, maxItems: MAX_EDITS, items: { type: "object", properties: {
        old_string: { type: "string", minLength: 1 },
        new_string: { type: "string" },
        replace_all: { type: "boolean" },
      }, required: ["old_string", "new_string"], additionalProperties: false } },
    }, required: ["path", "edits"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "write_file",
    description: "Create a new project file, or replace an existing one entirely, with the given content. Missing parent folders are created. Prefer edit_file for small changes to existing files. Returns the receipt and the LSP diagnostics after the write.",
    parameters: { type: "object", properties: {
      path: { type: "string", description: "Path relative to the project root." },
      content: { type: "string" },
    }, required: ["path", "content"], additionalProperties: false },
  } },
  { type: "function", function: {
    name: "move_file",
    description: "Move or rename a project file. The destination must not exist. Missing parent folders are created.",
    parameters: { type: "object", properties: { from: { type: "string" }, to: { type: "string" } }, required: ["from", "to"], additionalProperties: false },
  } },
];

/** The approval shows the change itself; very large diffs are cut with an explicit marker. */
function boundedDiff(diff: string, maxLines = 400): string {
  const lines = diff.split("\n");
  return lines.length <= maxLines ? diff : `${lines.slice(0, maxLines).join("\n")}\n… (+${lines.length - maxLines})`;
}

export class EditError extends Error {
  readonly detail: Record<string, unknown>;
  constructor(code: string, detail: Record<string, unknown> = {}) { super(code); this.name = "EditError"; this.detail = detail; }
}

export interface EditRequest { old_string: string; new_string: string; replace_all?: boolean }
export interface EditOutcome { text: string; applied: Array<{ index: number; matches: number; strategy: "exact" | "line_trimmed" | "indentation" }> }

function occurrences(text: string, needle: string): number[] {
  const found: number[] = [];
  for (let at = text.indexOf(needle); at >= 0; at = text.indexOf(needle, at + needle.length)) found.push(at);
  return found;
}

/** Spans of `text` whose lines equal the lines of `needle` under `same`. Returns [start, end) offsets. */
function lineSpans(text: string, needle: string, same: (a: string, b: string) => boolean): Array<[number, number]> {
  const lines = text.split("\n");
  const wanted = needle.replace(/\n$/, "").split("\n");
  if (!wanted.length || wanted.every((line) => !line.trim())) return [];
  const offsets: number[] = [];
  let offset = 0;
  for (const line of lines) { offsets.push(offset); offset += line.length + 1; }
  const spans: Array<[number, number]> = [];
  for (let start = 0; start + wanted.length <= lines.length; start++) {
    let ok = true;
    for (let k = 0; k < wanted.length && ok; k++) ok = same(lines[start + k]!, wanted[k]!);
    if (!ok) continue;
    const last = start + wanted.length - 1;
    const end = offsets[last]! + lines[last]!.length + (needle.endsWith("\n") && last + 1 < lines.length ? 1 : 0);
    spans.push([offsets[start]!, end]);
  }
  return spans;
}

function minIndent(lines: string[]): number {
  const widths = lines.filter((line) => line.trim()).map((line) => line.length - line.trimStart().length);
  return widths.length ? Math.min(...widths) : 0;
}

function reindent(replacement: string, from: number, to: number): string {
  if (from === to) return replacement;
  return replacement.split("\n").map((line) => {
    if (!line.trim()) return line;
    const width = line.length - line.trimStart().length;
    return " ".repeat(Math.max(0, width - from + to)) + line.trimStart();
  }).join("\n");
}

/** Most similar region of the file to `needle`, so the model can copy the exact current text. */
export function closestRegion(text: string, needle: string): { line: number; text: string } | null {
  const lines = text.split("\n");
  const wanted = needle.split("\n").map((line) => line.trim());
  if (!wanted.some(Boolean) || !lines.length) return null;
  const size = wanted.length;
  // Character-bigram similarity (Dice) per line, so a near miss (one token changed) is still found.
  const bigrams = (value: string) => { const out = new Map<string, number>(); for (let k = 0; k + 1 < value.length; k++) { const pair = value.slice(k, k + 2); out.set(pair, (out.get(pair) ?? 0) + 1); } return out; };
  const dice = (a: string, b: string) => {
    if (a === b) return 1;
    if (a.length < 2 || b.length < 2) return 0;
    const left = bigrams(a), right = bigrams(b);
    let shared = 0;
    for (const [pair, count] of left) shared += Math.min(count, right.get(pair) ?? 0);
    return (2 * shared) / (a.length - 1 + b.length - 1);
  };
  const wantedLines = wanted.filter(Boolean);
  const trimmed = lines.map((line) => line.trim());
  let best = -1, score = 0;
  for (let start = 0; start < lines.length; start++) {
    const window = trimmed.slice(start, start + size).filter(Boolean);
    if (!window.length) continue;
    const total = wantedLines.reduce((sum, line) => sum + Math.max(...window.map((candidate) => dice(line, candidate))), 0) / wantedLines.length;
    if (total > score) { score = total; best = start; }
  }
  if (best < 0 || score < 0.5) return null;
  return { line: best + 1, text: lines.slice(best, best + size).join("\n").slice(0, 4000) };
}

/** Applies edits in order. Exact match first; then whole-line matches ignoring surrounding whitespace, then
 * ignoring a uniform indentation shift (the replacement is re-indented). A match must be unique unless
 * replace_all is set. Line endings follow the file. */
export function applyEdits(original: string, edits: readonly EditRequest[]): EditOutcome {
  const crlf = original.includes("\r\n");
  let text = crlf ? original.replace(/\r\n/g, "\n") : original;
  const applied: EditOutcome["applied"] = [];
  edits.forEach((edit, index) => {
    const oldString = edit.old_string.replace(/\r\n/g, "\n");
    const newString = edit.new_string.replace(/\r\n/g, "\n");
    if (!oldString) throw new EditError("edit_old_string_empty", { index });
    if (oldString === newString) throw new EditError("edit_no_change", { index });
    const exact = occurrences(text, oldString);
    if (exact.length) {
      if (exact.length > 1 && !edit.replace_all) throw new EditError("edit_not_unique", { index, matches: exact.length, lines: exact.slice(0, 10).map((at) => text.slice(0, at).split("\n").length) });
      text = edit.replace_all ? text.split(oldString).join(newString) : text.slice(0, exact[0]!) + newString + text.slice(exact[0]! + oldString.length);
      applied.push({ index, matches: edit.replace_all ? exact.length : 1, strategy: "exact" });
      return;
    }
    const wantedIndent = minIndent(oldString.split("\n"));
    const strategies: Array<{ name: "line_trimmed" | "indentation"; spans: Array<[number, number]>; replacement: (span: [number, number]) => string }> = [
      (() => {
        const wanted = oldString.split("\n");
        const base = minIndent(wanted);
        const strip = (line: string) => line.trim() ? line.slice(Math.min(base, line.length - line.trimStart().length)) : "";
        const spans = lineSpans(text, oldString, () => true).filter(([start, end]) => {
          const region = text.slice(start, end).split("\n");
          const shift = minIndent(region);
          return region.length === wanted.length && region.every((line, k) => (line.trim() ? line.slice(Math.min(shift, line.length - line.trimStart().length)) : "").trimEnd() === strip(wanted[k]!).trimEnd());
        });
        return { name: "indentation" as const, spans, replacement: (span: [number, number]) => reindent(newString, base, minIndent(text.slice(span[0], span[1]).split("\n"))) };
      })(),
      // Lines equal after trimming, relative indentation not preserved by the model: the replacement takes the
      // indentation of the region it replaces.
      { name: "line_trimmed", spans: lineSpans(text, oldString, (a, b) => a.trim() === b.trim()), replacement: (span: [number, number]) => reindent(newString, wantedIndent, minIndent(text.slice(span[0], span[1]).split("\n"))) },
    ];
    for (const strategy of strategies) {
      if (!strategy.spans.length) continue;
      if (strategy.spans.length > 1 && !edit.replace_all) throw new EditError("edit_not_unique", { index, matches: strategy.spans.length, strategy: strategy.name });
      for (const span of [...(edit.replace_all ? strategy.spans : strategy.spans.slice(0, 1))].reverse()) text = text.slice(0, span[0]) + strategy.replacement(span) + text.slice(span[1]);
      applied.push({ index, matches: edit.replace_all ? strategy.spans.length : 1, strategy: strategy.name });
      return;
    }
    throw new EditError("edit_not_found", { index, closest: closestRegion(text, oldString) });
  });
  return { text: crlf ? text.replace(/\n/g, "\r\n") : text, applied };
}

function pathOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 1024 || /[\x00-\x1f:*?"<>|]/.test(value)) throw new EditError("project_path_invalid");
  const path = value.trim().replaceAll("\\", "/").replace(/^\.\//, "");
  if (path.startsWith("/") || path.endsWith("/") || path.split("/").some((part) => !part || part === "." || part === "..")) throw new EditError("project_path_invalid");
  return path;
}

function missingParents(path: string, existing: ReadonlySet<string>): string[] {
  const parts = path.split("/").slice(0, -1);
  const out: string[] = [];
  for (let k = 1; k <= parts.length; k++) {
    const dir = parts.slice(0, k).join("/");
    if (!existing.has(dir)) out.push(dir);
  }
  return out;
}

export interface NativeWriteHost extends NativePlanHost {
  rootBindingId: string;
  readOnly: boolean;
  diagnostics?: (paths: string[], signal?: AbortSignal, context?: NativeToolExecutionContext) => Promise<NativeDiagnosticsResult>;
  /** Receives every successful write (the controller refreshes its file index and offers verification). */
  onWritten?: (paths: string[], receiptId: string) => void;
}

type Operation = { type: "mkdir" | "create" | "replace" | "move"; path: string; fromPath?: string; expectedSha256?: string; newSha256?: string; content?: string };

export function nativeWriteExecutor(options: NativeWriteHost): NativeReadToolExecutor {
  const { workspace } = options;
  return async (call, signal, context) => {
    if (!context) throw new Error("conversation_admission_unavailable");
    const check = async () => {
      signal?.throwIfAborted();
      if (!options.stillBound()) throw new Error("project_binding_changed");
      await context.assertCurrent();
      if (!options.stillBound()) throw new Error("project_binding_changed");
    };
    const failure = (reason: string, detail: Record<string, unknown> = {}) => {
      const outcome = { status: "not_completed", tool: call.name, reason, ...detail };
      return { output: JSON.stringify(outcome), persistedOutput: { status: "not_completed", tool: call.name, reason } };
    };
    await check();
    if (options.readOnly) return failure("project_read_only");
    const definition = NATIVE_WRITE_TOOLS.find((tool) => tool.function.name === call.name);
    if (!definition) throw new Error("conversation_tool_unavailable");
    const allowed = Object.keys(definition.function.parameters.properties as object);
    if (Object.keys(call.arguments).some((key) => !allowed.includes(key))) return failure("write_arguments_invalid", { allowed });
    try {
      const read = async (path: string): Promise<ProjectTextFile | null> => { const file = await workspace.readProjectFile(options.projectId, options.rootBindingId, path, signal); await check(); return file; };
      const manifest = await workspace.getManifest(options.projectId, options.rootBindingId, signal);
      await check();
      const directories = new Set(manifest.entries.filter((entry) => entry.kind === "directory").map((entry) => entry.relativePath.replace(/\/$/, "")));
      for (const entry of manifest.entries) { const parts = entry.relativePath.split("/"); for (let k = 1; k < parts.length; k++) directories.add(parts.slice(0, k).join("/")); }
      const operations: Operation[] = [];
      let paths: string[] = [];
      let summary = "";
      let detail: string | undefined;
      let stats = { added: 0, removed: 0 };
      let editReport: EditOutcome["applied"] | undefined;
      if (call.name === "edit_file") {
        const path = pathOf(call.arguments.path);
        const edits = call.arguments.edits;
        if (!Array.isArray(edits) || !edits.length || edits.length > MAX_EDITS || edits.some((edit) => !edit || typeof edit !== "object" || typeof (edit as EditRequest).old_string !== "string" || typeof (edit as EditRequest).new_string !== "string" || ((edit as EditRequest).replace_all !== undefined && typeof (edit as EditRequest).replace_all !== "boolean"))) return failure("write_arguments_invalid");
        const file = await read(path);
        if (!file) return failure("project_file_not_found", { path, create_with: "write_file" });
        const outcome = applyEdits(file.text, edits as EditRequest[]);
        if (outcome.text === file.text) return failure("edit_no_change", { path });
        operations.push({ type: "replace", path, expectedSha256: file.sha256, newSha256: sha256Text(outcome.text), content: outcome.text });
        stats = diffStats(diffLines(splitLines(file.text), splitLines(outcome.text)));
        editReport = outcome.applied;
        paths = [path];
        summary = t("write_summary_edit", { path, added: stats.added, removed: stats.removed });
        detail = boundedDiff(unifiedDiff(path, file.text, outcome.text));
      } else if (call.name === "write_file") {
        const path = pathOf(call.arguments.path);
        const content = call.arguments.content;
        if (typeof content !== "string" || Buffer.byteLength(content, "utf8") > MAX_CONTENT_BYTES) return failure("write_arguments_invalid");
        const file = await read(path);
        if (file && file.text === content) return failure("edit_no_change", { path });
        for (const dir of missingParents(path, directories)) operations.push({ type: "mkdir", path: dir });
        operations.push(file ? { type: "replace", path, expectedSha256: file.sha256, newSha256: sha256Text(content), content } : { type: "create", path, newSha256: sha256Text(content), content });
        stats = diffStats(diffLines(splitLines(file?.text ?? ""), splitLines(content)));
        paths = [path];
        summary = t(file ? "write_summary_replace" : "write_summary_create", { path, added: stats.added, removed: stats.removed });
        detail = boundedDiff(unifiedDiff(path, file?.text ?? null, content));
      } else {
        const from = pathOf(call.arguments.from), to = pathOf(call.arguments.to);
        if (from === to) return failure("write_arguments_invalid");
        if (!await read(from)) return failure("project_file_not_found", { path: from });
        if (await read(to)) return failure("project_file_exists", { path: to });
        for (const dir of missingParents(to, directories)) operations.push({ type: "mkdir", path: dir });
        operations.push({ type: "move", fromPath: from, path: to });
        paths = [from, to];
        summary = t("write_summary_move", { from, to });
        detail = `${from} → ${to}`;
      }
      const raw = { id: `cs-${randomUUID()}`, taskId: `tui-native-${randomUUID()}`, baseManifestDigest: manifest.snapshotDigest, revision: 1, operations };
      const changeSet = { ...raw, digest: computeProjectChangeSetDigest(raw) };
      const preflight = await workspace.preflightChangeSet(options.projectId, options.rootBindingId, changeSet as never, signal);
      await check();
      if (preflight.issues.length) return failure("write_preflight_failed", { issues: preflight.issues.map((issue) => ({ path: issue.path, code: issue.code })) });
      const current = await workspace.refresh(options.projectId, signal);
      await check();
      const planned = await workspace.createChangeSetPlan(options.projectId, { expectedRevision: current.revision, rootBindingId: options.rootBindingId, changeSet: changeSet as never, objective: summary.slice(0, 500) }, signal);
      const step = planned.plan?.steps[0];
      if (planned.projectId !== options.projectId || planned.plan?.steps.length !== 1 || step?.capabilityId !== "workspace.project.write") throw new Error("write_plan_mismatch");
      await check();
      const settled = await executeNativeApprovedPlan(options, planned, summary, context, signal, detail);
      if (!settled) return failure("user_declined");
      const runId = settled.run?.id;
      const receipt = settled.receipts.find((item) => item.runId === runId && item.capabilityId === "workspace.project.write");
      if (settled.run?.status !== "succeeded" || receipt?.status !== "succeeded") {
        const outcome = { status: "not_completed", tool: call.name, runId, runStatus: settled.run?.status ?? "unknown", ...(receipt ? { receiptId: receipt.id } : {}) };
        return { output: JSON.stringify(outcome), persistedOutput: outcome, ...(receipt ? { receiptId: receipt.id } : {}) };
      }
      options.onWritten?.(paths, receipt.id);
      const written = paths.filter((path) => call.name !== "move_file" || path === paths[1]);
      let diagnostics: unknown;
      if (options.diagnostics) {
        try {
          const result = await options.diagnostics(written, signal, context);
          const errors = result.files.flatMap((file) => file.diagnostics.filter((d) => (d.severity ?? 1) <= 1).map((d) => ({ path: file.path, line: d.range.start.line + 1, column: d.range.start.character + 1, message: String(d.message).slice(0, 500) })));
          diagnostics = { status: result.status, errors: errors.slice(0, MAX_DIAGNOSTICS), errorCount: errors.length, unavailable: result.unavailable };
        } catch (error) {
          signal?.throwIfAborted();
          diagnostics = { status: "not_executed", reason: error instanceof Error ? error.message.slice(0, 120) : "diagnostics_failed" };
        }
      }
      const metadata = { status: "succeeded", tool: call.name, paths, receiptId: receipt.id, runId, added: stats.added, removed: stats.removed, ...(editReport ? { edits: editReport } : {}) };
      return { output: JSON.stringify({ ...metadata, ...(diagnostics ? { diagnostics } : {}) }), persistedOutput: metadata, receiptId: receipt.id };
    } catch (error) {
      if (error instanceof EditError) return failure(error.message, error.detail);
      throw error;
    }
  };
}
