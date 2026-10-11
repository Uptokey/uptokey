/**
 * E2-22 — Production metrics project canonical W5 comparison runs.
 * Legacy synthetic evaluation helpers remain available only to isolated tests.
 * Inference execution and consent belong to the existing multimodel service.
 * Probe latency is NEVER labeled as generation speed.
 */

import { createHash, randomUUID } from "node:crypto";
import {parseMultiModelPlan,parseMultimodelRun,type MultiModelPlan,type MultimodelRun} from '@uptokey/sync-contract/multimodel';

/** Read-only projection of the canonical, durable W5 journal. Never dispatches inference. */
export function projectMultimodelBenchmark(planInput:MultiModelPlan,runInput:MultimodelRun):{run:BenchmarkRun;observations:Observation[]}{
  const plan=parseMultiModelPlan(planInput),run=parseMultimodelRun(runInput);
  if(plan.id!==run.planId||plan.digest!==run.planDigest||plan.projectId!==run.projectId||plan.principalId!==run.principalId)throw new BenchmarkError('benchmark_scope_denied');
  if(plan.mode!=='compare')throw new BenchmarkError('benchmark_incompatible','comparison plan required');
  const datasetHash=createHash('sha256').update(JSON.stringify([plan.contextSnapshotId,plan.members.map(m=>m.task)])).digest('hex');
  const observations:Observation[]=[],modelRefs:ModelRef[]=[],states:Record<string,string>={};
  for(const branch of run.branches){
    const member=plan.members.find(m=>m.id===branch.memberId);
    if(!member||branch.runId!==run.id)throw new BenchmarkError('benchmark_incompatible');
    // A connection can change provider later; do not rewrite the historical provider from live configuration.
    const modelRef:ModelRef={providerId:'unrecorded',modelId:branch.actualModel,accountRef:member.connectionId};modelRefs.push(modelRef);states[member.id]=branch.status;
    const numeric=(value:unknown)=>typeof value==='number'&&Number.isFinite(value)&&value>=0?value:null;
    const completed=branch.completedAt!==null,success=branch.status==='succeeded';
    const duration=completed&&branch.startedAt?numeric(Date.parse(branch.completedAt!)-Date.parse(branch.startedAt)):null;
    const providerUsage=branch.usage?.basis==='provider_reported';
    const cost=branch.cost&&/^\d+$/.test(branch.cost.micros)&&BigInt(branch.cost.micros)<=BigInt(Number.MAX_SAFE_INTEGER)?Number(branch.cost.micros):null;
    const metrics:[string,number|null,string,string][]=[
      ['execution_duration_ms',duration,'ms','local_journal_elapsed'],
      ['input_tokens',success&&providerUsage?numeric(branch.usage?.inputTokens):null,'tokens','provider_reported'],
      ['output_tokens',success&&providerUsage?numeric(branch.usage?.outputTokens):null,'tokens','provider_reported'],
      ['reference_cost_micros',cost,'micro-USD','public_tariff_estimate'],
      ['completed_successfully',completed?(success?1:0):null,'boolean','journal_status'],
    ];
    for(const [metric,value,unit,method] of metrics)observations.push({
      id:`bm_${createHash('sha256').update(`${run.id}:${member.id}:${metric}`).digest('hex').slice(0,32)}`,
      kind:'active',modelRef,metric,value,unit,measuredAt:branch.completedAt??run.updatedAt,runRef:run.id,
      sourceRef:`multimodel:${run.id}:${member.id}`,status:branch.status,method,
      window:{datasetHash,planId:plan.id,planDigest:plan.digest,contextSnapshotId:plan.contextSnapshotId,attemptIds:[...branch.attemptIds],artifactRefs:[...branch.artifactRefs]},
    });
  }
  const costs=run.branches.map(b=>b.cost&&/^\d+$/.test(b.cost.micros)?BigInt(b.cost.micros):null);
  const total=costs.length===plan.members.length&&costs.every(c=>c!==null)?costs.reduce<bigint>((sum,c)=>sum+c!,0n):null;
  const knownTotal=total!==null&&total<=BigInt(Number.MAX_SAFE_INTEGER)?Number(total):null;
  return {run:{id:run.id,definitionId:plan.id,definitionVersion:plan.digest,modelRefs,completedCases:run.branches.filter(b=>b.completedAt!==null).length,total:plan.members.length,perCaseState:states,costKnown:knownTotal===null?'unknown':'estimated',costMicros:knownTotal,status:run.status==='succeeded'?'completed':run.status==='cancelled'?'cancelled':run.status==='running'?'running':run.status==='draft'?'queued':'failed',childIds:run.branches.flatMap(b=>b.attemptIds)},observations};
}

