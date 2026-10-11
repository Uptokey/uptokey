/**
 * Bounded productivity transport (etapa 15). POST/GET with vault bearer, same-origin
 * enforcement, byte/timeout caps. Errors never echo secrets, tokens or response bodies.
 */
import type { PreparedProductivityCall } from './operations.ts';
import { PROD_TASKS_SERVER_URL } from './tasks-spec.ts';

export interface ProductivityTransportOptions {
  fetchFn?: typeof fetch;
  signal: AbortSignal;
  deadlineAt: string;
  /** Resolved from the vault at dispatch; never logged or persisted. */
  bearer: string;
  /** Extra idempotency key for POST; absent for reads. */
  idempotencyKey?: string;
  maxOutputBytes: number;
  /** Supplied only by the server's admitted operation descriptor. */
  allowedOrigin?:string;
}

export type ProductivityTransportOutcome =
  | { kind: 'completed'; status: number; data: unknown; byteLength: number }
  | { kind: 'failed'; code: string; sent: 'yes' | 'no' | 'unknown'; httpStatus?: number };

function failed(code: string, sent: 'yes' | 'no' | 'unknown', httpStatus?: number): ProductivityTransportOutcome {
  return httpStatus === undefined ? { kind: 'failed', code, sent } : { kind: 'failed', code, sent, httpStatus };
}

export async function sendProductivityCall(
  prepared: PreparedProductivityCall,
  options: ProductivityTransportOptions,
): Promise<ProductivityTransportOutcome> {
  const allowedOrigin=options.allowedOrigin??PROD_TASKS_SERVER_URL;
  if (!prepared.url.startsWith(`${allowedOrigin}/`) || prepared.origin !== allowedOrigin) {
    return failed('unadmitted_destination_origin', 'no');
  }
  let url: URL;
  try {
    url = new URL(prepared.url);
  } catch {
    return failed('productivity_url_invalid', 'no');
  }
  if (url.username || url.password || url.hash) return failed('productivity_url_invalid', 'no');
  if (options.signal.aborted) return failed('productivity_cancelled', 'no');
  const deadline = Date.parse(options.deadlineAt);
  if (!Number.isFinite(deadline) || deadline <= Date.now()) return failed('productivity_deadline_exceeded', 'no');
  if (!Number.isSafeInteger(options.maxOutputBytes) || options.maxOutputBytes < 1 || options.maxOutputBytes > 1024 * 1024) {
    return failed('productivity_limits_invalid', 'no');
  }
  if (!options.bearer || options.bearer.length > 4096) return failed('productivity_credential_missing', 'no');

  const headers: Record<string, string> = {
    accept: 'application/json',
    authorization: `Bearer ${options.bearer}`,
  };
  let bodyText: string | undefined;
  if (prepared.method === 'POST') {
    headers['content-type'] = 'application/json';
    if (options.idempotencyKey) headers['idempotency-key'] = options.idempotencyKey;
    try {
      bodyText = JSON.stringify(prepared.body ?? {});
    } catch {
      return failed('productivity_body_invalid', 'no');
    }
    if (bodyText.length > 65_536) return failed('productivity_body_too_large', 'no');
  }
  const fetchFn = options.fetchFn ?? fetch;
  let response: Response;
  try {
    response = await fetchFn(prepared.url, {
      method: prepared.method,
      headers,
      body: bodyText,
      signal: options.signal,
      redirect: 'error',
    });
  } catch (error) {
    // Past initiation the outcome is uncertain even on abort: the bytes may have left.
    // Only the explicit pre-send checks above return 'no'.
    void error;
    return failed('productivity_transport_failed', 'unknown');
  }
  if (options.signal.aborted) return failed('productivity_cancelled', 'unknown');
  const status = response.status;
  if (status === 401 || status === 403) {
    await response.body?.cancel().catch(() => undefined);
    return failed('productivity_forbidden', status === 401 ? 'no' : 'unknown', status);
  }
  if (status === 409) {
    await response.body?.cancel().catch(() => undefined);
    return failed('productivity_idempotent_replay', 'unknown', status);
  }
  if (status === 422) {
    await response.body?.cancel().catch(() => undefined);
    return failed('productivity_rejected', 'unknown', status);
  }
  if (status === 429) {
    await response.body?.cancel().catch(() => undefined);
    return failed('productivity_quota_exhausted', 'unknown', status);
  }
  if (status < 200 || status >= 300) {
    await response.body?.cancel().catch(() => undefined);
    return failed('productivity_failed', 'unknown', status);
  }
  try {
    const reader = response.body?.getReader();
    if (!reader) return failed('productivity_empty_body', 'yes');
    const chunks: Uint8Array[] = [];
    let received = 0;
    for (;;) {
      if (options.signal.aborted) {
        try { await reader.cancel(); } catch { /* already settled */ }
        return failed('productivity_cancelled', 'unknown');
      }
      const { done, value } = await reader.read();
      if (done) break;
      received += value.byteLength;
      if (received > options.maxOutputBytes) {
        try { await reader.cancel(); } catch { /* already settled */ }
        return failed('productivity_response_too_large', 'yes');
      }
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const text = bytes.toString('utf8');
    if (!text.trim()) return failed('productivity_empty_body', 'yes');
    return { kind: 'completed', status, data: JSON.parse(text), byteLength: bytes.length };
  } catch {
    return failed('productivity_body_unreadable', 'unknown');
  }
}
