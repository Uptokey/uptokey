import { execFile } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canonicalContextSnapshotPayload, parseCapabilityDescriptor, parseExecutionPlan, validatePlanBindings, type ExecutionPlan } from '@uptokey/sync-contract/workflow';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import { isSafeRelativePath } from '@uptokey/sync-contract/project-agent';
import { computePlanDigest } from './planner.ts';
import { isProtectedProjectPath } from './project-root-service.ts';
import { WorkspaceError, type WorkspaceRuntime } from './runtime.ts';
import type { EffectRequest, EffectOutcome } from './executor.ts';

/**
 * Governed Git for an authorized project root.
 *
 * Reads (status, diff) run `git` with every repository-configurable executor
 * disabled (hooks, fsmonitor, external diff, textconv, pager) and a minimal
 * environment. Effects (stage, unstage, commit) are W5 plans: the plan binds
 * the exact paths/message and a digest of the index/worktree state; dispatch
 * refuses (`not_sent`) when that state changed after approval. Commits never
 * run repository hooks (`--no-verify` and an empty hooks path). Nothing here
 * pushes, fetches or touches remotes.
 */
export const PROJECT_GIT_CAPABILITY = parseCapabilityDescriptor({
  schemaVersion: 1, id: 'workspace.project.git', version: 1, createdAt: '2026-09-28T00:00:00.000Z',
  titleKey: 'ws_project_git', descriptionKey: 'ws_project_git_scope', tags: ['project', 'git'],
  inputSchemaId: 'workspace.project.git.input.v1', outputSchemaId: 'workspace.project.git.output.v1',
  effect: 'execute_local', dataDestination: { kind: 'local', id: 'authorized_project_root' },
  availability: 'executable', supportLevel: 'experimental', requiredScopes: ['run:execute', 'project:process:run'],
  retryClass: 'never_automatic',
  limits: { maxSteps: 1, maxCalls: 1, maxOutputTokens: 4096, timeoutMs: 60_000, maxOutputBytes: 1_048_576 },
});

export type GitOperation =
  | { kind: 'stage'; paths: string[] }
  | { kind: 'unstage'; paths: string[] }
  | { kind: 'commit'; message: string };

export interface GitStatusEntry { path: string; index: string; worktree: string; kind: 'changed' | 'renamed' | 'unmerged' | 'untracked' | 'ignored'; origPath?: string }
export interface GitStatus { repository: boolean; branch: string | null; head: string | null; upstream: string | null; ahead: number; behind: number; entries: GitStatusEntry[] }

const OUTPUT_LIMIT = 1_048_576;
let emptyHooksDir: string | null = null;

function hooksDir(): string {
  if (emptyHooksDir && fs.existsSync(emptyHooksDir)) return emptyHooksDir;
  emptyHooksDir = fs.mkdtempSync(path.join(os.tmpdir(), 'uptokey-git-nohooks-'));
  return emptyHooksDir;
}

function gitEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'windir', 'WINDIR', 'HOME', 'USERPROFILE', 'HOMEDRIVE', 'HOMEPATH', 'LANG', 'LC_ALL', 'TEMP', 'TMP', 'COMSPEC', 'PATHEXT'];
  const env: NodeJS.ProcessEnv = {};
  for (const key of keep) if (process.env[key] !== undefined) env[key] = process.env[key];
  env.GIT_TERMINAL_PROMPT = '0';
  env.GIT_OPTIONAL_LOCKS = '0';
  env.GIT_CONFIG_NOSYSTEM = '1';
  return env;
}

