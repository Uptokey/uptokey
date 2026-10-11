import type { CuratedOperation, PreparedApiCall, GovernedReadOutcome } from './types.ts';
import { prepareApiCall, reconstructPreparedArguments } from './governed-transport.ts';

export interface PageExecutionContext {
  pageIndex: number;
  remainingBytes: number;
  deadlineAt: string;
  signal: AbortSignal;
}

export interface PaginationOptions {
  maxPages?: number;
  signal?: AbortSignal;
  deadlineAt?: string;
  /** Server-owned callback: admit through W5 and commit a real receipt.
   * Cache lookup belongs inside it, after authorization and policy validation.
   * Bounded transport must obey remainingBytes/deadlineAt/signal. */
  executePage: (prepared: PreparedApiCall, context: PageExecutionContext) => Promise<{ outcome: GovernedReadOutcome; receiptId: string }>;
}

export interface PageReceipt {
  receiptId: string;
  pageIndex: number;
  cursor: string | null;
  bytes: number | null;
  retrievedAt: string | null;
  callDigest: string;
  status: 'completed' | 'failed';
  cached: boolean;
}

export interface PaginatedReadResult {
  pages: unknown[];
  pageCount: number;
  totalBytes: number;
  completed: boolean;
  reason: 'completed' | 'max_pages_reached' | 'max_bytes_reached' | 'timeout' | 'cancelled' | 'error';
  error?: string;
  receipts: PageReceipt[];
}

/** Coordinates admitted reads; it has no HTTP client, cache bypass, or authority of its own. */
export async function executeGovernedPagination(operation: CuratedOperation, basePrepared: PreparedApiCall, options: PaginationOptions): Promise<PaginatedReadResult> {
  const pages: unknown[] = [];
  const receipts: PageReceipt[] = [];
  let totalBytes = 0;
  const finish = (reason: PaginatedReadResult['reason'], error?: string): PaginatedReadResult => ({ pages, pageCount: pages.length, totalBytes, completed: reason === 'completed', reason, ...(error ? { error } : {}), receipts });
  const { maxCalls, maxOutputBytes, timeoutMs } = basePrepared.limits;
  if (![maxCalls, maxOutputBytes, timeoutMs, options?.maxPages ?? 1].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value > 0) || typeof options?.executePage !== 'function') return finish('error', 'pagination_invalid_limits_or_executor');
  const suppliedDeadline = options.deadlineAt === undefined ? Infinity : Date.parse(options.deadlineAt);
  if (Number.isNaN(suppliedDeadline)) return finish('error', 'pagination_invalid_deadline');
  const deadlineAtMs = Math.min(Date.now() + timeoutMs, suppliedDeadline);
  if (options.signal?.aborted) return finish('cancelled');
  if (deadlineAtMs <= Date.now()) return finish('timeout');
  const controller = new AbortController();
  const cancel = () => controller.abort(options.signal?.reason);
  options.signal?.addEventListener('abort', cancel, { once: true });
  const timer = setTimeout(() => controller.abort(new Error('pagination_timeout')), deadlineAtMs - Date.now());
  const maxPages = operation.pagination ? Math.min(maxCalls, options.maxPages ?? maxCalls) : 1;
  const seen = new Set<string>();
  try {
    const baseArguments = reconstructPreparedArguments(operation, basePrepared);
    const rebuiltBase = prepareApiCall(operation, baseArguments);
    if (rebuiltBase.callDigest !== basePrepared.callDigest || rebuiltBase.url !== basePrepared.url) return finish('error', 'pagination_prepared_binding_mismatch');
    const contract = operation.pagination;
    let cursor = contract ? (baseArguments[contract.cursorParameter] ?? contract.initialCursor) : undefined;
    for (let pageIndex = 0; pageIndex < maxPages; pageIndex++) {
      if (options.signal?.aborted) return finish('cancelled');
      if (Date.now() >= deadlineAtMs) return finish('timeout');
      if (totalBytes >= maxOutputBytes!) return finish('max_bytes_reached');
      const cursorKey = cursor === undefined ? '<initial>' : JSON.stringify(cursor);
      if (seen.has(cursorKey)) return finish('error', 'pagination_cursor_loop');
      seen.add(cursorKey);
      const args = { ...baseArguments };
      if (contract && cursor !== undefined) args[contract.cursorParameter] = cursor;
      const prepared = contract ? prepareApiCall(operation, args) : basePrepared;
      // Preserve signed limits/digest; the remaining budget is an additional restriction.
      const { outcome, receiptId } = await options.executePage(prepared, { pageIndex, remainingBytes: maxOutputBytes! - totalBytes, deadlineAt: new Date(deadlineAtMs).toISOString(), signal: controller.signal });
      if (typeof receiptId !== 'string' || !receiptId) return finish('error', 'pagination_durable_receipt_required');
      receipts.push({ receiptId, pageIndex, cursor: cursor === undefined ? null : String(cursor), bytes: outcome.kind === 'completed' ? outcome.byteLength : null, retrievedAt: outcome.kind === 'completed' ? outcome.retrievedAt : null, callDigest: prepared.callDigest, status: outcome.kind, cached: outcome.kind === 'completed' && outcome.cached === true });
      if (outcome.kind === 'failed') {
        return finish(outcome.code === 'api_timeout' ? 'timeout' : outcome.code === 'api_cancelled' ? 'cancelled' : outcome.code === 'api_response_too_large' ? 'max_bytes_reached' : 'error', outcome.code);
      }
      if (!Number.isSafeInteger(outcome.byteLength) || outcome.byteLength < 0 || outcome.byteLength > maxOutputBytes! - totalBytes) return finish('max_bytes_reached', 'pagination_executor_exceeded_remaining_bytes');
      if (outcome.origin !== prepared.origin || outcome.operation !== prepared.operationId) return finish('error', 'pagination_outcome_binding_mismatch');
      totalBytes += outcome.byteLength;
      pages.push(outcome.data);
      if (options.signal?.aborted) return finish('cancelled');
      if (Date.now() >= deadlineAtMs) return finish('timeout');
      if (!contract) return finish('completed');
      let next: unknown = outcome.data;
      for (const part of contract.nextCursorPath) {
        next = next && typeof next === 'object' && Object.hasOwn(next, part) ? (next as Record<string, unknown>)[part] : undefined;
      }
      // Null is the endpoint's explicit end marker. Missing metadata is incomplete.
      if (next === null) return finish('completed');
      if ((typeof next !== 'string' && typeof next !== 'number') || next === '' || (typeof next === 'number' && !Number.isFinite(next))) return finish('error', 'pagination_missing_or_invalid_next_cursor');
      cursor = next;
    }
    return finish('max_pages_reached');
  } catch (err) {
    if (options.signal?.aborted) return finish('cancelled');
    if (Date.now() >= deadlineAtMs) return finish('timeout');
    return finish('error', err instanceof Error ? err.message : 'pagination_executor_failed');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', cancel);
  }
}
