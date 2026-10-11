import { createRequire } from "node:module";
import { mkdir, readFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { Language, Node, Parser } from "web-tree-sitter";
import { getWasmPath } from "tree-sitter-wasm";

export type SupportedLanguage =
  | "javascript" | "typescript" | "python" | "go" | "rust" | "java"
  | "c_sharp" | "cpp" | "ruby" | "php" | "swift";

export type SymbolKind =
  | "function" | "method" | "class" | "interface" | "struct" | "enum"
  | "trait" | "module" | "type" | "variable" | "constant" | "unknown";

export interface Position { row: number; column: number }
export interface SymbolRange {
  startIndex: number;
  endIndex: number;
  startPosition: Position;
  endPosition: Position;
}
export interface Symbol {
  id: number;
  name: string;
  kind: SymbolKind;
  file: string;
  range: SymbolRange;
  scope: string[];
  language: SupportedLanguage;
}
export interface SymbolReference {
  symbolId: number;
  name: string;
  file: string;
  line: number;
  range: SymbolRange;
}
export interface FileNode { path: string }
export interface SymbolQueryOptions { file?: string; kind?: SymbolKind }
export interface SymbolIndex {
  add(file: string | FileNode, source: string): Promise<void>;
  query(name: string, opts?: SymbolQueryOptions): Symbol[];
  definitions(file?: string): Symbol[];
  remove(file: string): void;
  references(symbol: Symbol): SymbolReference[];
  refresh(file: string | FileNode): Promise<void>;
  save(): Promise<void>;
  load(): Promise<void>;
}

const require = createRequire(import.meta.url);
const EXTENSIONS: Record<string, SupportedLanguage> = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "typescript", ".py": "python", ".go": "go", ".rs": "rust",
  ".java": "java", ".cs": "c_sharp", ".cpp": "cpp", ".cc": "cpp", ".cxx": "cpp",
  ".h": "cpp", ".hpp": "cpp", ".rb": "ruby", ".php": "php", ".swift": "swift",
};
const IDENTIFIER = /^(identifier|type_identifier|property_identifier|field_identifier|namespace_identifier|shorthand_property_identifier_pattern|constant|variable_name|class_name)$/;
const DECLARATION = /(function|method|class|interface|struct|enum|trait|namespace|module|type_alias|type_definition|record|impl_item|variable_declarator|property_declaration|const_item|static_item|let_declaration)/;

type SqliteStatement = { run: (...values: unknown[]) => unknown; all: (...values: unknown[]) => unknown[] };
type SqliteDb = { exec: (sql: string) => void; prepare: (sql: string) => SqliteStatement; close: () => void };
type SqliteCtor = new (path: string) => SqliteDb;

function filePath(file: string | FileNode): string { return typeof file === "string" ? file : file.path; }
function languageFor(file: string): SupportedLanguage | undefined { return EXTENSIONS[extname(file).toLowerCase()]; }
function kindFor(type: string): SymbolKind {
  const t = type.toLowerCase();
  if (t.includes("function") || t.includes("lambda") || t.includes("closure")) return "function";
  if (t.includes("method") || t.includes("constructor")) return "method";
  if (t.includes("interface")) return "interface";
  if (t.includes("class") || t.includes("record")) return "class";
  if (t.includes("struct")) return "struct";
  if (t.includes("enum")) return "enum";
  if (t.includes("trait")) return "trait";
  if (t.includes("namespace") || t.includes("module")) return "module";
  if (t.includes("type_") || t.includes("impl_item")) return "type";
  if (t.includes("const") || t.includes("static")) return "constant";
  if (t.includes("variable") || t.includes("let_") || t.includes("property")) return "variable";
  return "unknown";
}
function rangeOf(node: Node): SymbolRange {
  return { startIndex: node.startIndex, endIndex: node.endIndex, startPosition: { ...node.startPosition }, endPosition: { ...node.endPosition } };
}
function nameNode(node: Node): Node | null {
  for (const field of ["name", "declarator", "left", "pattern"]) {
    const candidate = node.childForFieldName(field);
    if (candidate && (IDENTIFIER.test(candidate.type) || candidate.type.endsWith("identifier"))) {
      return candidate;
    }
    if (candidate) {
      for (const child of candidate.namedChildren) if (IDENTIFIER.test(child.type) || child.type.endsWith("identifier")) return child;
    }
  }
  for (const child of node.namedChildren) if (IDENTIFIER.test(child.type) || child.type.endsWith("identifier")) return child;
  return null;
}