export type ObservationKind = "probe" | "passive" | "active" | "external";
export type CostKnown = "known" | "estimated" | "unknown";
export type ToolSupport = boolean | "unknown";
export type ConnectionState =
  | "connected"
  | "disconnected"
  | "unknown"
  | "configured"
  | "unavailable";

export class BenchmarkError extends Error {
  readonly code: string;
  constructor(code: string, message?: string) {
    super(message ?? code);
    this.code = code;
    this.name = "BenchmarkError";
  }
}

export interface ModelRef {
  readonly providerId: string;
  readonly modelId: string;
  readonly revision?: string | null;
  readonly accountRef?: string | null;
}

export interface ModelCard {
  readonly providerId: string;
  readonly modelId: string;
  readonly revision: string | null;
  readonly modalities: readonly string[];
  readonly contextLimit: number | null;
  readonly toolSupport: ToolSupport;
  readonly connectionState: ConnectionState;
  readonly source: string;
  readonly observedAt: string;
}

export interface CatalogEntryLike {
  readonly id?: string;
  readonly displayName?: string;
  readonly models?: readonly string[];
  readonly capabilities?: readonly string[];
  readonly executable?: boolean;
  readonly supportLevel?: string;
}

export interface ObservedConnectionLike {
  readonly providerId: string;
  readonly available?: boolean;
  readonly reason?: string | null;
  readonly observedAt?: string;
  readonly effectiveModels?: readonly string[];
}

export interface BenchmarkDefinition {
  readonly id: string;
  readonly version: string;
  readonly datasetHash: string;
  readonly caseRefs: readonly string[];
  readonly rubric: { readonly version: string; readonly [k: string]: unknown };
  readonly sampleCount: number;
  readonly parameters: Readonly<Record<string, unknown>>;
  readonly budget: Readonly<{ maxCostMicros?: number; maxTokens?: number }>;
  readonly deadline: string;
  readonly privacyScope: string;
}

export interface Observation {
  readonly id: string;
  readonly kind: ObservationKind;
  readonly modelRef: ModelRef;
  readonly metric: string;
  readonly value: number | null;
  readonly unit: string;
  readonly measuredAt: string;
  readonly window?: Readonly<Record<string, unknown>>;
  readonly runRef?: string;
  readonly sourceRef?: string;
  readonly status: string;
  readonly license?: string;
  readonly method?: string;
  readonly sourceDate?: string;
  readonly stale?: boolean;
}

export interface BenchmarkRun {
  readonly id: string;
  readonly definitionVersion: string;
  readonly definitionId: string;
  readonly modelRefs: readonly ModelRef[];
  readonly completedCases: number;
  readonly total: number;
  readonly perCaseState: Readonly<Record<string, string>>;
  readonly costKnown: CostKnown;
  readonly costMicros: number | null;
  readonly cancelledAt?: string;
  readonly status: "queued" | "running" | "completed" | "cancelled" | "budget_exceeded" | "failed";
  readonly childIds: readonly string[];
  readonly judge?: { readonly evaluator: string; readonly rubricVersion: string; readonly evidence: boolean };
}

