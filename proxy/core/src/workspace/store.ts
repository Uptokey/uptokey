import type {EffectArtifact} from './executor.ts';
import {settleReceipt} from './receipts.ts';
import {PROJECT_WRITE_CAPABILITY} from './capabilities.ts';
import {parseProjectTaskRecord,taskAuthority,type ProjectTaskRecord} from './project-task-authority.ts';
import {parseVoiceSessionRecord,type VoiceSessionRecord} from '../voice-session-service.ts';
import {artifactByteLimit,sealedJsonByteLimit} from './artifacts.ts';
import {detectImageMediaType,IMAGE_BATCH_MAX} from '@uptokey/sync-contract/image';
import { createCipheriv, createDecipheriv, createHash, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { lstatSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, readdir, rm, unlink } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { asDataRecord as record, projectStringArray } from "@uptokey/sync-contract/plain-data";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { canonicalCompositionRequest, parseCompositionSpec, type CompositionSpec } from "@uptokey/sync-contract/composition";
import {
  type Artifact,
  type ContextSnapshot,
  type DataDestination,
  type ExecutionReceipt,
  type ProjectContext,
  type Run,
  type PlanApproval,
  type ExecutionPlan,
  type ProjectGrant,
  type Recipe,
  type UsageValueReceipt,
  parseExecutionPlan,
  validatePlanBindings,
  parseContextSnapshot,
  parseProjectGrant,
  parseRecipe,
  parseUsageValueReceipt,
  canonicalPlanPayload,
  canonicalContextSnapshotPayload,
  parsePlanApproval,
  parseArtifact,
  parseExecutionReceipt,
  parseProjectContext,
  parseRun,
  parseWorkflowCommand,
  RUN_STATUSES,
  WorkflowContractError,
} from "@uptokey/sync-contract/workflow";
import { readJson, writeJsonAtomic } from "../atomic-json.ts";
import { dataDir } from "../paths.ts";
import { sharedSinkAuthority } from "./sink-authority.ts";
// E2-15
import { saveUsageObservabilityPersist, loadUsageObservabilityPersist, restoreUsageObservabilityFromPersist,projectJournalUsage } from "./usage-observability-persist.ts";
import { getBoundUsageObservabilityStore } from "./usage-observability-http.ts";
import type { SecretStore } from "../secret-store.ts";
import {
  parseLearnedApiRecipe,
  type LearnedApiRecipe,
} from "../../../integracoes/api-instruments/src/learned-recipes.ts";
import {
  type ProjectRootBinding,
  type ProjectChangeSet,
  parseProjectRootBinding,
  parseProjectChangeSet,
} from "@uptokey/sync-contract/project-agent";
import {
  type MultiModelPlan,
  type MultimodelRun,
  type PanelResult,
  type SynthesisResult,
  parseMultiModelPlan,
  parseMultimodelRun,
  parsePanelResult,
  parseSynthesisResult,
} from "@uptokey/sync-contract/multimodel";
import {
  ARTIFACT_TEXT_MAX_BYTES,
  PROJECT_STORAGE_MAX_BYTES,
  SNAPSHOT_JSON_MAX_BYTES,
  assertImmutableReplace,
  createArtifactRecord,
  projectByteLength,
  sha256Hex,
} from "./artifacts.ts";
import {
  applyClassificationCorrection,
  parseUsageClassificationRecord,
  MAX_CLASSIFICATIONS_PER_PROJECT,
  type HumanCorrection,
  type UsageClassificationRecord,
} from "./usage-classification.ts";
import {
  type ContextActor,
  type ContextEntry,
  appendContextEntry,
  assertIdentityId,
  assertIsoTime,
  assertWorkflowId,
  confirmHypothesisAsDecision,
  createContextEntry,
  createContextSnapshot,
} from "./context.ts";

const SEALED_SCHEMA = "uptokey-workspace-sealed-v1";
const BUNDLE_SCHEMA = "uptokey-workspace-bundle-v1";
const KEY_ACCOUNT = "local:workspace-store-key";
const CACHE_KEY_ACCOUNTS = new Set(["local:cache-hmac-key", "local:cache-data-key"]);
const ACTIVE_RUN = new Set(["draft", "ready", "running", "awaiting_approval", "needs_attention"]);
const JOURNAL_ACTIVE = new Set(["running", "ready", "awaiting_approval", "needs_attention"]);
const SEALED_KEYS = ["alg", "ciphertext", "identityId", "kdf", "nonce", "projectId", "revision", "schema", "tag"];
const LEGACY_BUNDLE_KEYS = ["approvals", "artifacts", "journalRevision", "persistSchema", "project", "runs"];
const BUNDLE_KEYS = [...LEGACY_BUNDLE_KEYS, "plans", "snapshots", "grants", "recipes", "usageValues"].sort();
const OPTIONAL_BUNDLE_KEYS = ["telemetryDeliveries", "compositions", "learnedRecipes", "projectRoots", "writeIntents", "multimodelPlans", "multimodelRuns", "usageClassifications", "privacyPurges", "voiceSessions", "projectTasks"];
const MAX_PROJECT_ROOTS = 32;
const MAX_WRITE_INTENTS = 128;
const MAX_MULTIMODEL_PLANS = 64;
const MAX_MULTIMODEL_RUNS = 128;
const MAX_USAGE_CLASSIFICATIONS = MAX_CLASSIFICATIONS_PER_PROJECT;

export interface StoredProjectRoot {
  readonly binding: ProjectRootBinding;
  readonly localPath: string;
}

export interface StoredProjectWriteReceipt {
  readonly operationId: string;
  readonly changeSetId: string;
  readonly baseManifestDigest: string;
  readonly appliedAt: string;
  readonly confirmedPaths: readonly string[];
  readonly observedHashes: Readonly<Record<string, string>>;
  readonly preimagesRef: string;
}

export interface StoredWriteIntent {
  readonly operationId: string;
  readonly rootBindingId: string;
  readonly changeSet: ProjectChangeSet;
  readonly status: 'pending' | 'in_progress' | 'completed' | 'failed' | 'needs_attention';
  readonly preimagesDir: string;
  readonly createdAt: string;
  readonly confirmedPaths: readonly string[];
  readonly receipt?: StoredProjectWriteReceipt;
  readonly recovery?: StoredWriteRecovery;
}

export interface StoredWriteRecovery {
  readonly runId: string;
  readonly action: 'keep_stopped' | 'retry';
  readonly reviewDigest: string;
  readonly resolvedAt: string;
  readonly replacementPlanId?: string;
  readonly reason?: string;
}

export interface ResolveInterruptedWriteInput {
  readonly operationId: string;
  readonly expectedRunRevision: number;
  readonly action: StoredWriteRecovery['action'];
  readonly reviewDigest: string;
  readonly reason?: string;
  readonly replacement?: { readonly plan: ExecutionPlan; readonly snapshot: ContextSnapshot };
  /** Recheck the runtime's disk observation after waiting for the project queue. */
  readonly revalidate?: () => void;
}

export interface ResolveInterruptedWriteResult {
  readonly intent: StoredWriteIntent;
  readonly record: JournalRunRecord;
  readonly replacement?: { readonly plan: ExecutionPlan; readonly snapshot: ContextSnapshot };
}
const STORED_RUN_KEYS = ["receipts", "revision", "run"];
const MAX_JOURNAL_RUNS = 128;
const MAX_COMPOSITIONS = 64;
const MAX_LEARNED_RECIPES = 64;
const PROCESS_ROOT_LOCKS = new Map<string, string>();

export type ApprovalOccupancy = PlanApproval;

export type JournalRunRecord = { revision: number; run: Run; receipts: ExecutionReceipt[] };
type PrivacyPurge = {targetClass:'artifact'|'local_receipts';targetId:string;purgedAt:string};
export class WorkspacePrivacyError extends Error {
  readonly code:string;readonly status:number;
  constructor(code:string,status:number){super(code);this.code=code;this.status=status;}
}
export type PrivacyResource = {targetClass:PrivacyPurge['targetClass'];targetId:string;projectId:string;name:string;createdAt:string;blockedReason:string|null};
function containsReference(value:unknown,id:string):boolean {
  if(value===id)return true;
  if(Array.isArray(value))return value.some(item=>containsReference(item,id));
  return !!value&&typeof value==='object'&&Object.values(value).some(item=>containsReference(item,id));
}
function privacyBlock(bundle:WorkspaceBundle,kind:PrivacyPurge['targetClass'],id:string):string|null {
  if(bundle.runs.some(item=>ACTIVE_RUN.has(item.run.status))||bundle.writeIntents?.some(item=>['pending','in_progress','needs_attention'].includes(item.status)))return 'privacy_active_execution';
  const references=[bundle.project.entries,bundle.plans,bundle.snapshots,bundle.recipes,bundle.usageValues,bundle.compositions,bundle.learnedRecipes,bundle.multimodelPlans,bundle.multimodelRuns,bundle.usageClassifications,bundle.writeIntents];
  if(kind==='artifact')references.push(bundle.runs as never);
  else references.push(bundle.artifacts as never);
  const ids=[id,...(kind==='local_receipts'?bundle.runs.flatMap(slot=>slot.receipts.filter(receipt=>receipt.id===id).flatMap(receipt=>receipt.sources.map(source=>source.id))):[])];
  if(references.some(value=>ids.some(ref=>containsReference(value,ref))))return 'privacy_resource_referenced';
  return null;
}
export type TelemetryDelivery = { destinationId: string; runId: string; runRevision: number; fingerprint: string };

export type JournalCreateRunResult =
  | { kind: "created"; record: JournalRunRecord }
  | { kind: "existing"; record: JournalRunRecord }
  | { kind: "conflict"; code: "project_run_active" | "approval_consumed" };

export type JournalCommitResult =
  | { kind: "committed"; record: JournalRunRecord }
  | { kind: "conflict" };

export type WorkspaceBundle = {
  voiceSessions?:VoiceSessionRecord[];
  projectTasks?:ProjectTaskRecord[];
  privacyPurges?:PrivacyPurge[];
  persistSchema: typeof BUNDLE_SCHEMA;
  project: ProjectContext;
  journalRevision: number;
  runs: JournalRunRecord[];
  approvals: ApprovalOccupancy[];
  artifacts: Artifact[];
  plans: ExecutionPlan[];
  snapshots: ContextSnapshot[];
  grants: ProjectGrant[];
  recipes: Recipe[];
  usageValues: UsageValueReceipt[];
  /** Delivery acknowledgements only. Pending metadata is derived from the durable run journal. */
  telemetryDeliveries?: TelemetryDelivery[];
  /** Immutable, owner-bound local condition specifications; these never authorize an effect. */
  compositions?: CompositionSpec[];
  /**
    * Owner-bound learned API recipes (stage 18). Every revision is preserved for
    * audit; plans pin a revision through the operation schema digest. Never a
    * global catalog: entries are invisible outside the owner's project bundle.
    */
  learnedRecipes?: LearnedApiRecipe[];
  projectRoots?: StoredProjectRoot[];
  writeIntents?: StoredWriteIntent[];
  multimodelPlans?: MultiModelPlan[];
  multimodelRuns?: MultimodelRun[];
  /**
   * E2-16 usage classification metadata, one latest record per runId. Labels
   * only (never prompt text); human corrections are recorded as `user` labels.
   * These never alter financial receipts and are invisible outside the owner.
   */
  usageClassifications?: UsageClassificationRecord[];
};

export class WorkspaceConflictError extends Error {
  readonly expectedRevision: number;
  readonly actualRevision: number;
  constructor(expectedRevision: number, actualRevision: number) {
    super("workspace_revision_conflict");
    this.expectedRevision = expectedRevision;
    this.actualRevision = actualRevision;
  }
}

export class WorkspaceStore {
  private readonly secrets: SecretStore;
  private readonly root: string;
  private readonly now: () => Date;
  readonly sinkPolicy: import("./sink-authority.ts").SinkAccessPolicy;
  private readonly queues = new Map<string, Promise<unknown>>();
  private lockRelease: (() => void) | undefined;
  private processUnlock: (() => void) | undefined;
  private masterKey: Buffer | undefined;

  constructor(secrets: SecretStore, root = join(dataDir(), "workspace"), now: () => Date = () => new Date(), options?: { sinkPolicy?: import("./sink-authority.ts").SinkAccessPolicy }) {
    if (CACHE_KEY_ACCOUNTS.has(KEY_ACCOUNT)) throw new Error("workspace_key_account_invalid");
    this.secrets = secrets;
    this.root = resolve(root);
    this.now = now;
    this.sinkPolicy = options?.sinkPolicy ?? sharedSinkAuthority();
  }

  runtimeNamespaceDigest():string{return createHash('sha256').update(process.platform==='win32'?this.root.toLowerCase():this.root).digest('hex');}

  async initialize(): Promise<void> {
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const processUnlock = claimProcessRoot(this.root, token);
    try {
      this.lockRelease = claimWriterLock(join(this.root, "writer.lock"), token);
      this.processUnlock = processUnlock;
    } catch (error) {
      processUnlock();
      throw error;
    }
    try {
      await this.ensureKey();
      await unlinkStaleTemps(this.root);
    } catch (error) {
      this.close();
      throw error;
    }
  }

  async close(): Promise<void> {
    this.lockRelease?.();
    this.lockRelease = undefined;
    this.processUnlock?.();
    this.processUnlock = undefined;
    this.masterKey?.fill(0);
    this.masterKey = undefined;
  }

  async createProject(input: {
    identityId: string;
    name: string;
    goal: string;
    constraints?: string[];
    folderName?: unknown;
    path?: unknown;
    directoryHandle?: unknown;
  }, imported?:{legacyId:string;entries:Array<{id:string;content:string;origin:'user'|'model'}>}): Promise<ProjectContext> {
    assertIdentityId(input.identityId);
    this.sinkPolicy.assertSinkAllowed(input.identityId, "sqlite:runs");
    if (input.folderName !== undefined || input.directoryHandle !== undefined || input.path !== undefined) {
      throw new Error("workspace_native_path_rejected");
    }
    const command = asContract(() => parseWorkflowCommand("createProject", { name: input.name, goal: input.goal }), "workspace_project_invalid");
    const createdAt = this.isoNow();
    if(imported)assertWorkflowId(imported.legacyId,'workspace_legacy_id');
    const importId=imported?`import_${sha256Hex(new TextEncoder().encode(JSON.stringify([input.identityId,imported.legacyId])))}`:undefined;
    const project = assertStoredProject({
      schemaVersion: 1,
      id: importId??randomUUID(),
      createdAt,
      ownerPrincipalId: input.identityId,
      revision: 1,
      name: command.name,
      goal: command.goal,
      constraints: input.constraints ?? [],
      entries: imported?.entries.map(entry=>createContextEntry({id:entry.id,content:entry.content,origin:entry.origin,kind:'fact',status:'proposed',sourceRefs:[],supersedes:null,createdAt}))??[],
      sources: [],
      artifactRefs: [],
      updatedAt: createdAt,
    });
    return this.serial(projectKey(input.identityId, project.id), async () => {
      if(importId){
        try{return (await this.readSnapshot(input.identityId,project.id)).project;}
        catch(error){if(!(error instanceof Error&&error.message==='workspace_project_not_found'))throw error;}
      }
      await mkdir(this.projectDir(input.identityId, project.id), { recursive: true, mode: 0o700 });
      await this.writeSnapshot({
        persistSchema: BUNDLE_SCHEMA,
        project,
        journalRevision: 0,
        runs: [],
        approvals: [],
        artifacts: [],
        plans: [], snapshots: [], grants: [], recipes: [], usageValues: [],
      }, undefined, "create");
      return project;
    });
  }

  async getProject(identityId: string, projectId: string): Promise<ProjectContext> {
    return (await this.readLocked(identityId, projectId)).project;
  }

  async getBundle(identityId: string, projectId: string): Promise<WorkspaceBundle> {
    return this.readLocked(identityId, projectId);
  }

  async putProjectTask(identityId:string,record:ProjectTaskRecord):Promise<void>{
    const task=parseProjectTaskRecord(record);
    if(task.principalId!==identityId)throw Error('project_task_owner_mismatch');
    await this.serial(projectKey(identityId,task.projectId),async()=>{
      const current=await this.readSnapshot(identityId,task.projectId),previous=current.projectTasks??[];
      const old=previous.find(t=>t.id===task.id);if(old){if(canonicalJson(old)!==canonicalJson(task))throw Error('project_task_conflict');return;}
      if(task.predecessorTaskId&&!previous.some(t=>t.id===task.predecessorTaskId&&t.rootBindingId===task.rootBindingId))throw Error('project_task_predecessor_missing');
      const root=current.runs.find(r=>r.run.id===task.rootRunId),plan=current.plans.find(p=>p.id===task.rootPlanId);
      if(root?.run.status!=='running'||root.run.planId!==task.rootPlanId||plan?.steps.length!==1||plan.steps[0]?.capabilityId!=='workspace.project.task'||previous.length>=128)throw Error('project_task_admission_invalid');
      const binding=plan.steps[0].arguments.task;if(binding?.kind!=='literal'||!recordMatchesTaskBinding(task,binding.value))throw Error('project_task_admission_invalid');
      for(const child of task.children){const plan=current.plans.find(p=>p.id===child.planId);if(!plan||plan.digest!==child.digest||child.runId!==null)throw Error('project_task_plan_changed');}
      await this.writeSnapshot(this.bumpJournal(current,{...current,projectTasks:[...previous,task]}),current,'journal');
    });
  }
  async readProjectTaskAuthority(identityId:string,projectId:string,planId:string,requestId:string){
    const bundle=await this.readLocked(identityId,projectId),task=bundle.projectTasks?.find(t=>t.children.some(c=>c.planId===planId&&c.requestId===requestId));
    return task?taskAuthority(bundle,task,planId,requestId,this.now()):undefined;
  }
  async isProjectTaskRequest(identityId:string,projectId:string,requestId:string){return !!(await this.readLocked(identityId,projectId)).projectTasks?.some(t=>t.children.some(c=>c.requestId===requestId));}
  async stopProjectTask(identityId:string,projectId:string,taskId:string){
    await this.serial(projectKey(identityId,projectId),async()=>{const current=await this.readSnapshot(identityId,projectId);if(!current.projectTasks?.some(t=>t.id===taskId))throw Error('project_task_missing');
      await this.writeSnapshot(this.bumpJournal(current,{...current,projectTasks:current.projectTasks.map(t=>t.id===taskId?{...t,stoppedAt:t.stoppedAt??this.now().toISOString()}:t)}),current,'journal');});
  }
  async blockProjectTaskForRun(identityId:string,projectId:string,runId:string,reason:string){
    await this.serial(projectKey(identityId,projectId),async()=>{const current=await this.readSnapshot(identityId,projectId);if(!current.projectTasks?.some(t=>t.children.some(c=>c.runId===runId)))return;
      await this.writeSnapshot(this.bumpJournal(current,{...current,projectTasks:current.projectTasks.map(t=>t.children.some(c=>c.runId===runId)?{...t,blockedReason:t.blockedReason??reason}:t)}),current,'journal');});
  }
  async createProjectTaskRun(identityId:string,run:Run):Promise<JournalCreateRunResult>{
    return this.serial(projectKey(identityId,run.projectId),async()=>{
      const current=await this.readSnapshot(identityId,run.projectId),parsed=assertStoredRun(run,current.project);
      const old=current.runs.find(r=>r.run.requestId===parsed.requestId&&r.run.principalId===parsed.principalId);if(old)return {kind:'existing',record:cloneRecord(old)};
      if(current.runs.some(r=>JOURNAL_ACTIVE.has(r.run.status)))return {kind:'conflict',code:'project_run_active'};
      const task=current.projectTasks?.find(t=>t.children.some(c=>c.requestId===parsed.requestId&&c.planId===parsed.planId));
      const authority=task&&taskAuthority(current,task,parsed.planId,parsed.requestId,this.now());
      if(!task||!authority||authority.authority.childPlanDigest!==parsed.planDigest)return {kind:'conflict',code:'approval_consumed'};
      if(current.runs.length>=MAX_JOURNAL_RUNS)throw Error('workspace_journal_full');
      const child=task.children.find(c=>c.requestId===parsed.requestId)!;if(child.runId!==null)return {kind:'conflict',code:'approval_consumed'};
      const record:JournalRunRecord={revision:1,run:parsed,receipts:[]};
      await this.writeSnapshot(this.bumpJournal(current,{...current,runs:[...current.runs,record],projectTasks:current.projectTasks!.map(t=>t.id!==task.id?t:{...t,children:t.children.map(c=>c.requestId===parsed.requestId?{...c,runId:parsed.id}:c)})}),current,'journal');
      return {kind:'created',record:cloneRecord(record)};
    });
  }

  async putVoiceSession(record:VoiceSessionRecord):Promise<void>{
    const valid=parseVoiceSessionRecord(record),identityId=valid.principalId,projectId=valid.projectId;
    await this.serial(projectKey(identityId,projectId),async()=>{
      const bundle=await this.readSnapshot(identityId,projectId),previous=bundle.voiceSessions??[],old=previous.find(item=>item.sessionId===valid.sessionId);
      if(bundle.project.ownerPrincipalId!==identityId||!bundle.runs.some(slot=>slot.run.id===valid.runId))throw new Error('voice_run_binding_invalid');
      if(old){
        if(old.runId!==valid.runId||old.startedAt!==valid.startedAt||canonicalJson(old.session)!==canonicalJson(valid.session)||valid.events.length<old.events.length||canonicalJson(valid.events.slice(0,old.events.length))!==canonicalJson(old.events)||old.endedAt!==null&&(old.endedAt!==valid.endedAt||old.status!==valid.status))throw new Error('voice_record_conflict');
        if(canonicalJson(old)===canonicalJson(valid))return;
      }else if(previous.length>=128)throw new Error('voice_journal_full');
      const voiceSessions=old?previous.map(item=>item.sessionId===valid.sessionId?valid:item):[...previous,valid];
      await this.writeSnapshot(this.bumpJournal(bundle,{...bundle,voiceSessions}),bundle,'journal');
    });
  }
  async getVoiceSession(principalId:string,projectId:string,sessionId:string):Promise<VoiceSessionRecord|undefined>{
    return (await this.readLocked(principalId,projectId)).voiceSessions?.find(item=>item.sessionId===sessionId);
  }

  async putCompositionSpec(identityId: string, spec: CompositionSpec): Promise<CompositionSpec> {
    assertIdentityId(identityId);
    const valid = parseCompositionSpec(spec);
    if (valid.principalId !== identityId) throw new Error("workspace_composition_binding_invalid");
    return this.serial(projectKey(identityId, valid.projectId), async () => {
      const current = await this.readSnapshot(identityId, valid.projectId);
      if (valid.principalId !== current.project.ownerPrincipalId) throw new Error("workspace_composition_binding_invalid");
      const previous = current.compositions ?? [];
      const replay = previous.find(item => item.requestId === valid.requestId);
      if (replay) {
        if (compositionRequest(replay) !== compositionRequest(valid)) throw new Error("workspace_idempotency_conflict");
        return replay;
      }
      if (previous.some(item => item.id === valid.id)) throw new Error("workspace_idempotency_conflict");
      if (!compositionBound(valid, current.project, current.runs)) throw new Error("workspace_composition_binding_invalid");
      if (previous.length >= MAX_COMPOSITIONS) throw new Error("workspace_compositions_full");
      await this.writeSnapshot(this.bumpJournal(current, { ...current, compositions: [...previous, valid] }), current, "journal");
      return valid;
    });
  }

  async getCompositionSpec(identityId: string, projectId: string, id: string): Promise<CompositionSpec | undefined> {
    assertWorkflowId(id, "workspace_composition_id");
    return (await this.readLocked(identityId, projectId)).compositions?.find(item => item.id === id);
  }

  /**
   * Persists a learned recipe revision. New ids start at revision 1; updates
   * must be exactly max+1 (revocation and promotion build the next revision).
   * Owner and project binding are enforced; history is never rewritten.
   */
  async putLearnedRecipe(identityId: string, recipe: LearnedApiRecipe): Promise<LearnedApiRecipe> {
    assertIdentityId(identityId);
    const valid = parseLearnedApiRecipe(recipe);
    if (valid.ownerPrincipalId !== identityId) throw new Error("workspace_learned_recipe_binding_invalid");
    return this.serial(projectKey(identityId, valid.projectId), async () => {
      const current = await this.readSnapshot(identityId, valid.projectId);
      if (valid.ownerPrincipalId !== current.project.ownerPrincipalId) throw new Error("workspace_learned_recipe_binding_invalid");
      const previous = current.learnedRecipes ?? [];
      const revisions = previous.filter(item => item.id === valid.id).map(item => item.revision);
      const expected = revisions.length === 0 ? 1 : Math.max(...revisions) + 1;
      if (valid.revision !== expected) throw new Error("workspace_learned_recipe_revision_conflict");
      if (previous.length >= MAX_LEARNED_RECIPES) throw new Error("workspace_learned_recipes_full");
      await this.writeSnapshot(this.bumpJournal(current, { ...current, learnedRecipes: [...previous, valid] }), current, "journal");
      return valid;
    });
  }

  async getLearnedRecipe(identityId: string, projectId: string, id: string): Promise<LearnedApiRecipe | undefined> {
    assertIdentityId(identityId);
    const recipes = (await this.readLocked(identityId, projectId)).learnedRecipes ?? [];
    const revisions = recipes.filter(item => item.id === id);
    if (revisions.length === 0) return undefined;
    return revisions.reduce((latest, item) => (item.revision > latest.revision ? item : latest));
  }

  async listLearnedRecipes(identityId: string, projectId: string): Promise<LearnedApiRecipe[]> {
    assertIdentityId(identityId);
    const recipes = (await this.readLocked(identityId, projectId)).learnedRecipes ?? [];
    const latest = new Map<string, LearnedApiRecipe>();
    for (const item of recipes) {
      const current = latest.get(item.id);
      if (!current || item.revision > current.revision) latest.set(item.id, item);
    }
    return [...latest.values()].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  }

  /* ── E2-16 usage classification metadata ─────────────────────────────
     Labels-only metadata per runId. Owner/project-bound, idempotent by run,
     never alters financial receipts and never stores prompt text. */
  async putUsageClassification(identityId: string, record: UsageClassificationRecord): Promise<UsageClassificationRecord> {
    assertIdentityId(identityId);
    const valid = parseUsageClassificationRecord(record);
    if (valid.principalId !== identityId) throw new Error("workspace_classification_binding_invalid");
    return this.serial(projectKey(identityId, valid.projectId), async () => {
      const current = await this.readSnapshot(identityId, valid.projectId);
      if (current.project.ownerPrincipalId !== identityId) throw new Error("workspace_classification_binding_invalid");
      const previous = current.usageClassifications ?? [];
      const filtered = previous.filter(entry => entry.runId !== valid.runId);
      if (filtered.length >= MAX_USAGE_CLASSIFICATIONS) throw new Error("workspace_classifications_full");
      await this.writeSnapshot(this.bumpJournal(current, { ...current, usageClassifications: [...filtered, valid] }), current, "journal");
      return valid;
    });
  }

  async getUsageClassification(identityId: string, projectId: string, runId: string): Promise<UsageClassificationRecord | undefined> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).usageClassifications?.find(entry => entry.runId === runId);
  }

  async listUsageClassifications(identityId: string, projectId: string): Promise<UsageClassificationRecord[]> {
    assertIdentityId(identityId);
    const rows = (await this.readLocked(identityId, projectId)).usageClassifications ?? [];
    return [...rows].sort((a, b) => (a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0));
  }

  /** Human correction becomes the new latest record; receipts are untouched. */
  async correctUsageClassification(identityId: string, projectId: string, runId: string, correction: HumanCorrection): Promise<UsageClassificationRecord> {
    assertIdentityId(identityId);
    if (correction.principalId !== identityId || correction.projectId !== projectId || correction.runId !== runId) {
      throw new Error("workspace_classification_binding_invalid");
    }
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      if (current.project.ownerPrincipalId !== identityId) throw new Error("workspace_classification_binding_invalid");
      const row = (current.usageClassifications ?? []).find(entry => entry.runId === runId);
      if (!row) throw new Error("classification_missing");
      const updated = parseUsageClassificationRecord(applyClassificationCorrection(row, correction));
      const next = (current.usageClassifications ?? []).map(entry => (entry.runId === runId ? updated : entry));
      await this.writeSnapshot(this.bumpJournal(current, { ...current, usageClassifications: next }), current, "journal");
      return updated;
    });
  }

  /** Export happens outside the lock. A changed run cannot be acknowledged by an older export. */
  async putProjectRoot(identityId: string, projectId: string, root: StoredProjectRoot): Promise<StoredProjectRoot> {
    assertIdentityId(identityId);
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      if (current.project.ownerPrincipalId !== identityId) throw new Error("workspace_project_identity_mismatch");
      const previous = current.projectRoots ?? [];
      const filtered = previous.filter(r => r.binding.id !== root.binding.id);
      if (filtered.length >= MAX_PROJECT_ROOTS) throw new Error("workspace_project_roots_full");
      const updated = [...filtered, root];
      await this.writeSnapshot(this.bumpJournal(current, { ...current, projectRoots: updated }), current, "journal");
      return root;
    });
  }

  async getProjectRoot(identityId: string, projectId: string, rootBindingId: string): Promise<StoredProjectRoot | undefined> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).projectRoots?.find(r => r.binding.id === rootBindingId);
  }

  async listProjectRoots(identityId: string, projectId: string): Promise<StoredProjectRoot[]> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).projectRoots ?? [];
  }

  async revokeProjectRoot(identityId: string, projectId: string, rootBindingId: string, revokedAt: string): Promise<StoredProjectRoot> {
    assertIdentityId(identityId);
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const previous = current.projectRoots ?? [];
      const found = previous.find(r => r.binding.id === rootBindingId);
      if (!found) throw new Error("project_root_not_found");
      const revoked: StoredProjectRoot = {
        ...found,
        binding: {
          ...found.binding,
          revokedAt,
          revision: found.binding.revision + 1,
        }
      };
      const updated = previous.map(r => r.binding.id === rootBindingId ? revoked : r);
      await this.writeSnapshot(this.bumpJournal(current, { ...current, projectRoots: updated }), current, "journal");
      return revoked;
    });
  }

  async putWriteIntent(identityId: string, projectId: string, intent: StoredWriteIntent): Promise<StoredWriteIntent> {
    assertIdentityId(identityId);
    // Capture validated data before entering the asynchronous project queue.
    // The caller must not be able to change the record while persistence awaits.
    const valid = assertStoredWriteIntent(intent);
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const previous = current.writeIntents ?? [];
      const saved = previous.find(i => i.operationId === valid.operationId);
      // Resolution belongs to the atomic journal operation below. A delayed
      // writer cannot reopen it or discard its durable recovery decision.
      if (saved?.recovery) {
        if (canonicalJson(saved) !== canonicalJson(valid)) throw new Error('workspace_write_recovery_conflict');
        return structuredClone(saved);
      }
      if (valid.recovery) throw new Error('workspace_write_recovery_invalid');
      const filtered = previous.filter(i => i.operationId !== valid.operationId);
      if (filtered.length >= MAX_WRITE_INTENTS) throw new Error("workspace_write_intents_full");
      const updated = [...filtered, valid];
      await this.writeSnapshot(this.bumpJournal(current, { ...current, writeIntents: updated }), current, "journal");
      return structuredClone(valid);
    });
  }

  async getWriteIntent(identityId: string, projectId: string, operationId: string): Promise<StoredWriteIntent | undefined> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).writeIntents?.find(i => i.operationId === operationId);
  }

  async listWriteIntents(identityId: string, projectId: string): Promise<StoredWriteIntent[]> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).writeIntents ?? [];
  }

  async resolveInterruptedWrite(identityId: string, projectId: string, input: ResolveInterruptedWriteInput): Promise<ResolveInterruptedWriteResult> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, 'workspace_project_id');
    // Parsers copy all data synchronously, before either the queue or the read.
    // The callback remains separate and is never persisted or called on replay.
    const request = parseWriteRecoveryInput(input);
    const revalidate = input.revalidate;
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      if (current.project.ownerPrincipalId !== identityId) throw new Error('workspace_write_recovery_not_found');
      const intent = current.writeIntents?.find(item => item.operationId === request.operationId);
      if (!intent) throw new Error('workspace_write_recovery_not_found');
      const bound = bindInterruptedWrite(current, intent);
      const stored = bound.record;
      if (intent.recovery) {
        const replacement = savedWriteReplacement(current, intent.recovery);
        if (stored.revision !== request.expectedRunRevision + 1 || intent.recovery.action !== request.action ||
            intent.recovery.reviewDigest !== request.reviewDigest || intent.recovery.reason !== request.reason ||
            (request.replacement !== undefined && canonicalJson(replacement ?? null) !== canonicalJson(request.replacement))) {
          throw new Error('workspace_write_recovery_conflict');
        }
        return structuredClone({ intent, record: stored, ...(replacement ? { replacement } : {}) });
      }
      if (stored.revision !== request.expectedRunRevision) throw new Error('run_revision_conflict');
      if (stored.run.status !== 'needs_attention' || (intent.status === 'completed' && request.action !== 'keep_stopped')) {
        throw new Error('workspace_write_recovery_conflict');
      }
      if (current.runs.some(item => item.run.id !== stored.run.id && ACTIVE_RUN.has(item.run.status))) throw new Error('project_run_active');
      try { assertIsoTime(intent.createdAt, 'workspace_intent_time'); }
      catch { throw new Error('workspace_write_recovery_invalid'); }
      if (request.replacement) {
        const { plan, snapshot } = request.replacement;
        if (current.plans.some(item => item.id === plan.id) || current.snapshots.some(item => item.id === snapshot.id) ||
            current.approvals.some(item => item.planId === plan.id) || current.runs.some(item => item.run.planId === plan.id)) {
          throw new Error('workspace_write_recovery_conflict');
        }
        this.assertRevision(plan.projectRevision, current.project.revision);
        assertPlanSnapshot(plan, snapshot, current.project);
        const expected = createContextSnapshot({ id: snapshot.id, createdAt: snapshot.createdAt, project: current.project,
          artifacts: current.artifacts, selectedEntryIds: snapshot.entries.map(entry => entry.id),
          excludedEntryIds: snapshot.excludedEntryIds, selectedArtifactIds: snapshot.artifacts.map(artifact => artifact.id),
          allowedDestinations: snapshot.allowedDestinations, maxContextBytes: snapshot.maxContextBytes });
        if (canonicalJson(expected) !== canonicalJson(snapshot)) throw new Error('workspace_snapshot_binding_invalid');
        assertWriteReplacement(intent, bound.plan, plan, snapshot);
      }
      const at = new Date(Math.max(this.now().getTime(), Date.parse(intent.createdAt), Date.parse(stored.run.updatedAt),
        ...stored.receipts.map(receipt => Date.parse(receipt.startedAt)))).toISOString();
      const receipts = stored.receipts.map(receipt => receipt.status === 'dispatched'
        ? settleReceipt(receipt, { kind: 'unknown', code: 'attention_resolved', now: at })
        : receipt.status === 'prepared' ? settleReceipt(receipt, { kind: 'not_sent', code: 'attention_resolved', now: at }) : receipt);
      const run = parseRun({ ...stored.run, status: 'failed', updatedAt: at, finishedAt: at,
        stepStates: stored.run.stepStates.map(state => state.status === 'dispatched' ? { ...state, status: 'unknown' }
          : state.status === 'prepared' ? { ...state, status: 'failed' } : state) });
      const nextRecord = { revision: stored.revision + 1, run, receipts };
      const nextIntent = assertStoredWriteIntent({ ...intent, status: intent.status === 'completed' ? 'completed' : 'failed', recovery: {
        runId: run.id, action: request.action, reviewDigest: request.reviewDigest, resolvedAt: at,
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.replacement ? { replacementPlanId: request.replacement.plan.id } : {}),
      } });
      const next = this.bumpJournal(current, { ...current,
        runs: current.runs.map(item => item.run.id === run.id ? nextRecord : item),
        writeIntents: current.writeIntents!.map(item => item.operationId === intent.operationId ? nextIntent : item),
        plans: request.replacement ? [...current.plans, request.replacement.plan] : current.plans,
        snapshots: request.replacement ? [...current.snapshots, request.replacement.snapshot] : current.snapshots,
      });
      const validation: unknown = revalidate?.();
      if (validation !== undefined) {
        // An accidental async callback must not turn an unfinished inspection
        // into permission to persist. Consume rejection without awaiting it.
        void Promise.resolve(validation).catch(() => undefined);
        throw new Error('workspace_write_recovery_invalid');
      }
      await this.writeSnapshot(next, current, 'journal');
      return structuredClone({ intent: nextIntent, record: nextRecord, ...(request.replacement ? { replacement: request.replacement } : {}) });
    });
  }

  // ── E2-05 Multimodel ──────────────────────────────────────────────
  async putMultimodelPlan(identityId: string, plan: MultiModelPlan): Promise<MultiModelPlan> {
    assertIdentityId(identityId);
    const valid = parseMultiModelPlan(plan) as MultiModelPlan;
    if(valid.principalId!==identityId) throw new Error('workspace_multimodel_binding_invalid');
    return this.serial(projectKey(identityId, valid.projectId), async()=>{
      const current = await this.readSnapshot(identityId, valid.projectId);
      if(valid.principalId!==current.project.ownerPrincipalId) throw new Error('workspace_multimodel_binding_invalid');
      const previous = current.multimodelPlans ?? [];
      const existing = previous.find(p=>p.id===valid.id);
      if(existing){
        if(canonicalJson(existing)!==canonicalJson(valid)) throw new Error('workspace_metadata_conflict');
        return existing;
      }
      if(previous.length>=MAX_MULTIMODEL_PLANS) throw new Error('workspace_multimodel_plans_full');
      // validate snapshot binding
      const snap = current.snapshots.find(s=>s.id===valid.contextSnapshotId);
      if(!snap) throw new Error('workspace_multimodel_snapshot_missing');
      await this.writeSnapshot(this.bumpJournal(current,{...current, multimodelPlans:[...previous, valid]}), current,'journal');
      return valid;
    });
  }
  async getMultimodelPlan(identityId: string, projectId: string, planId: string): Promise<MultiModelPlan|undefined> {
    assertIdentityId(identityId);
    assertWorkflowId(planId,'workspace_multimodel_plan_id');
    return (await this.readLocked(identityId, projectId)).multimodelPlans?.find(p=>p.id===planId);
  }
  async listMultimodelPlans(identityId: string, projectId: string): Promise<MultiModelPlan[]> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).multimodelPlans ?? [];
  }
  async putMultimodelRun(identityId: string, run: MultimodelRun): Promise<MultimodelRun> {
    assertIdentityId(identityId);
    const valid = parseMultimodelRun(run) as MultimodelRun;
    if(valid.principalId!==identityId) throw new Error('workspace_multimodel_binding_invalid');
    return this.serial(projectKey(identityId, valid.projectId), async()=>{
      const current = await this.readSnapshot(identityId, valid.projectId);
      const previous = current.multimodelRuns ?? [];
      const idx = previous.findIndex(r=>r.id===valid.id);
      if(idx>=0){
        const stored = previous[idx]!;
        if(stored.revision!==valid.revision-1) throw new Error('workspace_revision_conflict');
        if(stored.planId!==valid.planId) throw new Error('workspace_metadata_conflict');
        const next=[...previous]; next[idx]=valid;
        await this.writeSnapshot(this.bumpJournal(current,{...current, multimodelRuns:next}), current,'journal');
        return valid;
      }
      if(previous.length>=MAX_MULTIMODEL_RUNS) throw new Error('workspace_multimodel_runs_full');
      // ensure plan exists
      if(!(current.multimodelPlans??[]).some(p=>p.id===valid.planId)) throw new Error('workspace_multimodel_plan_missing');
      await this.writeSnapshot(this.bumpJournal(current,{...current, multimodelRuns:[...previous, valid]}), current,'journal');
      return valid;
    });
  }
  async getMultimodelRun(identityId: string, projectId: string, runId: string): Promise<MultimodelRun|undefined> {
    assertIdentityId(identityId);
    assertWorkflowId(runId,'workspace_multimodel_run_id');
    return (await this.readLocked(identityId, projectId)).multimodelRuns?.find(r=>r.id===runId);
  }
  async listMultimodelRuns(identityId: string, projectId: string): Promise<MultimodelRun[]> {
    assertIdentityId(identityId);
    return (await this.readLocked(identityId, projectId)).multimodelRuns ?? [];
  }
  async commitMultimodelRun(identityId: string, projectId: string, runId: string, expectedRevision: number, next: MultimodelRun): Promise<{kind:'committed';run:MultimodelRun}|{kind:'conflict'}> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId,'workspace_project_id');
    assertWorkflowId(runId,'workspace_multimodel_run_id');
    if(!Number.isSafeInteger(expectedRevision)||expectedRevision<1) throw new Error('workspace_revision_invalid');
    return this.serial(projectKey(identityId, projectId), async()=>{
      const current = await this.readSnapshot(identityId, projectId);
      const idx = (current.multimodelRuns??[]).findIndex(r=>r.id===runId);
      if(idx<0) return {kind:'conflict'};
      const stored = current.multimodelRuns![idx]!;
      if(stored.revision!==expectedRevision) return {kind:'conflict'};
      const valid = parseMultimodelRun({...next, revision: expectedRevision+1}) as MultimodelRun;
      if(valid.id!==runId||valid.projectId!==projectId||valid.principalId!==identityId) return {kind:'conflict'};
      const updated=[...(current.multimodelRuns??[])]; updated[idx]=valid;
      await this.writeSnapshot(this.bumpJournal(current,{...current, multimodelRuns:updated}), current,'journal');
      return {kind:'committed',run:valid};
    });
  }

  async acknowledgeTelemetry(identityId: string, projectId: string, delivery: TelemetryDelivery): Promise<boolean> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    const valid = parseTelemetryDelivery(delivery);
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const run = current.runs.find(item => item.run.id === valid.runId);
      if (!run || run.revision !== valid.runRevision) return false;
      const previous = current.telemetryDeliveries ?? [];
      const key = (item: TelemetryDelivery) => `${item.destinationId}:${item.runId}`;
      const found = previous.find(item => key(item) === key(valid));
      if (found && canonicalJson(found) === canonicalJson(valid)) return true;
      const next = previous.filter(item => key(item) !== key(valid));
      next.push(valid);
      // Metadata cannot grow with every retry. At most four explicitly configured destinations per run.
      if (next.filter(item => item.runId === valid.runId).length > 4) throw new Error("workspace_telemetry_destinations_full");
      await this.writeSnapshot(this.bumpJournal(current, { ...current, telemetryDeliveries: next }), current, "journal");
      return true;
    });
  }

  /** Local composition only; no data is sent by discovery. Used for resuming journal-derived delivery. */
  async listJournalProjects(): Promise<Array<{ identityId: string; projectId: string }>> {
    const result: Array<{ identityId: string; projectId: string }> = [];
    const valid = (name: string) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name);
    for (const identityId of await readdir(this.root)) {
      if (!valid(identityId)) continue;
      let projects: string[];
      try { projects = await readdir(this.identityDir(identityId)); } catch { continue; }
      for (const projectId of projects) if (valid(projectId)) result.push({ identityId, projectId });
    }
    return result;
  }

  async putPlan(identityId: string, plan: ExecutionPlan, snapshot: ContextSnapshot): Promise<ExecutionPlan> {
    const valid = parseExecutionPlan(plan), context = parseContextSnapshot(snapshot);
    await this.mutateMetadata(identityId, valid.projectId, (bundle) => {
      // Keep the active run visible. This check shares the store's writer lock with
      // run creation, so another client cannot hide it by racing a new plan.
      if(bundle.runs.some(slot=>JOURNAL_ACTIVE.has(slot.run.status))&&!bundle.plans.some(item=>item.id===valid.id))throw new Error('project_run_active');
      this.assertRevision(valid.projectRevision, bundle.project.revision);
      assertPlanSnapshot(valid, context, bundle.project);
      const expected = createContextSnapshot({ id: context.id, createdAt: context.createdAt, project: bundle.project,
        artifacts: bundle.artifacts, selectedEntryIds: context.entries.map(entry => entry.id),
        excludedEntryIds: context.excludedEntryIds, selectedArtifactIds: context.artifacts.map(artifact => artifact.id),
        allowedDestinations: context.allowedDestinations, maxContextBytes: context.maxContextBytes });
      if (canonicalJson(expected) !== canonicalJson(context)) throw new Error("workspace_snapshot_binding_invalid");
      return { ...bundle, plans: immutableInsert(bundle.plans, valid, item => item.id),
        snapshots: immutableInsert(bundle.snapshots, context, item => item.id) };
    });
    return valid;
  }

  async getPlan(identityId: string, projectId: string, planId: string): Promise<ExecutionPlan | undefined> {
    return (await this.readLocked(identityId, projectId)).plans.find(item => item.id === planId);
  }

  async getSnapshot(identityId: string, projectId: string, snapshotId: string): Promise<ContextSnapshot | undefined> {
    return (await this.readLocked(identityId, projectId)).snapshots.find(item => item.id === snapshotId);
  }

  async putGrant(identityId: string, grant: ProjectGrant): Promise<ProjectGrant> {
    const valid = parseProjectGrant(grant);
    if (valid.principalId !== identityId) throw new Error("workspace_grant_owner_mismatch");
    await this.mutateMetadata(identityId, valid.projectId, bundle => {
      const existing = bundle.grants.find(item => item.principalId === valid.principalId);
      if (existing && canonicalJson(existing) === canonicalJson(valid)) return bundle;
      if (existing ? valid.id !== existing.id || valid.revision !== existing.revision + 1 : valid.revision !== 1) {
        throw new Error("workspace_grant_revision_conflict");
      }
      return { ...bundle, grants: [...bundle.grants.filter(item => item.principalId !== valid.principalId), valid] };
    });
    return valid;
  }

  async getGrant(identityId: string, projectId: string, principalId = identityId): Promise<ProjectGrant | undefined> {
    return (await this.readLocked(identityId, projectId)).grants.find(item => item.principalId === principalId);
  }

  async putRecipe(identityId: string, projectId: string, recipe: Recipe): Promise<Recipe> {
    const valid = parseRecipe(recipe);
    await this.mutateMetadata(identityId, projectId, bundle => ({ ...bundle,
      recipes: immutableInsert(bundle.recipes, valid, item => `${item.id}:${item.version}`) }));
    return valid;
  }

  async listRecipes(identityId: string, projectId: string): Promise<Recipe[]> {
    return (await this.readLocked(identityId, projectId)).recipes;
  }

  async putUsageValue(identityId: string, receipt: UsageValueReceipt): Promise<UsageValueReceipt> {
    const valid = parseUsageValueReceipt(receipt);
    await this.mutateMetadata(identityId, valid.projectId, bundle => ({ ...bundle,
      usageValues: immutableInsert(bundle.usageValues, valid, usageAttemptKey) }));
    return valid;
  }

  async listUsageValues(identityId: string, projectId: string): Promise<UsageValueReceipt[]> {
    return (await this.readLocked(identityId, projectId)).usageValues;
  }

  private async mutateMetadata(identityId: string, projectId: string, change: (bundle: WorkspaceBundle) => WorkspaceBundle): Promise<void> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    await this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const next = change(current);
      if (canonicalJson(next) !== canonicalJson(current)) {
        await this.writeSnapshot(this.bumpJournal(current, next), current, "journal");
      }
    });
  }

  async listProjects(identityId: string, allowedProjects:'*'|readonly string[]='*'): Promise<Array<{ id: string; revision: number; name: string; updatedAt: string }>> {
    assertIdentityId(identityId);
    const directory = this.identityDir(identityId);
    let names: string[] = [];
    try { names = await readdir(directory); } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const listed = [];
    for (const name of names) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name)) continue;
      if (allowedProjects!=='*'&&!allowedProjects.includes(name)) continue;
      try {
        const bundle = await this.serial(projectKey(identityId, name), () => this.readSnapshot(identityId, name));
        listed.push({ id: bundle.project.id, revision: bundle.project.revision, name: bundle.project.name, updatedAt: bundle.project.updatedAt });
      } catch (error) {
        if (error instanceof Error && error.message === "workspace_snapshot_corrupt") continue;
        throw error;
      }
    }
    return listed.sort((left, right) => left.updatedAt < right.updatedAt ? 1 : -1);
  }

  /** Enumerates directory names, but decrypts only the requested page (at most 100 snapshots). */
  async listProjectsPage(identityId:string,after='',limit=100,allowedProjects:'*'|readonly string[]='*') {
    assertIdentityId(identityId);
    if(after)assertWorkflowId(after,'workspace_project_cursor');
    if(!Number.isSafeInteger(limit)||limit<1||limit>100)throw new Error('workspace_project_page_limit');
    let names:string[];
    try {
      names=(await readdir(this.identityDir(identityId),{withFileTypes:true}))
        .filter(item=>item.isDirectory()&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(item.name)&&item.name>after)
        .map(item=>item.name).filter(id=>allowedProjects==='*'||allowedProjects.includes(id)).sort();
    }catch(error){if((error as NodeJS.ErrnoException).code==='ENOENT')return {projects:[],nextCursor:null};throw error;}
    const selected=names.slice(0,limit);
    const projects=[];
    for(const projectId of selected) {
      const bundle=await this.serial(projectKey(identityId,projectId),()=>this.readSnapshot(identityId,projectId));
      const {id,revision,name,updatedAt}=bundle.project;
      projects.push({id,revision,name,updatedAt});
    }
    return {projects,nextCursor:names.length>limit?selected.at(-1)!:null};
  }

  async patchProject(identityId:string,projectId:string,input:unknown):Promise<ProjectContext> {
    const {expectedRevision,...patch}=parseWorkflowCommand('patchProject',input);
    return this.mutate(identityId,projectId,expectedRevision,bundle=>{
      if(bundle.runs.some(item=>JOURNAL_ACTIVE.has(item.run.status)))throw new Error('project_run_active');
      return {...bundle,project:parseProjectContext({...bundle.project,...patch})};
    });
  }

  async appendEntry(
    identityId: string,
    projectId: string,
    expectedRevision: number,
    entry: Omit<ContextEntry, "createdAt" | "id" | "supersedes"> & { id?: string; supersedes?: string | null },
    actor: ContextActor,
  ): Promise<ProjectContext> {
    return this.mutate(identityId, projectId, expectedRevision, (bundle) => {
      const created = createContextEntry({
        ...entry,
        id: entry.id ?? randomUUID(),
        createdAt: this.isoNow(),
        supersedes: entry.supersedes ?? null,
      });
      return {
        ...bundle,
        project: { ...bundle.project, entries: appendContextEntry(bundle.project.entries, created, actor) },
      };
    });
  }

  async confirmHypothesis(
    identityId: string,
    projectId: string,
    expectedRevision: number,
    hypothesisId: string,
    actor: ContextActor,
  ): Promise<ProjectContext> {
    return this.mutate(identityId, projectId, expectedRevision, (bundle) => ({
      ...bundle,
      project: {
        ...bundle.project,
        entries: confirmHypothesisAsDecision(bundle.project.entries, hypothesisId, randomUUID(), actor, this.isoNow()),
      },
    }));
  }

  async putTextArtifact(
    identityId: string,
    projectId: string,
    expectedRevision: number,
    mediaType: Artifact["mediaType"],
    text: string,
    artifactId: string = randomUUID(),
    provenance?: {runId:string;receiptRefs:string[];sourceRefs:string[];requireDispatchedAttemptId?:string},
  ): Promise<{ project: ProjectContext; artifactId: string }> {
    const saved=await this.putTextArtifacts(identityId,projectId,expectedRevision,[{artifactId,mediaType,text}],provenance);
    return {project:saved.project,artifactId:saved.artifactIds[0]!};
  }

  /** Seal every member before atomically exposing primary + canonical response in one revision. */
  async putTextArtifacts(
    identityId:string, projectId:string, expectedRevision:number,
    items:readonly {artifactId:string;mediaType:Artifact["mediaType"];text:string}[],
    provenance?:{runId:string;receiptRefs:string[];sourceRefs:string[];requireDispatchedAttemptId?:string},
  ):Promise<{project:ProjectContext;artifactIds:string[]}> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId,"workspace_project_id");
    if(!Array.isArray(items)||items.length<1||items.length>2||new Set(items.map(item=>item?.artifactId)).size!==items.length)
      throw new Error('workspace_artifact_batch_invalid');
    const inputs=items.map(item=>{
      if(!item||typeof item.text!=='string')throw new Error('workspace_artifact_batch_invalid');
      if(['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4','image/png','image/jpeg','image/webp','video/mp4'].includes(item.mediaType))throw new Error('workspace_artifact_media_type_invalid');
      return {artifactId:item.artifactId,mediaType:item.mediaType,bytes:new TextEncoder().encode(item.text)};
    });
    return this.putArtifactBytes(identityId,projectId,expectedRevision,inputs,provenance);
  }

  async putBinaryArtifact(identityId:string,projectId:string,expectedRevision:number,mediaType:Artifact['mediaType'],
    bytes:Uint8Array,artifactId:string=randomUUID(),
    provenance?:{runId:string;receiptRefs:string[];sourceRefs:string[];requireDispatchedAttemptId?:string},
  ):Promise<{project:ProjectContext;artifactId:string}> {
    const saved=await this.putBinaryArtifacts(identityId,projectId,expectedRevision,[{artifactId,mediaType,bytes}],provenance);
    return {project:saved.project,artifactId:saved.artifactIds[0]!};
  }

  async putBinaryArtifacts(identityId:string,projectId:string,expectedRevision:number,
    items:readonly {artifactId:string;mediaType:Artifact['mediaType'];bytes:Uint8Array}[],
    provenance?:{runId:string;receiptRefs:string[];sourceRefs:string[];requireDispatchedAttemptId?:string},
  ):Promise<{project:ProjectContext;artifactIds:string[]}> {
    if(!Array.isArray(items)||items.length<1||items.length>IMAGE_BATCH_MAX||new Set(items.map(item=>item?.artifactId)).size!==items.length)
      throw new Error('workspace_artifact_batch_invalid');
    const inputs=items.map(item=>{
      if(!item||!['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4','image/png','image/jpeg','image/webp','video/mp4'].includes(item.mediaType)||!(item.bytes instanceof Uint8Array))
        throw new Error('workspace_artifact_media_type_invalid');
      const bytes=new Uint8Array(item.bytes);
      if(item.mediaType.startsWith('image/')&&detectImageMediaType(bytes)!==item.mediaType)throw new Error('workspace_artifact_media_type_invalid');
      return {artifactId:item.artifactId,mediaType:item.mediaType,bytes};
    });
    return this.putArtifactBytes(identityId,projectId,expectedRevision,inputs,provenance);
  }

  private async putArtifactBytes(identityId:string,projectId:string,expectedRevision:number,
    inputs:readonly {artifactId:string;mediaType:Artifact['mediaType'];bytes:Uint8Array}[],
    provenance?:{runId:string;receiptRefs:string[];sourceRefs:string[];requireDispatchedAttemptId?:string},
  ):Promise<{project:ProjectContext;artifactIds:string[]}> {
    assertIdentityId(identityId);assertWorkflowId(projectId,'workspace_project_id');
    if(provenance)provenance={...provenance,receiptRefs:[...provenance.receiptRefs],sourceRefs:[...provenance.sourceRefs]};
    return this.serial(projectKey(identityId,projectId),async()=>{
      const current=await this.readSnapshot(identityId,projectId);
      this.assertRevision(expectedRevision,current.project.revision);
      this.sinkPolicy.assertSinkAllowed(identityId, "filesystem:artifacts");
      if(provenance) {
        const producer=current.runs.find(item=>item.run.id===provenance.runId);
        if(!producer||provenance.receiptRefs.some(id=>!producer.receipts.some(receipt=>receipt.id===id))||provenance.sourceRefs.some(id=>!producer.receipts.some(receipt=>receipt.sources.some(source=>source.id===id))))throw new Error('workspace_artifact_provenance_invalid');
        // Shares the journal's project lock: cancellation and artifact publication have one order.
        if(provenance.requireDispatchedAttemptId!==undefined&&(producer.run.status!=='running'||
          !producer.receipts.some(receipt=>receipt.attemptId===provenance.requireDispatchedAttemptId&&receipt.status==='dispatched')))
          throw new Error('workspace_artifact_attempt_inactive');
      }
      // Validate every immutable record before writing any new artifact file.
      const prepared=inputs.map(item=>{
        if(current.privacyPurges?.some(p=>p.targetClass==='artifact'&&p.targetId===item.artifactId))throw new WorkspacePrivacyError('privacy_resource_purged',409);
        const existing=current.artifacts.find(artifact=>artifact.id===item.artifactId);
        const artifact=createArtifactRecord({id:item.artifactId,createdAt:existing?.createdAt??this.isoNow(),projectId,
          runId:provenance?.runId??current.runs.find(slot=>JOURNAL_ACTIVE.has(slot.run.status))?.run.id??current.runs.at(-1)?.run.id??"unassigned",
          version:existing?.version??1,mediaType:item.mediaType,bytes:item.bytes,receiptRefs:provenance?.receiptRefs,sourceRefs:provenance?.sourceRefs});
        assertImmutableReplace(existing,artifact);
        return {...item,artifact,existing};
      });
      const additions=prepared.filter(item=>!item.existing);
      const next=this.bump(current,{...current,artifacts:[...current.artifacts,...additions.map(item=>item.artifact)],
        project:{...current.project,artifactRefs:[...current.project.artifactRefs,...additions.map(item=>item.artifactId)]}});
      const nextBytes=Buffer.byteLength(JSON.stringify(next),'utf8');
      if(nextBytes>SNAPSHOT_JSON_MAX_BYTES)throw new Error('workspace_snapshot_too_large');
      projectByteLength(nextBytes,next.artifacts);
      for(const item of prepared)if(!item.existing)
        await this.writeSealed(this.artifactPath(identityId,projectId,item.artifactId),item.bytes,identityId,projectId,`artifact:${item.artifactId}`,sealedJsonByteLimit(artifactByteLimit(item.mediaType)));
      await this.writeSnapshot(next,current,"project");
      await this.collectOrphans(next);
      return {project:next.project,artifactIds:prepared.map(item=>item.artifactId)};
    });
  }

  /** V6: sealed bytes after the byteLength/SHA-256 check, undecoded, for structural verification. */
  async readArtifactRaw(identityId: string, projectId: string, artifactId: string, binary: boolean): Promise<Uint8Array> {
    return (await this.readArtifactBytes(identityId, projectId, artifactId, binary)).bytes;
  }

  async readTextArtifact(identityId: string, projectId: string, artifactId: string): Promise<string> {
    const {bytes}=await this.readArtifactBytes(identityId,projectId,artifactId,false);
    return new TextDecoder('utf-8',{fatal:true}).decode(bytes);
  }

  async listPrivacyResources(identityId:string,allowedProjects:'*'|readonly string[]='*'):Promise<PrivacyResource[]> {
    const resources:PrivacyResource[]=[];
    for(const project of await this.listProjects(identityId,allowedProjects)) {
      const bundle=await this.getBundle(identityId,project.id);
      for(const artifact of bundle.artifacts)resources.push({targetClass:'artifact',targetId:`${project.id}/${artifact.id}`,projectId:project.id,name:artifact.filename,createdAt:artifact.createdAt,blockedReason:privacyBlock(bundle,'artifact',artifact.id)});
      for(const slot of bundle.runs)for(const receipt of slot.receipts)resources.push({targetClass:'local_receipts',targetId:`${project.id}/${receipt.id}`,projectId:project.id,name:`${receipt.capabilityId} · ${receipt.status}`,createdAt:receipt.createdAt,blockedReason:privacyBlock(bundle,'local_receipts',receipt.id)});
    }
    return resources;
  }

  async exportPrivacyReceipts(identityId:string,includeContent=false,allowedProjects:'*'|readonly string[]='*'):Promise<unknown[]> {
    this.sinkPolicy.assertSinkAllowed(identityId, "fs:export");
    const items:unknown[]=[];
    for(const project of await this.listProjects(identityId,allowedProjects)) {
      const bundle=await this.getBundle(identityId,project.id);
      for(const slot of bundle.runs)for(const receipt of slot.receipts)items.push({...receipt,...(!includeContent?{sources:[],contentOmitted:true}:{})});
    }
    return items;
  }

  async purgePrivacyResource(identityId:string,targetClass:PrivacyPurge['targetClass'],targetId:string,revalidate?:()=>Promise<void>):Promise<boolean> {
    assertIdentityId(identityId);
    const parts=targetId.split('/');
    if(parts.length!==2||parts.some(part=>!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(part)))throw new WorkspacePrivacyError('privacy_target_invalid',400);
    const [projectId,id]=parts as [string,string];
    return this.serial(projectKey(identityId,projectId),async()=>{
      let current:WorkspaceBundle;
      try{current=await this.readSnapshot(identityId,projectId);}catch(error){if(error instanceof Error&&error.message==='workspace_project_not_found')throw new WorkspacePrivacyError('privacy_resource_not_found',404);throw error;}
      await revalidate?.();
      const already=current.privacyPurges?.some(item=>item.targetClass===targetClass&&item.targetId===id);
      if(!already){
        const exists=targetClass==='artifact'?current.artifacts.some(item=>item.id===id):current.runs.some(item=>item.receipts.some(receipt=>receipt.id===id));
        if(!exists)throw new WorkspacePrivacyError('privacy_resource_not_found',404);
        const blocked=privacyBlock(current,targetClass,id);if(blocked)throw new WorkspacePrivacyError(blocked,409);
        if((current.privacyPurges?.length??0)>=4096)throw new WorkspacePrivacyError('privacy_journal_full',409);
        const privacyPurges=[...(current.privacyPurges??[]),{targetClass,targetId:id,purgedAt:this.isoNow()}];
        if(targetClass==='artifact'){
          const next=this.bump(current,{...current,privacyPurges,artifacts:current.artifacts.filter(item=>item.id!==id),project:{...current.project,artifactRefs:current.project.artifactRefs.filter(ref=>ref!==id)}});
          await this.writeSnapshot(next,current,'project',revalidate);
        }else{
          // Retain the terminal run/request identity: forgetting it could execute a retried request twice.
          const runs=current.runs.map(slot=>slot.receipts.some(receipt=>receipt.id===id)?{...slot,revision:slot.revision+1,receipts:slot.receipts.filter(receipt=>receipt.id!==id),run:{...slot.run,stepStates:slot.run.stepStates.map(step=>({...step,receiptIds:step.receiptIds.filter(ref=>ref!==id)}))}}:slot);
          await this.writeSnapshot(this.bumpJournal(current,{...current,privacyPurges,runs}),current,'journal',revalidate);
        }
      }
      // Snapshot first, bytes second. A durable tombstone makes interrupted unlink retryable.
      if(targetClass==='artifact'){
        await revalidate?.();
        await unlink(this.artifactPath(identityId,projectId,id)).catch(error=>{if(error.code!=='ENOENT')throw error;});
      }
      const observations=getBoundUsageObservabilityStore();
      if(observations){projectJournalUsage(observations,await this.readSnapshot(identityId,projectId));await saveUsageObservabilityPersist(this.projectDir(identityId,projectId),observations,identityId,projectId);}
      return true;
    });
  }

  async readBinaryArtifact(identityId:string,projectId:string,artifactId:string):Promise<Uint8Array> {
    return (await this.readBinaryArtifactMedia(identityId,projectId,artifactId)).bytes;
  }

  async readBinaryArtifactMedia(identityId:string,projectId:string,artifactId:string):Promise<{bytes:Uint8Array;mediaType:Artifact['mediaType'];filename:string}> {
    return this.readArtifactBytes(identityId,projectId,artifactId,true);
  }

  private async readArtifactBytes(identityId:string,projectId:string,artifactId:string,binary:boolean):Promise<{bytes:Uint8Array;mediaType:Artifact['mediaType'];filename:string}> {
    return this.serial(projectKey(identityId, projectId), async () => {
      const bundle = await this.readSnapshot(identityId, projectId);
      const artifact = bundle.artifacts.find((item) => item.id === artifactId);
      if (!artifact) throw new Error("workspace_artifact_not_found");
      if(['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4','image/png','image/jpeg','image/webp','video/mp4'].includes(artifact.mediaType)!==binary)throw new Error('workspace_artifact_media_type_invalid');
      const bytes = await this.readSealed(this.artifactPath(identityId, projectId, artifactId), identityId, projectId, `artifact:${artifactId}`, sealedJsonByteLimit(artifactByteLimit(artifact.mediaType)));
      if (bytes.byteLength !== artifact.byteLength || sha256Hex(bytes) !== artifact.sha256) throw new Error("workspace_artifact_hash_mismatch");
      return {bytes:new Uint8Array(bytes),mediaType:artifact.mediaType,filename:artifact.filename};
    });
  }

  async putApprovalOccupancy(identityId: string, projectId: string, occupancy: ApprovalOccupancy): Promise<ApprovalOccupancy> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    const valid = assertApprovalOccupancy(occupancy);
    if (valid.projectId !== projectId || valid.principalId !== identityId) throw new Error("workspace_approval_invalid");
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const existing = current.approvals.find((item) => item.id === valid.id || item.planId === valid.planId);
      if (existing?.consumedByRunId) throw new Error("workspace_approval_consumed");
      const approvals = existing
        ? current.approvals.map((item) => item.id === existing.id || item.planId === existing.planId ? valid : item)
        : [...current.approvals, valid];
      await this.writeSnapshot(this.bumpJournal(current, { ...current, approvals }), current, "journal");
      return valid;
    });
  }

  async readApprovalOccupancy(identityId: string, projectId: string, planId: string): Promise<ApprovalOccupancy | undefined> {
    const bundle = await this.readLocked(identityId, projectId);
    return bundle.approvals.find((item) => item.planId === planId);
  }

  async findRunByRequest(identityId: string, projectId: string, principalId: string, requestId: string): Promise<JournalRunRecord | undefined> {
    const bundle = await this.readLocked(identityId, projectId);
    const found = bundle.runs.find((item) => item.run.principalId === principalId && item.run.requestId === requestId);
    return found ? cloneRecord(found) : undefined;
  }

  async readRun(identityId: string, projectId: string, runId: string): Promise<JournalRunRecord | undefined> {
    const bundle = await this.readLocked(identityId, projectId);
    const found = bundle.runs.find((item) => item.run.id === runId);
    return found ? cloneRecord(found) : undefined;
  }

  /**
   * Atômico no mesmo snapshot: dedup por (principalId, requestId); recusa se há run ativo;
   * consome ApprovalOccupancy.consumedByRunId = run.id. Não altera ProjectContext.revision.
   * Esta operação segue o contrato canônico de PlanApproval e RunJournal.createRun.
   */
  async consumeApprovalAndCreateRun(identityId: string, run: Run, approvalId: string): Promise<JournalCreateRunResult> {
    assertIdentityId(identityId);
    assertWorkflowId(approvalId, "workspace_approval_id");
    return this.serial(projectKey(identityId, run.projectId), async () => {
      const current = await this.readSnapshot(identityId, run.projectId);
      const parsed = assertStoredRun(run, current.project);
      const existing = current.runs.find((item) => item.run.principalId === parsed.principalId && item.run.requestId === parsed.requestId);
      if (existing) return { kind: "existing", record: cloneRecord(existing) };
      if (current.runs.some((item) => JOURNAL_ACTIVE.has(item.run.status))) return { kind: "conflict", code: "project_run_active" };
      const approval = current.approvals.find((item) => item.id === approvalId);
      if (!approval || approval.consumedByRunId !== null || approval.planId !== parsed.planId ||
          approval.projectId !== parsed.projectId || approval.principalId !== parsed.principalId ||
          approval.planDigest !== parsed.planDigest || Date.parse(approval.expiresAt) <= this.now().getTime()) {
        return { kind: "conflict", code: "approval_consumed" };
      }
      if (current.runs.some((item) => item.run.id === parsed.id)) throw new Error("workspace_run_id_duplicate");
      if (current.runs.length >= MAX_JOURNAL_RUNS) throw new Error("workspace_journal_full");
      const record: JournalRunRecord = { revision: 1, run: parsed, receipts: [] };
      const next = this.bumpJournal(current, {
        ...current,
        approvals: current.approvals.map((item) => item.id === approvalId ? { ...item, consumedByRunId: parsed.id } : item),
        runs: [...current.runs, record],
      });
      await this.writeSnapshot(next, current, "journal");
      return { kind: "created", record: cloneRecord(record) };
    });
  }

  async commitRun(
    identityId: string,
    projectId: string,
    runId: string,
    expectedRevision: number,
    next: { run: Run; receipts: ExecutionReceipt[] },
  ): Promise<JournalCommitResult> {
    return this.commitRunInternal(identityId,projectId,runId,expectedRevision,next);
  }
  async commitEffectArtifacts(identityId:string,projectId:string,runId:string,expectedRevision:number,next:{run:Run;receipts:ExecutionReceipt[]},artifacts:readonly EffectArtifact[]):Promise<JournalCommitResult>{
    if(!Array.isArray(artifacts)||artifacts.length<1||artifacts.length>IMAGE_BATCH_MAX||new Set(artifacts.map(item=>item.artifactId)).size!==artifacts.length)throw new Error('workspace_artifact_batch_invalid');
    const copied=artifacts.map(item=>{if(!(item.bytes instanceof Uint8Array))throw new Error('workspace_artifact_size_invalid');return {...item,bytes:new Uint8Array(item.bytes)};});
    return this.commitRunInternal(identityId,projectId,runId,expectedRevision,structuredClone(next),copied);
  }
  private async commitRunInternal(
    identityId: string,
    projectId: string,
    runId: string,
    expectedRevision: number,
    next: { run: Run; receipts: ExecutionReceipt[] },
    artifacts?:readonly EffectArtifact[],
  ): Promise<JournalCommitResult> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    assertWorkflowId(runId, "workspace_run_id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("workspace_revision_invalid");
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      const index = current.runs.findIndex((item) => item.run.id === runId);
      if (index < 0) return { kind: "conflict" };
      const stored = current.runs[index]!;
      if (stored.revision !== expectedRevision) return { kind: "conflict" };
      if (current.writeIntents?.some(intent => intent.recovery?.runId === runId)) return { kind: 'conflict' };
      const run = assertStoredRun(next.run, current.project);
      if (run.id !== runId || run.projectId !== projectId || run.requestId !== stored.run.requestId || run.principalId !== stored.run.principalId) {
        return { kind: "conflict" };
      }
      const receipts = next.receipts.map((receipt) => asContract(() => parseExecutionReceipt(receipt), "workspace_receipt_invalid"));
      if(receipts.some(receipt=>current.privacyPurges?.some(p=>p.targetClass==='local_receipts'&&p.targetId===receipt.id)))throw new WorkspacePrivacyError('privacy_resource_purged',409);
      if (receipts.some((receipt) => receipt.projectId !== projectId || receipt.runId !== runId)) return { kind: "conflict" };
      const record: JournalRunRecord = { revision: expectedRevision + 1, run, receipts };
      const runs = current.runs.map((item, offset) => offset === index ? record : item);
      if(artifacts){
        if(stored.run.status!=='running'||run.status!=='running')return {kind:'conflict'};
        const changed=receipts.filter(receipt=>stored.receipts.some(old=>old.id===receipt.id&&old.status==='dispatched')&&receipt.status==='succeeded');
        if(changed.length!==1)throw new Error('workspace_artifact_settlement_invalid');
        const receipt=changed[0]!,old=stored.receipts.find(item=>item.id===receipt.id)!;
        if(receipt.attemptId!==old.attemptId||receipt.stepId!==old.stepId||receipt.capabilityId!==old.capabilityId||canonicalJson([...receipt.outputArtifactRefs].sort())!==canonicalJson(artifacts.map(item=>item.artifactId).sort()))throw new Error('workspace_artifact_settlement_invalid');
        for(const key of ['planId','planDigest','policyRevision','createdAt'] as const)if(run[key]!==stored.run[key])throw new Error('workspace_artifact_settlement_invalid');
        for(const key of ['id','createdAt','projectId','runId','stepId','attemptId','capabilityId','capabilityVersion','startedAt','inputArtifactRefs'] as const)if(canonicalJson(receipt[key])!==canonicalJson(old[key]))throw new Error('workspace_artifact_settlement_invalid');
        if(receipts.length!==stored.receipts.length||stored.receipts.some(previous=>previous.id!==old.id&&canonicalJson(receipts.find(item=>item.id===previous.id))!==canonicalJson(previous)))throw new Error('workspace_artifact_settlement_invalid');
        const prepared=artifacts.map(item=>{
          if(current.privacyPurges?.some(p=>p.targetClass==='artifact'&&p.targetId===item.artifactId))throw new WorkspacePrivacyError('privacy_resource_purged',409);
          if(item.mediaType.startsWith('image/')&&detectImageMediaType(item.bytes)!==item.mediaType)throw new Error('workspace_artifact_media_type_invalid');
          const existing=current.artifacts.find(value=>value.id===item.artifactId);
          const artifact=createArtifactRecord({id:item.artifactId,projectId,runId,createdAt:existing?.createdAt??receipt.finishedAt!,version:existing?.version??1,mediaType:item.mediaType,bytes:item.bytes,receiptRefs:[receipt.id],sourceRefs:receipt.sources.map(source=>source.id)});
          assertImmutableReplace(existing,artifact);return {...item,artifact,existing};
        });
        const additions=prepared.filter(item=>!item.existing);
        const updated=this.bump(current,{...current,runs,artifacts:[...current.artifacts,...additions.map(item=>item.artifact)],project:{...current.project,artifactRefs:[...current.project.artifactRefs,...additions.map(item=>item.artifactId)]}});
        updated.journalRevision=current.journalRevision+1;
        this.sinkPolicy.assertSinkAllowed(identityId,"filesystem:artifacts");
        const bytes=Buffer.byteLength(JSON.stringify(updated));if(bytes>SNAPSHOT_JSON_MAX_BYTES)throw new Error('workspace_snapshot_too_large');projectByteLength(bytes,updated.artifacts);
        for(const item of additions)await this.writeSealed(this.artifactPath(identityId,projectId,item.artifactId),item.bytes,identityId,projectId,`artifact:${item.artifactId}`,sealedJsonByteLimit(artifactByteLimit(item.mediaType)));
        await this.writeSnapshot(updated,current,'settlement');
      }else await this.writeSnapshot(this.bumpJournal(current, { ...current, runs }), current, "journal");
      return { kind: "committed", record: cloneRecord(record) };
    });
  }

  async listRecoverable(): Promise<Array<{ identityId: string; projectId: string; runId: string }>> {
    let identities: string[] = [];
    try { identities = await readdir(this.root); } catch { return []; }
    const recoverable: Array<{ identityId: string; projectId: string; runId: string }> = [];
    for (const identityId of identities) {
      if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(identityId)) continue;
      let projects: string[] = [];
      try { projects = await readdir(this.identityDir(identityId)); } catch { continue; }
      for (const projectId of projects) {
        if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(projectId)) continue;
        try {
          const bundle = await this.serial(projectKey(identityId, projectId), () => this.readSnapshot(identityId, projectId));
          for (const item of bundle.runs) {
            if (item.run.status === "running") recoverable.push({ identityId, projectId, runId: item.run.id });
          }
        } catch (error) {
          if (error instanceof Error && error.message === "workspace_project_not_found") continue;
          throw error;
        }
      }
    }
    return recoverable;
  }

  async snapshotContext(
    identityId: string,
    projectId: string,
    input: {
      selectedEntryIds: string[];
      excludedEntryIds: string[];
      selectedArtifactIds: string[];
      allowedDestinations: DataDestination[];
      maxContextBytes: number;
    },
  ): Promise<ContextSnapshot> {
    const bundle = await this.readLocked(identityId, projectId);
    return createContextSnapshot({
      id: randomUUID(),
      createdAt: this.isoNow(),
      project: bundle.project,
      artifacts: bundle.artifacts,
      ...input,
    });
  }

  async deleteProject(identityId: string, projectId: string, expectedRevision?:number): Promise<void> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    await this.serial(projectKey(identityId, projectId), async () => {
      const bundle = await this.readSnapshot(identityId, projectId);
      if(expectedRevision!==undefined)this.assertRevision(expectedRevision,bundle.project.revision);
      if (bundle.runs.some((item) => ACTIVE_RUN.has(item.run.status))) throw new Error("workspace_delete_run_active");
      await rm(this.projectDir(identityId, projectId), { recursive: true, force: true });
    });
  }

  private mutate(
    identityId: string,
    projectId: string,
    expectedRevision: number,
    update: (bundle: WorkspaceBundle) => WorkspaceBundle,
  ): Promise<ProjectContext> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1) throw new Error("workspace_revision_invalid");
    return this.serial(projectKey(identityId, projectId), async () => {
      const current = await this.readSnapshot(identityId, projectId);
      this.assertRevision(expectedRevision, current.project.revision);
      const next = this.bump(current, update(current));
      await this.writeSnapshot(next, current, "project");
      await this.collectOrphans(next);
      return next.project;
    });
  }

  private bump(current: WorkspaceBundle, next: WorkspaceBundle): WorkspaceBundle {
    const revision = current.project.revision + 1;
    if (revision <= current.project.revision) throw new Error("workspace_revision_not_monotonic");
    return {
      ...next,
      persistSchema: BUNDLE_SCHEMA,
      journalRevision: current.journalRevision,
      runs: next.runs,
      approvals: next.approvals,
      artifacts: next.artifacts,
      project: assertStoredProject({
        ...next.project,
        ownerPrincipalId: current.project.ownerPrincipalId,
        id: current.project.id,
        schemaVersion: 1,
        createdAt: current.project.createdAt,
        revision,
        updatedAt: this.isoNow(),
      }),
    };
  }

  private bumpJournal(current: WorkspaceBundle, next: WorkspaceBundle): WorkspaceBundle {
    const journalRevision = current.journalRevision + 1;
    if (journalRevision <= current.journalRevision) throw new Error("workspace_journal_revision_not_monotonic");
    if (next.project.revision !== current.project.revision || next.project.id !== current.project.id) {
      throw new Error("workspace_journal_must_not_mutate_project");
    }
    return {
      ...next,
      persistSchema: BUNDLE_SCHEMA,
      project: current.project,
      journalRevision,
      runs: next.runs,
      approvals: next.approvals,
      artifacts: current.artifacts,
    };
  }

  private assertRevision(expected: number, actual: number): void {
    if (expected !== actual) throw new WorkspaceConflictError(expected, actual);
  }

  private async readLocked(identityId: string, projectId: string): Promise<WorkspaceBundle> {
    assertIdentityId(identityId);
    assertWorkflowId(projectId, "workspace_project_id");
    return this.serial(projectKey(identityId, projectId), () => this.readSnapshot(identityId, projectId));
  }

  private async writeSnapshot(bundle: WorkspaceBundle, previous: WorkspaceBundle | undefined, kind: "create" | "project" | "journal" | "settlement",beforeCommit?:()=>Promise<void>): Promise<void> {
    const valid = assertStoredBundle(bundle);
    this.sinkPolicy.assertSinkAllowed(valid.project.ownerPrincipalId, "sqlite:runs");
    if (previous && (valid.project.id !== previous.project.id || valid.project.ownerPrincipalId !== previous.project.ownerPrincipalId)) {
      throw new Error("workspace_project_identity_mismatch");
    }
    if (kind === "create") {
      if (previous || valid.project.revision !== 1 || valid.journalRevision !== 0) throw new Error("workspace_revision_not_monotonic");
    } else if (!previous) {
      throw new Error("workspace_revision_not_monotonic");
    } else if (kind === "settlement") {
      if(valid.project.revision!==previous.project.revision+1||valid.journalRevision!==previous.journalRevision+1)throw new Error("workspace_settlement_revision_invalid");
    } else if (kind === "project") {
      if (valid.project.revision !== previous.project.revision + 1) throw new Error("workspace_revision_not_monotonic");
      if (valid.journalRevision !== previous.journalRevision) throw new Error("workspace_journal_revision_not_monotonic");
    } else if (valid.project.revision !== previous.project.revision || valid.journalRevision !== previous.journalRevision + 1) {
      throw new Error("workspace_revision_not_monotonic");
    }
    const encoded = Buffer.from(JSON.stringify(valid), "utf8");
    if (encoded.byteLength > SNAPSHOT_JSON_MAX_BYTES) throw new Error("workspace_snapshot_too_large");
    projectByteLength(encoded.byteLength, valid.artifacts);
    await mkdir(this.artifactsDir(valid.project.ownerPrincipalId, valid.project.id), { recursive: true, mode: 0o700 });
    await this.writeSealed(
      this.snapshotPath(valid.project.ownerPrincipalId, valid.project.id),
      encoded,
      valid.project.ownerPrincipalId,
      valid.project.id,
      "snapshot",
      sealedJsonByteLimit(SNAPSHOT_JSON_MAX_BYTES),
      valid.project.revision,
      beforeCommit,
    );
    // E2-15 — persist usage observability sidecar (additive; missing⇒empty)
    {
      const obs = getBoundUsageObservabilityStore();
      if (obs) {
        projectJournalUsage(obs,valid);
        await saveUsageObservabilityPersist(this.projectDir(valid.project.ownerPrincipalId, valid.project.id), obs, valid.project.ownerPrincipalId, valid.project.id).catch(() => undefined);
      }
    }
  }

  private async readSnapshot(identityId: string, projectId: string): Promise<WorkspaceBundle> {
    const path = this.snapshotPath(identityId, projectId);
    let sealed: unknown;
    try {
      sealed = await readJson(path, null, sealedJsonByteLimit(SNAPSHOT_JSON_MAX_BYTES));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "json_state_path_invalid") {
        throw new Error("workspace_project_not_found");
      }
      throw new Error("workspace_snapshot_corrupt");
    }
    if (sealed === null) throw new Error("workspace_project_not_found");
    const envelope = assertSealedEnvelope(sealed);
    if (envelope.identityId !== identityId || envelope.projectId !== projectId) throw new Error("workspace_project_not_found");
    let bytes: Uint8Array;
    try {
      bytes = await this.openSealed(envelope, identityId, projectId, "snapshot");
    } catch (error) {
      if (error instanceof Error && error.message === "secret_store_read_unavailable") throw error;
      throw new Error("workspace_snapshot_corrupt");
    }
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
    catch { throw new Error("workspace_snapshot_corrupt"); }
    const bundle = assertStoredBundle(parsed);
    if (bundle.project.ownerPrincipalId !== identityId || bundle.project.id !== projectId || bundle.project.revision !== envelope.revision) {
      throw new Error("workspace_snapshot_corrupt");
    }
    // E2-15 — restore usage observability sidecar (absent ⇒ leave store empty; absent≠0)
    {
      const obs = getBoundUsageObservabilityStore();
      if (obs) {
        const snap = await loadUsageObservabilityPersist(this.projectDir(identityId, projectId));
        restoreUsageObservabilityFromPersist(obs, snap, identityId, projectId);
        projectJournalUsage(obs,bundle);
      }
    }
    return bundle;
  }

  private async collectOrphans(bundle: WorkspaceBundle): Promise<void> {
    const directory = this.artifactsDir(bundle.project.ownerPrincipalId, bundle.project.id);
    let names: string[] = [];
    try { names = await readdir(directory); } catch { return; }
    const live = new Set(bundle.artifacts.map((artifact) => `${artifact.id}.json`));
    for (const name of names) {
      if (!live.has(name) && name.endsWith(".json")) await unlink(join(directory, name)).catch(() => undefined);
    }
  }

  private async writeSealed(
    path: string,
    plaintext: Uint8Array,
    identityId: string,
    projectId: string,
    aadKind: string,
    maximum: number,
    revision?: number,
    beforeCommit?:()=>Promise<void>,
  ): Promise<void> {
    const key = await this.projectKey(identityId, projectId);
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(aad(identityId, projectId, aadKind));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const sealed = {
        schema: SEALED_SCHEMA,
        alg: "aes-256-gcm",
        kdf: "hkdf-sha256",
        identityId,
        projectId,
        revision: revision ?? 0,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      };
      await writeJsonAtomic(path, sealed, { maximum, beforeCommit });
    } finally {
      key.fill(0);
      nonce.fill(0);
    }
  }

  private async readSealed(path: string, identityId: string, projectId: string, aadKind: string, maximum: number): Promise<Uint8Array> {
    const sealed = assertSealedEnvelope(await readJson(path, null, maximum));
    if (sealed.identityId !== identityId || sealed.projectId !== projectId) throw new Error("workspace_artifact_not_found");
    return this.openSealed(sealed, identityId, projectId, aadKind);
  }

  private async openSealed(
    sealed: ReturnType<typeof assertSealedEnvelope>,
    identityId: string,
    projectId: string,
    aadKind: string,
  ): Promise<Uint8Array> {
    const key = await this.projectKey(identityId, projectId);
    try {
      const nonce = Buffer.from(sealed.nonce, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(aad(identityId, projectId, aadKind));
      decipher.setAuthTag(Buffer.from(sealed.tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(sealed.ciphertext, "base64url")), decipher.final()]);
    } finally { key.fill(0); }
  }

  private async projectKey(identityId: string, projectId: string): Promise<Buffer> {
    const master = await this.ensureKey();
    return Buffer.from(hkdfSync("sha256", master, identityId, `uptokey-workspace-project-v1|${projectId}`, 32));
  }

  private async ensureKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey;
    let encoded: string | undefined;
    try { encoded = await this.secrets.get(KEY_ACCOUNT); }
    catch (error) {
      if (error instanceof Error && error.message === "secret_store_read_unavailable") throw error;
      throw new Error("workspace_key_unavailable");
    }
    if (!encoded) {
      encoded = randomBytes(32).toString("base64url");
      try { await this.secrets.set(KEY_ACCOUNT, encoded); }
      catch { throw new Error("workspace_key_unavailable"); }
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("workspace_key_invalid");
    this.masterKey = key;
    return key;
  }

  private serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next;
  }

  private isoNow(): string {
    const value = this.now().toISOString();
    assertIsoTime(value, "workspace_clock");
    return value;
  }

  private identityDir(identityId: string): string { return join(this.root, identityId); }
  private projectDir(identityId: string, projectId: string): string { return join(this.identityDir(identityId), projectId); }
  private artifactsDir(identityId: string, projectId: string): string { return join(this.projectDir(identityId, projectId), "artifacts"); }
  private snapshotPath(identityId: string, projectId: string): string { return join(this.projectDir(identityId, projectId), "snapshot.json"); }
  private artifactPath(identityId: string, projectId: string, artifactId: string): string {
    return join(this.artifactsDir(identityId, projectId), `${artifactId}.json`);
  }
}

