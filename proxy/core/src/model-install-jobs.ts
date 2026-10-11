import { randomUUID } from "node:crypto";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { withConfigFileLock } from "./config-file-lock.ts";
import { installLocalModel, type ModelInstallProgress } from "./local-model-install.ts";
import { discoverLocalModels } from "./local-model-discovery.ts";
import { modelInstallJobsPath } from "./paths.ts";
import { CONNECTIONS_SCHEMA_VERSION, parseModelInstallSpec, type ModelInstallRuntime, type ModelInstallState } from "@uptokey/sync-contract/connections";

export interface InstallJobSnapshot {
  id: string;
  runtime: ModelInstallRuntime;
  modelId: string;
  destinationId: string;
  expectedDigest: string | null;
  observedDigest: string | null;
  operationId?: string;
  state: ModelInstallState;
  downloadedBytes: number;
  /** null = tamanho não disponível (nunca 0 inventado). */
  sizeBytes: number | null;
  integrity: "unverified" | "verified" | "mismatch";
  createdAt: string;
  updatedAt: string;
  note?: string;
}

interface InstallJobsFile {
  schemaVersion: number;
  jobs: InstallJobSnapshot[];
  idempotency: Record<string, string>;
}

export interface InstallJobsStorage {
  load(): Promise<InstallJobsFile | null>;
  save(state: InstallJobsFile): Promise<void>;
}

export function fileInstallJobsStorage(path: string = modelInstallJobsPath()): InstallJobsStorage {
  return {
    load: () => readJson<InstallJobsFile | null>(path, null),
    save: (state) => withConfigFileLock(path, () => writeJsonAtomic(path, state)),
  };
}

export function memoryInstallJobsStorage(): InstallJobsStorage {
  let state: InstallJobsFile | null = null;
  return { load: async () => state, save: async (next) => { state = next; } };
}

export interface InstallerContext {
  signal: AbortSignal;
  endpointUrl?: string;
  onProgress: (completedBytes: number, totalBytes: number | null) => void;
}

export interface InstallerResult {
  observedDigest: string | null;
  sizeBytes: number | null;
}

export type ModelInstaller = (
  spec: { runtime: ModelInstallRuntime; modelId: string; destinationId: string },
  ctx: InstallerContext,
) => Promise<InstallerResult>;

function fail(code: string, status?: number): Error {
  return Object.assign(new Error(code), { code, ...(status === undefined ? {} : { status }) });
}

/** Instalador real: Ollama via daemon loopback; vLLM não suporta instalação. */
export async function defaultModelInstaller(
  spec: { runtime: ModelInstallRuntime; modelId: string; destinationId: string },
  ctx: InstallerContext,
): Promise<InstallerResult> {
  if (spec.runtime !== "ollama") throw fail("runtime_unavailable", 503);
  let downloaded = 0;
  let total: number | null = null;
  const forward = (progress: ModelInstallProgress) => {
    if (typeof progress.completedBytes === "number") downloaded = progress.completedBytes;
    if (typeof progress.totalBytes === "number") total = progress.totalBytes;
    ctx.onProgress(downloaded, total);
  };
  await installLocalModel(spec.modelId, { confirmed: true, signal: ctx.signal, endpointUrl: ctx.endpointUrl, onProgress: forward });
  // Verify the installed manifest digest, rather than inventing one from name/size.
  const inventory = await discoverLocalModels(ctx.signal, fetch, ctx.endpointUrl);
  if (inventory.status !== "available") throw fail(inventory.status === "unreachable" ? "ollama_unreachable" : "invalid_install_response", 503);
  const normalized = (id: string) => id.includes(":") ? id : `${id}:latest`;
  const found = inventory.models.find((m) => normalized(m.name) === normalized(spec.modelId));
  if (!found) throw fail("install_incomplete", 500);
  if (!found.digest) throw fail("invalid_install_response", 500);
  return { observedDigest: found.digest, sizeBytes: found.sizeBytes };
}

