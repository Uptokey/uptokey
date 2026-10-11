/**
 * Supervised DAP consumer. Protocol: https://microsoft.github.io/debug-adapter-protocol/
 * Microsoft js-debug (MIT) is used as an external adapter, never transplanted.
 * Its standalone server requires same-server __pendingTargetId continuations:
 * https://github.com/microsoft/vscode-js-debug/blob/main/src/dapDebugServer.ts
 * Preparation is read-only; start requires approval of the exact frozen config.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import { realpathSync, statSync } from "node:fs";
import { connect, type Socket } from "node:net";
import { isAbsolute, relative, resolve } from "node:path";
import type { Readable, Writable } from "node:stream";
import { resolveProgram } from "./lsp.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

export type DebugAdapter =
  | { kind: "stdio" | "js-debug"; command: string; args?: string[]; id?: string }
  | { kind: "tcp"; port: number; host?: "127.0.0.1" | "::1"; id?: string };
export interface DebugBreakpointInput { path: string; lines: number[] }
export interface DebugSessionConfig {
  adapter: DebugAdapter; rootPath: string; request: "launch" | "attach";
  configuration: Record<string, unknown>; breakpoints?: DebugBreakpointInput[];
}
export interface PreparedDebugSession extends DebugSessionConfig { fingerprint: string; summary: string }
export interface DebugThread { id: number; name: string }
export interface DebugFrame { id: number; name: string; line: number; column: number; source?: { name?: string; path?: string; sourceReference?: number } }
export interface DebugScope { name: string; variablesReference: number; expensive: boolean }
export interface DebugVariable { name: string; value: string; type?: string; variablesReference: number }
export interface DebugBreakpoint { id?: number; verified: boolean; line?: number; message?: string }
export type DebugState = "idle" | "starting" | "running" | "stopped" | "stopping" | "terminated" | "failed";
export interface DebugSnapshot {
  state: DebugState; reason?: string; error?: string; threads: DebugThread[];
  threadId?: number; frameId?: number; frames: DebugFrame[]; scopes: DebugScope[];
  variables: Record<number, DebugVariable[]>; breakpoints: Record<string, DebugBreakpoint[]>; output: string[];
}
export class DebuggerError extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; this.name = "DebuggerError"; } }

function inside(root: string, path: string): string {
  const absolute = resolve(root, path), rel = relative(root, absolute);
  if (!rel || rel === ".." || rel.startsWith("../") || rel.startsWith("..\\") || isAbsolute(rel)) throw new DebuggerError("debug_path_outside_root");
  // A breakpoint/source may not exist yet, but existing symlinks cannot escape.
  try { const real = realpathSync.native(absolute); const realRel = relative(root, real); if (realRel.startsWith("..") || isAbsolute(realRel)) throw new DebuggerError("debug_path_outside_root"); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
  return absolute;
}
function freeze<T>(value: T): T { if (value && typeof value === "object") { Object.values(value).forEach(freeze); Object.freeze(value); } return value; }
function digest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function identity(config: DebugSessionConfig): DebugSessionConfig { return { adapter: config.adapter, rootPath: config.rootPath, request: config.request, configuration: config.configuration, breakpoints: config.breakpoints ?? [] }; }
function adapterProgram(command: string): string {
  const found = isAbsolute(command) ? command : resolveProgram(command);
  if (!found) throw new DebuggerError("debug_adapter_not_found");
  const program = realpathSync.native(found);
  if (!statSync(program).isFile() || /\.(cmd|bat|ps1)$/i.test(program)) throw new DebuggerError("debug_adapter_requires_executable");
  return program;
}

/** No process or network operation is performed here. UI displays summary before approval. */
export function prepareDebugSession(input: DebugSessionConfig): PreparedDebugSession {
  if (!["launch", "attach"].includes(input.request)) throw new DebuggerError("debug_invalid_request");
  const rootPath = realpathSync.native(resolve(input.rootPath));
  if (!statSync(rootPath).isDirectory()) throw new DebuggerError("debug_root_not_directory");
  const adapter = structuredClone(input.adapter);
  if (adapter.kind === "tcp") {
    if (!Number.isInteger(adapter.port) || adapter.port < 1 || adapter.port > 65535 || (adapter.host && !["127.0.0.1", "::1"].includes(adapter.host))) throw new DebuggerError("debug_endpoint_not_loopback");
    adapter.host ??= "127.0.0.1";
  } else if (adapter.kind === "stdio" || adapter.kind === "js-debug") {
    adapter.command = adapterProgram(adapter.command);
    adapter.args ??= [];
    if (!adapter.args.every((arg) => typeof arg === "string" && !arg.includes("\0"))) throw new DebuggerError("debug_invalid_adapter_args");
    if (adapter.kind === "js-debug") {
      if (adapter.args.length !== 1 || !isAbsolute(adapter.args[0]!)) throw new DebuggerError("debug_js_adapter_requires_script");
      adapter.args[0] = realpathSync.native(adapter.args[0]!);
      if (!statSync(adapter.args[0]).isFile()) throw new DebuggerError("debug_adapter_not_found");
    }
  } else throw new DebuggerError("debug_invalid_adapter");
  const configuration = structuredClone(input.configuration);
  if (!configuration || typeof configuration !== "object" || Array.isArray(configuration)) throw new DebuggerError("debug_invalid_configuration");
  if (configuration.__pendingTargetId !== undefined) throw new DebuggerError("debug_reserved_configuration");
  // DAP JSON only, bounded. Do not import .vscode/tasks.json or execute preLaunchTask.
  if (JSON.stringify(configuration).length > 64 * 1024) throw new DebuggerError("debug_configuration_too_large");
  for (const key of ["preLaunchTask", "postDebugTask", "envFile"]) if (configuration[key] !== undefined) throw new DebuggerError("debug_implicit_execution_unsupported");
  if (configuration.cwd !== undefined && realpathSync.native(resolve(rootPath, String(configuration.cwd))) !== rootPath) throw new DebuggerError("debug_cwd_mismatch");
  configuration.cwd = rootPath;
  const breakpoints = (input.breakpoints ?? []).map((bp) => ({ path: inside(rootPath, bp.path), lines: validateLines(bp.lines) }));
  const config = identity({ adapter, rootPath, request: input.request, configuration, breakpoints });
  const summary = `Depuração executa código local nesta pasta.\nPasta: ${rootPath}\nAdaptador: ${JSON.stringify(adapter)}\nPedido: ${input.request}\nConfiguração: ${JSON.stringify(configuration, null, 2)}\nBreakpoints: ${JSON.stringify(breakpoints)}`;
  return freeze({ ...config, fingerprint: digest(config), summary });
}

