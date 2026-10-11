import type { WorkspaceStore } from './store.ts';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  isSafeRelativePath,
  parseProjectRootBinding,
  type ProjectRootBinding,
  type ProjectAccessMode
} from '@uptokey/sync-contract/project-agent';

export interface RegisterRootParams {
  readonly projectId: string;
  readonly principalId: string;
  readonly localAbsolutePath: string;
  readonly displayName: string;
  readonly accessMode?: ProjectAccessMode;
  readonly nonce: string;
}

export class ProjectRootError extends Error {
  readonly status: number;
  constructor(message: string, status: number = 400) {
    super(message);
    this.status = status;
    this.name = 'ProjectRootError';
  }
}

export function computeRootIdentityDigest(realPath: string): string {
  const stat = fs.statSync(realPath);
  const normalized = path.resolve(realPath).toLowerCase();
  const rawId = `${stat.dev}:${stat.ino || normalized}:${stat.birthtimeMs || 0}`;
  return createHash('sha256').update(rawId).digest('hex');
}

/** Default-deny operational state and credentials in previews/exports. A future
 * governed artifact manifest may explicitly admit safe placeholders. */
export function isProtectedProjectPath(relativePath: string): boolean {
  return relativePath.replace(/\\/g, '/').split('/').some(part =>
    (part.startsWith('.') && part !== '.gitignore' && part !== '.uptokey' && part !== '.claude' && part !== '.cursor' && part !== '.github') || /(?:^|[._-])(?:credential|credentials|secret|secrets|token|tokens|private)(?:[._-]|$)/i.test(part) ||
    /\.(?:pem|key|p12|pfx|keystore|jks|tfvars|tfstate|db|sqlite|sqlite3)$/i.test(part));
}

function assertNoLinks(absolutePath: string): void {
  const root = path.parse(absolutePath).root;
  let cursor = root;
  for (const part of absolutePath.slice(root.length).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat: fs.Stats;
    try { stat = fs.lstatSync(cursor); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') break;
      throw error;
    }
    if (stat.isSymbolicLink() || stat.isFile() && stat.nlink > 1) {
      throw new ProjectRootError('project_root_link_forbidden', 403);
    }
  }
}

export class ProjectRootService {
  private readonly bindings = new Map<string, { binding: ProjectRootBinding; localPath: string }>();
  private readonly seenNonces = new Set<string>();

  bindFromStore(binding: ProjectRootBinding, localPath: string): void {
    this.bindings.set(binding.id, { binding, localPath });
  }

  async registerRootWithStore(params: RegisterRootParams, store: WorkspaceStore): Promise<ProjectRootBinding> {
    const binding = this.registerRoot(params);
    await store.putProjectRoot(params.principalId, params.projectId, { binding, localPath: path.resolve(params.localAbsolutePath) });
    return binding;
  }

  registerRoot(params: RegisterRootParams): ProjectRootBinding {
    if (!params.nonce || this.seenNonces.has(params.nonce)) {
      throw new ProjectRootError('project_root_nonce_invalid', 400);
    }
    this.seenNonces.add(params.nonce);

    if (!params.localAbsolutePath || typeof params.localAbsolutePath !== 'string' || !path.isAbsolute(params.localAbsolutePath)) {
      throw new ProjectRootError('project_root_path_invalid', 400);
    }

    const resolved = path.resolve(params.localAbsolutePath);
    assertNoLinks(resolved);
    if (!fs.existsSync(resolved)) {
      throw new ProjectRootError('project_root_not_found', 404);
    }

    const lstat = fs.lstatSync(resolved);
    if (lstat.isSymbolicLink()) {
      throw new ProjectRootError('project_root_symlink_forbidden', 400);
    }
    if (!lstat.isDirectory()) {
      throw new ProjectRootError('project_root_not_a_directory', 400);
    }

    const rootIdentityDigest = computeRootIdentityDigest(resolved);
    const now = new Date();
    const grantedAt = now.toISOString();
    const expiresAt = new Date(now.getTime() + 365 * 24 * 3600 * 1000).toISOString();
    const id = `root-${randomUUID()}`;

    const rawBinding = {
      id,
      projectId: params.projectId,
      principalId: params.principalId,
      revision: 1,
      displayName: params.displayName || path.basename(resolved),
      rootIdentityDigest,
      grantedAt,
      expiresAt,
      accessMode: params.accessMode || 'read_write'
    };

    const binding = parseProjectRootBinding(rawBinding);
    this.bindings.set(id, { binding, localPath: resolved });
    return binding;
  }

