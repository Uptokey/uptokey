/** Repository analysis is CPU work. It must never share the terminal's input/render thread. */
import { parentPort, workerData } from "node:worker_threads";
import { rankedRepoMap } from "../coding/repo-map-v2.ts";
import type { BuildOpts } from "../coding/repo-graph.ts";
import type { RepoMapEntry } from "./repo-map.ts";

const request = workerData as { rootPath: string; options: BuildOpts };
try {
  const ranked = await rankedRepoMap(request.rootPath, [], request.options);
  const entries: RepoMapEntry[] = ranked.slice(0, request.options.maxFiles ?? 500).map(entry => ({
    path: entry.path,
    size: entry.size,
    symbols: entry.symbols.map(symbol => ({
      name: symbol.name,
      type: symbol.kind === "fn" ? "function" : symbol.kind === "class" ? "class" : symbol.kind === "method" ? "method" : symbol.kind === "type" ? "type" : symbol.kind === "const" ? "const" : "export",
      file: entry.path,
      line: 0,
    })),
  }));
  parentPort?.postMessage({ entries });
} catch {
  parentPort?.postMessage({ error: "repo_map_worker_failed" });
} finally { parentPort?.close(); }
