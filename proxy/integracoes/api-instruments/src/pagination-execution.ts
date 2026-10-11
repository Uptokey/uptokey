import { randomUUID } from 'node:crypto';
import type { RunJournal } from '../../../core/src/workspace/executor.ts';
import { markDispatched, prepareReceipt, settleReceipt } from '../../../core/src/workspace/receipts.ts';
import type { CapabilityDescriptor, ExecutionReceipt } from '@uptokey/sync-contract/workflow';
import { executeGovernedRead } from './governed-transport.ts';
import type { GovernedReadOutcome, PreparedApiCall } from './types.ts';
import type { PageExecutionContext } from './pagination.ts';

/**
 * Server-owned page executor for governed cursor pagination (C08, R13, R16).
 *
 * Each page is admitted as its own durable attempt receipt against the same
 * run/step, following the exact W3 lifecycle of the canonical executor:
 * prepare → dispatched → settle, all persisted through the journal's CAS.
 * The coordinator (`executeGovernedPagination`) receives the receipt id and
 * requires it; a page without a committed receipt never counts as a page.
 *
 * The outer step attempt is still admitted by the WorkflowExecutor; this
 * callback is meant to run inside the effect dispatcher of a paginated step.
 * Page receipts are appended to the run receipt list without touching
 * stepStates, so dependent bindings keep resolving only the outer aggregated
 * artifact. Cancellation of the run settles dispatched pages through the same
 * CAS this callback uses; the settle below is conflict-tolerant and never
 * reopens a cancelled run.
 */
export interface JournaledPageExecutorOptions {
  journal: RunJournal;
  principalId: string;
  projectId: string;
  runId: string;
  stepId: string;
  planDigest: string;
  capability: Pick<CapabilityDescriptor, 'id' | 'version'>;
  fetchFn?: typeof fetch;
  allowLoopbackForTesting?: boolean;
  newId?: () => string;
}

const COMMIT_RETRIES = 16;

/** Mirrors the canonical executor's outcome-to-receipt mapping (W3). */
function settleInputFor(outcome: GovernedReadOutcome, prepared: PreparedApiCall, now: string) {
  if (outcome.kind === 'completed') {
    return {
      kind: 'completed' as const,
      outputArtifactRefs: [] as string[],
      sources: [{
        id: `source_page_${prepared.operationId}`,
        sourceId: prepared.serviceId,
        externalId: prepared.url,
        title: `${prepared.serviceId}: ${prepared.operationId}`,
        url: prepared.url,
        retrievedAt: outcome.retrievedAt,
      }],
      usage: undefined,
      now,
    };
  }
  if (outcome.sent === 'no') return { kind: 'not_sent' as const, code: outcome.code, now };
  if (outcome.sent === 'yes') return { kind: 'failed' as const, code: outcome.code, usage: undefined, now };
  return { kind: 'unknown' as const, code: outcome.code, usage: undefined, now };
}

/**
 * Commits a page attempt through the journal CAS. Returns undefined when the
 * receipt was already settled externally (run cancellation/timeout) — the
 * caller must not retry or reopen the run in that case.
 */
async function commitPageReceipt(
  journal: RunJournal,
  projectId: string,
  runId: string,
  build: (record: { run: any; receipts: ExecutionReceipt[]; revision: number }) =>
    | { run: any; receipts: ExecutionReceipt[] } | undefined,
  expectedReceiptId: string,
): Promise<{ run: any; receipts: ExecutionReceipt[] } | undefined> {
  for (let attempt = 0; attempt < COMMIT_RETRIES; attempt += 1) {
    const current = await journal.read(projectId, runId);
    if (!current) return undefined;
    const settled = current.receipts.find((receipt) => receipt.id === expectedReceiptId);
    if (settled && !['prepared', 'dispatched'].includes(settled.status)) return undefined;
    const next = build(current as any);
    if (!next) return undefined;
    const result = await journal.commit(projectId, runId, current.revision, next);
    if (result.kind === 'committed') return result.record as any;
  }
  throw new Error('workflow_journal_conflict');
}

