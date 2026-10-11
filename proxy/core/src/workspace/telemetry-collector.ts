import { Agent } from 'node:http';
import { ExportResultCode } from '@opentelemetry/core';
import type { ReadableSpan } from '@opentelemetry/sdk-trace';
import { OTLPExporterBase } from '@opentelemetry/otlp-exporter-base';
import { createOtlpHttpExportDelegate } from '@opentelemetry/otlp-exporter-base/node-http';
import { JsonTraceSerializer, TraceExporterMetricsHelper } from '@opentelemetry/otlp-transformer';
import { asDataRecord, projectDataArray } from '@uptokey/sync-contract/plain-data';
import {
  readableSpan, WORKSPACE_TELEMETRY_MAX_BATCH, WORKSPACE_TELEMETRY_MAX_BYTES, type WorkspaceTelemetryExporter,
} from './telemetry-exporter.ts';

/**
 * collector-local profile: OTLP/HTTP JSON to an OpenTelemetry Collector on loopback, without any
 * credential, Langfuse header or environment inheritance. Same official SDK serializer/transport,
 * limits, ACK validation and sequential shutdown as the Langfuse profile. This is not a new OTLP
 * encoder or HTTP client: only the endpoint policy and the (empty) credential closure differ.
 */
export interface CollectorTelemetryExporterOptions {
  readonly endpoint: string;
  readonly timeoutMillis?: number;
}

export function createCollectorTelemetryExporter(options: CollectorTelemetryExporterOptions): WorkspaceTelemetryExporter {
  let endpoint: string;
  const timeoutMillis = options.timeoutMillis ?? 2000;
  try {
    const url = new URL(options.endpoint);
    if (url.href !== options.endpoint || url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port ||
      url.username || url.password || url.search || url.hash || url.pathname !== '/v1/traces' ||
      !Number.isInteger(timeoutMillis) || timeoutMillis < 50 || timeoutMillis > 30_000) throw new Error();
    endpoint = url.href;
  } catch { throw new Error('collector_telemetry_export_config_invalid'); }
  let closed = false, active: AbortController | null = null, activeFinished: Promise<void> | undefined;
  const cleanups = new Set<Promise<void>>();
  let closing: Promise<void> | undefined;
  return {
    async export(input) {
      if (closed || active || cleanups.size) return false;
      let spans: ReadableSpan[];
      try {
        const batch = projectDataArray(input, WORKSPACE_TELEMETRY_MAX_BATCH);
        if (!batch) return false;
        spans = batch.map(readableSpan);
        if (spans.length === 0) return true;
        const body = JsonTraceSerializer.serializeRequest(spans);
        if (!body || body.byteLength > WORKSPACE_TELEMETRY_MAX_BYTES) return false;
      } catch { return false; }
      const controller = new AbortController(); active = controller;
      let finishActive!: () => void;
      activeFinished = new Promise<void>(resolve => { finishActive = resolve; });
      const agent = new Agent({ keepAlive: false, maxSockets: 1, maxTotalSockets: 1 });
      const abort = () => agent.destroy(); controller.signal.addEventListener('abort', abort, { once: true });
      let sdk: OTLPExporterBase<ReadableSpan[]> | undefined, rejected = false, sdkFinished = false;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const deadline = new Promise<boolean>(resolve => {
          controller.signal.addEventListener('abort', () => resolve(false), { once: true });
          timer = setTimeout(() => controller.abort(), timeoutMillis);
        });
        const operation = (async () => {
          try {
            const delegate = createOtlpHttpExportDelegate({
              url: endpoint, timeoutMillis, concurrencyLimit: 1, compression: 'none', agentFactory: () => agent,
              headers: async () => {
                if (closed || controller.signal.aborted) throw new Error('collector_telemetry_export_unavailable');
                // No Authorization, no vendor ingestion header, no OTEL_* merge: loopback Collector only.
                return { 'Content-Type': 'application/json' };
              },
            }, {
              serializeRequest: JsonTraceSerializer.serializeRequest,
              deserializeResponse: data => {
                // Keep only acceptance, never response text; partial rejection is a failure.
                try {
                  if (data.byteLength > 4096) throw new Error();
                  if (data.byteLength) JSON.parse(new TextDecoder().decode(data));
                  const response = asDataRecord(JsonTraceSerializer.deserializeResponse(data));
                  if (!response || Object.keys(response).some(key => key !== 'partialSuccess')) throw new Error();
                  if (response.partialSuccess !== undefined) {
                    const partial = asDataRecord(response.partialSuccess);
                    if (!partial || Object.keys(partial).some(key => !['rejectedSpans', 'errorMessage'].includes(key)) ||
                      ![undefined, 0, '0'].includes(partial.rejectedSpans as number | string | undefined)) rejected = true;
                  }
                } catch { rejected = true; }
                return {};
              },
            }, 'otlp_http_span_exporter', TraceExporterMetricsHelper, undefined);
            sdk = new OTLPExporterBase(delegate);
            return await new Promise<boolean>(resolve => {
              try { sdk!.export(spans, result => { sdkFinished = true; resolve(!closed && !controller.signal.aborted && !rejected && result.code === ExportResultCode.SUCCESS); }); }
              catch { resolve(false); }
            });
          } catch { return false; }
        })();
        return await Promise.race([operation, deadline]);
      } finally {
        clearTimeout(timer); controller.abort();
        if (sdk) {
          const cleanup = sdk.shutdown().catch(() => undefined);
          cleanups.add(cleanup); void cleanup.finally(() => cleanups.delete(cleanup));
          if (sdkFinished) await cleanup;
        }
        if (active === controller) active = null;
        finishActive(); activeFinished = undefined;
      }
    },
    shutdown() {
      if (closing) return closing;
      closed = true; const pending = activeFinished; active?.abort();
      closing = (async () => { await pending; await Promise.all([...cleanups]); })();
      return closing;
    },
  };
}

