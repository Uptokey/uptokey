import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport, type StdioServerParameters } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { ErrorCode, McpError } from '@modelcontextprotocol/sdk/types.js';
import { parseBrowserReadRequest, parseBrowserFillRequest } from '@uptokey/sync-contract/browser';

export interface BrowserReadRequest {
  url: string;
  signal: AbortSignal;
  deadlineAt: string;
  maxOutputBytes: number;
}
export interface WorkspaceBrowser {
  readonly allowedOrigin: string;
  readonly available?: boolean;
  readPage(request: BrowserReadRequest): Promise<string>;
  fillPage?(request: BrowserReadRequest & { fields: readonly { label: string; value: string }[] }): Promise<string>;
}
export interface McpWorkspaceBrowserOptions {
  /** Trusted composition only. This is a controlled fixture origin, not a network sandbox. */
  allowedOrigin: string;
  appRoot: string;
  stateRoot: string;
  browsersPath: string;
  executablePath: string;
  /** Tests can provide an SDK transport; the production default always uses SDK stdio. */
  transportFactory?: (parameters: StdioServerParameters) => Transport;
}

type FailureCode = 'browser_invalid_request' | 'browser_cancelled' | 'browser_deadline_exceeded' |
  'browser_operation_failed' | 'browser_output_limit' | 'browser_invalid_output' | 'browser_cleanup_failed';

export class BrowserReadError extends Error {
  readonly code: FailureCode;
  readonly sent: boolean;
  readonly outcome: 'not_sent' | 'unknown';
  constructor(code: FailureCode, sent: boolean) {
    super(code);
    this.name = 'BrowserReadError';
    this.code = code;
    this.sent = sent;
    this.outcome = sent ? 'unknown' : 'not_sent';
  }
}

const MAX_OUTPUT_BYTES = 1024 * 1024;
const MAX_DURATION_MS = 120_000;
// Closing a real Chromium context includes process/profile disposal. A 750ms
// cutoff could reject a completed read while that ordinary cleanup was pending.
const CLOSE_TOOL_MS = 5_000;
const CLOSE_TRANSPORT_MS = 5_000;
type CleanupFailure = { phase: 'close_tool' | 'close_transport' | 'remove_state'; reason: 'timeout' | 'failed'; elapsedMs: number };

/** One worker per read. No browser session, cookies, model, tool names or tool arguments come from the caller. */
export class McpWorkspaceBrowser implements WorkspaceBrowser {
  readonly allowedOrigin: string;
  private readonly options: McpWorkspaceBrowserOptions;
  constructor(options: McpWorkspaceBrowserOptions) {
    if (!/^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(options.allowedOrigin)) throw invalid();
    try { if (new URL(options.allowedOrigin).origin !== options.allowedOrigin) throw invalid(); } catch { throw invalid(); }
    for (const value of [options.appRoot, options.stateRoot, options.browsersPath, options.executablePath]) {
      if (!isAbsolute(value) || value.includes('\0') || resolve(value) === parse(value).root) throw invalid();
    }
    this.options = { ...options };
    this.allowedOrigin = options.allowedOrigin;
  }

  async readPage(request: BrowserReadRequest): Promise<string> {
    return this.operation(request);
  }

  async fillPage(request: BrowserReadRequest & { fields: readonly { label: string; value: string }[] }): Promise<string> {
    let parsed;
    try { parsed = parseBrowserFillRequest({ schemaVersion: 1, url: request.url, fields: request.fields }); } catch { throw invalid(); }
    const { fields: ignoredFields, ...base } = request;
    validateRequest(base, this.allowedOrigin);
    // Reuse the pinned Playwright serializer and parser; no caller can supply a selector.
    const { iso } = createRequire(import.meta.url)(join(this.options.appRoot, 'node_modules/playwright-core/lib/coreBundle.js'));
    const css = 'textarea, input:is([type="text"],[type="search"],[type="email"],[type="url"],[type="tel"],[type="number"],:not([type]))';
    const fields = parsed.fields.map(field => {
      const target = `internal:label=${iso.escapeForTextSelector(field.label, true)} >> internal:and=${JSON.stringify(css)}`;
      if (iso.locatorOrSelectorAsSelector('javascript', target) !== target) throw invalid();
      return { name: field.label, type: 'textbox', target, value: field.value };
    });
    return this.operation({ ...base, url: parsed.url }, fields);
  }

