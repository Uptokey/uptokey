/**
 * C6 / step 1 — fault localization (DeepSeek Agentless-inspired).
 *
 * Two stages, both local-first:
 * (a) deterministic ranking of the repository graph (A10): token overlap
 *     between the issue text and file paths/symbols, weighted by PageRank —
 *     no network, no model;
 * (b) optional architect refinement (A14 prompts, injected caller): the
 *     architect names the files most likely affected; its answer is filtered
 *     to files that actually exist in the graph and merged over the lexical
 *     ranking.
 *
 * Embeddings remain an opt-in enhancer: when a caller supplies `embed`, the
 * similarity replaces the lexical overlap; without it the harness stays free
 * and offline.
 */
import { architectTask } from "../prompts/architect.ts";
import { pageRank } from "../pagerank.ts";
import type { RepoGraph } from "../repo-graph.ts";

export interface LocalizedFiles {
  /** Repo-relative paths, best candidate first, at most `k`. */
  files: string[];
  /** Deterministic lexical+PageRank score per file (0..1-ish, for the report). */
  scores: Map<string, number>;
  source: "lexical" | "architect";
}

const STOPWORDS = new Set([
  "the", "and", "for", "with", "this", "that", "from", "into", "que", "uma",
  "dos", "das", "não", "com", "por", "para", "como", "mais", "este", "isso",
  "should", "would", "could", "when", "where", "which", "while", "return",
  "function", "arquivo", "arquivos", "file", "files", "code", "código",
]);

export function tokenize(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9_]{3,}/g) ?? []).filter((token) => !STOPWORDS.has(token));
}

/** Deterministic stage (a): lexical overlap + PageRank tiebreak. */
export function rankFilesByIssue(issue: string, graph: RepoGraph, k = 20): Array<{ path: string; score: number }> {
  const ranks = pageRank(graph, { damping: 0.85, iterations: 30 });
  const issueTokens = new Set(tokenize(issue));
  const symbolsByFile = new Map<string, string[]>();
  for (const symbol of graph.symbols) {
    const list = symbolsByFile.get(symbol.file) ?? [];
    list.push(symbol.name);
    symbolsByFile.set(symbol.file, list);
  }
  const scored = graph.files.map((file) => {
    const fileTokens = new Set([
      ...tokenize(file.path.replace(/[/\\.-]/g, " ")),
      ...tokenize((symbolsByFile.get(file.path) ?? []).join(" ")),
    ]);
    let overlap = 0;
    for (const token of issueTokens) if (fileTokens.has(token)) overlap++;
    const rank = ranks.get(file.path) ?? 0;
    // Overlap dominates; PageRank only breaks ties (bounded boost).
    const score = overlap > 0 ? overlap + Math.min(rank, 0.05) : rank / 1000;
    return { path: file.path, score };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, k).filter((entry) => entry.score > 0);
}

/** Stage (b) parser: "Files most likely affected: file.py (why)" lines. */
export function parseArchitectFiles(text: string): string[] {
  const paths: string[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const match = /(?:^|[\s\-*\d.([{])((?:[\w.@-]+[/\\])?[\w.@-]+\.[A-Za-z0-9]{1,8})\b/.exec(raw.replace(/^#+\s*/, ""));
    const candidate = match?.[1];
    if (!candidate) continue;
    const normalized = candidate.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!paths.includes(normalized)) paths.push(normalized);
  }
  return paths;
}

export interface LocalizeOptions {
  k?: number;
  /** A14 architect transport (fixture in tests; the canonical gateway in production). */
  architect?: (prompt: string) => Promise<string>;
}

export async function localize(issue: string, graph: RepoGraph, options: LocalizeOptions = {}): Promise<LocalizedFiles> {
  const k = options.k ?? 20;
  const ranked = rankFilesByIssue(issue, graph, k);
  const scores = new Map(ranked.map((entry) => [entry.path, entry.score]));
  const known = new Set(graph.files.map((file) => file.path));

  if (!options.architect) {
    return { files: ranked.map((entry) => entry.path), scores, source: "lexical" };
  }

  const context = ranked.slice(0, k).map((entry) => {
    const symbols = graph.symbols.filter((symbol) => symbol.file === entry.path).map((symbol) => symbol.name).slice(0, 10);
    return `${entry.path} (score ${entry.score.toFixed(3)}${symbols.length ? `; símbolos: ${symbols.join(", ")}` : ""})`;
  }).join("\n");
  const response = await options.architect(architectTask(issue, context));
  const architectFiles = parseArchitectFiles(response).filter((path) => known.has(path));
  if (!architectFiles.length) {
    return { files: ranked.map((entry) => entry.path), scores, source: "lexical" };
  }
  // Architect candidates first (graph-verified), lexical ranking fills the rest.
  const files = [...architectFiles, ...ranked.map((entry) => entry.path).filter((path) => !architectFiles.includes(path))].slice(0, k);
  return { files, scores, source: "architect" };
}