/** Standalone Microsoft js-debug server, explicitly selected by the user. */
/** js-debug and the debugged program need Node (V8 inspector). Under Bun (the OpenTUI frontend) use Node from PATH. */
export function nodeExecutable(): string {
  if (!process.versions.bun) return process.execPath;
  const node = resolveProgram("node");
  if (!node) throw new DebuggerError("debug_node_not_found");
  return realpathSync.native(node);
}
export function prepareNodeDebugSession(input: { rootPath: string; program: string; adapterPath: string; args?: string[]; breakpoints?: DebugBreakpointInput[] }): PreparedDebugSession {
  const rootPath = realpathSync.native(resolve(input.rootPath));
  const program = inside(rootPath, input.program);
  if (!statSync(program).isFile()) throw new DebuggerError("debug_program_not_found");
  const node = nodeExecutable();
  return prepareDebugSession({ rootPath, adapter: { kind: "js-debug", command: node, args: [resolve(input.adapterPath)], id: "pwa-node" }, request: "launch",
    configuration: { type: "pwa-node", name: "Uptokey Node", program, args: input.args ?? [], cwd: rootPath, console: "internalConsole", runtimeExecutable: node, autoAttachChildProcesses: false, stopOnEntry: true }, breakpoints: input.breakpoints });
}
function validateLines(lines: number[]): number[] { if (!Array.isArray(lines) || lines.length > 2000 || lines.some((line) => !Number.isSafeInteger(line) || line < 1)) throw new DebuggerError("debug_invalid_breakpoints"); return [...new Set(lines)].sort((a, b) => a - b); }
function minimalEnv(): NodeJS.ProcessEnv { const env: NodeJS.ProcessEnv = {}; for (const key of ["PATH", "Path", "PATHEXT", "SystemRoot", "SYSTEMROOT", "WINDIR", "windir", "HOME", "USERPROFILE", "TEMP", "TMP", "APPDATA", "LOCALAPPDATA"]) if (process.env[key] !== undefined) env[key] = process.env[key]; return env; }
function killProcess(proc: ChildProcess | null): void {
  if (!proc?.pid) return;
  if (process.platform === "win32") spawnSync("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore", timeout: 4000 });
  else { try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); } }
}
function waitProcessExit(proc: ChildProcess, timeoutMs = 1500): Promise<boolean> {
  if (!proc.pid || proc.exitCode !== null || proc.signalCode !== null) return Promise.resolve(true);
  return new Promise((resolvePromise) => {
    const done = () => { clearTimeout(timer); proc.off("close", done); proc.off("exit", done); resolvePromise(true); };
    const timer = setTimeout(() => { proc.off("close", done); proc.off("exit", done); resolvePromise(false); }, timeoutMs);
    proc.once("close", done); proc.once("exit", done);
  });
}
type DapMessage = { seq: number; type: "response" | "event" | "request"; command?: string; request_seq?: number; success?: boolean; message?: string; body?: any; arguments?: any; event?: string };

