/**
 * E2-13.E — produção: liga os efeitos de cadeia ao executor W5 existente.
 *
 * Um passo de receita executa através do mesmo `WorkspaceRuntime`: a receita
 * precisa estar selecionável (tombstone de revogação vence), o principal ativo,
 * o projeto do principal e existir uma autorização recorrente W5
 * (`AutomationScheduleGrants`) cobrindo exatamente a versão da receita. O plano
 * da ocorrência reusa os passos/limites assinados no grant, é persistido e
 * imediatamente autorizado e executado por `startScheduledRun`, que revalida a
 * autorização antes de cada efeito. A chave de ocorrência é estável
 * (scheduleId + deadline persistido da cadeia), então repetição, perda de
 * resposta e reinício retornam o run/recibo existente sem duplicar efeito.
 *
 * Ausência de autorização, receita revogada, agenda pausada ou orçamento
 * esgotado retornam erro contratual acionável e não criam plano órfão. Passos
 * de canal/composição/chat ainda não têm adaptador W5 consentido próprio e
 * falham fechado; nenhum envio é simulado.
 */
import {createHash, randomUUID} from 'node:crypto';
import {canonicalContextSnapshotPayload, parseExecutionPlan, type ExecutionPlan} from '@uptokey/sync-contract/workflow';
import {computePlanDigest} from './planner.ts';
import type {WorkspaceRuntime} from './runtime.ts';
import {assertRecipeSelectable} from './community-recipes.ts';
import type {AutomationScheduleGrants} from './automation-schedule-grants.ts';
import type {ChainEffectDispatcher, ChainEffectOutcome, ChainEffectRequest} from './automation-chain.ts';

const TERMINAL_RUN_STATUSES = new Set(['succeeded', 'failed', 'cancelled', 'needs_attention']);

function codeOf(error: unknown, fallback: string): string {
  return error && typeof error === 'object' && 'code' in error && typeof (error as {code: unknown}).code === 'string'
    ? (error as {code: string}).code
    : error instanceof Error && error.message ? error.message : fallback;
}

function defaultSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener('abort', onAbort, {once: true});
  });
}

export type WorkspaceChainEffectsOptions = {
  /** Grants store owned by the runtime scheduler facade. */
  grants: () => AutomationScheduleGrants | undefined;
  /** Server-side principal check (same one used by the workspace runtime). */
  active: (principalId: string) => Promise<boolean>;
  /** Persistent schedule lookup so a paused schedule never creates an orphan plan. */
  scheduleEnabled?: (scheduleId: string) => boolean;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  pollMs?: number;
};

