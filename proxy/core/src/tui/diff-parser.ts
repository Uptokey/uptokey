export interface DiffHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: DiffLine[];
}

export interface DiffLine {
  type: "add" | "remove" | "context";
  content: string;
  oldLineNum?: number;
  newLineNum?: number;
}

export interface FileDiff {
  path: string;
  hunks: DiffHunk[];
  additions: number;
  deletions: number;
}

/** Parse unified diff data without depending on a terminal component. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = [];
  const lines = diff.split("\n");
  let current: FileDiff | null = null;
  let currentHunk: DiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;

  for (const line of lines) {
    if (line.startsWith("diff --git")) {
      current = null;
      currentHunk = null;
      continue;
    }
    if (line.startsWith("--- ")) continue;
    if (line.startsWith("+++ ")) {
      current = { path: line.slice(4).replace(/^[ab]\//, ""), hunks: [], additions: 0, deletions: 0 };
      files.push(current);
      currentHunk = null;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
      if (match && current) {
        oldLine = parseInt(match[1]!, 10);
        newLine = parseInt(match[3]!, 10);
        currentHunk = {
          oldStart: oldLine,
          oldLines: parseInt(match[2] || "1", 10),
          newStart: newLine,
          newLines: parseInt(match[4] || "1", 10),
          lines: [],
        };
        current.hunks.push(currentHunk);
      }
      continue;
    }
    if (!currentHunk || !current) continue;
    if (line.startsWith("+")) {
      currentHunk.lines.push({ type: "add", content: line.slice(1), newLineNum: newLine++ });
      current.additions++;
    } else if (line.startsWith("-")) {
      currentHunk.lines.push({ type: "remove", content: line.slice(1), oldLineNum: oldLine++ });
      current.deletions++;
    } else {
      currentHunk.lines.push({ type: "context", content: line.startsWith(" ") ? line.slice(1) : line, oldLineNum: oldLine++, newLineNum: newLine++ });
    }
  }
  return files;
}
