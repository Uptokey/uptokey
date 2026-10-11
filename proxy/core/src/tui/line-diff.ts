/**
 * Uptokey TUI — exact line diff and unified hunks.
 *
 * Used to show what a proposed ChangeSet does before any approval and to build
 * per-hunk selections. Lines are compared exactly; EOL normalization is the
 * caller's decision (the editor/writer preserve the file's own line endings).
 *
 * Diff engine: jsdiff 8.0.2, BSD-3-Clause, Kevin Decker and contributors.
 * https://github.com/kpdecker/jsdiff/tree/v8.0.2/src/diff
 * This is a runtime dependency, also used by OpenCode's edit/apply-patch tools,
 * not a local reimplementation or a vendored copy of their execution policy.
 */
import { diffArrays } from "diff";

export type DiffOp = { kind: "equal" | "delete" | "insert"; line: string; oldNo: number | null; newNo: number | null };

export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  ops: DiffOp[];
}

export interface DiffStats { added: number; removed: number }

// A deterministic distance bound is essential: proposal review and partial
// approval recompute this diff, so a wall-clock timeout could change hunk IDs.
const MAX_EDIT_DISTANCE = 512;

export function splitLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split("\n");
  if (lines[lines.length - 1] === "") lines.pop();
  return lines;
}

/** Exact tokens through jsdiff; too-different middles become a complete replacement. */
export function diffLines(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  // Trim common prefix/suffix first: most edits are local.
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
  let suffix = 0;
  while (suffix < oldLines.length - prefix && suffix < newLines.length - prefix
    && oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]) suffix++;
  const a = oldLines.slice(prefix, oldLines.length - suffix);
  const b = newLines.slice(prefix, newLines.length - suffix);
  const changes = diffArrays(a, b, { maxEditLength: MAX_EDIT_DISTANCE });
  const ops: DiffOp[] = [];
  let o = 0, n = 0;
  const push = (kind: DiffOp["kind"], line: string) => {
    ops.push({ kind, line, oldNo: kind === "insert" ? null : ++o, newNo: kind === "delete" ? null : ++n });
  };
  for (let i = 0; i < prefix; i++) push("equal", oldLines[i]!);
  if (changes) {
    for (const change of changes) {
      const kind = change.removed ? "delete" : change.added ? "insert" : "equal";
      for (const line of change.value) push(kind, line);
    }
  } else {
    // The fallback remains byte-exact and reviewable; it never omits a change
    // or guesses a match, and does not retain per-distance frontier snapshots.
    for (const line of a) push("delete", line);
    for (const line of b) push("insert", line);
  }
  for (let i = oldLines.length - suffix; i < oldLines.length; i++) push("equal", oldLines[i]!);
  return ops;
}

export function diffStats(ops: readonly DiffOp[]): DiffStats {
  let added = 0, removed = 0;
  for (const op of ops) { if (op.kind === "insert") added++; else if (op.kind === "delete") removed++; }
  return { added, removed };
}

/** Groups changes into hunks with `context` equal lines around them. */
export function toHunks(ops: readonly DiffOp[], context = 3): DiffHunk[] {
  const hunks: DiffHunk[] = [];
  const changeIdx: number[] = [];
  ops.forEach((op, i) => { if (op.kind !== "equal") changeIdx.push(i); });
  if (!changeIdx.length) return hunks;
  let start = Math.max(0, changeIdx[0]! - context);
  let end = Math.min(ops.length, changeIdx[0]! + context + 1);
  const flush = () => {
    const slice = ops.slice(start, end);
    const firstOld = slice.find((op) => op.oldNo !== null)?.oldNo ?? (ops.slice(0, start).reverse().find((op) => op.oldNo !== null)?.oldNo ?? 0) + 1;
    const firstNew = slice.find((op) => op.newNo !== null)?.newNo ?? (ops.slice(0, start).reverse().find((op) => op.newNo !== null)?.newNo ?? 0) + 1;
    hunks.push({
      oldStart: firstOld, newStart: firstNew,
      oldLines: slice.filter((op) => op.kind !== "insert").length,
      newLines: slice.filter((op) => op.kind !== "delete").length,
      ops: slice,
    });
  };
  for (const idx of changeIdx.slice(1)) {
    if (idx - context <= end) end = Math.min(ops.length, idx + context + 1);
    else { flush(); start = Math.max(0, idx - context); end = Math.min(ops.length, idx + context + 1); }
  }
  flush();
  return hunks;
}

/** Unified diff text (for export/copy); display uses the structured hunks. */
export function unifiedDiff(path: string, before: string | null, after: string, context = 3): string {
  const ops = diffLines(splitLines(before ?? ""), splitLines(after));
  const out = [`--- ${before === null ? "/dev/null" : `a/${path}`}`, `+++ b/${path}`];
  for (const hunk of toHunks(ops, context)) {
    out.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`);
    for (const op of hunk.ops) out.push(`${op.kind === "insert" ? "+" : op.kind === "delete" ? "-" : " "}${op.line}`);
  }
  return out.join("\n");
}

/**
 * Rebuilds the new content applying only the selected hunks (by index);
 * unselected hunks keep the old lines. Used for partial approval.
 */
export function applySelectedHunks(before: string, after: string, selected: ReadonlySet<number>, context = 3): string {
  const ops = diffLines(splitLines(before), splitLines(after));
  const hunks = toHunks(ops, context);
  const accepted = new Set<DiffOp>();
  hunks.forEach((hunk, index) => { if (selected.has(index)) for (const op of hunk.ops) accepted.add(op); });
  const out: string[] = [];
  for (const op of ops) {
    if (op.kind === "equal") out.push(op.line);
    else if (op.kind === "delete") { if (!accepted.has(op)) out.push(op.line); }
    else if (accepted.has(op)) out.push(op.line);
  }
  const trailing = (selected.size && after.endsWith("\n")) || (!selected.size && before.endsWith("\n")) || (before.endsWith("\n") && after.endsWith("\n"));
  return out.join("\n") + (out.length && trailing ? "\n" : "");
}