export interface RankingView {
  readonly id: string;
  readonly filter: Readonly<Record<string, unknown>>;
  readonly metric: string;
  readonly weights?: Readonly<Record<string, number>>;
  readonly cohort: string;
  readonly method: string;
  readonly sampleCount: number;
  readonly sourceDate: string;
  readonly exclusions: readonly string[];
  readonly rows: readonly RankingRow[];
}

export interface RankingRow {
  readonly modelRef: ModelRef;
  readonly score: number | null;
  readonly sampleCount: number;
  readonly excludedReason?: string;
  readonly source?: string;
  readonly method?: string;
  readonly sourceDate?: string;
}

export interface SyntheticCase {
  readonly id: string;
  readonly prompt: string;
  readonly expectedHint?: string;
}

const MAX_COMPARE = 4;
const MAX_CASES_FIRST = 20;

function freeze<T extends object>(v: T): Readonly<T> {
  return Object.freeze(v);
}

function isoNow(): string {
  return new Date().toISOString();
}

function stableVersion(baseId: string, parameters: Record<string, unknown>, datasetHash: string): string {
  const payload = JSON.stringify({
    baseId,
    parameters: Object.fromEntries(Object.keys(parameters).sort().map((k) => [k, parameters[k]])),
    datasetHash,
  });
  const h = createHash("sha256").update(payload).digest("hex").slice(0, 12);
  return `${baseId}@${h}`;
}

/** Project ModelCards from catalog entries + connection state (read-only). */
export function projectModelCards(
  entries: readonly CatalogEntryLike[],
  observed: readonly ObservedConnectionLike[] = [],
  observedAt: string = isoNow(),
): ModelCard[] {
  const byProvider = new Map(observed.map((o) => [o.providerId, o]));
  const cards: ModelCard[] = [];
  for (const entry of entries) {
    const providerId = entry.id ?? "unknown";
    const obs = byProvider.get(providerId);
    const models = entry.models?.length ? entry.models : obs?.effectiveModels ?? [];
    const modalities = (entry.capabilities ?? []).filter((c) =>
      ["text", "image", "audio", "video", "tools"].includes(c),
    );
    for (const modelId of models.length ? models : ["(undeclared)"]) {
      let toolSupport: ToolSupport = "unknown";
      if (entry.capabilities?.includes("tools")) toolSupport = true;
      else if (entry.capabilities && entry.capabilities.length > 0 && !entry.capabilities.includes("tools")) {
        // Declared caps without tools → still unknown unless explicitly denied
        toolSupport = "unknown";
      }
      const connectionState: ConnectionState = !obs
        ? "unknown"
        : obs.available === true
          ? "connected"
          : obs.available === false
            ? "unavailable"
            : "unknown";
      cards.push(
        freeze({
          providerId,
          modelId,
          revision: null,
          modalities: modalities.length ? modalities : ["unknown"],
          contextLimit: null,
          toolSupport,
          connectionState,
          source: "catalog-projection",
          observedAt: obs?.observedAt ?? observedAt,
        }),
      );
    }
  }
  return cards;
}

/**
 * In-memory + optional persist hook for immutable Observation / BenchmarkRun / RankingView.
 */
export interface PreparedBenchmarkEval {
  readonly prepareId: string;
  readonly definition: BenchmarkDefinition;
  readonly modelRefs: readonly ModelRef[];
  readonly cases: readonly SyntheticCase[];
  readonly preparedAt: string;
  readonly autoStarted: false;
}

export class BenchmarkStore {
  /** AC08: bind store to authenticated principal; other principals cannot read private runs. */
  bindPrincipal(principalId: string) {
    this.principalId = principalId;
  }
  assertPrincipalScope(principalId: string) {
    if (this.principalId && this.principalId !== principalId) {
      throw new BenchmarkError('benchmark_scope_denied');
    }
  }
  /** AC09: mark a case as rate-limited partial — counts in denominator, identifiable. */
  markRateLimitedPartial(runId: string, caseId: string, modelRefKey: string) {
    const run = this.runs.get(runId);
    if (!run) throw new BenchmarkError('benchmark_run_missing');
    const key = `${caseId}::${modelRefKey}`;
    const state = { ...(run.perCaseState as any) };
    state[key] = { ...(state[key] ?? {}), status: 'rate_limited_partial', partial: true };
    const next = { ...run, perCaseState: state, completedCases: run.completedCases };
    this.runs.set(runId, Object.freeze(next) as any);
    return next;
  }

