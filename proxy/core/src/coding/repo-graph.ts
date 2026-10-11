import { createHash } from "node:crypto";
import { access, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { extname, join, relative, resolve } from "node:path";
import { buildSymbolIndex, type Symbol as IndexedSymbol, type SymbolKind } from "./symbol-index.ts";

export interface SymbolNode { id: string; name: string; kind: "fn" | "class" | "type" | "const" | "method" | "unknown"; file: string }
export interface FileNode { id: string; path: string; sha256: string; loc: number; size: number; mtimeMs: number }
export interface Edge { from: string; to: string; kind: "defines" | "references" }
export interface RepoGraph { files: FileNode[]; symbols: SymbolNode[]; edges: Edge[]; createdAt: string }
export interface BuildOpts { projectId?: string; rootBindingId?: string; dataDir?: string; maxFiles?: number; maxFileSize?: number; ignorePatterns?: string[] }

const CODE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".py", ".rs", ".go", ".java", ".cpp", ".cc", ".cxx", ".h", ".hpp", ".cs", ".rb", ".php", ".swift"]);
const IGNORE_DIRS = new Set(["node_modules", ".git", "dist", "build", "coverage", ".next", "__pycache__", ".venv", "vendor", "target", ".turbo"]);

function kind(kind: SymbolKind): SymbolNode["kind"] { if (kind === "function") return "fn"; if (kind === "method") return "method"; if (["class", "interface", "struct"].includes(kind)) return "class"; if (["type", "enum", "trait"].includes(kind)) return "type"; if (["constant", "variable"].includes(kind)) return "const"; return "unknown"; }
function graphPath(root: string, opts: BuildOpts): string { const data = opts.dataDir ?? process.env.UPTOKEY_QUIMERA_DATA_DIR ?? join(root, ".uptokey-data"); return join(resolve(data), "repo-graph", opts.projectId ?? "default", `${opts.rootBindingId ?? "root"}.json`); }
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
    const cached = JSON.parse(await readFile(cache, "utf8")) as RepoGraph;
    const current = new Map(files.map((file) => [file.path, file.mtimeMs]));
    const valid = cached.files.length === current.size && cached.files.every((file) => current.get(file.path) === file.mtimeMs);
    if (valid) return cached;
  } catch { /* cold cache */ }
  const index = await buildSymbolIndex(root);
  const graphFiles: FileNode[] = files.map((file) => ({ id: `file:${file.path}`, path: file.path, sha256: createHash("sha256").update(file.source).digest("hex"), loc: file.source.split(/\r?\n/).length, size: file.size, mtimeMs: file.mtimeMs }));
  const graphSymbols: SymbolNode[] = []; const edges: Edge[] = []; const bySymbol = new Map<number, SymbolNode>();
  // Hand the event loop back between files and symbol batches: built in an interactive process (the TUI binds a
  // project folder), a large repository otherwise froze every key for minutes.
  for (const file of files) {
    await yieldToEventLoop();
    await index.add(file.absolute, file.source);
    const names = new Set(file.source.match(/[A-Za-z_$][A-Za-z0-9_$]*/g) ?? []);
    for (const name of names) for (const symbol of index.query(name, { file: file.absolute })) {
      const node: SymbolNode = { id: `symbol:${symbol.id}`, name: symbol.name, kind: kind(symbol.kind), file: file.path }; graphSymbols.push(node); bySymbol.set(symbol.id, node); edges.push({ from: node.id, to: `file:${file.path}`, kind: "defines" });
    }
  }
  const seenSymbols = new Set<string>(); const uniqueSymbols = graphSymbols.filter((symbol) => !seenSymbols.has(symbol.id) && (seenSymbols.add(symbol.id), true));
  let batch = 0;
  for (const symbol of [...bySymbol.entries()]) {
    if (++batch % 50 === 0) await yieldToEventLoop();
    for (const reference of index.references(index.query(symbol[1].name, { file: resolve(root, symbol[1].file) }).find((item) => item.id === symbol[0]) ?? index.query(symbol[1].name)[0]!)) {
      edges.push({ from: `file:${relative(root, reference.file).replace(/\\/g, "/")}`, to: symbol[1].id, kind: "references" });
    }
  }
  const graph: RepoGraph = { files: graphFiles, symbols: uniqueSymbols, edges, createdAt: new Date().toISOString() };
  await mkdir(resolve(cache, ".."), { recursive: true }); await writeFile(cache, JSON.stringify(graph), "utf8");
  return graph;
}
