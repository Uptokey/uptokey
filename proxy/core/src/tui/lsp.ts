/**
 * Uptokey TUI — supervised Language Server client.
 *
 * A language server executes code from the developer's environment (and may
 * load project plugins/configuration), so it only starts after an explicit
 * consent recorded for (server command, project folder) in the user profile —
 * never because a file was discovered in the repository. The process gets a
 * minimal environment (no secrets), fixed arguments from the detection table,
 * byte-accurate JSON-RPC framing, per-request timeouts and is killed with its
 * children on stop. Server edits (rename, code actions) are returned as data;
 * the caller turns them into a reviewable proposal applied by the canonical
 * writer (W5). Behavioural reference for incremental sync and diagnostics:
 * OpenCode (Go, MIT) internal/lsp — independent implementation.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";
import { createRequire } from "node:module";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, dirname, extname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export interface Position { line: number; character: number }
export interface Range { start: Position; end: Position }
export interface Location { uri: string; range: Range }
export interface Diagnostic { range: Range; severity?: 1 | 2 | 3 | 4; message: string; source?: string; code?: string | number }
export interface TextEdit { range: Range; newText: string }
export interface WorkspaceEdit { changes?: Record<string, TextEdit[]>; documentChanges?: Array<{ textDocument?: { uri: string; version?: number | null }; edits?: TextEdit[]; kind?: string }> }
export interface CodeAction { title: string; kind?: string; isPreferred?: boolean; disabled?: { reason: string }; edit?: WorkspaceEdit; command?: { title: string; command: string; arguments?: unknown[] }; data?: unknown }

export interface ServerSpec { id: string; command: string; args: string[]; languageId: string; install: string }

const SERVERS: Array<{ extensions: string[]; spec: ServerSpec }> = [
  { extensions: [".ts", ".tsx", ".mts", ".cts"], spec: { id: "typescript", command: "typescript-language-server", args: ["--stdio"], languageId: "typescript", install: "npm install -g typescript-language-server typescript" } },
  { extensions: [".js", ".jsx", ".mjs", ".cjs"], spec: { id: "typescript", command: "typescript-language-server", args: ["--stdio"], languageId: "javascript", install: "npm install -g typescript-language-server typescript" } },
  { extensions: [".py"], spec: { id: "pyright", command: "pyright-langserver", args: ["--stdio"], languageId: "python", install: "npm install -g pyright" } },
  { extensions: [".go"], spec: { id: "gopls", command: "gopls", args: [], languageId: "go", install: "go install golang.org/x/tools/gopls@latest" } },
  { extensions: [".rs"], spec: { id: "rust-analyzer", command: "rust-analyzer", args: [], languageId: "rust", install: "rustup component add rust-analyzer" } },
  { extensions: [".c", ".h", ".cc", ".cpp", ".cxx", ".hpp"], spec: { id: "clangd", command: "clangd", args: [], languageId: "cpp", install: "instale clangd (LLVM)" } },
  { extensions: [".lua"], spec: { id: "lua", command: "lua-language-server", args: [], languageId: "lua", install: "instale lua-language-server" } },
];

export function serverForFile(path: string): ServerSpec | null {
  const ext = extname(path).toLowerCase();
  return SERVERS.find((s) => s.extensions.includes(ext))?.spec ?? null;
}

/**
 * TypeScript 7 ships its own language server (`tsc --lsp --stdio`, Apache-2.0). When typescript-language-server
 * is not installed, TypeScript >= 7 from the project or the installed Uptokey toolchain serves the folder, run by Node,
 * under the same exact consent (the consent records this command, its arguments and the resolved program). The
 * compiler path is resolved through links (workspaces and pnpm keep it outside the folder): a different compiler
 * means different arguments, so a previous consent no longer applies.
 */
export function effectiveServer(spec: ServerSpec, root: string, env: NodeJS.ProcessEnv = process.env): ServerSpec {
  if (spec.id !== "typescript" || resolveProgram(spec.command, env)) return spec;
  const bases = [join(root, "node_modules", "typescript")];
  try { bases.push(dirname(createRequire(import.meta.url).resolve("typescript/package.json"))); } catch { /* optional installed toolchain */ }
  for (const base of new Set(bases)) try {
    const version = Number(String((JSON.parse(readFileSync(join(base, "package.json"), "utf8")) as { version?: unknown }).version ?? "").split(".")[0]);
    const tsc = realpathSync.native(join(base, "bin", "tsc"));
    if (!(version >= 7)) continue;
    return { id: "typescript-native", command: process.execPath, args: [tsc, "--lsp", "--stdio"], languageId: spec.languageId, install: spec.install };
  } catch { /* try the next installed compiler without downloading or running it */ }
  return spec;
}