/** `git` with repository-configurable executors disabled; argv only, no shell. */
export function runGit(root: string, args: readonly string[], options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<{ code: number; stdout: string; stderr: string; limited: boolean }> {
  const safe = [
    '-c', `core.hooksPath=${hooksDir()}`, '-c', 'core.fsmonitor=false', '-c', `safe.directory=${root.replace(/\\/g, '/')}`,
    '-c', 'diff.external=', '-c', 'core.pager=cat', '-c', 'color.ui=false', '-c', 'core.quotePath=false',
    '-c', 'protocol.allow=never',
  ];
  return new Promise((resolve, reject) => {
    const child = execFile('git', [...safe, ...args], { cwd: root, env: gitEnv(), windowsHide: true, timeout: options.timeoutMs ?? 30_000, maxBuffer: OUTPUT_LIMIT * 2, encoding: 'buffer', ...(options.signal ? { signal: options.signal } : {}) }, (error, stdout, stderr) => {
      const out = Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout ?? '');
      const err = Buffer.isBuffer(stderr) ? stderr : Buffer.from(stderr ?? '');
      const limited = out.byteLength > OUTPUT_LIMIT;
      const code = error && typeof (error as NodeJS.ErrnoException & { code?: unknown }).code === 'number' ? (error as unknown as { code: number }).code : error ? (((error as NodeJS.ErrnoException).code === 'ENOENT') ? -2 : 1) : 0;
      if (error && (error as NodeJS.ErrnoException).code === 'ENOENT') { reject(new WorkspaceError('git_unavailable', 503)); return; }
      if (error && (error as { name?: string }).name === 'AbortError') { reject(new WorkspaceError('git_cancelled', 409)); return; }
      resolve({ code, stdout: out.subarray(0, OUTPUT_LIMIT).toString('utf8'), stderr: err.subarray(0, 16_384).toString('utf8'), limited });
    });
    child.stdin?.end();
  });
}

/** Porcelain v2 with NUL separators: paths with spaces/newlines/Unicode are exact. */
export function parsePorcelainV2(output: string): GitStatus {
  const status: GitStatus = { repository: true, branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;
    if (record.startsWith('# branch.oid ')) status.head = record.slice(13) === '(initial)' ? null : record.slice(13);
    else if (record.startsWith('# branch.head ')) status.branch = record.slice(14) === '(detached)' ? null : record.slice(14);
    else if (record.startsWith('# branch.upstream ')) status.upstream = record.slice(18);
    else if (record.startsWith('# branch.ab ')) { const m = /\+(\d+) -(\d+)/.exec(record); if (m) { status.ahead = Number(m[1]); status.behind = Number(m[2]); } }
    else if (record.startsWith('1 ')) { const parts = record.split(' '); status.entries.push({ kind: 'changed', index: parts[1]![0]!, worktree: parts[1]![1]!, path: parts.slice(8).join(' ') }); }
    else if (record.startsWith('2 ')) { const parts = record.split(' '); status.entries.push({ kind: 'renamed', index: parts[1]![0]!, worktree: parts[1]![1]!, path: parts.slice(9).join(' '), origPath: records[++i] ?? '' }); }
    else if (record.startsWith('u ')) { const parts = record.split(' '); status.entries.push({ kind: 'unmerged', index: parts[1]![0]!, worktree: parts[1]![1]!, path: parts.slice(10).join(' ') }); }
    else if (record.startsWith('? ')) status.entries.push({ kind: 'untracked', index: '?', worktree: '?', path: record.slice(2) });
    else if (record.startsWith('! ')) status.entries.push({ kind: 'ignored', index: '!', worktree: '!', path: record.slice(2) });
  }
  return status;
}