export function createWorkspaceChainEffects(runtime: WorkspaceRuntime, options: WorkspaceChainEffectsOptions): ChainEffectDispatcher {
  const sleep = options.sleep ?? defaultSleep;
  const pollMs = options.pollMs ?? 25;

  async function revalidate(request: ChainEffectRequest): Promise<ChainEffectOutcome | undefined> {
    if (request.signal.aborted) return {kind: 'not_sent', code: 'cancelled'};
    const deadline = Date.parse(request.deadlineAt);
    if (!Number.isFinite(deadline) || deadline <= Date.now()) return {kind: 'not_sent', code: 'chain_deadline_exceeded'};
    if (!(await options.active(request.principalId))) return {kind: 'not_sent', code: 'principal_revoked'};
    try {
      await runtime.store.getProject(request.principalId, request.projectId);
    } catch {
      return {kind: 'not_sent', code: 'project_missing'};
    }
    return undefined;
  }

  async function prepareOccurrencePlan(request: ChainEffectRequest, grant: NonNullable<ReturnType<AutomationScheduleGrants['list']>[number]>): Promise<ExecutionPlan> {
    const project = await runtime.store.getProject(request.principalId, request.projectId);
    const snapshot = await runtime.store.snapshotContext(request.principalId, request.projectId, {
      selectedEntryIds: [],
      selectedArtifactIds: [],
      excludedEntryIds: project.entries.map(entry => entry.id),
      allowedDestinations: structuredClone(grant.destinations),
      maxContextBytes: 32_000,
    });
    const digest = createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex');
    const base = parseExecutionPlan({
      schemaVersion: 1,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
      projectId: request.projectId,
      projectRevision: project.revision,
      contextSnapshotId: snapshot.id,
      contextSnapshotDigest: digest,
      steps: structuredClone(grant.steps),
      limits: structuredClone(grant.limits),
      digest: '0'.repeat(64),
    });
    const plan = parseExecutionPlan({...base, digest: computePlanDigest(base)});
    request.signal.throwIfAborted();
    await runtime.store.putPlan(request.principalId, plan, snapshot);
    return plan;
  }

  function runOutcome(view: Awaited<ReturnType<WorkspaceRuntime['viewPlan']>>, fallbackCode: string): ChainEffectOutcome {
    const run = view.run;
    if (!run) return {kind: 'not_sent', code: 'chain_run_missing'};
    const receipts = view.receipts.filter(receipt => receipt.runId === run.id);
    const succeeded = receipts.filter(receipt => receipt.status === 'succeeded');
    if (run.status === 'succeeded') {
      return {kind: 'completed', effects: succeeded.map(receipt => receipt.id), summary: `Receita executada no workspace (run ${run.id}); ${succeeded.length} recibo(s) confirmado(s).`};
    }
    // Anything that left the process can never be reported as not_sent.
    const left = receipts.some(receipt => receipt.status === 'dispatched' || receipt.status === 'succeeded' || receipt.status === 'unknown');
    const recorded = (run as {errorCode?: unknown}).errorCode;
    const code = typeof recorded === 'string' && recorded ? recorded : fallbackCode;
    if (run.status === 'cancelled') return left ? {kind: 'failed', code: 'cancelled', sent: 'unknown'} : {kind: 'not_sent', code: 'cancelled'};
    if (run.status === 'failed') return left ? {kind: 'failed', code, sent: 'unknown'} : {kind: 'not_sent', code};
    if (run.status === 'needs_attention') return {kind: 'failed', code: 'chain_run_needs_attention', sent: 'unknown'};
    return {kind: 'failed', code, sent: 'unknown'};
  }

  async function dispatchRecipe(request: ChainEffectRequest): Promise<ChainEffectOutcome> {
    const grantsApi = options.grants();
    if (!grantsApi) return {kind: 'not_sent', code: 'chain_w5_authorization_required'};
    const version = Number(request.step.bindings?.recipeVersion);
    if (!Number.isSafeInteger(version) || version < 1) return {kind: 'not_sent', code: 'recipe_version_required'};
    const recipes = await runtime.store.listRecipes(request.principalId, request.projectId);
    const recipe = recipes.find(item => item.id === request.step.ref && item.version === version);
    if (!recipe) return {kind: 'not_sent', code: 'recipe_missing'};
    // Durable tombstone: a revoked version cannot be re-selected through a chain.
    try {
      await assertRecipeSelectable(runtime, request.principalId, request.projectId, recipe);
    } catch (error) {
      return {kind: 'not_sent', code: codeOf(error, 'recipe_revoked')};
    }
    const now = Date.now();
    const grant = [...grantsApi.list(request.principalId, request.projectId)].reverse().find(candidate =>
      !candidate.revokedAt
      && Date.parse(candidate.expiresAt) > now
      && candidate.recipeId === recipe.id
      && candidate.recipeVersion === recipe.version);
    if (!grant) return {kind: 'not_sent', code: 'chain_w5_authorization_required'};
    if (options.scheduleEnabled && !options.scheduleEnabled(grant.scheduleId)) return {kind: 'not_sent', code: 'schedule_paused'};

    // Stable occurrence identity: the chain run deadline is persisted, so a lost
    // reply, restart or retry resolves to the same claim and the same W5 run.
    const occurrenceKey = `${grant.scheduleId}@${request.deadlineAt}`;
    const existingClaim = grant.claims.find(claim => claim.occurrenceKey === occurrenceKey);
    if (!existingClaim && grant.claims.length >= grant.maxOccurrences) return {kind: 'not_sent', code: 'schedule_grant_exhausted'};

    let plan: ExecutionPlan | undefined;
    if (existingClaim) {
      plan = await runtime.store.getPlan(request.principalId, request.projectId, existingClaim.planId);
      if (!plan || plan.digest !== existingClaim.planDigest) return {kind: 'not_sent', code: 'schedule_claim_conflict'};
    }
    if (!plan) {
      // Preconditions above rejected before any persistence; the plan below is
      // immediately authorized and executed, never left as an orphan.
      try {
        plan = await prepareOccurrencePlan(request, grant);
      } catch (error) {
        return {kind: 'not_sent', code: codeOf(error, 'schedule_plan_unavailable')};
      }
    }

    let authority;
    try {
      authority = await grantsApi.authorizeOccurrence(runtime.store, request.principalId, request.projectId, grant.scheduleId, occurrenceKey, plan);
    } catch (error) {
      return {kind: 'not_sent', code: codeOf(error, 'schedule_authorization_inactive')};
    }
    let runId: string | undefined;
    try {
      const started = await runtime.startScheduledRun(authority);
      runId = started.run?.id;
    } catch (error) {
      return {kind: 'not_sent', code: codeOf(error, 'schedule_run_start_failed')};
    }
    if (!runId) return {kind: 'not_sent', code: 'schedule_run_missing'};
    // Same claim↔run link the scheduler path records; a replay still resolves by
    // the claim requestId even if this observability write fails.
    try {
      grantsApi.linkRun(request.principalId, request.projectId, authority.grantId, occurrenceKey, runId);
    } catch {
      /* the durable run is already addressable by the claim requestId */
    }

    // The W5 executor drives the run in background; observe its durable record
    // instead of inventing an outcome. The chain signal aborts through the
    // canonical cancel, so no effect can settle after cancellation.
    for (;;) {
      const view = await runtime.viewPlan(request.principalId, request.projectId, plan.id);
      if (view.run && TERMINAL_RUN_STATUSES.has(view.run.status)) return runOutcome(view, 'chain_run_failed');
      if (request.signal.aborted) {
        try {
          await runtime.cancel(request.principalId, request.projectId, runId);
        } catch {
          /* cancellation already observed by the executor */
        }
        const settled = await runtime.viewPlan(request.principalId, request.projectId, plan.id).catch(() => undefined);
        return settled ? runOutcome(settled, 'cancelled') : {kind: 'not_sent', code: 'cancelled'};
      }
      if (Date.parse(request.deadlineAt) <= Date.now()) return {kind: 'failed', code: 'chain_deadline_exceeded', sent: 'unknown'};
      try {
        await sleep(pollMs, request.signal);
      } catch {
        /* cancellation re-evaluated on the next loop */
      }
    }
  }

  return {
    async dispatch(request: ChainEffectRequest): Promise<ChainEffectOutcome> {
      const denial = await revalidate(request);
      if (denial) return denial;
      if (request.step.kind !== 'recipe') {
        // Each remaining kind needs its own consented W5 plan/preparation. Until
        // that adapter exists the chain fails closed with an actionable code; no
        // synthetic send, no orphan plan and no widened client scope.
        return {kind: 'not_sent', code: `chain_step_${request.step.kind}_requires_w5_plan`};
      }
      return dispatchRecipe(request);
    },
    // No real inverse exists for a completed production/inference step, and
    // channel sends are not reachable yet. Absence is recorded as
    // skipped_unavailable by the executor; an inverse is never invented.
  };
}
