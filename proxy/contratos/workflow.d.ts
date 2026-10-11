/** Wire contract only. Parsing is not authorization. See WORKFLOW.md. */
export const WORKFLOW_CONTRACT_VERSION: 1;
export const WORKFLOW_CONTRACT_REVISION: '1.6.0';
export const WORKFLOW_LIMITS: Readonly<{commandBytes:262144; steps:12; entries:256; sources:256; artifactBytes:5242880; videoArtifactBytes:67108864; projectBytes:104857600; activeRunsPerProject:1; activeRunsPerProcess:2}>;
export type WorkflowScope = 'project:read'|'project:write'|'project:process:run'|'plan:create'|'run:execute'|'run:cancel'|'artifact:read'|'recipe:write';
export const WORKFLOW_SCOPES: readonly WorkflowScope[];
export type RunStatus = 'draft'|'awaiting_approval'|'ready'|'running'|'succeeded'|'failed'|'cancelled'|'needs_attention';
export const RUN_STATUSES: readonly RunStatus[];
export type AttemptStatus = 'prepared'|'dispatched'|'succeeded'|'failed'|'unknown';
export const ATTEMPT_STATUSES: readonly AttemptStatus[];
export class WorkflowContractError extends Error { readonly code:string; constructor(code?:string); }
export interface WorkflowRecord {schemaVersion:1; id:string; createdAt:string;}
export interface DataDestination {kind:'local'|'public_source'|'provider'; id:string;}
export interface ExecutionLimits {maxSteps:number; maxCalls:number; maxOutputTokens:number; timeoutMs:number; maxOutputBytes:number;}
export interface CapabilityDescriptor extends WorkflowRecord {
  version:number; titleKey:string; descriptionKey:string; tags:string[]; inputSchemaId:string; outputSchemaId:string;
  effect:'read_external'|'write_external'|'inference'|'produce_artifact'|'execute_local'; dataDestination:DataDestination;
  availability:'executable'|'unavailable'|'catalogued'; supportLevel:'catalogued'|'experimental'|'integrated';
  requiredScopes:WorkflowScope[]; retryClass:'read_only'|'idempotent_local'|'never_automatic'; limits:ExecutionLimits;
}
export interface SourceReference {id:string; sourceId:string; externalId:string; title:string; url:string; retrievedAt:string; receiptId:string;}
export interface ContextEntry {id:string; kind:'fact'|'decision'|'hypothesis'|'task'; origin:'user'|'source'|'model'; content:string; sourceRefs:string[]; status:'proposed'|'confirmed'|'superseded'|'done'; createdAt:string; supersedes:string|null;}
export interface ProjectContext extends WorkflowRecord {ownerPrincipalId:string; revision:number; name:string; goal:string; constraints:string[]; entries:ContextEntry[]; sources:SourceReference[]; artifactRefs:string[]; updatedAt:string;}
export interface ContextSelection {id:string; sha256:string;}
export interface ContextSnapshot extends WorkflowRecord {projectId:string; projectRevision:number; entries:ContextSelection[]; artifacts:ContextSelection[]; sourceRefs:string[]; allowedDestinations:DataDestination[]; maxContextBytes:number; excludedEntryIds:string[];}
export type JsonData = null|boolean|number|string|JsonData[]|{[key:string]:JsonData};
export type InputBinding = {kind:'literal'; value:JsonData}|{kind:'step_output'; stepId:string; output:string};
export type RecipeBinding = InputBinding|{kind:'parameter'; parameter:string};
export interface PlanStep {id:string; capabilityId:string; capabilityVersion:number; arguments:Record<string,InputBinding>;}
export interface RecipeStep {id:string; capabilityId:string; capabilityVersion:number; arguments:Record<string,RecipeBinding>;}
export interface ExecutionPlan extends WorkflowRecord {projectId:string; projectRevision:number; contextSnapshotId:string; contextSnapshotDigest:string; steps:PlanStep[]; limits:ExecutionLimits; digest:string;}
export interface ProjectGrant extends WorkflowRecord {principalId:string; projectId:string; revision:number; scopes:WorkflowScope[]; capabilityIds:string[]; destinations:DataDestination[]; limits:ExecutionLimits; expiresAt:string; revokedAt:string|null;}
export interface StepState {stepId:string; status:'pending'|AttemptStatus; attemptIds:string[]; receiptIds:string[];}
export interface PlanApproval {id:string; projectId:string; planId:string; planDigest:string; principalId:string; destinations:DataDestination[]; expiresAt:string; consumedByRunId:string|null;}
export function parsePlanApproval(value:unknown):PlanApproval;
export interface Run extends WorkflowRecord {projectId:string; principalId:string; planId:string; planDigest:string; policyRevision:number; requestId:string; status:RunStatus; stepStates:StepState[]; updatedAt:string; finishedAt:string|null;}
export type TokenUsageBasis = 'provider_reported'|'estimated'|'unknown'|'model_tokenizer'|'heuristic'|'reserved_limit';
export interface TokenUsage {basis:TokenUsageBasis; inputTokens:number|null; outputTokens:number|null; cachedInputTokens:number|null; reasoningTokens?:number|null; totalTokens?:number|null; source?:string|null; version?:string|null; measuredAt?:string|null; reason?:string|null;}
export interface ExecutionReceipt extends WorkflowRecord {projectId:string; runId:string; stepId:string; attemptId:string; capabilityId:string; capabilityVersion:number; status:AttemptStatus; startedAt:string; finishedAt:string|null; inputArtifactRefs:string[]; outputArtifactRefs:string[]; sources:SourceReference[]; errorCode:string|null; usage:TokenUsage;}
export interface Artifact extends WorkflowRecord {projectId:string; runId:string; version:number; mediaType:'text/markdown'|'text/plain'|'application/json'|'text/csv'|'audio/mpeg'|'audio/wav'|'audio/ogg'|'audio/webm'|'audio/mp4'|'image/png'|'image/jpeg'|'image/webp'|'video/mp4'; filename:string; byteLength:number; sha256:string; receiptRefs:string[]; sourceRefs:string[];}
/** Structured input shape: field names and types only, never the author's values. */
export type RecipeInputShape =
  | {type:'object'; properties:Record<string,RecipeInputShape>; required?:string[]}
  | {type:'array'; items:RecipeInputShape; maxItems?:number}
  | {type:'string'|'integer'|'number'|'boolean'};