  private principalId: string | null = null;

  private readonly observations = new Map<string, Observation>();
  private readonly runs = new Map<string, BenchmarkRun>();
  private readonly rankings = new Map<string, RankingView>();
  private readonly definitions = new Map<string, BenchmarkDefinition>();
  private readonly prepared = new Map<string, PreparedBenchmarkEval>();
  private activeStarts = 0;
  private persistHook: ((kind: string, id: string) => void) | null = null;

  onPersist(hook: (kind: string, id: string) => void): void {
    this.persistHook = hook;
  }

  getActiveStartCount(): number {
    return this.activeStarts;
  }

  putDefinition(def: BenchmarkDefinition): BenchmarkDefinition {
    const version = def.version || stableVersion(def.id, { ...def.parameters }, def.datasetHash);
    if (def.caseRefs.length > MAX_CASES_FIRST) {
      throw new BenchmarkError("benchmark_incompatible", "max 20 cases on first run");
    }
    const budgetOk =
      (typeof def.budget.maxCostMicros === "number" && Number.isFinite(def.budget.maxCostMicros) && def.budget.maxCostMicros > 0) ||
      (typeof def.budget.maxTokens === "number" && Number.isFinite(def.budget.maxTokens) && def.budget.maxTokens > 0);
    if (!budgetOk) throw new BenchmarkError("benchmark_incompatible", "finite budget required");
    if (!def.deadline || !Number.isFinite(Date.parse(def.deadline))) {
      throw new BenchmarkError("benchmark_incompatible", "finite deadline required");
    }
    const stored = freeze({ ...def, version });
    this.definitions.set(`${stored.id}:${stored.version}`, stored);
    this.persistHook?.("definition", `${stored.id}:${stored.version}`);
    return stored;
  }

  /** Parameter change → new definition version (never mutate prior). */
  reviseDefinition(prev: BenchmarkDefinition, parameters: Record<string, unknown>): BenchmarkDefinition {
    const version = stableVersion(prev.id, parameters, prev.datasetHash);
    return this.putDefinition(
      freeze({
        ...prev,
        version,
        parameters: freeze({ ...parameters }),
      }),
    );
  }

