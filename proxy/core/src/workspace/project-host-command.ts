import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import { canonicalContextSnapshotPayload, parseCapabilityDescriptor, parseExecutionPlan, validatePlanBindings, type ExecutionPlan } from '@uptokey/sync-contract/workflow';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { computePlanDigest } from './planner.ts';
import { WorkspaceError } from './workspace-error.ts';
import type { WorkspaceRuntime } from './runtime.ts';
import type { EffectRequest, EffectOutcome } from './executor.ts';

export const PROJECT_HOST_COMMAND_CAPABILITY = parseCapabilityDescriptor({
  schemaVersion: 1,
  id: 'workspace.project.host-command',
  version: 1,
  createdAt: '2026-10-01T00:00:00.000Z',
  titleKey: 'ws_project_host_command',
  descriptionKey: 'ws_project_host_command_scope',
  tags: ['project', 'command', 'host'],
  inputSchemaId: 'workspace.project.host-command.input.v1',
  outputSchemaId: 'workspace.project.host-command.output.v1',
  effect: 'execute_local',
  dataDestination: { kind: 'local', id: 'authorized_project_root' },
  availability: 'executable',
  supportLevel: 'experimental',
  requiredScopes: ['run:execute', 'project:process:run'],
  retryClass: 'never_automatic',
  limits: { maxSteps: 1, maxCalls: 1, maxOutputTokens: 4096, timeoutMs: 330000, maxOutputBytes: 1048576 },
});

const ALLOWED_ENV_VARS = new Set([
  'systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec',
  'processor_architecture', 'number_of_processors', 'programfiles',
  'programfiles(x86)', 'lang', 'lc_all', 'term', 'home', 'userprofile'
]);

