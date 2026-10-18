import { createHash, randomUUID } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, open, rename, unlink } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { createMemorySymbolIndex, type Symbol as IndexedSymbol, type SymbolKind } from "./symbol-index.ts";

export interface SymbolNode { id: string; name: string; kind: "fn" | "class" | "type" | "const" | "method" | "unknown"; file: string }
export interface FileNode { id: string; path: string; sha256: string; loc: number; size: number; mtimeMs: number }
export interface Edge { from: string; to: string; kind: "defines" | "references"; weight?: number }
export interface RepoGraph { files: FileNode[]; symbols: SymbolNode[]; edges: Edge[]; createdAt: string }
export interface BuildOpts { projectId?: string; rootBindingId?: string; dataDir?: string; maxFiles?: number; maxFileSize?: number; ignorePatterns?: string[] }

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs", ".rb", ".php", ".swift"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "__pycache__", ".venv", "vendor", "target", ".turbo"]);

function kind(kind: SymbolKind): SymbolNode["kind"] { if (kind === "function") return "fn"; if (kind === "method") return "method"; if (["class", "interface", "struct"].includes(kind)) return "class"; if (["type", "enum", "trait"].includes(kind)) return "type"; if (["constant", "variable"].includes(kind)) return "const"; return "unknown"; }
// A separate derived-cache version avoids loading the old fully materialized multigraph into memory.
function graphPath(root: string, opts: BuildOpts): string { const data = opts.dataDir ?? process.env.UPTOKEY_QUIMERA_DATA_DIR ?? join(root, ".uptokey-data"); const rootKey = createHash("sha256").update(root).digest("hex").slice(0, 16); return join(resolve(data), "repo-graph", opts.projectId ?? "default", `${opts.rootBindingId ?? "root"}-${rootKey}.v3.json`); }

/** Cache wire format only: a flat numeric array avoids duplicated path strings and millions of tuple arrays. */
interface CompactGraphCache { version: 3; files: FileNode[]; symbols: SymbolNode[]; edges: number[]; createdAt: string }
function decodeGraphCache(cache: CompactGraphCache): RepoGraph {
  if (cache.version !== 3 || !Array.isArray(cache.files) || !Array.isArray(cache.symbols) || !Array.isArray(cache.edges) || cache.edges.length % 4 !== 0) throw new Error("repo_graph_cache_invalid");
  const ids = [...cache.files.map(file => file.id), ...cache.symbols.map(symbol => symbol.id)];
  const edges: Edge[] = [];
  for (let i = 0; i < cache.edges.length; i += 4) {
    const from = cache.edges[i]!, to = cache.edges[i + 1]!, kind = cache.edges[i + 2]!, weight = cache.edges[i + 3]!;
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < 0 || to < 0 || from >= ids.length || to >= ids.length || kind !== 0 && kind !== 1 || !Number.isFinite(weight) || weight <= 0) throw new Error("repo_graph_cache_invalid");
    edges.push(kind === 0 ? { from: ids[from]!, to: ids[to]!, kind: "defines" } : { from: ids[from]!, to: ids[to]!, kind: "references", weight });
  }
  return { files: cache.files, symbols: cache.symbols, edges, createdAt: cache.createdAt };
}

