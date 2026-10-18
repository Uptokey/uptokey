/**
 * Canonical W0 contracts for conversational project creation and management in authorized workspace directories.
 * Part of Etapa 19 (19A-19G).
 */

export const PROJECT_AGENT_CONTRACT_VERSION: 1;

export type ProjectAccessMode = 'read_write' | 'read_only';

export interface ProjectRootBinding {
  readonly id: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly revision: number;
  readonly displayName: string;
  readonly rootIdentityDigest: string;
  readonly grantedAt: string;
  readonly expiresAt: string;
  readonly revokedAt?: string | null;
  readonly accessMode: ProjectAccessMode;
}

export type ProjectTaskMode = 'supervised' | 'bounded';

export interface ProjectTaskLimits {
  readonly maxIterations: number;
  readonly maxInferenceCalls: number;
  readonly maxAggregateOutputTokens: number;
  readonly timeoutMs: number;
  readonly maxFiles: number;
  readonly maxFileSizeBytes: number;
  readonly maxTotalChangeBytes: number;
}

export interface ProjectTaskSpec {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly rootBindingId: string;
  readonly rootBindingRevision: number;
  readonly rootIdentityDigest: string;
  readonly objective: string;
  readonly mode: ProjectTaskMode;
  readonly allowedCapabilityIds: readonly string[];
  readonly allowedDestinations: readonly string[];
  readonly runtimeProfileIds: readonly string[];
  readonly filePolicy: {
    readonly allowedExtensions: readonly string[];
    readonly excludedPaths: readonly string[];
    readonly allowHidden: boolean;
  };
  readonly networkPolicy: 'none' | 'isolated_loopback' | 'allowlist';
  readonly installPolicy: 'none' | 'lockfile_only' | 'explicit_approval';
  readonly limits: ProjectTaskLimits;
  readonly acceptanceSpecRef: string;
  readonly digest: string;
}

export type ProjectFileKind = 'file' | 'directory';
export type ProjectFileSensitivity = 'public' | 'protected' | 'secret';

export interface ProjectFileManifestEntry {
  readonly relativePath: string;
  readonly kind: ProjectFileKind;
  readonly language?: string;
  readonly mediaType?: string;
  readonly byteLength: number;
  readonly sha256: string;
  readonly contentArtifactRef?: string | null;
  readonly empty?: boolean;
  readonly sensitivity?: ProjectFileSensitivity;
  readonly protectedRef?: string;
}

export interface ProjectFileManifest {
  readonly id: string;
  readonly projectId: string;
  readonly rootBindingId: string;
  readonly snapshotDigest: string;
  readonly entries: readonly ProjectFileManifestEntry[];
}

export interface ProjectPatchChunk {
  readonly startLine: number;
  readonly deleteCount: number;
  readonly newLines: readonly string[];
}

/** `delete` removes one file whose current bytes match `expectedSha256`; the writer keeps a preimage. */
export type ProjectChangeOperationType = 'mkdir' | 'create' | 'replace' | 'move' | 'patch_lines' | 'delete';

export interface ProjectChangeOperation {
  readonly type: ProjectChangeOperationType;
  readonly path: string;
  readonly fromPath?: string;
  readonly expectedSha256?: string;
  readonly newSha256?: string;
  readonly content?: string;
  readonly patches?: readonly ProjectPatchChunk[];
}

export interface ProjectTreeDigestEntry {
  readonly path: string;
  readonly sha256: string;
  readonly size: number;
}

export interface ProjectTreeDigest {
  readonly rootDigest: string;
  readonly entries: readonly ProjectTreeDigestEntry[];
}

export interface ProjectSymbolOutlineEntry {
  readonly name: string;
  readonly kind: 'function' | 'class' | 'interface' | 'variable' | 'export';
  readonly line: number;
}

export interface ProjectFileOutline {
  readonly path: string;
  readonly symbols: readonly ProjectSymbolOutlineEntry[];
}

export interface ProjectChangeSet {
  readonly id: string;
  readonly taskId: string;
  readonly baseManifestDigest: string;
  readonly revision: number;
  readonly operations: readonly ProjectChangeOperation[];
  readonly digest: string;
}