/** Minimal outbox surface the runtime needs; the real WorkspaceTelemetryOutbox satisfies it. */
export interface CollectorRuntimeOutbox {
  flushProject(identityId: string, projectId: string): Promise<boolean>;
  close(): Promise<void>;
}
export interface CollectorRuntimeTarget { readonly identityId: string; readonly projectId: string; }
export interface CollectorRuntimeDiagnostics {
  readonly notified: number;
  readonly attempted: number;
  readonly retries: number;
  readonly delivered: number;
  readonly failures: number;
  readonly droppedOverflow: number;
  readonly droppedExpired: number;
  readonly droppedExhausted: number;
  readonly lastFailureAt: string | null;
}
export interface CollectorRuntimeOptions {
  readonly outbox: CollectorRuntimeOutbox;
  readonly listTargets: () => Promise<readonly CollectorRuntimeTarget[]>;
  readonly maxAttempts?: number;
  readonly baseDelayMillis?: number;
  readonly maxDelayMillis?: number;
  readonly maxQueueItems?: number;
  readonly maxEntryAgeMillis?: number;
  readonly now?: () => number;
  readonly sleep?: (millis: number) => Promise<void>;
}
export interface CollectorRuntime {
  notify(identityId: string, projectId: string): void;
  resume(): Promise<void>;
  diagnostics(): CollectorRuntimeDiagnostics;
  close(): Promise<void>;
}

/**
 * Bounded recoverable forwarding on top of the journal-backed outbox. The encrypted journal stays
 * the durable source; this queue is only wakeup state with item/age/attempt limits, backoff and
 * metadata-only diagnostics. It never calls the executor and never throws into execution.
 * close() waits for the in-flight flush and at most one in-progress backoff interval.
 */