async function writeGraphCache(cache: string, graph: RepoGraph): Promise<void> {
  await mkdir(resolve(cache, ".."), { recursive: true });
  const temporary = `${cache}.${process.pid}.${randomUUID()}.tmp`;
  const file = await open(temporary, "wx");
  let closed = false;
  try {
    const ids = new Map([...graph.files.map(node => node.id), ...graph.symbols.map(node => node.id)].map((id, index) => [id, index]));
    await file.writeFile(`{"version":3,"files":${JSON.stringify(graph.files)},"symbols":${JSON.stringify(graph.symbols)},"createdAt":${JSON.stringify(graph.createdAt)},"edges":[`);
    let batch: string[] = [], first = true;
    const flush = async () => { if (!batch.length) return; await file.writeFile(`${first ? "" : ","}${batch.join(",")}`); first = false; batch = []; };
    for (const edge of graph.edges) {
      batch.push(`${ids.get(edge.from)},${ids.get(edge.to)},${edge.kind === "defines" ? 0 : 1},${edge.weight ?? 1}`);
      if (batch.length === 4096) await flush();
    }
    await flush();
    await file.writeFile("]}");
    await file.close(); closed = true;
    await rename(temporary, cache);
  } finally {
    if (!closed) await file.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}
async function collect(root: string, opts: BuildOpts): Promise<Array<{ path: string; absolute: string; source: string; mtimeMs: number; size: number }>> {
  const found: Array<{ path: string; absolute: string; source: string; mtimeMs: number; size: number }> = [];
  const maxFiles = opts.maxFiles ?? 2000; const maxSize = opts.maxFileSize ?? 500_000;
  async function walk(dir: string): Promise<void> {
    if (found.length >= maxFiles) return;
    let entries; try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (found.length >= maxFiles || IGNORE_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      const absolute = join(dir, entry.name);
      if (entry.isDirectory()) { await walk(absolute); continue; }
      if (!entry.isFile() || !CODE_EXTENSIONS.has(extname(entry.name).toLowerCase())) continue;
      let info; try { info = await stat(absolute); } catch { continue; }
      if (info.size > maxSize) continue;
      try { found.push({ path: relative(root, absolute).replace(/\\/g, "/"), absolute, source: await readFile(absolute, "utf8"), mtimeMs: info.mtimeMs, size: info.size }); } catch { /* unreadable files are omitted */ }
    }
  }
  await walk(root); return found;
}

const yieldToEventLoop = () => new Promise<void>((done) => setImmediate(done));

export async function buildRepoGraph(rootPath: string, options: BuildOpts = {}): Promise<RepoGraph> {
  const root = resolve(rootPath); const cache = graphPath(root, options); const files = await collect(root, options);
  try {
    const cached = JSON.parse(await readFile(cache, "utf8")) as CompactGraphCache;
    const current = new Map(files.map((file) => [file.path, file.mtimeMs]));
    const valid = cached.files.length === current.size && cached.files.every((file) => current.get(file.path) === file.mtimeMs);
    if (valid) return decodeGraphCache(cached);
  } catch { /* cold cache */ }
  // This derived graph reparses the complete selected set. Loading a second persisted symbol snapshot
  // first both retains stale references and can duplicate definitions from previous revisions.
  const index = createMemorySymbolIndex(root);
  const graphFiles: FileNode[] = files.map((file) => ({ id: `file:${file.path}`, path: file.path, sha256: createHash("sha256").update(file.source).digest("hex"), loc: file.source.split(/\r?\n/).length, size: file.size, mtimeMs: file.mtimeMs }));
  const fileIds = new Map(files.map((file, index) => [file.absolute, graphFiles[index]!.id]));
  const graphSymbols: SymbolNode[] = []; const edges: Edge[] = []; const bySymbol = new Map<number, SymbolNode>();
  // Hand the event loop back between files and symbol batches: built in an interactive process (the TUI binds a
  // project folder), a large repository otherwise froze every key for minutes.
  for (const file of files) {
    await yieldToEventLoop();
    await index.add(file.absolute, file.source);
    const names = new Set(file.source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
    for (const name of names) for (const symbol of index.query(name, { file: file.absolute })) {
      const node: SymbolNode = { id: `symbol:${symbol.id}`, name: symbol.name, kind: kind(symbol.kind), file: file.path }; graphSymbols.push(node); bySymbol.set(symbol.id, node); edges.push({ from: node.id, to: fileIds.get(file.absolute)!, kind: "defines" });
    }
  }
  const seenSymbols = new Set<string>(); const uniqueSymbols = graphSymbols.filter((symbol) => !seenSymbols.has(symbol.id) && (seenSymbols.add(symbol.id), true));
  let batch = 0;
  for (const symbol of [...bySymbol.entries()]) {
    if (++batch % 50 === 0) await yieldToEventLoop();
    for (const reference of index.referenceFiles(index.query(symbol[1].name, { file: resolve(root, symbol[1].file) }).find((item) => item.id === symbol[0]) ?? index.query(symbol[1].name)[0]!)) {
      // Parallel edges only encode occurrence multiplicity. Store the exact count instead of a Range-bearing object per occurrence.
      edges.push({ from: fileIds.get(reference.file)!, to: symbol[1].id, kind: "references", weight: reference.count });
    }
  }
  const graph: RepoGraph = { files: graphFiles, symbols: uniqueSymbols, edges, createdAt: new Date().toISOString() };
  await writeGraphCache(cache, graph);
  return graph;
}
