import type { RepoGraph } from "./repo-graph.ts";

export interface PageRankOptions { damping?: number; iterations?: number }

/**
 * PageRank over the file/symbol graph. The update is intentionally deterministic
 * so repo context is stable across clients and runtimes.
 */
export function pageRank(graph: RepoGraph, options: PageRankOptions = {}): Map<string, number> {
  const damping = options.damping ?? 0.85;
  const iterations = options.iterations ?? 30;
  const nodes = [...graph.files.map((file) => file.id), ...graph.symbols.map((symbol) => symbol.id)];
  const n = nodes.length;
  if (!n) return new Map();
  const outgoing = new Map<string, string[]>();
  const incoming = new Map<string, string[]>();
  for (const node of nodes) { outgoing.set(node, []); incoming.set(node, []); }
  for (const edge of graph.edges) {
    if (!outgoing.has(edge.from) || !incoming.has(edge.to)) continue;
    outgoing.get(edge.from)?.push(edge.to);
    incoming.get(edge.to)?.push(edge.from);
  }
  let ranks = new Map(nodes.map((node) => [node, 1 / n]));
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const next = new Map<string, number>();
    const dangling = nodes.reduce((sum, node) => sum + (outgoing.get(node)?.length ? 0 : (ranks.get(node) ?? 0)), 0);
    for (const node of nodes) {
      let contribution = dangling / n;
      for (const source of incoming.get(node) ?? []) {
        const degree = outgoing.get(source)?.length ?? 1;
        contribution += (ranks.get(source) ?? 0) / degree;
      }
      next.set(node, (1 - damping) / n + damping * contribution);
    }
    ranks = next;
  }
  return ranks;
}
