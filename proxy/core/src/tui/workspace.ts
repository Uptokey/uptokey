/**
 * Uptokey TUI — Workspace service.
 * Interfaces with the proxy-local workspace HTTP API for projects, conversations,
 * plans, runs, roots, W5 operations, gateway chat plans and governed tool plans.
 *
 * Authority stays in the core: this service only prepares, consents, observes and
 * reads canonical artifacts. It never executes a tool, writes a file or invents a
 * receipt on its own.
 */
import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { computeProjectChangeSetDigest, type ProjectChangeOperation, type ProjectChangeOperationType } from "@uptokey/sync-contract/project-agent";
import { parseGatewayChatRequest, parseGatewayToolPlanRequest, parseGatewayToolResultPlanRequest, type GatewayChatRequest, type GatewayToolPlanRequest, type GatewayToolResultPlanRequest } from "@uptokey/sync-contract/gateway";
import { parseFilesystemCatalog, type FilesystemCatalog } from "@uptokey/sync-contract/filesystem";
import { RUN_STATUSES, type RunStatus } from "@uptokey/sync-contract/workflow";
import type { TuiClient } from "./client.ts";

export interface Project {
  id: string;
  name: string;
  status?: string;
  goal?: string;
  revision?: number;
  rootBindings?: RootBinding[];
  createdAt?: string;
  updatedAt?: string;
}

/** Strict projection of a core root binding; the local path never comes back. */
export interface RootBindingView {
  id: string;
  projectId: string;
  displayName: string;
  rootIdentityDigest: string;
  accessMode: "read_write" | "read_only";
  expiresAt: string;
  revokedAt: string | null;
  revision: number;
}

export interface RootBinding {
  id: string;
  path?: string;
  localAbsolutePath?: string;
  displayName?: string;
  status?: string;
}

export interface Plan {
  id: string;
  digest?: string;
  projectId?: string;
  type?: string;
  status?: string;
  summary?: string;
  changes?: PlanChange[];
  createdAt?: string;
}

export interface PlanChange {
  path: string;
  type: "create" | "modify" | "delete";
  hunks?: Array<{ oldStart: number; newStart: number; lines: string[] }>;
}

export interface Run {
  id: string;
  planId: string;
  status: string;
  requestId?: string;
  startedAt?: string;
  completedAt?: string;
  error?: string;
}

export interface WorkspaceReceiptRef {
  id: string;
  runId: string;
  stepId?: string;
  attemptId?: string;
  capabilityId?: string;
  status: string;
  /** Code of a failed attempt (bounded, never provider text). */
  errorCode?: string;
  outputArtifactRefs: string[];
}

export interface WorkspaceArtifactRef {
  id: string;
  projectId?: string;
  runId?: string;
  mediaType?: string;
}

export interface WorkspacePlanStep {
  id?: string;
  capabilityId?: string;
  arguments?: Readonly<Record<string, unknown>>;
}

export interface WorkspacePlanRef {
  id: string;
  digest: string;
  projectId?: string;
  steps: WorkspacePlanStep[];
}

export interface WorkspacePreview {
  runId: string;
  attemptId: string;
  sequence: number;
  text: string;
  truncated: boolean;
}

/** Minimal, strict projection of the canonical project view used by the TUI. */
export interface WorkspaceView {
  projectId: string;
  revision: number;
  plan: WorkspacePlanRef | null;
  run: Run | null;
  receipts: WorkspaceReceiptRef[];
  artifact: WorkspaceArtifactRef | null;
  gatewayPreview?: WorkspacePreview | null;
}

export interface RunAttentionReview {
  view: WorkspaceView;
  write?: { digest: string; expectedRunRevision: number; entries: Array<{ path: string; state: string }> };
}

export interface ConsentChallenge {
  challengeId: string;
  nonce: string;
  digest?: string;
  effect?: string[];
}

export interface RunCommand {
  planId: string;
  planDigest: string;
  requestId: string;
}

/** Conversation intention (outbox request of a user message) that admits a run. */
export interface ConversationAdmission {
  conversationId: string;
  requestId: string;
}

export interface ProjectTextFile {
  relativePath: string;
  text: string;
  sha256: string;
  byteLength: number;
  mediaType: string;
  language?: string;
}

export interface ProjectTextFileRange extends Omit<ProjectTextFile, 'sha256'> {
  sha256: string | null;
  rangeSha256: string;
  rangeByteLength: number;
  startLine: number;
  endLine: number;
  totalLines: number | null;
  nextLine: number | null;
  scannedBytes: number;
}

export interface ProjectDirectoryPage {
  relativePath: string;
  entries: Array<{ relativePath: string; kind: "file" | "directory"; byteLength: number }>;
  nextOffset: number | null;
}

export interface ProjectManifestEntry {
  relativePath: string;
  kind: "file" | "directory";
  sha256: string | null;
  byteLength: number;
  sensitivity: string;
}

export interface ProjectManifest {
  snapshotDigest: string;
  entries: ProjectManifestEntry[];
  /** Exact manifest as returned by the core (bound into run plans unchanged). */
  raw: Record<string, unknown>;
}

export interface ProjectChangeSetInput {
  id: string;
  taskId: string;
  baseManifestDigest: string;
  revision: number;
  digest: string;
  operations: ProjectChangeOperation[];
}

export interface ChangePreflight {
  entries: Array<{ path: string; operation: string; status: string; baseSha256: string | null }>;
  issues: Array<{ path: string; code: string }>;
}

export interface ProjectRunRequestInput {
  taskId: string;
  manifestDigest: string;
  runtimeProfileId: string;
  actionId: string;
  relativeWorkingDirectory: string;
  artifactInputRefs: string[];
  timeoutMs: number;
  outputLimitBytes: number;
  execution?: { readonly writable: true; readonly outputPaths: readonly string[]; readonly dependencies?: readonly { readonly url: string; readonly sha256: string; readonly path: string }[] };
}

export interface RuntimeProfile {
  id: string;
  name: string;
  available: boolean;
  isolation: string;
  runtime: string;
  diagnostic?: string;
  defaultActions: string[];
}

export type GitOperationInput = { kind: "stage" | "unstage"; paths: string[] } | { kind: "commit"; message: string };

export interface GitStatusView {
  repository: boolean;
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  entries: Array<{ path: string; index: string; worktree: string; kind: string; origPath?: string }>;
}

export type ProjectTaskStatus = "ready" | "running" | "succeeded" | "blocked" | "needs_attention" | "cancelled" | "expired";
export interface ProjectTaskChildView {
  planId: string;
  requestId: string;
  runId: string | null;
  status: string;
  receiptIds: string[];
  artifactIds: string[];
}
export interface ProjectTaskView {
  id: string;
  objective: string;
  status: ProjectTaskStatus;
  rootRunId: string;
  rootBindingId: string;
  blockedReason: string | null;
  children: ProjectTaskChildView[];
  limits: { maxCalls: number; maxOutputTokens: number; timeoutMs: number };
  expiresAt: string;
}

const TASK_STATUSES: readonly string[] = ["ready", "running", "succeeded", "blocked", "needs_attention", "cancelled", "expired"];
const TASK_ID = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;