class SymbolIndexImpl implements SymbolIndex {
  private readonly root: string;
  private readonly files = new Map<string, { source: string; language: SupportedLanguage; symbols: Symbol[]; identifiers: { name: string; range: SymbolRange }[] }>();
  private readonly symbols = new Map<number, Symbol>();
  private readonly refs = new Map<number, SymbolReference[]>();
  private readonly languages = new Map<SupportedLanguage, Language>();
  private parserPromise: Promise<void> | undefined;
  private nextId = 1;
  private readonly dbPath: string;

  constructor(root: string) {
    this.root = resolve(root);
    this.dbPath = join(this.root, ".uptokey", "symbol-index.sqlite");
  }

  async add(file: string | FileNode, source: string): Promise<void> {
    const raw = filePath(file);
    const path = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
    const language = languageFor(path);
    if (!language) return;
    const parser = await this.parserFor(language);
    parser.reset();
    const tree = parser.parse(source);
    if (!tree) { parser.delete(); return; }
    const symbols: Symbol[] = [];
    const identifiers: { name: string; range: SymbolRange }[] = [];
    const declarationRanges = new Set<string>();
    const visit = (node: Node, scope: string[]) => {
      if (node.isNamed && IDENTIFIER.test(node.type)) identifiers.push({ name: node.text, range: rangeOf(node) });
      const isDeclaration = node.isNamed && DECLARATION.test(node.type);
      const childName = isDeclaration ? nameNode(node) : null;
      const nextScope = childName && childName.text ? [...scope, childName.text] : scope;
      if (childName && childName.text) {
        const symbol: Symbol = { id: this.nextId++, name: childName.text, kind: kindFor(node.type), file: path, range: rangeOf(node), scope, language };
        symbols.push(symbol);
        declarationRanges.add(`${childName.startIndex}:${childName.endIndex}`);
      }
      for (const child of node.namedChildren) visit(child, nextScope);
    };
    visit(tree.rootNode, []);
    tree.delete();
    parser.delete();
    const old = this.files.get(path);
    if (old) for (const symbol of old.symbols) this.symbols.delete(symbol.id);
    this.files.set(path, { source, language, symbols, identifiers: identifiers.filter((item) => !declarationRanges.has(`${item.range.startIndex}:${item.range.endIndex}`)) });
    for (const symbol of symbols) this.symbols.set(symbol.id, symbol);
    this.rebuildReferences();
  }

  query(name: string, opts: SymbolQueryOptions = {}): Symbol[] {
    return [...this.symbols.values()].filter((symbol) => symbol.name === name && (!opts.file || symbol.file === this.resolveFile(opts.file)) && (!opts.kind || symbol.kind === opts.kind));
  }

  definitions(file?: string): Symbol[] { return [...this.symbols.values()].filter(symbol => !file || symbol.file === this.resolveFile(file)); }

  remove(file: string): void {
    const path = this.resolveFile(file);
    for (const symbol of this.symbols.values()) if (symbol.file === path) this.symbols.delete(symbol.id);
    this.files.delete(path);
    this.rebuildReferences();
  }

  references(symbol: Symbol): SymbolReference[] { return [...(this.refs.get(symbol.id) ?? [])]; }

  async refresh(file: string | FileNode): Promise<void> {
    const raw = filePath(file);
    const path = isAbsolute(raw) ? resolve(raw) : resolve(this.root, raw);
    const source = await readFile(path, "utf8");
    await this.add(path, source);
  }

  async save(): Promise<void> {
    await mkdir(dirname(this.dbPath), { recursive: true });
    const Database = require("better-sqlite3") as SqliteCtor;
    const db = new Database(this.dbPath);
    try {
      db.exec("CREATE TABLE IF NOT EXISTS symbols(id INTEGER PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL, file TEXT NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, start_row INTEGER NOT NULL, start_col INTEGER NOT NULL, end_row INTEGER NOT NULL, end_col INTEGER NOT NULL, scope TEXT NOT NULL, language TEXT NOT NULL); CREATE INDEX IF NOT EXISTS idx_symbols_name ON symbols(name); CREATE TABLE IF NOT EXISTS refs(symbol_id INTEGER NOT NULL, ref_file TEXT NOT NULL, ref_line INTEGER NOT NULL, start INTEGER NOT NULL, end INTEGER NOT NULL, start_row INTEGER NOT NULL, start_col INTEGER NOT NULL, end_row INTEGER NOT NULL, end_col INTEGER NOT NULL);");
      db.exec("DELETE FROM refs; DELETE FROM symbols;");
      const insertSymbol = db.prepare("INSERT INTO symbols(id,name,kind,file,start,end,start_row,start_col,end_row,end_col,scope,language) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)");
      for (const s of this.symbols.values()) insertSymbol.run(s.id, s.name, s.kind, s.file, s.range.startIndex, s.range.endIndex, s.range.startPosition.row, s.range.startPosition.column, s.range.endPosition.row, s.range.endPosition.column, JSON.stringify(s.scope), s.language);
      const insertRef = db.prepare("INSERT INTO refs(symbol_id,ref_file,ref_line,start,end,start_row,start_col,end_row,end_col) VALUES(?,?,?,?,?,?,?,?,?)");
      for (const [id, refs] of this.refs) for (const ref of refs) insertRef.run(id, ref.file, ref.line, ref.range.startIndex, ref.range.endIndex, ref.range.startPosition.row, ref.range.startPosition.column, ref.range.endPosition.row, ref.range.endPosition.column);
    } finally { db.close(); }
  }

