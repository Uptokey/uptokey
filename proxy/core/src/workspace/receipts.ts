/**
 * W3 — recibos de tentativa. Funções puras sobre o contrato W0 (`ExecutionReceipt`).
 * Recibo registra estado, referências e uso declarado; não prova veracidade do conteúdo
 * nem resiste a quem controla o processo ou o disco local.
 */
import {
  parseExecutionReceipt,
  type CapabilityDescriptor,
  type ExecutionReceipt,
  type SourceReference,
  type TokenUsage,
} from "@uptokey/sync-contract/workflow";

/** Prefixo de recusa da política antes de qualquer preparação de efeito. */
export const POLICY_ERROR_PREFIX = "policy.";
/** Prefixo de falha comprovadamente anterior ao envio (efeito não saiu do processo). */
export const NOT_SENT_ERROR_PREFIX = "not_sent.";
export const GENERIC_EFFECT_ERROR = "effect_error";

const CODE = /^[a-z][a-z0-9_]{0,63}$/;
const UNKNOWN_USAGE: TokenUsage = Object.freeze({ basis: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null });

export interface SourceInput { id: string; sourceId: string; externalId: string; title: string; url: string; retrievedAt: string; }

/** Código de erro vem só de allowlist sintática; texto livre (prompt, chave, corpo) vira código genérico. */
export function sanitizeErrorCode(code: unknown, prefix = ""): string {
  const inner = typeof code === "string" && CODE.test(code) && !/^(sk|gsk|aiza|utk)_?/i.test(code) ? code : GENERIC_EFFECT_ERROR;
  return `${prefix}${inner}`;
}

/** Uso inválido ou ausente vira `unknown` com campos nulos; ausência de medição nunca vira zero. */
export function normalizeUsage(value: unknown): TokenUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) return { ...UNKNOWN_USAGE };
  const item = value as Record<string, unknown>;
  const count = (v: unknown) => v === null || v === undefined ? null : Number.isSafeInteger(v) && (v as number) >= 0 ? v as number : Number.NaN;
  const inputTokens = count(item.inputTokens), outputTokens = count(item.outputTokens), cachedInputTokens = count(item.cachedInputTokens);
  if ([inputTokens, outputTokens, cachedInputTokens].some((v) => Number.isNaN(v))) return { ...UNKNOWN_USAGE };
  if (item.basis !== "provider_reported" && item.basis !== "estimated") return { ...UNKNOWN_USAGE };
  if (inputTokens === null && outputTokens === null) return { ...UNKNOWN_USAGE };
  if (cachedInputTokens !== null && (inputTokens === null || cachedInputTokens > inputTokens)) return { basis: item.basis, inputTokens, outputTokens, cachedInputTokens: null };
  return { basis: item.basis, inputTokens, outputTokens, cachedInputTokens };
}

export function prepareReceipt(input: { id: string; projectId: string; runId: string; stepId: string; attemptId: string; capability: Pick<CapabilityDescriptor, "id" | "version">; inputArtifactRefs: string[]; now: string }): ExecutionReceipt {
  return validated({
    schemaVersion: 1, id: input.id, createdAt: input.now, projectId: input.projectId, runId: input.runId, stepId: input.stepId,
    attemptId: input.attemptId, capabilityId: input.capability.id, capabilityVersion: input.capability.version,
    status: "prepared", startedAt: input.now, finishedAt: null, inputArtifactRefs: [...new Set(input.inputArtifactRefs)],
    outputArtifactRefs: [], sources: [], errorCode: null, usage: { ...UNKNOWN_USAGE },
  });
}

/** Recibo de recusa da política: nenhuma preparação ou despacho ocorreu. */
export function policyDeniedReceipt(input: Parameters<typeof prepareReceipt>[0] & { code: string }): ExecutionReceipt {
  const prepared = prepareReceipt(input);
  return validated({ ...prepared, status: "failed", finishedAt: input.now, errorCode: sanitizeErrorCode(input.code, POLICY_ERROR_PREFIX) });
}

const ATTEMPT_TRANSITIONS: Readonly<Record<ExecutionReceipt["status"], readonly ExecutionReceipt["status"][]>> = Object.freeze({
  prepared: ["dispatched", "failed"],
  dispatched: ["succeeded", "failed", "unknown"],
  succeeded: [], failed: [], unknown: [],
});

