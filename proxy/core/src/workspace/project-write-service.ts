import type { WorkspaceStore, StoredWriteIntent, StoredProjectWriteReceipt } from './store.ts';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeRelativePath,
  computeProjectChangeSetDigest,
  parseProjectChangeSet,
  parseProjectFileManifest,
  type ProjectChangeOperationType,
  type ProjectChangeSet,
  type ProjectFileManifest,
  type ProjectFileManifestEntry
} from '@uptokey/sync-contract/project-agent';
import { ProjectRootService, ProjectRootError, isProtectedProjectPath } from './project-root-service.ts';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { sharedSinkAuthority, type SinkAccessPolicy } from './sink-authority.ts';

export class ProjectWriteError extends Error {
  readonly status: number;
  readonly details?: unknown;
  constructor(message: string, status: number = 400, details?: unknown) {
    super(message);
    this.status = status;
    this.details = details;
    this.name = 'ProjectWriteError';
  }
}

export interface AppliedWriteReceipt extends StoredProjectWriteReceipt {}

export interface RestoreReceipt {
  readonly operationId: string;
  readonly restoredAt: string;
  readonly restoredPaths: readonly string[];
  readonly skippedPaths: readonly string[];
}

export interface WriteIntentRecord {
  readonly operationId: string;
  readonly rootBindingId: string;
  readonly changeSet: ProjectChangeSet;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'needs_attention';
  readonly preimagesDir: string;
  readonly createdAt: string;
  readonly confirmedPaths: string[];
}

export interface ProjectFileRead {
  readonly relativePath: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly mediaType: string;
  readonly language?: string;
  readonly text: string;
}

export interface ProjectFileRangeRead extends Omit<ProjectFileRead, 'sha256'> {
  /** Full-file digest only when every byte was read and the identity revalidated. */
  readonly sha256: string | null;
  readonly rangeSha256: string;
  readonly rangeByteLength: number;
  readonly startLine: number;
  readonly endLine: number;
  readonly totalLines: number | null;
  readonly nextLine: number | null;
  readonly scannedBytes: number;
}

export interface ProjectDirectoryPage {
  readonly relativePath: string;
  readonly entries: readonly { relativePath: string; kind: 'file' | 'directory'; byteLength: number }[];
  /** Native directory offset, including omitted protected or inaccessible children. */
  readonly nextOffset: number | null;
}

export type ProjectPreflightStatus = 'create' | 'replace' | 'unchanged' | 'conflict' | 'missing' | 'blocked';

export interface ProjectPreflightEntry {
  readonly path: string;
  readonly operation: ProjectChangeOperationType;
  readonly status: ProjectPreflightStatus;
  readonly baseSha256: string | null;
  readonly expectedSha256: string | null;
  readonly newSha256: string | null;
  readonly byteLength: number | null;
}

export interface ProjectChangePreflight {
  readonly changeSetId: string;
  readonly rootBindingId: string;
  readonly ok: boolean;
  readonly entries: readonly ProjectPreflightEntry[];
  readonly issues: readonly { path: string; code: string }[];
}

export interface ProjectWriteRecoveryEntry {
  readonly path: string;
  readonly type: ProjectChangeOperationType;
  readonly state: 'pending' | 'already_present' | 'conflict';
  readonly observedSha256: string | null;
  readonly sourceSha256?: string | null;
}

export interface ProjectWriteRecoveryReview {
  readonly operationId: string;
  readonly rootBindingId: string;
  readonly changeSetDigest: string;
  readonly digest: string;
  readonly entries: readonly ProjectWriteRecoveryEntry[];
  /** Null when there are conflicts or no pending effects; inspect entries to distinguish. */
  readonly residualChangeSet: ProjectChangeSet | null;
}

const SENSITIVE_FILENAMES = new Set(['.env', '.env.local', '.env.production', '.env.development', '.npmrc', '.yarnrc', '.tfvars']);

/** Conservative text allowlist for reading a project file into conversation context. */
const TEXT_MEDIA_TYPES: Record<string, { mediaType: string; language?: string }> = {
  '.md': { mediaType: 'text/markdown', language: 'markdown' },
  '.markdown': { mediaType: 'text/markdown', language: 'markdown' },
  '.txt': { mediaType: 'text/plain' },
  '.json': { mediaType: 'application/json', language: 'json' },
  '.jsonc': { mediaType: 'application/json', language: 'json' },
  '.html': { mediaType: 'text/html', language: 'html' },
  '.htm': { mediaType: 'text/html', language: 'html' },
  '.css': { mediaType: 'text/css', language: 'css' },
  '.js': { mediaType: 'application/javascript', language: 'javascript' },
  '.mjs': { mediaType: 'application/javascript', language: 'javascript' },
  '.cjs': { mediaType: 'application/javascript', language: 'javascript' },
  '.ts': { mediaType: 'application/typescript', language: 'typescript' },
  '.tsx': { mediaType: 'application/typescript', language: 'typescript' },
  '.jsx': { mediaType: 'application/javascript', language: 'javascript' },
  '.py': { mediaType: 'text/x-python', language: 'python' },
  '.sh': { mediaType: 'text/x-shellscript', language: 'shell' },
  '.yml': { mediaType: 'text/yaml', language: 'yaml' },
  '.yaml': { mediaType: 'text/yaml', language: 'yaml' },
  '.csv': { mediaType: 'text/csv', language: 'csv' },
  '.svg': { mediaType: 'image/svg+xml', language: 'xml' },
  '.xml': { mediaType: 'text/xml', language: 'xml' },
  '.sql': { mediaType: 'text/x-sql', language: 'sql' },
  '.ini': { mediaType: 'text/plain', language: 'ini' },
  '.toml': { mediaType: 'text/plain', language: 'toml' },
  '.env.example': { mediaType: 'text/plain', language: 'dotenv' },
  '.gitignore': { mediaType: 'text/plain', language: 'gitignore' },
  '.dockerignore': { mediaType: 'text/plain', language: 'gitignore' },
  // Source code commonly edited through the terminal client. Text detection
  // (NUL bytes refused, bounded size) and protected-path rules still apply.
  '.go': { mediaType: 'text/plain', language: 'go' },
  '.rs': { mediaType: 'text/plain', language: 'rust' },
  '.java': { mediaType: 'text/plain', language: 'java' },
  '.kt': { mediaType: 'text/plain', language: 'kotlin' },
  '.kts': { mediaType: 'text/plain', language: 'kotlin' },
  '.scala': { mediaType: 'text/plain', language: 'scala' },
  '.groovy': { mediaType: 'text/plain', language: 'groovy' },
  '.gradle': { mediaType: 'text/plain', language: 'groovy' },
  '.c': { mediaType: 'text/plain', language: 'c' },
  '.h': { mediaType: 'text/plain', language: 'c' },
  '.cc': { mediaType: 'text/plain', language: 'cpp' },
  '.cpp': { mediaType: 'text/plain', language: 'cpp' },
  '.cxx': { mediaType: 'text/plain', language: 'cpp' },
  '.hpp': { mediaType: 'text/plain', language: 'cpp' },
  '.cs': { mediaType: 'text/plain', language: 'csharp' },
  '.fs': { mediaType: 'text/plain', language: 'fsharp' },
  '.rb': { mediaType: 'text/plain', language: 'ruby' },
  '.php': { mediaType: 'text/plain', language: 'php' },
  '.swift': { mediaType: 'text/plain', language: 'swift' },
  '.m': { mediaType: 'text/plain', language: 'objective-c' },
  '.lua': { mediaType: 'text/plain', language: 'lua' },
  '.pl': { mediaType: 'text/plain', language: 'perl' },
  '.r': { mediaType: 'text/plain', language: 'r' },
  '.dart': { mediaType: 'text/plain', language: 'dart' },
  '.ex': { mediaType: 'text/plain', language: 'elixir' },
  '.exs': { mediaType: 'text/plain', language: 'elixir' },
  '.erl': { mediaType: 'text/plain', language: 'erlang' },
  '.hs': { mediaType: 'text/plain', language: 'haskell' },
  '.ml': { mediaType: 'text/plain', language: 'ocaml' },
  '.clj': { mediaType: 'text/plain', language: 'clojure' },
  '.elm': { mediaType: 'text/plain', language: 'elm' },
  '.zig': { mediaType: 'text/plain', language: 'zig' },
  '.nim': { mediaType: 'text/plain', language: 'nim' },
  '.jl': { mediaType: 'text/plain', language: 'julia' },
  '.sol': { mediaType: 'text/plain', language: 'solidity' },
  '.vue': { mediaType: 'text/plain', language: 'vue' },
  '.svelte': { mediaType: 'text/plain', language: 'svelte' },
  '.astro': { mediaType: 'text/plain', language: 'astro' },
  '.scss': { mediaType: 'text/css', language: 'scss' },
  '.sass': { mediaType: 'text/css', language: 'sass' },
  '.less': { mediaType: 'text/css', language: 'less' },
  '.graphql': { mediaType: 'text/plain', language: 'graphql' },
  '.gql': { mediaType: 'text/plain', language: 'graphql' },
  '.proto': { mediaType: 'text/plain', language: 'protobuf' },
  '.tf': { mediaType: 'text/plain', language: 'hcl' },
  '.hcl': { mediaType: 'text/plain', language: 'hcl' },
  '.ps1': { mediaType: 'text/plain', language: 'powershell' },
  '.psm1': { mediaType: 'text/plain', language: 'powershell' },
  '.bat': { mediaType: 'text/plain', language: 'bat' },
  '.cmd': { mediaType: 'text/plain', language: 'bat' },
  '.zsh': { mediaType: 'text/x-shellscript', language: 'shell' },
  '.bash': { mediaType: 'text/x-shellscript', language: 'shell' },
  '.fish': { mediaType: 'text/plain', language: 'fish' },
  '.mdx': { mediaType: 'text/markdown', language: 'mdx' },
  '.rst': { mediaType: 'text/plain', language: 'rst' },
  '.tex': { mediaType: 'text/plain', language: 'latex' },
  '.properties': { mediaType: 'text/plain', language: 'properties' },
  '.cfg': { mediaType: 'text/plain', language: 'ini' },
  '.conf': { mediaType: 'text/plain', language: 'ini' },
  'makefile': { mediaType: 'text/plain', language: 'makefile' },
  'dockerfile': { mediaType: 'text/plain', language: 'dockerfile' },
  'justfile': { mediaType: 'text/plain', language: 'makefile' },
  'gemfile': { mediaType: 'text/plain', language: 'ruby' },
  'rakefile': { mediaType: 'text/plain', language: 'ruby' },
  'procfile': { mediaType: 'text/plain' },
  'license': { mediaType: 'text/plain' },
  'readme': { mediaType: 'text/plain' }
};

