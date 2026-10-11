import { createHash } from 'node:crypto';
import type { ChildProcess } from 'node:child_process';
import {
  parseEmbeddingsRequest,
  parseEmbeddingsWireRequest,
  canonicalEmbeddingsPayload,
  canonicalEmbeddingsWirePayload,
  normalizeEmbeddingsResponse,
  parseEmbeddingsManifest,
  EMBEDDINGS_TOTAL_MAX_BYTES,
  EMBEDDINGS_DIMENSION_MAX,
  type EmbeddingsRequest,
  type EmbeddingsWireRequest,
  type EmbeddingsManifest,
  type EmbeddingsManifestInput,
} from '@uptokey/sync-contract/embeddings';
import type { EffectRequest } from './workspace/executor.ts';
import type { WorkspaceStore } from './workspace/store.ts';
import {
  MediaEffectError,
  refusalCode,
  type MediaDispatchGate,
  admitDispatched,
  effectSignal,
  readBoundedJson,
  classifyProviderStatus,
  launchPreparationWorker,
  requestPreparation,
  stopWorker,
} from './media-dispatch.ts';

export interface WorkspaceEmbeddings {
  readonly model: string;
  readonly available?: boolean;
  readonly endpoint?: string;
  prepare(request: EmbeddingsRequest, texts: readonly string[], signal: AbortSignal): Promise<EmbeddingsWireRequest>;
  execute(
    request: EmbeddingsRequest,
    wire: EmbeddingsWireRequest,
    texts: readonly string[],
    effect: EffectRequest,
    gate?: MediaDispatchGate
  ): Promise<EmbeddingsManifest>;
}

export interface EmbeddingsOptions {
  child: ChildProcess;
  model: string;
  provider: string;
  providerUrl: string;
  driverRevision: string;
  modelRevision?: string;
  store: Pick<WorkspaceStore, 'readRun'>;
  resolveCredential(): Promise<string>;
  fetchImpl?: typeof fetch;
}

const RESPONSE_MAX_BYTES = 1048576;

export class IpcWorkspaceEmbeddings implements WorkspaceEmbeddings {
  readonly model: string;
  readonly endpoint: string;
  private lifetime = new AbortController();
  private busy = false;
  private consumed = new Set<string>();
  private options: EmbeddingsOptions;

  constructor(options: EmbeddingsOptions) {
    this.options = { ...options };
    this.model = options.model;
    this.endpoint = options.providerUrl;
  }

  get available() {
    return this.options.child.connected && !this.lifetime.signal.aborted;
  }

  dispose() {
    this.lifetime.abort();
  }

  async close() {
    this.dispose();
  }

  private wire(value: unknown, request: EmbeddingsRequest) {
    const wire = parseEmbeddingsWireRequest(value, request);
    if (
      wire.model !== this.model ||
      wire.url !== this.options.providerUrl ||
      wire.provider !== this.options.provider ||
      wire.driverRevision !== this.options.driverRevision
    ) {
      throw new MediaEffectError('not_sent');
    }
    return wire;
  }

  async prepare(
    input: EmbeddingsRequest,
    textsInput: readonly string[],
    signal: AbortSignal
  ): Promise<EmbeddingsWireRequest> {
    if (this.busy || !this.available) throw new MediaEffectError('not_sent');
    const request = parseEmbeddingsRequest(input);
    if (request.model !== this.model) throw new MediaEffectError('not_sent');
    if (!Array.isArray(textsInput) || textsInput.length !== request.inputs.length) {
      throw new MediaEffectError('not_sent');
    }
    const totalBytes = textsInput.reduce((acc, t) => acc + Buffer.byteLength(t, 'utf8'), 0);
    if (totalBytes > EMBEDDINGS_TOTAL_MAX_BYTES) throw new MediaEffectError('not_sent');

    this.busy = true;
    try {
      return await requestPreparation(
        this.options.child,
        'embeddings-prepare',
        'embeddings-prepared',
        {
          request,
          texts: [...textsInput],
          provider: this.options.provider,
          providerUrl: this.options.providerUrl,
          driverRevision: this.options.driverRevision,
        },
        AbortSignal.any([signal, this.lifetime.signal, AbortSignal.timeout(10000)]),
        wire => this.wire(wire, request)
      );
    } finally {
      this.busy = false;
    }
  }