  async load(): Promise<void> {
    try {
      const Database = require("better-sqlite3") as SqliteCtor;
      const db = new Database(this.dbPath);
      try {
        const rows = db.prepare("SELECT * FROM symbols ORDER BY id").all() as Array<Record<string, unknown>>;
        const refs = db.prepare("SELECT * FROM refs").all() as Array<Record<string, unknown>>;
        this.symbols.clear(); this.refs.clear();
        for (const row of rows) {
          const symbol: Symbol = { id: Number(row.id), name: String(row.name), kind: String(row.kind) as SymbolKind, file: String(row.file), language: String(row.language) as SupportedLanguage, scope: JSON.parse(String(row.scope)) as string[], range: { startIndex: Number(row.start), endIndex: Number(row.end), startPosition: { row: Number(row.start_row), column: Number(row.start_col) }, endPosition: { row: Number(row.end_row), column: Number(row.end_col) } } };
          this.symbols.set(symbol.id, symbol); this.nextId = Math.max(this.nextId, symbol.id + 1);
        }
        for (const row of refs) { const symbolId = Number(row.symbol_id); const symbol = this.symbols.get(symbolId); if (!symbol) continue; const range: SymbolRange = { startIndex: Number(row.start), endIndex: Number(row.end), startPosition: { row: Number(row.start_row), column: Number(row.start_col) }, endPosition: { row: Number(row.end_row), column: Number(row.end_col) } }; const ref: SymbolReference = { symbolId, name: symbol.name, file: String(row.ref_file), line: Number(row.ref_line), range }; this.refs.set(symbolId, [...(this.refs.get(symbolId) ?? []), ref]); }
      } finally { db.close(); }
    } catch { /* first run: there is no index yet */ }
  }

  private resolveFile(file: string): string { return isAbsolute(file) ? resolve(file) : resolve(this.root, file); }
  private async parserFor(language: SupportedLanguage): Promise<Parser> {
    await this.ensureParser();
    const parser = new Parser();
    const grammar = this.languages.get(language) ?? await Language.load(getWasmPath(language));
    this.languages.set(language, grammar); parser.setLanguage(grammar); return parser;
  }
  private async ensureParser(): Promise<void> {
    if (!this.parserPromise) this.parserPromise = Parser.init({ locateFile: () => require.resolve("web-tree-sitter/web-tree-sitter.wasm") });
    await this.parserPromise;
  }
  private rebuildReferences(): void {
    this.refs.clear();
    const byName = new Map<string, Symbol[]>();
    for (const symbol of this.symbols.values()) byName.set(symbol.name, [...(byName.get(symbol.name) ?? []), symbol]);
    const family = (language: SupportedLanguage) => language === "javascript" || language === "typescript" ? "ecmascript" : language;
    for (const [file, entry] of this.files) for (const identifier of entry.identifiers) {
      const candidates = byName.get(identifier.name)?.filter(symbol => family(symbol.language) === family(entry.language));
      if (!candidates?.length) continue;
      const local = candidates.filter(symbol => symbol.file === file);
      // This index supplies name candidates, not semantic import resolution.
      // Never assign a JS call to Python merely because it was indexed first.
      for (const target of local.length ? local : candidates) {
        const ref: SymbolReference = { symbolId: target.id, name: identifier.name, file, line: identifier.range.startPosition.row, range: identifier.range };
        this.refs.set(target.id, [...(this.refs.get(target.id) ?? []), ref]);
      }
    }
  }
}

export async function buildSymbolIndex(root: string): Promise<SymbolIndex> {
  const index = new SymbolIndexImpl(root); await index.load(); return index;
}

/** For authorized remote/project readers: parse supplied bytes only. Never
 * loads SQLite or reads source files merely because a root was supplied. */
export function createMemorySymbolIndex(root: string): SymbolIndex { return new SymbolIndexImpl(root); }

export function symbolLanguageForFile(path: string): SupportedLanguage | null { return languageFor(path) ?? null; }