function projectKey(identityId: string, projectId: string): string { return `${identityId}:${projectId}`; }

function aad(identityId: string, projectId: string, kind: string): Buffer {
  return Buffer.from(`1|${identityId}|${projectId}|${kind}`);
}

function asContract<T>(run: () => T, code: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowContractError) throw new Error(code);
    throw error;
  }
}

function assertStoredProject(value: unknown): ProjectContext {
  return asContract(() => parseProjectContext(value), "workspace_project_invalid");
}

function cloneRecord(record: JournalRunRecord): JournalRunRecord {
  return { revision: record.revision, run: structuredClone(record.run), receipts: structuredClone(record.receipts) };
}

function assertStoredRun(value: unknown, project: ProjectContext): Run {
  const run = asContract(() => parseRun(value), "workspace_run_invalid");
  if (run.projectId !== project.id) throw new Error("workspace_run_project_mismatch");
  if (!RUN_STATUSES.includes(run.status)) throw new Error("workspace_run_status_invalid");
  return run;
}

function assertApprovalOccupancy(value: unknown): ApprovalOccupancy {
  return asContract(() => parsePlanApproval(value), "workspace_approval_invalid");
}

function assertStoredProjectRoot(value: unknown): StoredProjectRoot {
  const item = record(value);
  if (!item || typeof item.localPath !== "string") throw new Error("workspace_snapshot_corrupt");
  const binding = asContract(() => parseProjectRootBinding(item.binding), "workspace_snapshot_corrupt");
  return { binding, localPath: item.localPath };
}

