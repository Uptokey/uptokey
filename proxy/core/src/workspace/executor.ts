import type {Artifact} from '@uptokey/sync-contract/workflow';
import type {ProjectTaskAuthority} from './project-task-authority.ts';
/**
 * W3 — executor local serial de planos aprovados.
 *
 * Garantias: intenção (`prepared`, depois `dispatched`) é persistida antes do efeito e o
 * resultado depois; política é reavaliada antes de cada etapa; cancelamento impede novas
 * etapas e propaga AbortSignal; após reinício, tentativa `dispatched` de inferência vira
 * `unknown` e o run fica `needs_attention`, sem reenvio automático.
 *
 * NÃO garante exactly-once com serviços externos: provedor pode ter recebido e cobrado uma
 * tentativa `unknown`; leituras externas podem ser consultadas mais de uma vez; cancelamento
 * não desfaz efeito já recebido; política só cobre efeitos despachados por este executor.
 */
import { randomUUID } from "node:crypto";
import {
  parseCapabilityDescriptor,
  parseExecutionPlan,
  parseProjectGrant,
  parseRun,
  parseWorkflowCommand,
  WORKFLOW_LIMITS,
  type CapabilityDescriptor,
  type ExecutionLimits,
  type ExecutionPlan,
  type ExecutionReceipt,
  type JsonData,
  type PlanStep,
  type Run,
  type StepState,
} from "@uptokey/sync-contract/workflow";
import { RequestAdmission } from "../request-admission.ts";
import {
  authorizeRunStart,
  authorizeTaskRunStart,
  authorizeStep,
  capabilityKey,
  computePlanDigest,
  effectiveLimits,
  runDeadlineAt,
  utcInstant,
  type AccessGateDecision,
  type PlanApproval,
  type PolicySnapshot,
} from "./policy.ts";
import {
  countDispatchedCalls,
  isNotSent,
  markDispatched,
  policyDeniedReceipt,
  prepareReceipt,
  receiptsForStep,
  settleReceipt,
  type SettleInput,
  type SourceInput,
} from "./receipts.ts";

/** Tentativas por etapa, somando retries automáticos permitidos (leitura, escrita local idempotente, não enviado). */
export const MAX_ATTEMPTS_PER_STEP = 3;
const MAX_COMMIT_RETRIES = 16;

export interface RunRecord { revision: number; run: Run; receipts: ExecutionReceipt[]; }

export type CreateRunResult =
  | { kind: "created"; record: RunRecord }
  | { kind: "existing"; record: RunRecord }
  | { kind: "conflict"; code: "project_run_active" | "approval_consumed" };

/**
 * Persistência durável (W1). Run, recibos e consumo de aprovação ficam no MESMO snapshot
 * transacional do projeto; `commit` é compare-and-set por revisão.
 */
export type EffectArtifact={artifactId:string;mediaType:Artifact['mediaType'];bytes:Uint8Array};
export interface RunJournal {
  isTaskRequest?(projectId:string,requestId:string):Promise<boolean>;
  readTaskAuthority?(projectId:string,planId:string,requestId:string):Promise<ProjectTaskAuthority|undefined>;
  createTaskRun?(run:Run):Promise<CreateRunResult>;
  commitEffectArtifacts?(projectId:string,runId:string,expectedRevision:number,next:{run:Run;receipts:ExecutionReceipt[]},artifacts:readonly EffectArtifact[]):Promise<{kind:'committed';record:RunRecord}|{kind:'conflict'}>;
  findByRequest(projectId: string, principalId: string, requestId: string): Promise<RunRecord | undefined>;
  readApproval(projectId: string, planId: string): Promise<PlanApproval | undefined>;
  /** Atômico: requestId existente → existing; aprovação consumida por outro run ou run ativo no projeto → conflict. */
  createRun(run: Run, approvalId: string): Promise<CreateRunResult>;
  read(projectId: string, runId: string): Promise<RunRecord | undefined>;
  commit(projectId: string, runId: string, expectedRevision: number, next: { run: Run; receipts: ExecutionReceipt[] }): Promise<{ kind: "committed"; record: RunRecord } | { kind: "conflict" }>;
  /** Runs com status `running` para recuperação no boot. */
  listRecoverable(): Promise<Array<{ projectId: string; runId: string }>>;
}

