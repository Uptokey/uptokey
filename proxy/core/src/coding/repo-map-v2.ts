import { buildRepoGraph, type BuildOpts, type RepoGraph, type SymbolNode } from "./repo-graph.ts";
import { pageRank } from "./pagerank.ts";

export interface RankedFile { path: string; rank: number; sha256: string; loc: number; size: number; symbols: SymbolNode[] }
export async function rankedRepoMap(root: string, focus: string[] = [], options: BuildOpts = {}): Promise<RankedFile[]> {
  const graph = await buildRepoGraph(root, options); const ranks = pageRank(graph, { damping: 0.85, iterations: 30 });
  const normalized = new Set(focus.map((item) => item.replace(/^@/, "").replace(/\\/g, "/")));
  return graph.files.map((file) => { const focused = [...normalized].some((item) => item === file.path || item.endsWith(`/${file.path}`)); const boost = focused ? 5 : 1; return { path: file.path, rank: (ranks.get(file.id) ?? 0) * boost, sha256: file.sha256, loc: file.loc, size: file.size, symbols: graph.symbols.filter((symbol) => symbol.file === file.path), focused }; }).sort((a, b) => Number(b.focused) - Number(a.focused) || b.rank - a.rank || a.path.localeCompare(b.path)).map(({ focused: _focused, ...file }) => file);
}