function parseWriteRecoveryInput(value: unknown): Omit<ResolveInterruptedWriteInput, 'revalidate'> {
  const item = record(value);
  const allowed = ['operationId', 'expectedRunRevision', 'action', 'reviewDigest', 'reason', 'replacement', 'revalidate'];
  if (!item || Object.keys(item).some(key => !allowed.includes(key)) ||
      typeof item.operationId !== 'string' || !/^op-[a-f0-9]{64}$/.test(item.operationId) ||
      !Number.isSafeInteger(item.expectedRunRevision) || (item.expectedRunRevision as number) < 1 ||
      (item.action !== 'keep_stopped' && item.action !== 'retry') ||
      typeof item.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.reviewDigest) ||
      (item.reason !== undefined && (typeof item.reason !== 'string' || item.reason.length > 512)) ||
      (item.revalidate !== undefined && typeof item.revalidate !== 'function') ||
      (item.action === 'keep_stopped' && item.replacement !== undefined)) throw new Error('workspace_write_recovery_invalid');
  let replacement: ResolveInterruptedWriteInput['replacement'];
  if (item.replacement !== undefined) {
    const pair = record(item.replacement);
    if (!pair || Object.keys(pair).sort().join(',') !== 'plan,snapshot') throw new Error('workspace_write_recovery_invalid');
    try { replacement = { plan: parseExecutionPlan(pair.plan), snapshot: parseContextSnapshot(pair.snapshot) }; }
    catch { throw new Error('workspace_write_recovery_invalid'); }
  }
  return { operationId: item.operationId, expectedRunRevision: item.expectedRunRevision as number, action: item.action,
    reviewDigest: item.reviewDigest, ...(item.reason === undefined ? {} : { reason: item.reason as string }),
    ...(replacement ? { replacement } : {}) };
}