/** Estado corrente de autorização (W5/W1/W2). Cada chamada relê a fonte; sem cache. */
export interface PolicyEnvironment {
  isPrincipalActive(principalId: string): Promise<boolean>;
  accessGate(): Promise<AccessGateDecision>;
  loadGrant(principalId: string, projectId: string): Promise<unknown>;
  loadPlan(projectId: string, planId: string): Promise<unknown>;
  resolveCapability(id: string, version: number): Promise<unknown>;
  /**
   * Owner-bound learned-recipe capabilities (stage 18). Optional so existing
   * environments keep working; the executor tries it only when the shared
   * registry has no descriptor, keeping learned ids out of global listings.
   */
  resolveLearnedCapability?(principalId: string, projectId: string, id: string, version: number): Promise<unknown>;
  policyRevision(): Promise<number>;
}

export type ResolvedBinding = { kind: "literal"; value: JsonData } | { kind: "step_output"; stepId: string; output: string; artifactRefs: string[] };

export interface EffectRequest {
  projectId: string; runId: string; stepId: string; attemptId: string; principalId: string;
  capability: CapabilityDescriptor; arguments: Record<string, ResolvedBinding>; limits: ExecutionLimits;
  /** Prazo total do run (ISO UTC); `signal` aborta nele ou no cancelamento. */
  deadlineAt: string; signal: AbortSignal;
  /** F1/E1: authority owned by the caller (account funding, identity), revalidated by the executor
   * after its last wait and immediately before the transport. A rejection means nothing was sent. */
  dispatchGate?: { validate(signal: AbortSignal): Promise<void> };
}

/**
 * Resultado do serviço (inferência/fonte/artefato). `not_sent` somente quando o efeito
 * comprovadamente não saiu do processo; em dúvida, `failed` com `sent: "unknown"`.
 */
export type EffectOutcome =
  | { kind: "not_sent"; code: string }
  | { kind: "completed"; artifacts?:readonly EffectArtifact[]; outputArtifactRefs: string[]; sources?: SourceInput[]; usage?: unknown }
  | { kind: "pending"; artifacts?:readonly EffectArtifact[]; outputArtifactRefs:string[]; sources?:SourceInput[]; usage?:unknown }
  | { kind: "failed"; code: string; sent: "yes" | "unknown"; usage?: unknown };

export interface EffectDispatcher { dispatch(request: EffectRequest): Promise<EffectOutcome>; }

export type StartResult =
  | { kind: "created" | "existing"; run: Run }
  | { kind: "rejected"; status: 400 | 403 | 404 | 409 | 429 | 503; code: string };

export type CancelResult = { kind: "ok"; run: Run } | { kind: "rejected"; status: 403 | 404; code: string };
export type ResolveAttentionAction = 'keep_stopped' | 'retry';
export type ResolveAttentionResult =
  | { kind: "ok"; run: Run; action: ResolveAttentionAction }
  | { kind: "rejected"; status: 400 | 403 | 404 | 409; code: string };

export interface WorkflowExecutorOptions {
  journal: RunJournal;
  policy: PolicyEnvironment;
  effects: EffectDispatcher;
  now?: () => Date;
  newId?: () => string;
  admission?: RequestAdmission;
  /** Espera entre tentativas; padrão usa `schedule` quando injetado. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** Agenda callback após `ms` no relógio do executor; retorna cancelamento. Padrão: setTimeout sem manter o processo vivo. */
  schedule?: (ms: number, callback: () => void) => () => void;
  retryBaseMs?: number;
}

export class WorkflowExecutor {
  private readonly journal: RunJournal;
  private readonly policy: PolicyEnvironment;
  private readonly effects: EffectDispatcher;
  private readonly now: () => Date;
  private readonly newId: () => string;
  private readonly admission: RequestAdmission;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly schedule: (ms: number, callback: () => void) => () => void;
  private readonly retryBaseMs: number;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private startQueue: Promise<unknown> = Promise.resolve();

  constructor(options: WorkflowExecutorOptions) {
    this.journal = options.journal;
    this.policy = options.policy;
    this.effects = options.effects;
    this.now = options.now ?? (() => new Date());
    this.newId = options.newId ?? randomUUID;
    this.admission = options.admission ?? new RequestAdmission(WORKFLOW_LIMITS.activeRunsPerProcess);
    this.schedule = options.schedule ?? unrefTimer;
    this.sleep = options.sleep ?? (options.schedule ? scheduledSleep(options.schedule) : abortableSleep);
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
  }

  /** Persiste e admite o run; a execução segue em segundo plano (HTTP 202 no integrador). */
  start(principalId: string, projectId: string, command: unknown): Promise<StartResult> {
    const next = this.startQueue.then(() => this.startSerial(principalId, projectId, command));
    this.startQueue = next.catch(() => undefined);
    return next;
  }

