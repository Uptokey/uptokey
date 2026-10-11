/**
 * Uptokey TUI — governed editor save.
 *
 * The editor never writes a file directly and never reports success without a
 * confirmed proxy receipt. The canonical path is: project-agent write plan →
 * P256 consent (consent/complete starts the run) → bounded observation of the
 * exact admitted run → succeeded receipt for this plan. A failed, refused,
 * cancelled, partial or unreconciled attempt keeps the buffer modified.
 */
import { createHash, randomUUID } from "node:crypto";
import { relative, resolve } from "node:path";
import { WorkspaceServiceError, type Plan, type RunCommand, type WorkspaceView } from "./workspace.ts";

export interface EditorSaveDeps {
  createWritePlan(projectId: string, rootBindingId: string, changes: Array<{ path: string; content: string; type?: "create" | "replace"; expectedSha256?: string }>): Promise<Plan>;
  approveAndStart(projectId: string, command: RunCommand, signFn: (nonce: string) => string): Promise<WorkspaceView>;
  waitForSettledRun(
    projectId: string,
    association: { planId: string; requestId?: string; runId?: string },
    options?: { timeoutMs?: number; onPoll?: (view: WorkspaceView) => void },
  ): Promise<WorkspaceView>;
  /** Identity signer owned by the caller; the module never generates its own key. */
  sign(nonce: string): string;
  refreshPlan(projectId: string, planId: string): Promise<WorkspaceView>;
}

/** One in-memory operation; the canonical plan/run/receipt remain in the core journal. */
export interface EditorSaveOperation {
  readonly projectId: string;
  readonly rootBindingId: string;
  readonly projectRoot: string;
  readonly filePath: string;
  readonly content: string;
  readonly expectedSha256?: string;
  readonly requestId: string;
  readonly bufferVersion?: number;
  plan?: Plan;
  runId?: string;
}

export interface EditorSaveInput {
  projectId: string | null;
  rootBindingId: string | null;
  projectRoot: string | null;
  filePath: string;
  content: string;
  /** SHA-256 of the exact bytes the buffer was opened from; the core revalidates it. */
  expectedSha256?: string;
  privateKeyPem: string | null;
  /** The caller holds a native signer (the private key never leaves its owner). */
  hasIdentity?: boolean;
  /** Reused verbatim across retries so a lost ACK can never authorize a new effect. */
  requestId?: string;
  bufferVersion?: number;
  operation?: EditorSaveOperation;
  /** Captured before the first await, including failures with an unknown outcome. */
  onOperation?: (operation: EditorSaveOperation) => void;
}

export type EditorSaveErrorCode =
  | "editor_save_unbound"
  | "editor_save_identity_missing"
  | "editor_path_outside_root"
  | "editor_path_invalid"
  | "editor_plan_failed"
  | "editor_consent_unconfirmed"
  | "editor_run_failed"
  | "editor_run_attention"
  | "editor_receipt_missing";

export type EditorSaveResult =
  | { ok: true; planId: string; runId: string; receiptId: string; relativePath: string; requestId: string; operation: EditorSaveOperation; contentSha256: string }
  | { ok: false; code: EditorSaveErrorCode; message: string; requestId: string; runId?: string; retryable: boolean; operation?: EditorSaveOperation };

/** Canonical, conservative relative path for the changeset; refusal is explicit. */
export function canonicalProjectRelativePath(projectRoot: string, filePath: string): string | null {
  const root = resolve(projectRoot);
  const target = resolve(filePath);
  const rel = relative(root, target);
  if (!rel) return null;
  if (rel.startsWith("..") || rel.includes("..\\") || rel.includes("../")) return null;
  if (rel.startsWith("/") || rel.startsWith("\\") || /^[A-Za-z]:/.test(rel)) return null;
  const normalized = rel.replace(/\\/g, "/");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return null;
  return normalized;
}

const PROJECT_WRITE_CAPABILITY = "workspace.project.write";