  async execute(
    input: EmbeddingsRequest,
    wireInput: EmbeddingsWireRequest,
    textsInput: readonly string[],
    effectInput: EffectRequest,
    gate?: MediaDispatchGate
  ): Promise<EmbeddingsManifest> {
    if (this.busy || !this.available) throw new MediaEffectError('not_sent');
    let request: EmbeddingsRequest, wire: EmbeddingsWireRequest;
    try {
      request = parseEmbeddingsRequest(input);
      wire = this.wire(wireInput, request);
    } catch {
      throw new MediaEffectError('not_sent');
    }

    if (!Array.isArray(textsInput) || textsInput.length !== request.inputs.length) {
      throw new MediaEffectError('not_sent');
    }

    for (let i = 0; i < request.inputs.length; i++) {
      const item = request.inputs[i];
      const text = textsInput[i];
      if (!item || typeof text !== 'string') throw new MediaEffectError('not_sent');
      if (item.kind === 'text') {
        if (item.text !== text) throw new MediaEffectError('not_sent');
      } else if (item.kind === 'artifact') {
        const textBytes = Buffer.from(text, 'utf8');
        const textHash = createHash('sha256').update(textBytes).digest('hex');
        if (textHash !== item.sha256) throw new MediaEffectError('not_sent');
      }
    }

    const effect = {
      ...effectInput,
      arguments: structuredClone(effectInput.arguments),
      capability: structuredClone(effectInput.capability),
      limits: { ...effectInput.limits },
    };
    const a = effect.arguments.request;
    const b = effect.arguments.wire;
    if (
      a?.kind !== 'literal' ||
      b?.kind !== 'literal' ||
      canonicalEmbeddingsPayload(a.value) !== canonicalEmbeddingsPayload(request) ||
      canonicalEmbeddingsWirePayload(b.value, request) !== canonicalEmbeddingsWirePayload(wire, request) ||
      effect.capability.effect !== 'inference' ||
      effect.capability.retryClass !== 'never_automatic' ||
      effect.capability.dataDestination.kind !== 'provider'
    ) {
      throw new MediaEffectError('not_sent');
    }

    const key = JSON.stringify([effect.principalId, effect.projectId, effect.runId, effect.attemptId]);
    const { signal, abort } = effectSignal(effect, this.lifetime.signal);
    let sent = false;
    this.busy = true;

    try {
      if (this.consumed.has(key)) throw new MediaEffectError('not_sent');
      await admitDispatched(this.options.store, effect, signal);
      let secret: string;
      try { secret = await this.options.resolveCredential(); }
      catch { throw new MediaEffectError('not_sent', 'auth', 'embeddings_credential_unavailable'); }
      signal.throwIfAborted();
      if (!secret) throw new MediaEffectError('not_sent', 'auth', 'embeddings_credential_unavailable');

      await admitDispatched(this.options.store, effect, signal);
      // The caller's authority (account observation, identity) is revalidated after every wait above,
      // immediately before the transport. A refusal here is certain: nothing was sent.
      if (gate) {
        try { await gate.validate(signal); }
        catch (error) { throw new MediaEffectError('not_sent', 'policy', signal.aborted ? 'cancelled' : refusalCode(error, 'embeddings_authority_changed')); }
        signal.throwIfAborted();
      }
      this.consumed.add(key);

      sent = true;
      const response = await (this.options.fetchImpl ?? fetch)(wire.url, {
        method: 'POST',
        body: wire.body,
        headers: {
          ...wire.headers,
          authorization: 'Bearer ' + secret,
        },
        redirect: 'error',
        signal,
      });

      if (!response.ok) {
        void response.body?.cancel().catch(() => {});
        throw new MediaEffectError('unknown', classifyProviderStatus(response.status));
      }

      const body = await readBoundedJson(response, Math.min(RESPONSE_MAX_BYTES, effect.limits.maxOutputBytes), signal);
      signal.throwIfAborted();

      const normalized = normalizeEmbeddingsResponse(body, request);
      if (normalized.dimension > EMBEDDINGS_DIMENSION_MAX) {
        throw new MediaEffectError('unknown', 'policy');
      }

      const manifestInputs: EmbeddingsManifestInput[] = request.inputs.map((inp, idx) => {
        const text = textsInput[idx] ?? '';
        const bytes = Buffer.from(text, 'utf8');
        const hash = createHash('sha256').update(bytes).digest('hex');
        return {
          index: idx,
          sha256: hash,
          byteLength: bytes.byteLength,
          source:
            inp.kind === 'text'
              ? ({ kind: 'text' } as const)
              : ({ kind: 'artifact', artifactId: inp.artifactId, sha256: inp.sha256 } as const),
        };
      });

      const manifest = parseEmbeddingsManifest({
        schemaVersion: 1,
        model: request.model,
        modelRevision: this.options.modelRevision ?? '1',
        provider: this.options.provider,
        endpoint: this.options.providerUrl,
        dimension: normalized.dimension,
        inputs: manifestInputs,
        vectors: normalized.vectors,
        inputTokens: normalized.inputTokens,
        requestDigest: createHash('sha256').update(canonicalEmbeddingsPayload(request)).digest('hex'),
        wireDigest: createHash('sha256').update(canonicalEmbeddingsWirePayload(wire, request)).digest('hex'),
        observedAt: new Date().toISOString(),
      });

      return manifest;
    } catch (error) {
      if (error instanceof MediaEffectError && ((error.outcome === 'not_sent' && !sent) || error.outcome === 'unknown')) {
        throw error;
      }
      throw new MediaEffectError(sent ? 'unknown' : 'not_sent', signal.aborted && sent ? 'network' : 'unknown');
    } finally {
      abort();
      this.busy = false;
    }
  }
}

export async function launchWorkspaceEmbeddings(
  appRoot: string,
  options: Omit<EmbeddingsOptions, 'child'>
): Promise<IpcWorkspaceEmbeddings> {
  const child = await launchPreparationWorker(
    appRoot,
    'embeddings-worker.mjs',
    'embeddings-ready',
    options.driverRevision
  );
  const service = new IpcWorkspaceEmbeddings({ ...options, child });
  const dispose = service.dispose.bind(service);
  service.dispose = () => {
    dispose();
    child.kill();
  };
  service.close = async () => {
    dispose();
    await stopWorker(child);
  };
  return service;
}