export function canTransitionAttempt(from: ExecutionReceipt["status"], to: ExecutionReceipt["status"]): boolean {
  return ATTEMPT_TRANSITIONS[from].includes(to);
}

export function markDispatched(receipt: ExecutionReceipt): ExecutionReceipt {
  return transition(receipt, "dispatched", {});
}

export type SettleInput =
  | { kind: "not_sent"; code: string; now: string }
  | { kind: "completed"; outputArtifactRefs: string[]; sources?: SourceInput[]; usage?: unknown; now: string }
  | { kind: "failed"; code: string; usage?: unknown; now: string }
  | { kind: "unknown"; code: string; usage?: unknown; now: string };

/** `not_sent` exige garantia de que o efeito não saiu do processo; sem ela, usar `unknown`. */
export function settleReceipt(receipt: ExecutionReceipt, input: SettleInput): ExecutionReceipt {
  const finishedAt = latest(receipt.startedAt, input.now);
  if (input.kind === "not_sent") return transition(receipt, "failed", { finishedAt, errorCode: sanitizeErrorCode(input.code, NOT_SENT_ERROR_PREFIX) });
  if (input.kind === "completed") {
    return transition(receipt, "succeeded", {
      finishedAt, errorCode: null, outputArtifactRefs: [...new Set(input.outputArtifactRefs)],
      sources: toSourceReferences(receipt.id, input.sources ?? []), usage: normalizeUsage(input.usage),
    });
  }
  return transition(receipt, input.kind, { finishedAt, errorCode: sanitizeErrorCode(input.code), usage: normalizeUsage(input.usage) });
}

export function toSourceReferences(receiptId: string, sources: SourceInput[]): SourceReference[] {
  return sources.map((source) => ({ ...source, receiptId }));
}

export function isNotSent(receipt: ExecutionReceipt): boolean { return receipt.status === "failed" && !!receipt.errorCode?.startsWith(NOT_SENT_ERROR_PREFIX); }
export function isPolicyDenial(receipt: ExecutionReceipt): boolean { return receipt.status === "failed" && !!receipt.errorCode?.startsWith(POLICY_ERROR_PREFIX); }

/** Chamadas contabilizadas: toda tentativa que pode ter saído do processo. Conservador para `unknown`. */
export function countDispatchedCalls(receipts: readonly ExecutionReceipt[]): number {
  return receipts.filter((receipt) => receipt.status !== "prepared" && !isNotSent(receipt) && !isPolicyDenial(receipt)).length;
}

export function receiptsForStep(receipts: readonly ExecutionReceipt[], stepId: string): ExecutionReceipt[] {
  return receipts.filter((receipt) => receipt.stepId === stepId);
}

/** Paginação estável por ordem de criação persistida. Cursor é o id do último recibo entregue. */
export function receiptPage(receipts: readonly ExecutionReceipt[], options: { after?: string; limit?: number } = {}): { items: ExecutionReceipt[]; next: string | null } {
  const limit = Number.isSafeInteger(options.limit) && options.limit! >= 1 && options.limit! <= 100 ? options.limit! : 50;
  const start = options.after === undefined ? 0 : receipts.findIndex((receipt) => receipt.id === options.after) + 1;
  if (options.after !== undefined && start === 0) return { items: [], next: null };
  const items = receipts.slice(start, start + limit).map((receipt) => structuredClone(receipt));
  return { items, next: start + limit < receipts.length ? items.at(-1)?.id ?? null : null };
}

function transition(receipt: ExecutionReceipt, to: ExecutionReceipt["status"], patch: Partial<ExecutionReceipt>): ExecutionReceipt {
  if (!canTransitionAttempt(receipt.status, to)) throw new Error(`workflow_attempt_transition_invalid:${receipt.status}->${to}`);
  return validated({ ...receipt, ...patch, status: to });
}

function latest(a: string, b: string): string { return b > a ? b : a; }
function validated(receipt: ExecutionReceipt): ExecutionReceipt { return parseExecutionReceipt(receipt); }