/** `defaults`: fixed fields merged under a structured object input (reviewed, never author-identifying). */
export interface RecipeParameter {name:string; type:'string'|'integer'|'boolean'|'json'; required:boolean; label?:string; schema?:RecipeInputShape; defaults?:Record<string,JsonData>;}
/** Additive provenance: derived from a run whose every step succeeded with receipts. Identifies, never authorizes. */
export interface RecipeOrigin {kind:'confirmed_run'; runId:string; planId:string; planDigest:string; receiptsDigest:string; sealedAt:string;}
export interface Recipe extends WorkflowRecord {version:number; title:string; description:string; parameters:RecipeParameter[]; steps:RecipeStep[]; limits:ExecutionLimits; expectedOutputs:string[]; origin?:RecipeOrigin;}
export type AccessMode = 'public'|'byok'|'local'|'hosted';
export interface ReferenceTariff extends WorkflowRecord {version:number; provider:string; model:string; accessMode:AccessMode; currency:'USD'; unit:'million_tokens'|'per_image'|'per_second'|'per_character'|'per_megapixel'; inputMicrosPerMillion:string; outputMicrosPerMillion:string; cachedInputMicrosPerMillion:string|null; priceMicrosPerUnit?:string|null; sourceUrl:string; checkedAt:string; validFrom:string; validUntil:string|null; comparisonBasis:'same_service'|'explicit_alternative';}
export interface RationalMicros {numeratorMicros:string; denominator:string;}
export interface UsageValueReceipt extends WorkflowRecord {projectId:string; runId:string; stepId:string; attemptId:string; provider:string; model:string; accessMode:AccessMode; cache:'none'|'provider'|'local'; usage:TokenUsage; tariffId:string|null; tariffVersion:number|null; referenceValue:RationalMicros|null; estimatedProviderCharge:RationalMicros|null; confirmedUptokeyCharge:RationalMicros|null; coverage:'included'|'missing_usage'|'missing_tariff'|'not_comparable'|'local_cache'|'estimated_usage';}
export function parseCapabilityDescriptor(value:unknown):CapabilityDescriptor;
export function parseProjectContext(value:unknown):ProjectContext;
export function parseContextSnapshot(value:unknown):ContextSnapshot;
export function parseExecutionPlan(value:unknown):ExecutionPlan;
export function parseProjectGrant(value:unknown):ProjectGrant;
export function parseRun(value:unknown):Run;
export function parseExecutionReceipt(value:unknown):ExecutionReceipt;
export function parseArtifact(value:unknown):Artifact;
export function parseRecipe(value:unknown):Recipe;
export function parseReferenceTariff(value:unknown):ReferenceTariff;
export function parseUsageValueReceipt(value:unknown):UsageValueReceipt;
export function canonicalPlanPayload(value:unknown):string;
export function canonicalContextSnapshotPayload(value:unknown):string;
/** Structural cross-references only; the caller must still authorize and verify digests. */
export function validatePlanBindings(plan:unknown,snapshot:unknown,capabilities:unknown):true;
export interface WorkflowCommands {
  importProject:{legacyId:string;name:string;goal:string;entries:Array<{id:string;content:string;origin:'user'|'model'}>};
  createProject:{name:string;goal:string};
  patchProject:{expectedRevision:number;name?:string;goal?:string;constraints?:string[]};
  createPlan:{expectedRevision:number;objective:string;selectedEntryIds:string[];selectedArtifactIds:string[];sourceIds:string[];limits:ExecutionLimits};
  startRun:{planId:string;planDigest:string;requestId:string};
  cancelRun:Record<string,never>;
  createRecipe:{planId:string;title:string;runId?:string;description?:string;parameters?:Array<{name:string;stepId:string;argument:string;type:'string'|'integer'|'boolean'|'json';required:boolean;label?:string;fields?:string[]}>};
  recipePlan:{recipeVersion:number;expectedRevision:number;parameters:Record<string,string|number|boolean>};
}
export function parseWorkflowCommand<K extends keyof WorkflowCommands>(command:K,value:unknown):WorkflowCommands[K];
