/**
 * E2-13.E — durable short chains (cadeias curtas).
 *
 * A chain executes a preset DAG with stable node ids, bounded limits and a
 * persisted step ledger. Every step records principal, project, capability,
 * destination, effect, limits, deadline, result and receipts. All mutations
 * are committed to the AutomationService snapshot before the next effect.
 *
 * Durability contract:
 *  - `prepared` steps never left this process → interrupted steps settle
 *    `not_sent` on recovery and may retry within the attempt bound.
 *  - `dispatched` steps have unknown remote outcome → recovery settles the
 *    receipt as `unknown` and the chain needs_attention; never auto-replayed.
 *  - Resuming after restart re-drives only pending/failed steps; succeeded
 *    steps and their receipts are preserved and never re-executed.
 *  - Step effects are idempotent by a stable requestId derived from
 *    chain id + step id; the dispatcher owns provider-side deduplication.
 *  - Compensation runs only for succeeded write effects whose dispatcher
 *    declares a real inverse; absence is recorded, never invented.
 */
import { createHash, randomUUID } from "node:crypto";
import { AutomationError, isId, type Clock, SystemClock } from "./automation-types.ts";
import type { AutomationPreset, PresetEdge } from "./automation-presets.ts";
import { topologicalOrder } from "./automation-presets.ts";

export const CHAIN_LIMIT_BOUNDS = {
  maxSteps: 8,
  maxCalls: 16,
  maxOutputTokens: 4_096,
  maxOutputBytes: 1_048_576,
  timeoutMs: 300_000,
} as const;

export const CHAIN_MAX_ATTEMPTS_PER_STEP = 3;

export type ChainLimits = {
  maxCalls: number;
  maxOutputTokens: number;
  maxOutputBytes: number;
  timeoutMs: number;
};

export type ChainStepStatus = "pending" | "prepared" | "dispatched" | "succeeded" | "failed" | "unknown";
export type ChainStatus = "running" | "succeeded" | "failed" | "cancelled" | "needs_attention";
export type ChainReceiptStatus = "prepared" | "dispatched" | "succeeded" | "failed" | "unknown";

export type ChainStepSpec = {
  stepId: string;
  kind: "recipe" | "composition" | "channel_preview" | "channel_send" | "chat";
  ref: string;
  bindings?: Record<string, string>;
};

export type ChainStepReceipt = {
  id: string;
  attemptId: string;
  stepId: string;
  requestId: string;
  principalId: string;
  projectId: string;
  capabilityId: string;
  destination: { kind: string; id: string };
  effect: "read_external" | "produce_artifact" | "write_external" | "inference";
  status: ChainReceiptStatus;
  errorCode?: string;
  limits: ChainLimits;
  deadlineAt: string;
  startedAt?: string;
  finishedAt?: string;
  result?: string;
  effects: string[];
};

export type ChainStepRecord = ChainStepSpec & {
  status: ChainStepStatus;
  requestId: string;
  attemptIds: string[];
  receipts: ChainStepReceipt[];
  errorCode?: string;
  dispatchedAt?: string;
  finishedAt?: string;
};

export type ChainCompensationRecord = {
  id: string;
  stepId: string;
  requestId: string;
  status: "executing" | "executed" | "skipped_unavailable" | "failed";
  errorCode?: string;
  executedAt?: string;
};

export type ChainRun = {
  id: string;
  principalId: string;
  projectId: string;
  presetId: string;
  presetVersion: number;
  presetDigest: string;
  requestId: string;
  status: ChainStatus;
  steps: ChainStepRecord[];
  edges: PresetEdge[];
  compensations: ChainCompensationRecord[];
  limits: ChainLimits;
  createdAt: string;
  updatedAt: string;
  deadlineAt: string;
  errorCode?: string;
};

export type ChainStepInput = { stepId: string; effects: string[]; result?: string };

export type ChainEffectRequest = {
  chainId: string;
  stepId: string;
  requestId: string;
  attemptId: string;
  principalId: string;
  projectId: string;
  step: ChainStepSpec;
  inputs: ChainStepInput[];
  limits: ChainLimits;
  deadlineAt: string;
  signal: AbortSignal;
};

export type ChainEffectOutcome =
  | { kind: "completed"; effects: string[]; summary: string }
  | { kind: "not_sent"; code: string }
  | { kind: "failed"; code: string; sent: "yes" | "unknown" };