export function createJournaledPageExecutor(
  options: JournaledPageExecutorOptions,
): (prepared: PreparedApiCall, context: PageExecutionContext) => Promise<{ outcome: GovernedReadOutcome; receiptId: string }> {
  const newId = options.newId ?? randomUUID;
  return async (prepared, context) => {
    // Admission revalidation (W5/W1): the run must be active, owned by the
    // principal, bound to the signed plan digest, and contain this step.
    const record = await options.journal.read(options.projectId, options.runId);
    if (!record || record.run.status !== 'running' || record.run.principalId !== options.principalId || record.run.planDigest !== options.planDigest) {
      throw Object.assign(new Error('pagination_run_not_active'), { code: 'pagination_run_not_active', sent: 'no' });
    }
    if (!record.run.stepStates.some((state) => state.stepId === options.stepId)) {
      throw Object.assign(new Error('pagination_step_not_in_plan'), { code: 'pagination_step_not_in_plan', sent: 'no' });
    }
    if (context.signal.aborted) {
      throw Object.assign(new Error('pagination_cancelled_before_admission'), { code: 'api_cancelled', sent: 'no' });
    }

    const attemptId = newId();
    const receiptId = newId();
    const stamp = () => new Date().toISOString();

    // 1. prepare (intent persisted before any effect)
    const preparedCommit = await commitPageReceipt(options.journal, options.projectId, options.runId, (current) => {
      if (current.run.status !== 'running') return undefined;
      const at = stamp();
      const receipt = prepareReceipt({
        id: receiptId, projectId: options.projectId, runId: options.runId, stepId: options.stepId,
        attemptId, capability: { id: options.capability.id, version: options.capability.version },
        inputArtifactRefs: [], now: at,
      });
      return { run: { ...current.run, updatedAt: at }, receipts: [...current.receipts, receipt] };
    }, receiptId);
    if (!preparedCommit) throw Object.assign(new Error('pagination_run_not_active'), { code: 'pagination_run_not_active', sent: 'no' });

    // 2. dispatched (effect may leave the process)
    const dispatchedCommit = await commitPageReceipt(options.journal, options.projectId, options.runId, (current) => {
      const receipt = current.receipts.find((item) => item.id === receiptId);
      if (!receipt || receipt.status !== 'prepared' || current.run.status !== 'running') return undefined;
      const at = stamp();
      return { run: { ...current.run, updatedAt: at }, receipts: current.receipts.map((item) => item.id === receiptId ? markDispatched(receipt) : item) };
    }, receiptId);
    if (!dispatchedCommit) {
      // Never leave a prepared receipt dangling: if the run moved on, the
      // executor's cancellation settles it; otherwise settle not_sent here.
      await commitPageReceipt(options.journal, options.projectId, options.runId, (current) => {
        const receipt = current.receipts.find((item) => item.id === receiptId);
        if (!receipt || receipt.status !== 'prepared') return undefined;
        const at = stamp();
        return { run: { ...current.run, updatedAt: at }, receipts: current.receipts.map((item) => item.id === receiptId ? settleReceipt(receipt, { kind: 'not_sent', code: 'cancelled', now: at }) : item) };
      }, receiptId).catch(() => undefined);
      throw Object.assign(new Error('pagination_run_not_active'), { code: 'pagination_run_not_active', sent: 'yes' });
    }

    // 3. bounded read with the remaining page budget; deadline and signal stay active.
    const outcome = await executeGovernedRead(
      {
        ...prepared,
        limits: {
          ...prepared.limits,
          maxOutputBytes: Math.min(prepared.limits.maxOutputBytes, context.remainingBytes),
        },
      },
      {
        signal: context.signal,
        deadlineAt: context.deadlineAt,
        fetchFn: options.fetchFn,
        allowLoopbackForTesting: options.allowLoopbackForTesting,
      },
    );

    // 4. settle through the same CAS; a receipt already settled by a concurrent
    // cancellation/timeout is left untouched and never reopened.
    const settled = await commitPageReceipt(options.journal, options.projectId, options.runId, (current) => {
      const receipt = current.receipts.find((item) => item.id === receiptId);
      if (!receipt || receipt.status !== 'dispatched') return undefined;
      const at = stamp();
      return { run: { ...current.run, updatedAt: at }, receipts: current.receipts.map((item) => item.id === receiptId ? settleReceipt(receipt, settleInputFor(outcome, prepared, at) as any) : item) };
    }, receiptId);

    if (!settled) {
      // Receipt settled externally (run cancelled/expired mid-page): the page
      // outcome is discarded and never retried by the coordinator.
      throw Object.assign(new Error('pagination_receipt_externally_settled'), { code: 'pagination_receipt_externally_settled', sent: outcome.kind === 'failed' && outcome.sent === 'yes' ? 'yes' : 'no' });
    }

    return { outcome, receiptId };
  };
}
