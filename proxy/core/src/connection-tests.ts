import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { withConfigFileLock } from "./config-file-lock.ts";
import { connectionJobsPath } from "./paths.ts";
import { CONNECTION_LIMITS, CONNECTIONS_SCHEMA_VERSION, parseConnectionTestResult, parseConnectionTestSpec, type ConnectionTestMode, type ConnectionTestResult, type ConnectionTestResultKind, type ConnectionTestState } from "@uptokey/sync-contract/connections";
import { type ConnectionProfileService, type StoredProfile } from "./connection-profiles.ts";

export interface TestJobSnapshot {
  id: string;
  connectionIds: string[];
  mode: ConnectionTestMode;
  maxCalls: number;
  maxCostMicros: string;
  operationId?: string;
  state: ConnectionTestState;
  cursor: number;
  results: ConnectionTestResult[];
  callsMade: number;
  costMicros: string;
  createdAt: string;
  updatedAt: string;
  note?: string;
}

interface JobsFile {
  schemaVersion: number;
  jobs: TestJobSnapshot[];
  idempotency: Record<string, string>;
}

export interface JobsStorage {
  load(): Promise<JobsFile | null>;
  save(state: JobsFile): Promise<void>;
}

export function fileJobsStorage(path: string = connectionJobsPath()): JobsStorage {
  return {
    load: () => readJson<JobsFile | null>(path, null),
    save: (state) => withConfigFileLock(path, () => writeJsonAtomic(path, state)),
  };
}

export function memoryJobsStorage(): JobsStorage {
  let state: JobsFile | null = null;
  return { load: async () => state, save: async (next) => { state = next; } };
}

export interface ProbeOutcome {
  result: ConnectionTestResultKind;
  latencyMs: number;
  note?: string;
  /** Chamadas ao provedor consumidas por esta sonda (metadata = 0). */
  callsMade: number;
  /** Custo em micros de USD quando conhecido, senão "0". */
  costMicros: string;
}

export interface ProbeContext {
  signal: AbortSignal;
  timeoutMs: number;
  fetchImpl: typeof fetch;
  now: () => number;
}

export type ConnectionProbe = (profile: StoredProfile, credential: string | null, ctx: ProbeContext) => Promise<ProbeOutcome>;

function fail(code: string, status?: number): Error {
  return Object.assign(new Error(code), { code, ...(status === undefined ? {} : { status }) });
}

function isUuid(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

/**
 * Sonda metadata: avaliação local, zero chamadas ao provedor, custo zero.
 * Nunca inventa saúde: sem credencial ou desabilitada, o veredito é local e explícito.
 */
export async function metadataProbe(profile: StoredProfile, credential: string | null): Promise<ProbeOutcome> {
  if (!profile.enabled) return { result: "skipped", latencyMs: 0, note: "disabled", callsMade: 0, costMicros: "0" };
  if (profile.accessMode !== "local" && !credential) {
    return { result: "failed", latencyMs: 0, note: "credential_missing", callsMade: 0, costMicros: "0" };
  }
  return { result: "ok", latencyMs: 0, note: "local_admission", callsMade: 0, costMicros: "0" };
}

interface CheapEndpoint {
  url: string;
  queryKey?: boolean;
}

function cheapEndpointFor(profile: StoredProfile): CheapEndpoint | null {
  switch (profile.providerId) {
    case "groq": return { url: "https://api.groq.com/openai/v1/models" };
    case "openrouter": return { url: "https://openrouter.ai/api/v1/models" };
    case "together": return { url: "https://api.together.xyz/v1/models" };
    case "deepseek": return { url: "https://api.deepseek.com/models" };
    case "mistral": return { url: "https://api.mistral.ai/v1/models" };
    case "cerebras": return { url: "https://api.cerebras.ai/v1/models" };
    case "gemini": return { url: "https://generativelanguage.googleapis.com/v1beta/models", queryKey: true };
    default: break;
  }
  if (profile.accessMode === "local" && profile.endpointUrl) {
    try {
      const base = new URL(profile.endpointUrl);
      if (profile.providerId === "ollama") return { url: `${base.origin}/api/tags` };
      return { url: `${base.origin}/v1/models` };
    } catch { return null; }
  }
  return null;
}

/**
 * Sonda barata oficial (GET /models): 1 chamada, custo zero.
 * Sem credencial → failed local antes de qualquer rede.
 */
export async function cheapHttpProbe(profile: StoredProfile, credential: string | null, ctx: ProbeContext): Promise<ProbeOutcome> {
  const started = ctx.now();
  if (!profile.enabled) return { result: "skipped", latencyMs: 0, note: "disabled", callsMade: 0, costMicros: "0" };
  const endpoint = cheapEndpointFor(profile);
  if (!endpoint) return { result: "skipped", latencyMs: 0, note: "no_cheap_probe", callsMade: 0, costMicros: "0" };
  const needsKey = profile.accessMode !== "local";
  if (needsKey && !credential) return { result: "failed", latencyMs: 0, note: "credential_missing", callsMade: 0, costMicros: "0" };
  const target = endpoint.queryKey ? `${endpoint.url}?key=${encodeURIComponent(credential ?? "")}` : endpoint.url;
  let response: Response;
  try {
    response = await ctx.fetchImpl(target, {
      method: "GET",
      redirect: "error",
      signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(ctx.timeoutMs)]),
      headers: needsKey && !endpoint.queryKey ? { authorization: `Bearer ${credential}`, accept: "application/json" } : { accept: "application/json" },
    });
  } catch (error) {
    if (ctx.signal.aborted) throw error;
    const timedOut = error instanceof Error && /timeout|aborted|abandon/i.test(error.message);
    void timedOut;
    return { result: "timeout", latencyMs: ctx.now() - started, note: "probe_timeout", callsMade: 1, costMicros: "0" };
  }
  await response.body?.cancel().catch(() => undefined);
  const latencyMs = ctx.now() - started;
  if (response.status === 200) return { result: "ok", latencyMs, callsMade: 1, costMicros: "0" };
  if (response.status === 401 || response.status === 403) return { result: "unauthorized", latencyMs, callsMade: 1, costMicros: "0" };
  if (response.status === 429) return { result: "rate_limited", latencyMs, callsMade: 1, costMicros: "0" };
  return { result: "unreachable", latencyMs, note: `http_${response.status}`, callsMade: 1, costMicros: "0" };
}