export interface ChainEffectDispatcher {
  dispatch(request: ChainEffectRequest): Promise<ChainEffectOutcome>;
  /** Real inverse of a completed write effect, if any. Absence → skip, never invent. */
  compensate?(request: {
    chainId: string;
    stepId: string;
    requestId: string;
    principalId: string;
    projectId: string;
    receipt: ChainStepReceipt;
    signal: AbortSignal;
  }): Promise<{ kind: "completed" } | { kind: "unavailable" } | { kind: "failed"; code: string }>;
}

/** Thrown by tests/fault hooks to simulate process death without settling state. */
export class ChainCrashError extends Error {
  constructor(reason = "chain_simulated_crash") {
    super(reason);
    this.name = "ChainCrashError";
  }
}

export type ChainFaultPhase = "after_prepare" | "after_dispatch" | "after_settle";
export type ChainFaultHook = (phase: ChainFaultPhase, chainId: string, stepId: string) => void;

export type ChainExecutorOptions = {
  clock?: Clock;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  retryBaseMs?: number;
  maxAttemptsPerStep?: number;
  fault?: ChainFaultHook;
  newId?: () => string;
};

const hash = (material: string): string => createHash("sha256").update(material).digest("hex");

function stepDescriptor(step: ChainStepSpec): Pick<ChainStepReceipt, "capabilityId" | "destination" | "effect"> {
  switch (step.kind) {
    case "channel_preview":
      return { capabilityId: `automation.channel.${step.ref}`, destination: { kind: "channel", id: step.ref }, effect: "read_external" };
    case "channel_send":
      return { capabilityId: `automation.channel.${step.ref}`, destination: { kind: "channel", id: step.ref }, effect: "write_external" };
    case "recipe":
      return { capabilityId: `automation.recipe.${step.ref}`, destination: { kind: "recipe", id: step.ref }, effect: "produce_artifact" };
    case "composition":
      return { capabilityId: `automation.composition.${step.ref}`, destination: { kind: "composition", id: step.ref }, effect: "produce_artifact" };
    case "chat":
      return { capabilityId: "automation.chat.local", destination: { kind: "chat", id: "local" }, effect: "inference" };
  }
}

function normalizeLimits(input: unknown): ChainLimits {
  const value = (input && typeof input === "object" ? input : {}) as Record<string, unknown>;
  const num = (key: string, fallback: number, max: number): number => {
    const raw = value[key];
    return typeof raw === "number" && Number.isSafeInteger(raw) && raw >= 1 && raw <= max ? raw : fallback;
  };
  return {
    maxCalls: num("maxCalls", CHAIN_LIMIT_BOUNDS.maxCalls, CHAIN_LIMIT_BOUNDS.maxCalls),
    maxOutputTokens: num("maxOutputTokens", CHAIN_LIMIT_BOUNDS.maxOutputTokens, CHAIN_LIMIT_BOUNDS.maxOutputTokens),
    maxOutputBytes: num("maxOutputBytes", CHAIN_LIMIT_BOUNDS.maxOutputBytes, CHAIN_LIMIT_BOUNDS.maxOutputBytes),
    timeoutMs: num("timeoutMs", CHAIN_LIMIT_BOUNDS.timeoutMs, CHAIN_LIMIT_BOUNDS.timeoutMs),
  };
}

export class AutomationChainStore {
  private runs = new Map<string, ChainRun>();
  private byRequest = new Map<string, string>();
  private seq = 0;
  private readonly clock: Clock;
  private readonly persist: () => void;

  constructor(clock: Clock, persist: () => void) {
    this.clock = clock;
    this.persist = persist;
  }

  private requestKey(principalId: string, projectId: string, requestId: string): string {
    return `${principalId}:${projectId}:${requestId}`;
  }