/** One byte-framed DAP channel; child js-debug sessions use a separate channel. */
class DapChannel extends EventEmitter {
  private readonly input: Readable;
  private readonly output: Writable;
  private buffer = Buffer.alloc(0);
  private seq = 1;
  private closed = false;
  private pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
  initialized = false;
  capabilities: Record<string, unknown> = {};
  constructor(input: Readable, output: Writable) {
    super();
    this.input = input; this.output = output;
    input.on("data", (data: Buffer) => { this.buffer = Buffer.concat([this.buffer, data]); this.drain(); });
    input.on("error", () => this.close(new DebuggerError("debug_transport_failed")));
    input.on("end", () => this.close(new DebuggerError("debug_adapter_disconnected")));
    output.on("error", () => this.close(new DebuggerError("debug_transport_failed")));
  }
  private drain(): void {
    try {
      while (!this.closed) {
        const headerEnd = this.buffer.indexOf("\r\n\r\n");
        if (headerEnd < 0) { if (this.buffer.length > 8192) throw new DebuggerError("debug_invalid_frame"); return; }
        if (headerEnd > 8192) throw new DebuggerError("debug_invalid_frame");
        const headers = this.buffer.subarray(0, headerEnd).toString("ascii").split("\r\n");
        const lengths = headers.filter((header) => /^Content-Length:/i.test(header));
        if (lengths.length !== 1 || !/^Content-Length:\s*\d+\s*$/i.test(lengths[0]!)) throw new DebuggerError("debug_invalid_frame");
        const length = Number(lengths[0]!.split(":")[1]);
        if (!Number.isSafeInteger(length) || length < 2 || length > 8 * 1024 * 1024) throw new DebuggerError("debug_invalid_frame");
        if (this.buffer.length < headerEnd + 4 + length) return;
        const message = JSON.parse(this.buffer.subarray(headerEnd + 4, headerEnd + 4 + length).toString("utf8")) as DapMessage;
        this.buffer = this.buffer.subarray(headerEnd + 4 + length);
        if (message.type === "response") {
          const pending = this.pending.get(message.request_seq!); if (!pending) continue;
          this.pending.delete(message.request_seq!); clearTimeout(pending.timer);
          if (!message.success) pending.reject(new DebuggerError(`debug_request_failed:${sanitizeForDisplay(String(message.message ?? message.command ?? "error")).slice(0, 180)}`)); else pending.resolve(message.body ?? {});
        } else if (message.type === "event") { if (message.event === "initialized") this.initialized = true; this.emit("event", message.event, message.body ?? {}); }
        else if (message.type === "request") this.emit("reverse", message);
        else throw new DebuggerError("debug_invalid_message");
      }
    } catch (error) { this.close(error instanceof DebuggerError ? error : new DebuggerError("debug_invalid_frame")); }
  }
  send(message: object): void { if (this.closed || !this.output.writable) throw new DebuggerError("debug_not_connected"); const body = Buffer.from(JSON.stringify({ seq: this.seq++, ...message })); this.output.write(Buffer.concat([Buffer.from(`Content-Length: ${body.length}\r\n\r\n`), body])); }
  request<T = any>(command: string, args: unknown = {}, timeoutMs = 10_000): Promise<T> {
    const seq = this.seq;
    return new Promise((resolvePromise, reject) => { const timer = setTimeout(() => { this.pending.delete(seq); reject(new DebuggerError(`debug_timeout:${command}`)); }, timeoutMs); this.pending.set(seq, { resolve: resolvePromise, reject, timer }); try { this.send({ type: "request", command, arguments: args }); } catch (error) { clearTimeout(timer); this.pending.delete(seq); reject(error); } });
  }
  waitInitialized(timeoutMs: number): Promise<void> {
    if (this.closed) return Promise.reject(new DebuggerError("debug_not_connected"));
    if (this.initialized) return Promise.resolve();
    return new Promise((resolvePromise, reject) => {
      const cleanup = () => { clearTimeout(timer); this.off("event", onEvent); this.off("closed", onClosed); };
      const onEvent = (name: string) => { if (name === "initialized") { cleanup(); resolvePromise(); } };
      const onClosed = (error: Error) => { cleanup(); reject(error); };
      const timer = setTimeout(() => { cleanup(); reject(new DebuggerError("debug_initialize_timeout")); }, timeoutMs);
      this.on("event", onEvent); this.on("closed", onClosed);
    });
  }
  close(error = new DebuggerError("debug_stopped")): void { if (this.closed) return; this.closed = true; this.buffer = Buffer.alloc(0); for (const p of this.pending.values()) { clearTimeout(p.timer); p.reject(error); } this.pending.clear(); this.emit("closed", error); }
}

