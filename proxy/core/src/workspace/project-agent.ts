import { createHash, randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  parseProjectTaskSpec,
  parseProjectTask,
  parseRunAuthority,
  type ProjectTaskSpec,
  type ProjectTask,
  type RunAuthority,
  type ProjectVerificationReport,
  type ProjectChangeSet
} from '@uptokey/sync-contract/project-agent';
import { ProjectRootService, isProtectedProjectPath } from './project-root-service.ts';
import { ProjectWriteService, type AppliedWriteReceipt } from './project-write-service.ts';
import { ProjectRunnerService } from './project-runner-service.ts';
import { ProjectPreviewService } from './project-preview-service.ts';

export class ProjectAgentError extends Error {
  readonly status: number;
  readonly code?: string;
  constructor(message: string, status: number = 400, code?: string) {
    super(message);
    this.status = status;
    this.code = code;
    this.name = 'ProjectAgentError';
  }
}

export interface DispatchChildRunParams {
  readonly taskId: string;
  readonly rootRunId: string;
  readonly childPlanDigest: string;
  readonly inferenceCalls: number;
  readonly outputTokens: number;
  readonly changeBytes: number;
}

export interface DispatchedChildRunResult {
  readonly runId: string;
  readonly authority: RunAuthority;
  readonly iteration: number;
  readonly remainingBudget: {
    readonly iterations: number;
    readonly inferenceCalls: number;
    readonly outputTokens: number;
    readonly totalChangeBytes: number;
  };
}

/**
 * Portable, dependency-free in-memory PKZip file generator for reliable project exports.
 */
export function buildZipArchive(files: Array<{ name: string; content: Buffer | string }>): Buffer {
  const localHeaders: Buffer[] = [];
  const centralHeaders: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const data = Buffer.isBuffer(file.content) ? file.content : Buffer.from(file.content, 'utf8');
    const nameBuffer = Buffer.from(file.name.replace(/\\/g, '/'), 'utf8');
    const crc = computeCrc32(data);

    // Local file header (30 bytes + name length)
    const localHeader = Buffer.alloc(30 + nameBuffer.length);
    localHeader.writeUInt32LE(0x04034b50, 0); // signature
    localHeader.writeUInt16LE(20, 4);         // version needed
    localHeader.writeUInt16LE(0, 6);          // flags
    localHeader.writeUInt16LE(0, 8);          // compression (0 = stored)
    localHeader.writeUInt16LE(0, 10);         // mod time
    localHeader.writeUInt16LE(0, 12);         // mod date
    localHeader.writeUInt32LE(crc, 14);       // crc-32
    localHeader.writeUInt32LE(data.length, 18); // compressed size
    localHeader.writeUInt32LE(data.length, 22); // uncompressed size
    localHeader.writeUInt16LE(nameBuffer.length, 26); // filename length
    localHeader.writeUInt16LE(0, 28);         // extra field length
    nameBuffer.copy(localHeader, 30);

    localHeaders.push(localHeader, data);

    // Central directory header (46 bytes + name length)
    const centralHeader = Buffer.alloc(46 + nameBuffer.length);
    centralHeader.writeUInt32LE(0x02014b50, 0); // signature
    centralHeader.writeUInt16LE(20, 4);          // version made by
    centralHeader.writeUInt16LE(20, 6);          // version needed
    centralHeader.writeUInt16LE(0, 8);           // flags
    centralHeader.writeUInt16LE(0, 10);          // compression
    centralHeader.writeUInt16LE(0, 12);          // mod time
    centralHeader.writeUInt16LE(0, 14);          // mod date
    centralHeader.writeUInt32LE(crc, 16);        // crc-32
    centralHeader.writeUInt32LE(data.length, 20); // compressed size
    centralHeader.writeUInt32LE(data.length, 24); // uncompressed size
    centralHeader.writeUInt16LE(nameBuffer.length, 28); // filename length
    centralHeader.writeUInt16LE(0, 30);          // extra field length
    centralHeader.writeUInt16LE(0, 32);          // file comment length
    centralHeader.writeUInt16LE(0, 34);          // disk number start
    centralHeader.writeUInt16LE(0, 36);          // internal file attributes
    centralHeader.writeUInt32LE(0, 38);          // external file attributes
    centralHeader.writeUInt32LE(offset, 42);     // relative offset of local header
    nameBuffer.copy(centralHeader, 46);

    centralHeaders.push(centralHeader);
    offset += localHeader.length + data.length;
  }

  const centralDirOffset = offset;
  const centralDirSize = centralHeaders.reduce((sum, h) => sum + h.length, 0);

  // End of central directory record (22 bytes)
  const endRecord = Buffer.alloc(22);
  endRecord.writeUInt32LE(0x06054b50, 0);     // signature
  endRecord.writeUInt16LE(0, 4);              // number of this disk
  endRecord.writeUInt16LE(0, 6);              // disk where central dir starts
  endRecord.writeUInt16LE(files.length, 8);   // records on this disk
  endRecord.writeUInt16LE(files.length, 10);  // total records
  endRecord.writeUInt32LE(centralDirSize, 12); // size of central directory
  endRecord.writeUInt32LE(centralDirOffset, 16); // offset of start of central directory
  endRecord.writeUInt16LE(0, 20);             // comment length

  return Buffer.concat([...localHeaders, ...centralHeaders, endRecord]);
}