function writeStepBinding(step: ExecutionPlan['steps'][number]): { rootBindingId: string; changeSet: ProjectChangeSet } {
  const args = step.arguments;
  const root = args.root_binding_id ?? args.rootBindingId;
  const change = args.change_set ?? args.changeSet;
  if (step.capabilityId !== PROJECT_WRITE_CAPABILITY.id || step.capabilityVersion !== PROJECT_WRITE_CAPABILITY.version ||
      (args.root_binding_id && args.rootBindingId) || (args.change_set && args.changeSet) ||
      root?.kind !== 'literal' || typeof root.value !== 'string' || change?.kind !== 'literal') {
    throw new Error('workspace_write_recovery_invalid');
  }
  try { return { rootBindingId: root.value, changeSet: parseProjectChangeSet(change.value) }; }
  catch { throw new Error('workspace_write_recovery_invalid'); }
}

function bindInterruptedWrite(bundle: Pick<WorkspaceBundle, 'project' | 'runs' | 'plans'>, intent: StoredWriteIntent): {
  record: JournalRunRecord; plan: ExecutionPlan;
} {
  for (const slot of bundle.runs) {
    if (slot.run.principalId !== bundle.project.ownerPrincipalId || slot.run.projectId !== bundle.project.id) continue;
    const plan = bundle.plans.find(plan => plan.id === slot.run.planId && plan.digest === slot.run.planDigest);
    if (!plan) continue;
    for (const step of plan.steps) {
      const operationId = `op-${createHash('sha256').update(JSON.stringify([slot.run.principalId, bundle.project.id, slot.run.id, step.id])).digest('hex')}`;
      if (operationId !== intent.operationId) continue;
      const binding = writeStepBinding(step);
      const state = slot.run.stepStates.find(state => state.stepId === step.id);
      if (binding.rootBindingId !== intent.rootBindingId || canonicalJson(binding.changeSet) !== canonicalJson(intent.changeSet) ||
          !state || !slot.receipts.some(receipt => receipt.stepId === step.id &&
            receipt.capabilityId === step.capabilityId && receipt.capabilityVersion === step.capabilityVersion &&
            state.receiptIds.includes(receipt.id) && state.attemptIds.includes(receipt.attemptId))) {
        throw new Error('workspace_write_recovery_invalid');
      }
      return { record: slot, plan };
    }
  }
  throw new Error('workspace_write_recovery_invalid');
}