const DEFAULT_FILE_READ_MAX_BYTES = 256 * 1024;

export class ProjectWriteService {
  private readonly intents = new Map<string, WriteIntentRecord>();
  private readonly rootService: ProjectRootService;
  private readonly stagingBaseDir: string;
  private readonly sinkPolicy: SinkAccessPolicy;

  constructor(rootService: ProjectRootService, stagingBaseDir?: string, options?: { sinkPolicy?: SinkAccessPolicy }) {
    this.rootService = rootService;
    this.stagingBaseDir = stagingBaseDir || path.resolve(process.cwd(), 'output', 'project-staging');
    this.sinkPolicy = options?.sinkPolicy ?? sharedSinkAuthority();
  }

  computeFileSha256(filePath: string): string {
    // Used as an authorization/conflict precondition: size and mtime can be
    // preserved by editors or restored tools and cannot authenticate bytes.
    return createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
  }

  async readProjectMedia(projectId: string, rootBindingId: string, relativePath: string, signal?: AbortSignal, maxBytes: number = 32 * 1024 * 1024): Promise<{ byteLength: number; bytes: Buffer; mediaType: string }> {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.projectId !== projectId) throw new ProjectWriteError('project_root_mismatch', 403);
    if (isProtectedProjectPath(relativePath)) throw new ProjectWriteError('project_path_protected', 403);
    const absFile = this.rootService.resolveVerifiedPath(rootBindingId, relativePath);

