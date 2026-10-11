import type { BrowserReadRequest } from './browser.js';
import type { ExecutionPlan, RunStatus } from './workflow.js';
export const COMPOSITION_CONTRACT_VERSION: 1;
export interface CompositionRequest {
  readonly schemaVersion:1; readonly requestId:string; readonly sourceRunId:string;
  /** Literal, case-sensitive containment; evaluated locally on the selected artifact. */
  readonly containsText:string; readonly next:Readonly<BrowserReadRequest>;
}
export interface CompositionSpec extends CompositionRequest {
  readonly id:string; readonly createdAt:string; readonly projectId:string; readonly principalId:string;
}
export function parseCompositionRequest(input:unknown):Readonly<CompositionRequest>;
export function parseCompositionSpec(input:unknown):Readonly<CompositionSpec>;
export function canonicalCompositionRequest(input:unknown):string;
export type CompositionStatus = 'review_required'|'proposal_ready'|'complete'|'stopped';
export type CompositionDecision = 'recheck'|'stop';
export interface CompositionGraphSnapshot {
  readonly compositionId:string; readonly observedStatus:RunStatus|null;
  readonly status:CompositionStatus; readonly interrupted:boolean;
}
export interface CompositionResult {
  readonly spec:Readonly<CompositionSpec>;
  readonly state:Readonly<CompositionGraphSnapshot>|null;
  readonly plan:ExecutionPlan|null;
}
export function parseCompositionResult(input:unknown):Readonly<CompositionResult>;
export function parseCompositionGraphSnapshot(input:unknown):Readonly<CompositionGraphSnapshot>;