export function createCollectorRuntime(options: CollectorRuntimeOptions): CollectorRuntime {
  const maxAttempts = options.maxAttempts ?? 4;
  const baseDelayMillis = options.baseDelayMillis ?? 250;
  const maxDelayMillis = options.maxDelayMillis ?? 5000;
  const maxQueueItems = options.maxQueueItems ?? 128;
  const maxEntryAgeMillis = options.maxEntryAgeMillis ?? 600_000;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (millis => new Promise<void>(resolve => setTimeout(resolve, millis)));
  if (!options.outbox || typeof options.outbox.flushProject !== 'function' || typeof options.listTargets !== 'function' ||
    ![maxAttempts, baseDelayMillis, maxDelayMillis, maxQueueItems, maxEntryAgeMillis].every(value => Number.isInteger(value) && value > 0) ||
    maxAttempts > 16 || baseDelayMillis > maxDelayMillis || maxDelayMillis > 60_000 ||
    maxQueueItems > 1024 || maxEntryAgeMillis > 86_400_000) throw new Error('collector_runtime_config_invalid');
  interface Entry { readonly identityId: string; readonly projectId: string; readonly enqueuedAt: number; attempts: number; nextAttemptAt: number; generation: number; }
  const queue = new Map<string, Entry>();
  const counters = {
    notified: 0, attempted: 0, retries: 0, delivered: 0, failures: 0,
    droppedOverflow: 0, droppedExpired: 0, droppedExhausted: 0, lastFailureAt: null as string | null,
  };
  let closed = false, pumping: Promise<void> | undefined, closing: Promise<void> | undefined;
  const pump = async (): Promise<void> => {
    while (!closed) {
      const at = now();
      let due: Entry | undefined, earliest: number | undefined;
      for (const entry of queue.values()) {
        if (entry.nextAttemptAt <= at) { if (!due || entry.nextAttemptAt < due.nextAttemptAt) due = entry; }
        else earliest = earliest === undefined ? entry.nextAttemptAt : Math.min(earliest, entry.nextAttemptAt);
      }
      if (!due) {
        if (earliest === undefined) return;
        await sleep(Math.max(0, earliest - now()));
        continue;
      }
      const key = `${due.identityId}:${due.projectId}`;
      if (at - due.enqueuedAt > maxEntryAgeMillis) { queue.delete(key); counters.droppedExpired++; continue; }
      counters.attempted++;
      const generation = due.generation;
      let ok = false;
      try { ok = await options.outbox.flushProject(due.identityId, due.projectId); } catch { ok = false; }
      if (ok) {
        counters.delivered++;
        if (due.generation === generation) queue.delete(key);
        else { due.attempts = 0; due.nextAttemptAt = now(); }
        continue;
      }
      counters.failures++; counters.lastFailureAt = new Date(now()).toISOString();
      due.attempts++;
      if (due.attempts >= maxAttempts) { queue.delete(key); counters.droppedExhausted++; continue; }
      counters.retries++;
      due.nextAttemptAt = now() + Math.min(maxDelayMillis, baseDelayMillis * 2 ** (due.attempts - 1));
    }
  };
  const kick = (): void => {
    if (closed || pumping) return;
    pumping = (async () => {
      try { await pump(); } catch { /* Telemetry never throws into execution. */ }
      pumping = undefined;
      if (!closed) {
        for (const entry of queue.values()) if (entry.nextAttemptAt <= now()) { kick(); break; }
      }
    })();
  };
  const notify = (identityId: string, projectId: string): void => {
    if (closed || typeof identityId !== 'string' || typeof projectId !== 'string' || !identityId || !projectId) return;
    const key = `${identityId}:${projectId}`, existing = queue.get(key);
    if (existing) { existing.generation++; existing.nextAttemptAt = now(); kick(); return; }
    // Overflow only loses a wakeup: the journal remains the durable source and resume rediscovers it.
    if (queue.size >= maxQueueItems) { counters.droppedOverflow++; return; }
    counters.notified++;
    queue.set(key, { identityId, projectId, enqueuedAt: now(), attempts: 0, nextAttemptAt: now(), generation: 0 });
    kick();
  };
  return {
    notify,
    async resume() {
      if (closed) return;
      let targets: readonly CollectorRuntimeTarget[];
      try { targets = await options.listTargets(); } catch { return; }
      for (const target of targets) { if (closed) break; notify(target.identityId, target.projectId); }
    },
    diagnostics() { return Object.freeze({ ...counters }); },
    close() {
      if (closing) return closing;
      closed = true;
      closing = (async () => {
        await pumping;
        queue.clear();
        try { await options.outbox.close(); } catch { /* No exception text is logged. */ }
      })();
      return closing;
    },
  };
}