  getRoot(rootId: string): { binding: ProjectRootBinding; localPath: string } | undefined {
    return this.bindings.get(rootId);
  }

  async ensureRootLoaded(rootId: string, store: WorkspaceStore, principalId: string, projectId: string): Promise<{ binding: ProjectRootBinding; localPath: string }> {
    let entry = this.bindings.get(rootId);
    if (!entry) {
      const stored = await store.getProjectRoot(principalId, projectId, rootId);
      if (stored) {
        this.bindFromStore(stored.binding, stored.localPath);
        entry = stored;
      }
    }
    const verified = this.getVerifiedRoot(rootId);
    if (verified.binding.principalId !== principalId || verified.binding.projectId !== projectId) {
      throw new ProjectRootError('project_root_not_found', 404);
    }
    return verified;
  }

  getVerifiedRoot(rootId: string): { binding: ProjectRootBinding; localPath: string } {
    const entry = this.bindings.get(rootId);
    if (!entry) throw new ProjectRootError('project_root_not_found', 404);
    if (entry.binding.revokedAt) throw new ProjectRootError('project_root_revoked', 403);
    if (new Date(entry.binding.expiresAt).getTime() <= Date.now()) throw new ProjectRootError('project_root_expired', 403);
    assertNoLinks(entry.localPath);
    if (!fs.existsSync(entry.localPath) || !fs.lstatSync(entry.localPath).isDirectory() ||
        computeRootIdentityDigest(entry.localPath) !== entry.binding.rootIdentityDigest) {
      throw new ProjectRootError('project_root_identity_changed', 409);
    }
    return entry;
  }

  async revokeRootWithStore(rootId: string, principalId: string, store: WorkspaceStore, projectId: string): Promise<ProjectRootBinding> {
    const updated = this.revokeRoot(rootId, principalId);
    await store.revokeProjectRoot(principalId, projectId, rootId, updated.revokedAt || new Date().toISOString());
    return updated;
  }

  revokeRoot(rootId: string, principalId: string): ProjectRootBinding {
    const entry = this.bindings.get(rootId);
    if (!entry) {
      throw new ProjectRootError('project_root_not_found', 404);
    }
    if (entry.binding.principalId !== principalId) {
      throw new ProjectRootError('unauthorized', 403);
    }
    if (entry.binding.revokedAt) {
      return entry.binding;
    }

    const updated = parseProjectRootBinding({
      ...entry.binding,
      revision: entry.binding.revision + 1,
      revokedAt: new Date().toISOString()
    });

    this.bindings.set(rootId, { binding: updated, localPath: entry.localPath });
    return updated;
  }

  resolveVerifiedPath(rootId: string, relativePath: string): string {
    const entry = this.getVerifiedRoot(rootId);
    if (!isSafeRelativePath(relativePath)) {
      throw new ProjectRootError('project_path_traversal_forbidden', 400);
    }

    const resolved = path.resolve(entry.localPath, relativePath);
    // Strict boundary enforcement: path must strictly reside within entry.localPath
    if (!resolved.startsWith(entry.localPath + path.sep) && resolved !== entry.localPath) {
      throw new ProjectRootError('project_path_escape_forbidden', 400);
    }
    assertNoLinks(resolved);
    return resolved;
  }
}
