/**
 * W3 — política de execução. Decisões puras sobre objetos já validados pelo contrato W0.
 * O chamador fornece estado corrente (sem cache) do principal, gate de acesso, grant, plano,
 * aprovação e capacidades. Token válido de `/v1/*` não substitui grant do projeto.
 *
 * NÃO protege: operações fora do executor (ex.: `/v1/chat/completions` direto), processo ou
 * cofre comprometidos, nem desfaz efeito já recebido por terceiro.
 */
import { createHash } from "node:crypto";
import type {ProjectTaskAuthority} from './project-task-authority.ts';
import {
  canonicalPlanPayload,
  WORKFLOW_LIMITS,
  type CapabilityDescriptor,
  type DataDestination,
  type ExecutionLimits,
  type ExecutionPlan,
  type PlanApproval,
  type PlanStep,
  type ProjectGrant,
  type Run,
} from "@uptokey/sync-contract/workflow";

/** Aprovação canônica W0; a política não mantém um contrato paralelo. */
export type { PlanApproval } from "@uptokey/sync-contract/workflow";

export type AccessGateDecision = { allowed: true } | { allowed: false; code: string };
export type PolicyDecision = { allowed: true } | { allowed: false; code: PolicyDenialCode | string; status: 403 | 404 | 409 | 503 };

export type PolicyDenialCode =
  | "clock_invalid" | "principal_revoked" | "grant_missing" | "grant_project_mismatch" | "grant_invalid" | "grant_revoked" | "grant_expired"
  | "scope_missing" | "plan_missing" | "plan_project_mismatch" | "plan_digest_mismatch" | "plan_changed"
  | "approval_missing" | "approval_mismatch" | "approval_invalid" | "approval_expired" | "approval_consumed" | "run_invalid" | "run_timeout_exceeded"
  | "policy_revision_changed" | "capability_unavailable" | "capability_not_granted"
  | "destination_not_granted" | "destination_not_approved" | "limit_exceeds_grant" | "limit_steps_exceeded" | "limit_calls_exceeded";

export interface PolicySnapshot {
  now: Date;
  principalActive: boolean;
  accessGate: AccessGateDecision;
  grant: ProjectGrant | undefined;
  plan: ExecutionPlan | undefined;
  policyRevision: number;
  capabilities: ReadonlyMap<string, CapabilityDescriptor>;
}

export function computePlanDigest(plan: ExecutionPlan): string {
  return createHash("sha256").update(canonicalPlanPayload(plan), "utf8").digest("hex");
}

export function capabilityKey(id: string, version: number): string { return `${id}@${version}`; }

/** Limites efetivos: nunca acima do grant nem do plano. */
export function effectiveLimits(plan: ExecutionPlan, grant: ProjectGrant): ExecutionLimits {
  return {
    maxSteps: Math.min(plan.limits.maxSteps, grant.limits.maxSteps),
    maxCalls: Math.min(plan.limits.maxCalls, grant.limits.maxCalls),
    maxOutputTokens: Math.min(plan.limits.maxOutputTokens, grant.limits.maxOutputTokens),
    timeoutMs: Math.min(plan.limits.timeoutMs, grant.limits.timeoutMs),
    maxOutputBytes: Math.min(plan.limits.maxOutputBytes, grant.limits.maxOutputBytes),
  };
}

