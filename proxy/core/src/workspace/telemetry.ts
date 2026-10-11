import { createHash } from 'node:crypto';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { projectDataArray } from '@uptokey/sync-contract/plain-data';
import { parseExecutionReceipt, parseRun, type ExecutionReceipt, type Run, type TokenUsage } from '@uptokey/sync-contract/workflow';
import { telemetryLeakReason } from '../scrub.ts';

type FinishedRunStatus = 'succeeded' | 'failed' | 'cancelled';
type FinishedAttemptStatus = 'succeeded' | 'failed' | 'unknown';
/**
 * Canonical low-cardinality telemetry families. Static executable capabilities
 * keep their own id; dynamic families (`inference.report.<provider>`,
 * curated `api.*` reads) collapse to one family each so provider/operation
 * identity never becomes a high-cardinality attribute.
 */
export type TelemetryCapability =
  | 'inference.chat.9router' | 'inference.report.v1'
  | 'inference.speech.9router' | 'inference.transcription.9router' | 'inference.image.9router' | 'inference.video.9router'
  | 'inference.typesafe.intent'
  | 'video.job.poll' | 'video.content.read'
  | 'browser.page.inspect' | 'browser.form.fill'
  | 'filesystem.metadata.inspect' | 'filesystem.text.read'
  | 'artifacts.markdown.create'
  | 'sources.crossref.search' | 'sources.open-library.search' | 'api.rss.read'
  | 'api.read_external.v1';

export interface RunTelemetryAttributes {
  readonly 'quimera.run.correlation_id': string;
  readonly 'quimera.run.status': FinishedRunStatus;
}
export interface AttemptTelemetryAttributes {
  readonly 'quimera.run.correlation_id': string;
  readonly 'quimera.attempt.status': FinishedAttemptStatus;
  readonly 'quimera.capability': TelemetryCapability;
  readonly 'quimera.usage.basis': TokenUsage['basis'];
  readonly 'quimera.usage.input_tokens'?: number;
  readonly 'quimera.usage.output_tokens'?: number;
  readonly 'quimera.usage.cached_input_tokens'?: number;
}

/** Neutral data for a future manual-span SDK adapter, not an OTLP wire payload or SDK Span. */
export interface WorkspaceTelemetrySpan {
  readonly name: 'quimera.run' | 'quimera.inference.chat' | 'quimera.inference.speech' | 'quimera.inference.transcription' | 'quimera.inference.image' |
    'quimera.inference.video' | 'quimera.inference.intent' | 'quimera.video.poll' | 'quimera.video.read' |
    'quimera.browser.read' | 'quimera.browser.write' | 'quimera.filesystem.read' | 'quimera.artifact.create' |
    'quimera.source.read' | 'quimera.api.read';
  readonly traceId: string;
  readonly spanId: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly attributes: Readonly<RunTelemetryAttributes | AttemptTelemetryAttributes>;
}

const names: Readonly<Record<TelemetryCapability, WorkspaceTelemetrySpan['name']>> = Object.freeze({
  'inference.chat.9router': 'quimera.inference.chat',
  'inference.report.v1': 'quimera.inference.chat',
  'inference.speech.9router': 'quimera.inference.speech',
  'inference.transcription.9router': 'quimera.inference.transcription',
  'inference.image.9router': 'quimera.inference.image',
  'inference.video.9router': 'quimera.inference.video',
  'inference.typesafe.intent': 'quimera.inference.intent',
  'video.job.poll': 'quimera.video.poll',
  'video.content.read': 'quimera.video.read',
  'browser.page.inspect': 'quimera.browser.read',
  'browser.form.fill': 'quimera.browser.write',
  'filesystem.metadata.inspect': 'quimera.filesystem.read',
  'filesystem.text.read': 'quimera.filesystem.read',
  'artifacts.markdown.create': 'quimera.artifact.create',
  'sources.crossref.search': 'quimera.source.read',
  'sources.open-library.search': 'quimera.source.read',
  'api.rss.read': 'quimera.source.read',
  'api.read_external.v1': 'quimera.api.read',
});
/** Exported so the OTLP serializer validates exactly the same closed set. */
export const TELEMETRY_SPAN_NAMES: Readonly<Record<string, string>> = names;
/**
 * Project only validated, linked journal records; parsing is not evidence of admission or persistence.
 * The caller must supply an already committed record and isolate projection/export failures from execution.
 * Every attempt is an independent root trace. It never depends on a run finishing and is never reparented.
 * A finished run has a separate summary trace; W0 needs_attention has no finishedAt, so no end is invented.
 * Hashes provide scoped correlation, not encryption or a guarantee of anonymity for predictable identifiers.
 */