export async function gitStatus(root: string, signal?: AbortSignal): Promise<GitStatus> {
  const probe = await runGit(root, ['rev-parse', '--is-inside-work-tree'], { signal });
  if (probe.code !== 0 || probe.stdout.trim() !== 'true') return { repository: false, branch: null, head: null, upstream: null, ahead: 0, behind: 0, entries: [] };
  const result = await runGit(root, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all'], { signal });
  if (result.code !== 0) throw new WorkspaceError('git_status_failed', 409);
  return parsePorcelainV2(result.stdout);
}

export async function gitDiff(root: string, relativePath: string, staged: boolean, signal?: AbortSignal): Promise<{ diff: string; limited: boolean }> {
  if (!isSafeRelativePath(relativePath)) throw new WorkspaceError('invalid_request');
  const result = await runGit(root, ['diff', '--no-ext-diff', '--no-textconv', '--no-color', ...(staged ? ['--cached'] : []), '--', relativePath], { signal });
  if (result.code !== 0) throw new WorkspaceError('git_diff_failed', 409);
  return { diff: result.stdout, limited: result.limited };
}

function stateDigest(status: GitStatus, operation: GitOperation): string {
  const relevant = operation.kind === 'commit'
    ? status.entries.filter((e) => e.kind !== 'untracked' && e.kind !== 'ignored' && e.index !== '.')
    : status.entries.filter((e) => operation.paths.includes(e.path) || (e.origPath !== undefined && operation.paths.includes(e.origPath)));
  return createHash('sha256').update(JSON.stringify({ head: status.head, branch: status.branch, entries: relevant.map((e) => [e.path, e.origPath ?? '', e.index, e.worktree, e.kind]) })).digest('hex');
}

export function parseGitOperation(value: unknown): GitOperation {
  if (!isDataRecord(value)) throw new WorkspaceError('git_operation_invalid');
  if (value.kind === 'commit') {
    if (Object.keys(value).sort().join(',') !== 'kind,message' || typeof value.message !== 'string') throw new WorkspaceError('git_operation_invalid');
    const message = value.message.replace(/\r\n?/g, '\n').trim();
    if (!message || message.length > 4000) throw new WorkspaceError('git_commit_message_invalid');
    return { kind: 'commit', message };
  }
  if (value.kind === 'stage' || value.kind === 'unstage') {
    if (Object.keys(value).sort().join(',') !== 'kind,paths' || !Array.isArray(value.paths) || value.paths.length < 1 || value.paths.length > 500) throw new WorkspaceError('git_operation_invalid');
    const paths = [...new Set(value.paths as unknown[])].map((p) => {
      if (typeof p !== 'string' || !isSafeRelativePath(p)) throw new WorkspaceError('project_path_traversal_forbidden');
      if (isProtectedProjectPath(p)) throw new WorkspaceError('project_path_protected', 403);
      return p;
    });
    return { kind: value.kind, paths };
  }
  throw new WorkspaceError('git_operation_invalid');
}

/** Durable W5 plan binding the operation and the observed Git state. Nothing runs here. */
export async function prepareGitPlan(runtime: WorkspaceRuntime, principal: string, projectId: string, input: unknown, signal: AbortSignal) {
  if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== 'expectedRevision,operation,rootBindingId' || !Number.isSafeInteger(input.expectedRevision) || typeof input.rootBindingId !== 'string') throw new WorkspaceError('invalid_request');
  const operation = parseGitOperation(input.operation);
  const bundle = await runtime.store.getBundle(principal, projectId), project = bundle.project;
  if (project.revision !== input.expectedRevision) throw new WorkspaceError('workspace_revision_conflict', 409);
  if (bundle.runs.some((item) => ['running', 'needs_attention', 'ready', 'awaiting_approval'].includes(item.run.status))) throw new WorkspaceError('project_run_active', 409);
  await runtime.projectRoot.ensureRootLoaded(input.rootBindingId, runtime.store, principal, projectId);
  const root = runtime.projectRoot.getVerifiedRoot(input.rootBindingId);
  if (root.binding.projectId !== projectId) throw new WorkspaceError('project_root_project_mismatch', 403);
  if (root.binding.accessMode === 'read_only') throw new WorkspaceError('project_root_read_only', 403);
  const status = await gitStatus(root.localPath, signal);
  if (!status.repository) throw new WorkspaceError('git_not_a_repository', 409);
  if (operation.kind === 'commit' && !status.entries.some((e) => e.kind !== 'untracked' && e.kind !== 'ignored' && e.index !== '.')) throw new WorkspaceError('git_nothing_staged', 409);
  const snapshot = await runtime.store.snapshotContext(principal, projectId, { selectedEntryIds: [], selectedArtifactIds: [], excludedEntryIds: project.entries.map((e) => e.id), allowedDestinations: [PROJECT_GIT_CAPABILITY.dataDestination], maxContextBytes: 32000 });
  let plan: ExecutionPlan = {
    schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), projectId, projectRevision: project.revision, contextSnapshotId: snapshot.id,
    contextSnapshotDigest: createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),
    steps: [{ id: 'git', capabilityId: PROJECT_GIT_CAPABILITY.id, capabilityVersion: 1, arguments: {
      root_binding_id: { kind: 'literal', value: input.rootBindingId },
      operation: { kind: 'literal', value: JSON.parse(JSON.stringify(operation)) },
      state_digest: { kind: 'literal', value: stateDigest(status, operation) },
      objective: { kind: 'literal', value: operation.kind === 'commit' ? `git commit: ${operation.message.split('\n')[0]!.slice(0, 120)}` : `git ${operation.kind}: ${operation.paths.slice(0, 5).join(', ')}${operation.paths.length > 5 ? ` (+${operation.paths.length - 5})` : ''}` },
    } }],
    limits: { ...PROJECT_GIT_CAPABILITY.limits }, digest: '0'.repeat(64),
  };
  plan = parseExecutionPlan({ ...plan, digest: computePlanDigest(plan) });
  validatePlanBindings(plan, snapshot, runtime.registry().forPlan(plan));
  await runtime.store.putPlan(principal, plan, snapshot);
  return runtime.viewPlan(principal, projectId, plan.id);
}

