import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, realpath } from 'node:fs/promises';
import { isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { DEFAULT_INHERITED_ENV_VARS, StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { FILESYSTEM_TEXT_MAX_LINES, type FilesystemDiagnostic } from '@uptokey/sync-contract/filesystem';

const VERSION = '2026.8.31';
const TOOLS = ['list_directory', 'get_file_info', 'read_text_file'] as const;
type ReadTool = typeof TOOLS[number];
/**
 * Uptokey, not the server, decides what each admitted tool may receive. Upstream annotations
 * such as readOnlyHint are untrusted and never widen this list. `tail` is advertised upstream
 * for read_text_file but is never sent: it reads the whole file before returning a window.
 */
const ADMITTED_INPUT: Record<ReadTool, readonly string[]> = {
  list_directory: ['path'], get_file_info: ['path'], read_text_file: ['head', 'path', 'tail'],
};
export interface FilesystemToolDescription { name: ReadTool; inputSchema: Record<string, unknown>; outputSchema?: Record<string, unknown>; digest: string }
export interface FilesystemMcpOptions {
  /** Trusted local composition. Never populated from a model or an HTTP body. */
  packageRoot: string;
  allowedRoot: string;
  stateRoot: string;
}
export interface FilesystemReadOperation {
  tool: ReadTool;
  relativePath: string;
  /** Required for read_text_file (first N lines); refused for other tools. */
  lineLimit?: number;
  schemaDigest: string;
  profileDigest: string;
  signal: AbortSignal;
  deadlineAt: string;
  maxOutputBytes: number;
}
export class FilesystemMcpError extends Error {
  readonly outcome: 'not_sent' | 'unknown';
  constructor(code: string, sent: boolean) {
    super(code); this.name = 'FilesystemMcpError'; this.outcome = sent ? 'unknown' : 'not_sent';
  }
}
const DISCOVERY_CODES: readonly string[] = ['mcp_config_invalid', 'mcp_package_invalid', 'mcp_discovery_invalid', 'mcp_tool_missing', 'mcp_schema_unexpected'];
/** Stable operator diagnostic for a failed explicit discovery; never a path or upstream message. */
export function filesystemDiagnostic(error: unknown): FilesystemDiagnostic {
  if (!(error instanceof FilesystemMcpError)) return 'mcp_discovery_failed';
  if (['mcp_link_denied', 'mcp_path_denied'].includes(error.message)) return 'mcp_config_invalid';
  return (DISCOVERY_CODES.includes(error.message) ? error.message : 'mcp_discovery_failed') as FilesystemDiagnostic;
}

/** Read-only effect port, not an authority to approve effects. No automatic retries. */
export class FilesystemMcpService {
  private readonly options: FilesystemMcpOptions;
  constructor(options: FilesystemMcpOptions) {
    for (const path of Object.values(options)) {
      if (!isAbsolute(path) || resolve(path) === parse(path).root || path.includes('\0')) throw new FilesystemMcpError('mcp_config_invalid', false);
    }
    this.options = { ...options };
  }

  /** Explicit discovery starts upstream; plan preparation must not call this implicitly. */
  async discover(signal: AbortSignal, deadlineAt: string) {
    return this.session(signal, deadlineAt, async (client, options, profileDigest) => {
      const tools = await this.schemas(client, options);
      return { profileDigest, tools };
    });
  }

  async read(operation: FilesystemReadOperation): Promise<string> {
    const request = { ...operation };
    const text = request.tool === 'read_text_file';
    if (!TOOLS.includes(request.tool) || !/^[a-f0-9]{64}$/.test(request.schemaDigest) ||
        !/^[a-f0-9]{64}$/.test(request.profileDigest) || !Number.isSafeInteger(request.maxOutputBytes) ||
        request.maxOutputBytes < 1 || request.maxOutputBytes > 1024 * 1024 ||
        (text ? !Number.isSafeInteger(request.lineLimit) || request.lineLimit! < 1 || request.lineLimit! > FILESYSTEM_TEXT_MAX_LINES
          : request.lineLimit !== undefined)) throw new FilesystemMcpError('mcp_request_invalid', false);
    // No absolute paths, alternate data streams, traversal or ambiguous Windows names.
    if (typeof request.relativePath !== 'string' || request.relativePath.length > 2048 ||
        (request.relativePath !== '.' && request.relativePath.split(/[\\/]/).some(part =>
          !part || part === '.' || part === '..' || /[\x00-\x1f:<>"|?*]/.test(part) || /[. ]$/.test(part)))) {
      throw new FilesystemMcpError('mcp_path_denied', false);
    }
    const target = resolve(this.options.allowedRoot, request.relativePath);
    if (!inside(this.options.allowedRoot, target)) throw new FilesystemMcpError('mcp_path_denied', false);
    let sent = false;
    try {
      await checkedPath(this.options.allowedRoot);
      await checkedPath(target);
      return await this.session(request.signal, request.deadlineAt, async (client, options, profileDigest) => {
        if (profileDigest !== request.profileDigest) throw new FilesystemMcpError('mcp_profile_changed', false);
        const tools = await this.schemas(client, options);
        const tool = tools.find(tool => tool.name === request.tool);
        if (tool?.digest !== request.schemaDigest) throw new FilesystemMcpError('mcp_schema_changed', false);
        await checkedPath(target);
        request.signal.throwIfAborted();
        options.signal.throwIfAborted();
        sent = true;
        const result = await client.callTool({ name: request.tool, arguments: text ? { path: target, head: request.lineLimit } : { path: target } }, undefined, options);
        options.signal.throwIfAborted();
        if (result.isError || !Array.isArray(result.content) || result.content.some(item => item.type !== 'text' || typeof item.text !== 'string')) {
          throw new FilesystemMcpError('mcp_tool_failed', true);
        }
        const output = result.content.map(item => (item as { text: string }).text).join('\n');
        // Structured output must be exactly the admitted shape and agree with the text channel.
        if (tool.outputSchema !== undefined || result.structuredContent !== undefined) {
          const structured = result.structuredContent as Record<string, unknown> | undefined;
          if (!structured || typeof structured !== 'object' || Array.isArray(structured) || Object.keys(structured).join(',') !== 'content' ||
              structured.content !== output) throw new FilesystemMcpError('mcp_output_invalid', true);
        }
        if (Buffer.byteLength(output) > request.maxOutputBytes) throw new FilesystemMcpError('mcp_output_limit', true);
        return output;
      });
    } catch (error) {
      if (error instanceof FilesystemMcpError) throw error;
      throw new FilesystemMcpError('mcp_operation_failed', sent);
    }
  }

  private async schemas(client: Client, options: { signal: AbortSignal; timeout: number; resetTimeoutOnProgress: boolean }): Promise<FilesystemToolDescription[]> {
    // One page only: a cursor is refused rather than followed, so discovery cannot loop.
    const result = await client.listTools({}, options);
    if (result.nextCursor !== undefined || result.tools.length > 64 || new Set(result.tools.map(tool => tool.name)).size !== result.tools.length) {
      throw new FilesystemMcpError('mcp_discovery_invalid', false);
    }
    return TOOLS.map(name => {
      const tool = result.tools.find(tool => tool.name === name);
      if (!tool) throw new FilesystemMcpError('mcp_tool_missing', false);
      const inputSchema = tool.inputSchema as Record<string, unknown>;
      const properties = inputSchema.properties as Record<string, { type?: unknown }> | undefined;
      if (inputSchema.type !== 'object' || !properties || typeof properties !== 'object' ||
          Object.keys(properties).sort().join(',') !== ADMITTED_INPUT[name].join(',') || properties.path?.type !== 'string' ||
          (name === 'read_text_file' && properties.head?.type !== 'number')) throw new FilesystemMcpError('mcp_schema_unexpected', false);
      const outputSchema = tool.outputSchema as Record<string, unknown> | undefined;
      if (outputSchema !== undefined) {
        const out = outputSchema.properties as Record<string, { type?: unknown }> | undefined;
        if (!out || Object.keys(out).join(',') !== 'content' || out.content?.type !== 'string') throw new FilesystemMcpError('mcp_schema_unexpected', false);
      }
      // Digest without an output schema stays identical to the first profile revision.
      return outputSchema === undefined ? { name, inputSchema, digest: hash({ name, inputSchema }) }
        : { name, inputSchema, outputSchema, digest: hash({ name, inputSchema, outputSchema }) };
    });
  }

  private async session<T>(signal: AbortSignal, deadlineAt: string,
    task: (client: Client, options: { signal: AbortSignal; timeout: number; resetTimeoutOnProgress: boolean }, profileDigest: string) => Promise<T>): Promise<T> {
    const deadline = Date.parse(deadlineAt);
    if (!Number.isFinite(deadline) || new Date(deadline).toISOString() !== deadlineAt || deadline <= Date.now() || deadline - Date.now() > 120_000) {
      throw new FilesystemMcpError('mcp_deadline_invalid', false);
    }
    signal.throwIfAborted();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), deadline - Date.now());
    const combined = AbortSignal.any([signal, controller.signal]);
    const client = new Client({ name: 'quimera-filesystem', version: '1.0.0' }, { capabilities: {} });
    // Output flood, malformed stdout or a closed pipe fails the pending request now instead of at the deadline.
    client.onerror = () => controller.abort();
    client.onclose = () => controller.abort();
    try {
      await checkedPath(this.options.packageRoot);
      await checkedPath(this.options.allowedRoot);
      const manifest = JSON.parse(await readFile(join(this.options.packageRoot, 'package.json'), 'utf8'));
      if (manifest.name !== '@modelcontextprotocol/server-filesystem' || manifest.version !== VERSION) throw new FilesystemMcpError('mcp_package_invalid', false);
      const entry = join(this.options.packageRoot, 'dist/index.js');
      await checkedPath(entry);
      const profileDigest = hash({ version: VERSION, root: await realpath(this.options.allowedRoot), entryHash: createHash('sha256').update(await readFile(entry)).digest('hex') });
      await mkdir(this.options.stateRoot, { recursive: true });
      await checkedPath(this.options.stateRoot);
      const state = await mkdtemp(join(this.options.stateRoot, 'mcp-'));
      const env = Object.fromEntries(DEFAULT_INHERITED_ENV_VARS.map(key => [key, '']));
      for (const key of ['SystemRoot', 'SYSTEMROOT', 'WINDIR']) if (process.env[key]) env[key] = process.env[key]!;
      for (const key of ['HOME', 'USERPROFILE', 'TMP', 'TEMP', 'APPDATA', 'LOCALAPPDATA', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME']) env[key] = state;
      combined.throwIfAborted();
      const options = { signal: combined, timeout: Math.max(1, deadline - Date.now()), resetTimeoutOnProgress: false };
      await client.connect(new StdioClientTransport({ command: process.execPath, args: [entry, this.options.allowedRoot], cwd: state, env, stderr: 'ignore', maxBufferSize: 2 * 1024 * 1024 }), options);
      combined.throwIfAborted();
      return await task(client, options, profileDigest);
    } finally {
      clearTimeout(timer);
      client.onclose = undefined;
      await client.close();
    }
  }
}

function hash(value: unknown) { return createHash('sha256').update(canonicalJson(value)).digest('hex'); }
function inside(root: string, path: string) { const part = relative(resolve(root), path); return part === '' || (!isAbsolute(part) && part !== '..' && !part.startsWith(`..${sep}`)); }
async function checkedPath(path: string) {
  const absolute = resolve(path);
  let current = parse(absolute).root;
  for (const part of relative(current, absolute).split(sep).filter(Boolean)) {
    current = join(current, part);
    if ((await lstat(current)).isSymbolicLink()) throw new FilesystemMcpError('mcp_link_denied', false);
  }
  if (relative(absolute, await realpath(absolute)) !== '') throw new FilesystemMcpError('mcp_path_denied', false);
}