    const fsp = await import('node:fs/promises');
    let fd: import('node:fs/promises').FileHandle | undefined;
    try {
      fd = await fsp.open(absFile, 'r');
      const stat = await fd.stat();
      if (!stat.isFile()) throw new ProjectWriteError('project_file_not_regular', 400);

      const extension = path.extname(relativePath).toLowerCase().slice(1);
      const mediaType = ({ mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", webm: "audio/webm", m4a: "audio/mp4", mp4: "audio/mp4", png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", webp: "image/webp" } as const)[extension as "mp3"] || "application/octet-stream";

      const chunks: Buffer[] = [];
      let totalRead = 0;
      let position = 0;
      const buf = Buffer.alloc(64 * 1024);
      while (true) {
        if (signal?.aborted) throw new Error("AbortError");
        const { bytesRead } = await fd.read(buf, 0, buf.length, position);
        if (bytesRead === 0) break;
        totalRead += bytesRead;
        if (totalRead > maxBytes) throw new ProjectWriteError('project_file_too_large', 413, { byteLength: totalRead, maxBytes });
        chunks.push(Buffer.from(buf.subarray(0, bytesRead)));
        position += bytesRead;
      }
      const bytes = Buffer.concat(chunks);
      
      const afterStat = await fsp.stat(absFile);
      if (afterStat.ino !== stat.ino || afterStat.mtimeMs !== stat.mtimeMs || afterStat.size !== bytes.byteLength) {
        throw new ProjectWriteError('project_file_changed', 409);
      }

      return { byteLength: bytes.byteLength, bytes, mediaType };
    } catch (e: any) {
      if (e instanceof ProjectWriteError) throw e;
      throw new ProjectWriteError('project_file_not_found', 404);
    } finally {
      if (fd !== undefined) await fd.close();
    }
  }

  /** Bounded text read of one file inside an authorized root. Never returns secrets,
   * never follows links and never accepts an absolute path from the caller. */
  readProjectFile(rootBindingId: string, relativePath: string, maxBytes: number = DEFAULT_FILE_READ_MAX_BYTES): ProjectFileRead {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (isProtectedProjectPath(relativePath)) throw new ProjectWriteError('project_path_protected', 403);
    const absFile = this.rootService.resolveVerifiedPath(rootBindingId, relativePath);

    let fd: number | undefined;
    let bytes: Buffer;
    let meta: { mediaType: string, language?: string };
    
    try {
      fd = fs.openSync(absFile, 'r');
      const stat = fs.fstatSync(fd);
      if (!stat.isFile()) throw new ProjectWriteError('project_file_not_regular', 400);
      if (stat.size > maxBytes) throw new ProjectWriteError('project_file_too_large', 413, { byteLength: stat.size, maxBytes });

      const base = path.basename(relativePath).toLowerCase();
      const ext = path.extname(base);
      meta = TEXT_MEDIA_TYPES[base] ?? TEXT_MEDIA_TYPES[ext] ?? { mediaType: 'text/plain' };
      if (!meta) throw new ProjectWriteError('project_file_not_text', 415);

      bytes = Buffer.alloc(stat.size);
      let bytesRead = 0;
      while (bytesRead < stat.size) {
        const read = fs.readSync(fd, bytes, bytesRead, stat.size - bytesRead, bytesRead);
        if (read === 0) break;
        bytesRead += read;
      }
      if (bytesRead !== stat.size) throw new ProjectWriteError('project_file_changed', 409);

      const afterStat = fs.fstatSync(fd);
      if (afterStat.mtimeMs !== stat.mtimeMs || afterStat.size !== stat.size) throw new ProjectWriteError('project_file_changed', 409);
    } catch (e: any) {
      if (e instanceof ProjectWriteError) throw e;
      throw new ProjectWriteError('project_file_not_found', 404);
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
    }

    // A declared text extension can still hold binary bytes; refuse instead of decoding garbage.
    if (bytes.includes(0)) throw new ProjectWriteError('project_file_not_text', 415);
    const text = bytes.toString('utf8');
    return {
      relativePath,
      byteLength: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      mediaType: meta.mediaType,
      ...(meta.language ? { language: meta.language } : {}),
      text
    };
  }

  /** Bounded text range: streams the prefix, publishes only selected lines. */
  async readProjectFileRange(rootBindingId: string, relativePath: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<ProjectFileRangeRead> {
    if (!Number.isSafeInteger(startLine) || !Number.isSafeInteger(endLine) || startLine < 1 || endLine < startLine
      || endLine > 1_000_000 || endLine - startLine > 1999) throw new ProjectWriteError('project_file_range_invalid');
    signal?.throwIfAborted();
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (isProtectedProjectPath(relativePath)) throw new ProjectWriteError('project_path_protected', 403);
    const absolute = this.rootService.resolveVerifiedPath(rootBindingId, relativePath);
    const base = path.basename(relativePath).toLowerCase();
    const meta = TEXT_MEDIA_TYPES[base] ?? TEXT_MEDIA_TYPES[path.extname(base)];
    if (!meta) throw new ProjectWriteError('project_file_not_text', 415);
    let observed: fs.Stats;
    try { observed = await fs.promises.lstat(absolute); }
    catch (error) { throw new ProjectWriteError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'project_file_not_found' : 'project_file_unreadable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 403); }
    if (!observed.isFile() || observed.isSymbolicLink() || observed.nlink > 1) throw new ProjectWriteError('project_file_not_regular');
    const sameFile = (value: fs.Stats) => value.isFile() && !value.isSymbolicLink() && value.nlink === 1
      && value.dev === observed.dev && value.ino === observed.ino && value.birthtimeMs === observed.birthtimeMs
      && value.size === observed.size && value.mtimeMs === observed.mtimeMs && value.ctimeMs === observed.ctimeMs;
    const verifyRoot = () => {
      signal?.throwIfAborted();
      const verified = this.rootService.getVerifiedRoot(rootBindingId);
      if (verified.binding.revision !== root.binding.revision || verified.binding.rootIdentityDigest !== root.binding.rootIdentityDigest)
        throw new ProjectWriteError('project_root_identity_changed', 409);
      this.rootService.resolveVerifiedPath(rootBindingId, relativePath);
    };
    verifyRoot();
    const handle = await fs.promises.open(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    let scannedBytes = 0, line = 1, resultBytes = 0;
    const chunks: Buffer[] = [], digest = createHash('sha256');
    try {
      verifyRoot();
      if (!sameFile(await handle.stat())) throw new ProjectWriteError('project_file_changed', 409);
      const buffer = Buffer.allocUnsafe(64 * 1024);
      // Prefix scanning keeps memory bounded even when skipped lines are huge.
      while (scannedBytes < observed.size && line <= endLine) {
        verifyRoot();
        if (scannedBytes >= 64 * 1024 * 1024) throw new ProjectWriteError('project_file_scan_limit', 413, { maxScanBytes: 64 * 1024 * 1024 });
        const { bytesRead } = await handle.read(buffer, 0, Math.min(buffer.length, observed.size - scannedBytes), scannedBytes);
        verifyRoot();
        if (!bytesRead) throw new ProjectWriteError('project_file_changed', 409);
        const chunk = buffer.subarray(0, bytesRead);
        if (chunk.includes(0)) throw new ProjectWriteError('project_file_not_text', 415);
        digest.update(chunk); scannedBytes += bytesRead;
        let cursor = 0;
        while (cursor < bytesRead) {
          const newline = chunk.indexOf(10, cursor), stop = newline < 0 ? bytesRead : newline + 1;
          if (line >= startLine && line <= endLine) {
            const piece = chunk.subarray(cursor, stop);
            resultBytes += piece.length;
            if (resultBytes > 48_001) throw new ProjectWriteError('project_file_range_too_large', 413, { maxBytes: 48_000 });
            chunks.push(Buffer.from(piece));
          }
          if (newline >= 0) line++;
          cursor = stop;
        }
      }
      if (!sameFile(await handle.stat()) || !sameFile(await fs.promises.lstat(absolute))) throw new ProjectWriteError('project_file_changed', 409);
      verifyRoot();
    } finally { await handle.close(); }
    if (!sameFile(await fs.promises.lstat(absolute))) throw new ProjectWriteError('project_file_changed', 409);
    verifyRoot();
    let selected = Buffer.concat(chunks);
    if (line > endLine && selected.at(-1) === 10) selected = selected.subarray(0, selected.length - 1);
    if (selected.length > 48_000) throw new ProjectWriteError('project_file_range_too_large', 413, { maxBytes: 48_000 });
    let text: string;
    try { text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(selected); }
    catch { throw new ProjectWriteError('project_file_not_text', 415); }
    const complete = scannedBytes === observed.size;
    return { relativePath, byteLength: observed.size, sha256: complete ? digest.digest('hex') : null,
      rangeSha256: createHash('sha256').update(selected).digest('hex'), rangeByteLength: selected.length,
      startLine, endLine: Math.min(endLine, line), totalLines: complete ? line : null,
      nextLine: !complete || line > endLine ? endLine + 1 : null, scannedBytes,
      mediaType: meta.mediaType, ...(meta.language ? { language: meta.language } : {}), text };
  }

  /** Bounded, non-recursive browsing. Unlike a write manifest this never hashes files. */
  async listProjectDirectory(rootBindingId: string, relativePath = '', offset = 0, signal?: AbortSignal): Promise<ProjectDirectoryPage> {
    if (typeof relativePath !== 'string' || relativePath.length > 2048 || !Number.isSafeInteger(offset) || offset < 0 || offset > 100_000) {
      throw new ProjectWriteError('project_directory_query_invalid');
    }
    signal?.throwIfAborted();
    const directoryPath = relativePath === '.' ? '' : relativePath;
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (directoryPath && isProtectedProjectPath(directoryPath)) throw new ProjectWriteError('project_path_protected', 403);
    const absolute = directoryPath ? this.rootService.resolveVerifiedPath(rootBindingId, directoryPath) : root.localPath;
    let observed: fs.Stats;
    try { observed = await fs.promises.lstat(absolute); }
    catch (error) { throw new ProjectWriteError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'project_directory_not_found' : 'project_directory_unreadable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 403); }
    if (observed.isSymbolicLink() || !observed.isDirectory()) throw new ProjectWriteError('project_directory_not_regular');
    const entries: Array<{ relativePath: string; kind: 'file' | 'directory'; byteLength: number }> = [];
    let cursor = 0;
    let exhausted = false;
    let directory: fs.Dir;
    try { directory = await fs.promises.opendir(absolute); }
    catch (error) { throw new ProjectWriteError((error as NodeJS.ErrnoException).code === 'ENOENT' ? 'project_directory_not_found' : 'project_directory_unreadable', (error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 403); }
    try {
      // Offset bounds keep reopening a later page finite; skipping performs no child IO.
      while (cursor < offset) {
        signal?.throwIfAborted();
        if (!await directory.read()) { exhausted = true; break; }
        cursor++;
      }
      while (!exhausted && cursor < offset + 100) {
        signal?.throwIfAborted();
        const child = await directory.read();
        if (!child) { exhausted = true; break; }
        cursor++;
        const childPath = directoryPath ? `${directoryPath}/${child.name}` : child.name;
        if (isProtectedProjectPath(childPath) || child.isSymbolicLink() || (!child.isDirectory() && !child.isFile())) continue;
        try {
          const childAbsolute = this.rootService.resolveVerifiedPath(rootBindingId, childPath);
          const info = await fs.promises.lstat(childAbsolute);
          if (info.isSymbolicLink() || (info.isFile() && info.nlink > 1) || (!info.isDirectory() && !info.isFile())) continue;
          entries.push({ relativePath: childPath, kind: info.isDirectory() ? 'directory' : 'file', byteLength: info.isFile() ? info.size : 0 });
        } catch (error) {
          // One protected junction (e.g. in a Windows home directory) must not
          // hide its safe siblings. Revocation and root changes still fail below.
          if (error instanceof ProjectRootError && !['project_root_link_forbidden', 'project_path_traversal_forbidden', 'project_path_escape_forbidden'].includes(error.message)) throw error;
          if (!(error instanceof ProjectRootError) && !['ENOENT', 'EACCES', 'EPERM'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
        }
      }
    } finally { await directory.close(); }
    signal?.throwIfAborted();
    const verified = this.rootService.getVerifiedRoot(rootBindingId);
    if (directoryPath) this.rootService.resolveVerifiedPath(rootBindingId, directoryPath);
    const current = await fs.promises.lstat(absolute);
    if (verified.binding.rootIdentityDigest !== root.binding.rootIdentityDigest || current.isSymbolicLink() || !current.isDirectory()
      || current.dev !== observed.dev || current.ino !== observed.ino) throw new ProjectWriteError('project_directory_changed', 409);
    signal?.throwIfAborted();
    this.rootService.getVerifiedRoot(rootBindingId);
    return { relativePath: directoryPath, entries, nextOffset: exhausted || cursor >= 100_000 ? null : cursor };
  }

  /** Read-only diff of a proposed changeSet against the current disk. No IO mutation. */
  preflightChangeSet(rootBindingId: string, changeSetInput: unknown): ProjectChangePreflight {
    const changeSet = parseProjectChangeSet(changeSetInput);
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.revokedAt) throw new ProjectRootError('project_root_revoked', 403);
    const readOnly = root.binding.accessMode === 'read_only';

    const entries: ProjectPreflightEntry[] = [];
    const issues: { path: string; code: string }[] = [];

    for (const op of changeSet.operations) {
      const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.path);
      const exists = fs.existsSync(targetAbs);
      const baseSha256 = exists && fs.statSync(targetAbs).isFile() ? this.computeFileSha256(targetAbs) : null;
      const newSha256 = op.newSha256 ?? (typeof op.content === 'string' ? createHash('sha256').update(op.content, 'utf8').digest('hex') : null);
      const byteLength = typeof op.content === 'string' ? Buffer.byteLength(op.content, 'utf8') : null;
      let status: ProjectPreflightStatus = 'blocked';

      if (readOnly && op.type !== 'mkdir') {
        status = 'blocked';
        issues.push({ path: op.path, code: 'project_root_read_only' });
      } else if (op.type === 'mkdir') {
        status = exists ? 'unchanged' : 'create';
      } else if (op.type === 'create') {
        status = exists ? 'conflict' : 'create';
        if (exists) issues.push({ path: op.path, code: 'target_exists' });
      } else if (op.type === 'replace' || op.type === 'patch_lines') {
        if (!exists) {
          status = 'missing';
          issues.push({ path: op.path, code: 'target_missing' });
        } else if (op.expectedSha256 && baseSha256 !== op.expectedSha256) {
          status = 'conflict';
          issues.push({ path: op.path, code: 'base_hash_mismatch' });
        } else {
          status = 'replace';
        }
      } else if (op.type === 'move') {
        const fromAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.fromPath!);
        if (!fs.existsSync(fromAbs)) {
          status = 'missing';
          issues.push({ path: op.fromPath!, code: 'source_missing' });
        } else if (op.expectedSha256 && this.computeFileSha256(fromAbs) !== op.expectedSha256) {
          status = 'conflict';
          issues.push({ path: op.fromPath!, code: 'base_hash_mismatch' });
        } else if (exists) {
          status = 'conflict';
          issues.push({ path: op.path, code: 'target_exists' });
        } else {
          status = 'replace';
        }
      }

      entries.push({
        path: op.path,
        operation: op.type,
        status,
        baseSha256,
        expectedSha256: op.expectedSha256 ?? null,
        newSha256,
        byteLength
      });
    }

    return {
      changeSetId: changeSet.id,
      rootBindingId,
      ok: !readOnly && issues.length === 0,
      entries: Object.freeze(entries),
      issues: Object.freeze(issues)
    };
  }

  /** Current filesystem observations only. Matching bytes never prove who wrote them.
   * No write, checkpoint, historical receipt or automatic retry is performed here. */
  inspectInterruptedWrite(projectId: string, rootBindingId: string, intent: StoredWriteIntent): ProjectWriteRecoveryReview {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.projectId !== projectId) throw new ProjectWriteError('project_root_project_mismatch', 403);
    if (root.binding.accessMode !== 'read_write') throw new ProjectWriteError('project_root_read_only', 403);
    if (intent.rootBindingId !== rootBindingId || !['in_progress', 'failed', 'needs_attention'].includes(intent.status)) {
      throw new ProjectWriteError('project_write_not_recoverable', 409);
    }
    if (!/^op-[A-Za-z0-9_-]+$/.test(intent.operationId)) throw new ProjectWriteError('project_write_operation_invalid', 400);
    const changeSet = parseProjectChangeSet(intent.changeSet);
    const paths = changeSet.operations.map(op => [op.path, ...(op.fromPath ? [op.fromPath] : [])]);
    // Validate every path before inspecting any bytes, including move sources.
    for (const names of paths) for (const name of names) {
      if (!isSafeRelativePath(name)) throw new ProjectWriteError('project_path_traversal_forbidden', 400);
      if (isProtectedProjectPath(name)) throw new ProjectWriteError('project_path_protected', 403);
    }
    // Cross-platform conservative identity: repeated, case-aliased and ancestor
    // paths cannot be classified independently after an interrupted sequence.
    const normalized = paths.map(names => names.map(name => name.replace(/\\/g, '/').toLowerCase()));
    const overlaps = (a: string, b: string) => a === b || a.startsWith(b + '/') || b.startsWith(a + '/');
    const ambiguous = new Set<number>();
    normalized.forEach((names, index) => {
      if (names.length === 2 && overlaps(names[0]!, names[1]!)) ambiguous.add(index);
      for (let other = 0; other < index; other++) if (names.some(a => normalized[other]!.some(b => overlaps(a, b)))) {
        ambiguous.add(index); ambiguous.add(other);
      }
    });
    type Observation = { kind: 'missing' | 'file' | 'directory' | 'other'; sha256: string | null };
    const observe = (relativePath: string): Observation => {
      let absolutePath: string;
      let stat: fs.Stats;
      try {
        absolutePath = this.rootService.resolveVerifiedPath(rootBindingId, relativePath);
        stat = fs.lstatSync(absolutePath);
      }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { kind: 'missing', sha256: null };
        if ((error as NodeJS.ErrnoException).code === 'ENOTDIR') return { kind: 'other', sha256: null };
        throw error;
      }
      if (stat.isFile()) return { kind: 'file', sha256: this.computeFileSha256(absolutePath) };
      return { kind: stat.isDirectory() ? 'directory' : 'other', sha256: null };
    };
    // Derive the location from trusted configuration, never from intent.preimagesDir.
    const preimagesDir = path.join(this.stagingBaseDir, 'preimages', rootBindingId, intent.operationId);
    const observations: { target: Observation; source?: Observation; preimage: string | null }[] = [];
    const entries: ProjectWriteRecoveryEntry[] = changeSet.operations.map((op, index) => {
      const target = observe(op.path);
      const source = op.fromPath ? observe(op.fromPath) : undefined;
      let state: ProjectWriteRecoveryEntry['state'] = 'conflict';
      let preimage: string | null = null;
      if (!ambiguous.has(index)) {
        if (op.type === 'mkdir') {
          if (target.kind === 'missing') state = 'pending';
          else if (target.kind === 'directory') state = 'already_present';
        } else if (op.type === 'create' || op.type === 'replace') {
          const desiredHash = createHash('sha256').update(op.content ?? '', 'utf8').digest('hex');
          if (desiredHash === op.newSha256) {
            if (target.kind === 'file' && target.sha256 === desiredHash) state = 'already_present';
            else if (op.type === 'create' && target.kind === 'missing' || op.type === 'replace' && target.kind === 'file' && target.sha256 === op.expectedSha256) state = 'pending';
          }
        } else if (op.type === 'patch_lines') {
          // Patching the present file might apply an insertion twice. Always derive
          // the intended output from the hash-verified original preimage instead.
          try {
            const bytes = this.readPreimage(preimagesDir, op.path, op.expectedSha256!);
            const original = bytes.toString('utf8');
            if (bytes.includes(0) || !Buffer.from(original, 'utf8').equals(bytes)) throw new Error('not_text');
            preimage = op.expectedSha256!;
            const desiredHash = createHash('sha256').update(this.patchContent(op, original), 'utf8').digest('hex');
            if (op.newSha256 === undefined || op.newSha256 === desiredHash) {
              if (target.kind === 'file' && target.sha256 === desiredHash) state = 'already_present';
              else if (target.kind === 'file' && target.sha256 === op.expectedSha256) state = 'pending';
            }
          } catch { /* Missing, corrupted or non-text preimages require explicit review. */ }
        } else if (op.type === 'move' && source) {
          const originalHash = op.expectedSha256 ?? op.newSha256;
          // Without any bound hash, an arbitrary current source is not a safe retry.
          if (originalHash && (op.newSha256 === undefined || op.newSha256 === originalHash)) {
            try {
              this.readPreimage(preimagesDir, op.fromPath!, originalHash);
              preimage = originalHash;
              if (source.kind === 'file' && source.sha256 === originalHash && target.kind === 'missing') state = 'pending';
              else if (source.kind === 'missing' && target.kind === 'file' && target.sha256 === originalHash) state = 'already_present';
            } catch { /* Keep an unverified move conflicted, never guess its source. */ }
          }
        }
      }
      observations.push({ target, ...(source ? { source } : {}), preimage });
      return Object.freeze({ path: op.path, type: op.type, state, observedSha256: target.sha256, ...(source ? { sourceSha256: source.sha256 } : {}) });
    });
    const pending = changeSet.operations.filter((_, index) => entries[index]!.state === 'pending');
    const canPrepare = pending.length > 0 && entries.every(entry => entry.state !== 'conflict');
    const manifestDigest = canPrepare ? this.generateSnapshotManifest(projectId, rootBindingId).snapshotDigest : null;
    const digest = createHash('sha256').update(canonicalJson({
      kind: 'project-write-recovery-review-v1', projectId,
      rootBinding: root.binding,
      intent: { operationId: intent.operationId, rootBindingId, status: intent.status, createdAt: intent.createdAt, confirmedPaths: intent.confirmedPaths, changeSetDigest: changeSet.digest },
      entries, observations, manifestDigest,
    })).digest('hex');
    let residualChangeSet: ProjectChangeSet | null = null;
    if (canPrepare) {
      const raw = { id: `recovery-${digest}`, taskId: `recovery-${digest}`, revision: 1, baseManifestDigest: manifestDigest!, operations: pending };
      residualChangeSet = parseProjectChangeSet({ ...raw, digest: computeProjectChangeSetDigest(raw) });
    }
    return Object.freeze({ operationId: intent.operationId, rootBindingId, changeSetDigest: changeSet.digest, digest, entries: Object.freeze(entries), residualChangeSet });
  }

  generateSnapshotManifest(projectId: string, rootBindingId: string): ProjectFileManifest {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if(root.binding.projectId !== projectId) throw new ProjectRootError('project_root_project_mismatch',403);

    const entries: ProjectFileManifestEntry[] = [];
    const walk = (relDir: string) => {
      const absDir = relDir === '' ? root.localPath : path.join(root.localPath, relDir);
      const items = fs.readdirSync(absDir, { withFileTypes: true });

      for (const item of items) {
        const itemRel = relDir === '' ? item.name : `${relDir}/${item.name}`;
        if (isProtectedProjectPath(itemRel)) continue;

        // Filter default excluded folders and files
        if (item.name === '.git' || item.name === 'node_modules' || item.name === 'dist' ||
            item.name === '__pycache__' || item.name === '.venv' || item.name === '.uptokey-preimages') {
          continue;
        }

        if (item.isSymbolicLink()) {
          // Reject symlink items inside the project
          continue;
        }

        if (item.isDirectory()) {
          entries.push({
            relativePath: itemRel,
            kind: 'directory',
            byteLength: 0,
            sha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855'
          });
          walk(itemRel);
        } else if (item.isFile()) {
          const absFile = this.rootService.resolveVerifiedPath(rootBindingId, itemRel);
          const stat = fs.statSync(absFile);
          const sha256 = this.computeFileSha256(absFile);
          const ext = path.extname(item.name).toLowerCase();
          const isSensitive = SENSITIVE_FILENAMES.has(item.name.toLowerCase());

          entries.push({
            relativePath: itemRel,
            kind: 'file',
            byteLength: stat.size,
            sha256,
            empty: stat.size === 0,
            sensitivity: isSensitive ? 'protected' : 'public',
            ...(isSensitive ? { protectedRef: `prot-${sha256.slice(0, 16)}` } : {}),
            ...(ext === '.md' ? { language: 'markdown', mediaType: 'text/markdown' } : {}),
            ...(ext === '.html' ? { language: 'html', mediaType: 'text/html' } : {}),
            ...(ext === '.js' ? { language: 'javascript', mediaType: 'application/javascript' } : {}),
            ...(ext === '.ts' ? { language: 'typescript', mediaType: 'application/typescript' } : {}),
            ...(ext === '.json' ? { language: 'json', mediaType: 'application/json' } : {})
          });
        }
      }
    };

    walk('');

    const snapshotDigest = createHash('sha256')
      .update(JSON.stringify(entries.map(e => ({ p: e.relativePath, h: e.sha256 }))))
      .digest('hex');

    const manifestId = `manifest-${randomUUID()}`;
    return parseProjectFileManifest({
      id: manifestId,
      projectId,
      rootBindingId,
      snapshotDigest,
      entries
    });
  }

  async applyChangeSetWithStore(
    rootBindingId: string,
    changeSetInput: unknown,
    store: WorkspaceStore,
    principalId: string,
    projectId: string,
    options: { signal?: AbortSignal; execution?: { runId: string; stepId: string } } = {}
  ): Promise<AppliedWriteReceipt> {
    const checkCancellation = () => {
      if (options.signal?.aborted) throw new ProjectWriteError('project_write_cancelled', 409);
    };
    checkCancellation();
    const changeSet = parseProjectChangeSet(changeSetInput);
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.revokedAt) throw new ProjectRootError('project_root_revoked', 403);
    if (root.binding.accessMode === 'read_only') throw new ProjectWriteError('project_root_read_only', 403);
    // Retention gate before any staging/preimage bytes reach disk for this principal.
    this.sinkPolicy.assertSinkAllowed(principalId, 'filesystem:project_write');

    // The trusted runtime binds all attempts of one step to the same write.
    // An uncertain write is never silently repeated under a fresh UUID.
    const operationId = options.execution
      ? `op-${createHash('sha256').update(JSON.stringify([principalId, projectId, options.execution.runId, options.execution.stepId])).digest('hex')}`
      : `op-${randomUUID()}`;
    if (options.execution) {
      const existing = await store.getWriteIntent(principalId, projectId, operationId);
      if (existing) {
        if (existing.rootBindingId !== rootBindingId || existing.changeSet.digest !== changeSet.digest) {
          throw new ProjectWriteError('project_write_execution_conflict', 409);
        }
        checkCancellation();
        this.rootService.getVerifiedRoot(rootBindingId);
        // A durable completed receipt proves the old execution, not today's file
        // contents. Never rewrite or re-hash a user's subsequent edits on replay.
        if (existing.status === 'completed' && existing.receipt) return structuredClone(existing.receipt);
        throw new ProjectWriteError('project_write_already_recorded', 409);
      }
    }
    checkCancellation();
    const preimagesDir = path.join(this.stagingBaseDir, 'preimages', rootBindingId, operationId);
    fs.mkdirSync(path.dirname(preimagesDir), { recursive: true });
    try { fs.mkdirSync(preimagesDir); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new ProjectWriteError('project_write_reconciliation_required', 409);
      throw error;
    }

    // Step 1: Pre-validation of all operations against current disk state
    for (const op of changeSet.operations) {
      const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.path);

      if (op.type === 'create') {
        if (fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Target file already exists: ${op.path}`, 409, { conflictPath: op.path });
        }
        this.verifyOutputDigest(op, op.content ?? '');
      } else if (op.type === 'replace' || op.type === 'patch_lines') {
        if (!fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Target file to replace or patch does not exist: ${op.path}`, 404, { missingPath: op.path });
        }
        const currentSha = this.computeFileSha256(targetAbs);
        if (op.expectedSha256 && currentSha !== op.expectedSha256) {
          throw new ProjectWriteError(`Conflict: current hash does not match expected for ${op.path}`, 409, {
            conflictPath: op.path,
            expectedSha256: op.expectedSha256,
            currentSha256: currentSha
          });
        }
        this.verifyOutputDigest(op, op.type === 'patch_lines' ? this.patchContent(op, fs.readFileSync(targetAbs, 'utf8')) : op.content ?? '');
        this.savePreimage(preimagesDir, op.path, targetAbs);
      } else if (op.type === 'move') {
        if (!op.fromPath) throw new ProjectWriteError('Move operation missing fromPath', 400);
        const fromAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.fromPath);
        if (!fs.existsSync(fromAbs)) {
          throw new ProjectWriteError(`Source file to move does not exist: ${op.fromPath}`, 404);
        }
        if (fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Destination file already exists: ${op.path}`, 409);
        }
        const sourceHash = this.computeFileSha256(fromAbs);
        if (op.expectedSha256 && sourceHash !== op.expectedSha256) throw new ProjectWriteError('base_hash_mismatch', 409);
        if (op.newSha256 && sourceHash !== op.newSha256) throw new ProjectWriteError('project_write_output_digest_mismatch', 422);
        this.savePreimage(preimagesDir, op.fromPath, fromAbs);
      }
    }

    // Persist intent as in_progress BEFORE touching disk files
    const intent: WriteIntentRecord = {
      operationId,
      rootBindingId,
      changeSet,
      status: 'in_progress',
      preimagesDir,
      createdAt: new Date().toISOString(),
      confirmedPaths: []
    };
    this.intents.set(operationId, intent);
    await store.putWriteIntent(principalId, projectId, {
      ...intent,
      confirmedPaths: [...intent.confirmedPaths]
    });

    const observedHashes: Record<string, string> = Object.create(null);
    let completionCommitStarted = false;

    // Windows readers can briefly deny an atomic replacement. Retry that same
    // staged write only; every wait revalidates authority and both file hashes.
    const replaceStagedFile = async (op: ProjectChangeSet['operations'][number], tempPath: string, targetAbs: string, content: string) => {
      const stagedHash = createHash('sha256').update(content).digest('hex');
      const delays = [10, 25, 50, 100, 200];
      for (let attempt = 0; ; attempt++) {
        checkCancellation();
        const liveRoot = this.rootService.getVerifiedRoot(rootBindingId);
        if (liveRoot.binding.accessMode !== 'read_write') throw new ProjectWriteError('project_root_read_only', 403);
        this.sinkPolicy.assertSinkAllowed(principalId, 'filesystem:project_write');
        if (this.rootService.resolveVerifiedPath(rootBindingId, op.path) !== targetAbs) throw new ProjectWriteError('project_root_mismatch', 403);
        if (op.type === 'create' && fs.existsSync(targetAbs)) throw new ProjectWriteError('target_exists', 409);
        if (op.type !== 'create' && op.expectedSha256 && (!fs.existsSync(targetAbs) || this.computeFileSha256(targetAbs) !== op.expectedSha256)) {
          throw new ProjectWriteError('base_hash_mismatch', 409);
        }
        if (!fs.lstatSync(tempPath).isFile() || this.computeFileSha256(tempPath) !== stagedHash) {
          throw new ProjectWriteError('project_write_output_digest_mismatch', 422);
        }
        try {
          fs.renameSync(tempPath, targetAbs);
          return;
        } catch (error) {
          if (process.platform !== 'win32' || !['EPERM', 'EACCES', 'EBUSY'].includes((error as NodeJS.ErrnoException).code ?? '') || attempt >= delays.length) throw error;
          await new Promise(resolve => setTimeout(resolve, delays[attempt]));
        }
      }
    };

    try {
      for (const op of changeSet.operations) {
        checkCancellation();
        const liveRoot = this.rootService.getVerifiedRoot(rootBindingId);
        if (liveRoot.binding.accessMode !== 'read_write') throw new ProjectWriteError('project_root_read_only', 403);
        const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.path);
        // Persisting the intent awaited IO; recheck immediately before each mutation.
        if (op.type === 'create' && fs.existsSync(targetAbs)) throw new ProjectWriteError('target_exists', 409);
        if ((op.type === 'replace' || op.type === 'patch_lines') && op.expectedSha256) {
          if (!fs.existsSync(targetAbs) || createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex') !== op.expectedSha256) {
            throw new ProjectWriteError('base_hash_mismatch', 409);
          }
        }

        if (op.type === 'mkdir') {
          if (!fs.existsSync(targetAbs)) {
            fs.mkdirSync(targetAbs, { recursive: true });
          }
          intent.confirmedPaths.push(op.path);
        } else if (op.type === 'create' || op.type === 'replace') {
          const parentDir = path.dirname(targetAbs);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          const tempPath = path.join(parentDir, `.tmp-${randomBytes(8).toString('hex')}`);
          fs.writeFileSync(tempPath, op.content || '', 'utf8');
          await replaceStagedFile(op, tempPath, targetAbs, op.content || '');

          const observedSha = this.computeFileSha256(targetAbs);
          if (op.newSha256 && observedSha !== op.newSha256) {
            throw new ProjectWriteError(`Integrity verification failed for ${op.path}`, 500);
          }
          observedHashes[op.path] = observedSha;
          intent.confirmedPaths.push(op.path);
        } else if (op.type === 'patch_lines') {
          const currentContent = fs.readFileSync(targetAbs, 'utf8');
          const lines = currentContent.split(/\r?\n/);
          const sortedPatches = [...(op.patches || [])].sort((a, b) => b.startLine - a.startLine);
          for (const patch of sortedPatches) {
            const startIndex = Math.max(0, patch.startLine - 1);
            lines.splice(startIndex, patch.deleteCount, ...patch.newLines);
          }
          const newContent = lines.join('\n');
          const parentDir = path.dirname(targetAbs);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          const tempPath = path.join(parentDir, `.tmp-${randomBytes(8).toString('hex')}`);
          fs.writeFileSync(tempPath, newContent, 'utf8');
          await replaceStagedFile(op, tempPath, targetAbs, newContent);

          const observedSha = this.computeFileSha256(targetAbs);
          if (op.newSha256 && observedSha !== op.newSha256) {
            throw new ProjectWriteError(`Integrity verification failed for ${op.path}`, 500);
          }
          observedHashes[op.path] = observedSha;
          intent.confirmedPaths.push(op.path);
        } else if (op.type === 'move' && op.fromPath) {
          const fromAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.fromPath);
          if (op.expectedSha256 && this.computeFileSha256(fromAbs) !== op.expectedSha256) throw new ProjectWriteError('base_hash_mismatch', 409);
          if (fs.existsSync(targetAbs)) throw new ProjectWriteError('target_exists', 409);
          const parentDir = path.dirname(targetAbs);
          if (!fs.existsSync(parentDir)) {
            fs.mkdirSync(parentDir, { recursive: true });
          }
          fs.renameSync(fromAbs, targetAbs);
          observedHashes[op.path] = this.computeFileSha256(targetAbs);
          intent.confirmedPaths.push(op.path);
        }
        // Persist each confirmed mutation before proceeding to another file.
        // A crash between filesystem mutation and this commit still requires
        // reconciliation; this is not an atomic multi-file transaction.
        await store.putWriteIntent(principalId, projectId, {
          ...intent,
          confirmedPaths: [...intent.confirmedPaths]
        });
      }

      // Mark intent completed and persist to store
      checkCancellation();
      const receipt: AppliedWriteReceipt = {
        operationId,
        changeSetId: changeSet.id,
        baseManifestDigest: changeSet.baseManifestDigest,
        // Logical completion time cannot precede the recorded opening when the
        // OS adjusts its wall clock. This does not alter consent expiry clocks.
        appliedAt: new Date(Math.max(Date.now(), Date.parse(intent.createdAt))).toISOString(),
        confirmedPaths: Object.freeze([...intent.confirmedPaths]),
        observedHashes: Object.fromEntries(Object.entries(observedHashes)),
        preimagesRef: preimagesDir
      };
      completionCommitStarted = true;
      await store.putWriteIntent(principalId, projectId, {
        ...intent,
        status: 'completed',
        confirmedPaths: [...intent.confirmedPaths],
        receipt,
      });
      (intent as { status: string }).status = 'completed';
      return receipt;
    } catch (err) {
      // A failed acknowledgement may follow a committed completion. Overwriting
      // it as failed would destroy the only durable proof of the actual result.
      if (completionCommitStarted) throw err;
      (intent as { status: string }).status = 'failed';
      await store.putWriteIntent(principalId, projectId, {
        ...intent,
        status: 'failed',
        confirmedPaths: [...intent.confirmedPaths]
      });
      throw err;
    }
  }

  applyChangeSet(rootBindingId: string, changeSetInput: unknown): AppliedWriteReceipt {
    const changeSet = parseProjectChangeSet(changeSetInput);
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.revokedAt) throw new ProjectRootError('project_root_revoked', 403);
    if (root.binding.accessMode === 'read_only') throw new ProjectWriteError('project_root_read_only', 403);

    const operationId = `op-${randomUUID()}`;
    const preimagesDir = path.join(this.stagingBaseDir, 'preimages', rootBindingId, operationId);
    fs.mkdirSync(preimagesDir, { recursive: true });

    // Step 1: Pre-validation of all operations against current disk state
    for (const op of changeSet.operations) {
      const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.path);

      if (op.type === 'create') {
        if (fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Target file already exists: ${op.path}`, 409, { conflictPath: op.path });
        }
        this.verifyOutputDigest(op, op.content ?? '');
      } else if (op.type === 'replace' || op.type === 'patch_lines') {
        if (!fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Target file to replace or patch does not exist: ${op.path}`, 404, { missingPath: op.path });
        }
        const currentSha = this.computeFileSha256(targetAbs);
        if (op.expectedSha256 && currentSha !== op.expectedSha256) {
          throw new ProjectWriteError(`Conflict: current hash does not match expected for ${op.path}`, 409, {
            conflictPath: op.path,
            expectedSha256: op.expectedSha256,
            currentSha256: currentSha
          });
        }
        // Save preimage
        this.verifyOutputDigest(op, op.type === 'patch_lines' ? this.patchContent(op, fs.readFileSync(targetAbs, 'utf8')) : op.content ?? '');
        this.savePreimage(preimagesDir, op.path, targetAbs);
      } else if (op.type === 'move') {
        if (!op.fromPath) throw new ProjectWriteError('Move operation missing fromPath', 400);
        const fromAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.fromPath);
        if (!fs.existsSync(fromAbs)) {
          throw new ProjectWriteError(`Source file to move does not exist: ${op.fromPath}`, 404);
        }
        if (fs.existsSync(targetAbs)) {
          throw new ProjectWriteError(`Destination file already exists: ${op.path}`, 409);
        }
        // Save preimage of source
        const sourceHash = this.computeFileSha256(fromAbs);
        if (op.expectedSha256 && sourceHash !== op.expectedSha256) throw new ProjectWriteError('base_hash_mismatch', 409);
        if (op.newSha256 && sourceHash !== op.newSha256) throw new ProjectWriteError('project_write_output_digest_mismatch', 422);
        this.savePreimage(preimagesDir, op.fromPath, fromAbs);
      }
    }

    // Local helper state only: this is NOT durable intent or W5 authorization.
    const intent: WriteIntentRecord = {
      operationId,
      rootBindingId,
      changeSet,
      status: 'in_progress',
      preimagesDir,
      createdAt: new Date().toISOString(),
      confirmedPaths: []
    };
    this.intents.set(operationId, intent);

    // Individual replacements use rename; the changeset is not a filesystem transaction.
    const observedHashes: Record<string, string> = Object.create(null);

    for (const op of changeSet.operations) {
      const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.path);

      if (op.type === 'mkdir') {
        if (!fs.existsSync(targetAbs)) {
          fs.mkdirSync(targetAbs, { recursive: true });
        }
        intent.confirmedPaths.push(op.path);
      } else if (op.type === 'create' || op.type === 'replace') {
        const parentDir = path.dirname(targetAbs);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }

        // Safe replacement via temp file on the same directory
        const tempPath = path.join(parentDir, `.tmp-${randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tempPath, op.content || '', 'utf8');

        // Atomically replace target
        fs.renameSync(tempPath, targetAbs);

        // Step 4: Immediately read observed bytes from disk
        const observedSha = this.computeFileSha256(targetAbs);
        if (op.newSha256 && observedSha !== op.newSha256) {
          throw new ProjectWriteError(`Integrity verification failed for ${op.path}`, 500);
        }
        observedHashes[op.path] = observedSha;
        intent.confirmedPaths.push(op.path);
      } else if (op.type === 'patch_lines') {
        const currentContent = fs.readFileSync(targetAbs, 'utf8');
        const lines = currentContent.split(/\r?\n/);
        const sortedPatches = [...(op.patches || [])].sort((a, b) => b.startLine - a.startLine);
        for (const patch of sortedPatches) {
          const startIndex = Math.max(0, patch.startLine - 1);
          lines.splice(startIndex, patch.deleteCount, ...patch.newLines);
        }
        const newContent = lines.join('\n');
        const parentDir = path.dirname(targetAbs);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        const tempPath = path.join(parentDir, `.tmp-${randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tempPath, newContent, 'utf8');
        fs.renameSync(tempPath, targetAbs);

        const observedSha = this.computeFileSha256(targetAbs);
        if (op.newSha256 && observedSha !== op.newSha256) {
          throw new ProjectWriteError(`Integrity verification failed for ${op.path}`, 500);
        }
        observedHashes[op.path] = observedSha;
        intent.confirmedPaths.push(op.path);
      } else if (op.type === 'move' && op.fromPath) {
        const fromAbs = this.rootService.resolveVerifiedPath(rootBindingId, op.fromPath);
        if (op.expectedSha256 && this.computeFileSha256(fromAbs) !== op.expectedSha256) throw new ProjectWriteError('base_hash_mismatch', 409);
        if (fs.existsSync(targetAbs)) throw new ProjectWriteError('target_exists', 409);
        const parentDir = path.dirname(targetAbs);
        if (!fs.existsSync(parentDir)) {
          fs.mkdirSync(parentDir, { recursive: true });
        }
        fs.renameSync(fromAbs, targetAbs);
        observedHashes[op.path] = this.computeFileSha256(targetAbs);
        intent.confirmedPaths.push(op.path);
      }
    }

    // Step 5: Mark intent completed
    (intent as { status: string }).status = 'completed';

    return {
      operationId,
      changeSetId: changeSet.id,
      baseManifestDigest: changeSet.baseManifestDigest,
      appliedAt: new Date().toISOString(),
      confirmedPaths: Object.freeze([...intent.confirmedPaths]),
      observedHashes: Object.fromEntries(Object.entries(observedHashes)),
      preimagesRef: preimagesDir
    };
  }

  restoreChangeSet(operationId: string): RestoreReceipt {
    const intent = this.intents.get(operationId);
    if (!intent) {
      throw new ProjectWriteError('write_intent_not_found', 404);
    }

    const restoredPaths: string[] = [];
    const skippedPaths: string[] = [];

    for (const op of intent.changeSet.operations) {
      if (op.type === 'replace' && op.expectedSha256 && op.newSha256) {
        const targetAbs = this.rootService.resolveVerifiedPath(intent.rootBindingId, op.path);
        if (!fs.existsSync(targetAbs)) {
          skippedPaths.push(op.path);
          continue;
        }

        const currentSha = this.computeFileSha256(targetAbs);
        // CONDITIONAL RESTORATION INVARIANT:
        // Only restore if current disk hash matches the Uptokey applied hash.
        // If user has edited the file in the meantime (currentSha !== op.newSha256), NEVER overwrite!
        if (currentSha !== op.newSha256) {
          skippedPaths.push(op.path);
          continue;
        }

        let bytes: Buffer;
        try { bytes = this.readPreimage(intent.preimagesDir, op.path, op.expectedSha256); }
        catch { skippedPaths.push(op.path); continue; }
        const tempPath = path.join(path.dirname(targetAbs), `.tmp-restore-${randomBytes(8).toString('hex')}`);
        fs.writeFileSync(tempPath, bytes, { flag: 'wx' });
        fs.renameSync(tempPath, targetAbs);
        restoredPaths.push(op.path);
      } else if (op.type === 'create') {
        const targetAbs = this.rootService.resolveVerifiedPath(intent.rootBindingId, op.path);
        if (fs.existsSync(targetAbs)) {
          const currentSha = this.computeFileSha256(targetAbs);
          if (currentSha === op.newSha256) {
            fs.unlinkSync(targetAbs);
            restoredPaths.push(op.path);
          } else {
            skippedPaths.push(op.path);
          }
        }
      }
    }

    return {
      operationId,
      restoredAt: new Date().toISOString(),
      restoredPaths: Object.freeze(restoredPaths),
      skippedPaths: Object.freeze(skippedPaths)
    };
  }

  /** Preparation only. Restoration is another reviewed W5 write, never a direct copy. */
  prepareFileRestore(projectId: string, rootBindingId: string, relativePath: string, expectedSha256: string, intent: StoredWriteIntent) {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if (root.binding.projectId !== projectId) throw new ProjectWriteError('project_root_project_mismatch', 403);
    if (root.binding.accessMode !== 'read_write') throw new ProjectWriteError('project_root_read_only', 403);
    if (intent.rootBindingId !== rootBindingId || !['completed', 'failed', 'needs_attention'].includes(intent.status) || !intent.confirmedPaths.includes(relativePath)) {
      throw new ProjectWriteError('restore_operation_mismatch', 409);
    }
    const operation = intent.changeSet.operations.find(op => op.path === relativePath);
    if (!operation || !['replace', 'patch_lines'].includes(operation.type) || !operation.expectedSha256 || !operation.newSha256) {
      throw new ProjectWriteError('restore_preimage_unavailable', 409);
    }
    const current = this.readProjectFile(rootBindingId, relativePath);
    if (current.sha256 !== expectedSha256) {
      throw new ProjectWriteError('restore_file_changed', 409);
    }
    // The directory is derived from trusted service configuration, never a supplied/stored arbitrary path.
    if (!/^op-[A-Za-z0-9_-]+$/.test(intent.operationId)) throw new ProjectWriteError('restore_operation_invalid', 400);
    const preimagesDir = path.join(this.stagingBaseDir, 'preimages', rootBindingId, intent.operationId);
    const bytes = this.readPreimage(preimagesDir, relativePath, operation.expectedSha256);
    const text = bytes.toString('utf8');
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (bytes.includes(0) || !Buffer.from(text, 'utf8').equals(bytes) || digest !== operation.expectedSha256) {
      throw new ProjectWriteError('restore_preimage_integrity', 409);
    }
    const manifest = this.generateSnapshotManifest(projectId, rootBindingId);
    const raw = {
      id: `restore-${randomUUID()}`, taskId: `restore-${randomUUID()}`, revision: 1,
      baseManifestDigest: manifest.snapshotDigest,
      operations: [{ type: 'replace' as const, path: relativePath, expectedSha256: current.sha256, newSha256: digest, content: text }]
    };
    const changeSet = parseProjectChangeSet({ ...raw, digest: computeProjectChangeSetDigest(raw) });
    return { changeSet, before: current.text, after: text };
  }

  private preimageName(relativePath: string): string {
    return createHash('sha256').update(relativePath.replace(/\\/g, '/'), 'utf8').digest('hex') + '.bin';
  }

  private patchContent(op: ProjectChangeSet['operations'][number], current: string): string {
    const lines = current.split(/\r?\n/);
    const patches = [...(op.patches ?? [])].sort((a, b) => b.startLine - a.startLine);
    for (const patch of patches) lines.splice(patch.startLine - 1, patch.deleteCount, ...patch.newLines);
    return lines.join('\n');
  }

  private verifyOutputDigest(op: ProjectChangeSet['operations'][number], content: string): void {
    if (op.newSha256 && createHash('sha256').update(content, 'utf8').digest('hex') !== op.newSha256) {
      throw new ProjectWriteError('project_write_output_digest_mismatch', 422);
    }
  }

  private savePreimage(directory: string, relativePath: string, source: string): void {
    const versioned = path.join(directory, 'v2');
    fs.mkdirSync(versioned, { recursive: true });
    fs.copyFileSync(source, path.join(versioned, this.preimageName(relativePath)), fs.constants.COPYFILE_EXCL);
  }

  private readPreimage(directory: string, relativePath: string, expectedHash: string): Buffer {
    let bytes: Buffer;
    try {
      const directoryStat = fs.lstatSync(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink()) throw new Error('invalid');
      const versioned = path.join(directory, 'v2');
      let versionStat: fs.Stats | undefined;
      try { versionStat = fs.lstatSync(versioned); }
      catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
      if (versionStat?.isSymbolicLink()) throw new Error('invalid');
      // Older operations remain readable without moving data. A missing v2 file
      // never falls back to an ambiguous legacy name within a v2 operation.
      const file = versionStat?.isDirectory()
        ? path.join(versioned, this.preimageName(relativePath))
        : path.join(directory, relativePath.replace(/[\\/]/g, '__'));
      const stat = fs.lstatSync(file);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size > DEFAULT_FILE_READ_MAX_BYTES) throw new Error('invalid');
      bytes = fs.readFileSync(file);
      if (bytes.length > DEFAULT_FILE_READ_MAX_BYTES) throw new Error('invalid');
    } catch { throw new ProjectWriteError('restore_preimage_unavailable', 409); }
    if (createHash('sha256').update(bytes).digest('hex') !== expectedHash) {
      throw new ProjectWriteError('restore_preimage_integrity', 409);
    }
    return bytes;
  }

  writeProtectedLocalConfig(rootBindingId: string, relativePath: string, keyValues: Record<string, string>): { sha256: string; protectedRef: string } {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    if(root.binding.accessMode !== 'read_write') throw new ProjectWriteError('project_root_read_only',403);
    if (!SENSITIVE_FILENAMES.has(path.basename(relativePath).toLowerCase())) {
      throw new ProjectWriteError('Not a protected sensitive configuration file', 400);
    }
    const targetAbs = this.rootService.resolveVerifiedPath(rootBindingId, relativePath);
    if(fs.existsSync(targetAbs)) throw new ProjectWriteError('protected_config_existing_file',409);
    if(Object.entries(keyValues).some(([key,value])=>!/^[_A-Za-z][_A-Za-z0-9]*$/.test(key)||typeof value!=='string'||/[\r\n\0]/.test(value))) {
      throw new ProjectWriteError('protected_config_invalid',400);
    }
    const lines = Object.entries(keyValues).map(([k, v]) => `${k}=${v}`).join('\n') + '\n';

    const parentDir = path.dirname(targetAbs);
    if (!fs.existsSync(parentDir)) {
      fs.mkdirSync(parentDir, { recursive: true });
    }

    const tempPath = path.join(parentDir, `.tmp-env-${randomBytes(8).toString('hex')}`);
    fs.writeFileSync(tempPath, lines, 'utf8');
    fs.renameSync(tempPath, targetAbs);

    const sha256 = this.computeFileSha256(targetAbs);
    return {
      sha256,
      protectedRef: `prot-${sha256.slice(0, 16)}`
    };
  }
}