  putObservation(input: Omit<Observation, "id"> & { id?: string }): Observation {
    if (input.kind === "probe") {
      if (
        input.metric !== "endpoint_latency_ms" &&
        input.metric !== "availability" &&
        !input.metric.startsWith("probe_")
      ) {
        throw new BenchmarkError("benchmark_incompatible", "probe must not use generation metrics");
      }
    }
    // Never store absence as zero: allow null
    const obs = freeze({
      id: input.id ?? `obs_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
      kind: input.kind,
      modelRef: freeze({ ...input.modelRef }),
      metric: input.metric,
      value: input.value === undefined ? null : input.value,
      unit: input.unit,
      measuredAt: input.measuredAt,
      ...(input.window ? { window: freeze({ ...input.window }) } : {}),
      ...(input.runRef ? { runRef: input.runRef } : {}),
      ...(input.sourceRef ? { sourceRef: input.sourceRef } : {}),
      status: input.status,
      ...(input.license ? { license: input.license } : {}),
      ...(input.method ? { method: input.method } : {}),
      ...(input.sourceDate ? { sourceDate: input.sourceDate } : {}),
      ...(input.stale !== undefined ? { stale: input.stale } : {}),
    }) as Observation;
    this.observations.set(obs.id, obs);
    this.persistHook?.("observation", obs.id);
    return obs;
  }

  /**
   * External snapshot: source_unavailable keeps snapshot marked stale, never show 0 as new result.
   */
  putExternalSnapshot(input: {
    modelRef: ModelRef;
    metric: string;
    value: number | null;
    unit: string;
    sourceRef: string;
    license: string;
    method: string;
    sourceDate: string;
    sourceAvailable: boolean;
  }): Observation {
    if (!input.sourceAvailable) {
      return this.putObservation({
        kind: "external",
        modelRef: input.modelRef,
        metric: input.metric,
        value: input.value, // keep prior snapshot value; do not invent 0
        unit: input.unit,
        measuredAt: isoNow(),
        sourceRef: input.sourceRef,
        status: "source_unavailable",
        license: input.license,
        method: input.method,
        sourceDate: input.sourceDate,
        stale: true,
      });
    }
    return this.putObservation({
      kind: "external",
      modelRef: input.modelRef,
      metric: input.metric,
      value: input.value,
      unit: input.unit,
      measuredAt: isoNow(),
      sourceRef: input.sourceRef,
      status: "ok",
      license: input.license,
      method: input.method,
      sourceDate: input.sourceDate,
      stale: false,
    });
  }

  listObservations(filter?: { kind?: ObservationKind; modelId?: string }): Observation[] {
    return [...this.observations.values()].filter((o) => {
      if (filter?.kind && o.kind !== filter.kind) return false;
      if (filter?.modelId && o.modelRef.modelId !== filter.modelId) return false;
      return true;
    });
  }

  getObservation(id: string): Observation | undefined {
    return this.observations.get(id);
  }

  listRuns(): BenchmarkRun[] {
    return [...this.runs.values()];
  }

  listRankings(): RankingView[] {
    if (this.rankings.size > 0) {
      return [...this.rankings.values()];
    }
    const obs = this.listObservations().filter((o) => o.value !== null && !o.stale);
    if (obs.length > 0) {
      const metric = obs[0]!.metric;
      try {
        const computed = this.buildRanking({
          cohort: "observed_cohort",
          metric,
          method: "mean",
          filter: {},
        });
        return [computed];
      } catch {
        return [];
      }
    }
    return [];
  }

  listDefinitions(): BenchmarkDefinition[] {
    return [...this.definitions.values()];
  }

  getPrepared(prepareId: string): PreparedBenchmarkEval | undefined {
    return this.prepared.get(prepareId);
  }

  listPrepared(): PreparedBenchmarkEval[] {
    return [...this.prepared.values()];
  }

  /**
   * Prepare active eval — validates + stages only. NEVER starts.
   * Pair with startPreparedEval / startActiveEval via explicit POST.
   */
  prepareActiveEval(input: {
    definition: BenchmarkDefinition;
    modelRefs: readonly ModelRef[];
    cases: readonly SyntheticCase[];
    paidProviderAllowed?: boolean;
  }): PreparedBenchmarkEval {
    if (input.paidProviderAllowed) {
      throw new BenchmarkError("benchmark_incompatible", "paid providers disabled in this window");
    }
    if (input.modelRefs.length < 1 || input.modelRefs.length > MAX_COMPARE) {
      throw new BenchmarkError("benchmark_incompatible", "1..4 models per comparison");
    }
    const def = this.putDefinition(input.definition);
    if (Date.parse(def.deadline) < Date.now()) {
      throw new BenchmarkError("benchmark_incompatible", "deadline passed");
    }
    const cases = input.cases.slice(0, MAX_CASES_FIRST);
    if (cases.length < 1) throw new BenchmarkError("insufficient_samples");
    const prepareId = `prep_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const prepared = freeze({
      prepareId,
      definition: def,
      modelRefs: input.modelRefs.map((m) => freeze({ ...m })),
      cases: cases.map((c) => freeze({ ...c })),
      preparedAt: isoNow(),
      autoStarted: false as const,
    });
    this.prepared.set(prepareId, prepared);
    this.persistHook?.("prepare", prepareId);
    return prepared;
  }

  /** Dispatch a previously prepared eval (fixture-only). */
  startPreparedEval(prepareId: string): BenchmarkRun {
    const prepared = this.prepared.get(prepareId);
    if (!prepared) throw new BenchmarkError("benchmark_incompatible", "prepare not found");
    this.prepared.delete(prepareId);
    return this.startActiveEval({
      definition: prepared.definition,
      modelRefs: prepared.modelRefs,
      cases: prepared.cases,
      paidProviderAllowed: false,
    });
  }

  /**
   * Start active eval — EXPLICIT only. Fixture/synthetic cases; no paid providers.
   * Does NOT auto-start on open/filter/select (callers must invoke this).
   */
  startActiveEval(input: {
    definition: BenchmarkDefinition;
    modelRefs: readonly ModelRef[];
    cases: readonly SyntheticCase[];
    paidProviderAllowed?: boolean;
  }): BenchmarkRun {
    if (input.paidProviderAllowed) {
      throw new BenchmarkError("benchmark_incompatible", "paid providers disabled in this window");
    }
    if (input.modelRefs.length < 1 || input.modelRefs.length > MAX_COMPARE) {
      throw new BenchmarkError("benchmark_incompatible", "1..4 models per comparison");
    }
    const def = this.putDefinition(input.definition);
    if (Date.parse(def.deadline) < Date.now()) {
      throw new BenchmarkError("benchmark_incompatible", "deadline passed");
    }
    const cases = input.cases.slice(0, MAX_CASES_FIRST);
    if (cases.length < 1) throw new BenchmarkError("insufficient_samples");

    this.activeStarts += 1;
    const id = `run_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const childIds: string[] = [];
    const perCaseState: Record<string, string> = {};
    let completed = 0;
    let costMicros = 0;
    const maxCost = def.budget.maxCostMicros ?? Number.POSITIVE_INFINITY;

    for (const model of input.modelRefs) {
      for (const c of cases) {
        const childId = `${id}:${model.providerId}:${model.modelId}:${c.id}`;
        childIds.push(childId);
        // Synthetic fixture scoring — deterministic, no network
        const syntheticCost = 1;
        if (costMicros + syntheticCost > maxCost) {
          perCaseState[childId] = "budget_exceeded";
          // Ceiling: mark remaining children as skipped_budget; do not continue spending.
          for (const model2 of input.modelRefs) {
            for (const c2 of cases) {
              const cid = `${id}:${model2.providerId}:${model2.modelId}:${c2.id}`;
              if (!(cid in perCaseState)) perCaseState[cid] = "skipped_budget";
              if (!childIds.includes(cid)) childIds.push(cid);
            }
          }
          const run = freeze({
            id,
            definitionVersion: def.version,
            definitionId: def.id,
            modelRefs: input.modelRefs.map((m) => freeze({ ...m })),
            completedCases: completed,
            total: input.modelRefs.length * cases.length,
            perCaseState: freeze({ ...perCaseState }),
            costKnown: "estimated" as const,
            costMicros,
            status: "budget_exceeded" as const,
            childIds: freeze([...childIds]),
          });
          this.runs.set(id, run);
          this.persistHook?.("run", id);
          return run;
        }
        costMicros += syntheticCost;
        // Fixture: score by prompt length parity (deterministic)
        const score = (c.prompt.length + model.modelId.length) % 100;
        this.putObservation({
          kind: "active",
          modelRef: model,
          metric: "fixture_score",
          value: score,
          unit: "score",
          measuredAt: isoNow(),
          runRef: id,
          status: "ok",
          method: "synthetic_fixture",
        });
        perCaseState[childId] = "completed";
        completed += 1;
      }
    }

    const run = freeze({
      id,
      definitionVersion: def.version,
      definitionId: def.id,
      modelRefs: input.modelRefs.map((m) => freeze({ ...m })),
      completedCases: completed,
      total: input.modelRefs.length * cases.length,
      perCaseState: freeze({ ...perCaseState }),
      costKnown: "estimated" as const,
      costMicros,
      status: "completed" as const,
      childIds: freeze([...childIds]),
    });
    this.runs.set(id, run);
    this.persistHook?.("run", id);
    try {
      const ranking = this.buildRanking({
        cohort: `run_${id}`,
        metric: "fixture_score",
        method: "mean",
        filter: { runRef: id },
      });
      this.rankings.set(ranking.id, ranking);
    } catch { /* ranking build optional */ }
    return run;
  }

  /** Cancel ends children; subsequent reload observes only. */
  cancelRun(runId: string): BenchmarkRun {
    const run = this.runs.get(runId);
    if (!run) throw new BenchmarkError("benchmark_incompatible", "run not found");
    if (run.cancelledAt) return run;
    const perCaseState: Record<string, string> = { ...run.perCaseState };
    for (const child of run.childIds) {
      if (perCaseState[child] !== "completed") perCaseState[child] = "cancelled";
    }
    const next = freeze({
      ...run,
      perCaseState: freeze(perCaseState),
      cancelledAt: isoNow(),
      status: "cancelled" as const,
    });
    this.runs.set(runId, next);
    this.persistHook?.("run", runId);
    return next;
  }

  /** Reload observes only — does not restart. */
  reloadRun(runId: string): BenchmarkRun | undefined {
    return this.runs.get(runId);
  }

  getRun(runId: string): BenchmarkRun | undefined {
    return this.runs.get(runId);
  }

  /**
   * Build ranking from observations. Never ranks absence as zero.
   * Never sums distinct datasets.
   */
  buildRanking(input: {
    filter: Record<string, unknown>;
    metric: string;
    cohort: string;
    method: "mean" | "median" | "count";
    datasetHash?: string;
    weights?: Record<string, number>;
    sourceDate?: string;
  }): RankingView {
    if (input.cohort === "implicit_global") {
      throw new BenchmarkError("benchmark_incompatible", "no implicit global ranking");
    }
    const obs = this.listObservations().filter((o) => {
      if (o.metric !== input.metric) return false;
      if (o.value === null) return false; // absence / unknown excluded, not zeroed
      if (o.stale) return false;
      if (o.status === "source_unavailable") return false;
      if (input.datasetHash && o.window && (o.window as { datasetHash?: string }).datasetHash) {
        return (o.window as { datasetHash?: string }).datasetHash === input.datasetHash;
      }
      return true;
    });

    // Dataset isolation: group by datasetHash when present; refuse cross-sum
    const byDataset = new Map<string, Observation[]>();
    for (const o of obs) {
      const ds = (o.window as { datasetHash?: string } | undefined)?.datasetHash ?? input.datasetHash ?? "_default";
      if (input.datasetHash && ds !== input.datasetHash && ds !== "_default") continue;
      const list = byDataset.get(ds) ?? [];
      list.push(o);
      byDataset.set(ds, list);
    }
    if (byDataset.size > 1 && !input.datasetHash) {
      throw new BenchmarkError("benchmark_incompatible", "distinct datasets must not be summed");
    }

    const pool = input.datasetHash
      ? byDataset.get(input.datasetHash) ?? byDataset.get("_default") ?? []
      : [...byDataset.values()][0] ?? [];

    const byModel = new Map<string, number[]>();
    for (const o of pool) {
      const key = JSON.stringify([o.modelRef.providerId,o.modelRef.modelId,o.modelRef.accountRef??null]);
      const arr = byModel.get(key) ?? [];
      arr.push(o.value as number);
      byModel.set(key, arr);
    }

    const rows: RankingRow[] = [];
    const exclusions: string[] = [];
    for (const [key, values] of byModel) {
      const [providerId, modelId,accountRef] = JSON.parse(key) as [string, string,string|null];
      if (values.length < 1) {
        exclusions.push(key);
        rows.push(
          freeze({
            modelRef: freeze({ providerId, modelId, accountRef }),
            score: null,
            sampleCount: 0,
            excludedReason: "insufficient_samples",
          }),
        );
        continue;
      }
      let score: number;
      if (input.method === "mean") score = values.reduce((a, b) => a + b, 0) / values.length;
      else if (input.method === "median") {
        const s = [...values].sort((a, b) => a - b);
        score = s[Math.floor(s.length / 2)]!;
      } else score = values.length;
      rows.push(
        freeze({
          modelRef: freeze({ providerId, modelId, accountRef }),
          score,
          sampleCount: values.length,
          source: "local_observations",
          method: input.method,
          sourceDate: input.sourceDate ?? isoNow(),
        }),
      );
    }

    // Models with no observations: excluded, score null — never 0
    if (input.filter.modelRefs && Array.isArray(input.filter.modelRefs)) {
      for (const ref of input.filter.modelRefs as ModelRef[]) {
        const key = JSON.stringify([ref.providerId,ref.modelId,ref.accountRef??null]);
        if (!byModel.has(key)) {
          exclusions.push(`${ref.providerId}/${ref.modelId}${ref.accountRef?` (${ref.accountRef})`:''}`);
          rows.push(
            freeze({
              modelRef: freeze({ ...ref }),
              score: null,
              sampleCount: 0,
              excludedReason: "no_observation",
            }),
          );
        }
      }
    }

    const view = freeze({
      id: `rank_${randomUUID().replace(/-/g, "").slice(0, 10)}`,
      filter: freeze({ ...input.filter }),
      metric: input.metric,
      ...(input.weights ? { weights: freeze({ ...input.weights }) } : {}),
      cohort: input.cohort,
      method: input.method,
      sampleCount: pool.length,
      sourceDate: input.sourceDate ?? isoNow(),
      exclusions: freeze([...exclusions]),
      rows: freeze(rows),
    });
    this.rankings.set(view.id, view);
    this.persistHook?.("ranking", view.id);
    return view;
  }

  /**
   * Optional judge score — must identify evaluator/rubric; no evidence → no "best" seal.
   */
  attachJudge(
    runId: string,
    judge: { evaluator: string; rubricVersion: string; evidence: boolean; score?: number },
  ): { sealBest: boolean; run: BenchmarkRun } {
    const run = this.runs.get(runId);
    if (!run) throw new BenchmarkError("benchmark_incompatible", "run not found");
    const sealBest = Boolean(judge.evidence && judge.evaluator && judge.rubricVersion);
    const next = freeze({
      ...run,
      judge: freeze({
        evaluator: judge.evaluator,
        rubricVersion: judge.rubricVersion,
        evidence: judge.evidence,
      }),
    });
    this.runs.set(runId, next);
    return { sealBest, run: next };
  }

  /** Opening panel / filter / select must not call this — tests assert activeStarts unchanged. */
  notePanelOpen(): void {
    // intentionally empty — observe only
  }

  noteFilterChange(): void {
    // intentionally empty
  }

  noteModelSelect(): void {
    // intentionally empty
  }
}

/** Label helper: probe latency display string (never "generation speed"). */
export function labelProbeLatency(valueMs: number | null): { label: string; kind: "probe" } {
  return {
    kind: "probe",
    label: valueMs === null ? "probe latency: unknown" : `probe latency: ${valueMs} ms`,
  };
}

/** Guard used by UI/scripts: refuse treating GET /models latency as TTFT. */
export function isGenerationSpeedMetric(metric: string, kind: ObservationKind): boolean {
  if (kind === "probe") return false;
  return (
    metric === "ttft_ms" ||
    metric === "generation_ttft_ms" ||
    metric === "tokens_per_sec" ||
    metric === "generation_duration_ms"
  );
}

export { MAX_COMPARE, MAX_CASES_FIRST, stableVersion };