  private async operation(request: BrowserReadRequest, fields?: readonly Record<string, string>[]): Promise<string> {
    const deadline = validateRequest(request, this.options.allowedOrigin);
    request = { ...request };
    let sent = false;
    let callRoot: string | undefined;
    let transport: Transport | undefined;
    let backendReady = false;
    let result: string | undefined;
    let failure: BrowserReadError | undefined;
    const controller = new AbortController();
    const abort = () => controller.abort(new BrowserReadError('browser_cancelled', sent));
    const timer = setTimeout(() => controller.abort(new BrowserReadError('browser_deadline_exceeded', sent)), deadline - Date.now());
    request.signal.addEventListener('abort', abort, { once: true });
    if (request.signal.aborted) abort();
    const client = new Client({ name: 'quimera-browser-fixture', version: '1.0.0' }, { capabilities: {} });
    const assertLive = () => {
      if (controller.signal.aborted) throw controller.signal.reason;
      if (Date.now() >= deadline) throw new BrowserReadError('browser_deadline_exceeded', sent);
    };
    try {
      assertLive();
      await mkdir(this.options.stateRoot, { recursive: true });
      assertLive();
      callRoot = await mkdtemp(join(this.options.stateRoot, 'read-'));
      assertLive();
      const environment = browserEnvironment(callRoot, this.options.browsersPath);
      environment.UPTOKEY_BROWSER_ORIGIN = this.allowedOrigin;
      environment.UPTOKEY_BROWSER_TARGET_URL = request.url;
      environment.UPTOKEY_BROWSER_DEADLINE = String(deadline);
      environment.UPTOKEY_BROWSER_VERIFIED_DISPOSAL = '1';
      await Promise.all(['home', 'tmp', 'output', 'home/AppData/Roaming', 'home/AppData/Local', 'cache', 'config']
        .map(part => mkdir(join(callRoot!, part), { recursive: true })));
      assertLive();
      const configPath = join(callRoot, 'browser.config.json');
      await writeFile(configPath, JSON.stringify({ browser: { contextOptions: {
        acceptDownloads: false, serviceWorkers: 'block', javaScriptEnabled: false,
      } }, sharedBrowserContext: false }), { flag: 'wx' });
      assertLive();
      const parameters: StdioServerParameters = {
        command: process.execPath,
        args: [join(this.options.appRoot, 'cli.js'), '--isolated', '--headless', '--block-service-workers',
          '--browser', 'chromium', '--executable-path', this.options.executablePath,
          '--config', configPath,
          '--init-page', join(dirname(this.options.appRoot), 'init-page.cjs'),
          '--output-dir', join(callRoot, 'output'), '--timeout-navigation', String(Math.max(1, deadline - Date.now())),
          '--timeout-action', String(Math.max(1, deadline - Date.now()))],
        cwd: callRoot, env: environment, stderr: 'ignore',
        maxBufferSize: request.maxOutputBytes * 6 + 65_536,
      };
      transport = this.options.transportFactory?.(parameters) ?? new StdioClientTransport(parameters);
      await abortable(client.connect(transport, { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()) }), controller.signal);
      assertLive();
      // Once navigate may have entered the SDK, its remote result is uncertain on any failure.
      sent = true;
      const navigate = await abortable(client.callTool({ name: 'browser_navigate', arguments: { url: request.url } }, undefined,
        { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()), resetTimeoutOnProgress: false }), controller.signal);
      backendReady = navigate.isError !== true;
      assertLive();
      toolText(navigate, request.maxOutputBytes, false);
      if (fields) {
        const filled = await abortable(client.callTool({ name: 'browser_fill_form', arguments: { fields } }, undefined,
          { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()), resetTimeoutOnProgress: false }), controller.signal);
        assertLive();
        toolText(filled, request.maxOutputBytes, false);
      }
      const snapshot = await abortable(client.callTool({ name: 'browser_snapshot', arguments: {} }, undefined,
        { signal: controller.signal, timeout: Math.max(1, deadline - Date.now()), resetTimeoutOnProgress: false }), controller.signal);
      assertLive();
      result = toolText(snapshot, request.maxOutputBytes, true);
      // Pinned MCP response.ts renders this section before the page-controlled snapshot.
      // This is a final consistency check; request interception is enforced by init-page.
      if (result.match(/^### Page\r?\n- Page URL: ([^\r\n]+)\r?$/m)?.[1] !== request.url) {
        throw new BrowserReadError('browser_invalid_output', true);
      }
    } catch (error) {
      const reason = controller.signal.aborted ? controller.signal.reason :
        Date.now() >= deadline || error instanceof McpError && error.code === ErrorCode.RequestTimeout ?
          new BrowserReadError('browser_deadline_exceeded', sent) : error;
      failure = reason instanceof BrowserReadError ? new BrowserReadError(reason.code, sent) : new BrowserReadError('browser_operation_failed', sent);
    } finally {
      // The cleanup signal is independent: the operation's signal is often already aborted.
      let cleanupFailed = false;
      const cleanupFailures: CleanupFailure[] = [];
      const failedCleanup = (phase: CleanupFailure['phase'], error: unknown, started: number) => {
        cleanupFailed = true;
        cleanupFailures.push({ phase, reason: error instanceof McpError && error.code === ErrorCode.RequestTimeout ||
          error instanceof Error && error.message === 'browser_cleanup_timeout' ? 'timeout' : 'failed',
          elapsedMs: Math.max(0, Date.now() - started) });
      };
      // A failed lazy backend launch must not be retried by issuing another tool.
      // Pending/failed navigation is cancelled by SDK signal + transport EOF disposal.
      if (backendReady) {
        const started = Date.now();
        try {
          const closed = await within(client.callTool({ name: 'browser_close', arguments: {} }, undefined,
            { timeout: CLOSE_TOOL_MS, resetTimeoutOnProgress: false }), CLOSE_TOOL_MS);
          toolText(closed, 65_536, false);
          if (!['graceful_verified', 'forced_verified'].includes(String(closed._meta?.quimeraDisposal))) {
            throw new Error('browser_disposal_unverified');
          }
        } catch (error) { failedCleanup('close_tool', error, started); }
      }
      if (transport) {
        const started = Date.now();
        try { await within(client.close(), CLOSE_TRANSPORT_MS); } catch (error) { failedCleanup('close_transport', error, started); }
      }
      if (callRoot && !cleanupFailed) {
        const started = Date.now();
        try {
          // Delete only the unique directory this invocation created, within the configured root.
          const part = relative(resolve(this.options.stateRoot), resolve(callRoot));
          if (!part || part.startsWith(`..${sep}`) || part === '..' || isAbsolute(part)) throw invalid();
          await rm(callRoot, { recursive: true, force: true });
        } catch (error) { failedCleanup('remove_state', error, started); }
      }
      if (callRoot && cleanupFailed) {
        // Best-effort evidence in the already retained invocation directory.
        // Never include page text, URLs, environment, remote errors or stacks.
        try {
          await writeFile(join(callRoot, 'cleanup-failure.json'), JSON.stringify({ schemaVersion: 1,
            closeToolTimeoutMs: CLOSE_TOOL_MS, closeTransportTimeoutMs: CLOSE_TRANSPORT_MS, failures: cleanupFailures }), { flag: 'wx' });
        } catch { /* The original cleanup failure remains authoritative. */ }
      }
      clearTimeout(timer);
      request.signal.removeEventListener('abort', abort);
      if (!failure && controller.signal.aborted) failure = new BrowserReadError(controller.signal.reason.code, sent);
      if (cleanupFailed && !failure) failure = new BrowserReadError('browser_cleanup_failed', sent);
    }
    if (failure) throw failure;
    return result!;
  }
}