export async function saveEditorBuffer(deps: EditorSaveDeps, input: EditorSaveInput): Promise<EditorSaveResult> {
  const requestId = input.operation?.requestId ?? input.requestId ?? randomUUID();
  if (!input.projectId || !input.rootBindingId) {
    return { ok: false, code: "editor_save_unbound", message: "Vincule uma pasta ao projeto antes de salvar; o buffer foi preservado.", requestId, retryable: false };
  }
  if (!input.projectRoot) {
    return { ok: false, code: "editor_save_unbound", message: "A raiz do projeto é desconhecida nesta sessão; o buffer foi preservado.", requestId, retryable: false };
  }
  if (!input.privateKeyPem && !input.hasIdentity) {
    return { ok: false, code: "editor_save_identity_missing", message: "Salvar exige a identidade nativa para o consentimento W5; o buffer foi preservado.", requestId, retryable: true };
  }
  if (input.expectedSha256 !== undefined && !/^[0-9a-f]{64}$/.test(input.expectedSha256)) {
    return { ok: false, code: "editor_path_invalid", message: "A preimage do buffer é inválida; reabra o arquivo antes de salvar. O buffer foi preservado.", requestId, retryable: false };
  }
  const relativePath = canonicalProjectRelativePath(input.projectRoot, input.filePath);
  if (!relativePath) {
    return {
      ok: false,
      code: input.filePath.startsWith(input.projectRoot) ? "editor_path_invalid" : "editor_path_outside_root",
      message: "O arquivo está fora da raiz vinculada (ou o caminho é ambíguo). Nenhuma escrita foi preparada e o buffer foi preservado.",
      requestId,
      retryable: false,
    };
  }

  if (input.operation && (input.operation.projectId !== input.projectId || input.operation.rootBindingId !== input.rootBindingId
    || input.operation.projectRoot !== input.projectRoot || input.operation.filePath !== input.filePath)) {
    return { ok: false, code: "editor_save_unbound", message: "A operação pertence a outro contexto; reabra o projeto original para reconciliá-la.", requestId, retryable: false, operation: input.operation };
  }
  const operation: EditorSaveOperation = input.operation ?? {
    projectId: input.projectId, rootBindingId: input.rootBindingId, projectRoot: input.projectRoot,
    filePath: input.filePath, content: input.content, expectedSha256: input.expectedSha256, requestId, bufferVersion: input.bufferVersion,
  };
  input.onOperation?.(operation);
  const retry = Boolean(operation.plan);
  let plan: Plan;
  try {
    plan = operation.plan ?? await deps.createWritePlan(operation.projectId, operation.rootBindingId, [{
      path: relativePath,
      content: operation.content,
      type: "replace",
      ...(operation.expectedSha256 ? { expectedSha256: operation.expectedSha256 } : {}),
    }]);
  } catch (error) {
    return {
      ok: false,
      code: "editor_plan_failed",
      message: `Não foi possível preparar a escrita governada: ${error instanceof Error ? error.message : "falha"}. O buffer foi preservado.`,
      requestId,
      operation,
      retryable: true,
    };
  }
  if (!plan?.id || typeof plan.digest !== "string" || !/^[0-9a-f]{64}$/.test(plan.digest)) {
    return { ok: false, code: "editor_plan_failed", message: "O proxy não devolveu um plano com digest verificável; o buffer foi preservado.", requestId, retryable: true, operation };
  }
  operation.plan = plan;
  const command: RunCommand = { planId: plan.id, planDigest: plan.digest, requestId };

  let admitted: WorkspaceView;
  try {
    // Before retrying W5, inspect this plan, never the project's newest plan.
    const prior = retry ? await deps.refreshPlan(operation.projectId, plan.id) : null;
    if (prior?.run && (prior.run.planId !== plan.id || prior.run.requestId !== requestId
      || (operation.runId && prior.run.id !== operation.runId))) throw new Error("run_identity_changed");
    if (operation.runId && !prior?.run) throw new Error("run_not_observed");
    admitted = prior?.run ? prior : await deps.approveAndStart(operation.projectId, command, (nonce) => deps.sign(nonce));
  } catch (error) {
    const unknown = error instanceof WorkspaceServiceError && error.outcome === "unknown";
    return {
      ok: false,
      code: "editor_consent_unconfirmed",
      message: unknown
        ? "O consentimento não foi confirmado (ACK perdido). O proxy será consultado antes de repetir; nenhuma nova escrita foi autorizada."
        : `Consentimento recusado: ${error instanceof Error ? error.message : "falha"}. O buffer foi preservado.`,
      requestId,
      operation,
      retryable: unknown || retry,
    };
  }
  const admittedRun = admitted.run;
  if (!admittedRun) {
    // consent/complete starts the run; without it nothing is confirmed.
    return { ok: false, code: "editor_consent_unconfirmed", message: "O proxy não confirmou a execução do plano; o buffer foi preservado.", requestId, retryable: true, operation };
  }
  if (admittedRun.planId !== plan.id || (admittedRun.requestId !== undefined && admittedRun.requestId !== requestId)) {
    return { ok: false, code: "editor_consent_unconfirmed", message: "O run não corresponde à operação; o buffer foi preservado.", requestId, retryable: true, operation };
  }
  operation.runId = admittedRun.id;

  let settled: WorkspaceView;
  try {
    settled = await deps.waitForSettledRun(input.projectId, { planId: plan.id, requestId, runId: admittedRun.id });
  } catch (error) {
    return {
      ok: false,
      code: "editor_consent_unconfirmed",
      message: `Execução não observada até o fim: ${error instanceof Error ? error.message : "falha"}. O buffer foi preservado; consulte o run no proxy antes de repetir.`,
      requestId,
      operation,
      runId: admittedRun.id,
      retryable: true,
    };
  }
  const run = settled.run;
  if (!run || run.id !== admittedRun.id) {
    return { ok: false, code: "editor_consent_unconfirmed", message: "A identidade do run mudou durante a observação; o buffer foi preservado.", requestId, runId: admittedRun.id, retryable: true, operation };
  }
  if (run.status === "needs_attention") {
    return { ok: false, code: "editor_run_attention", message: `O run ${run.id.slice(0, 8)} precisa de atenção; use a revisão de execução para decidir. O buffer foi preservado.`, requestId, runId: run.id, retryable: true, operation };
  }
  if (run.status !== "succeeded") {
    return { ok: false, code: "editor_run_failed", message: `A escrita terminou como ${run.status} (run ${run.id.slice(0, 8)}). O buffer foi preservado.`, requestId, runId: run.id, retryable: false, operation };
  }
  const receipt = settled.receipts.find((item) => item.runId === run.id && item.status === "succeeded"
    && (item.capabilityId === PROJECT_WRITE_CAPABILITY || (item.capabilityId === undefined && item.stepId !== undefined)));
  if (!receipt) {
    return { ok: false, code: "editor_receipt_missing", message: `O run ${run.id.slice(0, 8)} concluiu sem recibo de escrita correspondente; o buffer foi preservado.`, requestId, runId: run.id, retryable: true, operation };
  }
  return { ok: true, planId: plan.id, runId: run.id, receiptId: receipt.id, relativePath, requestId, operation,
    contentSha256: createHash("sha256").update(operation.content).digest("hex") };
}
