export const MULTIMODEL_CONTRACT_VERSION: 1;
export const MULTIMODEL_SCHEMA_VERSION: 1;

export type MultimodelMode = 'advisor'|'subagents'|'compare'|'fusion'|'architect_coder';
export type PanelRole = 'advisor'|'worker'|'critic'|'analyst'|'writer';
export type BranchStatus = 'pending'|'running'|'succeeded'|'failed'|'cancelled'|'unknown';
export type MultimodelRunStatus = 'draft'|'running'|'succeeded'|'failed'|'cancelled'|'needs_attention'|'partial';

export interface MultimodelLimits {
  readonly maxMembers: number;
  readonly maxConcurrency: number;
  readonly maxDepth: number;
  readonly maxCalls: number;
  readonly maxElapsedMs: number;
  readonly maxCostMicros: string;
  readonly maxTokens: number;
}
export interface Quorum {
  readonly minSuccess: number;
  readonly graceMs: number;
  readonly deadlineMs: number;
}
export interface PanelMember {
  readonly id: string;
  readonly role: PanelRole;
  readonly modelId: string;
  readonly connectionId: string;
  readonly task: string;
  readonly allowedCapabilityIds: readonly string[];
  readonly contextRefs: readonly string[];
  readonly outputSchemaRef: string|null;
}
export interface MultiModelPlan {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly createdAt: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly revision: number;
  readonly mode: MultimodelMode;
  readonly principalModel: string;
  readonly members: readonly PanelMember[];
  readonly analystModel: string|null;
  readonly finalModel: string|null;
  readonly limits: MultimodelLimits;
  readonly quorum: Quorum;
  readonly contextSnapshotId: string;
  readonly digest: string;
}
export interface PanelResult {
  readonly memberId: string;
  readonly runId: string;
  readonly attemptIds: readonly string[];
  readonly status: BranchStatus;
  readonly actualModel: string;
  readonly artifactRefs: readonly string[];
  /** null quando não medido: unknown nunca vira zero nem estimativa disfarçada. */
  readonly usage: { readonly basis:'provider_reported'|'estimated'|'unknown'; readonly inputTokens:number|null; readonly outputTokens:number|null } | null;
  /** null quando não apurado contra tarifa. */
  readonly cost: { readonly micros: string } | null;
  readonly startedAt: string|null;
  readonly completedAt: string|null;
  readonly errorCode: string|null;
  /** sha256 do texto normalizado da resposta; igual entre ramos => acordo exato. */
  readonly responseHash: string|null;
}
export interface SynthesisResult {
  readonly agreement: readonly string[];
  readonly contradictions: readonly string[];
  readonly coverageGaps: readonly string[];
  readonly uniqueInsights: readonly string[];
  readonly blindSpots: readonly string[];
  readonly sourceResultIds: readonly string[];
  readonly finalArtifactRef: string|null;
}
export interface MultimodelRun {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly projectId: string;
  readonly principalId: string;
  readonly planId: string;
  readonly planDigest: string;
  readonly status: MultimodelRunStatus;
  readonly branches: readonly PanelResult[];
  readonly synthesis: SynthesisResult|null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly finishedAt: string|null;
  readonly revision: number;
}

export function parseMultiModelPlan(input: unknown): MultiModelPlan;
export function canonicalMultiModelPlanPayload(value: unknown): string;
export function parsePanelResult(input: unknown): PanelResult;
export function parseSynthesisResult(input: unknown): SynthesisResult;
export function parseMultimodelRun(input: unknown): MultimodelRun;
export function parseCreateMultimodelPlanCommand(input: unknown): {
  readonly expectedRevision:number; readonly mode:MultimodelMode; readonly principalModel:string;
  readonly members: readonly any[]; readonly analystModel:string|null; readonly finalModel:string|null;
  readonly limits:MultimodelLimits; readonly quorum:Quorum; readonly contextSnapshotId:string; readonly objective:string|null;
};
export const MULTIMODEL_ERRORS: Record<string,string>;