function assertWriteReplacement(intent: StoredWriteIntent, original: ExecutionPlan, plan: ExecutionPlan, snapshot: ContextSnapshot): void {
  if (plan.id === original.id || snapshot.id === original.contextSnapshotId || plan.steps.length !== 1) {
    throw new Error('workspace_write_recovery_invalid');
  }
  try { validatePlanBindings(plan, snapshot, [PROJECT_WRITE_CAPABILITY]); }
  catch { throw new Error('workspace_write_recovery_invalid'); }
  const replacement = writeStepBinding(plan.steps[0]!);
  if (replacement.rootBindingId !== intent.rootBindingId || replacement.changeSet.id === intent.changeSet.id) {
    throw new Error('workspace_write_recovery_invalid');
  }
  // An ordered subsequence preserves each complete operation, including its
  // content, old/new hashes and move source. Paths alone are not a safe match.
  let cursor = 0;
  const originalOps = intent.changeSet.operations.map(op => canonicalJson(op));
  const seen = new Set<string>();
  for (const operation of replacement.changeSet.operations) {
    const encoded = canonicalJson(operation);
    const index = originalOps.indexOf(encoded, cursor);
    if (index < 0 || seen.has(encoded)) throw new Error('workspace_write_recovery_invalid');
    seen.add(encoded);
    cursor = index + 1;
  }
}