function invalid(): BrowserReadError { return new BrowserReadError('browser_invalid_request', false); }
function validateRequest(input: BrowserReadRequest, origin: string): number {
  if (!input || Object.keys(input).some(key => !['url', 'signal', 'deadlineAt', 'maxOutputBytes'].includes(key)) ||
    !(input.signal instanceof AbortSignal) || typeof input.url !== 'string' || input.url.length > 2048 ||
    !Number.isSafeInteger(input.maxOutputBytes) || input.maxOutputBytes < 1 || input.maxOutputBytes > MAX_OUTPUT_BYTES ||
    typeof input.deadlineAt !== 'string') throw invalid();
  try { parseBrowserReadRequest({ schemaVersion: 1, url: input.url }); } catch { throw invalid(); }
  if (new URL(input.url).origin !== origin) throw invalid();
  const deadline = Date.parse(input.deadlineAt);
  if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== input.deadlineAt || deadline - Date.now() > MAX_DURATION_MS) throw invalid();
  if (deadline <= Date.now()) throw new BrowserReadError('browser_deadline_exceeded', false);
  return deadline;
}

function browserEnvironment(callRoot: string, browsersPath: string): Record<string, string> {
  // SDK stdio merges getDefaultEnvironment() first; clear every inherited name explicitly.
  const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
  const home = join(callRoot, 'home');
  const systemRoot = process.platform === 'win32' ? process.env.SystemRoot ?? process.env.SYSTEMROOT : undefined;
  Object.assign(env, {
    HOME: home, USERPROFILE: home, HOMEDRIVE: parse(home).root.replace(/[\\/]$/, ''), HOMEPATH: home.slice(parse(home).root.length - 1),
    APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TMP: join(callRoot, 'tmp'), TEMP: join(callRoot, 'tmp'), TMPDIR: join(callRoot, 'tmp'),
    XDG_CACHE_HOME: join(callRoot, 'cache'), XDG_CONFIG_HOME: join(callRoot, 'config'),
    PATH: dirname(process.execPath), USER: 'quimera', USERNAME: 'quimera', LOGNAME: 'quimera',
    PLAYWRIGHT_BROWSERS_PATH: browsersPath, PLAYWRIGHT_SKIP_BROWSER_DOWNLOAD: '1',
    NODE_ENV: 'production',
  });
  if (systemRoot && isAbsolute(systemRoot)) {
    env.SYSTEMROOT = systemRoot;
    env.SystemRoot = systemRoot;
    env.SYSTEMDRIVE = parse(systemRoot).root.replace(/[\\/]$/, '');
    env.PATH += `;${join(systemRoot, 'System32')}`;
  }
  return env;
}

function toolText(value: unknown, maxBytes: number, required: boolean): string {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new BrowserReadError('browser_invalid_output', true);
  const result = value as { isError?: unknown; content?: unknown };
  if (result.isError === true) throw new BrowserReadError('browser_operation_failed', true);
  if (!Array.isArray(result.content) || result.content.some(item => !item || item.type !== 'text' || typeof item.text !== 'string')) {
    throw new BrowserReadError('browser_invalid_output', true);
  }
  const text = result.content.map(item => item.text as string).join('\n');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new BrowserReadError('browser_output_limit', true);
  if (required && !text.trim()) throw new BrowserReadError('browser_invalid_output', true);
  return text;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) { void promise.catch(() => {}); return Promise.reject(signal.reason); }
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}
function within<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('browser_cleanup_timeout')), timeoutMs);
    promise.then(resolve, reject).finally(() => clearTimeout(timer));
  });
}