  async cancel(principalId: string, projectId: string, runId: string): Promise<CancelResult> {
    const record = await this.journal.read(projectId, runId);
    if (!record || record.run.principalId !== principalId || record.run.projectId !== projectId) return { kind: "rejected", status: 404, code: "run_not_found" };
    if (!await this.policy.isPrincipalActive(principalId)) return { kind: "rejected", status: 403, code: "principal_revoked" };
    const updated = await this.mutate(projectId, runId, (current) => {
      if (isTerminal(current.run.status)) return undefined;
      const at = this.stamp(current.run.updatedAt);
      // Cancellation and receipt settlement share the CAS. Late effects cannot reopen
      // a cancelled run or publish output, even if the provider ignores abort.
      const receipts=current.receipts.map(receipt=>receipt.status==='dispatched'
        ?settleReceipt(receipt,{kind:'unknown',code:'cancelled',now:at})
        :receipt.status==='prepared'?settleReceipt(receipt,{kind:'not_sent',code:'cancelled',now:at}):receipt);
      const stepStates=current.run.stepStates.map(state=>state.status==='dispatched'?{...state,status:'unknown' as const}:state.status==='prepared'?{...state,status:'failed' as const}:state);
      return { run: { ...current.run, stepStates, status: "cancelled", updatedAt: at, finishedAt: at }, receipts };
    });
    this.active.get(runId)?.controller.abort(new Error("run_cancelled"));
    return { kind: "ok", run: structuredClone((updated ?? record).run) };
  }

  /** Boot: converte tentativas interrompidas e retoma somente o que é seguro. */
  
  async resolveAttention(
    principalId: string,
    projectId: string,
    runId: string,
    input: {
      expectedRunRevision?: number;
      action: ResolveAttentionAction;
      reason?: string;
    },
  ): Promise<ResolveAttentionResult> {
    const record = await this.journal.read(projectId, runId);
    if (!record || record.run.principalId !== principalId || record.run.projectId !== projectId) {
      return { kind: "rejected", status: 404, code: "run_not_found" };
    }
    if (!(await this.policy.isPrincipalActive(principalId))) {
      return { kind: "rejected", status: 403, code: "principal_revoked" };
    }
    if (record.run.status !== "needs_attention") {
      return { kind: "rejected", status: 409, code: "run_not_in_attention" };
    }
    if (
      typeof input.expectedRunRevision === 'number' &&
      record.revision !== input.expectedRunRevision &&
      (record.run as any).revision !== input.expectedRunRevision
    ) {
      return { kind: "rejected", status: 409, code: "run_revision_conflict" };
    }
    if (input.action !== "keep_stopped" && input.action !== "retry") {
      return { kind: "rejected", status: 400, code: "invalid_attention_action" };
    }

    let conflict: "run_not_in_attention" | "run_revision_conflict" = "run_not_in_attention";
    const updated = await this.mutate(projectId, runId, (current) => {
      if (current.run.status !== "needs_attention") { conflict = "run_not_in_attention"; return undefined; }
      // Precondição do cliente reaplicada dentro do CAS: uma revisão concorrente
      // entre a leitura e o commit recusa a resolução em vez de aceitar stale.
      if (typeof input.expectedRunRevision === "number" && current.revision !== input.expectedRunRevision) {
        conflict = "run_revision_conflict";
        return undefined;
      }
      const at = this.stamp(current.run.updatedAt);
      // Incerteza de envio: recibo `dispatched` pode ter saído do processo; só
      // `prepared` é comprovadamente não enviado (mesma semântica do recover).
      const receipts = current.receipts.map((receipt) => {
        if (receipt.status === "dispatched") return settleReceipt(receipt, { kind: "unknown", code: "attention_resolved", now: at });
        if (receipt.status === "prepared") return settleReceipt(receipt, { kind: "not_sent", code: "attention_resolved", now: at });
        return receipt;
      });
      const stepStates = current.run.stepStates.map((state) => {
        if (state.status === "dispatched") return { ...state, status: "unknown" as const };
        if (state.status === "prepared") return { ...state, status: "failed" as const };
        return state;
      });
      return {
        run: {
          ...current.run,
          stepStates,
          status: "failed",
          updatedAt: at,
          finishedAt: at,
        },
        receipts,
      };
    });
    if (!updated) return { kind: "rejected", status: 409, code: conflict };

    return { kind: "ok", run: structuredClone(updated.run), action: input.action };
  }

  async recover(): Promise<void> {
    for (const { projectId, runId } of await this.journal.listRecoverable()) {
      if (this.active.has(runId)) continue;
      await this.reconcileInterrupted(projectId, runId);
      const record = await this.journal.read(projectId, runId);
      if (record?.run.status !== "running") continue;
      const release = this.admission.tryAcquire();
      if (!release) { await this.setRunStatus(projectId, runId, "needs_attention"); continue; }
      this.launch(projectId, runId, release);
    }
  }

