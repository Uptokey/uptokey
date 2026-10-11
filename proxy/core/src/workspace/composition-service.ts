import { Worker } from 'node:worker_threads';
import { parseCompositionGraphSnapshot, type CompositionDecision, type CompositionGraphSnapshot } from '@uptokey/sync-contract/composition';
import { RUN_STATUSES } from '@uptokey/sync-contract/workflow';
import type { CompositionObservation } from './composition-graph.ts';

export interface CompositionScopeOptions {
  scopeId: string;
  loadObservation(compositionId: string): Promise<CompositionObservation>;
}
export interface CompositionGraphFacade {
  start(compositionId: string): Promise<CompositionGraphSnapshot>;
  getState(compositionId: string): Promise<CompositionGraphSnapshot | null>;
  resume(compositionId: string, decision: CompositionDecision): Promise<CompositionGraphSnapshot>;
}
export interface CompositionService {
  createGraph(options: CompositionScopeOptions): CompositionGraphFacade;
  close(): Promise<void>;
}
type Method = 'start' | 'getState' | 'resume';
type Pending = {
  scopeId: string; compositionId: string; method: Method; reads: number;
  loadObservation: CompositionScopeOptions['loadObservation'];
  resolve(value: CompositionGraphSnapshot | null): void; reject(error: Error): void;
  timer: ReturnType<typeof setTimeout>;
};
const unavailable = () => new Error('composition_unavailable');
const record = (input: unknown): input is Record<string, unknown> => input !== null && typeof input === 'object' && !Array.isArray(input);
const idValid = (input: unknown): input is string => typeof input === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input);
const integer = (input: unknown): input is number => Number.isSafeInteger(input) && (input as number) > 0;
const errors = new Set(['composition_unavailable', 'composition_not_paused', 'composition_checkpoint_invalid', 'composition_checkpoint_missing']);