/** Resolves a program on PATH (PATHEXT on Windows) without running it. */
export function resolveProgram(command: string, env: NodeJS.ProcessEnv = process.env): string | null {
  if (isAbsolute(command)) return existsSync(command) ? command : null;
  const exts = process.platform === "win32" ? (env.PATHEXT ?? ".COM;.EXE;.BAT;.CMD").split(";").filter(Boolean) : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter).filter(Boolean)) {
    for (const ext of exts) {
      const candidate = join(dir, command + ext.toLowerCase());
      if (existsSync(candidate)) return candidate;
      const upper = join(dir, command + ext);
      if (existsSync(upper)) return upper;
    }
  }
  return null;
}

function minimalEnv(): NodeJS.ProcessEnv {
  const keep = ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "windir", "WINDIR", "HOME", "USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "LANG", "LC_ALL", "TEMP", "TMP", "COMSPEC", "GOPATH", "GOROOT", "CARGO_HOME", "RUSTUP_HOME"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  return env;
}

// ─── consent (user profile, never the repository) ──────────────────────

export function lspConsentPath(): string {
  return join(process.env.UPTOKEY_TUI_CONFIG_DIR ?? join(homedir(), ".uptokey", "tui"), "lsp-consent.json");
}

function consentKey(serverId: string, root: string): string {
  let real = resolve(root);
  try { real = realpathSync.native(real); } catch { /* keep resolved */ }
  return `${serverId}::${process.platform === "win32" ? real.toLowerCase() : real}`;
}

type ConsentRecord = { grantedAt: string; command: string; args?: string[]; program?: string };
async function readConsents(): Promise<Record<string, ConsentRecord>> {
  try { return JSON.parse(await readFile(lspConsentPath(), "utf8")) as Record<string, ConsentRecord>; }
  catch { return {}; }
}

export async function hasLspConsent(spec: ServerSpec, root: string): Promise<boolean> {
  const record = (await readConsents())[consentKey(spec.id, root)];
  const program = resolveProgram(spec.command);
  return !!program && record?.command === spec.command && JSON.stringify(record.args) === JSON.stringify(spec.args) && record.program === realpathSync.native(program);
}

export async function grantLspConsent(spec: ServerSpec, root: string): Promise<void> {
  const all = await readConsents();
  const program = resolveProgram(spec.command);
  if (!program) throw new LspError("lsp_program_not_found");
  all[consentKey(spec.id, root)] = { grantedAt: new Date().toISOString(), command: spec.command, args: [...spec.args], program: realpathSync.native(program) };
  await mkdir(dirname(lspConsentPath()), { recursive: true });
  await writeFile(lspConsentPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
}

export async function revokeLspConsent(spec: ServerSpec, root: string): Promise<void> {
  const all = await readConsents();
  delete all[consentKey(spec.id, root)];
  await mkdir(dirname(lspConsentPath()), { recursive: true });
  await writeFile(lspConsentPath(), `${JSON.stringify(all, null, 2)}\n`, "utf8");
}

// ─── client ────────────────────────────────────────────────────────────

export class LspError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; this.name = "LspError"; }
}

export class LspClient extends EventEmitter {
  private proc: ChildProcess | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  private buffer = Buffer.alloc(0);
  private versions = new Map<string, number>();
  private diagnosticVersions = new Map<string, number>();
  private editEpoch = 0;
  private actionEpoch = new WeakMap<CodeAction, number>();
  private capabilities: Record<string, unknown> = {};
  private lifecycle = 0;
  private starting = false;
  readonly diagnostics = new Map<string, Diagnostic[]>();
  private readonly spec: ServerSpec;
  private readonly root: string;
  private readonly program: string;

  constructor(spec: ServerSpec, root: string, program: string) {
    super();
    this.spec = { ...spec, args: [...spec.args] };
    this.root = realpathSync.native(resolve(root));
    this.program = realpathSync.native(program);
  }

  get running(): boolean { return this.proc !== null; }