/** Validates the core projection; unknown shapes are refused, never guessed. */
export function parseProjectTaskView(value: unknown): ProjectTaskView {
  const fail = (): never => { throw new WorkspaceServiceError("project_task_invalid"); };
  if (!isRecord(value) || typeof value.id !== "string" || !TASK_ID.test(value.id) || typeof value.status !== "string" || !TASK_STATUSES.includes(value.status)
    || typeof value.objective !== "string" || typeof value.rootRunId !== "string" || typeof value.rootBindingId !== "string" || !Array.isArray(value.children)) return fail();
  const grant = isRecord(value.grant) ? value.grant : {};
  const limits = isRecord(value.limits) ? value.limits : {};
  const children = value.children.map((c): ProjectTaskChildView => {
    if (!isRecord(c) || typeof c.planId !== "string" || typeof c.requestId !== "string" || (c.runId !== null && typeof c.runId !== "string") || typeof c.status !== "string") return fail();
    const ids = (v: unknown) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
    return { planId: c.planId, requestId: c.requestId, runId: c.runId as string | null, status: c.status, receiptIds: ids(c.receiptIds), artifactIds: ids(c.artifactIds) };
  });
  const num = (v: unknown) => typeof v === "number" && Number.isFinite(v) ? v : 0;
  return {
    id: value.id, objective: value.objective, status: value.status as ProjectTaskStatus, rootRunId: value.rootRunId, rootBindingId: value.rootBindingId,
    blockedReason: typeof value.blockedReason === "string" ? value.blockedReason : null, children,
    limits: { maxCalls: num(limits.maxCalls), maxOutputTokens: num(limits.maxOutputTokens), timeoutMs: num(limits.timeoutMs) },
    expiresAt: typeof grant.expiresAt === "string" ? grant.expiresAt : "",
  };
}

/** Structured `{error:{type}}` code when present, otherwise the fallback. */
async function errorCode(res: Response, fallback: string): Promise<string> {
  try {
    const body = await res.json() as { error?: { type?: unknown } };
    if (body.error && typeof body.error.type === "string" && /^[a-z0-9_]{1,64}$/.test(body.error.type)) return body.error.type;
  } catch { /* keep fallback */ }
  return fallback;
}

/** Typed workspace failure: `unknown` outcome means the effect may have committed. */
export class WorkspaceServiceError extends Error {
  readonly code: string;
  readonly status: number | null;
  readonly outcome: "not_applied" | "unknown";
  constructor(
    code: string,
    status: number | null = null,
    outcome: "not_applied" | "unknown" = "not_applied",
    message?: string,
  ) {
    super(message ?? code);
    this.name = "WorkspaceServiceError";
    this.code = code;
    this.status = status;
    this.outcome = outcome;
  }
}

const ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const MAX_PLAN_STEPS = 64;
const MAX_RECEIPTS = 256;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function requireId(value: unknown): string {
  if (typeof value !== "string" || !ID.test(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  return value;
}

function parseRun(value: unknown): Run {
  if (!isRecord(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  const status = value.status;
  if (typeof value.id !== "string" || !value.id || typeof value.planId !== "string" || !value.planId
    || typeof status !== "string" || !RUN_STATUSES.includes(status as RunStatus)) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  if (value.requestId !== undefined && (typeof value.requestId !== "string" || !value.requestId)) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  return {
    id: value.id,
    planId: value.planId,
    status,
    ...(typeof value.requestId === "string" ? { requestId: value.requestId } : {}),
  };
}

function parsePlan(value: unknown): WorkspacePlanRef | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  const id = requireId(value.id);
  if (typeof value.digest !== "string" || !/^[0-9a-f]{64}$/.test(value.digest)) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  const rawSteps = value.steps;
  if (!Array.isArray(rawSteps) || rawSteps.length > MAX_PLAN_STEPS) throw new WorkspaceServiceError("workspace_invalid_response");
  const steps: WorkspacePlanStep[] = rawSteps.map((step) => {
    if (!isRecord(step)) throw new WorkspaceServiceError("workspace_invalid_response");
    return {
      ...(typeof step.id === "string" ? { id: step.id } : {}),
      ...(typeof step.capabilityId === "string" ? { capabilityId: step.capabilityId } : {}),
      ...(isRecord(step.arguments) ? { arguments: step.arguments as Readonly<Record<string, unknown>> } : {}),
    };
  });
  return { id, digest: value.digest, ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}), steps };
}

function parseReceipt(value: unknown): WorkspaceReceiptRef {
  if (!isRecord(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  const refs = value.outputArtifactRefs;
  if (typeof value.id !== "string" || !value.id || typeof value.runId !== "string" || !value.runId
    || typeof value.status !== "string" || !Array.isArray(refs) || refs.some((ref) => typeof ref !== "string")) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  return {
    id: value.id,
    runId: value.runId,
    status: value.status,
    outputArtifactRefs: refs as string[],
    ...(typeof value.stepId === "string" ? { stepId: value.stepId } : {}),
    ...(typeof value.attemptId === "string" ? { attemptId: value.attemptId } : {}),
    ...(typeof value.capabilityId === "string" ? { capabilityId: value.capabilityId } : {}),
    ...(typeof value.errorCode === "string" && /^[a-z0-9_:.-]{1,120}$/i.test(value.errorCode) ? { errorCode: value.errorCode } : {}),
  };
}

function parseArtifact(value: unknown): WorkspaceArtifactRef | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  const id = requireId(value.id);
  return {
    id,
    ...(typeof value.projectId === "string" ? { projectId: value.projectId } : {}),
    ...(typeof value.runId === "string" ? { runId: value.runId } : {}),
    ...(typeof value.mediaType === "string" ? { mediaType: value.mediaType } : {}),
  };
}

function parsePreview(value: unknown): WorkspacePreview | null {
  if (value === null || value === undefined) return null;
  if (!isRecord(value)) throw new WorkspaceServiceError("workspace_invalid_response");
  const sequence = value.sequence;
  if (typeof value.runId !== "string" || typeof value.attemptId !== "string"
    || typeof sequence !== "number" || !Number.isSafeInteger(sequence)
    || typeof value.text !== "string" || typeof value.truncated !== "boolean") {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  return { runId: value.runId, attemptId: value.attemptId, sequence, text: value.text, truncated: value.truncated };
}

/** Strict-enough projection: rejects divergent identities instead of trusting shapes. */
export function parseWorkspaceView(input: unknown): WorkspaceView {
  if (!isRecord(input)) throw new WorkspaceServiceError("workspace_invalid_response");
  const projectId = requireId(input.projectId);
  const revision = input.revision;
  if (typeof revision !== "number" || !Number.isSafeInteger(revision) || revision < 1) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  const plan = parsePlan(input.plan);
  const run = input.run === null || input.run === undefined ? null : parseRun(input.run);
  const rawReceipts = input.receipts;
  if (rawReceipts !== undefined && !Array.isArray(rawReceipts)) throw new WorkspaceServiceError("workspace_invalid_response");
  const receipts = ((rawReceipts ?? []) as unknown[]).slice(0, MAX_RECEIPTS).map(parseReceipt);
  if (receipts.length > MAX_RECEIPTS) throw new WorkspaceServiceError("workspace_invalid_response");
  const artifact = parseArtifact(input.artifact);
  if (run && !plan) throw new WorkspaceServiceError("workspace_invalid_response");
  if (run && run.planId !== plan!.id) throw new WorkspaceServiceError("workspace_invalid_response");
  if (receipts.some((receipt) => receipt.runId !== run?.id)) throw new WorkspaceServiceError("workspace_invalid_response");
  if (artifact && artifact.projectId !== undefined && artifact.projectId !== projectId) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  const preview = parsePreview(input.gatewayPreview);
  if (preview && (preview.runId !== run?.id || !receipts.some((receipt) => receipt.attemptId === preview.attemptId))) {
    throw new WorkspaceServiceError("workspace_invalid_response");
  }
  return {
    projectId,
    revision,
    plan,
    run,
    receipts,
    artifact,
    ...(input.gatewayPreview !== undefined ? { gatewayPreview: preview } : {}),
  };
}

export function isSettledStatus(status: string): boolean {
  return ["succeeded", "failed", "cancelled", "needs_attention"].includes(status);
}

export function isPreviewActive(view: WorkspaceView): boolean {
  if (!view.run) return false;
  if (view.run.status === "running") return true;
  return view.receipts.some((receipt) => receipt.status === "prepared" || receipt.status === "dispatched");
}

export class WorkspaceService {
  private client: TuiClient;

  constructor(client: TuiClient) {
    this.client = client;
  }

  // --- Projects ---

  async listProjects(): Promise<Project[]> {
    const res = await this.client.fetchAuth("/v1/workspace/projects");
    if (!res.ok) return [];
    const data = await res.json() as { projects?: Project[] };
    return data.projects ?? [];
  }

  /** Every project visible to this identity (pages followed, cycle-safe, bounded). */
  async listAllProjects(signal?: AbortSignal): Promise<Project[]> {
    const out: Project[] = [];
    const seen = new Set<string>();
    let after = "";
    for (let page = 0; page < 50; page++) {
      const res = await this.client.fetchRaw(`/v1/workspace/projects?limit=100${after ? `&after=${encodeURIComponent(after)}` : ""}`, { ...(signal ? { signal } : {}) });
      if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `projects_list_failed_${res.status}`), res.status);
      const data = await res.json() as { projects?: Project[]; nextCursor?: string | null };
      if (!Array.isArray(data.projects)) throw new WorkspaceServiceError("workspace_invalid_response");
      out.push(...data.projects);
      if (!data.nextCursor) return out;
      if (seen.has(data.nextCursor)) throw new WorkspaceServiceError("workspace_invalid_response");
      seen.add(data.nextCursor);
      after = data.nextCursor;
    }
    return out;
  }

  /** Root bindings of a project exactly as the core reports them (no local path). */
  async listRootBindings(projectId: string, signal?: AbortSignal): Promise<RootBindingView[]> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `project_roots_failed_${res.status}`), res.status);
    const data = await res.json() as unknown;
    if (!Array.isArray(data)) throw new WorkspaceServiceError("workspace_invalid_response");
    return data.filter(isRecord).map((raw) => {
      const binding = (isRecord(raw.binding) ? raw.binding : raw) as Record<string, unknown>;
      return {
        id: String(binding.id ?? ""), projectId: String(binding.projectId ?? projectId),
        displayName: String(binding.displayName ?? ""), rootIdentityDigest: String(binding.rootIdentityDigest ?? ""),
        accessMode: binding.accessMode === "read_only" ? "read_only" as const : "read_write" as const,
        expiresAt: String(binding.expiresAt ?? ""), revokedAt: typeof binding.revokedAt === "string" ? binding.revokedAt : null,
        revision: Number(binding.revision ?? 1),
      };
    }).filter((binding) => binding.id);
  }

  async getProject(id: string): Promise<Project | null> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(id)}`);
    if (!res.ok) return null;
    const data = await res.json() as Record<string, unknown>;
    const p = (data.project ?? data) as Record<string, unknown>;
    return {
      id: String(data.projectId ?? p.id ?? id),
      name: String(p.name ?? ""),
      status: String(p.status ?? "active"),
      goal: typeof p.goal === "string" ? p.goal : undefined,
      revision: Number(data.revision ?? p.revision ?? 1),
      rootBindings: Array.isArray(p.rootBindings) ? (p.rootBindings as RootBinding[]) : [],
    };
  }

  async createProject(name: string, goal = ""): Promise<Project> {
    const res = await this.client.fetchAuth("/v1/workspace/projects/create", {
      method: "POST",
      body: JSON.stringify({ name, goal }),
    });
    if (!res.ok) throw new WorkspaceServiceError(`create_project_failed_${res.status}`, res.status);
    const data = await res.json() as Record<string, unknown>;
    const p = (data.project ?? data) as Record<string, unknown>;
    return {
      id: String(data.projectId ?? p.id ?? ""),
      name: String(p.name ?? name),
      status: String(p.status ?? "active"),
      goal: typeof p.goal === "string" ? p.goal : goal,
      revision: Number(data.revision ?? p.revision ?? 1),
      rootBindings: Array.isArray(p.rootBindings) ? (p.rootBindings as RootBinding[]) : [],
    };
  }

  // --- Root Bindings ---

  async registerRoot(projectId: string, path: string): Promise<RootBinding> {
    const displayName = path.split(/[/\\]/).filter(Boolean).pop() || "root";
    const nonce = randomUUID();
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots/register`, {
      method: "POST",
      body: JSON.stringify({
        localAbsolutePath: path,
        displayName,
        nonce,
        accessMode: "read_write",
      }),
    });
    if (!res.ok) throw new WorkspaceServiceError(`register_root_failed_${res.status}`, res.status);
    const data = await res.json() as { binding?: RootBinding } & RootBinding;
    return data.binding ?? data;
  }

  async revokeRoot(projectId: string, rootId: string): Promise<void> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots/${encodeURIComponent(rootId)}/revoke`, {
      method: "POST", body: JSON.stringify({}),
    });
    if (!res.ok) throw new WorkspaceServiceError(`revoke_root_failed_${res.status}`, res.status);
  }

  async listRoots(projectId: string): Promise<RootBinding[]> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots`);
    if (!res.ok) return [];
    const data = await res.json() as Array<{ binding?: RootBinding }>;
    return Array.isArray(data) ? data.map(r => r.binding ?? (r as unknown as RootBinding)) : [];
  }

  // --- Canonical views ---

  /** Current project view. Reconciliation reads also use this exact projection. */
  async refresh(projectId: string, signal?: AbortSignal): Promise<WorkspaceView> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}`, { signal });
    if (!res.ok) throw new WorkspaceServiceError(`workspace_view_failed_${res.status}`, res.status);
    const view = parseWorkspaceView(await res.json());
    if (view.projectId !== projectId) throw new WorkspaceServiceError("workspace_project_mismatch");
    return view;
  }

  /** View for a specific plan, never merely the newest plan in the project. */
  async refreshPlan(projectId: string, planId: string, signal?: AbortSignal): Promise<WorkspaceView> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/plans/${encodeURIComponent(planId)}`, { signal });
    if (!res.ok) throw new WorkspaceServiceError(`workspace_plan_view_failed_${res.status}`, res.status);
    const view = parseWorkspaceView(await res.json());
    if (view.projectId !== projectId) throw new WorkspaceServiceError("workspace_project_mismatch");
    if (view.plan?.id !== planId) throw new WorkspaceServiceError("workspace_plan_mismatch");
    return view;
  }

  async listPlans(projectId: string): Promise<Plan[]> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/plans`);
    if (!res.ok) return [];
    const data = await res.json() as { plans?: Plan[] };
    return data.plans ?? [];
  }

  async viewPlan(projectId: string, planId: string): Promise<Plan | null> {
    try {
      const view = await this.refreshPlan(projectId, planId);
      if (!view.plan) return null;
      return { id: view.plan.id, digest: view.plan.digest, projectId: view.projectId };
    } catch { return null; }
  }

  /** The single canonical filesystem catalog; absent configuration stays explicit. */
  async getFilesystemCatalog(signal?: AbortSignal): Promise<FilesystemCatalog | null> {
    try {
      const res = await this.client.fetchAuth("/v1/workspace/filesystem", { signal });
      if (!res.ok) return null;
      return parseFilesystemCatalog(await res.json());
    } catch { return null; }
  }

  // --- Plan preparation (no execution) ---

  /** Chat plan with the allowed tool catalog; prepared only, never dispatched here. */
  async createChatPlan(projectId: string, input: { expectedRevision: number; chat: GatewayChatRequest }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createChatPlan");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new WorkspaceServiceError("workspace_invalid_revision");
    const chat = parseGatewayChatRequest(input.chat);
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/chat-plans`, {
      method: "POST",
      body: JSON.stringify({ expectedRevision: input.expectedRevision, chat }),
      ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createChatPlan", { requirePlan: true, forbidRun: true });
  }

  /** Filesystem plan for a specific durable proposal call; arguments never come from the client. */
  async createToolPlan(projectId: string, input: GatewayToolPlanRequest, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createToolPlan");
    const parsed = parseGatewayToolPlanRequest(input);
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/tool-plans`, {
      method: "POST",
      body: JSON.stringify(parsed),
      ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createToolPlan", { requirePlan: true, forbidRun: true });
  }

  /** Continuation chat plan reconstructed by the server from its durable tool result. */
  async createToolResultPlan(projectId: string, input: GatewayToolResultPlanRequest, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createToolResultPlan");
    const parsed = parseGatewayToolResultPlanRequest(input);
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/tool-result-plans`, {
      method: "POST",
      body: JSON.stringify(parsed),
      ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createToolResultPlan", { requirePlan: true, forbidRun: true });
  }

  async createWritePlan(
    projectId: string,
    rootBindingId: string,
    changes: Array<{ path: string; content: string; type?: "create" | "replace"; expectedSha256?: string }>
  ): Promise<Plan> {
    this.guardWrite("createWritePlan");
    const view = await this.refresh(projectId);
    const expectedRevision = view.revision;

    const operations: ProjectChangeOperation[] = changes.map(c => ({
      type: (c.type === "replace" ? "replace" : "create") as ProjectChangeOperationType,
      path: c.path,
      ...(c.expectedSha256 ? { expectedSha256: c.expectedSha256 } : {}),
      newSha256: createHash("sha256").update(c.content || "").digest("hex"),
      content: c.content || "",
    }));

    const cs = {
      id: `cs-${randomUUID()}`,
      taskId: `task-${randomUUID()}`,
      baseManifestDigest: "0".repeat(64),
      revision: 1,
      operations,
    };
    const digest = computeProjectChangeSetDigest(cs);

    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/plans`, {
      method: "POST",
      body: JSON.stringify({
        expectedRevision,
        rootBindingId,
        objective: `Write ${changes.map(c => c.path).join(", ")}`,
        changeSet: { ...cs, digest },
      }),
    });
    if (!res.ok) {
      let code = `create_write_plan_failed_${res.status}`;
      try {
        const body = await res.json() as { error?: { type?: unknown } };
        if (body.error && typeof body.error.type === "string" && /^[a-z0-9_]{1,64}$/.test(body.error.type)) code = body.error.type;
      } catch { /* keep status-derived code */ }
      throw new WorkspaceServiceError(code, res.status);
    }
    const data = await res.json() as { plan?: Plan } & Plan;
    return data.plan ?? data;
  }

  private async parseMutationView(res: Response, projectId: string, operation: string, rules: { requirePlan?: boolean; forbidRun?: boolean } = {}): Promise<WorkspaceView> {
    if (!res.ok) {
      const status = res.status;
      // A 409 keeps its structured code so an unsupported tool is actionable.
      let code = `${operation}_failed_${status}`;
      try {
        const body = await res.json() as { error?: { type?: unknown } };
        if (body.error && typeof body.error.type === "string" && /^[a-z0-9_]{1,64}$/.test(body.error.type)) code = body.error.type;
      } catch { /* keep status-derived code */ }
      throw new WorkspaceServiceError(code, status);
    }
    const view = parseWorkspaceView(await res.json());
    if (view.projectId !== projectId) throw new WorkspaceServiceError("workspace_project_mismatch");
    if (rules.requirePlan && !view.plan) throw new WorkspaceServiceError("workspace_plan_missing");
    if (rules.forbidRun && view.run) throw new WorkspaceServiceError("workspace_run_unexpected");
    return view;
  }

  // --- Project files through the verified root (reads never leave the root service) ---

  /** One bounded directory page, without constructing the write manifest. */
  async listProjectDirectory(projectId: string, rootBindingId: string, relativePath = "", offset = 0, signal?: AbortSignal): Promise<ProjectDirectoryPage> {
    const directoryPath = relativePath === "." ? "" : relativePath;
    const query = new URLSearchParams({ rootBindingId, path: directoryPath, offset: String(offset) });
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/directory?${query}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `project_directory_read_failed_${res.status}`), res.status);
    const value: unknown = await res.json();
    if (!isRecord(value) || value.relativePath !== directoryPath || !Array.isArray(value.entries) || value.entries.length > 100
      || !(value.nextOffset === null || (Number.isSafeInteger(value.nextOffset) && Number(value.nextOffset) > offset && Number(value.nextOffset) <= 100_000))) throw new WorkspaceServiceError("workspace_invalid_response");
    const prefix = directoryPath ? `${directoryPath}/` : "";
    const paths = new Set<string>();
    const entries = value.entries.map((entry: unknown) => {
      if (!isRecord(entry) || typeof entry.relativePath !== "string" || !entry.relativePath.startsWith(prefix)
        || !entry.relativePath.slice(prefix.length) || /[\\/\x00-\x1f]/.test(entry.relativePath.slice(prefix.length))
        || [".", ".."].includes(entry.relativePath.slice(prefix.length)) || paths.has(entry.relativePath)
        || !["file", "directory"].includes(String(entry.kind)) || !Number.isSafeInteger(entry.byteLength) || Number(entry.byteLength) < 0) throw new WorkspaceServiceError("workspace_invalid_response");
      paths.add(entry.relativePath);
      return { relativePath: entry.relativePath, kind: entry.kind as "file" | "directory", byteLength: entry.byteLength as number };
    });
    return { relativePath: directoryPath, entries, nextOffset: value.nextOffset as number | null };
  }

  /** Native range contract, distinct from a complete file used for edit preimages. */
  async readProjectFileRange(projectId: string, rootBindingId: string, relativePath: string, startLine: number, endLine: number, signal?: AbortSignal): Promise<ProjectTextFileRange | null> {
    const query = new URLSearchParams({ rootBindingId, path: relativePath, startLine: String(startLine), endLine: String(endLine) });
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/file?${query}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const code = await errorCode(res, `project_file_read_failed_${res.status}`);
      if (code === 'project_file_not_found') return null;
      throw new WorkspaceServiceError(code, res.status);
    }
    const value: unknown = await res.json();
    const integer = (input: unknown): input is number => typeof input === 'number' && Number.isSafeInteger(input) && input >= 0;
    const hash = (input: unknown): input is string => typeof input === 'string' && /^[0-9a-f]{64}$/.test(input);
    if (!isRecord(value) || value.relativePath !== relativePath || typeof value.text !== 'string'
      || !integer(value.byteLength) || !integer(value.scannedBytes) || value.scannedBytes > value.byteLength
      || !integer(value.rangeByteLength) || value.rangeByteLength > 48_000 || Buffer.byteLength(value.text) !== value.rangeByteLength
      || !hash(value.rangeSha256) || createHash('sha256').update(value.text).digest('hex') !== value.rangeSha256
      || !(value.sha256 === null || hash(value.sha256)) || (value.sha256 !== null && value.scannedBytes !== value.byteLength)
      || value.startLine !== startLine || !integer(value.endLine) || value.endLine > endLine
      || !(value.totalLines === null || integer(value.totalLines) && value.totalLines >= 1 && value.scannedBytes === value.byteLength)
      || !(value.nextLine === null || value.nextLine === endLine + 1)) throw new WorkspaceServiceError('workspace_invalid_response');
    signal?.throwIfAborted();
    return { relativePath, text: value.text as string, sha256: value.sha256 as string | null, byteLength: value.byteLength as number,
      rangeSha256: value.rangeSha256 as string, rangeByteLength: value.rangeByteLength as number, startLine, endLine: value.endLine as number,
      totalLines: value.totalLines as number | null, nextLine: value.nextLine as number | null, scannedBytes: value.scannedBytes as number,
      mediaType: typeof value.mediaType === 'string' ? value.mediaType : 'text/plain',
      ...(typeof value.language === 'string' ? { language: value.language } : {}) };
  }

  /** One bounded text file read by the core; `null` when the file does not exist. */
  async readProjectFile(projectId: string, rootBindingId: string, relativePath: string, signal?: AbortSignal): Promise<ProjectTextFile | null> {
    const query = `rootBindingId=${encodeURIComponent(rootBindingId)}&path=${encodeURIComponent(relativePath)}`;
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/file?${query}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const code = await errorCode(res, `project_file_read_failed_${res.status}`);
      if (code === "project_file_not_found") return null;
      throw new WorkspaceServiceError(code, res.status);
    }
    const value = await res.json() as Record<string, unknown>;
    if (!isRecord(value) || value.relativePath !== relativePath || typeof value.text !== "string" || typeof value.sha256 !== "string"
      || !/^[0-9a-f]{64}$/.test(value.sha256) || !Number.isSafeInteger(value.byteLength)) {
      throw new WorkspaceServiceError("workspace_invalid_response");
    }
    return {
      relativePath, text: value.text, sha256: value.sha256, byteLength: value.byteLength as number,
      mediaType: typeof value.mediaType === "string" ? value.mediaType : "text/plain",
      ...(typeof value.language === "string" ? { language: value.language } : {}),
    };
  }

  async readFile(projectId: string, rootBindingId: string, relativePath: string, signal?: AbortSignal): Promise<Uint8Array> {
    const query = `rootBindingId=${encodeURIComponent(rootBindingId)}&path=${encodeURIComponent(relativePath)}`;
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/media?${query}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) {
      const code = await errorCode(res, `project_file_read_failed_${res.status}`);
      throw new WorkspaceServiceError(code, res.status);
    }
    // Limits the binary payload to 32MB to prevent OOM
    const maxBytes = 32 * 1024 * 1024;
    const contentLength = Number(res.headers.get("content-length") || 0);
    if (contentLength > maxBytes) throw new WorkspaceServiceError("project_file_too_large", 413);

    const reader = res.body?.getReader();
    if (!reader) {
      const buf = await res.arrayBuffer();
      if (buf.byteLength > maxBytes) throw new WorkspaceServiceError("project_file_too_large", 413);
      return new Uint8Array(buf);
    }
    const chunks: Uint8Array[] = [];
    let received = 0;
    while (true) {
      signal?.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > maxBytes) {
        reader.cancel();
        throw new WorkspaceServiceError("project_file_too_large", 413);
      }
      chunks.push(value);
    }
    const result = new Uint8Array(received);
    let offset = 0;
    for (const chunk of chunks) {
      result.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return result;


  }

  /** Canonical manifest of the root (public/protected classification included). */
  async getManifest(projectId: string, rootBindingId: string, signal?: AbortSignal): Promise<ProjectManifest> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/manifest?rootBindingId=${encodeURIComponent(rootBindingId)}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `project_manifest_failed_${res.status}`), res.status);
    const value = await res.json() as Record<string, unknown>;
    if (!isRecord(value) || typeof value.snapshotDigest !== "string" || !Array.isArray(value.entries)) throw new WorkspaceServiceError("workspace_invalid_response");
    const entries = (value.entries as unknown[]).filter(isRecord).map((entry) => ({
      relativePath: String(entry.relativePath ?? ""),
      kind: entry.kind === "directory" ? "directory" as const : "file" as const,
      sha256: typeof entry.sha256 === "string" ? entry.sha256 : null,
      byteLength: typeof entry.byteLength === "number" ? entry.byteLength : 0,
      sensitivity: typeof entry.sensitivity === "string" ? entry.sensitivity : "public",
    })).filter((entry) => entry.relativePath);
    return { snapshotDigest: value.snapshotDigest, entries, raw: value };
  }

  /** Read-only comparison of a ChangeSet with the disk (no effect). */
  async preflightChangeSet(projectId: string, rootBindingId: string, changeSet: ProjectChangeSetInput, signal?: AbortSignal): Promise<ChangePreflight> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/preflight`, {
      method: "POST", body: JSON.stringify({ rootBindingId, changeSet }), ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `preflight_failed_${res.status}`), res.status);
    const value = await res.json() as Record<string, unknown>;
    const entries = Array.isArray(value.entries) ? (value.entries as unknown[]).filter(isRecord) : [];
    const issues = Array.isArray(value.issues) ? (value.issues as unknown[]).filter(isRecord) : [];
    return {
      entries: entries.map((entry) => ({ path: String(entry.path ?? ""), operation: String(entry.operation ?? ""), status: String(entry.status ?? "blocked"), baseSha256: typeof entry.baseSha256 === "string" ? entry.baseSha256 : null })),
      issues: issues.map((issue) => ({ path: String(issue.path ?? ""), code: String(issue.code ?? "") })),
    };
  }

  /** Durable write plan for an exact ChangeSet; nothing is written until consent/complete. */
  async createChangeSetPlan(projectId: string, input: { expectedRevision: number; rootBindingId: string; changeSet: ProjectChangeSetInput; objective: string }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createChangeSetPlan");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/plans`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    const view = await this.parseMutationView(res, projectId, "createChangeSetPlan", { requirePlan: true });
    const step = view.plan?.steps.find((item) => item.capabilityId === "workspace.project.write");
    const bound = step?.arguments?.change_set as { kind?: string; value?: { digest?: string } } | undefined;
    if (!step || bound?.value?.digest !== input.changeSet.digest) throw new WorkspaceServiceError("workspace_plan_mismatch");
    return view;
  }

  /** Verification plan executed by the canonical project runner (OCI or static checker). */
  async createRunPlan(projectId: string, input: { expectedRevision: number; rootBindingId: string; request: ProjectRunRequestInput }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createRunPlan");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/run-plans`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createRunPlan", { requirePlan: true, forbidRun: true });
  }

  /** Git status of the root, read by the core with repository executors disabled. */
  async createRunPromotionPlan(projectId: string, input: { expectedRevision: number; rootBindingId: string; outputManifestArtifactId: string; paths: string[] }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createRunPromotionPlan");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/run-promotions`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createRunPromotionPlan", { requirePlan: true, forbidRun: true });
  }

  /** Git status of the root, read by the core with repository executors disabled. */
  async gitStatus(projectId: string, rootBindingId: string, signal?: AbortSignal): Promise<GitStatusView> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/git-status?rootBindingId=${encodeURIComponent(rootBindingId)}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `git_status_failed_${res.status}`), res.status);
    const value = await res.json() as Record<string, unknown>;
    if (!isRecord(value) || typeof value.repository !== "boolean" || !Array.isArray(value.entries)) throw new WorkspaceServiceError("workspace_invalid_response");
    return {
      repository: value.repository, branch: typeof value.branch === "string" ? value.branch : null, head: typeof value.head === "string" ? value.head : null,
      upstream: typeof value.upstream === "string" ? value.upstream : null, ahead: Number(value.ahead ?? 0), behind: Number(value.behind ?? 0),
      entries: (value.entries as unknown[]).filter(isRecord).map((e) => ({ path: String(e.path ?? ""), index: String(e.index ?? " "), worktree: String(e.worktree ?? " "), kind: String(e.kind ?? "changed"), ...(typeof e.origPath === "string" ? { origPath: e.origPath } : {}) })),
    };
  }

  async gitDiff(projectId: string, rootBindingId: string, relativePath: string, staged: boolean, signal?: AbortSignal): Promise<{ diff: string; limited: boolean }> {
    const query = `rootBindingId=${encodeURIComponent(rootBindingId)}&path=${encodeURIComponent(relativePath)}&staged=${staged ? 1 : 0}`;
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/git-diff?${query}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `git_diff_failed_${res.status}`), res.status);
    const value = await res.json() as { diff?: unknown; limited?: unknown };
    if (typeof value.diff !== "string") throw new WorkspaceServiceError("workspace_invalid_response");
    return { diff: value.diff, limited: value.limited === true };
  }

  /** Governed Git plan (stage/unstage/commit); runs only after W5 consent. */
  async createGitPlan(projectId: string, input: { expectedRevision: number; rootBindingId: string; operation: GitOperationInput }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createGitPlan");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/git-plans`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createGitPlan", { requirePlan: true, forbidRun: true });
  }

  /** Governed host command plan (interactive/script execution in authorized project root); runs only after W5 consent. */
  async createHostCommandPlan(projectId: string, input: { expectedRevision: number; rootBindingId: string; command: string; timeoutMs?: number; conversationId?: string }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("createHostCommandPlan");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/host-command-plans`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "createHostCommandPlan", { requirePlan: true, forbidRun: true });
  }

  /** Closes an active host command session for a project root / conversation. */
  async closeHostCommandSession(projectId: string, input: { rootBindingId?: string; conversationId?: string }, signal?: AbortSignal): Promise<boolean> {
    this.guardWrite("closeHostCommandSession");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/host-command-sessions/close`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `close_host_session_failed_${res.status}`), res.status);
    const data = await res.json() as { closed?: boolean };
    return Boolean(data.closed);
  }

  /** Runtime profiles as observed by the core (availability and diagnostic included). */
  async getRuntimeProfiles(signal?: AbortSignal): Promise<RuntimeProfile[]> {
    const res = await this.client.fetchRaw("/v1/workspace/project-agent/capabilities", { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `runtime_profiles_failed_${res.status}`), res.status);
    const value = await res.json() as { profiles?: unknown };
    if (!Array.isArray(value.profiles)) throw new WorkspaceServiceError("workspace_invalid_response");
    return (value.profiles as unknown[]).filter(isRecord).map((profile) => ({
      id: String(profile.id ?? ""), name: String(profile.name ?? profile.id ?? ""), available: profile.available === true,
      isolation: String(profile.isolation ?? ""), runtime: String(profile.runtime ?? ""),
      ...(typeof profile.diagnostic === "string" ? { diagnostic: profile.diagnostic } : {}),
      defaultActions: Array.isArray(profile.defaultActions) ? (profile.defaultActions as unknown[]).map(String) : [],
    }));
  }

  /** Durable versions recorded by the writer for one file (restore is a new reviewed plan). */
  async listFileVersions(projectId: string, rootBindingId: string, relativePath: string): Promise<{ currentSha256: string; versions: Array<{ operationId: string; createdAt: string }> }> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots/${encodeURIComponent(rootBindingId)}/restore-file`, {
      method: "POST", body: JSON.stringify({ relativePath }),
    });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `restore_versions_failed_${res.status}`), res.status);
    const value = await res.json() as { currentSha256?: unknown; versions?: unknown };
    if (typeof value.currentSha256 !== "string" || !Array.isArray(value.versions)) throw new WorkspaceServiceError("workspace_invalid_response");
    return { currentSha256: value.currentSha256, versions: (value.versions as unknown[]).filter(isRecord).map((v) => ({ operationId: String(v.operationId), createdAt: String(v.createdAt) })) };
  }

  /** Prepares a reviewed restore plan over the current content (no write here). */
  async prepareFileRestore(projectId: string, rootBindingId: string, input: { relativePath: string; operationId: string; expectedSha256: string; expectedRevision: number }): Promise<{ view: WorkspaceView; before: string; after: string }> {
    this.guardWrite("prepareFileRestore");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-roots/${encodeURIComponent(rootBindingId)}/restore-file`, {
      method: "POST", body: JSON.stringify(input),
    });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `restore_prepare_failed_${res.status}`), res.status);
    const value = await res.json() as { view?: unknown; before?: unknown; after?: unknown };
    if (typeof value.before !== "string" || typeof value.after !== "string") throw new WorkspaceServiceError("workspace_invalid_response");
    const view = parseWorkspaceView(value.view);
    if (view.projectId !== projectId || !view.plan) throw new WorkspaceServiceError("workspace_invalid_response");
    return { view, before: value.before, after: value.after };
  }

  // --- Consent and execution ---

  /**
   * Consent challenge/complete for an exact plan digest. `consent/complete` is the
   * only path that starts the run; the requestId is owned by the caller and reused
   * verbatim on retry. A lost ACK is reconciled from the journal through the
   * project view before any resend. When `admission` is given, the core admits
   * the run for that conversation intention (continuity and conversation budget).
   */
  async approveAndStart(projectId: string, command: RunCommand, signFn: (nonce: string) => string, signal?: AbortSignal, admission?: ConversationAdmission, beforeComplete?: () => Promise<void>): Promise<WorkspaceView> {
    this.guardWrite("approveAndStart");
    if (!command.planId || !/^[0-9a-f]{64}$/.test(command.planDigest) || !command.requestId) {
      throw new WorkspaceServiceError("workspace_invalid_command");
    }
    const admissionHeaders: Record<string, string> = admission
      ? { "x-uptokey-conversation-id": admission.conversationId, "x-uptokey-conversation-request-id": admission.requestId }
      : {};
    const challengeRes = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/consent/challenge`, {
      method: "POST",
      body: JSON.stringify(command),
      ...(signal ? { signal } : {}),
    });
    if (!challengeRes.ok) throw new WorkspaceServiceError(await errorCode(challengeRes, `consent_challenge_failed_${challengeRes.status}`), challengeRes.status);
    const challenge = await challengeRes.json() as ConsentChallenge;
    if (!isRecord(challenge) || typeof challenge.challengeId !== "string" || !challenge.challengeId
      || typeof challenge.nonce !== "string" || !challenge.nonce || challenge.nonce.length > 4096) {
      throw new WorkspaceServiceError("consent_challenge_invalid");
    }
    // A challenge is preparation, not execution. Recheck the caller's exact
    // conversation/root after that await, before signing or submitting it.
    // Keep this outside transport reconciliation: a rejected local guard has
    // provably sent no consent/complete and must never be recovered as a run.
    await beforeComplete?.();
    signal?.throwIfAborted();
    const signature = signFn(challenge.nonce);
    if (typeof signature !== "string" || !signature || signature.length > 1024) throw new WorkspaceServiceError("consent_signature_invalid");
    let completeRes: Response;
    try {
      completeRes = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/consent/complete`, {
        method: "POST",
        headers: admissionHeaders,
        body: JSON.stringify({ challengeId: challenge.challengeId, command, signature }),
        ...(signal ? { signal } : {}),
      });
    } catch (error) {
      return this.reconcileConsent(projectId, command, new WorkspaceServiceError(
        "consent_unconfirmed", null, "unknown", error instanceof Error ? error.message : "transport"), signal);
    }
    if (!completeRes.ok) {
      if (completeRes.status >= 500) {
        return this.reconcileConsent(projectId, command, new WorkspaceServiceError(`consent_complete_failed_${completeRes.status}`, completeRes.status, "unknown"), signal);
      }
      const code = await errorCode(completeRes, `consent_complete_failed_${completeRes.status}`);
      throw new WorkspaceServiceError(code, completeRes.status, "not_applied", `consent_complete_failed_${completeRes.status}:${code}`);
    }
    let view: WorkspaceView;
    try {
      view = parseWorkspaceView(await completeRes.json());
    } catch (error) {
      return this.reconcileConsent(projectId, command, new WorkspaceServiceError(
        "consent_response_invalid", null, "unknown", error instanceof Error ? error.message : "invalid"), signal);
    }
    if (view.projectId !== projectId || (view.plan && view.plan.id !== command.planId)) {
      throw new WorkspaceServiceError("consent_response_mismatch");
    }
    if (view.run && (view.run.planId !== command.planId
      || (view.run.requestId !== undefined && view.run.requestId !== command.requestId))) {
      throw new WorkspaceServiceError("consent_response_mismatch");
    }
    return view;
  }

  /** Journal reconciliation: only the exact admitted run recovers the command. */
  private async reconcileConsent(projectId: string, command: RunCommand, original: WorkspaceServiceError, signal?: AbortSignal): Promise<WorkspaceView> {
    let view: WorkspaceView;
    try {
      view = await this.refreshPlan(projectId, command.planId, signal);
    } catch { throw original; }
    const run = view.run;
    if (view.projectId === projectId && run && run.planId === command.planId
      && (run.requestId === undefined || run.requestId === command.requestId)) {
      return view;
    }
    throw original;
  }

  /** Back-compatible wrapper used by the approval overlay. */
  async requestConsent(projectId: string, planId: string, signFn: (nonce: string) => string, requestId?: string, admission?: ConversationAdmission): Promise<WorkspaceView> {
    this.guardWrite("requestConsent");
    const view = await this.refreshPlan(projectId, planId);
    if (!view.plan) throw new WorkspaceServiceError("workspace_plan_missing");
    const command: RunCommand = { planId, planDigest: view.plan.digest, requestId: requestId ?? randomUUID() };
    return this.approveAndStart(projectId, command, signFn, undefined, admission);
  }

  /**
   * Bounded observation of an admitted run. The association (project, plan,
   * requestId, runId) is revalidated on every poll so a newer run is never
   * mistaken for the approved one. `needs_attention` is settled, not success.
   */
  async waitForSettledRun(
    projectId: string,
    association: { planId: string; requestId?: string; runId?: string },
    options: { signal?: AbortSignal; timeoutMs?: number; pollMs?: number; onPoll?: (view: WorkspaceView) => void } = {},
  ): Promise<WorkspaceView> {
    const timeoutMs = Math.max(1_000, Math.min(options.timeoutMs ?? 120_000, 600_000));
    const pollMs = Math.max(100, Math.min(options.pollMs ?? 400, 5_000));
    const started = Date.now();
    for (;;) {
      options.signal?.throwIfAborted();
      const view = await this.refreshPlan(projectId, association.planId, options.signal);
      const run = view.run;
      if (run && association.runId && run.id !== association.runId) throw new WorkspaceServiceError("run_identity_changed");
      if (run && association.requestId && run.requestId !== undefined && run.requestId !== association.requestId) {
        throw new WorkspaceServiceError("run_identity_changed");
      }
      options.onPoll?.(view);
      if (run && isSettledStatus(run.status) && !isPreviewActive(view)) return view;
      if (!run && Date.now() - started > 5_000) throw new WorkspaceServiceError("run_not_admitted");
      if (Date.now() - started > timeoutMs) throw new WorkspaceServiceError("run_observation_timeout", null, "unknown");
      await sleep(pollMs, undefined, options.signal ? { signal: options.signal } : undefined).catch(() => { options.signal?.throwIfAborted(); });
    }
  }

  /** Deliverable bytes of a canonical artifact; never a local reconstruction. */
  async readArtifact(projectId: string, artifactId: string, signal?: AbortSignal): Promise<string> {
    if (!ID.test(artifactId)) throw new WorkspaceServiceError("workspace_invalid_id");
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}`, { signal });
    if (!res.ok) throw new WorkspaceServiceError(`artifact_read_failed_${res.status}`, res.status);
    const data = await res.json() as { content?: unknown };
    if (typeof data.content !== "string") throw new WorkspaceServiceError("workspace_invalid_response");
    return data.content;
  }

  /** Authenticated canonical media read; the core verifies artifact identity and SHA-256. */
  async readArtifactMedia(projectId: string, artifactId: string, signal?: AbortSignal): Promise<{ bytes: Uint8Array; mediaType: string }> {
    if (!ID.test(projectId) || !ID.test(artifactId)) throw new WorkspaceServiceError("workspace_invalid_id");
    const response = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/artifacts/${encodeURIComponent(artifactId)}/media`, { signal });
    if (!response.ok) throw new WorkspaceServiceError("artifact_read_failed", response.status);
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0] ?? "";
    if (Number(response.headers.get("content-length")) > 512 * 1024) { await response.body?.cancel(); throw new WorkspaceServiceError("attachment_size"); }
    const reader = response.body?.getReader();
    if (!reader) throw new WorkspaceServiceError("artifact_read_failed");
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      for (;;) {
        signal?.throwIfAborted();
        const item = await reader.read(); if (item.done) break;
        length += item.value.byteLength;
        if (length > 512 * 1024) throw new WorkspaceServiceError("attachment_size");
        chunks.push(item.value);
      }
    } finally { await reader.cancel().catch(() => undefined); reader.releaseLock(); }
    return { bytes: new Uint8Array(Buffer.concat(chunks)), mediaType };
  }

  async importMediaArtifact(projectId: string, expectedRevision: number, mediaType: string, bytes: Uint8Array, signal?: AbortSignal): Promise<{ artifactId: string; revision: number }> {
    this.guardWrite("importMediaArtifact");
    if (!ID.test(projectId) || !Number.isSafeInteger(expectedRevision)) throw new WorkspaceServiceError("workspace_invalid_request");
    const image = ["image/png", "image/jpeg", "image/webp"].includes(mediaType);
    if (!image && mediaType !== "audio/mpeg") throw new WorkspaceServiceError("attachment_unavailable");
    const response = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/${image ? "image" : "audio"}-import`, {
      method: "POST", body: JSON.stringify({ expectedRevision, mediaType, [image ? "imageBase64" : "audioBase64"]: Buffer.from(bytes).toString("base64") }), signal,
    });
    if (!response.ok) throw new WorkspaceServiceError("artifact_import_failed", response.status);
    const value = await response.json() as { projectId?: unknown; artifactId?: unknown; revision?: unknown };
    if (value.projectId !== projectId || typeof value.artifactId !== "string" || !ID.test(value.artifactId) || !Number.isSafeInteger(value.revision)) throw new WorkspaceServiceError("workspace_project_mismatch");
    return { artifactId: value.artifactId, revision: value.revision as number };
  }

  // --- Runs ---

  async startRun(projectId: string, planId: string): Promise<Run> {
    this.guardWrite("startRun");
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/start`, {
      method: "POST",
      body: JSON.stringify({ planId }),
    });
    if (!res.ok) throw new WorkspaceServiceError(`start_run_failed_${res.status}`, res.status);
    return await res.json() as Run;
  }

  async cancelRun(projectId: string, runId: string): Promise<void> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/cancel`, {
      method: "POST",
      body: JSON.stringify({}),
    });
    if (!res.ok) throw new WorkspaceServiceError(`cancel_run_failed_${res.status}`, res.status);
  }

  /** Explicit recovery decision for a run stuck in needs_attention. */
  async reviewRunAttention(projectId: string, planId: string, runId: string): Promise<RunAttentionReview> {
    const view = await this.refreshPlan(projectId, planId);
    if (view.run?.id !== runId || view.run.status !== "needs_attention") throw new WorkspaceServiceError("run_not_in_attention");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/write-recovery`);
    if (!res.ok) {
      const body = await res.json().catch(() => null) as { error?: { type?: string } } | null;
      if (res.status === 404 && body?.error?.type === "workspace_write_recovery_not_found") return { view };
      throw new WorkspaceServiceError(body?.error?.type ?? `recovery_review_failed_${res.status}`, res.status);
    }
    const value = await res.json() as Record<string, unknown>;
    if (!isRecord(value) || value.runId !== runId || typeof value.digest !== "string" || !/^[a-f0-9]{64}$/.test(value.digest)
      || !Number.isSafeInteger(value.expectedRunRevision) || Number(value.expectedRunRevision) < 1 || !Array.isArray(value.entries)
      || value.entries.some(item => !isRecord(item) || typeof item.path !== "string" || !["pending", "already_present", "conflict"].includes(String(item.state)))) {
      throw new WorkspaceServiceError("workspace_invalid_response");
    }
    return { view, write: { digest: value.digest, expectedRunRevision: value.expectedRunRevision as number,
      entries: value.entries.map(item => ({ path: item.path as string, state: item.state as string })) } };
  }

  async resolveRunAttention(projectId: string, runId: string, input: unknown, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("resolveRunAttention");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/resolve-attention`, {
      method: "POST",
      body: JSON.stringify(input),
      ...(signal ? { signal } : {}),
    });
    return this.parseMutationView(res, projectId, "resolveRunAttention");
  }

  async getRunOutput(projectId: string, runId: string): Promise<string> {
    const res = await this.client.fetchAuth(`/v1/workspace/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}/protocol-output`);
    if (!res.ok) return "";
    return await res.text();
  }

  // --- Tasks ---

  /** Delegated project tasks as projected by the core journal (root run + exact child plans). */
  async listTasks(projectId: string, signal?: AbortSignal): Promise<ProjectTaskView[]> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/tasks`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `project_tasks_failed_${res.status}`), res.status);
    const data = await res.json() as { tasks?: unknown };
    if (!Array.isArray(data.tasks)) throw new WorkspaceServiceError("project_tasks_invalid");
    return data.tasks.map(parseProjectTaskView);
  }

  async getTask(projectId: string, taskId: string, signal?: AbortSignal): Promise<ProjectTaskView> {
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/tasks/${encodeURIComponent(taskId)}`, { ...(signal ? { signal } : {}) });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `project_task_failed_${res.status}`), res.status);
    const task = parseProjectTaskView(await res.json());
    if (task.id !== taskId) throw new WorkspaceServiceError("project_task_mismatch");
    return task;
  }

  /** Prepares (never runs) the root delegation plan over exact child plans; one W5 consent covers the task grant. */
  async prepareTask(projectId: string, input: { expectedRevision: number; rootBindingId: string; objective: string; childPlanIds: string[] }, signal?: AbortSignal): Promise<WorkspaceView> {
    this.guardWrite("prepareTask");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/task-plans`, {
      method: "POST", body: JSON.stringify(input), ...(signal ? { signal } : {}),
    });
    const view = await this.parseMutationView(res, projectId, "prepareTask", { requirePlan: true, forbidRun: true });
    if (!view.plan!.steps.some((s) => s.capabilityId === "workspace.project.task")) throw new WorkspaceServiceError("project_task_plan_unbound");
    return view;
  }

  async cancelTask(projectId: string, taskId: string): Promise<ProjectTaskView> {
    this.guardWrite("cancelTask");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/tasks/${encodeURIComponent(taskId)}/cancel`, { method: "POST", body: "{}" });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `cancel_task_failed_${res.status}`), res.status);
    return parseProjectTaskView(await res.json());
  }

  /** Resumes a ready task: the core rechecks authority, root and budgets before starting the next child. */
  async resumeTask(projectId: string, taskId: string): Promise<ProjectTaskView> {
    this.guardWrite("resumeTask");
    const res = await this.client.fetchRaw(`/v1/workspace/projects/${encodeURIComponent(projectId)}/project-agent/tasks/${encodeURIComponent(taskId)}/resume`, { method: "POST", body: "{}" });
    if (!res.ok) throw new WorkspaceServiceError(await errorCode(res, `resume_task_failed_${res.status}`), res.status);
    return parseProjectTaskView(await res.json());
  }

  /** Governed inference lane for project plans (`uptokey start --gateway=9router`). */
  async getGatewayInfo(signal?: AbortSignal): Promise<{ available: boolean; model: string | null }> {
    const res = await this.client.fetchRaw("/v1/workspace/gateway", { ...(signal ? { signal } : {}) });
    if (!res.ok) return { available: false, model: null };
    const value = await res.json() as Record<string, unknown>;
    return { available: value.available === true && typeof value.model === "string", model: typeof value.model === "string" ? value.model : null };
  }

  // --- Storage policy ---

  private storagePolicy: "local" | "temporary" = "local";

  setStoragePolicy(policy: "local" | "temporary"): void {
    this.storagePolicy = policy;
  }

  private guardWrite(operation: string): void {
    if (this.storagePolicy === "temporary") {
      throw new WorkspaceServiceError(`operation_blocked_temporary_session: ${operation} requires local storage policy`);
    }
  }

  // --- Capabilities ---

  async getCapabilities(): Promise<Array<{ id: string; availability: string }>> {
    const res = await this.client.fetchAuth("/v1/workspace/capabilities");
    if (!res.ok) return [];
    const data = await res.json() as { capabilities?: Array<{ id: string; availability: string }> };
    return data.capabilities ?? [];
  }

  /**
   * T15: Restore a file to a previous version using checkpoints.
   * Uses the checkpoint system to find and restore.
   */
  async restoreFromCheckpoint(
    checkpointRef: string,
    filePath: string,
    projectRoot: string,
    projectId = "default",
    rootBindingId = "default"
  ): Promise<{ success: boolean; message: string }> {
    try {
      const { execFile } = await import("node:child_process");
      const { promisify } = await import("node:util");
      const exec = promisify(execFile);

      // Verify the ref exists
      await exec("git", ["cat-file", "-t", checkpointRef], { cwd: projectRoot });

      // Show the file at that checkpoint
      const { stdout: fileContent } = await exec(
        "git", ["show", `${checkpointRef}:${filePath}`],
        { cwd: projectRoot },
      );

      // Use the governed write path to apply the restoration
      const plan = await this.createWritePlan(projectId, rootBindingId, [{ path: filePath, content: fileContent, type: "replace" }]);
      if (!plan) {
        return { success: false, message: "Restauração bloqueada pela política de sessão" };
      }

      return { success: true, message: `Restaurado ${filePath} do checkpoint ${checkpointRef.slice(0, 8)}` };
    } catch (err) {
      return { success: false, message: `Falha: ${err instanceof Error ? err.message : String(err)}` };
    }
  }
}