  /** Aguarda o término do loop em memória (testes/shutdown). */
  async settled(runId: string): Promise<void> { await this.active.get(runId)?.done; }
  async settledAll(): Promise<void> { await Promise.all([...this.active.values()].map(item=>item.done)); }

  abortAll(): void { for (const { controller } of this.active.values()) controller.abort(new Error("executor_shutdown")); }

  private async startSerial(principalId: string, projectId: string, rawCommand: unknown): Promise<StartResult> {
    let command;
    try { command = parseWorkflowCommand("startRun", rawCommand); } catch (e: any) { console.log("EFFECT EXCEPTION STDOUT:", e.stack || e); return { kind: "rejected", status: 400, code: "invalid_request" }; }
    const snapshot = await this.policySnapshot(principalId, projectId, command.planId);
    const delegation=await this.journal.readTaskAuthority?.(projectId,command.planId,command.requestId);
    if(!delegation&&await this.journal.isTaskRequest?.(projectId,command.requestId))return {kind:'rejected',status:403,code:'project_task_authority_invalid'};
    if(delegation)snapshot.grant=delegation.grant;
    const existing = await this.journal.findByRequest(projectId, principalId, command.requestId);
    if (existing) {
      if (existing.run.planId !== command.planId || existing.run.planDigest !== command.planDigest) return { kind: "rejected", status: 409, code: "request_id_reused" };
      const allowed = checkBase(snapshot);
      if (!allowed.allowed) return { kind: "rejected", status: (allowed as any).status, code: (allowed as any).code };
      return { kind: "existing", run: structuredClone(existing.run) };
    }
    const approval = await this.journal.readApproval(projectId, command.planId);
    const decision = delegation?authorizeTaskRunStart({...snapshot,principalId,projectId,planId:command.planId,requestedDigest:command.planDigest,requestId:command.requestId,delegation}):authorizeRunStart({ ...snapshot, principalId, projectId, planId: command.planId, requestedDigest: command.planDigest, approval });
    if (!decision.allowed) return { kind: "rejected", status: (decision as any).status, code: (decision as any).code };
    const plan = snapshot.plan!;
    const release = this.admission.tryAcquire();
    if (!release) return { kind: "rejected", status: 429, code: "local_capacity_exceeded" };
    try {
      const at = this.now().toISOString();
      const run = parseRun({
        schemaVersion: 1, id: this.newId(), createdAt: at, projectId, principalId, planId: plan.id, planDigest: computePlanDigest(plan),
        policyRevision: snapshot.policyRevision, requestId: command.requestId, status: "running",
        stepStates: plan.steps.map((step): StepState => ({ stepId: step.id, status: "pending", attemptIds: [], receiptIds: [] })),
        updatedAt: at, finishedAt: null,
      });
      const created = delegation&&this.journal.createTaskRun?await this.journal.createTaskRun(run):await this.journal.createRun(run, approval!.id);
      if (created.kind === "conflict") { release(); return { kind: "rejected", status: 409, code: created.code }; }
      if (created.kind === "existing") {
        release();
        const same = created.record.run.planId === run.planId && created.record.run.planDigest === run.planDigest;
        return same ? { kind: "existing", run: structuredClone(created.record.run) } : { kind: "rejected", status: 409, code: "request_id_reused" };
      }
      this.launch(projectId, created.record.run.id, release);
      return { kind: "created", run: structuredClone(created.record.run) };
    } catch (error) { release(); throw error; }
  }

  private launch(projectId: string, runId: string, release: () => void): void {
    const controller = new AbortController();
    const done = this.drive(projectId, runId, controller.signal)
      .catch(async () => { await this.setRunStatus(projectId, runId, "needs_attention").catch(() => undefined); })
      .finally(() => { release(); this.active.delete(runId); });
    this.active.set(runId, { controller, done });
  }