  create(input: {
    principalId: string;
    projectId: string;
    preset: AutomationPreset;
    requestId: string;
    stepSpecs: ChainStepSpec[];
    edges: PresetEdge[];
    limits: ChainLimits;
  }): ChainRun {
    const now = this.clock.now().toISOString();
    const id = `chain_${(++this.seq).toString(36)}`;
    const digest = hash(JSON.stringify({ id: input.preset.id, version: input.preset.version, steps: input.preset.steps, edges: input.preset.edges }));
    const steps: ChainStepRecord[] = input.stepSpecs.map((spec) => ({
      ...structuredClone(spec),
      status: "pending" as const,
      requestId: stepRequestId(id, spec.stepId),
      attemptIds: [],
      receipts: [],
    }));
    const run: ChainRun = {
      id,
      principalId: input.principalId,
      projectId: input.projectId,
      presetId: input.preset.id,
      presetVersion: input.preset.version,
      presetDigest: digest,
      requestId: input.requestId,
      status: "running",
      steps,
      edges: structuredClone(input.edges),
      compensations: [],
      limits: structuredClone(input.limits),
      createdAt: now,
      updatedAt: now,
      deadlineAt: new Date(this.clock.now().getTime() + input.limits.timeoutMs).toISOString(),
    };
    this.runs.set(id, run);
    this.byRequest.set(this.requestKey(input.principalId, input.projectId, input.requestId), id);
    this.persist();
    return structuredClone(run);
  }

  get(id: string): ChainRun | undefined {
    const run = this.runs.get(id);
    return run ? structuredClone(run) : undefined;
  }

  list(principalId: string, projectId: string): ChainRun[] {
    return [...this.runs.values()]
      .filter((run) => run.principalId === principalId && run.projectId === projectId)
      .map((run) => structuredClone(run));
  }

  listAll(): ChainRun[] {
    return [...this.runs.values()].map((run) => structuredClone(run));
  }

  findByRequest(principalId: string, projectId: string, requestId: string): ChainRun | undefined {
    const id = this.byRequest.get(this.requestKey(principalId, projectId, requestId));
    const run = id ? this.runs.get(id) : undefined;
    return run ? structuredClone(run) : undefined;
  }

  mutate(id: string, change: (run: ChainRun) => ChainRun | undefined): ChainRun | undefined {
    const run = this.runs.get(id);
    if (!run) return undefined;
    const next = change(structuredClone(run));
    if (!next) return undefined;
    next.updatedAt = this.clock.now().toISOString() > next.updatedAt ? this.clock.now().toISOString() : next.updatedAt;
    this.runs.set(id, next);
    this.persist();
    return structuredClone(next);
  }

  exportState(): Array<[string, ChainRun]> {
    return [...this.runs.entries()].map(([id, run]) => [id, structuredClone(run)]);
  }

  restoreState(rows: Array<[string, ChainRun]>, seq: number): void {
    this.runs = new Map(rows.map(([id, run]) => [id, structuredClone(run)]));
    this.byRequest = new Map(
      [...this.runs.values()].map((run) => [this.requestKey(run.principalId, run.projectId, run.requestId), run.id]),
    );
    this.seq = seq;
  }
}

function stepRequestId(chainId: string, stepId: string): string {
  return `cs_${hash(`${chainId}:${stepId}`).slice(0, 40)}`;
}

export class AutomationChainExecutor {
  private readonly store: AutomationChainStore;
  private readonly effects: ChainEffectDispatcher;
  private readonly clock: Clock;
  private readonly sleep: (ms: number, signal: AbortSignal) => Promise<void>;
  private readonly retryBaseMs: number;
  private readonly maxAttemptsPerStep: number;
  private readonly fault?: ChainFaultHook;
  private readonly newId: () => string;
  private readonly active = new Map<string, { controller: AbortController; done: Promise<void> }>();
  /** One compensation drive per chain in this process; recovery must not re-invoke an in-flight inverse. */
  private readonly compensating = new Set<string>();

  constructor(store: AutomationChainStore, effects: ChainEffectDispatcher, options: ChainExecutorOptions = {}) {
    this.store = store;
    this.effects = effects;
    this.clock = options.clock ?? new SystemClock();
    this.sleep = options.sleep ?? defaultChainSleep;
    this.retryBaseMs = options.retryBaseMs ?? 1_000;
    this.maxAttemptsPerStep = options.maxAttemptsPerStep ?? CHAIN_MAX_ATTEMPTS_PER_STEP;
    this.fault = options.fault;
    this.newId = options.newId ?? randomUUID;
  }

  private static throwIfInvalidIds(principalId: string, projectId: string): void {
    if (!isId(principalId) || !isId(projectId)) throw new AutomationError("principal_or_project_invalid");
  }