  async start(timeoutMs = 20_000): Promise<void> {
    if (this.proc || this.starting) throw new LspError("lsp_already_running");
    this.starting = true;
    const lifecycle = this.lifecycle;
    try {
      if (!(await hasLspConsent(this.spec, this.root)) || realpathSync.native(resolveProgram(this.spec.command) ?? "") !== this.program) throw new LspError("lsp_consent_required");
      if (lifecycle !== this.lifecycle) throw new LspError("lsp_stopped");
    } catch (error) { this.starting = false; throw error; }
    this.buffer = Buffer.alloc(0); this.versions.clear(); this.diagnostics.clear(); this.diagnosticVersions.clear(); this.editEpoch++;
    const isShim = process.platform === "win32" && /\.(cmd|bat)$/i.test(this.program);
    if (isShim && (/[\r\n"%&|<>^!]/.test(this.program) || this.spec.args.some((arg) => !/^[\w./:-]+$/.test(arg)))) { this.starting = false; throw new LspError("lsp_unsafe_windows_shim"); }
    // Fixed arguments from the detection table only; no user text reaches the command line.
    this.proc = isShim
      ? spawn(process.env.COMSPEC ?? "cmd.exe", ["/d", "/s", "/c", `""${this.program}" ${this.spec.args.join(" ")}"`], { cwd: this.root, env: minimalEnv(), windowsHide: true, windowsVerbatimArguments: true, stdio: ["pipe", "pipe", "pipe"] })
      : spawn(this.program, this.spec.args, { cwd: this.root, env: minimalEnv(), windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
    // A server that exits mid-write must not surface as an unhandled stream error.
    this.proc.stdin!.on("error", () => undefined);
    this.proc.stdout!.on("error", () => undefined);
    this.proc.stdout!.on("data", (chunk: Buffer) => { this.buffer = Buffer.concat([this.buffer, chunk]); this.drain(); });
    this.proc.stderr!.on("data", () => undefined);
    this.proc.on("error", (error) => this.fail(new LspError(`lsp_spawn_failed:${(error as NodeJS.ErrnoException).code ?? "error"}`)));
    this.proc.on("exit", () => this.fail(new LspError("lsp_exited")));
    try {
    const initialized = await this.request<{ capabilities?: Record<string, unknown> }>("initialize", {
      processId: process.pid,
      rootUri: pathToFileURL(this.root).href,
      workspaceFolders: [{ uri: pathToFileURL(this.root).href, name: "root" }],
      capabilities: {
        general: { positionEncodings: ["utf-16"] },
        textDocument: {
          synchronization: { didSave: false },
          publishDiagnostics: { relatedInformation: false, versionSupport: true },
          diagnostic: { dynamicRegistration: false, relatedDocumentSupport: false },
          definition: {}, references: {}, rename: { prepareSupport: false },
          codeAction: { codeActionLiteralSupport: { codeActionKind: { valueSet: ["quickfix", "refactor", "source.organizeImports"] } }, resolveSupport: { properties: ["edit"] }, dataSupport: true, disabledSupport: true },
        },
        workspace: { workspaceEdit: { documentChanges: true } },
      },
    }, timeoutMs);
    this.capabilities = initialized?.capabilities ?? {};
    this.notify("initialized", {});
    } catch (error) { this.stop(); throw error; }
    finally { this.starting = false; }
  }

  private fail(error: Error): void {
    for (const [, entry] of this.pending) { clearTimeout(entry.timer); entry.reject(error); }
    this.pending.clear();
    this.proc = null;
    this.editEpoch++;
    this.emit("stopped");
  }

  private drain(): void {
    for (;;) {
      const headerEnd = this.buffer.indexOf("\r\n\r\n");
      if (headerEnd < 0) { if (this.buffer.length > 8192) this.stop(); return; }
      if (headerEnd > 8192) { this.stop(); return; }
      const header = this.buffer.subarray(0, headerEnd).toString("ascii");
      const lengths = header.split("\r\n").filter((line) => /^Content-Length:/i.test(line));
      const match = lengths.length === 1 ? /^Content-Length:\s*(\d+)\s*$/i.exec(lengths[0]!) : null;
      if (!match) { this.stop(); return; }
      const length = Number(match[1]);
      if (!Number.isSafeInteger(length) || length < 2 || length > 32 * 1024 * 1024) { this.stop(); return; }
      if (this.buffer.length < headerEnd + 4 + length) return;
      const body = this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8");
      this.buffer = this.buffer.subarray(headerEnd + 4 + length);
      let message: { id?: number | string; method?: string; params?: unknown; result?: unknown; error?: { message?: string } };
      try { message = JSON.parse(body); } catch { this.stop(); return; }
      if (!message || typeof message !== "object") { this.stop(); return; }
      if (message.method === "textDocument/publishDiagnostics") {
        const params = message.params as { uri: string; version?: number; diagnostics: Diagnostic[] };
        if (!params || typeof params.uri !== "string" || !this.versions.has(params.uri) || !Array.isArray(params.diagnostics)) continue;
        const version = this.versions.get(params.uri)!;
        if (params.version !== undefined && params.version !== version) continue;
        this.diagnostics.set(params.uri, params.diagnostics);
        this.diagnosticVersions.set(params.uri, version);
        this.emit("diagnostics", params.uri, params.diagnostics, version);
      } else if (message.method && message.id !== undefined) {
        // Server → client requests: answer minimally, never apply edits here.
        if (message.method === "workspace/applyEdit") this.send({ jsonrpc: "2.0", id: message.id, result: { applied: false, failureReason: "Edits require a reviewed proposal through the project writer" } });
        else if (message.method === "workspace/configuration") { const items = (message.params as { items?: unknown[] })?.items; this.send({ jsonrpc: "2.0", id: message.id, result: Array.isArray(items) ? items.map(() => null) : [] }); }
        else if (message.method === "workspace/workspaceFolders") this.send({ jsonrpc: "2.0", id: message.id, result: [{ uri: pathToFileURL(this.root).href, name: "root" }] });
        else this.send({ jsonrpc: "2.0", id: message.id, error: { code: -32601, message: "Unsupported client request" } });
      } else if (typeof message.id === "number" && this.pending.has(message.id)) {
        const entry = this.pending.get(message.id)!;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.error) entry.reject(new LspError(`lsp_request_failed:${String(message.error.message ?? "").slice(0, 80)}`));
        else entry.resolve(message.result);
      }
    }
  }

  private send(message: unknown): void {
    if (!this.proc?.stdin?.writable) throw new LspError("lsp_not_running");
    const body = Buffer.from(JSON.stringify(message), "utf8");
    this.proc.stdin.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`, "ascii"), body]));
  }

  request<T = unknown>(method: string, params: unknown, timeoutMs = 10_000): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolvePromise, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); try { this.notify("$/cancelRequest", { id }); } catch { /* transport closed */ } reject(new LspError("lsp_timeout")); }, timeoutMs);
      this.pending.set(id, { resolve: resolvePromise as (v: unknown) => void, reject, timer });
      try { this.send({ jsonrpc: "2.0", id, method, params }); }
      catch (error) { clearTimeout(timer); this.pending.delete(id); reject(error); }
    });
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  uriFor(relativePath: string): string { const uri = pathToFileURL(resolve(this.root, relativePath)).href; if (!this.relativeFromUri(uri)) throw new LspError("lsp_path_outside_root"); return uri; }

  relativeFromUri(uri: string): string | null {
    try {
      const abs = resolve(fileURLToPath(uri));
      const rel = relative(this.root, abs);
      if (!rel || rel === ".." || rel.startsWith("..\\") || rel.startsWith("../") || isAbsolute(rel)) return null;
      // Validate existing ancestors too, so a new file below an external symlink is refused.
      let ancestor = abs;
      while (!existsSync(ancestor)) { const parent = dirname(ancestor); if (parent === ancestor) return null; ancestor = parent; }
      const realRel = relative(this.root, realpathSync.native(ancestor));
      return realRel === ".." || realRel.startsWith("..\\") || realRel.startsWith("../") || isAbsolute(realRel) ? null : rel.replace(/\\/g, "/");
    } catch { return null; }
  }

  /** Opens or updates a document with the exact text the core returned. */
  sync(relativePath: string, text: string): string {
    const uri = this.uriFor(relativePath);
    const version = (this.versions.get(uri) ?? 0) + 1;
    this.versions.set(uri, version);
    this.editEpoch++;
    this.diagnostics.delete(uri); this.diagnosticVersions.delete(uri);
    if (version === 1) this.notify("textDocument/didOpen", { textDocument: { uri, languageId: this.spec.languageId, version, text } });
    else this.notify("textDocument/didChange", { textDocument: { uri, version }, contentChanges: [{ text }] });
    return uri;
  }

  /** Waits for diagnostics of `uri` published after `since` (bounded). */
  waitDiagnostics(uri: string, timeoutMs = 6_000, signal?: AbortSignal): Promise<Diagnostic[]> {
    signal?.throwIfAborted();
    const version = this.versions.get(uri);
    if (version !== undefined && this.diagnosticVersions.get(uri) === version) return Promise.resolve(this.diagnostics.get(uri) ?? []);
    if (version !== undefined && this.capabilities.diagnosticProvider) return this.pullDiagnostics(uri, version, timeoutMs, signal);
    return new Promise((resolvePromise, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off("diagnostics", on); this.off("stopped", onStop); signal?.removeEventListener("abort", onAbort); };
      const timer = setTimeout(() => { cleanup(); reject(new LspError("lsp_diagnostics_timeout")); }, timeoutMs);
      const onStop = () => { cleanup(); reject(new LspError("lsp_stopped")); };
      const onAbort = () => { cleanup(); reject(signal?.reason ?? new LspError("lsp_cancelled")); };
      const on = (published: string, diagnostics: Diagnostic[], publishedVersion: number) => {
        if (published !== uri || publishedVersion !== version) return;
        cleanup(); resolvePromise(diagnostics);
      };
      this.on("diagnostics", on); this.on("stopped", onStop);
      signal?.addEventListener("abort", onAbort, { once: true });
    });
  }

  /** Pull diagnostics (LSP 3.17) for servers that answer on request instead of publishing, such as TypeScript 7. */
  private async pullDiagnostics(uri: string, version: number, timeoutMs: number, signal?: AbortSignal): Promise<Diagnostic[]> {
    const result = await this.request<{ kind?: string; items?: Diagnostic[] } | null>("textDocument/diagnostic", { textDocument: { uri } }, timeoutMs);
    signal?.throwIfAborted();
    if (this.versions.get(uri) !== version) throw new LspError("lsp_stale_edit");
    const items = result?.kind === "full" && Array.isArray(result.items) ? result.items : [];
    this.diagnostics.set(uri, items); this.diagnosticVersions.set(uri, version);
    this.emit("diagnostics", uri, items, version);
    return items;
  }

  async rename(relativePath: string, position: Position, newName: string): Promise<Map<string, TextEdit[]>> {
    const epoch = this.editEpoch;
    const result = await this.request<WorkspaceEdit | null>("textDocument/rename", { textDocument: { uri: this.uriFor(relativePath) }, position, newName });
    if (epoch !== this.editEpoch) throw new LspError("lsp_stale_edit");
    return this.workspaceEdits(result);
  }

  private workspaceEdits(result: WorkspaceEdit | null | undefined): Map<string, TextEdit[]> {
    const edits = new Map<string, TextEdit[]>();
    if (!result) return edits;
    for (const [uri, list] of Object.entries(result.changes ?? {})) {
      const rel = this.relativeFromUri(uri);
      if (!rel) throw new LspError("lsp_edit_outside_root");
      edits.set(rel, [...(edits.get(rel) ?? []), ...list]);
    }
    for (const change of result.documentChanges ?? []) {
      if (change.kind) throw new LspError("lsp_resource_operation_unsupported");
      if (change.textDocument?.version != null && this.versions.get(change.textDocument.uri) !== change.textDocument.version) throw new LspError("lsp_stale_edit");
      const rel = change.textDocument ? this.relativeFromUri(change.textDocument.uri) : null;
      if (!rel) throw new LspError("lsp_edit_outside_root");
      edits.set(rel, [...(edits.get(rel) ?? []), ...(change.edits ?? [])]);
    }
    return edits;
  }

  /** Returns server actions as data. Commands are never executed by this client. */
  async codeActions(relativePath: string, range: Range): Promise<CodeAction[]> {
    const uri = this.uriFor(relativePath), epoch = this.editEpoch;
    const result = await this.request<Array<CodeAction | { title: string; command: string; arguments?: unknown[] }> | null>("textDocument/codeAction", { textDocument: { uri }, range, context: { diagnostics: this.diagnostics.get(uri) ?? [] } });
    if (epoch !== this.editEpoch) throw new LspError("lsp_stale_edit");
    return (result ?? []).map((entry) => {
      const action: CodeAction = typeof entry.command === "string" ? { title: entry.title, command: entry as { title: string; command: string; arguments?: unknown[] }, disabled: { reason: "Ação requer comando do servidor; execução automática indisponível." } } : entry as CodeAction;
      this.actionEpoch.set(action, epoch); return action;
    });
  }

  /** Code action -> reviewed write proposal. Rejects edits for changed documents. */
  async resolveCodeActionEdits(action: CodeAction): Promise<Map<string, TextEdit[]>> {
    const epoch = this.actionEpoch.get(action);
    if (epoch === undefined || epoch !== this.editEpoch) throw new LspError("lsp_stale_edit");
    if (action.disabled) throw new LspError("lsp_action_disabled");
    let resolved = action;
    if (!action.edit && (this.capabilities.codeActionProvider as { resolveProvider?: boolean } | undefined)?.resolveProvider) resolved = await this.request<CodeAction>("codeAction/resolve", action);
    if (epoch !== this.editEpoch) throw new LspError("lsp_stale_edit");
    if (resolved.disabled) throw new LspError("lsp_action_disabled");
    if (resolved.command) throw new LspError("lsp_action_command_requires_execution_policy");
    return this.workspaceEdits(resolved.edit);
  }

  async definition(relativePath: string, position: Position): Promise<Location[]> {
    const result = await this.request<Location | Location[] | Array<{ targetUri: string; targetSelectionRange: Location["range"] }> | null>("textDocument/definition", { textDocument: { uri: this.uriFor(relativePath) }, position });
    const list = result ? (Array.isArray(result) ? result : [result]) : [];
    // LocationLink (targetUri/targetSelectionRange) is normalized to Location.
    return list.map((item) => ("targetUri" in item ? { uri: item.targetUri, range: item.targetSelectionRange } : item));
  }

  async references(relativePath: string, position: Position, includeDeclaration = true): Promise<Location[]> {
    const result = await this.request<Location[] | null>("textDocument/references", { textDocument: { uri: this.uriFor(relativePath) }, position, context: { includeDeclaration } });
    return Array.isArray(result) ? result : [];
  }

  stop(): void {
    this.lifecycle++;
    const proc = this.proc;
    if (!proc) return;
    try { this.notify("exit", null); proc.stdin?.end(); } catch { /* already gone */ }
    // Terminate the server and any child it started.
    if (process.platform === "win32" && proc.pid) spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
    else { try { if (proc.pid) process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } }
    this.fail(new LspError("lsp_stopped"));
  }
}

/** Applies LSP text edits (UTF-16 positions) to a document text. */
export function applyTextEdits(text: string, edits: readonly TextEdit[]): string {
  const lineStarts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") lineStarts.push(i + 1);
  const offset = (p: Position) => {
    if (!Number.isSafeInteger(p.line) || !Number.isSafeInteger(p.character) || p.line < 0 || p.character < 0 || p.line >= lineStarts.length) throw new LspError("lsp_invalid_edit_range");
    const start = lineStarts[p.line]!;
    let end = p.line + 1 < lineStarts.length ? lineStarts[p.line + 1]! - 1 : text.length;
    if (end > start && text[end - 1] === "\r") end--;
    if (start + p.character > end) throw new LspError("lsp_invalid_edit_range");
    return start + p.character;
  };
  const sorted = [...edits].sort((a, b) => offset(b.range.start) - offset(a.range.start));
  let out = text;
  let lastStart = Infinity;
  for (const edit of sorted) {
    const start = offset(edit.range.start), end = offset(edit.range.end);
    if (end < start || typeof edit.newText !== "string") throw new LspError("lsp_invalid_edit_range");
    if (end > lastStart) throw new LspError("lsp_overlapping_edits");
    out = out.slice(0, start) + edit.newText + out.slice(end);
    lastStart = start;
  }
  return out;
}

export function formatDiagnostics(path: string, diagnostics: readonly Diagnostic[]): string {
  const label = { 1: "erro", 2: "aviso", 3: "info", 4: "dica" } as const;
  return diagnostics.map((d) => `${path}:${d.range.start.line + 1}:${d.range.start.character + 1} ${label[d.severity ?? 1]}${d.source ? ` (${d.source})` : ""}: ${d.message.split("\n")[0]}`).join("\n");
}