export class DebuggerClient extends EventEmitter {
  private current: DebugSnapshot = { state: "idle", threads: [], frames: [], scopes: [], variables: {}, breakpoints: {}, output: [] };
  private proc: ChildProcess | null = null;
  private channels = new Set<DapChannel>();
  private sockets = new Set<Socket>();
  private primary: DapChannel | null = null;
  private active: DapChannel | null = null;
  private endpoint: { host: string; port: number } | null = null;
  private childTargets = new Set<string>();
  private generation = 0;
  private lifetime = 0;
  private startAttempted = false;
  private stopping: Promise<void> | null = null;
  private processTermination: Promise<boolean> = Promise.resolve(true);
  readonly prepared: PreparedDebugSession;
  constructor(prepared: PreparedDebugSession) { super(); this.prepared = freeze(structuredClone(prepared)); }
  get snapshot(): DebugSnapshot { return structuredClone(this.current); }
  get running(): boolean { return ["starting", "running", "stopped"].includes(this.current.state); }
  private changed(): void { this.emit("change", this.snapshot); }
  private transition(state: DebugState, extras: Partial<DebugSnapshot> = {}): void { this.current = { ...this.current, ...extras, state }; this.changed(); }
  private appendOutput(text: string): void { this.current.output.push(...sanitizeForDisplay(text).slice(0, 16000).split(/\r?\n/)); this.current.output = this.current.output.slice(-300); this.changed(); }
  private teardown(error = new DebuggerError("debug_stopped")): void { this.lifetime++; this.generation++; const channels = [...this.channels]; this.channels.clear(); for (const channel of channels) channel.close(error); for (const socket of this.sockets) socket.destroy(); this.sockets.clear(); if(this.proc)this.processTermination=waitProcessExit(this.proc);killProcess(this.proc); this.proc = null; this.primary = null; this.active = null; this.clearStopped(); }
  private async confirmProcessStopped(): Promise<void> { if(!await this.processTermination){this.transition("failed",{error:"debug_adapter_stop_unconfirmed"});throw new DebuggerError("debug_adapter_stop_unconfirmed");} }
  private failure(error: unknown): void { if (["stopping", "terminated", "failed"].includes(this.current.state)) return; this.transition("failed", { error: error instanceof Error ? error.message : "debug_failed" }); this.teardown(); this.changed(); }
  private clearStopped(): void { this.current.frames = []; this.current.scopes = []; this.current.variables = {}; this.current.frameId = undefined; }

