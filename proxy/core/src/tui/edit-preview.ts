/**
 * Summarizes multi-file proposals and their per-file diffs for approval
 * before changes are applied.
 */
import { parseUnifiedDiff, renderDiffAnsi, renderDiffSummary } from "./inline-diff.ts";
import type { FileDiff } from "./inline-diff.ts";

export interface FileChange {
  path: string;
  type: "create" | "modify" | "delete" | "rename";
  diff?: string;
  oldPath?: string; // for renames
  content?: string; // for creates
}

export interface EditPreview {
  changes: FileChange[];
  diffs: FileDiff[];
  summary: string;
  totalAdditions: number;
  totalDeletions: number;
  filesAffected: number;
}

/**
 * Build an edit preview from a set of file changes.
 */
export function buildEditPreview(changes: FileChange[]): EditPreview {
  const diffs: FileDiff[] = [];

  for (const change of changes) {
    if (change.diff) {
      const parsed = parseUnifiedDiff(change.diff);
      diffs.push(...parsed);
    } else {
      diffs.push({
        path: change.path,
        hunks: [],
        additions: change.type === "create" ? (change.content?.split("\n").length ?? 0) : 0,
        deletions: change.type === "delete" ? 1 : 0,
        isBinary: false,
        isNew: change.type === "create",
        isDeleted: change.type === "delete",
      });
    }
  }

  const totalAdditions = diffs.reduce((s, d) => s + d.additions, 0);
  const totalDeletions = diffs.reduce((s, d) => s + d.deletions, 0);

  return {
    changes,
    diffs,
    summary: renderDiffSummary(diffs),
    totalAdditions,
    totalDeletions,
    filesAffected: changes.length,
  };
}

/**
 * Render the full edit preview as ANSI output.
 */
export function renderEditPreview(preview: EditPreview, options?: { maxWidth?: number }): string {
  const lines: string[] = [];

  // Header
  lines.push(`\x1b[1;36m╔══ Edit Preview ═══════════════════════════════╗\x1b[0m`);
  lines.push(`\x1b[1;36m║\x1b[0m ${preview.filesAffected} file${preview.filesAffected !== 1 ? "s" : ""} · \x1b[32m+${preview.totalAdditions}\x1b[0m · \x1b[31m-${preview.totalDeletions}\x1b[0m`);
  lines.push(`\x1b[1;36m╚═══════════════════════════════════════════════╝\x1b[0m`);
  lines.push("");

  // File list with icons
  for (const change of preview.changes) {
    const icon = change.type === "create" ? "\x1b[32m+ " : change.type === "delete" ? "\x1b[31m× " : change.type === "rename" ? "\x1b[33m→ " : "\x1b[34m~ ";
    const extra = change.type === "rename" && change.oldPath ? ` (from ${change.oldPath})` : "";
    lines.push(`  ${icon}${change.path}\x1b[0m${extra}`);
  }
  lines.push("");

  // Diffs
  for (const diff of preview.diffs) {
    lines.push(renderDiffAnsi(diff, { maxWidth: options?.maxWidth, contextLines: 3 }));
    lines.push("");
  }

  // Footer
  lines.push(`\x1b[2m[a] Approve all · [r] Reject all · [↑↓] Navigate · [Enter] Toggle file\x1b[0m`);

  return lines.join("\n");
}

/**
 * Validate changes before applying.
 * Returns errors for any issues found.
 */
export function validateChanges(changes: FileChange[]): string[] {
  const errors: string[] = [];

  // Check for duplicate paths
  const paths = new Set<string>();
  for (const change of changes) {
    if (paths.has(change.path)) {
      errors.push(`Duplicate path: ${change.path}`);
    }
    paths.add(change.path);
  }

  // Check for suspicious patterns
  for (const change of changes) {
    if (change.path.includes("..")) errors.push(`Path traversal: ${change.path}`);
    if (change.path.startsWith("/")) errors.push(`Absolute path: ${change.path}`);
    if (/\.(env|key|pem|p12|pfx)$/i.test(change.path)) {
      errors.push(`Sensitive file: ${change.path}`);
    }
  }

  return errors;
}
