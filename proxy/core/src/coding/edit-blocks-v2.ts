/**
 * Uptokey TUI — edit protocol v2
 * Based on Aider's editblock_coder.py (Apache-2.0).
 */
import type { EditBlock, AppliedFile, ApplyFailure } from "../tui/edit-blocks.ts";

export interface MatchOptions {
  reindentTolerant: boolean; // default true
  trailingWhitespaceTolerant: boolean; // default true
  ellipsisSupport: boolean; // default false
  ambiguityStrategy: 'first' | 'reject' | 'ask'; // default 'reject'
}

export interface MatchResult {
  text?: string;
  mode?: AppliedFile["matches"][number];
  error?: string;
  similar?: string;
  ambiguousPositions?: number[];
}

const BOM = String.fromCodePoint(0xfeff);

function trimOuterEmpty(lines: string[]): string[] {
  let start = 0, end = lines.length;
  while (start < end && !lines[start]!.trim()) start++;
  while (end > start && !lines[end - 1]!.trim()) end--;
  return lines.slice(start, end);
}

function normalizeWhitespace(line: string): string {
  return line.replace(/\s+/g, ' ').trim();
}

export function matchAndApply(block: EditBlock, source: string, opts: MatchOptions = {
  reindentTolerant: true,
  trailingWhitespaceTolerant: true,
  ellipsisSupport: false,
  ambiguityStrategy: 'reject'
}): MatchResult {
  const hasBom = source.startsWith(BOM);
  const current = hasBom ? source.slice(1) : source;
  const crlf = current.includes("\r\n");
  const normalizedSource = current.replace(/\r\n/g, "\n");
  
  const search = block.search;
  const replace = block.replace;

  if (!search.trim()) {
    if (normalizedSource.trim()) return { error: "SEARCH vazio só cria arquivos novos; o arquivo já existe" };
    return { text: replace, mode: "create" };
  }

  const lines = normalizedSource.split("\n");
  let searchLines = trimOuterEmpty(search.split("\n"));
  const replaceLines = replace === "" ? [] : replace.split("\n");

  const strategies: Array<{
    mode: "exact" | "trailing_whitespace" | "reindented";
    matches: (haystack: string[], needle: string[]) => Array<{ at: number; length: number; delta?: { add: string, remove: string } }>;
  }> = [];

  // Strategy 1: Exact
  strategies.push({
    mode: "exact",
    matches: (h, n) => {
      const out: Array<{ at: number; length: number; delta?: { add: string; remove: string } }> = [];
      outer: for (let i = 0; i + n.length <= h.length; i++) {
        for (let j = 0; j < n.length; j++) if (h[i + j] !== n[j]) continue outer;
        out.push({ at: i, length: n.length });
      }
      return out;
    }
  });

  // Strategy 2: Trailing whitespace tolerant
  if (opts.trailingWhitespaceTolerant) {
    strategies.push({
      mode: "trailing_whitespace",
      matches: (h, n) => {
        const out: Array<{ at: number; length: number; delta?: { add: string; remove: string } }> = [];
        outer: for (let i = 0; i + n.length <= h.length; i++) {
          for (let j = 0; j < n.length; j++) if (h[i + j]!.trimEnd() !== n[j]!.trimEnd()) continue outer;
          out.push({ at: i, length: n.length });
        }
        return out;
      }
    });
  }

  // Strategy 3: Reindent tolerant
  if (opts.reindentTolerant) {
    strategies.push({
      mode: "reindented",
      matches: (h, n) => {
        const out: Array<{ at: number; length: number; delta?: { add: string; remove: string } }> = [];
        const firstNonEmpty = n.findIndex((line) => line.trim());
        if (firstNonEmpty < 0) return out;
        outer: for (let i = 0; i + n.length <= h.length; i++) {
          const actual = /^[ \t]*/.exec(h[i + firstNonEmpty]!)![0];
          const proposed = /^[ \t]*/.exec(n[firstNonEmpty]!)![0];
          const delta = { add: actual, remove: proposed };
          for (let j = 0; j < n.length; j++) {
            const want = n[j]!;
            const have = h[i + j]!;
            if (!want.trim()) { if (have.trim()) continue outer; continue; }
            if (applyIndent(want, delta).trimEnd() !== have.trimEnd()) {
                if(normalizeWhitespace(want) !== normalizeWhitespace(have)) continue outer;
            }
          }
          out.push({ at: i, length: n.length, delta });
        }
        return out;
      }
    });
  }

  // Ellipsis support: if needle contains '...', we can split it into chunks
  let runStrategies = strategies;
  if (opts.ellipsisSupport && searchLines.some(l => l.trim() === '...')) {
    // Only support ellipsis in reindent or trailing_whitespace mode conceptually, but we can do a special match
    const chunks: string[][] = [];
    let cur: string[] = [];
    for (const l of searchLines) {
      if (l.trim() === '...') {
        if (cur.length) chunks.push(cur);
        cur = [];
      } else {
        cur.push(l);
      }
    }
    if (cur.length) chunks.push(cur);
    
    // Modify strategies to match chunks in order
    runStrategies = runStrategies.map(s => ({
      mode: s.mode,
      matches: (h, n) => {
        const out: Array<{ at: number; length: number; delta?: { add: string; remove: string } }> = [];
        const findChunks = (hLines: string[], startIdx: number) => {
          let currIdx = startIdx;
          const chunkMatches = [];
          for (const chunk of chunks) {
             const m = s.matches(hLines.slice(currIdx), chunk);
             if (m.length === 0) return null;
             // Greedily take the first match for this chunk
             const match = m[0]!;
             chunkMatches.push({ at: currIdx + match.at, length: match.length, delta: match.delta });
             currIdx = currIdx + match.at + match.length;
          }
          return chunkMatches;
        };
        
        for (let i = 0; i < h.length; i++) {
           const matches = findChunks(h, i);
           if (matches && matches.length === chunks.length) {
             const first = matches[0]!;
             const last = matches[matches.length - 1]!;
             if (first.at === i) {
               out.push({
                   at: i,
                   length: last.at + last.length - i,
                   delta: first.delta,
               });
             }
           }
        }
        return out;
      }
    }));
  }

  for (const strategy of runStrategies) {
    const found = strategy.matches(lines, searchLines);
    if (found.length === 1) {
      const match = found[0]!;
      let finalReplace = replaceLines;
      if (match.delta && strategy.mode === "reindented") {
        finalReplace = replaceLines.map((line) => (line.trim() ? applyIndent(line, match.delta!) : line));
      }
      let text = [...lines.slice(0, match.at), ...finalReplace, ...lines.slice(match.at + match.length)].join("\n");
      if (crlf) text = text.replace(/\n/g, "\r\n");
      if (hasBom) text = BOM + text;
      return { text, mode: strategy.mode };
    }
    if (found.length > 1) {
      if (opts.ambiguityStrategy === 'first') {
        const match = found[0]!;
        let finalReplace = replaceLines;
        if (match.delta && strategy.mode === "reindented") {
          finalReplace = replaceLines.map((line) => (line.trim() ? applyIndent(line, match.delta!) : line));
        }
        let text = [...lines.slice(0, match.at), ...finalReplace, ...lines.slice(match.at + match.length)].join("\n");
        if (crlf) text = text.replace(/\n/g, "\r\n");
        if (hasBom) text = BOM + text;
        return { text, mode: strategy.mode };
      }
      return { error: `o trecho SEARCH aparece ${found.length} vezes; inclua mais linhas de contexto`, ambiguousPositions: found.map(f => f.at) };
    }
  }

  // Similar check
  const similar = mostSimilar(lines, searchLines);
  return { error: "o trecho SEARCH não corresponde ao conteúdo atual do arquivo", ...(similar ? { similar } : {}) };
}