function computeCrc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    crc ^= buf[i]!;
    for (let j = 0; j < 8; j++) {
      crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

export class ProjectAgentCoordinator {
  private readonly tasks = new Map<string, { spec: ProjectTaskSpec; task: ProjectTask; startedAt: number }>();
  private readonly dispatches = new Map<string, DispatchedChildRunResult>();
  private readonly rootService: ProjectRootService;
  private readonly writeService: ProjectWriteService;
  private readonly runnerService: ProjectRunnerService;
  private readonly previewService: ProjectPreviewService;

  constructor(
    rootService: ProjectRootService,
    writeService: ProjectWriteService,
    runnerService: ProjectRunnerService,
    previewService: ProjectPreviewService
  ) {
    this.rootService = rootService;
    this.writeService = writeService;
    this.runnerService = runnerService;
    this.previewService = previewService;
  }

  admitTask(specInput: unknown, rootRunId: string): ProjectTask {
    const spec = parseProjectTaskSpec(specInput);
    const root = this.rootService.getRoot(spec.rootBindingId);
    if (!root) throw new ProjectAgentError('project_root_not_found', 404);
    if (root.binding.revokedAt) throw new ProjectAgentError('project_root_revoked', 403);

    const taskId = spec.id;
    if (this.tasks.has(taskId)) {
      return this.tasks.get(taskId)!.task;
    }

    const taskRaw = {
      specRef: spec.digest,
      authorityRef: `auth-${rootRunId}`,
      revision: 1,
      status: 'running' as const,
      iteration: 0,
      childRunIds: [],
      currentRunId: rootRunId,
      budgetReservations: {
        iterationsUsed: 0,
        inferenceCallsUsed: 0,
        outputTokensUsed: 0,
        totalChangeBytesUsed: 0
      },
      writeOperationRefs: [],
      resultRefs: [],
      updatedAt: new Date().toISOString()
    };

    const task = parseProjectTask(taskRaw);
    this.tasks.set(taskId, { spec, task, startedAt: Date.now() });
    return task;
  }

  getTask(taskId: string): { spec: ProjectTaskSpec; task: ProjectTask } | undefined {
    const entry = this.tasks.get(taskId);
    if (!entry) return undefined;
    return { spec: entry.spec, task: entry.task };
  }

  dispatchChildRun(params: DispatchChildRunParams): DispatchedChildRunResult {
    const entry = this.tasks.get(params.taskId);
    if (!entry) throw new ProjectAgentError('project_task_not_found', 404);

    const { spec, task, startedAt } = entry;
    this.rootService.getVerifiedRoot(spec.rootBindingId);
    if(task.status==='cancelled'||task.status==='succeeded')throw new ProjectAgentError('project_task_terminal',409);
    if(task.authorityRef!==`auth-${params.rootRunId}`)throw new ProjectAgentError('project_task_authority_mismatch',403);
    if([params.inferenceCalls,params.outputTokens,params.changeBytes].some(value=>!Number.isSafeInteger(value)||value<0)) {
      throw new ProjectAgentError('project_task_budget_invalid',400);
    }
    const { limits } = spec;

    // Strict time limit check
    if (Date.now() - startedAt > limits.timeoutMs) {
      throw new ProjectAgentError('project_task_timeout_exceeded', 429, 'timeout_exceeded');
    }

    // Monotonic budget check
    const nextIteration = task.iteration + 1;
    if (nextIteration > limits.maxIterations) {
      throw new ProjectAgentError('project_task_max_iterations_exceeded', 429, 'budget_exhausted');
    }

    const nextCalls = task.budgetReservations.inferenceCallsUsed + params.inferenceCalls;
    if (nextCalls > limits.maxInferenceCalls) {
      throw new ProjectAgentError('project_task_max_inference_calls_exceeded', 429, 'budget_exhausted');
    }

    const nextTokens = task.budgetReservations.outputTokensUsed + params.outputTokens;
    if (nextTokens > limits.maxAggregateOutputTokens) {
      throw new ProjectAgentError('project_task_max_tokens_exceeded', 429, 'budget_exhausted');
    }

    const nextBytes = task.budgetReservations.totalChangeBytesUsed + params.changeBytes;
    if (nextBytes > limits.maxTotalChangeBytes) {
      throw new ProjectAgentError('project_task_max_change_bytes_exceeded', 429, 'budget_exhausted');
    }

    const childRunId = `run-child-${randomUUID()}`;
    const reservationId = `res-${randomUUID()}`;

    const authorityRaw = {
      kind: 'project_task_delegation' as const,
      taskId: params.taskId,
      rootRunId: params.rootRunId,
      specDigest: spec.digest,
      childPlanDigest: params.childPlanDigest,
      reservationId,
      iteration: nextIteration
    };

    const authority = parseRunAuthority(authorityRaw);

    // Update task budget reservations
    const updatedTask = parseProjectTask({
      ...task,
      revision: task.revision + 1,
      iteration: nextIteration,
      childRunIds: [...task.childRunIds, childRunId],
      currentRunId: childRunId,
      budgetReservations: {
        iterationsUsed: nextIteration,
        inferenceCallsUsed: nextCalls,
        outputTokensUsed: nextTokens,
        totalChangeBytesUsed: nextBytes
      },
      updatedAt: new Date().toISOString()
    });

    this.tasks.set(params.taskId, { spec, task: updatedTask, startedAt });

    const result: DispatchedChildRunResult = {
      runId: childRunId,
      authority,
      iteration: nextIteration,
      remainingBudget: {
        iterations: limits.maxIterations - nextIteration,
        inferenceCalls: limits.maxInferenceCalls - nextCalls,
        outputTokens: limits.maxAggregateOutputTokens - nextTokens,
        totalChangeBytes: limits.maxTotalChangeBytes - nextBytes
      }
    };

    this.dispatches.set(childRunId, result);
    return result;
  }

  recordVerification(taskId: string, report: ProjectVerificationReport): ProjectTask {
    const entry = this.tasks.get(taskId);
    if (!entry) throw new ProjectAgentError('project_task_not_found', 404);

    const hasFailure = report.checks.some(c => c.status === 'fail');
    const allPassed = report.checks.length > 0 && report.checks.every(c => c.status === 'pass');

    const nextStatus = allPassed ? 'succeeded' : (hasFailure ? 'needs_attention' : 'running');

    const updatedTask = parseProjectTask({
      ...entry.task,
      revision: entry.task.revision + 1,
      status: nextStatus,
      lastVerification: report,
      updatedAt: new Date().toISOString()
    });

    this.tasks.set(taskId, { spec: entry.spec, task: updatedTask, startedAt: entry.startedAt });
    return updatedTask;
  }

  cancelTask(taskId: string): ProjectTask {
    const entry = this.tasks.get(taskId);
    if (!entry) throw new ProjectAgentError('project_task_not_found', 404);

    const updatedTask = parseProjectTask({
      ...entry.task,
      revision: entry.task.revision + 1,
      status: 'cancelled',
      currentRunId: null,
      updatedAt: new Date().toISOString()
    });

    this.tasks.set(taskId, { spec: entry.spec, task: updatedTask, startedAt: entry.startedAt });
    return updatedTask;
  }

  exportZip(rootBindingId: string): Buffer {
    const root = this.rootService.getVerifiedRoot(rootBindingId);

    const filesToArchive: Array<{ name: string; content: Buffer }> = [];
    const walk = (relDir: string) => {
      const absDir = relDir === '' ? root.localPath : path.join(root.localPath, relDir);
      const items = fs.readdirSync(absDir, { withFileTypes: true });

      for (const item of items) {
        const itemRel = relDir === '' ? item.name : `${relDir}/${item.name}`;
        if (isProtectedProjectPath(itemRel)) continue;

        // Exclude internal directories
        if (item.name === '.git' || item.name === 'node_modules' || item.name === 'dist' ||
            item.name === '__pycache__' || item.name === '.venv' || item.name === '.uptokey-preimages') {
          continue;
        }

        // Security rule: Never export sensitive files with real values (.env, etc.)!
        if (item.name.toLowerCase() === '.env' || item.name.toLowerCase() === '.env.local') {
          continue;
        }

        if (item.isDirectory()) {
          walk(itemRel);
        } else if (item.isFile()) {
          const absFile = this.rootService.resolveVerifiedPath(rootBindingId, itemRel);
          const stat=fs.statSync(absFile);
          if(stat.size>8*1024*1024||filesToArchive.length>=1000||filesToArchive.reduce((sum,file)=>sum+file.content.length,0)+stat.size>32*1024*1024) {
            throw new ProjectAgentError('project_export_limit_exceeded',413);
          }
          const buf = fs.readFileSync(absFile);
          filesToArchive.push({ name: itemRel, content: buf });
        }
      }
    };

    walk('');
    return buildZipArchive(filesToArchive);
  }

  inspectGit(rootBindingId: string): { isGitRepo: boolean; headCommit?: string; branch?: string } {
    const root = this.rootService.getVerifiedRoot(rootBindingId);

    const gitDir = this.rootService.resolveVerifiedPath(rootBindingId, '.git');
    if (!fs.existsSync(gitDir) || !fs.statSync(gitDir).isDirectory()) {
      return { isGitRepo: false };
    }

    try {
      const headFile = this.rootService.resolveVerifiedPath(rootBindingId, '.git/HEAD');
      if (fs.existsSync(headFile)) {
        const headContent = fs.readFileSync(headFile, 'utf8').trim();
        if (headContent.startsWith('ref: refs/heads/')) {
          const branch = headContent.replace('ref: refs/heads/', '');
          return { isGitRepo: true, branch };
        }
        return { isGitRepo: true, headCommit: headContent.slice(0, 40) };
      }
      return { isGitRepo: true };
    } catch {
      return { isGitRepo: true };
    }
  }

  performSyntaxPreflight(changeSet: ProjectChangeSet): { ok: boolean; issues: Array<{ path: string; message: string }> } {
    const issues: Array<{ path: string; message: string }> = [];

    for (const op of changeSet.operations) {
      if ((op.type === 'create' || op.type === 'replace') && typeof op.content === 'string') {
        const ext = path.extname(op.path).toLowerCase();
        if (ext === '.json') {
          try {
            JSON.parse(op.content);
          } catch (e: any) {
            issues.push({ path: op.path, message: `JSON syntax error: ${e?.message || 'Invalid JSON'}` });
          }
        }
        if (ext === '.html' || ext === '.htm') {
          const unclosed: string[] = [];
          const voidTags = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input', 'link', 'meta', 'param', 'source', 'track', 'wbr']);
          const tagRegex = /<\/?([a-zA-Z0-9]+)(?:\s+[^>]*)?>/g;
          let match: RegExpExecArray | null;
          while ((match = tagRegex.exec(op.content)) !== null) {
            const raw = match[0];
            const name = match[1]!.toLowerCase();
            if (voidTags.has(name) || raw.endsWith('/>')) continue;
            if (raw.startsWith('</')) {
              const last = unclosed.pop();
              if (last && last !== name) {
                issues.push({ path: op.path, message: `Mismatched tag: </${name}> does not match <${last}>` });
              }
            } else {
              unclosed.push(name);
            }
          }
          if (unclosed.length > 0) {
            issues.push({ path: op.path, message: `Unclosed tag: <${unclosed[unclosed.length - 1]}> was not closed` });
          }
        }
      }
    }

    return {
      ok: issues.length === 0,
      issues
    };
  }

  runInProcessStaticCheck(rootBindingId: string): { passed: boolean; verifiedFiles: number; details?: string } {
    const root = this.rootService.getVerifiedRoot(rootBindingId);
    let count = 0;
    const walk = (relDir: string) => {
      const absDir = relDir === '' ? root.localPath : path.join(root.localPath, relDir);
      for (const item of fs.readdirSync(absDir, { withFileTypes: true })) {
        const itemRel = relDir === '' ? item.name : `${relDir}/${item.name}`;
        if (item.isDirectory() && !['.git', 'node_modules', 'dist', '__pycache__'].includes(item.name)) {
          walk(itemRel);
        } else if (item.isFile()) {
          const absFile = path.join(root.localPath, itemRel);
          if (item.name.endsWith('.json')) {
            const content = fs.readFileSync(absFile, 'utf8');
            JSON.parse(content);
            count++;
          } else if (item.name.endsWith('.html') || item.name.endsWith('.md')) {
            count++;
          }
        }
      }
    };
    try {
      walk('');
      return { passed: true, verifiedFiles: count };
    } catch (e: any) {
      return { passed: false, verifiedFiles: count, details: e?.message || 'Static check failed' };
    }
  }
}