export interface TestServiceOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  metadataProbeImpl?: ConnectionProbe;
  httpProbeImpl?: ConnectionProbe;
  concurrency?: number;
  timeoutMs?: number;
}

/**
 * Testes em lote por conexão. Um job, um cursor; reload acompanha o mesmo job
 * sem repetir chamadas. Cancelar impede novos despachos; em voo aborta.
 */
export class ConnectionTestService {
  private readonly profiles: ConnectionProfileService;
  private readonly storage: JobsStorage;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly metadataProbeImpl: ConnectionProbe;
  private readonly httpProbeImpl: ConnectionProbe;
  private readonly concurrency: number;
  private readonly timeoutMs: number;
  private state: JobsFile | null = null;
  private readonly running = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private booted = false;

  constructor(profiles: ConnectionProfileService, storage: JobsStorage, options: TestServiceOptions = {}) {
    this.profiles = profiles;
    this.storage = storage;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.metadataProbeImpl = options.metadataProbeImpl ?? ((p, c) => metadataProbe(p, c));
    this.httpProbeImpl = options.httpProbeImpl ?? cheapHttpProbe;
    this.concurrency = options.concurrency ?? CONNECTION_LIMITS.maxConcurrentTests;
    this.timeoutMs = options.timeoutMs ?? CONNECTION_LIMITS.testTimeoutMs;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async load(): Promise<JobsFile> {
    if (!this.state) {
      const stored = await this.storage.load();
      this.state = stored && stored.schemaVersion === CONNECTIONS_SCHEMA_VERSION ? stored : { schemaVersion: CONNECTIONS_SCHEMA_VERSION, jobs: [], idempotency: {} };
    }
    if (!this.booted) {
      this.booted = true;
      let dirty = false;
      for (const job of this.state.jobs) {
        if (job.state === "running" || job.state === "queued") {
          job.state = "interrupted";
          job.note = "process_restart";
          job.updatedAt = this.iso();
          dirty = true;
        }
      }
      if (dirty) await this.storage.save(this.state);
    }
    return this.state;
  }

  private snapshot(job: TestJobSnapshot): TestJobSnapshot {
    return { ...job, connectionIds: [...job.connectionIds], results: job.results.map((r) => ({ ...r })) };
  }

  async get(id: string): Promise<TestJobSnapshot | undefined> {
    const state = await this.load();
    const job = state.jobs.find((j) => j.id === id);
    return job ? this.snapshot(job) : undefined;
  }

  async start(specInput: unknown): Promise<TestJobSnapshot> {
    const spec = parseConnectionTestSpec(specInput);
    return this.exclusive(async () => {
      const state = await this.load();
      if (spec.operationId) {
        const replayId = state.idempotency[spec.operationId];
        if (replayId) {
          const existing = state.jobs.find((j) => j.id === replayId);
          if (existing) return this.snapshot(existing);
        }
      }
      // Conexões removidas após o spec viram skipped, nunca erro fatal do job.
      const job: TestJobSnapshot = {
        id: randomUUID(),
        connectionIds: spec.connectionIds,
        mode: spec.mode,
        maxCalls: spec.maxCalls,
        maxCostMicros: spec.maxCostMicros,
        ...(spec.operationId ? { operationId: spec.operationId } : {}),
        state: "queued",
        cursor: 0,
        results: [],
        callsMade: 0,
        costMicros: "0",
        createdAt: this.iso(),
        updatedAt: this.iso(),
      };
      state.jobs.push(job);
      if (spec.operationId) state.idempotency[spec.operationId] = job.id;
      if (state.jobs.length > 200) state.jobs.splice(0, state.jobs.length - 200);
      await this.storage.save(state);
      void this.drive(job.id);
      return this.snapshot(job);
    });
  }

  async cancel(id: string): Promise<TestJobSnapshot> {
    const controller = this.running.get(id);
    controller?.abort();
    return this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job) throw fail("connection_not_found", 404);
      if (job.state === "queued" || job.state === "running") {
        job.state = "cancelled";
        job.updatedAt = this.iso();
        await this.storage.save(state);
      }
      return this.snapshot(job);
    });
  }

  /** Retomada explícita após interrupção: só itens pendentes, sem repetir chamadas. */
  async resume(id: string): Promise<TestJobSnapshot> {
    return this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job) throw fail("connection_not_found", 404);
      if (job.state !== "interrupted") return this.snapshot(job);
      job.state = "queued";
      job.note = undefined;
      job.updatedAt = this.iso();
      await this.storage.save(state);
      void this.drive(job.id);
      return this.snapshot(job);
    });
  }

  private async drive(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      await this.work(id, controller.signal);
    } finally {
      this.running.delete(id);
    }
  }

  private async work(id: string, signal: AbortSignal): Promise<void> {
    const markRunning = await this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job || job.state !== "queued" || signal.aborted) return false;
      job.state = "running";
      job.updatedAt = this.iso();
      await this.storage.save(state);
      return true;
    });
    if (!markRunning) return;

    const workers: Promise<void>[] = [];
    for (let w = 0; w < this.concurrency; w++) workers.push(this.worker(id, signal));
    await Promise.all(workers);

    await this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job || job.state === "cancelled") { await this.storage.save(state); return; }
      if (signal.aborted) {
        job.state = "cancelled";
      } else if (job.results.length < job.connectionIds.length) {
        job.state = "partial";
        job.note = job.note ?? "incomplete";
      } else {
        const bad = job.results.filter((r) => r.result !== "ok" && r.result !== "skipped").length;
        const decided = job.results.filter((r) => r.result !== "skipped").length;
        job.state = bad === 0 ? "succeeded" : bad === decided && decided > 0 ? "failed" : "partial";
      }
      job.updatedAt = this.iso();
      await this.storage.save(state);
    });
  }

  private async worker(id: string, signal: AbortSignal): Promise<void> {
    for (;;) {
      if (signal.aborted) return;
      const claim = await this.exclusive(async () => {
        const state = await this.load();
        const job = state.jobs.find((j) => j.id === id);
        if (!job || job.state !== "running") return null;
        // Teto de chamadas: sem novas sondas com custo de provedor.
        if (job.callsMade >= job.maxCalls) return null;
        // Teto de custo (modo inference): falhar fechado antes da próxima sonda.
        if (job.mode === "inference" && BigInt(job.costMicros) >= BigInt(job.maxCostMicros)) return null;
        if (job.cursor >= job.connectionIds.length) return null;
        const connectionId = job.connectionIds[job.cursor]!;
        job.cursor += 1;
        job.updatedAt = this.iso();
        await this.storage.save(state);
        return { job: this.snapshot(job), connectionId };
      });
      if (!claim) return;
      const profile = await this.profiles.get(claim.connectionId);
      let outcome: ProbeOutcome;
      if (!profile) {
        outcome = { result: "skipped", latencyMs: 0, note: "connection_removed", callsMade: 0, costMicros: "0" };
      } else if (claim.job.mode === "metadata") {
        const credential = await this.profiles.readCredential(profile);
        try {
          outcome = await this.metadataProbeImpl(profile, credential, this.ctx(signal));
        } catch (error) {
          if (signal.aborted) return;
          outcome = { result: "failed", latencyMs: 0, note: error instanceof Error ? error.message.slice(0, 80) : "probe_failed", callsMade: 0, costMicros: "0" };
        }
      } else {
        // Inference exige teto explícito (W0) e usa a sonda barata oficial.
        const credential = await this.profiles.readCredential(profile);
        try {
          outcome = await this.httpProbeImpl(profile, credential, this.ctx(signal));
        } catch (error) {
          if (signal.aborted) return;
          outcome = { result: "timeout", latencyMs: 0, note: error instanceof Error ? error.message.slice(0, 80) : "probe_failed", callsMade: 0, costMicros: "0" };
        }
      }
      const record = parseConnectionTestResult({
        connectionId: claim.connectionId,
        result: outcome.result,
        latencyMs: outcome.latencyMs,
        observedAt: this.iso(),
        ...(outcome.note ? { note: outcome.note } : {}),
      });
      await this.exclusive(async () => {
        const state = await this.load();
        const job = state.jobs.find((j) => j.id === id);
        if (!job) return;
        if (job.state === "cancelled") return;
        job.results.push(record);
        job.callsMade += outcome.callsMade;
        job.costMicros = (BigInt(job.costMicros) + BigInt(outcome.costMicros)).toString();
        if (job.callsMade >= job.maxCalls && job.cursor < job.connectionIds.length) {
          job.note = "test_budget_exceeded";
        }
        job.updatedAt = this.iso();
        await this.storage.save(state);
      });
    }
  }

  private ctx(signal: AbortSignal): ProbeContext {
    return { signal, timeoutMs: this.timeoutMs, fetchImpl: this.fetchImpl, now: this.now };
  }
}
