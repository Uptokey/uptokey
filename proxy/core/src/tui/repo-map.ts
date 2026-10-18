/**
 * Builds a ranked map of repository files and symbols for bounded model
 * context using the shared repository analysis service.
 */
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, extname, isAbsolute } from "node:path";
import { Worker } from "node:worker_threads";

declare const UPTOKEY_REPO_MAP_WORKER_PATH: string | undefined;

export interface RepoSymbol {
  name: string;
  type: "function" | "class" | "interface" | "type" | "const" | "export" | "method";
  file: string;
  line: number;
}

export interface RepoMapEntry {
  path: string;
  symbols: RepoSymbol[];
  size: number;
}

export interface RepoMapOptions {
  maxFiles?: number;
  maxFileSize?: number;
  ignorePatterns?: string[];
  signal?: AbortSignal;
}

const IGNORE_DIRS = new Set([
  "node_modules", ".git", "dist", "build", "coverage", ".next",
  "__pycache__", ".venv", "vendor", "target", ".turbo",
]);

const CODE_EXTENSIONS = new Set([
  ".ts", ".tsx", ".js", ".jsx", ".py", ".rs", ".go", ".java",
  ".c", ".cpp", ".h", ".hpp", ".cs", ".rb", ".php", ".swift",
  ".kt", ".scala", ".vue", ".svelte", ".astro",
]);

// Regex patterns for symbol extraction (language-agnostic subset)
const SYMBOL_PATTERNS: Array<{ regex: RegExp; type: RepoSymbol["type"] }> = [
  { regex: /^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm, type: "function" },
  { regex: /^(?:export\s+)?class\s+(\w+)/gm, type: "class" },
  { regex: /^(?:export\s+)?interface\s+(\w+)/gm, type: "interface" },
  { regex: /^(?:export\s+)?type\s+(\w+)\s*[=<]/gm, type: "type" },
  { regex: /^(?:export\s+)?const\s+(\w+)\s*[:=]/gm, type: "const" },
  { regex: /^\s+(?:async\s+)?(\w+)\s*\([^)]*\)\s*[:{]/gm, type: "method" },
  { regex: /^def\s+(\w+)/gm, type: "function" },
  { regex: /^class\s+(\w+)/gm, type: "class" },
  { regex: /^(?:pub\s+)?fn\s+(\w+)/gm, type: "function" },
  { regex: /^func\s+(\w+)/gm, type: "function" },
];

/**
 * Extract symbols from a source file using regex patterns.
 */