function savedWriteReplacement(bundle: Pick<WorkspaceBundle, 'plans' | 'snapshots'>, recovery: StoredWriteRecovery): ResolveInterruptedWriteResult['replacement'] {
  if (recovery.replacementPlanId === undefined) return undefined;
  const plan = bundle.plans.find(plan => plan.id === recovery.replacementPlanId);
  const snapshot = bundle.snapshots.find(snapshot => snapshot.id === plan?.contextSnapshotId);
  if (!plan || !snapshot) throw new Error('workspace_snapshot_corrupt');
  return { plan, snapshot };
}

function assertStoredWriteRecovery(value: unknown, intent: StoredWriteIntent): StoredWriteRecovery {
  const item = record(value);
  const allowed = ['runId', 'action', 'reviewDigest', 'resolvedAt', 'replacementPlanId', 'reason'];
  if (!item || Object.keys(item).some(key => !allowed.includes(key)) ||
      (intent.status !== 'failed' && !(intent.status === 'completed' && intent.receipt && item.action === 'keep_stopped')) ||
      (item.action !== 'keep_stopped' && item.action !== 'retry') ||
      typeof item.reviewDigest !== 'string' || !/^[a-f0-9]{64}$/.test(item.reviewDigest) ||
      (Object.hasOwn(item, 'reason') && (typeof item.reason !== 'string' || item.reason.length > 512)) ||
      (item.action === 'keep_stopped' && Object.hasOwn(item, 'replacementPlanId'))) throw new Error('workspace_snapshot_corrupt');
  try {
    assertWorkflowId(item.runId, 'workspace_run_id');
    if (Object.hasOwn(item, 'replacementPlanId')) assertWorkflowId(item.replacementPlanId, 'workspace_plan_id');
    assertIsoTime(item.resolvedAt, 'workspace_recovery_time');
    assertIsoTime(intent.createdAt, 'workspace_intent_time');
  } catch { throw new Error('workspace_snapshot_corrupt'); }
  if (Date.parse(item.resolvedAt) < Date.parse(intent.createdAt)) throw new Error('workspace_snapshot_corrupt');
  return { runId: item.runId, action: item.action, reviewDigest: item.reviewDigest, resolvedAt: item.resolvedAt,
    ...(item.replacementPlanId === undefined ? {} : { replacementPlanId: item.replacementPlanId as string }),
    ...(item.reason === undefined ? {} : { reason: item.reason as string }) };
}

