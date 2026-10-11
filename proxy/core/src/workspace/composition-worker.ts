import { isMainThread, parentPort, workerData } from 'node:worker_threads';
import { SqliteSaver } from '@langchain/langgraph-checkpoint-sqlite';
import { RUN_STATUSES } from '@uptokey/sync-contract/workflow';
import { createCompositionGraph, type CompositionObservation } from './composition-graph.ts';

if (isMainThread || !parentPort || !workerData || typeof workerData.databasePath !== 'string') throw new Error('composition_worker_invalid');
const port = parentPort;
function openSaver(): SqliteSaver | undefined {
  let candidate: SqliteSaver | undefined;
  try {
    candidate = SqliteSaver.fromConnString(workerData.databasePath);
    candidate.db.pragma('journal_mode = WAL');
    candidate.db.pragma('busy_timeout = 5000');
    return candidate;
  } catch {
    // Startup failures are expected for an invalid database. Report the closed
    // protocol code and let this worker exit normally after closing native state.
    // Throwing here made Node22/Windows tear down the native addon abnormally.
    try { candidate?.db.close(); } catch { /* Parent still receives only the closed error code. */ }
    port.postMessage({ type: 'startup_error', code: 'composition_unavailable' });
    port.close();
    return undefined;
  }
}
const saver = openSaver();
if (saver) startWorker(saver);

function startWorker(saver: SqliteSaver): void {
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const idValid = (value: unknown): value is string => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value);
const errors = new Set(['composition_not_paused', 'composition_checkpoint_invalid', 'composition_checkpoint_missing']);
const reads = new Map<number, { callId: number; resolve(value: CompositionObservation): void; reject(error: Error): void; timer: ReturnType<typeof setTimeout> }>();
let nextReadId = 0, latestCallId = 0, queued = 0, closing = false;
let queue = Promise.resolve();
function fail(): never {
  for (const read of reads.values()) { clearTimeout(read.timer); read.reject(new Error('composition_unavailable')); }
  reads.clear();
  saver.db.close(); port.close();
  throw new Error('composition_worker_protocol');
}
port.on('message', (input: unknown) => {
  if (!record(input)) return fail();
  if (input.type === 'observation_result') {
    if (Object.keys(input).length !== 4 || !integer(input.id) || !integer(input.callId)) return fail();
    const read = reads.get(input.id);
    if (!read || read.callId !== input.callId) return fail();
    reads.delete(input.id); clearTimeout(read.timer);
    if (input.value === null) { read.reject(new Error('composition_observation_unavailable')); return; }
    const value = input.value;
    if (!record(value) || Object.keys(value).length !== 2 || !RUN_STATUSES.includes(value.status as never) ||
        (value.conditionMatched !== null && typeof value.conditionMatched !== 'boolean')) return fail();
    read.resolve({ status: value.status as CompositionObservation['status'], conditionMatched: value.conditionMatched }); return;
  }
  if (input.type === 'close' && Object.keys(input).length === 1 && !closing) {
    closing = true;
    void queue.finally(() => { saver.db.close(); port.postMessage({ type: 'closed' }); port.close(); }); return;
  }
  if (closing || input.type !== 'call' || !integer(input.id) || input.id <= latestCallId ||
      typeof input.scopeId !== 'string' || input.scopeId.length < 1 || input.scopeId.length > 256 || !idValid(input.compositionId) ||
      !['start', 'getState', 'resume'].includes(input.method as string) ||
      (input.method === 'resume' ? Object.keys(input).length !== 6 || !['recheck', 'stop'].includes(input.decision as string) : Object.keys(input).length !== 5) || queued >= 64) return fail();
  latestCallId = input.id; queued++;
  const { id, scopeId, compositionId, method, decision } = input;
  queue = queue.then(async () => {
    const graph = createCompositionGraph({ scopeId, checkpointer: saver,
      loadObservation: async observedId => {
        if (observedId !== compositionId || nextReadId >= Number.MAX_SAFE_INTEGER) throw new Error('composition_observation_invalid');
        const readId = ++nextReadId;
        return new Promise<CompositionObservation>((resolve, reject) => {
          const timer = setTimeout(() => { reads.delete(readId); reject(new Error('composition_observation_unavailable')); }, 4000);
          reads.set(readId, { callId: id, resolve, reject, timer });
          port.postMessage({ type: 'observation', id: readId, callId: id, scopeId, compositionId });
        });
      } });
    try {
      const value = method === 'start' ? await graph.start(compositionId)
        : method === 'getState' ? await graph.getState(compositionId)
        : await graph.resume(compositionId, decision as 'recheck' | 'stop');
      port.postMessage({ type: 'result', id, value });
    } catch (error) {
      port.postMessage({ type: 'error', id, code: error instanceof Error && errors.has(error.message) ? error.message : 'composition_unavailable' });
    } finally { queued--; }
  });
});
port.postMessage({ type: 'ready' });
}
