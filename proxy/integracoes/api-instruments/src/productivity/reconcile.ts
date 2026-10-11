/**
 * Reconciliation: status query + webhook validation/convergence (etapa 15).
 *
 * After an uncertain send, reconcile via the official status query before suggesting a
 * new attempt — never resend blindly. Webhooks validate HMAC-SHA256 over the raw body
 * with timestamp tolerance, dedup by (account, eventId), and converge by object
 * version/status: a stale event never un-does success or revocation, and no event ever
 * grants authorization.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import { prepareProductivityCall } from './operations.ts';
import { sendProductivityCall } from './transport.ts';

export interface TaskStatus {
  id: string;
  status: 'open' | 'done' | 'cancelled';
  version: number;
  updatedAt: string;
  title: string;
}

export interface ReconcileOptions {
  fetchFn?: typeof fetch;
  signal: AbortSignal;
  deadlineAt: string;
  bearer: string;
  maxOutputBytes: number;
}

function parseStatus(data: unknown): TaskStatus {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('productivity_status_invalid');
  const record = data as Record<string, unknown>;
  if (typeof record.id !== 'string' || !['open', 'done', 'cancelled'].includes(record.status as string) ||
    !Number.isSafeInteger(record.version) || typeof record.updatedAt !== 'string' ||
    !Number.isFinite(Date.parse(record.updatedAt)) || typeof record.title !== 'string') {
    throw new Error('productivity_status_invalid');
  }
  return record as unknown as TaskStatus;
}

/** Official status query after timeout/uncertainty. Returns the observed status or throws. */
export async function reconcileTaskStatus(accountId: string, id: string, options: ReconcileOptions): Promise<TaskStatus> {
  const prepared = prepareProductivityCall('get_task', { accountId, id });
  const outcome = await sendProductivityCall(prepared, { ...options, bearer: options.bearer });
  if (outcome.kind === 'failed') throw new Error(outcome.code);
  return parseStatus(outcome.data);
}

export interface WebhookEnvelope {
  eventId: string;
  accountId: string;
  taskId: string;
  status: TaskStatus['status'];
  version: number;
  updatedAt: string;
  timestamp: string;
}

export interface VerifiedWebhook {
  envelope: WebhookEnvelope;
  duplicate: boolean;
}

/** HMAC-SHA256 over the raw body. Any parse/sign/timestamp failure rejects the event. */
export function verifyTaskWebhook(
  rawBody: string,
  signatureHex: string,
  secret: string,
  seen: Set<string>,
  nowMs = Date.now(),
): VerifiedWebhook {
  const fail = (code: string): never => { throw new Error(code); };
  if (typeof rawBody !== 'string' || !rawBody || rawBody.length > 65_536) fail('webhook_body_invalid');
  if (!/^[a-f0-9]{64}$/i.test(signatureHex)) fail('webhook_signature_invalid');
  const expected = createHmac('sha256', secret).update(rawBody, 'utf8').digest();
  const actual = Buffer.from(signatureHex, 'hex');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) fail('webhook_signature_invalid');
  let envelope: WebhookEnvelope;
  try {
    const parsed = JSON.parse(rawBody) as Record<string, unknown>;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('webhook_envelope_invalid');
    for (const key of ['eventId', 'accountId', 'taskId', 'status', 'version', 'updatedAt', 'timestamp']) {
      if (!(key in parsed)) fail('webhook_envelope_invalid');
    }
    envelope = parsed as unknown as WebhookEnvelope;
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('webhook_')) throw error;
    fail('webhook_envelope_invalid');
  }
  if (!['open', 'done', 'cancelled'].includes(envelope!.status) || !Number.isSafeInteger(envelope!.version) ||
    !Number.isFinite(Date.parse(envelope!.timestamp)) || !Number.isFinite(Date.parse(envelope!.updatedAt))) {
    fail('webhook_envelope_invalid');
  }
  if (Math.abs(nowMs - Date.parse(envelope!.timestamp)) > 5 * 60_000) fail('webhook_timestamp_invalid');
  const key = `${envelope!.accountId}:${envelope!.eventId}`;
  if (seen.has(key)) return { envelope: envelope!, duplicate: true };
  seen.add(key);
  return { envelope: envelope!, duplicate: false };
}

export interface ConvergedStatus {
  status: TaskStatus['status'];
  version: number;
  updatedAt: string;
  /** True when the event carried nothing newer; the durable state stands. */
  stale: boolean;
}

/**
 * Converge a verified event into the durable projection. Higher version wins; equal
 * version keeps the newer timestamp; anything older is stale. Terminal states are never
 * reverted by an older event.
 */
export function convergeWebhookStatus(current: ConvergedStatus | null, event: WebhookEnvelope): ConvergedStatus {
  const incoming: ConvergedStatus = { status: event.status, version: event.version, updatedAt: event.updatedAt, stale: false };
  if (!current) return incoming;
  if (incoming.version > current.version) return incoming;
  if (incoming.version === current.version) {
    return Date.parse(incoming.updatedAt) > Date.parse(current.updatedAt) ? incoming : { ...current, stale: true };
  }
  return { ...current, stale: true };
}