function assertStoredWriteIntent(value: unknown): StoredWriteIntent {
  const item = record(value);
  if (!item || typeof item.operationId !== "string" || typeof item.rootBindingId !== "string" ||
      typeof item.status !== "string" || typeof item.preimagesDir !== "string" || typeof item.createdAt !== "string" ||
      !Array.isArray(item.confirmedPaths)) {
    throw new Error("workspace_snapshot_corrupt");
  }
  const changeSet = asContract(() => parseProjectChangeSet(item.changeSet), "workspace_snapshot_corrupt");
  const validStatus = ["pending", "in_progress", "completed", "failed", "needs_attention"].includes(item.status);
  if (!validStatus) throw new Error("workspace_snapshot_corrupt");
  const intent: StoredWriteIntent = {
    operationId: item.operationId,
    rootBindingId: item.rootBindingId,
    changeSet,
    status: item.status as StoredWriteIntent["status"],
    preimagesDir: item.preimagesDir,
    createdAt: item.createdAt,
    confirmedPaths: item.confirmedPaths.map(p => { if (typeof p !== "string") throw new Error("workspace_snapshot_corrupt"); return p; })
  };
  // Absence remains compatible with historical intents. A present invalid
  // receipt is corruption, never a reason to silently erase completion proof.
  const withReceipt = Object.hasOwn(item, 'receipt') ? { ...intent, receipt: assertStoredProjectWriteReceipt(item.receipt, intent) } : intent;
  return Object.hasOwn(item, 'recovery') ? { ...withReceipt, recovery: assertStoredWriteRecovery(item.recovery, withReceipt) } : withReceipt;
}

function assertStoredProjectWriteReceipt(value: unknown, intent: StoredWriteIntent): StoredProjectWriteReceipt {
  const receipt = record(value);
  if (!receipt || Object.keys(receipt).sort().join(",") !== "appliedAt,baseManifestDigest,changeSetId,confirmedPaths,observedHashes,operationId,preimagesRef" ||
      intent.status !== "completed" || receipt.operationId !== intent.operationId ||
      receipt.changeSetId !== intent.changeSet.id || receipt.baseManifestDigest !== intent.changeSet.baseManifestDigest ||
      receipt.preimagesRef !== intent.preimagesDir) {
    throw new Error("workspace_snapshot_corrupt");
  }
  try {
    assertIsoTime(receipt.appliedAt, "workspace_receipt_time");
    assertIsoTime(intent.createdAt, "workspace_intent_time");
  } catch { throw new Error("workspace_snapshot_corrupt"); }
  if (Date.parse(receipt.appliedAt) < Date.parse(intent.createdAt)) throw new Error("workspace_snapshot_corrupt");

  const confirmedPaths = projectStringArray(receipt.confirmedPaths, 1000);
  const intentPaths = projectStringArray(intent.confirmedPaths, 1000);
  const operations = intent.changeSet.operations;
  if (!confirmedPaths || !intentPaths || confirmedPaths.length !== operations.length || intentPaths.length !== operations.length ||
      operations.some((op, index) => confirmedPaths[index] !== op.path || intentPaths[index] !== op.path)) {
    throw new Error("workspace_snapshot_corrupt");
  }

  const hashes = record(receipt.observedHashes);
  const fileOperations = operations.filter(op => op.type !== "mkdir");
  const filePaths = new Set(fileOperations.map(op => op.path));
  if (!hashes || Object.keys(hashes).length !== filePaths.size ||
      Object.entries(hashes).some(([path, hash]) => !filePaths.has(path) || typeof hash !== "string" || !/^[a-f0-9]{64}$/.test(hash)) ||
      fileOperations.some(op => !Object.hasOwn(hashes, op.path) || op.newSha256 !== undefined && hashes[op.path] !== op.newSha256)) {
    throw new Error("workspace_snapshot_corrupt");
  }
  return {
    operationId: intent.operationId,
    changeSetId: intent.changeSet.id,
    baseManifestDigest: intent.changeSet.baseManifestDigest,
    appliedAt: receipt.appliedAt,
    confirmedPaths,
    observedHashes: Object.fromEntries(Object.entries(hashes)) as Record<string, string>,
    preimagesRef: intent.preimagesDir,
  };
}

function assertStoredRunRecord(value: unknown, project: ProjectContext): JournalRunRecord {
  const item = record(value);
  if (!item || Object.keys(item).sort().join(",") !== STORED_RUN_KEYS.join(",")) throw new Error("workspace_snapshot_corrupt");
  if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 1) throw new Error("workspace_snapshot_corrupt");
  const run = assertStoredRun(item.run, project);
  if (!Array.isArray(item.receipts)) throw new Error("workspace_snapshot_corrupt");
  const receipts = item.receipts.map((receipt) => asContract(() => parseExecutionReceipt(receipt), "workspace_snapshot_corrupt"));
  if (receipts.some((receipt) => receipt.projectId !== project.id || receipt.runId !== run.id)) throw new Error("workspace_snapshot_corrupt");
  return { revision: item.revision, run, receipts };
}