  /** Create (or return the existing run for the same requestId) and launch the drive. */
  start(principalId: string, projectId: string, preset: AutomationPreset, requestId?: string, input?: unknown): ChainRun {
    AutomationChainExecutor.throwIfInvalidIds(principalId, projectId);
    const requested = requestId ?? randomUUID();
    if (!isId(requested)) throw new AutomationError("chain_request_invalid");
    const existing = this.store.findByRequest(principalId, projectId, requested);
    if (existing) {
      if (existing.presetId !== preset.id || existing.presetVersion !== preset.version) {
        throw new AutomationError("chain_request_reused", 409);
      }
      if (existing.status === "running") this.launch(existing.id);
      return existing;
    }
    const order = topologicalOrder(preset);
    if (!order.length) throw new AutomationError("empty_steps");
    if (order.length > CHAIN_LIMIT_BOUNDS.maxSteps) throw new AutomationError("chain_too_many_steps", 409);
    const byId = new Map(preset.steps.map((step) => [step.id, step]));
    const limits = normalizeLimits(input);
    const specs: ChainStepSpec[] = order.map((stepId) => {
      const step = byId.get(stepId)!;
      return { stepId: step.id, kind: step.kind, ref: step.ref, ...(step.bindings ? { bindings: structuredClone(step.bindings) } : {}) };
    });
    const run = this.store.create({ principalId, projectId, preset, requestId: requested, stepSpecs: specs, edges: [...preset.edges], limits });
    this.launch(run.id);
    return this.store.get(run.id) ?? run;
  }

  launch(chainId: string): void {
    if (this.active.has(chainId)) return;
    const controller = new AbortController();
    const done = this.drive(chainId, controller.signal)
      .catch((error) => {
        if (error instanceof ChainCrashError) return;
        this.store.mutate(chainId, (run) => (run.status === "running" ? { ...run, status: "needs_attention", errorCode: "chain_driver_failure" } : undefined));
      })
      .finally(() => {
        this.active.delete(chainId);
      });
    this.active.set(chainId, { controller, done });
  }

  async settled(chainId: string): Promise<void> {
    await this.active.get(chainId)?.done;
  }

  abortAll(): void {
    for (const { controller } of this.active.values()) controller.abort(new Error("chain_executor_shutdown"));
  }