function applyIndent(line: string, delta: { add: string; remove: string }): string {
  if (delta.remove && line.startsWith(delta.remove)) return delta.add + line.slice(delta.remove.length);
  return delta.add + line;
}

function mostSimilar(lines: readonly string[], needle: readonly string[]): string | undefined {
  if (!lines.length) return undefined;
  const want = needle.map((line) => line.trim());
  let best = -1, bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    for (let j = 0; j < want.length && i + j < lines.length; j++) if (lines[i + j]!.trim() === want[j] && want[j]) score++;
    if (score > bestScore) { bestScore = score; best = i; }
  }
  if (best < 0 || bestScore === 0) return undefined;
  return lines.slice(best, Math.min(lines.length, best + Math.max(needle.length, 3))).join("\n");
}

export function chunkForLargeFile(content: string, searchContext: string): string {
    if (content.length <= 200000) return content;
    // VERY simplistic chunking matching surrounding context for files > 200kb
    const lines = content.split('\n');
    const searchLines = searchContext.split('\n');
    const similar = mostSimilar(lines, searchLines);
    if (!similar) return content.slice(0, 200000); // fallback
    const idx = content.indexOf(similar);
    const start = Math.max(0, idx - 50000);
    const end = Math.min(content.length, idx + similar.length + 50000);
    return `... [Chunked content before] ...\n${content.slice(start, end)}\n... [Chunked content after] ...`;
}