  private async drive(projectId: string, runId: string, signal: AbortSignal): Promise<void> {
    // Recibo cuja espera de nova tentativa já foi cumprida neste loop (evita esperar duas vezes).
    let waitedFor: string | undefined;
    for (;;) {
      const record = await this.journal.read(projectId, runId);
      if (!record || record.run.status !== "running") return;
      const { run } = record;
      const index = run.stepStates.findIndex((state) => state.status !== "succeeded");
      if (index === -1) { await this.finish(projectId, runId, "succeeded"); return; }
      const state = run.stepStates[index]!;
      const snapshot = await this.policySnapshot(run.principalId, projectId, run.planId);
      const delegation=await this.journal.readTaskAuthority?.(projectId,run.planId,run.requestId);
      if(!delegation&&await this.journal.isTaskRequest?.(projectId,run.requestId)){await this.deny(projectId,runId,state.stepId,undefined,'project_task_authority_invalid');return;}
      if(delegation)snapshot.grant=delegation.grant;
      const step = snapshot.plan?.steps.find((candidate) => candidate.id === state.stepId);
      const capability = step ? snapshot.capabilities.get(capabilityKey(step.capabilityId, step.capabilityVersion)) : undefined;
      const stepReceipts = receiptsForStep(record.receipts, state.stepId);

      if (state.status === "prepared" || state.status === "dispatched") { await this.reconcileInterrupted(projectId, runId); continue; }
      const last = stepReceipts.at(-1);
      const retrying = state.status === "failed" || state.status === "unknown";
      if(delegation&&state.status==='unknown'){await this.finish(projectId,runId,'needs_attention');return;}
      if (retrying && (!last || !retryAllowed(last, capability, consecutiveFailures(stepReceipts)))) {
        await this.finish(projectId, runId, state.status === "unknown" ? "needs_attention" : "failed");
        return;
      }

      // Prazo do run inteiro, ancorado no createdAt persistido (não renova após reinício).
      const limits = snapshot.plan && snapshot.grant ? effectiveLimits(snapshot.plan, snapshot.grant) : undefined;
      const deadline = limits ? Math.min(runDeadlineAt(run, limits)??Infinity,Date.parse(snapshot.grant!.expiresAt)) : undefined;
      if (deadline !== undefined && this.now().getTime() >= deadline) { await this.expire(projectId, runId, state, step); return; }

      if (retrying && last && waitedFor !== last.id) {
        const backoff = this.retryBaseMs * 2 ** (consecutiveFailures(stepReceipts) - 1);
        if (deadline !== undefined && this.now().getTime() + backoff >= deadline) { await this.expire(projectId, runId, state, step); return; }
        const window = this.runWindow(signal, deadline);
        try { await this.sleep(backoff, window.signal); } catch (e) { console.error("EFFECT EXCEPTION:", e); /* cancelamento ou prazo: reavaliados no próximo ciclo */ } finally { window.dispose(); }
        if (signal.aborted) return;
        waitedFor = last.id;
        continue;
      }

      const intervalBinding=step?.arguments.poll_interval_ms;
      const pollInterval=intervalBinding?.kind==='literal'?intervalBinding.value:undefined;
      const polling=state.status==='pending'&&last?.status==='succeeded';
      if(polling){
        if(capability?.effect!=='read_external'||capability.retryClass!=='read_only'||!Number.isSafeInteger(pollInterval)||Number(pollInterval)<1000||Number(pollInterval)>60000){await this.deny(projectId,runId,state.stepId,step,'poll_invalid');return;}
        const remaining=Date.parse(last.finishedAt!)+Number(pollInterval)-this.now().getTime();
        if(remaining>0){
          if(deadline!==undefined&&this.now().getTime()+remaining>=deadline){await this.expire(projectId,runId,state,step);return;}
          const window=this.runWindow(signal,deadline);try{await this.sleep(remaining,window.signal);}catch{}finally{window.dispose();}
          if(signal.aborted)return;continue;
        }
      }

      const approval = await this.journal.readApproval(projectId, run.planId);
      const decision = step
        ? authorizeStep({ ...snapshot, run, step, approvalDestinations: delegation?.grant.destinations??(approval?.planDigest === run.planDigest ? approval.destinations : []), dispatchedCalls: countDispatchedCalls(record.receipts) })
        : { allowed: false as const, code: "plan_changed", status: 409 as const };
      if (!decision.allowed) { await this.deny(projectId, runId, state.stepId, step, (decision as any).code); return; }

      const attemptId = this.newId();
      const receiptId = this.newId();
      const resolved = resolveBindings(step!, record.receipts, run.stepStates);
      const prepared = await this.mutate(projectId, runId, (current) => {
        if (current.run.status !== "running") return undefined;
        const at = this.stamp(current.run.updatedAt);
        const receipt = prepareReceipt({ id: receiptId, projectId, runId, stepId: state.stepId, attemptId, capability: capability!, inputArtifactRefs: resolved.inputArtifactRefs, now: at });
        return { run: withStep(current.run, state.stepId, "prepared", at, attemptId, receiptId), receipts: [...current.receipts, receipt] };
      });
      if (!prepared) return;

      const dispatched = await this.mutate(projectId, runId, (current) => {
        const receipt = current.receipts.find((item) => item.id === receiptId);
        if (!receipt || receipt.status !== "prepared") return undefined;
        const at = this.stamp(current.run.updatedAt);
        const expired = deadline === undefined || this.now().getTime() >= deadline;
        if (current.run.status !== "running" || expired) {
          const code = current.run.status !== "running" ? "cancelled" : "run_timeout_exceeded";
          return { run: withStep(current.run, state.stepId, "failed", at), receipts: replace(current.receipts, settleReceipt(receipt, { kind: "not_sent", code, now: at })) };
        }
        return { run: withStep(current.run, state.stepId, "dispatched", at), receipts: replace(current.receipts, markDispatched(receipt)) };
      });
      if (!dispatched || dispatched.run.status !== "running") return;
      if (dispatched.receipts.find((item) => item.id === receiptId)?.status !== "dispatched") continue;

      const window = this.runWindow(signal, deadline);
      let outcome: EffectOutcome;
      try {
        outcome = await this.effects.dispatch({ projectId, runId, stepId: state.stepId, attemptId, principalId: run.principalId, capability: capability!, arguments: resolved.arguments, limits: limits!, deadlineAt: new Date(deadline!).toISOString(), signal: window.signal });
      } catch {
        outcome = { kind: "failed", code: window.timedOut() ? "run_timeout_exceeded" : window.signal.aborted ? "aborted" : "effect_exception", sent: "unknown" };
      } finally { window.dispose(); }
      if (window.timedOut() && outcome.kind === "failed") outcome = { ...outcome, code: "run_timeout_exceeded" };
      if(outcome.kind==='pending'&&(capability?.effect!=='read_external'||capability.retryClass!=='read_only'||!Number.isSafeInteger(pollInterval)||Number(pollInterval)<1000||Number(pollInterval)>60000))outcome={kind:'failed',code:'poll_invalid',sent:'unknown'};
      const artifacts=(outcome.kind==='completed'||outcome.kind==='pending')?outcome.artifacts?.map(item=>({...item,bytes:new Uint8Array(item.bytes)})):undefined;
      const pending=outcome.kind==='pending';
      const settle = toSettleInput(outcome);
      await this.mutate(projectId, runId, (current) => {
        const receipt = current.receipts.find((item) => item.id === receiptId);
        if (!receipt || receipt.status !== "dispatched" || current.run.status!=="running") return undefined;
        const at = this.stamp(current.run.updatedAt);
        // `not_sent` depois de `dispatched` depende da garantia do serviço (porta EffectDispatcher).
        const settled = settleReceipt(receipt, { ...settle, now: at } as SettleInput);
        const stepStatus = settled.status === "succeeded" ? pending?"pending":"succeeded" : settled.status === "unknown" ? "unknown" : "failed";
        return { run: withStep(current.run, state.stepId, stepStatus, at), receipts: replace(current.receipts, settled) };
      },artifacts);
    }
  }