/** Início do run: ordem fixa de checagens; nenhuma inferida de campo enviado pelo cliente além de planId/digest. */
export function authorizeRunStart(input: PolicySnapshot & { principalId: string; projectId: string; planId: string; requestedDigest: string; approval: PlanApproval | undefined; runId?: string }): PolicyDecision {
  const base = checkIdentityAndGrant(input, input.principalId, input.projectId);
  if (!base.allowed) return base;
  const grant = input.grant!;
  const plan = input.plan;
  if (!plan || plan.id !== input.planId) return deny("plan_missing", 404);
  if (plan.projectId !== input.projectId) return deny("plan_project_mismatch", 404);
  const digest = computePlanDigest(plan);
  if (plan.digest !== digest || input.requestedDigest !== digest) return deny("plan_digest_mismatch", 409);
  const approval = input.approval;
  if (!approval) return deny("approval_missing", 403);
  if (approval.projectId !== input.projectId || approval.planId !== plan.id || approval.principalId !== input.principalId) return deny("approval_mismatch", 403);
  if (approval.planDigest !== digest) return deny("plan_changed", 409);
  const approvalExpiresAt = utcInstant(approval.expiresAt);
  if (approvalExpiresAt === undefined) return deny("approval_invalid", 403);
  if (approvalExpiresAt <= input.now.getTime()) return deny("approval_expired", 403);
  if (approval.consumedByRunId !== null && approval.consumedByRunId !== input.runId) return deny("approval_consumed", 409);
  if (plan.steps.length > WORKFLOW_LIMITS.steps || plan.steps.length > grant.limits.maxSteps) return deny("limit_steps_exceeded", 403);
  const limitKeys = ["maxSteps", "maxCalls", "maxOutputTokens", "timeoutMs", "maxOutputBytes"] as const;
  if (limitKeys.some((key) => plan.limits[key] > grant.limits[key])) return deny("limit_exceeds_grant", 403);
  for (const step of plan.steps) {
    const decision = checkStepCapability(input, grant, step, approval.destinations);
    if (!decision.allowed) return decision;
  }
  return { allowed: true };
}

/** Root W5 approval delegates an immutable, pre-reserved child; this is not a PlanApproval. */
export function authorizeTaskRunStart(input:PolicySnapshot & {principalId:string;projectId:string;planId:string;requestedDigest:string;requestId:string;delegation:ProjectTaskAuthority}):PolicyDecision {
 const base=checkIdentityAndGrant(input,input.principalId,input.projectId);if(!base.allowed)return base;
 const {plan,delegation,grant}=input;
 if(!plan||plan.id!==input.planId||plan.projectId!==input.projectId)return deny('plan_missing',404);
 if(delegation.planId!==plan.id||delegation.requestId!==input.requestId||delegation.authority.childPlanDigest!==plan.digest||computePlanDigest(plan)!==plan.digest||input.requestedDigest!==plan.digest)return deny('project_task_authority_mismatch',403);
 if((['maxSteps','maxCalls','maxOutputTokens','timeoutMs','maxOutputBytes'] as const).some(key=>plan.limits[key]>grant!.limits[key]))return deny('limit_exceeds_grant',403);
 for(const step of plan.steps){const decision=checkStepCapability(input,grant!,step,grant!.destinations);if(!decision.allowed)return decision;}
 return {allowed:true};
}

/** Antes de cada etapa: estado corrente, não o observado no início do run. */
export function authorizeStep(input: PolicySnapshot & { run: Run; step: PlanStep; approvalDestinations: DataDestination[]; dispatchedCalls: number }): PolicyDecision {
  const { run } = input;
  const base = checkIdentityAndGrant(input, run.principalId, run.projectId);
  if (!base.allowed) return base;
  const grant = input.grant!;
  const plan = input.plan;
  if (!plan || plan.id !== run.planId) return deny("plan_missing", 404);
  if (plan.projectId !== run.projectId) return deny("plan_project_mismatch", 404);
  const digest = computePlanDigest(plan);
  if (plan.digest !== digest) return deny("plan_digest_mismatch", 409);
  if (digest !== run.planDigest) return deny("plan_changed", 409);
  if (input.policyRevision !== run.policyRevision) return deny("policy_revision_changed", 409);
  const planned = plan.steps.find((step) => step.id === input.step.id);
  if (!planned || JSON.stringify(planned) !== JSON.stringify(input.step)) return deny("plan_changed", 409);
  const limits = effectiveLimits(plan, grant);
  const deadline = runDeadlineAt(run, limits);
  if (deadline === undefined) return deny("run_invalid", 409);
  if (input.now.getTime() >= deadline) return deny("run_timeout_exceeded", 409);
  if (plan.steps.length > limits.maxSteps) return deny("limit_steps_exceeded", 403);
  if (input.dispatchedCalls >= limits.maxCalls) return deny("limit_calls_exceeded", 403);
  return checkStepCapability(input, grant, input.step, input.approvalDestinations);
}