/** No SDK runtime or native SQLite module is imported in the parent process. */
export async function openCompositionService(databasePath: string): Promise<CompositionService> {
  if (typeof databasePath !== 'string' || databasePath.length < 1 || databasePath.length > 4096) throw unavailable();
  const worker = new Worker(new URL(import.meta.url.endsWith('.ts') ? './composition-worker.ts' : './composition-worker.js', import.meta.url), {
    workerData: { databasePath },
    env: { LANGCHAIN_TRACING: 'false', LANGCHAIN_TRACING_V2: 'false', LANGSMITH_TRACING: 'false' },
    // Do not inherit --import/--require, loaders, inspectors, or NODE_OPTIONS.
    execArgv: import.meta.url.endsWith('.ts') ? ['--experimental-strip-types'] : [],
    resourceLimits: { maxOldGenerationSizeMb: 512, maxYoungGenerationSizeMb: 64, stackSizeMb: 4 },
    stdout: true, stderr: true,
  });
  // SDK diagnostics must not become parent logs. Protocol errors are closed codes.
  worker.stdout?.resume(); worker.stderr?.resume();
  const pending = new Map<number, Pending>();
  const reading = new Set<number>();
  let nextId = 0, closing = false, closed = false, started = false;
  let readyResolve!: () => void, readyReject!: (error: Error) => void;
  const ready = new Promise<void>((resolve, reject) => { readyResolve = resolve; readyReject = reject; });
  let exitResolve!: () => void;
  const exited = new Promise<void>(resolve => { exitResolve = resolve; });
  const startupTimer = setTimeout(() => fail(), 10000);
  function fail(terminate = true) {
    if (closed) return;
    closed = true; clearTimeout(startupTimer); readyReject(unavailable());
    for (const call of pending.values()) { clearTimeout(call.timer); call.reject(unavailable()); }
    pending.clear(); reading.clear();
    if (terminate) void worker.terminate().catch(() => undefined);
  }
  function send(value: unknown) {
    if (closed) return;
    try { worker.postMessage(value); } catch { fail(); }
  }
  // An uncaught worker exception already initiates exit. Do not race native
  // SQLite cleanup by issuing terminate again from the error callback.
  worker.on('error', () => fail(false));
  worker.on('exit', () => { if (!closed) fail(false); exitResolve(); });
  worker.on('message', (input: unknown) => {
    if (closed || !record(input)) { if (!closed) fail(); return; }
    if (input.type === 'ready' && !started && Object.keys(input).length === 1) { started = true; clearTimeout(startupTimer); readyResolve(); return; }
    if (input.type === 'startup_error' && !started && Object.keys(input).length === 2 && input.code === 'composition_unavailable') {
      // The worker has closed its database and port. Await its normal exit;
      // terminate() would race native cleanup during expected startup failure.
      fail(false); return;
    }
    if (input.type === 'closed' && closing && Object.keys(input).length === 1) {
      closed = true;
      for (const call of pending.values()) { clearTimeout(call.timer); call.reject(unavailable()); }
      pending.clear(); reading.clear(); return;
    }
    if (input.type === 'observation') {
      if (Object.keys(input).length !== 5 || !integer(input.id) || !integer(input.callId) || reading.has(input.id)) { fail(); return; }
      const call = pending.get(input.callId);
      if (!call || call.method === 'getState' || call.scopeId !== input.scopeId || call.compositionId !== input.compositionId || call.reads >= 1) { fail(); return; }
      call.reads++; reading.add(input.id);
      const { id, callId } = input;
      const finish = (value: CompositionObservation | null) => {
        if (!reading.delete(id) || closed || !pending.has(callId)) return;
        send({ type: 'observation_result', id, callId, value });
      };
      if (closing) { finish(null); return; }
      const timer = setTimeout(() => finish(null), 3000);
      void Promise.resolve().then(() => call.loadObservation(call.compositionId)).then(value => {
        if (!record(value) || !RUN_STATUSES.includes(value.status) ||
            (value.conditionMatched !== null && typeof value.conditionMatched !== 'boolean')) finish(null);
        else finish({ status: value.status, conditionMatched: value.conditionMatched });
      }, () => finish(null)).catch(() => finish(null)).finally(() => clearTimeout(timer));
      return;
    }
    if ((input.type === 'result' || input.type === 'error') && integer(input.id)) {
      const call = pending.get(input.id);
      if (!call || Object.keys(input).length !== 3) { fail(); return; }
      if (input.type === 'error') {
        if (typeof input.code !== 'string' || !errors.has(input.code)) { fail(); return; }
        pending.delete(input.id); clearTimeout(call.timer); call.reject(new Error(input.code)); return;
      }
      try {
        const value = input.value === null ? null : parseCompositionGraphSnapshot(input.value);
        if ((value && value.compositionId !== call.compositionId) || (!value && call.method !== 'getState')) throw unavailable();
        pending.delete(input.id); clearTimeout(call.timer); call.resolve(value);
      } catch { fail(); }
      return;
    }
    fail();
  });
  try { await ready; } catch { await exited; throw unavailable(); }

  let closePromise: Promise<void> | undefined;
  return Object.freeze({
    createGraph(options: CompositionScopeOptions): CompositionGraphFacade {
      const { scopeId, loadObservation } = options;
      if (closing || closed) throw unavailable();
      if (typeof scopeId !== 'string' || scopeId.length < 1 || scopeId.length > 256 || typeof loadObservation !== 'function') throw new Error('composition_scope_invalid');
      const invoke = (method: Method, compositionId: string, decision?: CompositionDecision): Promise<CompositionGraphSnapshot | null> => {
        if (!idValid(compositionId)) throw new Error('composition_id_invalid');
        if (decision !== undefined && decision !== 'recheck' && decision !== 'stop') throw new Error('composition_decision_invalid');
        if (closed || closing || pending.size >= 64 || nextId >= Number.MAX_SAFE_INTEGER) return Promise.reject(unavailable());
        const id = ++nextId;
        return new Promise((resolve, reject) => {
          const timer = setTimeout(() => fail(), 30000);
          pending.set(id, { scopeId, compositionId, method, reads: 0, loadObservation, resolve, reject, timer });
          send({ type: 'call', id, scopeId, compositionId, method, ...(decision === undefined ? {} : { decision }) });
        });
      };
      return Object.freeze({
        start: (id: string) => invoke('start', id) as Promise<CompositionGraphSnapshot>,
        getState: (id: string) => invoke('getState', id),
        resume: (id: string, decision: CompositionDecision) => {
          if (decision !== 'recheck' && decision !== 'stop') throw new Error('composition_decision_invalid');
          return invoke('resume', id, decision) as Promise<CompositionGraphSnapshot>;
        },
      });
    },
    close(): Promise<void> {
      if (closePromise) return closePromise;
      closing = true;
      closePromise = (async () => {
        const timer = setTimeout(() => fail(), 5000);
        send({ type: 'close' });
        try { await exited; } finally { clearTimeout(timer); }
      })();
      return closePromise;
    },
  });
}