function assertStoredBundle(value: unknown): WorkspaceBundle {
  const item = record(value);
  const keys = item && Object.keys(item).filter(key => !OPTIONAL_BUNDLE_KEYS.includes(key)).sort().join(",");
  const legacy = keys === LEGACY_BUNDLE_KEYS.join(",");
  if (!item || (!legacy && keys !== BUNDLE_KEYS.join(",")) || item.persistSchema !== BUNDLE_SCHEMA) {
    throw new Error("workspace_snapshot_corrupt");
  }
  if (typeof item.journalRevision !== "number" || !Number.isSafeInteger(item.journalRevision) || item.journalRevision < 0) {
    throw new Error("workspace_snapshot_corrupt");
  }
  const project = assertStoredProject(item.project);
  if (!Array.isArray(item.runs) || item.runs.length > MAX_JOURNAL_RUNS || !Array.isArray(item.approvals) || !Array.isArray(item.artifacts)) {
    throw new Error("workspace_snapshot_corrupt");
  }
  const runs = item.runs.map((entry) => assertStoredRunRecord(entry, project));
  const runIds = new Set(runs.map((entry) => entry.run.id));
  if (runIds.size !== runs.length) throw new Error("workspace_snapshot_corrupt");
  const requestKeys = new Set(runs.map((entry) => `${entry.run.principalId}:${entry.run.requestId}`));
  if (requestKeys.size !== runs.length) throw new Error("workspace_snapshot_corrupt");
  const approvals = item.approvals.map(assertApprovalOccupancy);
  if (approvals.some(item => item.projectId !== project.id || item.principalId !== project.ownerPrincipalId)) throw new Error("workspace_snapshot_corrupt");
  const approvalIds = new Set(approvals.map((entry) => entry.id));
  const approvalPlans = new Set(approvals.map((entry) => entry.planId));
  if (approvalIds.size !== approvals.length || approvalPlans.size !== approvals.length) throw new Error("workspace_snapshot_corrupt");
  const artifacts = item.artifacts.map((artifact) => asContract(() => parseArtifact(artifact), "workspace_snapshot_corrupt"));
  if (artifacts.some((artifact) => artifact.projectId !== project.id)) throw new Error("workspace_snapshot_corrupt");
  const artifactIds = new Set(artifacts.map((artifact) => artifact.id));
  if (project.artifactRefs.some((id) => !artifactIds.has(id)) || artifactIds.size !== project.artifactRefs.length) {
    throw new Error("workspace_snapshot_corrupt");
  }
  const readItems = <T>(key: string, parser: (value: unknown) => T): T[] => {
    const values = legacy && !OPTIONAL_BUNDLE_KEYS.includes(key) ? [] : item[key];
    if (!Array.isArray(values)) throw new Error("workspace_snapshot_corrupt");
    return values.map(value => asContract(() => parser(value), "workspace_snapshot_corrupt"));
  };
  const plans = readItems("plans", parseExecutionPlan);
  const snapshots = readItems("snapshots", parseContextSnapshot);
  const grants = readItems("grants", parseProjectGrant);
  const recipes = readItems("recipes", parseRecipe);
  const usageValues = readItems("usageValues", parseUsageValueReceipt);
  const telemetryDeliveries = item.telemetryDeliveries === undefined ? [] : readItems("telemetryDeliveries", parseTelemetryDelivery);
  if (telemetryDeliveries.length > MAX_JOURNAL_RUNS * 4) throw new Error("workspace_snapshot_corrupt");
  assertUnique(telemetryDeliveries, item => `${item.destinationId}:${item.runId}`);
  for (const delivery of telemetryDeliveries) {
    const slot = runs.find(item => item.run.id === delivery.runId);
    if (!slot || delivery.runRevision > slot.revision || telemetryDeliveries.filter(item => item.runId === delivery.runId).length > 4) {
      throw new Error("workspace_snapshot_corrupt");
    }
  }
  if (item.compositions !== undefined && (!Array.isArray(item.compositions) || item.compositions.length > MAX_COMPOSITIONS)) throw new Error("workspace_snapshot_corrupt");
  let compositions: CompositionSpec[];
  try { compositions = item.compositions === undefined ? [] : readItems("compositions", parseCompositionSpec); }
  catch { throw new Error("workspace_snapshot_corrupt"); }
  assertUnique(compositions, item => item.id);
  assertUnique(compositions, item => item.requestId);
  if (compositions.some(spec => !compositionBound(spec, project, runs))) throw new Error("workspace_snapshot_corrupt");
  let learnedRecipes: LearnedApiRecipe[];
  try {
    learnedRecipes = item.learnedRecipes === undefined ? [] : readItems("learnedRecipes", parseLearnedApiRecipe);
  } catch { throw new Error("workspace_snapshot_corrupt"); }
  if (learnedRecipes.length > MAX_LEARNED_RECIPES) throw new Error("workspace_snapshot_corrupt");
  assertUnique(learnedRecipes, item => `${item.id}:${item.revision}`);
  if (learnedRecipes.some(item => item.projectId !== project.id || item.ownerPrincipalId !== project.ownerPrincipalId)) {
    throw new Error("workspace_snapshot_corrupt");
  }
  assertUnique(plans, item => item.id);
  assertUnique(snapshots, item => item.id);
  assertUnique(grants, item => item.id);
  assertUnique(grants, item => item.principalId);
  assertUnique(recipes, item => `${item.id}:${item.version}`);
  assertUnique(usageValues, item => item.id);
  assertUnique(usageValues, usageAttemptKey);
  if (snapshots.some(item => item.projectId !== project.id || item.projectRevision > project.revision) ||
      grants.some(item => item.projectId !== project.id || item.principalId !== project.ownerPrincipalId) ||
      usageValues.some(item => item.projectId !== project.id)) throw new Error("workspace_snapshot_corrupt");
  for (const plan of plans) {
    const snapshot = snapshots.find(item => item.id === plan.contextSnapshotId);
    if (!snapshot) throw new Error("workspace_snapshot_corrupt");
    assertPlanSnapshot(plan, snapshot, project);
  }
  const projectRoots = legacy || item.projectRoots === undefined ? [] : (item.projectRoots as unknown[]).map(assertStoredProjectRoot);
  if (projectRoots.length > MAX_PROJECT_ROOTS) throw new Error("workspace_snapshot_corrupt");
  assertUnique(projectRoots, r => r.binding.id);
  if (projectRoots.some(r => r.binding.projectId !== project.id || r.binding.principalId !== project.ownerPrincipalId)) {
    throw new Error("workspace_snapshot_corrupt");
  }

  const writeIntents = legacy || item.writeIntents === undefined ? [] : (item.writeIntents as unknown[]).map(assertStoredWriteIntent);
  if (writeIntents.length > MAX_WRITE_INTENTS) throw new Error("workspace_snapshot_corrupt");
  assertUnique(writeIntents, i => i.operationId);
  const recovered = writeIntents.filter(intent => intent.recovery);
  assertUnique(recovered.filter(intent => intent.recovery!.replacementPlanId !== undefined), intent => intent.recovery!.replacementPlanId!);
  for (const intent of recovered) {
    try {
      const recovery = intent.recovery!;
      const bound = bindInterruptedWrite({ project, runs, plans }, intent);
      if (bound.record.run.id !== recovery.runId || bound.record.run.status !== 'failed' || bound.record.revision < 2 ||
          bound.record.run.updatedAt !== recovery.resolvedAt || bound.record.run.finishedAt !== recovery.resolvedAt ||
          bound.record.receipts.some(receipt => ['prepared', 'dispatched'].includes(receipt.status)) ||
          bound.record.run.stepStates.some(state => ['prepared', 'dispatched'].includes(state.status))) throw new Error('invalid');
      const replacement = savedWriteReplacement({ plans, snapshots }, recovery);
      if (replacement) assertWriteReplacement(intent, bound.plan, replacement.plan, replacement.snapshot);
    } catch { throw new Error('workspace_snapshot_corrupt'); }
  }

  let multimodelPlans: MultiModelPlan[] = [];
  let multimodelRuns: MultimodelRun[] = [];
  try {
    multimodelPlans = item.multimodelPlans === undefined ? [] : readItems("multimodelPlans", parseMultiModelPlan as any);
    multimodelRuns = item.multimodelRuns === undefined ? [] : readItems("multimodelRuns", parseMultimodelRun as any);
  } catch { throw new Error("workspace_snapshot_corrupt"); }
  if(multimodelPlans.length>MAX_MULTIMODEL_PLANS||multimodelRuns.length>MAX_MULTIMODEL_RUNS) throw new Error("workspace_snapshot_corrupt");
  assertUnique(multimodelPlans, p=>p.id);
  assertUnique(multimodelRuns, r=>r.id);
  if(multimodelPlans.some(p=>p.projectId!==project.id||p.principalId!==project.ownerPrincipalId)) throw new Error("workspace_snapshot_corrupt");
  if(multimodelRuns.some(r=>r.projectId!==project.id||r.principalId!==project.ownerPrincipalId)) throw new Error("workspace_snapshot_corrupt");
  for(const p of multimodelPlans){
    const snap = snapshots.find(s=>s.id===p.contextSnapshotId);
    if(!snap) throw new Error("workspace_snapshot_corrupt");
    if(p.projectId!==snap.projectId||p.principalId!==project.ownerPrincipalId) throw new Error("workspace_snapshot_corrupt");
  }

  let usageClassifications: UsageClassificationRecord[];
  try {
    usageClassifications = item.usageClassifications === undefined ? [] : readItems("usageClassifications", parseUsageClassificationRecord);
  } catch { throw new Error("workspace_snapshot_corrupt"); }
  if (usageClassifications.length > MAX_USAGE_CLASSIFICATIONS) throw new Error("workspace_snapshot_corrupt");
  assertUnique(usageClassifications, entry => entry.runId);
  if (usageClassifications.some(entry => entry.projectId !== project.id || entry.principalId !== project.ownerPrincipalId)) {
    throw new Error("workspace_snapshot_corrupt");
  }

  const voiceSessions:VoiceSessionRecord[]=item.voiceSessions===undefined?[]:readItems('voiceSessions',parseVoiceSessionRecord);
  if(voiceSessions.length>128||voiceSessions.some(item=>item.principalId!==project.ownerPrincipalId||item.projectId!==project.id||!runs.some(slot=>slot.run.id===item.runId)))throw new Error('workspace_snapshot_corrupt');
  assertUnique(voiceSessions,item=>item.sessionId);
  const projectTasks=item.projectTasks===undefined?[]:readItems('projectTasks',parseProjectTaskRecord);
  if(projectTasks.length>128||projectTasks.some(t=>t.projectId!==project.id||t.principalId!==project.ownerPrincipalId||!runs.some(r=>r.run.id===t.rootRunId&&r.run.planId===t.rootPlanId)))throw Error('workspace_snapshot_corrupt');
  assertUnique(projectTasks,t=>t.id);
  for(const task of projectTasks){
    const binding=plans.find(p=>p.id===task.rootPlanId)?.steps[0]?.arguments.task;
    if(binding?.kind!=='literal'||!recordMatchesTaskBinding(task,binding.value))throw Error('workspace_snapshot_corrupt');
    for(const child of task.children)if(child.runId!==null&&!runs.some(r=>r.run.id===child.runId&&r.run.planId===child.planId&&r.run.planDigest===child.digest&&r.run.requestId===child.requestId))throw Error('workspace_snapshot_corrupt');
  }
  const privacyPurges:PrivacyPurge[]=item.privacyPurges===undefined?[]:item.privacyPurges as PrivacyPurge[];
  if(!Array.isArray(privacyPurges)||privacyPurges.length>4096)throw new Error('workspace_snapshot_corrupt');
  for(const purge of privacyPurges){
    if(!purge||Object.keys(purge).sort().join(',')!=='purgedAt,targetClass,targetId'||!['artifact','local_receipts'].includes(purge.targetClass))throw new Error('workspace_snapshot_corrupt');
    assertWorkflowId(purge.targetId,'workspace_snapshot_corrupt');assertIsoTime(purge.purgedAt,'workspace_snapshot_corrupt');
  }
  assertUnique(privacyPurges,p=>`${p.targetClass}:${p.targetId}`);
  return { persistSchema: BUNDLE_SCHEMA, project, journalRevision: item.journalRevision, runs, approvals, artifacts,
    ...(item.voiceSessions!==undefined?{voiceSessions}:{}),
    ...(item.projectTasks!==undefined?{projectTasks}:{}),
    ...(item.privacyPurges!==undefined?{privacyPurges}:{}),
    plans, snapshots, grants, recipes, usageValues,
    ...(item.telemetryDeliveries !== undefined ? { telemetryDeliveries } : {}),
    ...(item.compositions !== undefined ? { compositions } : {}),
    ...(item.learnedRecipes !== undefined ? { learnedRecipes } : {}),
    ...(item.projectRoots !== undefined ? { projectRoots } : {}),
    ...(item.writeIntents !== undefined ? { writeIntents } : {}),
    ...(item.multimodelPlans !== undefined ? { multimodelPlans } : {}),
    ...(item.multimodelRuns !== undefined ? { multimodelRuns } : {}),
    ...(item.usageClassifications !== undefined ? { usageClassifications } : {}) };
}

function recordMatchesTaskBinding(task:ProjectTaskRecord,binding:unknown):boolean {
  const {schemaVersion:_schema,rootRunId:_run,rootPlanId:_plan,stoppedAt:_stopped,blockedReason:_blocked,...spec}=task;
  return canonicalJson({...spec,children:spec.children.map(c=>({...c,runId:null}))})===canonicalJson(binding);
}
function compositionRequest(spec: CompositionSpec): string {
  const { schemaVersion, requestId, sourceRunId, containsText, next } = spec;
  return canonicalCompositionRequest({ schemaVersion, requestId, sourceRunId, containsText, next });
}

function compositionBound(spec: CompositionSpec, project: ProjectContext, runs: JournalRunRecord[]): boolean {
  return spec.projectId === project.id && spec.principalId === project.ownerPrincipalId &&
    runs.some(slot => slot.run.id === spec.sourceRunId && slot.run.projectId === project.id && slot.run.principalId === spec.principalId);
}

function parseTelemetryDelivery(value: unknown): TelemetryDelivery {
  const item = record(value);
  if (!item || Object.keys(item).sort().join(",") !== "destinationId,fingerprint,runId,runRevision" ||
      typeof item.destinationId !== "string" || !/^[a-f0-9]{64}$/.test(item.destinationId) ||
      typeof item.fingerprint !== "string" || !/^[a-f0-9]{64}$/.test(item.fingerprint) ||
      typeof item.runRevision !== "number" || !Number.isSafeInteger(item.runRevision) || item.runRevision < 1) {
    throw new Error("workspace_telemetry_delivery_invalid");
  }
  assertWorkflowId(item.runId, "workspace_run_id");
  return { destinationId: item.destinationId, fingerprint: item.fingerprint, runId: item.runId as string, runRevision: item.runRevision };
}

function assertPlanSnapshot(plan: ExecutionPlan, snapshot: ContextSnapshot, project: ProjectContext): void {
  const hash = (text: string) => sha256Hex(new TextEncoder().encode(text));
  if (plan.projectId !== project.id || snapshot.projectId !== project.id || plan.projectRevision > project.revision ||
      plan.projectRevision !== snapshot.projectRevision || plan.contextSnapshotId !== snapshot.id ||
      plan.contextSnapshotDigest !== hash(canonicalContextSnapshotPayload(snapshot)) || plan.digest !== hash(canonicalPlanPayload(plan))) {
    throw new Error("workspace_plan_binding_invalid");
  }
}

function usageAttemptKey(item: UsageValueReceipt): string { return `${item.runId}:${item.stepId}:${item.attemptId}`; }

function immutableInsert<T>(items: T[], value: T, key: (item: T) => string): T[] {
  const previous = items.find(item => key(item) === key(value));
  if (!previous) return [...items, value];
  if (canonicalJson(previous) !== canonicalJson(value)) throw new Error("workspace_metadata_conflict");
  return items;
}

function assertUnique<T>(items: T[], key: (item: T) => string): void {
  if (new Set(items.map(key)).size !== items.length) throw new Error("workspace_snapshot_corrupt");
}

function assertSealedEnvelope(value: unknown): {
  schema: typeof SEALED_SCHEMA;
  alg: string;
  kdf: string;
  identityId: string;
  projectId: string;
  revision: number;
  nonce: string;
  ciphertext: string;
  tag: string;
} {
  const item = record(value);
  if (!item || Object.keys(item).sort().join(",") !== SEALED_KEYS.join(",") || item.schema !== SEALED_SCHEMA || item.alg !== "aes-256-gcm" || item.kdf !== "hkdf-sha256") {
    throw new Error("workspace_snapshot_corrupt");
  }
  assertIdentityId(item.identityId);
  assertWorkflowId(item.projectId, "workspace_project_id");
  if (typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 0) throw new Error("workspace_snapshot_corrupt");
  if (!encoded(item.nonce, 12, 12) || !encoded(item.tag, 16, 16) || !encoded(item.ciphertext, 1, PROJECT_STORAGE_MAX_BYTES)) throw new Error("workspace_snapshot_corrupt");
  return item as ReturnType<typeof assertSealedEnvelope>;
}

function encoded(value: unknown, minimum: number, maximum: number): boolean {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) return false;
  try {
    const bytes = Buffer.from(value, "base64url");
    return bytes.byteLength >= minimum && bytes.byteLength <= maximum && bytes.toString("base64url") === value;
  } catch { return false; }
}

function claimProcessRoot(root: string, token: string): () => void {
  const current = PROCESS_ROOT_LOCKS.get(root);
  if (current && current !== token) throw new Error("workspace_writer_lock_held");
  PROCESS_ROOT_LOCKS.set(root, token);
  return () => { if (PROCESS_ROOT_LOCKS.get(root) === token) PROCESS_ROOT_LOCKS.delete(root); };
}

function claimWriterLock(path: string, token: string, pid = process.pid): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("workspace_lock_invalid");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      writeFileSync(path, `${pid}\n${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return () => { try { if (readLockState(path)?.token === token) unlinkSync(path); } catch { /* already released */ } };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readLockState(path);
      if (!previous) {
        try { unlinkSync(path); } catch { /* racing recover */ }
        continue;
      }
      if (previous.token === token) return () => { try { if (readLockState(path)?.token === token) unlinkSync(path); } catch { /* already released */ } };
      if (processAlive(previous.pid)) throw new Error("workspace_writer_lock_held");
      try { unlinkSync(path); } catch { /* racing recover */ }
    }
  }
  throw new Error("workspace_writer_lock_timeout");
}

function readLockState(path: string): { pid: number; token: string | undefined } | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("workspace_lock_path_invalid");
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (!/^[1-9]\d{0,9}$/.test(lines[0] ?? "")) return undefined;
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    const token = lines[1] && /^[A-Za-z0-9_-]{8,128}$/.test(lines[1]) ? lines[1] : undefined;
    return { pid, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "EPERM"; }
}

async function unlinkStaleTemps(root: string): Promise<void> {
  const stack = [root];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); }
    catch { continue; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { stack.push(path); continue; }
      if (entry.name.endsWith(".tmp") || /\.\d+\.[0-9a-f-]{36}\.tmp$/i.test(entry.name)) {
        await unlink(path).catch(() => undefined);
      }
    }
  }
}
