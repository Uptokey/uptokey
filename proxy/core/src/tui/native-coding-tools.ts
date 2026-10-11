/** Coding intelligence uses authorized core reads and an ephemeral tree-sitter
 * index. No direct project filesystem access, cache authority or fake receipts. */
import { relative } from "node:path";
import type { TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor, NativeToolExecutionContext } from "./conversations.ts";
import type { ProjectBinding } from "./project-binding.ts";
import type { WorkspaceService } from "./workspace.ts";
import type { Diagnostic } from "./lsp.ts";
import { createMemorySymbolIndex, symbolLanguageForFile, type Symbol as IndexedSymbol } from "../coding/symbol-index.ts";
import { pageRank } from "../coding/pagerank.ts";
import type { RepoGraph, SymbolNode } from "../coding/repo-graph.ts";

export interface NativeDiagnosticsResult {
  status: "completed" | "partial" | "not_executed";
  files: Array<{ path: string; diagnostics: Diagnostic[] }>;
  unavailable: Array<{ path: string; reason: string }>;
  serverCount: number;
}
const pathProperty = { type: "string", description: "Optional relative directory to narrow indexing. Defaults to the bound root." };
const nameProperty = { type: "string", description: "Exact symbol name." };
function tool(name: string, description: string, properties: Record<string, unknown>, required: string[]): TuiFunctionTool {
  return { type: "function", function: { name, description, parameters: { type: "object", properties, required, additionalProperties: false } } };
}
export const NATIVE_CODING_TOOLS: TuiFunctionTool[] = [
  tool("get_repo_map", "Build a real PageRank map from authorized project files and tree-sitter definitions/references. Coverage and skipped files are explicit; narrow path for a large project.", { path: pathProperty, focus: { type: "array", items: { type: "string" }, maxItems: 30 } }, []),
  tool("get_symbol_definition", "Find tree-sitter definitions by exact name in authorized project files; returns relative paths and 1-based positions. An incomplete scan is not proof of absence.", { name: nameProperty, path: pathProperty }, ["name"]),
  tool("get_symbol_references", "Find identifier references to an indexed symbol. Name-based candidates are explicitly distinguished from semantic LSP references; results include scope and coverage.", { name: nameProperty, path: pathProperty, definitionFile: { type: "string" } }, ["name"]),
  tool("lsp_diagnostics", "Read actual LSP diagnostics after any required UI consent. The result includes messages and ranges, or an explicit unavailable/declined status. It does not merely ask the user to inspect a panel.", { paths: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 30 } }, ["paths"]),
  tool("lsp_definition", "Use the active Language Server Protocol to find exact semantic definitions (goto definition) for a given file and position. Requires UI consent to start the LSP.", { path: pathProperty, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } }, ["path", "line", "column"]),
  tool("lsp_references", "Use the active Language Server Protocol to find semantic references for a given file and position. Requires UI consent.", { path: pathProperty, line: { type: "integer", minimum: 1 }, column: { type: "integer", minimum: 1 } }, ["path", "line", "column"]),
];
function pathOf(input: unknown, allowRoot = true): string {
  if (input === undefined && allowRoot) return "";
  if (typeof input !== "string" || input.length > 2048 || /[\x00-\x1f:]/.test(input)) throw new Error("project_path_invalid");
  const path = input.replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "");
  if (allowRoot && (!path || path === ".")) return "";
  if (!path || path.startsWith("/") || path.split("/").some(part => !part || part === "." || part === "..")) throw new Error("project_path_invalid");
  return path;
}
function nameOf(value: unknown): string {
  if (typeof value !== "string" || !value.trim() || value.length > 256 || /[\r\n\x00]/.test(value)) throw new Error("symbol_name_invalid");
  return value;
}
function kindOf(symbol: IndexedSymbol): SymbolNode["kind"] {
  return symbol.kind === "function" ? "fn" : symbol.kind === "method" ? "method" : ["class", "interface", "struct"].includes(symbol.kind) ? "class" : ["type", "enum", "trait"].includes(symbol.kind) ? "type" : ["variable", "constant"].includes(symbol.kind) ? "const" : "unknown";
}