/** Executes an approved Git plan if the observed state is unchanged. */
export async function dispatchGit(runtime: WorkspaceRuntime, effect: EffectRequest): Promise<EffectOutcome> {
  const value = (key: string) => effect.arguments[key]?.kind === 'literal' ? effect.arguments[key].value : undefined;
  const rootBindingId = value('root_binding_id');
  if (typeof rootBindingId !== 'string') return { kind: 'not_sent', code: 'git_input_invalid' };
  let operation: GitOperation;
  try { operation = parseGitOperation(value('operation')); } catch { return { kind: 'not_sent', code: 'git_input_invalid' }; }
  await runtime.projectRoot.ensureRootLoaded(rootBindingId, runtime.store, effect.principalId, effect.projectId);
  const root = runtime.projectRoot.getVerifiedRoot(rootBindingId);
  if (root.binding.projectId !== effect.projectId || root.binding.revokedAt || root.binding.accessMode === 'read_only') return { kind: 'not_sent', code: 'project_root_unavailable' };
  const status = await gitStatus(root.localPath, effect.signal);
  if (!status.repository || stateDigest(status, operation) !== value('state_digest')) return { kind: 'not_sent', code: 'git_state_changed' };
  effect.signal.throwIfAborted();
  const args = operation.kind === 'stage' ? ['add', '--', ...operation.paths]
    : operation.kind === 'unstage' ? (status.head ? ['restore', '--staged', '--', ...operation.paths] : ['rm', '--cached', '-q', '--', ...operation.paths])
    : ['commit', '--no-verify', '--cleanup=strip', '-m', operation.message];
  const result = await runGit(root.localPath, args, { signal: effect.signal, timeoutMs: 60_000 });
  const after = await gitStatus(root.localPath).catch(() => null);
  const artifactId = randomUUID();
  const report = { operation, exitCode: result.code, stdout: result.stdout.slice(0, 16_384), stderr: result.stderr.slice(0, 8_192), headBefore: status.head, headAfter: after?.head ?? null, branch: after?.branch ?? status.branch };
  return { kind: 'completed', artifacts: [{ artifactId, mediaType: 'application/json', bytes: new TextEncoder().encode(JSON.stringify(report)) }], outputArtifactRefs: [artifactId], sources: [] };
}