  /**
   * Prazo esgotado: nenhum efeito novo. Resultado `unknown` pendente continua visível para
   * ação humana (`needs_attention`); demais casos encerram o run com recibo de recusa.
   */
  private async expire(projectId: string, runId: string, state: StepState, step: PlanStep | undefined): Promise<void> {
    if (state.status === "unknown") { await this.finish(projectId, runId, "needs_attention"); return; }
    await this.deny(projectId, runId, state.stepId, step, "run_timeout_exceeded");
  }

  /** Sinal que aborta por cancelamento do run ou ao atingir o prazo total, pelo agendador injetado. */
  private runWindow(signal: AbortSignal, deadline: number | undefined): { signal: AbortSignal; timedOut: () => boolean; dispose: () => void } {
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort(signal.reason);
    if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
    let cancelTimer: () => void = () => undefined;
    if (deadline !== undefined && !controller.signal.aborted) {
      const expire = () => { timedOut = true; controller.abort(new Error("run_timeout_exceeded")); };
      const remaining = deadline - this.now().getTime();
      if (remaining <= 0) expire(); else cancelTimer = this.schedule(remaining, expire);
    }
    return { signal: controller.signal, timedOut: () => timedOut, dispose: () => { cancelTimer(); signal.removeEventListener("abort", onAbort); } };
  }

  /** Tentativa `prepared` nunca saiu do processo; `dispatched` tem envio desconhecido. */
  private async reconcileInterrupted(projectId: string, runId: string): Promise<void> {
    await this.mutate(projectId, runId, (current) => {
      let changed = false;
      let run = current.run;
      let receipts = current.receipts;
      const at = this.stamp(current.run.updatedAt);
      for (const state of current.run.stepStates) {
        if (state.status !== "prepared" && state.status !== "dispatched") continue;
        const receipt = receipts.find((item) => item.id === state.receiptIds.at(-1));
        if (!receipt) continue;
        const settled = receipt.status === "prepared"
          ? settleReceipt(receipt, { kind: "not_sent", code: "interrupted", now: at })
          : receipt.status === "dispatched" ? settleReceipt(receipt, { kind: "unknown", code: "interrupted_after_dispatch", now: at }) : receipt;
        receipts = replace(receipts, settled);
        run = withStep(run, state.stepId, settled.status === "unknown" ? "unknown" : "failed", at);
        changed = true;
      }
      return changed ? { run, receipts } : undefined;
    });
  }