export function nativeCodingExecutor(options: {
  workspace: Pick<WorkspaceService, "listProjectDirectory" | "readProjectFile">;
  binding: ProjectBinding;
  stillBound: () => boolean;
  diagnostics: (paths: string[], signal?: AbortSignal, context?: NativeToolExecutionContext) => Promise<NativeDiagnosticsResult>;
  lspDefinition?: (path: string, line: number, column: number, signal?: AbortSignal, context?: NativeToolExecutionContext) => Promise<any>;
  lspReferences?: (path: string, line: number, column: number, signal?: AbortSignal, context?: NativeToolExecutionContext) => Promise<any>;
}): NativeReadToolExecutor {
  const { workspace, binding } = options;
  const index = createMemorySymbolIndex(binding.rootPath);
  const hashes = new Map<string, string>();
  const localPath = (file: string) => relative(binding.rootPath, file).replaceAll("\\", "/");
  const projection = (symbol: IndexedSymbol) => ({ name: symbol.name, kind: symbol.kind, file: localPath(symbol.file), language: symbol.language, scope: symbol.scope,
    range: { start: { line: symbol.range.startPosition.row + 1, column: symbol.range.startPosition.column + 1 }, end: { line: symbol.range.endPosition.row + 1, column: symbol.range.endPosition.column + 1 } } });
  return async (call, signal, context) => {
    const check = async () => { signal?.throwIfAborted(); if (!options.stillBound()) throw new Error("project_binding_changed"); await context?.assertCurrent(); signal?.throwIfAborted(); if (!options.stillBound()) throw new Error("project_binding_changed"); };
    await check();
    const definition = NATIVE_CODING_TOOLS.find(item => item.function.name === call.name);
    if (!definition) throw new Error("conversation_tool_unavailable");
    const allowed = Object.keys(definition.function.parameters.properties as object);
    if (Object.keys(call.arguments).some(key => !allowed.includes(key))) throw new Error("coding_arguments_invalid");
    if (call.name === "lsp_diagnostics") {
      if (!Array.isArray(call.arguments.paths) || !call.arguments.paths.length || call.arguments.paths.length > 30) throw new Error("coding_arguments_invalid");
      const paths = [...new Set(call.arguments.paths.map(path => pathOf(path, false)))];
      const result = await options.diagnostics(paths, signal, context);
      await check();
      const output = { ...result, files: result.files.map(file => ({ ...file, diagnostics: [...file.diagnostics] })), outputTruncated: false };
      while (Buffer.byteLength(JSON.stringify(output)) > 64_000) {
        const largest = output.files.filter(file => file.diagnostics.length).sort((a, b) => b.diagnostics.length - a.diagnostics.length)[0];
        if (!largest) throw new Error("coding_result_too_large");
        largest.diagnostics.pop(); output.outputTruncated = true;
      }
      const metadata = { status: result.status, tool: call.name, serverCount: result.serverCount, files: result.files.map(file => ({ path: file.path, count: file.diagnostics.length })), unavailable: result.unavailable, outputTruncated: output.outputTruncated, contentPersisted: false };
      return { output: JSON.stringify(output), persistedOutput: metadata };
    }
    if (call.name === "lsp_definition" || call.name === "lsp_references") {
      const scope = pathOf(call.arguments.path, false);
      const line = Number(call.arguments.line);
      const column = Number(call.arguments.column);
      if (!Number.isSafeInteger(line) || !Number.isSafeInteger(column) || line < 1 || column < 1) throw new Error("coding_arguments_invalid");
      try {
        const handler = call.name === "lsp_definition" ? options.lspDefinition : options.lspReferences;
        if (!handler) throw new Error("lsp_server_unavailable");
        const locations = await handler(scope, line, column, signal, context);
        await check();
        const metadata = { status: "completed", tool: call.name, count: locations.length };
        return { output: JSON.stringify({ locations }), persistedOutput: metadata };
      } catch (error) {
        await check();
        const metadata = { status: "not_executed", tool: call.name, reason: error instanceof Error ? error.message : String(error) };
        return { output: JSON.stringify({ status: "not_executed", error: metadata.reason }), persistedOutput: metadata };
      }
    }
    const scope = pathOf(call.arguments.path);
    const name = call.name === "get_repo_map" ? null : nameOf(call.arguments.name);
    const definitionFile = call.arguments.definitionFile === undefined ? undefined : pathOf(call.arguments.definitionFile, false);
    if (call.arguments.focus !== undefined && (!Array.isArray(call.arguments.focus) || call.arguments.focus.length > 30)) throw new Error("coding_arguments_invalid");
    const focus = Array.isArray(call.arguments.focus) ? call.arguments.focus.map(path => pathOf(path, false)) : [];
    const queue = [{ path: scope, offset: 0 }];
    const pending: Array<{ path: string; byteLength: number }> = [];
    const scanned: Array<{ path: string; sha256: string; bytes: number; loc: number }> = [];
    const skipped: Array<{ path: string; reason: string }> = [];
    const observed = new Set<string>();
    let pages = 0, bytes = 0, parseMs = 0, reparsed = 0;
    while ((queue.length || pending.length) && pages < 40 && scanned.length < 256 && bytes < 4_000_000) {
      await check();
      if (!pending.length) {
        const folder = queue.shift()!;
        const page = await workspace.listProjectDirectory(binding.projectId, binding.rootBindingId, folder.path, folder.offset, signal);
        await check(); pages++;
        if (page.nextOffset !== null) queue.unshift({ path: folder.path, offset: page.nextOffset });
        for (const entry of page.entries) {
          const path = pathOf(entry.relativePath, false);
          if (entry.kind === "directory") queue.push({ path, offset: 0 });
          else if (symbolLanguageForFile(path)) pending.push({ path, byteLength: entry.byteLength });
        }
        continue;
      }
      const entry = pending.shift()!;
      if (entry.byteLength > 256_000) { skipped.push({ path: entry.path, reason: "project_file_too_large" }); continue; }
      const file = await workspace.readProjectFile(binding.projectId, binding.rootBindingId, entry.path, signal);
      await check();
      if (!file) { skipped.push({ path: entry.path, reason: "project_file_not_found" }); continue; }
      bytes += file.byteLength; observed.add(entry.path);
      if (hashes.get(entry.path) !== file.sha256) {
        const started = performance.now();
        try { await index.add(entry.path, file.text); }
        catch (error) { if (signal?.aborted || !options.stillBound()) throw error; index.remove(entry.path); hashes.delete(entry.path); skipped.push({ path: entry.path, reason: "grammar_unavailable" }); continue; }
        parseMs += performance.now() - started; reparsed++;
        await check(); hashes.set(entry.path, file.sha256);
      }
      scanned.push({ path: entry.path, sha256: file.sha256, bytes: file.byteLength, loc: file.text.split("\n").length });
    }
    for (const path of hashes.keys()) if (!observed.has(path)) { hashes.delete(path); index.remove(path); }
    await check();
    const coverage = { path: scope || ".", scannedFiles: scanned.length, scannedBytes: bytes, directoryPages: pages, complete: queue.length === 0 && pending.length === 0 && skipped.length === 0, skipped: skipped.slice(0, 100), skippedCount: skipped.length, reparsedFiles: reparsed, parseMs: Math.round(parseMs * 100) / 100 };
    const definitions = index.definitions();
    let result: Record<string, unknown>;
    if (call.name === "get_repo_map") {
      const symbols: SymbolNode[] = definitions.map(symbol => ({ id: `symbol:${symbol.id}`, name: symbol.name, kind: kindOf(symbol), file: localPath(symbol.file) }));
      const graph: RepoGraph = { files: scanned.map(file => ({ id: `file:${file.path}`, path: file.path, sha256: file.sha256, size: file.bytes, loc: file.loc, mtimeMs: 0 })), symbols, edges: [], createdAt: new Date().toISOString() };
      for (const symbol of definitions) {
        graph.edges.push({ from: `symbol:${symbol.id}`, to: `file:${localPath(symbol.file)}`, kind: "defines" });
        for (const reference of index.references(symbol)) graph.edges.push({ from: `file:${localPath(reference.file)}`, to: `symbol:${symbol.id}`, kind: "references" });
      }
      const ranks = pageRank(graph, { damping: 0.85, iterations: 30 });
      const files = scanned.map(file => ({ path: file.path, rank: (ranks.get(`file:${file.path}`) ?? 0) * (focus.some(path => path === file.path || file.path.startsWith(path + "/")) ? 5 : 1), symbols: definitions.filter(symbol => localPath(symbol.file) === file.path).slice(0, 60).map(projection) })).sort((a, b) => b.rank - a.rank || a.path.localeCompare(b.path));
      result = { status: "completed", coverage, files: files.slice(0, 40), outputTruncated: files.length > 40 };
    } else {
      const matches = index.query(name!).filter(symbol => !definitionFile || localPath(symbol.file) === definitionFile);
      result = { status: "completed", coverage, definitions: matches.slice(0, 80).map(projection), outputTruncated: matches.length > 80 };
      if (call.name === "get_symbol_references") {
        const references = matches.flatMap(symbol => index.references(symbol).map(ref => ({ definition: projection(symbol), file: localPath(ref.file), line: ref.range.startPosition.row + 1, column: ref.range.startPosition.column + 1 })));
        result.references = references.slice(0, 160); result.resolution = "identifier_name_candidates"; result.semantic = false;
        result.outputTruncated = Boolean(result.outputTruncated) || references.length > 160;
      }
    }
    // Keep complete records, trimming arrays rather than cutting JSON or paths.
    const arrays = [result.files, result.definitions, result.references, coverage.skipped].filter(Array.isArray) as unknown[][];
    while (Buffer.byteLength(JSON.stringify(result)) > 64_000) {
      const largest = arrays.filter(array => array.length).sort((a, b) => b.length - a.length)[0];
      if (!largest) throw new Error("coding_result_too_large");
      largest.pop(); result.outputTruncated = true;
    }
    const { skipped: _skipped, ...coverageSummary } = coverage;
    const metadata = { status: result.status, tool: call.name, coverage: coverageSummary, outputTruncated: result.outputTruncated, contentPersisted: false };
    return { output: JSON.stringify(result), persistedOutput: metadata, references: scanned.slice(0, 8).map(file => ({ rootBindingId: binding.rootBindingId, relativePath: file.path, sha256: file.sha256, byteLength: file.bytes })) };
  };
}