export interface InstallServiceOptions {
  installer?: ModelInstaller;
  now?: () => number;
  maxConcurrent?: number;
  ollamaEndpointUrl?: string;
}

/**
 * Instalações com progresso persistido. Arquivo parcial nunca vira instalação
 * válida: `ready` exige instalador + verificação + integridade no mesmo job.
 */
export class ModelInstallJobService {
  private readonly storage: InstallJobsStorage;
  private readonly installer: ModelInstaller;
  private readonly now: () => number;
  private readonly maxConcurrent: number;
  private readonly ollamaEndpointUrl?: string;
  private state: InstallJobsFile | null = null;
  private readonly running = new Map<string, AbortController>();
  private queue: Promise<unknown> = Promise.resolve();
  private booted = false;

  constructor(storage: InstallJobsStorage, options: InstallServiceOptions = {}) {
    this.storage = storage;
    this.installer = options.installer ?? defaultModelInstaller;
    this.now = options.now ?? Date.now;
    this.maxConcurrent = options.maxConcurrent ?? 2;
    this.ollamaEndpointUrl = options.ollamaEndpointUrl;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  private iso(): string {
    return new Date(this.now()).toISOString();
  }

  private async load(): Promise<InstallJobsFile> {
    if (!this.state) {
      const stored = await this.storage.load();
      this.state = stored && stored.schemaVersion === CONNECTIONS_SCHEMA_VERSION
        ? stored
        : { schemaVersion: CONNECTIONS_SCHEMA_VERSION, jobs: [], idempotency: {} };
    }
    if (!this.booted) {
      this.booted = true;
      let dirty = false;
      for (const job of this.state.jobs) {
        if (job.state === "queued" || job.state === "downloading" || job.state === "verifying") {
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

  private snapshot(job: InstallJobSnapshot): InstallJobSnapshot {
    return { ...job };
  }

  async get(id: string): Promise<InstallJobSnapshot | undefined> {
    const state = await this.load();
    const job = state.jobs.find((j) => j.id === id);
    return job ? this.snapshot(job) : undefined;
  }

  async activeCount(): Promise<number> {
    const state = await this.load();
    return state.jobs.filter((j) => j.state === "queued" || j.state === "downloading" || j.state === "verifying").length;
  }

  async start(specInput: unknown): Promise<InstallJobSnapshot> {
    const spec = parseModelInstallSpec(specInput);
    return this.exclusive(async () => {
      const state = await this.load();
      if (spec.operationId) {
        const replayId = state.idempotency[spec.operationId];
        if (replayId) {
          const existing = state.jobs.find((j) => j.id === replayId);
          if (existing) return this.snapshot(existing);
        }
      }
      const job: InstallJobSnapshot = {
        id: randomUUID(),
        runtime: spec.runtime,
        modelId: spec.modelId,
        destinationId: spec.destinationId,
        expectedDigest: spec.expectedDigest,
        observedDigest: null,
        ...(spec.operationId ? { operationId: spec.operationId } : {}),
        state: "queued",
        downloadedBytes: 0,
        sizeBytes: null,
        integrity: "unverified",
        createdAt: this.iso(),
        updatedAt: this.iso(),
      };
      state.jobs.push(job);
      if (spec.operationId) state.idempotency[spec.operationId] = job.id;
      if (state.jobs.length > 200) state.jobs.splice(0, state.jobs.length - 200);
      await this.storage.save(state);
      void this.pump();
      return this.snapshot(job);
    });
  }

  async cancel(id: string): Promise<InstallJobSnapshot> {
    this.running.get(id)?.abort();
    return this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job) throw fail("connection_not_found", 404);
      if (job.state === "queued" || job.state === "downloading" || job.state === "verifying") {
        job.state = "cancelled";
        job.updatedAt = this.iso();
        await this.storage.save(state);
      }
      return this.snapshot(job);
    });
  }

  /** Retomada explícita: o instalador do runtime retoma o parcial; parcial nunca é `ready`. */
  async resume(id: string): Promise<InstallJobSnapshot> {
    return this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job) throw fail("connection_not_found", 404);
      if (job.state !== "interrupted") return this.snapshot(job);
      job.state = "queued";
      job.note = "resumed";
      job.updatedAt = this.iso();
      await this.storage.save(state);
      void this.pump();
      return this.snapshot(job);
    });
  }

  private async pump(): Promise<void> {
    const next = await this.exclusive(async () => {
      const state = await this.load();
      const active = state.jobs.filter((j) => j.state === "downloading" || j.state === "verifying").length;
      if (active >= this.maxConcurrent) return null;
      return state.jobs.find((j) => j.state === "queued" && !this.running.has(j.id))?.id ?? null;
    });
    if (next) void this.drive(next);
  }

  private async drive(id: string): Promise<void> {
    if (this.running.has(id)) return;
    const controller = new AbortController();
    this.running.set(id, controller);
    try {
      await this.execute(id, controller.signal);
    } finally {
      this.running.delete(id);
      void this.pump();
    }
  }

  private async execute(id: string, signal: AbortSignal): Promise<void> {
    const accepted = await this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job || job.state !== "queued" || signal.aborted) return false;
      job.state = "downloading";
      job.updatedAt = this.iso();
      await this.storage.save(state);
      return true;
    });
    if (!accepted) return;

    let lastWrite = 0;
    const onProgress = (completedBytes: number, totalBytes: number | null) => {
      void this.exclusive(async () => {
        const state = await this.load();
        const job = state.jobs.find((j) => j.id === id);
        if (!job || job.state !== "downloading") return;
        job.downloadedBytes = completedBytes;
        if (totalBytes !== null) job.sizeBytes = totalBytes;
        const now = this.now();
        if (now - lastWrite >= 1000) {
          lastWrite = now;
          job.updatedAt = this.iso();
          await this.storage.save(state);
        }
      });
    };

    let result: InstallerResult;
    try {
      result = await this.installer(
        await this.specOf(id),
        { signal, ...(this.ollamaEndpointUrl ? { endpointUrl: this.ollamaEndpointUrl } : {}), onProgress },
      );
    } catch (error) {
      await this.exclusive(async () => {
        const state = await this.load();
        const job = state.jobs.find((j) => j.id === id);
        if (!job) return;
        if (signal.aborted || (error instanceof Error && /abort|interrupted/i.test(error.message))) {
          if (job.state === "downloading" || job.state === "verifying") {
            job.state = "cancelled";
            job.note = "cancelled";
          }
        } else {
          job.state = "failed";
          job.note = error instanceof Error ? error.message.slice(0, 120) : "install_failed";
        }
        job.updatedAt = this.iso();
        await this.storage.save(state);
      });
      return;
    }

    await this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job) return;
      if (job.state === "cancelled") return;
      job.state = "verifying";
      job.observedDigest = result.observedDigest;
      if (result.sizeBytes !== null) job.sizeBytes = result.sizeBytes;
      job.updatedAt = this.iso();
      await this.storage.save(state);
    });

    // Integridade: hash esperado divergente nunca aparece como modelo pronto.
    await this.exclusive(async () => {
      const state = await this.load();
      const job = state.jobs.find((j) => j.id === id);
      if (!job || job.state === "cancelled") return;
      if (signal.aborted) {
        job.state = "cancelled";
        job.note = "cancelled";
      } else if (job.expectedDigest && job.observedDigest !== job.expectedDigest) {
        job.state = "failed";
        job.integrity = "mismatch";
        job.note = "integrity_mismatch";
      } else {
        job.state = "ready";
        job.integrity = job.expectedDigest ? "verified" : "unverified";
      }
      job.updatedAt = this.iso();
      await this.storage.save(state);
    });
  }

  private async specOf(id: string): Promise<{ runtime: ModelInstallRuntime; modelId: string; destinationId: string }> {
    const state = await this.load();
    const job = state.jobs.find((j) => j.id === id);
    if (!job) throw fail("connection_not_found", 404);
    return { runtime: job.runtime, modelId: job.modelId, destinationId: job.destinationId };
  }
}
