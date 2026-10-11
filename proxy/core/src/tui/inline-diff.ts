/**
 * Parses unified diffs and renders file headers, line numbers, changed lines
 * and folded unchanged context.
 */

export interface DiffHunk {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNo?: number;
  newLineNo?: number;
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
  isBinary: boolean;
  isNew: boolean;
  isDeleted: boolean;
}

/**
 * Parse a unified diff string into structured FileDiff objects.
 */
export function parseUnifiedDiff(diffText: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diffText.split("\n");
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    // File header
    const fileMatch = /^diff --git a\/(.+?) b\/(.+)/.exec(line);
    if (fileMatch) {
      current = {
        path: fileMatch[2] ?? fileMatch[1] ?? "",
        hunks: [],
        additions: 0,
        deletions: 0,
        isBinary: false,
        isNew: false,
        isDeleted: false,
      };
      files.push(current);
      currentHunk = null;
      continue;
    }

    if (!current) continue;

    if (line.startsWith("new file")) { current.isNew = true; continue; }
    if (line.startsWith("deleted file")) { current.isDeleted = true; continue; }
    if (line.startsWith("Binary files")) { current.isBinary = true; continue; }

    // Hunk header
    const hunkMatch = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(line);
    if (hunkMatch) {
      oldLine = parseInt(hunkMatch[1]!, 10);
      newLine = parseInt(hunkMatch[3]!, 10);
      currentHunk = {
        oldStart: oldLine,
        oldCount: parseInt(hunkMatch[2] ?? "1", 10),
        newStart: newLine,
        newCount: parseInt(hunkMatch[4] ?? "1", 10),
        lines: [],
      };
      current.hunks.push(currentHunk);
      continue;
    }

    if (!currentHunk) continue;

    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNo: newLine++ });
      current.additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLineNo: oldLine++ });
      current.deletions++;
    } else if (line.startsWith(" ")) {
      currentHunk.lines.push({ type: "context", content: line.slice(1), oldLineNo: oldLine++, newLineNo: newLine++ });
    }
  }

  return files;
}

/**
 * Render a FileDiff as ANSI-colored terminal output.
 * Folds context lines to show only `contextLines` around changes.
 */
export function renderDiffAnsi(diff: FileDiff, options?: { contextLines?: number; maxWidth?: number }): string {
  const ctx = options?.contextLines ?? 3;
  const maxW = options?.maxWidth ?? 120;
  const lines: string[] = [];

  // File header
  const stats = diff.isNew ? " (new)" : diff.isDeleted ? " (deleted)" : ` +${diff.additions} -${diff.deletions}`;
  lines.push(`\x1b[1;36m━━━ ${diff.path}${stats} ━━━\x1b[0m`);

  if (diff.isBinary) {
    lines.push("  \x1b[2m(binary file)\x1b[0m");
    return lines.join("\n");
  }

  for (const hunk of diff.hunks) {
    // Find which lines are near changes
    const changeIndices = hunk.lines
      .map((l, i) => l.type !== "context" ? i : -1)
      .filter((i) => i >= 0);

    const visible = new Set<number>();
    for (const ci of changeIndices) {
      for (let j = Math.max(0, ci - ctx); j <= Math.min(hunk.lines.length - 1, ci + ctx); j++) {
        visible.add(j);
      }
    }

    let lastVisible = -1;
    for (let i = 0; i < hunk.lines.length; i++) {
      const dl = hunk.lines[i]!;

      if (!visible.has(i)) {
        if (lastVisible === i - 1 && i > 0) {
          const skipped = hunk.lines.filter((_, j) => j > lastVisible && j < i + 1 && !visible.has(j)).length;
          if (skipped > 0) lines.push(`  \x1b[2m  ⋮ ${skipped} lines\x1b[0m`);
        }
        continue;
      }

      lastVisible = i;
      const content = dl.content.slice(0, maxW - 8);
      const lineNo = dl.type === "add" ? String(dl.newLineNo ?? "").padStart(4)
        : dl.type === "remove" ? String(dl.oldLineNo ?? "").padStart(4)
        : String(dl.oldLineNo ?? "").padStart(4);

      switch (dl.type) {
        case "add":
          lines.push(`  \x1b[32m${lineNo} + ${content}\x1b[0m`);
          break;
        case "remove":
          lines.push(`  \x1b[31m${lineNo} - ${content}\x1b[0m`);
          break;
        case "context":
          lines.push(`  \x1b[2m${lineNo}   ${content}\x1b[0m`);
          break;
      }
    }
  }

  return lines.join("\n");
}

/**
 * Render a compact summary for multiple file diffs.
 */
export function renderDiffSummary(diffs: FileDiff[]): string {
  const totalAdd = diffs.reduce((s, d) => s + d.additions, 0);
  const totalDel = diffs.reduce((s, d) => s + d.deletions, 0);
  const fileList = diffs.map((d) => {
    const icon = d.isNew ? "+" : d.isDeleted ? "×" : "~";
    return `  ${icon} ${d.path}`;
  });

  return [
    `\x1b[1m${diffs.length} file${diffs.length !== 1 ? "s" : ""} changed\x1b[0m (\x1b[32m+${totalAdd}\x1b[0m / \x1b[31m-${totalDel}\x1b[0m)`,
    ...fileList,
  ].join("\n");
}

/**
 * Detect if a chat message contains a diff block and extract it.
 */
export function extractDiffFromMessage(content: string): { before: string; diff: string; after: string } | null {
  // Look for ```diff blocks or raw unified diffs
  const diffBlockMatch = /```diff\n([\s\S]*?)\n```/.exec(content);
  if (diffBlockMatch) {
    const idx = diffBlockMatch.index;
    return {
      before: content.slice(0, idx),
      diff: diffBlockMatch[1]!,
      after: content.slice(idx + diffBlockMatch[0].length),
    };
  }

  // Look for raw unified diff starting with "diff --git"
  const rawDiffMatch = /(^|\n)(diff --git[\s\S]*?)(\n[^+\- @d]|\n$|$)/m.exec(content);
  if (rawDiffMatch) {
    const start = (rawDiffMatch.index ?? 0) + (rawDiffMatch[1]?.length ?? 0);
    return {
      before: content.slice(0, start),
      diff: rawDiffMatch[2]!,
      after: content.slice(start + (rawDiffMatch[2]?.length ?? 0)),
    };
  }

  return null;
}