function extractSymbols(content: string, filePath: string): RepoSymbol[] {
  const symbols: RepoSymbol[] = [];
  const lines = content.split("\n");

  for (const { regex, type } of SYMBOL_PATTERNS) {
    const re = new RegExp(regex.source, regex.flags);
    let match: RegExpExecArray | null;
    while ((match = re.exec(content)) !== null) {
      const name = match[1];
      if (!name || name.length < 2 || name.startsWith("_")) continue;
      // Find line number
      const lineNo = content.slice(0, match.index).split("\n").length;
      symbols.push({ name, type, file: filePath, line: lineNo });
    }
  }

  // Deduplicate by name+type
  const seen = new Set<string>();
  return symbols.filter((s) => {
    const key = `${s.name}:${s.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * Walk a directory tree and build a repo map.
 */
async function buildRepoMapLegacy(
  rootPath: string,
  options?: { maxFiles?: number; maxFileSize?: number; ignorePatterns?: string[] },
): Promise<RepoMapEntry[]> {
  const maxFiles = options?.maxFiles ?? 500;
  const maxFileSize = options?.maxFileSize ?? 100_000; // 100KB
  const entries: RepoMapEntry[] = [];

  async function walk(dir: string): Promise<void> {
    if (entries.length >= maxFiles) return;
    let items: string[];
    try { items = await readdir(dir); } catch { return; }

    for (const item of items) {
      if (entries.length >= maxFiles) break;
      if (IGNORE_DIRS.has(item) || item.startsWith(".")) continue;

      const fullPath = join(dir, item);
      let stats;
      try { stats = await stat(fullPath); } catch { continue; }

      if (stats.isDirectory()) {
        await walk(fullPath);
      } else if (stats.isFile() && CODE_EXTENSIONS.has(extname(item))) {
        if (stats.size > maxFileSize) continue;
        try {
          const content = await readFile(fullPath, "utf-8");
          const relPath = relative(rootPath, fullPath).replace(/\\/g, "/");
          const symbols = extractSymbols(content, relPath);
          if (symbols.length > 0) {
            entries.push({ path: relPath, symbols, size: stats.size });
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  await walk(rootPath);
  return entries.sort((a, b) => b.symbols.length - a.symbols.length);
}

/** Compatibility facade: the canonical map is now PageRank + symbol graph. */
export async function buildRepoMap(
  rootPath: string,
  options: RepoMapOptions = {},
): Promise<RepoMapEntry[]> {
  options.signal?.throwIfAborted();
  const workerPath = typeof UPTOKEY_REPO_MAP_WORKER_PATH === "string"
    ? UPTOKEY_REPO_MAP_WORKER_PATH : "./repo-map-worker.ts";
  const worker = new Worker(isAbsolute(workerPath) ? workerPath : new URL(workerPath, import.meta.url), {
    workerData: { rootPath, options: { maxFiles: options.maxFiles, maxFileSize: options.maxFileSize, ignorePatterns: options.ignorePatterns } },
  });
  try {
    return await new Promise<RepoMapEntry[]>((resolve, reject) => {
      let settled = false;
      const finish = (error?: Error, entries?: RepoMapEntry[]) => {
        if (settled) return;
        settled = true;
        options.signal?.removeEventListener("abort", abort);
        if (error) reject(error); else resolve(entries!);
      };
      const abort = () => finish(options.signal?.reason instanceof Error ? options.signal.reason : new DOMException("Aborted", "AbortError"));
      worker.once("message", (message: { entries?: RepoMapEntry[]; error?: string }) => {
        if (message.error || !Array.isArray(message.entries)) finish(new Error("repo_map_worker_failed"));
        else finish(undefined, message.entries);
      });
      worker.once("error", error => finish(error instanceof Error ? error : new Error("repo_map_worker_failed")));
      worker.once("exit", () => finish(new Error("repo_map_worker_closed")));
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  } finally { await worker.terminate(); }
}

/**
 * Format repo map as a concise string for LLM context.
 * Shows file paths with their key symbols, sorted by relevance.
 */
export function formatRepoMap(entries: RepoMapEntry[], maxTokenBudget: number = 2000): string {
  const lines: string[] = ["# Repository Map\n"];
  let estimatedTokens = 5;

  for (const entry of entries) {
    const symbolList = entry.symbols
      .slice(0, 15) // max 15 symbols per file
      .map((s) => `  ${s.type === "class" || s.type === "interface" ? "●" : s.type === "function" || s.type === "method" ? "ƒ" : "◦"} ${s.name}`)
      .join("\n");

    const block = `\n${entry.path}\n${symbolList}`;
    const blockTokens = Math.ceil(block.length / 4);

    if (estimatedTokens + blockTokens > maxTokenBudget) break;
    lines.push(block);
    estimatedTokens += blockTokens;
  }

  return lines.join("\n");
}

/**
 * Find symbols relevant to a query (for context selection).
 */
export function findRelevantSymbols(entries: RepoMapEntry[], query: string, limit: number = 10): RepoSymbol[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  const scored: Array<{ symbol: RepoSymbol; score: number }> = [];

  for (const entry of entries) {
    for (const symbol of entry.symbols) {
      const name = symbol.name.toLowerCase();
      const file = symbol.file.toLowerCase();
      let score = 0;
      for (const term of terms) {
        if (name === term) score += 10;
        else if (name.includes(term)) score += 5;
        if (file.includes(term)) score += 2;
      }
      if (score > 0) scored.push({ symbol, score });
    }
  }

  return scored
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((s) => s.symbol);
}