/**
 * Prazo do run inteiro (etapas, esperas entre tentativas e recuperação), ancorado no
 * `createdAt` persistido: reiniciar o processo não renova o orçamento. Limites só encolhem
 * o prazo se o grant for reduzido durante o run.
 */
export function runDeadlineAt(run: Pick<Run, "createdAt">, limits: Pick<ExecutionLimits, "timeoutMs">): number | undefined {
  const createdAt = utcInstant(run.createdAt);
  if (createdAt === undefined || !Number.isSafeInteger(limits.timeoutMs) || limits.timeoutMs < 1) return undefined;
  return createdAt + limits.timeoutMs;
}

/** Instante UTC no formato do contrato W0 (`YYYY-MM-DDTHH:mm:ss.sssZ`), com ida e volta exata. */
export function utcInstant(value: unknown): number | undefined {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) return undefined;
  const time = Date.parse(value);
  return Number.isFinite(time) && new Date(time).toISOString() === value ? time : undefined;
}

function checkIdentityAndGrant(input: PolicySnapshot, principalId: string, projectId: string): PolicyDecision {
  const now = input.now instanceof Date ? input.now.getTime() : Number.NaN;
  if (!Number.isFinite(now)) return deny("clock_invalid", 503);
  if (!input.principalActive) return deny("principal_revoked", 403);
  if (!input.accessGate.allowed) return deny((input.accessGate as any).code, 503);
  const grant = input.grant;
  if (!grant || grant.principalId !== principalId) return deny("grant_missing", 403);
  if (grant.projectId !== projectId) return deny("grant_project_mismatch", 403);
  const grantExpiresAt = utcInstant(grant.expiresAt);
  const grantRevokedAt = grant.revokedAt === null ? null : utcInstant(grant.revokedAt);
  if (grantExpiresAt === undefined || grantRevokedAt === undefined) return deny("grant_invalid", 403);
  if (grantRevokedAt !== null && grantRevokedAt <= now) return deny("grant_revoked", 403);
  if (grantExpiresAt <= now) return deny("grant_expired", 403);
  if (!grant.scopes.includes("run:execute")) return deny("scope_missing", 403);
  return { allowed: true };
}

function checkStepCapability(input: PolicySnapshot, grant: ProjectGrant, step: PlanStep, approved: DataDestination[]): PolicyDecision {
  const capability = input.capabilities.get(capabilityKey(step.capabilityId, step.capabilityVersion));
  if (!capability || capability.id !== step.capabilityId || capability.version !== step.capabilityVersion || capability.availability !== "executable") return deny("capability_unavailable", 503);
  if (!grant.capabilityIds.includes(capability.id)) return deny("capability_not_granted", 403);
  if (!capability.requiredScopes.every((scope) => grant.scopes.includes(scope))) return deny("scope_missing", 403);
  if (!hasDestination(grant.destinations, capability.dataDestination)) return deny("destination_not_granted", 403);
  if (!hasDestination(approved, capability.dataDestination)) return deny("destination_not_approved", 403);
  return { allowed: true };
}

function hasDestination(list: readonly DataDestination[], destination: DataDestination): boolean {
  return list.some((item) => item.kind === destination.kind && item.id === destination.id);
}

function deny(code: string, status: 403 | 404 | 409 | 503): PolicyDecision { return { allowed: false, code, status }; }
