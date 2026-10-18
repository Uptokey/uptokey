/**
 * Context budget of one dispatch, measured before inference with the canonical token catalog over the
 * exact messages and tool schemas sent, plus an output reserve. When a long tool loop would not fit the
 * destination's window, the oldest tool outputs of this dispatch are replaced by a short reference (the
 * durable history is untouched and the model can call the tool again). Instructions, the request, tool
 * call/result pairing and the latest results are never removed. Without a known window or a countable
 * estimate nothing is changed: an unknown budget is reported as unknown, not guessed.
 */
import type { DispatchMessage } from "./conversations.ts";
import type { TuiFunctionTool } from "./client.ts";

export interface ContextBudget {
  /** Context window of the selected destination (catalog or broker metadata). */
  window: number;
  /** Tokens kept free for the answer. */
  reserveOutput: number;
}

export interface BudgetOutcome {
  /** Estimated input tokens after fitting; null when the catalog cannot count this request. */
  estimated: number | null;
  /** Tool outputs replaced by a reference in this dispatch. */
  pruned: number;
  state: string | null;
}

export class ContextBudgetError extends Error {
  readonly code = "conversation_context_exceeds_window";
  readonly estimated: number;
  readonly limit: number;
  constructor(estimated: number, limit: number) { super("conversation_context_exceeds_window"); this.estimated = estimated; this.limit = limit; }
}

/** Output reserve for a window: a tenth, at least 1k and at most 16k tokens. */
export function outputReserve(window: number, declaredOutput?: number): number {
  const reserve = Math.min(16_384, Math.max(1_024, Math.floor(window / 10)));
  return declaredOutput && declaredOutput > 0 ? Math.min(reserve, declaredOutput) : reserve;
}

const PRUNED_PREFIX = "[earlier tool output omitted to fit the model context";

export async function fitContextBudget(model: string, messages: DispatchMessage[], tools: readonly TuiFunctionTool[] | undefined, budget: ContextBudget | undefined): Promise<BudgetOutcome> {
  if (!budget || !Number.isSafeInteger(budget.window) || budget.window <= 0) return { estimated: null, pruned: 0, state: null };
  const { detailedTokenEstimate } = await import("../token-estimate.ts");
  const measure = (list: DispatchMessage[], withTools = true) => detailedTokenEstimate({ model, messages: list, ...(withTools && tools?.length ? { tools } : {}) } as never);
  const total = measure(messages);
  if (!total || total.input === null) return { estimated: null, pruned: 0, state: total?.state ?? null };
  const limit = budget.window - budget.reserveOutput;
  let estimated = total.input;
  if (estimated <= limit) return { estimated, pruned: 0, state: total.state };
  // The newest tool batch (after the last assistant tool call) is what the model is working on now.
  let lastCall = -1;
  for (let i = messages.length - 1; i >= 0; i--) if (messages[i]!.role === "assistant" && messages[i]!.tool_calls?.length) { lastCall = i; break; }
  let pruned = 0;
  for (let i = 0; i < messages.length && estimated > limit; i++) {
    const message = messages[i]!;
    if (message.role !== "tool" || i > lastCall || typeof message.content !== "string" || message.content.startsWith(PRUNED_PREFIX) || message.content.length < 256) continue;
    const before = measure([message], false)?.input ?? null;
    const reference = `${PRUNED_PREFIX} (${Buffer.byteLength(message.content, "utf8")} bytes, call ${message.tool_call_id ?? "?"}); call the tool again if it is still needed]`;
    const after = measure([{ ...message, content: reference }], false)?.input ?? null;
    if (before === null || after === null || after >= before) continue;
    message.content = reference;
    estimated -= before - after;
    pruned++;
  }
  if (estimated > limit) throw new ContextBudgetError(estimated, limit);
  return { estimated, pruned, state: total.state };
}