export function projectExecutionSpans(runInput: unknown, receiptsInput: unknown): readonly WorkspaceTelemetrySpan[] {
  try {
    const run = parseRun(runInput);
    // Bound by W0-validated references: at most 12 steps with 256 unique refs each, not 256 per run.
    const maximum = run.stepStates.reduce((count, step) => count + Math.min(step.receiptIds.length, step.attemptIds.length), 0);
    const entries = projectDataArray(receiptsInput, maximum);
    if (!entries) throw invalid();
    const receipts = entries.map(parseExecutionReceipt);
    validateLinks(run, receipts);
    const scope = [run.principalId, run.projectId, run.id];
    const correlationId = deriveId('run.correlation', scope, 64);
    const spans: WorkspaceTelemetrySpan[] = [];
    if (run.finishedAt !== null && isFinishedRun(run.status)) {
      spans.push(Object.freeze({ name: 'quimera.run', traceId: deriveId('run.trace', scope, 32), spanId: deriveId('run.span', scope, 16),
        startedAt: run.createdAt, finishedAt: run.finishedAt,
        attributes: Object.freeze({ 'quimera.run.correlation_id': correlationId, 'quimera.run.status': run.status }),
      }));
    }
    for (const receipt of receipts) {
      const family = resolveTelemetryCapability(receipt.capabilityId, receipt.capabilityVersion);
      if (!family || receipt.finishedAt === null || !isFinishedAttempt(receipt.status)) continue;
      const attributes: AttemptTelemetryAttributes = {
        'quimera.run.correlation_id': correlationId,
        'quimera.attempt.status': receipt.status,
        'quimera.capability': family,
        'quimera.usage.basis': receipt.usage.basis,
        // Estimates remain identifiable as estimates; only measured counts are exported.
        ...(receipt.usage.basis === 'provider_reported' ? measuredTokens(receipt.usage) : {}),
      };
      const attemptScope = [...scope, receipt.stepId, receipt.attemptId];
      spans.push(Object.freeze({ name: names[family], traceId: deriveId('attempt.trace', attemptScope, 32),
        spanId: deriveId('attempt.span', attemptScope, 16),
        startedAt: receipt.startedAt, finishedAt: receipt.finishedAt, attributes: Object.freeze(attributes),
      }));
    }
    // Fixed fields are the primary boundary; the existing detector is an additional fail-closed check.
    // Serialize per span: batching belongs to the exporter, and canonicalJson bounds individual arrays to 1024.
    if (spans.some(span => telemetryLeakReason(canonicalJson(span)))) throw invalid();
    return Object.freeze(spans);
  } catch {
    // Never include original fields or validator exception text in the observable failure.
    throw invalid();
  }
}

function measuredTokens(usage: TokenUsage): Partial<AttemptTelemetryAttributes> {
  return {
    ...(usage.inputTokens !== null ? { 'quimera.usage.input_tokens': usage.inputTokens } : {}),
    ...(usage.outputTokens !== null ? { 'quimera.usage.output_tokens': usage.outputTokens } : {}),
    ...(usage.cachedInputTokens !== null ? { 'quimera.usage.cached_input_tokens': usage.cachedInputTokens } : {}),
  };
}

function validateLinks(run: Run, receipts: readonly ExecutionReceipt[]): void {
  const receiptIds = new Set<string>(), attemptIds = new Set<string>();
  for (const receipt of receipts) {
    const step = run.stepStates.find(item => item.stepId === receipt.stepId);
    if (receipt.projectId !== run.projectId || receipt.runId !== run.id || !step ||
        !step.receiptIds.includes(receipt.id) || !step.attemptIds.includes(receipt.attemptId) ||
        receiptIds.has(receipt.id) || attemptIds.has(receipt.attemptId)) throw invalid();
    receiptIds.add(receipt.id);
    attemptIds.add(receipt.attemptId);
  }
}

function deriveId(domain: string, scope: readonly string[], length: 16 | 32 | 64): string {
  let nonce = 0, id: string;
  do {
    id = createHash('sha256').update(canonicalJson(['quimera.telemetry.v1', domain, scope, nonce++])).digest('hex').slice(0, length);
  } while (/^0+$/.test(id));
  return id;
}
function isFinishedRun(status: Run['status']): status is FinishedRunStatus {
  return status === 'succeeded' || status === 'failed' || status === 'cancelled';
}
function isFinishedAttempt(status: ExecutionReceipt['status']): status is FinishedAttemptStatus {
  return status === 'succeeded' || status === 'failed' || status === 'unknown';
}
function isCapability(value: string): value is TelemetryCapability { return Object.hasOwn(names, value); }
/**
 * Canonical family for a receipt capability. Static executable ids keep their
 * own family; per-provider reports (`inference.report.<provider>`) and the
 * curated read-only `api.*` operations collapse to one family each so neither
 * provider nor operation identity becomes a high-cardinality attribute.
 * Unknown ids and non-v1 versions are not projected (fail-closed).
 */
export function resolveTelemetryCapability(capabilityId: string, capabilityVersion: number): TelemetryCapability | undefined {
  if (capabilityVersion !== 1 || typeof capabilityId !== "string") return undefined;
  if (isCapability(capabilityId)) return capabilityId;
  if (capabilityId.startsWith("inference.report.")) {
    const provider = capabilityId.slice("inference.report.".length);
    if (/^[A-Za-z0-9_-]{1,64}$/.test(provider)) return "inference.report.v1";
    return undefined;
  }
  // Curated read-only API family. Every operation in the catalog is admitted
  // only as read_external (pinned by test); a future write operation must
  // narrow this pattern before it can be projected.
  if (/^api\.[a-z0-9_]+(\.[a-z0-9_]+)+$/.test(capabilityId)) return "api.read_external.v1";
  return undefined;
}
function invalid(): Error { return new Error('workspace_telemetry_invalid_record'); }