  private async deny(projectId: string, runId: string, stepId: string, step: PlanStep | undefined, code: string): Promise<void> {
    await this.mutate(projectId, runId, (current) => {
      if (current.run.status !== "running") return undefined;
      const at = this.stamp(current.run.updatedAt);
      const receiptId = this.newId(), attemptId = this.newId();
      const receipt = policyDeniedReceipt({
        id: receiptId, projectId, runId, stepId, attemptId,
        capability: { id: step?.capabilityId ?? "unavailable", version: step?.capabilityVersion ?? 1 },
        inputArtifactRefs: [], now: at, code,
      });
      const run = withStep(current.run, stepId, "failed", at, attemptId, receiptId);
      return { run: { ...run, status: "failed", finishedAt: at }, receipts: [...current.receipts, receipt] };
    });
  }

  private async finish(projectId: string, runId: string, status: "succeeded" | "failed" | "needs_attention"): Promise<void> {
    await this.setRunStatus(projectId, runId, status);
  }

  private async setRunStatus(projectId: string, runId: string, status: "succeeded" | "failed" | "needs_attention"): Promise<void> {
    await this.mutate(projectId, runId, (current) => {
      if (current.run.status !== "running") return undefined;
      const at = this.stamp(current.run.updatedAt);
      return { run: { ...current.run, status, updatedAt: at, finishedAt: status === "needs_attention" ? null : at }, receipts: current.receipts };
    });
  }

  private async mutate(projectId: string, runId: string, change: (record: RunRecord) => { run: Run; receipts: ExecutionReceipt[] } | undefined, artifacts?:readonly EffectArtifact[]): Promise<RunRecord | undefined> {
    for (let attempt = 0; attempt < MAX_COMMIT_RETRIES; attempt += 1) {
      const current = await this.journal.read(projectId, runId);
      if (!current) return undefined;
      const next = change(structuredClone(current));
      if (!next) return undefined;
      if(artifacts&&!this.journal.commitEffectArtifacts)throw new Error('workflow_artifact_commit_unavailable');
      const result = artifacts?await this.journal.commitEffectArtifacts!(projectId,runId,current.revision,{run:parseRun(next.run),receipts:next.receipts},artifacts):await this.journal.commit(projectId, runId, current.revision, { run: parseRun(next.run), receipts: next.receipts });
      if (result.kind === "committed") return result.record;
    }
    throw new Error("workflow_journal_conflict");
  }

  private async policySnapshot(principalId: string, projectId: string, planId: string): Promise<PolicySnapshot> {
    const [principalActive, accessGate, rawGrant, rawPlan, policyRevision] = await Promise.all([
      this.policy.isPrincipalActive(principalId), this.policy.accessGate(), this.policy.loadGrant(principalId, projectId),
      this.policy.loadPlan(projectId, planId), this.policy.policyRevision(),
    ]);
    const grant = parseOrUndefined(parseProjectGrant, rawGrant);
    const plan = parseOrUndefined(parseExecutionPlan, rawPlan) as ExecutionPlan | undefined;
    const capabilities = new Map<string, CapabilityDescriptor>();
    for (const step of plan?.steps ?? []) {
      const key = capabilityKey(step.capabilityId, step.capabilityVersion);
      if (capabilities.has(key)) continue;
      const descriptor = parseOrUndefined(parseCapabilityDescriptor, await this.policy.resolveCapability(step.capabilityId, step.capabilityVersion))
        ?? parseOrUndefined(parseCapabilityDescriptor, await this.policy.resolveLearnedCapability?.(principalId, projectId, step.capabilityId, step.capabilityVersion));
      if (descriptor) capabilities.set(key, descriptor);
    }
    return { now: this.now(), principalActive, accessGate, grant, plan, policyRevision, capabilities };
  }

  private stamp(previous: string): string {
    const now = this.now().toISOString();
    return now > previous ? now : previous;
  }
}