export function sanitizedHostEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (ALLOWED_ENV_VARS.has(key.toLowerCase()) && value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

export function terminateProcessTree(proc: ChildProcessWithoutNullStreams) {
  if (!proc.pid) return;
  try {
    if (process.platform === 'win32') {
      spawn('taskkill', ['/PID', String(proc.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    } else {
      try {
        process.kill(-proc.pid, 'SIGKILL');
      } catch {
        proc.kill('SIGKILL');
      }
    }
  } catch {}
}

export async function terminateProcessTreeAsync(proc: ChildProcessWithoutNullStreams): Promise<boolean> {
  if (!proc.pid) return true;
  const pid = proc.pid;
  const isWin = process.platform === 'win32';

  let closed = proc.exitCode !== null || proc.signalCode !== null;
  if (closed) return true;
  let closeListener: () => void;
  const closePromise = new Promise<void>((resolve) => {
    closeListener = () => { closed = true; resolve(); };
    proc.once('close', closeListener);
  });
  let killConfirmed = false;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    if (isWin) {
      killConfirmed = await new Promise<boolean>((resolve) => {
        const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
        const timer = setTimeout(() => resolve(false), 5000);
        const finish = (confirmed: boolean) => { clearTimeout(timer); resolve(confirmed); };
        killer.once('close', code => finish(code === 0));
        killer.once('error', () => finish(false));
      });
    } else {
      try {
        process.kill(-pid, 'SIGKILL');
        killConfirmed = true;
      } catch (error) {
        // ESRCH means this detached group no longer exists. Other failures
        // cannot establish that descendants stopped.
        killConfirmed = (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }
    await Promise.race([closePromise, new Promise<void>(resolve => { timeout = setTimeout(resolve, 2500); })]);
    return closed && killConfirmed;
  } catch {
    return false;
  } finally {
    if (timeout) clearTimeout(timeout);
    proc.removeListener('close', closeListener!);
  }
}

export const MAX_OUTPUT_BYTES = 64 * 1024;
const TRUNCATION_NOTICE = '\n[Output truncated at 64 KiB UTF-8]';
const TRUNCATION_NOTICE_BYTES = Buffer.byteLength(TRUNCATION_NOTICE, 'utf8');

export interface CommandOutcome {
  status: 'completed' | 'timed_out' | 'failed' | 'aborted' | 'cancelled';
  output: string;
  exitCode: number | null;
  stdout?: string;
  stderr?: string;
  error?: string;
}

export class PersistentShell {
  private proc: ChildProcessWithoutNullStreams | null = null;
  private currentGeneration = 0;
  private outputBuffer = '';
  private stdoutBuffer = '';
  private stderrBuffer = '';
  private resolveOutput: ((val: CommandOutcome) => void) | null = null;
  private currentToken: string | null = null;
  private currentCwd: string;
  private queue: Promise<unknown> = Promise.resolve();
  private onDeltaCallback: ((text: string) => void) | null = null;
  private onChunkCallback: ((channel: 'stdout' | 'stderr', chunk: Buffer) => void) | null = null;
  private stdoutDecoder = new StringDecoder('utf8');
  private stderrDecoder = new StringDecoder('utf8');
  private pendingStreamText = '';
  private protocolBuffer = '';
  private beginBuffer = '';
  private awaitingBegin = false;
  private seenDelim = false;
  private stderrEnded = false;
  private pendingStderrText = '';
  private observedExitCode: number | null = null;
  private stopping: Promise<void> | null = null;
  private terminationUnconfirmed = false;
  private closed = false;

  constructor(cwd: string) {
    this.currentCwd = cwd;
  }

  get cwd(): string { return this.currentCwd; }

  start(cwd: string): boolean {
    if (this.proc) return true;
    this.currentCwd = cwd;
    const isWin = process.platform === 'win32';
    const shellExe = isWin ? (process.env.COMSPEC || 'cmd.exe') : '/bin/sh';
    const shellArgs = isWin ? ['/D', '/Q'] : [];

    const generation = ++this.currentGeneration;
    this.stdoutDecoder = new StringDecoder('utf8');
    this.stderrDecoder = new StringDecoder('utf8');
    this.pendingStreamText = '';
    this.seenDelim = false;
    this.outputBuffer = '';
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    try {
      this.proc = spawn(shellExe, shellArgs, {
        cwd: this.currentCwd,
        env: sanitizedHostEnv(),
        windowsHide: true,
        detached: !isWin,
      });
    } catch (err) {
      this.proc = null;
      return false;
    }

    if (isWin) this.proc.stdin.write('prompt $ \r\n@echo off\r\n');

    this.proc.stdout.on('data', (chunk: Buffer) => {
      if (this.currentGeneration !== generation) return;
      this.handleStdoutData(chunk);
    });

    this.proc.stderr.on('data', (chunk: Buffer) => {
      if (this.currentGeneration !== generation) return;
      this.handleStderrData(chunk);
    });

    this.proc.on('close', (code) => {
      if (this.currentGeneration !== generation) return;
      this.handleProcessClose(code);
    });

    this.proc.on('error', (err) => {
      if (this.currentGeneration !== generation) return;
      this.handleProcessError(err);
    });

    return true;
  }

  private cleanOutput(raw: string): string {
    let text = raw;
    if (this.currentToken) {
      text = text.replaceAll(`__UPTOKEY_DELIM_${this.currentToken}__`, '')
        .replace(new RegExp(`__UPTOKEY_EXIT_${this.currentToken}__:-?\\d+`, 'g'), '');
    }
    if (process.platform === 'win32') {
      text = text.replace(/(?:^|\r?\n)(?:[A-Za-z]:\\|\\\\)[^>\r\n]*>/g, '');
    }
    return text.trim();
  }

  private boundBuffer(current: string, next: string): string {
    const previouslyTruncated = current.endsWith(TRUNCATION_NOTICE);
    let combined = (previouslyTruncated ? current.slice(0, -TRUNCATION_NOTICE.length) : current) + next;
    const totalBytes = Buffer.byteLength(combined, 'utf8');
    if (previouslyTruncated || totalBytes > MAX_OUTPUT_BYTES) {
      const fullBuf = Buffer.from(combined, 'utf8');
      const keepBytes = MAX_OUTPUT_BYTES - TRUNCATION_NOTICE_BYTES;
      let start = Math.max(0, fullBuf.length - keepBytes);
      while (start < fullBuf.length && (fullBuf[start]! & 0xc0) === 0x80) {
        start++;
      }
      combined = fullBuf.subarray(start).toString('utf8') + TRUNCATION_NOTICE;
    }
    return combined;
  }

  private flushStream() {
    if (!this.onDeltaCallback && !this.onChunkCallback) return;

    // Ordinary output sharing the namespace is data. Retain only control
    // prefixes; a chunk boundary can split either marker at any character.
    const controlPrefixes = this.currentToken
      ? [`__UPTOKEY_DELIM_${this.currentToken}__`, `__UPTOKEY_EXIT_${this.currentToken}__:`]
      : ['__UPTOKEY_DELIM_', '__UPTOKEY_EXIT_'];
    const positions = controlPrefixes.map(prefix => this.pendingStreamText.indexOf(prefix)).filter(index => index >= 0);
    const delimIdx = positions.length ? Math.min(...positions) : -1;
    if (delimIdx !== -1) {
      const safe = this.pendingStreamText.slice(0, delimIdx);
      if (safe) {
        this.emitSafe(safe);
      }
      // A real control frame is short. Bound retention even if a faulty shell
      // emits additional output after that frame without its exit marker.
      this.pendingStreamText = this.pendingStreamText.slice(delimIdx, delimIdx + 256);
      return;
    }

    let matchLen = 0;
    for (const prefixTarget of controlPrefixes) {
      for (let len = Math.min(prefixTarget.length - 1, this.pendingStreamText.length); len > matchLen; len--) {
        if (prefixTarget.startsWith(this.pendingStreamText.slice(-len))) {
          matchLen = len;
          break;
        }
      }
    }

    if (matchLen > 0) {
      const safe = this.pendingStreamText.slice(0, -matchLen);
      if (safe) {
        this.emitSafe(safe);
      }
      this.pendingStreamText = this.pendingStreamText.slice(-matchLen);
    } else {
      this.emitSafe(this.pendingStreamText);
      this.pendingStreamText = '';
    }
  }

  private emitSafe(text: string) {
    if (!text) return;
    this.onDeltaCallback?.(text);
    this.onChunkCallback?.('stdout', Buffer.from(text, 'utf8'));
  }

  private handleStdoutData(chunk: Buffer) {
    let text = this.stdoutDecoder.write(chunk);
    if (!text) return;
    if (this.awaitingBegin && this.currentToken) {
      const begin = `__UPTOKEY_BEGIN_${this.currentToken}__`;
      const buffered = this.beginBuffer + text;
      const index = buffered.indexOf(begin);
      if (index < 0) {
        this.beginBuffer = buffered.slice(-(begin.length - 1));
        return;
      }
      this.beginBuffer = '';
      this.awaitingBegin = false;
      text = buffered.slice(index + begin.length).replace(/^\r?\n/, '');
    }

    this.stdoutBuffer = this.boundBuffer(this.stdoutBuffer, text);
    this.outputBuffer = this.boundBuffer(this.outputBuffer, text);
    const protocol = this.protocolBuffer + text;
    if (this.currentToken && protocol.includes(`__UPTOKEY_DELIM_${this.currentToken}__`)) this.seenDelim = true;
    // Inspect the complete chunk before retaining the bounded tail: a frame
    // at the beginning of a large chunk must not disappear before parsing.
    this.protocolBuffer = protocol;

    if (this.onDeltaCallback || this.onChunkCallback) {
      this.pendingStreamText += text;
      this.flushStream();
    }

    this.checkMarker();
    this.protocolBuffer = this.protocolBuffer.slice(-256);
  }

  private handleStderrData(chunk: Buffer) {
    const decoded = this.stderrDecoder.write(chunk);
    if (!decoded || !this.currentToken || this.stderrEnded) return;
    const marker = `__UPTOKEY_STDERR_END_${this.currentToken}__`;
    const text = this.pendingStderrText + decoded;
    const index = text.indexOf(marker);
    let keep = 0;
    if (index < 0) for (let length = Math.min(marker.length - 1, text.length); length > 0; length--) {
      if (marker.startsWith(text.slice(-length))) { keep = length; break; }
    }
    const safe = index >= 0 ? text.slice(0, index) : keep ? text.slice(0, -keep) : text;
    this.pendingStderrText = index >= 0 ? '' : keep ? text.slice(-keep) : '';
    this.stderrBuffer = this.boundBuffer(this.stderrBuffer, safe);
    this.outputBuffer = this.boundBuffer(this.outputBuffer, safe);
    if (safe) { this.onChunkCallback?.('stderr', Buffer.from(safe, 'utf8')); this.onDeltaCallback?.(safe); }
    if (index >= 0) { this.stderrEnded = true; this.checkMarker(); }
  }

  private checkMarker() {
    if (!this.currentToken || !this.resolveOutput) return;

    const token = this.currentToken;
    const delim = `__UPTOKEY_DELIM_${token}__`;
    const exitMarker = `__UPTOKEY_EXIT_${token}__:`;

    if (!this.seenDelim) return;
    const codeMatch = this.protocolBuffer.match(new RegExp(`${exitMarker}(-?\\d+)[\\r\\n]`));
    if (codeMatch) {
      const code = Number(codeMatch[1]);
      if (Number.isSafeInteger(code)) this.observedExitCode = code;
    }
    // stdout and stderr are independently scheduled pipes. Preserve the parsed
    // status before bounding stdout's tail, then wait for stderr's own barrier.
    if (this.observedExitCode === null || !this.stderrEnded) return;

    const rawOutput = this.cleanOutput(this.outputBuffer);
    const rawStdOut = this.cleanOutput(
      this.stdoutBuffer.indexOf(delim) !== -1
        ? this.stdoutBuffer.slice(0, this.stdoutBuffer.indexOf(delim))
        : this.stdoutBuffer
    );
    const rawStdErr = this.cleanOutput(this.stderrBuffer);
    const exitCode = this.observedExitCode;
    this.outputBuffer = '';
    this.protocolBuffer = '';
    this.stdoutBuffer = '';
    this.stderrBuffer = '';
    this.pendingStreamText = '';
    this.seenDelim = false;

    const resolve = this.resolveOutput;
    this.resolveOutput = null;
    this.currentToken = null;

    resolve({
      status: exitCode === 0 ? 'completed' : 'failed',
      output: rawOutput,
      exitCode,
      stdout: rawStdOut,
      stderr: rawStdErr,
    });
  }

  private handleProcessClose(code: number | null) {
    const trailingOut = this.stdoutDecoder.end();
    const trailingErr = this.stderrDecoder.end();
    if (trailingOut) {
      this.stdoutBuffer = this.boundBuffer(this.stdoutBuffer, trailingOut);
      this.outputBuffer = this.boundBuffer(this.outputBuffer, trailingOut);
    }
    if (trailingErr) {
      this.stderrBuffer = this.boundBuffer(this.stderrBuffer, trailingErr);
      this.outputBuffer = this.boundBuffer(this.outputBuffer, trailingErr);
    }
    this.pendingStreamText = '';

    if (this.resolveOutput) {
      const resolve = this.resolveOutput;
      this.resolveOutput = null;
      const clean = this.cleanOutput(this.outputBuffer);
      const cleanStdOut = this.cleanOutput(this.stdoutBuffer);
      const cleanStdErr = this.cleanOutput(this.stderrBuffer);
      this.currentToken = null;
      this.outputBuffer = '';
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.seenDelim = false;
      const exitCode = typeof code === 'number' ? code : -1;
      resolve({
        status: exitCode === 0 ? 'completed' : 'failed',
        output: clean,
        exitCode,
        stdout: cleanStdOut,
        stderr: cleanStdErr,
      });
    }
    this.proc = null;
  }

  private handleProcessError(err: unknown) {
    this.pendingStreamText = '';
    if (this.resolveOutput) {
      const resolve = this.resolveOutput;
      this.resolveOutput = null;
      this.currentToken = null;
      this.outputBuffer = '';
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.seenDelim = false;
      const errMsg = err instanceof Error ? err.message : String(err);
      resolve({ status: 'failed', output: errMsg, exitCode: -1, stdout: '', stderr: errMsg });
    }
    this.proc = null;
  }

  async runCommand(
    command: string,
    timeoutMs = 5000,
    signal?: AbortSignal,
    options?: {
      onChunk?: (channel: 'stdout' | 'stderr', chunk: Buffer) => void;
      onDelta?: (text: string) => void;
      revalidate?: () => Promise<void>;
    }
  ): Promise<CommandOutcome> {
    const run = async (): Promise<CommandOutcome> => {
      if (this.closed) throw new WorkspaceError('host_command_session_closed', 409);
      if (this.stopping) await this.stopping;
      if (this.closed || this.terminationUnconfirmed) throw new WorkspaceError('host_command_stop_unconfirmed', 409);
      signal?.throwIfAborted();
      if (options?.revalidate) await options.revalidate();
      signal?.throwIfAborted();
      if (this.closed) throw new WorkspaceError('host_command_session_closed', 409);

      if (!this.proc) {
        const started = this.start(this.currentCwd);
        if (!started || !this.proc) {
          return { status: 'failed', output: 'Failed to spawn shell', exitCode: -1 };
        }
      }

      signal?.throwIfAborted();
      if (options?.revalidate) {
        await options.revalidate();
      }
      signal?.throwIfAborted();

      const token = randomUUID().replace(/-/g, '');
      this.currentToken = token;
      this.stderrEnded = false;
      this.pendingStderrText = '';
      this.observedExitCode = null;
      this.outputBuffer = '';
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.protocolBuffer = '';
      this.beginBuffer = '';
      this.awaitingBegin = true;
      this.onDeltaCallback = options?.onDelta ?? null;
      this.onChunkCallback = options?.onChunk ?? null;
      this.pendingStreamText = '';
      this.seenDelim = false;
      const isWin = process.platform === 'win32';

      let tempBat: string | null = null;
      let effectiveCommand = command;
      try {
        if (isWin && /[^\x00-\x7F]/.test(command)) {
          tempBat = join(tmpdir(), `uptokey-cmd-${randomUUID()}.bat`);
          await fs.writeFile(tempBat, `@chcp 65001 > nul\r\n${command}\r\n`, { encoding: 'utf8', flag: 'wx' });
          effectiveCommand = `call "${tempBat}"`;
        }
        if (options?.revalidate) await options.revalidate();
        signal?.throwIfAborted();
        if (this.closed) throw new WorkspaceError('host_command_session_closed', 409);
      } catch (error) {
        if (tempBat) await fs.unlink(tempBat).catch(() => undefined);
        this.currentToken = null;
        this.onDeltaCallback = null;
        this.onChunkCallback = null;
        throw error;
      }

      return new Promise<CommandOutcome>((resolve) => {
        let timer: ReturnType<typeof setTimeout> | null = null;
        let stopping = false;

        const cleanup = () => {
          if (timer) clearTimeout(timer);
          if (tempBat) {
            void fs.unlink(tempBat).catch(() => {});
            tempBat = null;
          }
          this.resolveOutput = null;
          this.currentToken = null;
          this.onDeltaCallback = null;
          this.onChunkCallback = null;
          this.pendingStreamText = '';
          this.seenDelim = false;
        };

        const stopAndResolve = async (status: 'aborted' | 'timed_out') => {
          if (stopping) return;
          stopping = true;
          const partial = this.cleanOutput(this.outputBuffer);
          const stdout = this.cleanOutput(this.stdoutBuffer);
          const stderr = this.cleanOutput(this.stderrBuffer);
          signal?.removeEventListener('abort', abortHandler);
          cleanup();
          try {
            await this.terminateAsync();
            resolve({ status, output: partial, exitCode: null, stdout, stderr });
          } catch {
            resolve({ status: 'failed', output: partial, exitCode: null, stdout, stderr, error: 'host_command_stop_unconfirmed' });
          }
        };
        const abortHandler = () => { void stopAndResolve('aborted'); };

        if (signal?.aborted) {
          void abortHandler();
          return;
        }
        signal?.addEventListener('abort', abortHandler, { once: true });

        timer = setTimeout(() => { void stopAndResolve('timed_out'); }, timeoutMs);

        this.resolveOutput = (val) => {
          signal?.removeEventListener('abort', abortHandler);
          if (timer) clearTimeout(timer);
          cleanup();
          resolve(val);
        };

        const delim = `__UPTOKEY_DELIM_${token}__`;
        const exitMarker = `__UPTOKEY_EXIT_${token}__:`;
        const begin = `__UPTOKEY_BEGIN_${token}__`;
        const stderrEnd = `__UPTOKEY_STDERR_END_${token}__`;
        const statusVariable = `UPTOKEY_STATUS_${token}`;
        const payload = isWin
          ? `@echo ${begin}\r\n${effectiveCommand}\r\n@set "${statusVariable}=%errorlevel%"\r\n@echo ${stderrEnd} 1>&2\r\n@echo ${delim}\r\n@call echo ${exitMarker}%${statusVariable}%\r\n@set "${statusVariable}="\r\n`
          : `printf '%s\\n' '${begin}'\n${effectiveCommand}\n${statusVariable}=$?\nprintf '%s\\n' '${stderrEnd}' >&2\nprintf "\n%s\n%s%d\n" "${delim}" "${exitMarker}" "$${statusVariable}"\nunset ${statusVariable}\n`;

        try {
          this.proc!.stdin.write(payload);
        } catch (err) {
          signal?.removeEventListener('abort', abortHandler);
          cleanup();
          resolve({ status: 'failed', output: String(err), exitCode: -1 });
        }
      });
    };

    const next = this.queue.then(run, run);
    this.queue = next;
    return next;
  }

  terminate() {
    void this.close().catch(() => undefined);
  }

  async terminateAsync(): Promise<void> {
    if (this.stopping) return this.stopping;
    const stopping = (async () => {
      const proc = this.proc;
      if (proc && !(await terminateProcessTreeAsync(proc))) {
        this.terminationUnconfirmed = true;
        throw new WorkspaceError('host_command_stop_unconfirmed', 409);
      }
      this.terminationUnconfirmed = false;
      if (this.proc === proc) this.proc = null;
      this.currentGeneration++;
      const pending = this.resolveOutput;
      const partial = this.cleanOutput(this.outputBuffer);
      this.currentToken = null;
      this.resolveOutput = null;
      this.outputBuffer = '';
      this.stdoutBuffer = '';
      this.stderrBuffer = '';
      this.pendingStreamText = '';
      this.seenDelim = false;
      this.onChunkCallback = null;
      this.onDeltaCallback = null;
      pending?.({ status: 'aborted', output: partial, exitCode: null });
    })();
    this.stopping = stopping;
    try { await stopping; } finally { if (this.stopping === stopping) this.stopping = null; }
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.terminateAsync();
  }
}

// ─── CORE-OWNED PERSISTENT SESSIONS (H02 / K03) ─────────────────────────────
export interface HostSessionEntry {
  shell: PersistentShell;
  principalId: string;
  projectId: string;
  rootBindingId: string;
  rootRevision: number;
  conversationId: string;
  cwd: string;
  createdAt: number;
  lastUsedAt: number;
  closing?: boolean;
}

const fallbackHostSessions = new Map<string, HostSessionEntry>();

function hostSessionKey(principalId: string, projectId: string, rootBindingId: string, rootRevision: number, conversationId: string): string {
  return JSON.stringify([principalId, projectId, rootBindingId, rootRevision, conversationId]);
}

async function closeMatchingSessions(map: Map<string, HostSessionEntry>, matches: (entry: HostSessionEntry) => boolean): Promise<number> {
  const selected = [...map.entries()].filter(([, entry]) => matches(entry));
  // Mark every session before awaiting: none may accept more queued work.
  for (const [, entry] of selected) entry.closing = true;
  const results = await Promise.allSettled(selected.map(async ([key, entry]) => {
    await entry.shell.close();
    if (map.get(key) === entry) map.delete(key);
  }));
  const failure = results.find(result => result.status === 'rejected');
  if (failure?.status === 'rejected') throw failure.reason;
  return selected.length;
}

export function getOrCreateHostSession(
  runtime: WorkspaceRuntime | null,
  principalId: string,
  projectId: string,
  rootBindingId: string,
  rootRevision: number,
  conversationId: string,
  cwd: string
): PersistentShell {
  const map = runtime?.hostSessions ?? fallbackHostSessions;
  const key = hostSessionKey(principalId, projectId, rootBindingId, rootRevision, conversationId);
  const existing = map.get(key);
  if (existing) {
    if (existing.closing) throw new WorkspaceError('host_command_session_closing', 409);
    existing.lastUsedAt = Date.now();
    return existing.shell;
  }
  const shell = new PersistentShell(cwd);
  map.set(key, {
    shell,
    principalId,
    projectId,
    rootBindingId,
    rootRevision,
    conversationId,
    cwd,
    createdAt: Date.now(),
    lastUsedAt: Date.now(),
  });
  return shell;
}

export async function closeHostSession(
  runtime: WorkspaceRuntime | null,
  principalId: string,
  projectId: string,
  rootBindingId?: string,
  conversationId?: string
): Promise<boolean> {
  const map = runtime?.hostSessions ?? fallbackHostSessions;
  return (await closeMatchingSessions(map, entry => entry.principalId === principalId && entry.projectId === projectId
    && (!rootBindingId || entry.rootBindingId === rootBindingId)
    && (!conversationId || entry.conversationId === conversationId))) > 0;
}

export async function closeHostSessionsForRoot(runtime: WorkspaceRuntime | null, rootBindingId: string): Promise<number> {
  const map = runtime?.hostSessions ?? fallbackHostSessions;
  return closeMatchingSessions(map, entry => entry.rootBindingId === rootBindingId);
}

export async function closeAllHostSessions(runtime?: WorkspaceRuntime | null): Promise<void> {
  const map = runtime?.hostSessions ?? fallbackHostSessions;
  await closeMatchingSessions(map, () => true);
}

export async function prepareHostCommandPlan(runtime: WorkspaceRuntime, principal: string, projectId: string, input: unknown, signal: AbortSignal) {
  if (!isDataRecord(input)) throw new WorkspaceError('invalid_request');
  const allowedKeys = new Set(['command', 'expectedRevision', 'rootBindingId', 'timeoutMs', 'conversationId']);
  for (const k of Object.keys(input)) {
    if (!allowedKeys.has(k)) throw new WorkspaceError('invalid_request');
  }
  if (!Number.isSafeInteger(input.expectedRevision) || typeof input.rootBindingId !== 'string' || typeof input.command !== 'string') {
    throw new WorkspaceError('invalid_request');
  }
  if (input.timeoutMs !== undefined && (!Number.isSafeInteger(input.timeoutMs) || Number(input.timeoutMs) <= 0 || Number(input.timeoutMs) > 600_000)) {
    throw new WorkspaceError('invalid_request');
  }
  if (input.conversationId !== undefined && (typeof input.conversationId !== 'string' || input.conversationId.length > 256)) {
    throw new WorkspaceError('invalid_request');
  }

  const command = input.command.trim();
  if (!command || command.length > 4000) throw new WorkspaceError('command_invalid');
  const bundle = await runtime.store.getBundle(principal, projectId);
  const project = bundle.project;
  if (project.revision !== input.expectedRevision) throw new WorkspaceError('workspace_revision_conflict', 409);
  if (bundle.runs.some((item) => ['running', 'needs_attention', 'ready', 'awaiting_approval'].includes(item.run.status))) {
    throw new WorkspaceError('project_run_active', 409);
  }

  await runtime.projectRoot.ensureRootLoaded(input.rootBindingId, runtime.store, principal, projectId);
  const root = runtime.projectRoot.getVerifiedRoot(input.rootBindingId);
  if (root.binding.projectId !== projectId) throw new WorkspaceError('project_root_project_mismatch', 403);
  if (root.binding.revokedAt) throw new WorkspaceError('project_root_revoked', 403);
  if (root.binding.accessMode === 'read_only') throw new WorkspaceError('project_root_read_only', 403);

  const requestedTimeout = input.timeoutMs !== undefined
    ? Number(input.timeoutMs)
    : PROJECT_HOST_COMMAND_CAPABILITY.limits.timeoutMs;

  const snapshot = await runtime.store.snapshotContext(principal, projectId, {
    selectedEntryIds: [],
    selectedArtifactIds: [],
    excludedEntryIds: project.entries.map((e) => e.id),
    allowedDestinations: [PROJECT_HOST_COMMAND_CAPABILITY.dataDestination],
    maxContextBytes: 32000,
  });

  const conversationId = typeof input.conversationId === 'string' && input.conversationId ? input.conversationId : 'default';

  let plan: ExecutionPlan = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    projectId,
    projectRevision: project.revision,
    contextSnapshotId: snapshot.id,
    contextSnapshotDigest: createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),
    steps: [{
      id: 'host_command',
      capabilityId: PROJECT_HOST_COMMAND_CAPABILITY.id,
      capabilityVersion: 1,
      arguments: {
        root_binding_id: { kind: 'literal', value: input.rootBindingId },
        command: { kind: 'literal', value: command },
        conversation_id: { kind: 'literal', value: conversationId },
        objective: { kind: 'literal', value: `host: ${command.slice(0, 120)}` },
      },
    }],
    limits: {
      ...PROJECT_HOST_COMMAND_CAPABILITY.limits,
      timeoutMs: requestedTimeout,
    },
    digest: '0'.repeat(64),
  };
  plan = parseExecutionPlan({ ...plan, digest: computePlanDigest(plan) });
  validatePlanBindings(plan, snapshot, runtime.registry().forPlan(plan));
  await runtime.store.putPlan(principal, plan, snapshot);
  return runtime.viewPlan(principal, projectId, plan.id);
}

export async function dispatchHostCommand(runtime: WorkspaceRuntime, effect: EffectRequest): Promise<EffectOutcome> {
  const value = (key: string) => effect.arguments[key]?.kind === 'literal' ? effect.arguments[key].value : undefined;
  const rootBindingId = value('root_binding_id');
  const command = value('command');
  const conversationId = (typeof value('conversation_id') === 'string' ? value('conversation_id') : 'default') as string;
  if (typeof rootBindingId !== 'string' || typeof command !== 'string') {
    return { kind: 'not_sent', code: 'command_input_invalid' };
  }
  await runtime.projectRoot.ensureRootLoaded(rootBindingId, runtime.store, effect.principalId, effect.projectId);
  const root = runtime.projectRoot.getVerifiedRoot(rootBindingId);
  if (root.binding.projectId !== effect.projectId || root.binding.revokedAt || root.binding.accessMode === 'read_only') {
    return { kind: 'not_sent', code: 'project_root_unavailable' };
  }

  effect.signal.throwIfAborted();
  const start = Date.now();
  const timeoutMs = effect.limits.timeoutMs ?? 330_000;

  runtime.initRunOutput?.(effect.runId);

  const shell = getOrCreateHostSession(
    runtime,
    effect.principalId,
    effect.projectId,
    rootBindingId,
    root.binding.revision,
    conversationId,
    root.localPath
  );

  const outcome = await shell.runCommand(command, timeoutMs, effect.signal, {
    onChunk: (channel, chunk) => {
      runtime.pushRunOutput?.(effect.runId, channel, chunk);
    },
    revalidate: async () => {
      effect.signal.throwIfAborted();
      await runtime.projectRoot.ensureRootLoaded(rootBindingId, runtime.store, effect.principalId, effect.projectId);
      const recheck = runtime.projectRoot.getVerifiedRoot(rootBindingId);
      if (recheck.binding.projectId !== effect.projectId || recheck.binding.revision !== root.binding.revision
        || recheck.localPath !== root.localPath || recheck.binding.revokedAt || recheck.binding.accessMode === 'read_only') {
        throw new WorkspaceError('project_root_unavailable', 403);
      }
    },
  });

  const artifactId = randomUUID();
  const status = (outcome.exitCode !== 0 && outcome.exitCode !== null) ? 'failed' : outcome.status;
  const report = {
    command,
    exitCode: outcome.exitCode,
    stdout: outcome.stdout ?? outcome.output,
    stderr: outcome.stderr ?? '',
    output: outcome.output,
    status,
    durationMs: Date.now() - start,
    ...(outcome.error ? { error: outcome.error } : {}),
  };

  return {
    kind: 'completed',
    artifacts: [{
      artifactId,
      mediaType: 'application/json',
      bytes: new TextEncoder().encode(JSON.stringify(report)),
    }],
    outputArtifactRefs: [artifactId],
    sources: [],
  };
}