export interface ProjectRunRequest {
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly runtimeProfileId: string;
  readonly actionId: string;
  readonly relativeWorkingDirectory: string;
  readonly artifactInputRefs: readonly string[];
  readonly timeoutMs: number;
  readonly outputLimitBytes: number;
  /** Only with `actionId: 'exec'`: structured argv run inside the isolated runtime (no shell). */
  readonly argv?: readonly string[];
  /** Opt-in disposable writable OCI snapshot. Only exact outputs may be proposed for promotion. */
  readonly execution?: {
    readonly writable: true;
    readonly outputPaths: readonly string[];
    /** Exact approved HTTPS artifacts, integrity checked and staged for offline installation. No container network. */
    readonly dependencies?: readonly {readonly url:string;readonly sha256:string;readonly path:string}[];
    readonly resources?: {readonly cpus:number;readonly memoryMiB:number;readonly diskMiB:number};
  };
}

export type ProjectTaskStatus =
  | 'draft'
  | 'awaiting_approval'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'needs_attention'
  | 'blocked_dependency';

export interface ProjectTaskBudgetReservations {
  readonly iterationsUsed: number;
  readonly inferenceCallsUsed: number;
  readonly outputTokensUsed: number;
  readonly totalChangeBytesUsed: number;
}

export interface ProjectTask {
  readonly specRef: string;
  readonly authorityRef: string;
  readonly revision: number;
  readonly status: ProjectTaskStatus;
  readonly iteration: number;
  readonly childRunIds: readonly string[];
  readonly currentRunId: string | null;
  readonly budgetReservations: ProjectTaskBudgetReservations;
  readonly writeOperationRefs: readonly string[];
  readonly resultRefs: readonly string[];
  readonly lastVerification?: ProjectVerificationReport | null;
  readonly nextAction?: string;
  readonly updatedAt: string;
}

export type ProjectCheckStatus = 'pass' | 'fail' | 'blocked' | 'not_run';

export interface ProjectCheckResult {
  readonly id: string;
  readonly method: string;
  readonly command?: string;
  readonly exitCode?: number;
  readonly expected: string;
  readonly observed: string;
  readonly artifactRefs: readonly string[];
  readonly status: ProjectCheckStatus;
}

export interface ProjectVerificationReport {
  readonly taskId: string;
  readonly runId: string;
  readonly manifestDigest: string;
  readonly runtimeFingerprint: string;
  readonly checks: readonly ProjectCheckResult[];
}

export type ProjectPreviewStatus = 'starting' | 'running' | 'stopped' | 'expired';

export interface ProjectPreviewSession {
  readonly id: string;
  readonly taskId: string;
  readonly manifestDigest: string;
  readonly runtimeJobRef: string | null;
  readonly origin: string;
  readonly allowedResourceIds: readonly string[];
  readonly expiresAt: string;
  readonly status: ProjectPreviewStatus;
}

export type RunAuthority =
  | { readonly kind: 'plan_approval'; readonly approvalId: string }
  | {
      readonly kind: 'project_task_delegation';
      readonly taskId: string;
      readonly rootRunId: string;
      readonly specDigest: string;
      readonly childPlanDigest: string;
      readonly reservationId: string;
      readonly iteration: number;
    };

export function isSafeRelativePath(value: unknown): boolean;
export function parseProjectRootBinding(input: unknown): Readonly<ProjectRootBinding>;
export function parseProjectTaskSpec(input: unknown): Readonly<ProjectTaskSpec>;
export function computeProjectTaskSpecDigest(input: Omit<ProjectTaskSpec, 'digest'>): string;
export function parseProjectFileManifest(input: unknown): Readonly<ProjectFileManifest>;
export function parseProjectChangeSet(input: unknown): Readonly<ProjectChangeSet>;
export function computeProjectChangeSetDigest(input: Omit<ProjectChangeSet, 'digest'>): string;
export function computeTreeDigest(entries: readonly ProjectTreeDigestEntry[]): Readonly<ProjectTreeDigest>;
export function extractSymbolOutline(filePath: string, content: string): Readonly<ProjectFileOutline>;
export function parseProjectRunRequest(input: unknown): Readonly<ProjectRunRequest>;
export function parseProjectTask(input: unknown): Readonly<ProjectTask>;
export function parseProjectVerificationReport(input: unknown): Readonly<ProjectVerificationReport>;
export function parseProjectPreviewSession(input: unknown): Readonly<ProjectPreviewSession>;
export function parseRunAuthority(input: unknown): Readonly<RunAuthority>;