/** Inferência nunca é repetida automaticamente após possível envio; não enviado pode repetir dentro do limite. */
function consecutiveFailures(receipts:readonly ExecutionReceipt[]):number {let n=0;for(const receipt of [...receipts].reverse()){if(receipt.status==='succeeded')break;n++;}return n;}
function retryAllowed(last: ExecutionReceipt, capability: CapabilityDescriptor | undefined, attempts: number): boolean {
  if (attempts >= MAX_ATTEMPTS_PER_STEP || !capability) return false;
  if (last.errorCode?.startsWith("policy.") || last.errorCode === "not_sent.cancelled" || last.errorCode === "not_sent.video_job_terminal") return false;
  // Configuration/snapshot drift and missing credentials require a new reviewed plan or setup.
  if(last.errorCode?.startsWith('not_sent.')&&/(?:_profile_changed|_manifest_conflict|_credential_missing|_credentials_missing|_authorization_inactive|_input_invalid)$/.test(last.errorCode))return false;
  if (isNotSent(last)) return true;
  return capability.effect !== "inference" && capability.retryClass !== "never_automatic";
}

type SettleWithoutNow = { [K in SettleInput["kind"]]: Omit<Extract<SettleInput, { kind: K }>, "now"> }[SettleInput["kind"]];

function toSettleInput(outcome: EffectOutcome): SettleWithoutNow {
  if (outcome.kind === "completed"||outcome.kind === "pending") return { kind: "completed", outputArtifactRefs: outcome.outputArtifactRefs, sources: outcome.sources, usage: outcome.usage };
  if (outcome.kind === "not_sent") return { kind: "not_sent", code: outcome.code };
  return outcome.sent === "yes" ? { kind: "failed", code: outcome.code, usage: outcome.usage } : { kind: "unknown", code: outcome.code, usage: outcome.usage };
}

function resolveBindings(step: PlanStep, receipts: readonly ExecutionReceipt[], states: readonly StepState[]): { arguments: Record<string, ResolvedBinding>; inputArtifactRefs: string[] } {
  const resolved: Record<string, ResolvedBinding> = {};
  const inputs: string[] = [];
  for (const [key, binding] of Object.entries(step.arguments)) {
    if (binding.kind === "literal") { resolved[key] = { kind: "literal", value: structuredClone(binding.value) }; continue; }
    const source = states.find((state) => state.stepId === binding.stepId);
    const succeeded = [...receipts].reverse().find((receipt) => receipt.stepId === binding.stepId && receipt.status === "succeeded" && source?.receiptIds.includes(receipt.id));
    const artifactRefs = succeeded ? [...succeeded.outputArtifactRefs] : [];
    inputs.push(...artifactRefs);
    resolved[key] = { kind: "step_output", stepId: binding.stepId, output: binding.output, artifactRefs };
  }
  return { arguments: resolved, inputArtifactRefs: inputs };
}

function withStep(run: Run, stepId: string, status: StepState["status"], at: string, attemptId?: string, receiptId?: string): Run {
  return {
    ...run, updatedAt: at,
    stepStates: run.stepStates.map((state) => state.stepId !== stepId ? state : {
      ...state, status,
      attemptIds: attemptId ? [...state.attemptIds, attemptId] : state.attemptIds,
      receiptIds: receiptId ? [...state.receiptIds, receiptId] : state.receiptIds,
    }),
  };
}

function replace(receipts: readonly ExecutionReceipt[], receipt: ExecutionReceipt): ExecutionReceipt[] {
  return receipts.map((item) => item.id === receipt.id ? receipt : item);
}

function checkBase(snapshot: PolicySnapshot): { allowed: true } | { allowed: false; status: 403 | 503; code: string } {
  if (!snapshot.principalActive) return { allowed: false, status: 403, code: "principal_revoked" };
  if (!snapshot.accessGate.allowed) return { allowed: false, status: 503, code: (snapshot.accessGate as any).code };
  const revokedAt = snapshot.grant?.revokedAt === null ? null : utcInstant(snapshot.grant?.revokedAt);
  if (!snapshot.grant || revokedAt === undefined || revokedAt !== null && revokedAt <= snapshot.now.getTime()) return { allowed: false, status: 403, code: "grant_revoked" };
  return { allowed: true };
}

function isTerminal(status: Run["status"]): boolean { return status === "succeeded" || status === "failed" || status === "cancelled"; }

function parseOrUndefined<T>(parser: (value: unknown) => T, value: unknown): T | undefined {
  if (value === undefined || value === null) return undefined;
  try { return parser(value); } catch { return undefined; }
}

function unrefTimer(ms: number, callback: () => void): () => void {
  const timer = setTimeout(callback, ms);
  timer.unref?.();
  return () => clearTimeout(timer);
}

function scheduledSleep(schedule: (ms: number, callback: () => void) => () => void): (ms: number, signal: AbortSignal) => Promise<void> {
  return (ms, signal) => new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const onAbort = () => { cancel(); reject(signal.reason); };
    const cancel = schedule(ms, () => { signal.removeEventListener("abort", onAbort); resolve(); });
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function abortableSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, ms);
    const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
    signal.addEventListener("abort", onAbort, { once: true });
  });

}