  async start(approval: { approvedFingerprint: string }, timeoutMs = 15_000): Promise<void> {
    if (this.startAttempted) throw new DebuggerError("debug_session_already_started");
    if (approval?.approvedFingerprint !== this.prepared.fingerprint || digest(identity(this.prepared)) !== this.prepared.fingerprint) throw new DebuggerError("debug_approval_required");
    this.startAttempted = true;
    this.transition("starting");
    const lifetime = this.lifetime;
    try {
      const adapter = this.prepared.adapter;
      if (adapter.kind === "tcp") this.endpoint = { host: adapter.host ?? "127.0.0.1", port: adapter.port };
      else {
        // Resolve again to catch a changed symlink between review and launch.
        if (adapterProgram(adapter.command) !== adapter.command || realpathSync.native(this.prepared.rootPath) !== this.prepared.rootPath) throw new DebuggerError("debug_configuration_changed");
        const args = adapter.kind === "js-debug" ? [...adapter.args!, "0", "127.0.0.1"] : adapter.args ?? [];
        this.proc = spawn(adapter.command, args, { cwd: this.prepared.rootPath, env: minimalEnv(), shell: false, windowsHide: true, detached: process.platform !== "win32", stdio: ["pipe", "pipe", "pipe"] });
        this.proc.stdin!.on("error", () => undefined);
        this.proc.on("error", () => this.failure(new DebuggerError("debug_adapter_spawn_failed")));
        this.proc.on("exit", (code) => { if (this.running) this.failure(new DebuggerError(`debug_adapter_exited:${code ?? "signal"}`)); });
        this.proc.stderr!.on("data", (chunk: Buffer) => this.appendOutput(chunk.toString("utf8")));
        if (adapter.kind === "js-debug") this.endpoint = await this.serverEndpoint(this.proc, timeoutMs);
        else this.primary = this.addChannel(new DapChannel(this.proc.stdout!, this.proc.stdin!));
      }
      if (lifetime !== this.lifetime || !this.running) throw new DebuggerError("debug_stopped");
      if (this.endpoint) this.primary = await this.socketChannel(timeoutMs);
      if (lifetime !== this.lifetime || !this.primary) throw new DebuggerError("debug_stopped");
      this.active = this.primary;
      await this.configure(this.primary, this.prepared.request, this.prepared.configuration, timeoutMs);
      if (lifetime !== this.lifetime && this.current.state !== "terminated") throw new DebuggerError("debug_stopped");
      if (this.current.state === "starting") this.transition("running");
    } catch (error) { this.failure(error); throw error; }
  }
  private serverEndpoint(proc: ChildProcess, timeoutMs: number): Promise<{ host: string; port: number }> {
    return new Promise((resolvePromise, reject) => {
      let text = "";
      const cleanup = () => { clearTimeout(timer); proc.stdout!.off("data", onData); proc.off("exit", onExit); proc.off("error", onExit); };
      const onExit = () => { cleanup(); reject(new DebuggerError("debug_adapter_spawn_failed")); };
      const onData = (chunk: Buffer) => { text += chunk.toString("utf8"); const match = /Debug server listening at 127\.0\.0\.1:(\d+)/.exec(text); if (match) { cleanup(); const port = Number(match[1]); if (port > 0 && port <= 65535) resolvePromise({ host: "127.0.0.1", port }); else reject(new DebuggerError("debug_invalid_endpoint")); } else if (text.length > 16_384) { cleanup(); reject(new DebuggerError("debug_invalid_endpoint")); } };
      const timer = setTimeout(() => { cleanup(); reject(new DebuggerError("debug_adapter_start_timeout")); }, timeoutMs);
      proc.stdout!.on("data", onData); proc.on("exit", onExit); proc.on("error", onExit);
    });
  }
  private socketChannel(timeoutMs: number): Promise<DapChannel> {
    return new Promise((resolvePromise, reject) => {
      const socket = connect(this.endpoint!); this.sockets.add(socket);
      const timer = setTimeout(() => { socket.destroy(); reject(new DebuggerError("debug_connect_timeout")); }, timeoutMs);
      socket.once("error", () => { clearTimeout(timer); reject(new DebuggerError("debug_connect_failed")); });
      socket.once("close", () => { this.sockets.delete(socket); clearTimeout(timer); if (!socket.readyState || socket.readyState === "closed") reject(new DebuggerError("debug_disconnected")); });
      socket.once("connect", () => { clearTimeout(timer); resolvePromise(this.addChannel(new DapChannel(socket, socket))); });
    });
  }
  private addChannel(channel: DapChannel): DapChannel {
    this.channels.add(channel);
    channel.on("event", (event, body) => this.onEvent(channel, event, body));
    channel.on("reverse", (message: DapMessage) => { void this.reverse(channel, message).catch((error) => this.failure(error)); });
    channel.on("closed", (error) => { if (this.channels.has(channel)) this.failure(error); });
    return channel;
  }
  private async configure(channel: DapChannel, request: "launch" | "attach", configuration: Record<string, unknown>, timeoutMs: number): Promise<void> {
    channel.capabilities = await channel.request("initialize", { clientID: "uptokey-tui", adapterID: this.prepared.adapter.id ?? "uptokey", linesStartAt1: true, columnsStartAt1: true, pathFormat: "path", supportsVariableType: true, supportsVariablePaging: true, supportsRunInTerminalRequest: false, supportsStartDebuggingRequest: this.prepared.adapter.kind === "js-debug" }, timeoutMs);
    // launch can complete only after configurationDone; observe its rejection immediately.
    const launch = channel.request(request, configuration, timeoutMs); void launch.catch(() => undefined);
    const initialized = channel.waitInitialized(timeoutMs);
    await Promise.race([initialized, launch.then(() => initialized)]);
    for (const bp of this.prepared.breakpoints ?? []) await this.breakpointsOn(channel, bp.path, bp.lines);
    await channel.request("setExceptionBreakpoints", { filters: [] }, timeoutMs);
    if (channel.capabilities.supportsConfigurationDoneRequest) await channel.request("configurationDone", {}, timeoutMs);
    await launch;
  }
  private async reverse(channel: DapChannel, message: DapMessage): Promise<void> {
    const reject = () => channel.send({ type: "response", request_seq: message.seq, command: message.command, success: false, message: "Client execution requires separate explicit approval" });
    const args = message.arguments, config = args?.configuration;
    if (!this.running || this.prepared.adapter.kind !== "js-debug" || !this.endpoint || message.command !== "startDebugging" || !["launch", "attach"].includes(args?.request) || !config || typeof config.__pendingTargetId !== "string" || config.__pendingTargetId.length > 256 || Object.keys(config).some((key) => !["__pendingTargetId", "type", "name"].includes(key)) || config.type !== this.prepared.configuration.type || this.childTargets.size >= 8 || this.childTargets.has(config.__pendingTargetId)) { reject(); return; }
    // A pending target binds an already-authorized debuggee; no program/argv/env
    // from the reverse request is accepted and it can connect only to this server.
    this.childTargets.add(config.__pendingTargetId);
    const child = await this.socketChannel(10_000);
    channel.send({ type: "response", request_seq: message.seq, command: message.command, success: true });
    await this.configure(child, args.request, config, 15_000);
    if (this.active === this.primary) this.active = child;
  }
  private onEvent(channel: DapChannel, event: string, body: any): void {
    if (!this.running) return;
    if (event === "output") this.appendOutput(String(body.output ?? ""));
    else if (event === "stopped") {
      this.active = channel; this.generation++; this.clearStopped(); this.transition("stopped", { reason: String(body.reason ?? "pause"), threadId: body.threadId });
      void this.refreshStopped().catch((error) => { if (this.current.state === "stopped") { this.current.error = error.message; this.changed(); } });
    } else if (event === "continued" && channel === this.active) { this.generation++; this.clearStopped(); this.transition("running", { reason: undefined }); }
    else if (event === "terminated") {
      // js-debug has a launcher and target session; termination of the target is definitive.
      if (channel === this.active || channel === this.primary) { this.transition("terminated"); this.teardown(); this.changed(); }
    } else if (event === "breakpoint" && body.breakpoint) {
      for (const list of Object.values(this.current.breakpoints)) for (let i = 0; i < list.length; i++) if (list[i]!.id !== undefined && list[i]!.id === body.breakpoint.id) list[i] = body.breakpoint;
      this.changed();
    }
  }
  private selected(): DapChannel { if (!this.active || !this.running) throw new DebuggerError("debug_not_running"); return this.active; }
  private paused(): { channel: DapChannel; threadId: number } { if (this.current.state !== "stopped" || this.current.threadId === undefined) throw new DebuggerError("debug_not_stopped"); return { channel: this.selected(), threadId: this.current.threadId }; }
  private async breakpointsOn(channel: DapChannel, path: string, lines: number[]): Promise<DebugBreakpoint[]> { const source = inside(this.prepared.rootPath, path); const response = await channel.request<{ breakpoints?: DebugBreakpoint[] }>("setBreakpoints", { source: { path: source }, breakpoints: validateLines(lines).map((line) => ({ line })), sourceModified: false }); this.current.breakpoints[source] = response.breakpoints ?? []; this.changed(); return this.current.breakpoints[source]!; }
  async setBreakpoints(path: string, lines: number[]): Promise<DebugBreakpoint[]> { return this.breakpointsOn(this.selected(), path, lines); }
  async refreshStopped(): Promise<void> {
    const channel = this.selected(), generation = this.generation;
    const result = await channel.request<{ threads: DebugThread[] }>("threads");
    if (generation !== this.generation || this.current.state !== "stopped") return;
    this.current.threads = result.threads ?? [];
    this.current.threadId ??= this.current.threads[0]?.id;
    if (this.current.threadId !== undefined) await this.selectThread(this.current.threadId);
    else this.changed();
  }
  async selectThread(threadId: number): Promise<void> {
    const { channel } = this.paused(); const generation = ++this.generation; this.clearStopped(); this.current.threadId = threadId;
    const response = await channel.request<{ stackFrames: DebugFrame[] }>("stackTrace", { threadId, startFrame: 0, levels: 100 });
    if (generation !== this.generation || this.current.state !== "stopped") return;
    this.current.frames = response.stackFrames ?? []; this.changed();
    if (this.current.frames[0]) await this.selectFrame(this.current.frames[0].id);
  }
  async selectFrame(frameId: number): Promise<void> {
    const { channel } = this.paused(); if (!this.current.frames.some((frame) => frame.id === frameId)) throw new DebuggerError("debug_unknown_frame");
    const generation = ++this.generation; this.current.frameId = frameId; this.current.scopes = []; this.current.variables = {}; this.changed();
    const response = await channel.request<{ scopes: DebugScope[] }>("scopes", { frameId });
    if (generation !== this.generation || this.current.state !== "stopped") return;
    this.current.scopes = response.scopes ?? []; this.changed();
    for (const scope of this.current.scopes.filter((item) => !item.expensive).slice(0, 4)) { if (generation !== this.generation) break; await this.variables(scope.variablesReference); }
  }
  async variables(variablesReference: number): Promise<DebugVariable[]> {
    const { channel } = this.paused(), generation = this.generation;
    if (!Number.isSafeInteger(variablesReference) || variablesReference < 1) throw new DebuggerError("debug_invalid_reference");
    const response = await channel.request<{ variables: DebugVariable[] }>("variables", { variablesReference, start: 0, count: 100 });
    if (generation !== this.generation || this.current.state !== "stopped") return [];
    const variables = (response.variables ?? []).slice(0, 100); this.current.variables[variablesReference] = variables; this.changed(); return variables;
  }
  private async resume(command: "continue" | "next" | "stepIn" | "stepOut"): Promise<void> { const { channel, threadId } = this.paused(); const generation = ++this.generation; await channel.request(command, { threadId }); if (generation === this.generation) { this.clearStopped(); this.transition("running"); } }
  continue(): Promise<void> { return this.resume("continue"); }
  next(): Promise<void> { return this.resume("next"); }
  stepIn(): Promise<void> { return this.resume("stepIn"); }
  stepOut(): Promise<void> { return this.resume("stepOut"); }
  async pause(): Promise<void> { const channel = this.selected(); if (this.current.state !== "running") throw new DebuggerError("debug_not_running"); const threads = await channel.request<{ threads: DebugThread[] }>("threads"); const threadId = this.current.threadId ?? threads.threads?.[0]?.id; if (threadId === undefined) throw new DebuggerError("debug_no_thread"); await channel.request("pause", { threadId }); }
  stop(): Promise<void> {
    if (this.stopping) return this.stopping;
    if (["terminated", "failed", "idle"].includes(this.current.state)) { this.teardown(); return this.confirmProcessStopped().then(()=>{if(this.current.state!=="failed")this.transition("terminated");}); }
    this.transition("stopping"); this.generation++;
    this.stopping = (async () => { await Promise.allSettled([...this.channels].map((channel) => channel.request("disconnect", { restart: false, terminateDebuggee: this.prepared.request === "launch" }, 1500))); this.teardown(); await this.confirmProcessStopped();this.transition("terminated"); })();
    return this.stopping;
  }
  dispose(): void { void this.stop().catch(()=>undefined).finally(() => this.removeAllListeners()); }
}
