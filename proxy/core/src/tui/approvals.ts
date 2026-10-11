/**
 * Uptokey TUI — approval actions bound to canonical plans.
 *
 * A UI gesture never manufactures an execution: approving requires a plan id
 * verified in the proxy, a stable operation id created before the first send
 * (reused after a lost ACK) and the native consent signature. Moved unchanged
 * in behaviour from the former monolithic App (B4-reparo regressions apply).
 */
import { randomUUID } from "node:crypto";
import { RUN_STATUSES } from "@uptokey/sync-contract/workflow";
import type { ApprovalRequest } from "./approval-types.ts";
import { t } from "./i18n.ts";

export interface BoundApprovalRequest extends ApprovalRequest {
  /** Bound by the local producer, never accepted from model arguments. */
  conversationRevision: number;
  projectId?: string;
  /** Stable operation identity, created before the first send and reused on retry. */
  requestId?: string;
  planDigest?: string;
  planRevision?: number;
  recovery?: boolean;
  /** Which canonical pathway this item belongs to. */
  toolKind?: "chat-plan" | "tool-call" | "tool-result" | "project-write";
  /** Durable proposal binding: only the server authorizes these. */
  artifactId?: string;
  callId?: string;
  sourceRunId?: string;
  /** User text of the turn, persisted canonically when the plan result settles. */
  userText?: string;
  /** Conversation intention that admits this run (sent as admission headers). */
  admission?: { conversationId: string; requestId: string };
  intentionMessageId?: string;
}

export type BoundRunRequest = BoundApprovalRequest & { runId: string; planId: string; projectId: string };

/** Shared by the overlay handlers: a UI gesture cannot manufacture an execution. */
export function createApprovalActions(options: {
  requests: () => readonly BoundApprovalRequest[];
  current: () => { conversationRevision: number; projectId?: string };
  /** Only the capabilities this module uses; the result is parsed as envelope or bare run. */
  workspace: {
    requestConsent(projectId: string, planId: string, sign: (nonce: string) => string, requestId?: string, admission?: { conversationId: string; requestId: string }): Promise<unknown>;
    cancelRun(projectId: string, runId: string): Promise<void>;
  } | null;
  sign?: (nonce: string) => string;
  beforeApprove: (request: BoundApprovalRequest) => Promise<{ allow: boolean; message?: string }>;
  remove: (id: string) => void;
  bindRun: (id: string, runId: string) => void;
  notice: (message: string) => void;
  observed: (request: BoundApprovalRequest, status: "running" | "done" | "error" | "rejected", result: string) => unknown;
  inFlight?: Set<string>;
  /** Stable operation ids for items that predate the current producer. */
  requestIds?: Map<string, string>;
  attention?: (request: BoundApprovalRequest) => void;
}) {
  const inFlight = options.inFlight ?? new Set<string>();
  const requestIds = options.requestIds ?? new Map<string, string>();
  const current = (request: BoundApprovalRequest): boolean => {
    const context = options.current();
    return request.conversationRevision === context.conversationRevision && request.projectId === context.projectId;
  };
  const approve = async (id: string): Promise<void> => {
    const request = options.requests().find(item => item.id === id);
    if (!request || inFlight.has(id) || !current(request)) return;
    if (request.runId) {
      options.notice(t("appr_already_running"));
      return;
    }
    if (!request.planId) {
      options.notice(t("appr_no_plan"));
      return;
    }
    if (!options.workspace || !request.projectId || !options.sign) {
      options.notice(t("appr_no_consent"));
      return;
    }
    inFlight.add(id);
    try {
      const hooks = await options.beforeApprove(request);
      if (!current(request)) return;
      if (!hooks.allow) { options.notice(hooks.message ?? t("appr_hook_denied")); return; }
      // The operation identity exists before the first send; a retry after a lost
      // ACK reuses it, so the journal can reconcile instead of authorizing twice.
      const requestId = request.requestId ?? requestIds.get(id) ?? randomUUID();
      requestIds.set(id, requestId);
      const result: unknown = await options.workspace.requestConsent(request.projectId, request.planId, options.sign, requestId, request.admission);
      if (!current(request)) return;
      const body = result && typeof result === "object" ? result as Record<string, unknown> : {};
      const run = body.run && typeof body.run === "object" ? body.run as Record<string, unknown> : body;
      if (typeof run.id !== "string" || !run.id || run.planId !== request.planId || typeof run.status !== "string"
        || !RUN_STATUSES.some(status => status === run.status)) {
        options.notice(t("appr_not_confirmed"));
        return;
      }
      const bound: BoundApprovalRequest = request.runId === run.id ? request : { ...request, runId: run.id, requestId };
      if (request.runId !== run.id) options.bindRun(id, run.id);
      if (!["running", "succeeded", "failed", "cancelled"].includes(run.status)) {
        options.notice(t("appr_run_not_done", { run: run.id, status: run.status }));
        if (run.status === "needs_attention") options.attention?.(bound);
        return;
      }
      const status = run.status === "succeeded" ? "done" : ["failed", "cancelled"].includes(run.status) ? "error" : "running";
      await options.observed(bound, status, `Run ${run.id}: ${run.status}`);
      if (current(request)) options.remove(id);
    } catch (error) {
      if (current(request)) options.notice(t("appr_consent_unconfirmed", { reason: error instanceof Error ? error.message : t("appr_connection_failed") }));
    } finally { inFlight.delete(id); }
  };
  const reject = async (id: string): Promise<void> => {
    const request = options.requests().find(item => item.id === id);
    if (!request || inFlight.has(id) || !current(request)) return;
    inFlight.add(id);
    try {
      if (request.runId) {
        if (!request.projectId || !options.workspace) throw new Error("proxy indisponível");
        await options.workspace.cancelRun(request.projectId, request.runId);
      }
      if (!current(request)) return;
      options.observed(request, "rejected", request.runId ? t("appr_cancel_requested") : t("appr_discarded"));
      options.remove(id);
    } catch (error) {
      if (current(request)) options.notice(t("appr_cancel_unconfirmed", { reason: error instanceof Error ? error.message : t("appr_connection_failed") }));
    } finally { inFlight.delete(id); }
  };
  return {
    approve, reject,
    approveAll: () => options.notice(t("appr_no_bulk")),
    approveForSession: () => options.notice(t("appr_no_session")),
    rejectAll: async () => { for (const request of [...options.requests()]) await reject(request.id); },
  };
}
