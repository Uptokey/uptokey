import { createHash } from 'node:crypto';
import { Annotation, Command, END, START, StateGraph, interrupt, type BaseCheckpointSaver } from '@langchain/langgraph';
import { traceable } from 'langsmith/traceable';
import { RUN_STATUSES, type RunStatus } from '@uptokey/sync-contract/workflow';
import type { CompositionStatus, CompositionDecision, CompositionGraphSnapshot } from '@uptokey/sync-contract/composition';
export type { CompositionStatus, CompositionDecision, CompositionGraphSnapshot } from '@uptokey/sync-contract/composition';

export interface CompositionObservation {
  status: RunStatus;
  conditionMatched: boolean | null;
}
export interface CompositionGraphOptions {
  /** Trusted owner/project scope. Only its domain-separated hash reaches SQLite. */
  scopeId: string;
  checkpointer: BaseCheckpointSaver;
  /** The host checks ownership/bindings and evaluates the condition before returning. */
  loadObservation(compositionId: string): Promise<CompositionObservation>;
}

const State = Annotation.Root({
  compositionId: Annotation<string>,
  observedStatus: Annotation<RunStatus | null>,
  status: Annotation<CompositionStatus>,
});
const statuses: readonly string[] = ['review_required', 'proposal_ready', 'complete', 'stopped'];

function compositionId(value: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(value)) {
    throw new Error('composition_id_invalid');
  }
  return value;
}

/** Defense in depth; the service also isolates the SDK in a sanitized worker. */
function withoutTracing<T>(operation: () => Promise<T>): Promise<T> {
  return traceable(operation, { tracingEnabled: false })();
}

/**
 * Conditional composition only: nodes may read an observation or pause for review.
 * No plan creation, approval, navigation or effect dispatch belongs in this graph.
 * The caller owns the official checkpointer's lifecycle and must not share its scope
 * with another writer. Existing checkpoints are never restarted by start().
 */
export function createCompositionGraph(options: CompositionGraphOptions) {
  const { scopeId, checkpointer, loadObservation } = options;
  if (typeof scopeId !== 'string' || scopeId.length < 1 || scopeId.length > 256) {
    throw new Error('composition_scope_invalid');
  }

  const observe = async (state: typeof State.State): Promise<Partial<typeof State.State>> => {
    // Read failures become an explicit pause. Do not persist the exception or any
    // observation payload beyond the closed status, including on a resumed node.
    let observation: CompositionObservation;
    try {
      observation = await loadObservation(state.compositionId);
      if (!observation || !RUN_STATUSES.includes(observation.status) ||
          ![true, false, null].includes(observation.conditionMatched)) {
        return { observedStatus: null, status: 'review_required' };
      }
    } catch {
      return { observedStatus: null, status: 'review_required' };
    }
    const { status, conditionMatched } = observation;
    if (status === 'succeeded' && conditionMatched !== null) {
      return { observedStatus: status, status: conditionMatched ? 'proposal_ready' : 'complete' };
    }
    if (status === 'failed' || status === 'cancelled') {
      return { observedStatus: status, status: 'stopped' };
    }
    return { observedStatus: status, status: 'review_required' };
  };
  const route = (state: typeof State.State) => state.status === 'review_required' ? 'review' : END;
  const graph = new StateGraph(State)
    .addNode('observe', observe)
    .addNode('review', async state => {
      // LangGraph replays this node from its beginning on resume. There is no
      // effect before interrupt, and recheck only reads the same host binding.
      const decision: unknown = interrupt('review_required');
      if (decision === 'stop') return { status: 'stopped' as const };
      if (decision !== 'recheck') throw new Error('composition_decision_invalid');
      return observe(state);
    })
    .addEdge(START, 'observe')
    .addConditionalEdges('observe', route, ['review', END])
    .addConditionalEdges('review', route, ['review', END])
    .compile({ checkpointer });

  const config = (id: string) => ({
    configurable: { thread_id: createHash('sha256')
      .update(JSON.stringify(['quimera.composition.v1', scopeId, id])).digest('hex') },
    callbacks: [],
    recursionLimit: 8,
  });
  type SavedState = Awaited<ReturnType<typeof graph.getState>>;
  const snapshot = (id: string, saved: SavedState): CompositionGraphSnapshot | null => {
    if (!saved.config.configurable?.checkpoint_id) return null;
    const state = saved.values as Partial<typeof State.State>;
    if (state.compositionId !== id || !statuses.includes(state.status ?? '') ||
        (state.observedStatus !== null && !RUN_STATUSES.includes(state.observedStatus as RunStatus))) {
      throw new Error('composition_checkpoint_invalid');
    }
    return Object.freeze({ compositionId: id, observedStatus: state.observedStatus!, status: state.status!,
      interrupted: saved.tasks.some(task => task.interrupts.length > 0) });
  };
  const read = (id: string) => withoutTracing(async () => snapshot(id, await graph.getState(config(id))));

  // Prevent simultaneous starts/resumes from writing the same SQLite thread in
  // this host. This is an operation lock, not an additional execution journal.
  const pending = new Map<string, Promise<unknown>>();
  const serial = <T>(id: string, operation: () => Promise<T>): Promise<T> => {
    const result = (pending.get(id) ?? Promise.resolve()).catch(() => undefined).then(operation);
    pending.set(id, result);
    void result.finally(() => { if (pending.get(id) === result) pending.delete(id); }).catch(() => undefined);
    return result;
  };

  return Object.freeze({
    getState(id: string): Promise<CompositionGraphSnapshot | null> {
      compositionId(id);
      return serial(id, () => read(id));
    },
    start(id: string): Promise<CompositionGraphSnapshot> {
      compositionId(id);
      return serial(id, async () => {
        const existing = await read(id);
        if (existing) return existing;
        await withoutTracing(() => graph.invoke({ compositionId: id, observedStatus: null, status: 'review_required' }, config(id)));
        const saved = await read(id);
        if (!saved) throw new Error('composition_checkpoint_missing');
        return saved;
      });
    },
    resume(id: string, decision: CompositionDecision): Promise<CompositionGraphSnapshot> {
      compositionId(id);
      if (decision !== 'recheck' && decision !== 'stop') throw new Error('composition_decision_invalid');
      return serial(id, async () => {
        const existing = await read(id);
        if (!existing?.interrupted || existing.status !== 'review_required') throw new Error('composition_not_paused');
        await withoutTracing(() => graph.invoke(new Command({ resume: decision }), config(id)));
        const saved = await read(id);
        if (!saved) throw new Error('composition_checkpoint_missing');
        return saved;
      });
    },
  });
}
