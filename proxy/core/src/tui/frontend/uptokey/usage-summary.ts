/**
 * Session-level reading of the measurements projected on assistant messages. Context is the size of the
 * last measured request plus its answer; cost is the sum of known costs. Missing data stays missing:
 * a session without any provider report shows "not reported", never 0 tokens or $0.
 */
import type { AssistantMessage, Message } from "@opencode-ai/sdk/v2"
import { usageMarkerOf } from "./backend/projection.ts"

export interface UsageSummary {
  context: { tokens: number; percent: number | null; estimated: boolean } | null
  cost: { usd: number; partial: boolean; estimated: boolean } | null
}

export function usageSummary(messages: readonly Message[], contextWindow: (providerID: string, modelID: string) => number | undefined): UsageSummary {
  const answers = messages.filter((message): message is AssistantMessage => message.role === "assistant")
  const measured = answers.findLast((message) => usageMarkerOf(message)?.contextTokens != null)
  const marker = measured ? usageMarkerOf(measured) : undefined
  let context: UsageSummary["context"] = null
  if (measured && marker) {
    // Provider prompt counts already include cached input; output includes reasoning for the same reason.
    const tokens = (marker.contextTokens ?? 0) + measured.tokens.output
    const window = contextWindow(measured.providerID, measured.modelID)
    context = { tokens, percent: window ? Math.round((tokens / window) * 100) : null, estimated: marker.usage === "estimated" }
  }
  let usd = 0, known = 0, partial = false, estimated = false
  for (const answer of answers) {
    const mark = usageMarkerOf(answer)
    if (!mark || mark.usage === "none" || mark.cost === "unknown") { partial = true; continue }
    known++
    usd += answer.cost
    if (mark.cost === "partial") partial = true
    if (mark.costBasis === "estimate" || mark.costBasis === "mixed") estimated = true
  }
  return { context, cost: known ? { usd, partial, estimated } : null }
}