  private async drive(chainId: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const chain = this.store.get(chainId);
      if (!chain || chain.status !== "running") return;
      const index = chain.steps.findIndex((step) => step.status !== "succeeded");
      if (index === -1) {
        this.store.mutate(chainId, (run) => (run.status === "running" ? { ...run, status: "succeeded" } : undefined));
        return;
      }
      const step = chain.steps[index]!;
      const deadline = Date.parse(chain.deadlineAt);
      if (this.clock.now().getTime() >= deadline) {
        this.store.mutate(chainId, (run) => (run.status === "running" ? { ...run, status: "failed", errorCode: "chain_deadline_exceeded" } : undefined));
        return;
      }
      if (step.status === "prepared" || step.status === "dispatched") {
        this.reconcileInterrupted(chainId);
        continue;
      }
      if (step.status === "unknown") {
        this.store.mutate(chainId, (run) => (run.status === "running" ? { ...run, status: "needs_attention", errorCode: "chain_effect_uncertain" } : undefined));
        return;
      }
      if (step.status === "failed") {
        const last = step.receipts.at(-1);
        const retryable = !!last && last.status === "failed" && (last.errorCode?.startsWith("not_sent.") ?? false);
        if (!retryable || step.attemptIds.length >= this.maxAttemptsPerStep) {
          this.store.mutate(chainId, (run) => (run.status === "running" ? { ...run, status: "failed", errorCode: step.errorCode ?? "chain_step_failed" } : undefined));
          this.afterTerminal(chainId);
          return;
        }
        const reset = this.store.mutate(chainId, (run) => {
          const target = run.steps.find((candidate) => candidate.stepId === step.stepId && candidate.status === "failed");
          if (!target) return undefined;
          target.status = "pending";
          target.errorCode = undefined;
          return run;
        });
        if (!reset) continue;
        const backoff = this.retryBaseMs * 2 ** (step.attemptIds.length - 1);
        try {
          await this.sleep(backoff, signal);
        } catch {
          /* cancelamento reavaliado no próximo ciclo */
        }
        continue;
      }

      // pending → prepared → dispatched; both committed before the effect runs.
      const attemptId = this.newId();
      const receiptId = this.newId();
      const prepared = this.store.mutate(chainId, (run) => {
        if (run.status !== "running") return undefined;
        const target = run.steps.find((candidate) => candidate.stepId === step.stepId && candidate.status === "pending");
        if (!target) return undefined;
        const at = this.clock.now().toISOString();
        const descriptor = stepDescriptor(target);
        const receipt: ChainStepReceipt = {
          id: receiptId,
          attemptId,
          stepId: target.stepId,
          requestId: target.requestId,
          principalId: run.principalId,
          projectId: run.projectId,
          ...descriptor,
          status: "prepared",
          limits: structuredClone(run.limits),
          deadlineAt: run.deadlineAt,
          startedAt: at,
          effects: [],
        };
        target.status = "prepared";
        target.attemptIds = [...target.attemptIds, attemptId];
        target.receipts = [...target.receipts, receipt];
        return run;
      });
      if (!prepared) continue;
      this.fault?.("after_prepare", chainId, step.stepId);

      const dispatched = this.store.mutate(chainId, (run) => {
        if (run.status !== "running") return undefined;
        const target = run.steps.find((candidate) => candidate.stepId === step.stepId && candidate.status === "prepared");
        const receipt = target?.receipts.find((candidate) => candidate.id === receiptId);
        if (!target || !receipt || receipt.status !== "prepared") return undefined;
        const at = this.clock.now().toISOString();
        receipt.status = "dispatched";
        target.status = "dispatched";
        target.dispatchedAt = at;
        return run;
      });
      if (!dispatched || !dispatched.steps.find((candidate) => candidate.stepId === step.stepId)?.receipts.some((receipt) => receipt.id === receiptId && receipt.status === "dispatched")) continue;
      this.fault?.("after_dispatch", chainId, step.stepId);

      const current = this.store.get(chainId);
      const currentStep = current?.steps.find((candidate) => candidate.stepId === step.stepId);
      const inputs = this.resolveInputs(current!, currentStep!);
      const request: ChainEffectRequest = {
        chainId,
        stepId: step.stepId,
        requestId: currentStep!.requestId,
        attemptId,
        principalId: current!.principalId,
        projectId: current!.projectId,
        step: { stepId: currentStep!.stepId, kind: currentStep!.kind, ref: currentStep!.ref, ...(currentStep!.bindings ? { bindings: structuredClone(currentStep!.bindings) } : {}) },
        inputs,
        limits: structuredClone(current!.limits),
        deadlineAt: current!.deadlineAt,
        signal,
      };
      let outcome: ChainEffectOutcome;
      try {
        outcome = await this.effects.dispatch(request);
      } catch (error) {
        if (error instanceof ChainCrashError) throw error;
        outcome = signal.aborted ? { kind: "failed", code: "aborted", sent: "unknown" } : { kind: "failed", code: "chain_effect_exception", sent: "unknown" };
      }
      if (signal.aborted && outcome.kind === "failed") outcome = { ...outcome, code: "aborted" };
      // Cancel race: only settle when the step is still dispatched on a running chain.
      const settled = this.store.mutate(chainId, (run) => {
        if (run.status !== "running") return undefined;
        const target = run.steps.find((candidate) => candidate.stepId === step.stepId);
        const receipt = target?.receipts.find((candidate) => candidate.id === receiptId);
        if (!target || !receipt || receipt.status !== "dispatched") return undefined;
        const at = this.clock.now().toISOString();
        receipt.finishedAt = at;
        target.finishedAt = at;
        if (outcome.kind === "completed") {
          receipt.status = "succeeded";
          receipt.result = outcome.summary;
          receipt.effects = [...outcome.effects];
          target.status = "succeeded";
        } else if (outcome.kind === "not_sent") {
          receipt.status = "failed";
          receipt.errorCode = `not_sent.${outcome.code}`;
          target.status = "failed";
          target.errorCode = receipt.errorCode;
        } else {
          receipt.status = outcome.sent === "yes" ? "failed" : "unknown";
          receipt.errorCode = outcome.code;
          target.status = outcome.sent === "yes" ? "failed" : "unknown";
          target.errorCode = outcome.code;
        }
        return run;
      });
      if (!settled) continue;
      this.fault?.("after_settle", chainId, step.stepId);
    }
  }

  private resolveInputs(chain: ChainRun, step: ChainStepRecord): ChainStepInput[] {
    const byStepId = new Map(chain.steps.map((candidate) => [candidate.stepId, candidate]));
    const predecessors = chain.edges.length
      ? chain.edges.filter((edge) => edge.to === step.stepId).map((edge) => edge.from)
      : chain.steps.filter((candidate) => chain.steps.indexOf(candidate) < chain.steps.indexOf(step)).map((candidate) => candidate.stepId);
    const inputs: ChainStepInput[] = [];
    for (const stepId of predecessors) {
      const source = byStepId.get(stepId);
      const succeeded = source?.receipts.find((receipt) => receipt.status === "succeeded");
      if (source?.status === "succeeded" && succeeded) {
        inputs.push({ stepId, effects: [...succeeded.effects], result: succeeded.result });
      }
    }
    return inputs;
  }

  cancel(principalId: string, projectId: string, chainId: string): ChainRun {
    AutomationChainExecutor.throwIfInvalidIds(principalId, projectId);
    const chain = this.store.get(chainId);
    if (!chain || chain.principalId !== principalId || chain.projectId !== projectId) throw new AutomationError("chain_missing", 404);
    if (chain.status !== "running") return chain;
    this.active.get(chainId)?.controller.abort(new Error("chain_cancelled"));
    const at = this.clock.now().toISOString();
    this.store.mutate(chainId, (run) => {
      const steps = run.steps.map((step) => {
        if (step.status === "dispatched") {
          const receipt = step.receipts.at(-1);
          if (receipt && receipt.status === "dispatched") {
            receipt.status = "unknown";
            receipt.errorCode = "cancelled";
            receipt.finishedAt = at;
          }
          return { ...step, status: "unknown" as const, errorCode: "cancelled" };
        }
        if (step.status === "prepared") {
          const receipt = step.receipts.at(-1);
          if (receipt && receipt.status === "prepared") {
            receipt.status = "failed";
            receipt.errorCode = "not_sent.cancelled";
            receipt.finishedAt = at;
          }
          return { ...step, status: "failed" as const, errorCode: "not_sent.cancelled" };
        }
        return step;
      });
      return { ...run, steps, status: "cancelled", updatedAt: at };
    });
    void this.runCompensations(chainId);
    return this.store.get(chainId)!;
  }

  resolve(principalId: string, projectId: string, chainId: string, action: "keep_stopped" | "retry"): ChainRun {
    AutomationChainExecutor.throwIfInvalidIds(principalId, projectId);
    const chain = this.store.get(chainId);
    if (!chain || chain.principalId !== principalId || chain.projectId !== projectId) throw new AutomationError("chain_missing", 404);
    if (chain.status !== "needs_attention") throw new AutomationError("chain_not_in_attention", 409);
    if (action === "keep_stopped") {
      this.store.mutate(chainId, (run) => ({ ...run, status: "failed", errorCode: "chain_attention_resolved" }));
      this.afterTerminal(chainId);
      return this.store.get(chainId)!;
    }
    this.store.mutate(chainId, (run) => {
      const steps = run.steps.map((step) => (step.status === "unknown" ? { ...step, status: "pending" as const, errorCode: undefined } : step));
      return { ...run, steps, status: "running", errorCode: undefined };
    });
    this.launch(chainId);
    return this.store.get(chainId)!;
  }

  /** Sync boot reconciliation (no drives launched); dispatched stays unknown. */
  reconcileForBoot(): number {
    let changed = 0;
    for (const run of this.store.listAll()) {
      if (run.status === "running" && this.reconcileInterrupted(run.id)) changed += 1;
    }
    return changed;
  }

  /** Recovery on boot: interrupted steps reconciled; pending work resumed; compensation completed. */
  async recoverAll(): Promise<{ reconciled: number; resumed: number }> {
    let reconciled = 0;
    let resumed = 0;
    for (const run of this.store.listAll()) {
      if (run.status === "running" || run.status === "needs_attention") {
        if (run.status === "running" && this.reconcileInterrupted(run.id)) reconciled += 1;
        if (this.store.get(run.id)?.status === "running") {
          if (!this.active.has(run.id)) this.launch(run.id);
          resumed += 1;
        }
      }
      if (run.status !== "running" && run.compensations.some((record) => record.status === "executing")) {
        void this.runCompensations(run.id);
      }
    }
    return { reconciled, resumed };
  }

  /** Sync reconciliation: prepared → not_sent (safe retry), dispatched → unknown (needs_attention). */
  private reconcileInterrupted(chainId: string): boolean {
    let changed = false;
    this.store.mutate(chainId, (run) => {
      const at = this.clock.now().toISOString();
      const steps = run.steps.map((step) => {
        if (step.status === "prepared") {
          const receipt = step.receipts.at(-1);
          if (receipt && receipt.status === "prepared") {
            receipt.status = "failed";
            receipt.errorCode = "not_sent.interrupted";
            receipt.finishedAt = at;
          }
          changed = true;
          return { ...step, status: "failed" as const, errorCode: "not_sent.interrupted" };
        }
        if (step.status === "dispatched") {
          const receipt = step.receipts.at(-1);
          if (receipt && receipt.status === "dispatched") {
            receipt.status = "unknown";
            receipt.errorCode = "interrupted_after_dispatch";
            receipt.finishedAt = at;
          }
          changed = true;
          return { ...step, status: "unknown" as const, errorCode: "interrupted_after_dispatch" };
        }
        return step;
      });
      const hasUnknown = steps.some((step) => step.status === "unknown");
      if (!changed && !hasUnknown) return undefined;
      return { ...run, steps, status: hasUnknown ? "needs_attention" : run.status };
    });
    return changed;
  }

  private afterTerminal(chainId: string): void {
    void this.runCompensations(chainId);
  }

  private async runCompensations(chainId: string): Promise<void> {
    if (this.compensating.has(chainId)) return;
    this.compensating.add(chainId);
    try {
      await this.driveCompensations(chainId);
    } finally {
      this.compensating.delete(chainId);
    }
  }

  private async driveCompensations(chainId: string): Promise<void> {
    for (;;) {
      const chain = this.store.get(chainId);
      if (!chain || chain.status === "running" || chain.status === "succeeded") return;
      const target = chain.steps.find((step) => {
        if (step.status !== "succeeded") return false;
        if (stepDescriptor(step).effect !== "write_external") return false;
        const record = chain.compensations.find((candidate) => candidate.stepId === step.stepId);
        return !record || record.status === "executing";
      });
      if (!target) return;
      const succeededReceipt = target.receipts.find((receipt) => receipt.status === "succeeded");
      if (!succeededReceipt) return;
      const existing = chain.compensations.find((candidate) => candidate.stepId === target.stepId);
      if (!existing) {
        this.store.mutate(chainId, (run) => ({
          ...run,
          compensations: [
            ...run.compensations,
            { id: `comp_${(run.compensations.length + 1).toString(36)}`, stepId: target.stepId, requestId: `comp_${target.requestId}`, status: "executing" },
          ],
        }));
        continue;
      }
      if (!this.effects.compensate) {
        this.store.mutate(chainId, (run) => {
          const record = run.compensations.find((candidate) => candidate.stepId === target.stepId);
          if (record) {
            record.status = "skipped_unavailable";
            record.executedAt = this.clock.now().toISOString();
          }
          return run;
        });
        continue;
      }
      let outcome: { kind: "completed" } | { kind: "unavailable" } | { kind: "failed"; code: string };
      try {
        outcome = await this.effects.compensate({
          chainId,
          stepId: target.stepId,
          requestId: existing.requestId,
          principalId: chain.principalId,
          projectId: chain.projectId,
          receipt: succeededReceipt,
          signal: new AbortController().signal,
        });
      } catch {
        outcome = { kind: "failed", code: "compensation_exception" };
      }
      this.store.mutate(chainId, (run) => {
        const record = run.compensations.find((candidate) => candidate.stepId === target.stepId);
        if (record) {
          record.status = outcome.kind === "completed" ? "executed" : outcome.kind === "unavailable" ? "skipped_unavailable" : "failed";
          record.errorCode = outcome.kind === "failed" ? outcome.code : undefined;
          record.executedAt = this.clock.now().toISOString();
        }
        return run;
      });
    }
  }
}

function defaultChainSleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason);
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    timer.unref?.();
    const onAbort = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
