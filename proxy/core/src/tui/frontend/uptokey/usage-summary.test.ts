import { expect, test } from "bun:test"
import { createTimeAssigner, foldUsage, projectTranscript, usageMarkerOf } from "./backend/projection.ts"
import { usageSummary } from "./usage-summary.ts"
import type { TranscriptItem } from "../../transcript.ts"

const ctx = () => {
  const times = createTimeAssigner(() => 1_000)
  return { sessionID: "s", providerID: "openai", modelID: "gpt", agent: "build", cwd: "/p", time: times.assign, hint: () => undefined, now: () => 1_000 }
}

test("a round without a provider report is unknown, never zero tokens or a free answer", () => {
  const folded = foldUsage([{ state: "unavailable" }])
  expect(folded.marker).toEqual({ usage: "unavailable", cost: "unknown", contextTokens: null })
  const summary = usageSummary([{ id: "a", role: "assistant", providerID: "openai", modelID: "gpt", tokens: folded.tokens, cost: folded.cost, uptokey: folded.marker } as never], () => 100_000)
  expect(summary).toEqual({ context: null, cost: null })
})

test("context is the last measured request; cost sums known rounds and flags partial or estimated totals", () => {
  const folded = foldUsage([
    { state: "reported", input: 1200, output: 30, costMicros: 1500, costBasis: "estimate" },
    { state: "unavailable" },
    { state: "reported", input: 1500, output: 90, reasoning: 40, costMicros: 500, costBasis: "estimate" },
  ])
  expect(folded.tokens).toEqual({ input: 1500, output: 90, reasoning: 40, cache: { read: 0, write: 0 } })
  expect(folded.cost).toBeCloseTo(0.002)
  expect(folded.marker).toEqual({ usage: "partial", cost: "partial", costBasis: "estimate", contextTokens: 1500 })
  const message = { id: "a", role: "assistant", providerID: "openai", modelID: "gpt", tokens: folded.tokens, cost: folded.cost, uptokey: folded.marker }
  expect(usageSummary([message as never], () => 3180)).toEqual({ context: { tokens: 1590, percent: 50, estimated: false }, cost: { usd: 0.002, partial: true, estimated: true } })
  expect(usageSummary([message as never], () => undefined).context!.percent).toBeNull()
})

test("local and documented-free routes are a real zero cost, not a missing one", () => {
  const folded = foldUsage([{ state: "reported", input: 10, output: 2, costMicros: 0, costBasis: "local" }])
  expect(usageSummary([{ id: "a", role: "assistant", providerID: "ollama", modelID: "m", tokens: folded.tokens, cost: folded.cost, uptokey: folded.marker } as never], () => undefined).cost).toEqual({ usd: 0, partial: false, estimated: false })
})

test("the projection carries each round's measurement once, through tool rounds, into the visual answer", () => {
  const items: TranscriptItem[] = [
    { kind: "user", id: "u1", text: "Read and explain" },
    { kind: "tool", id: "r1:call-1", name: "read_file", summary: "{}", status: "done", usage: { state: "reported", input: 100, output: 5 } },
    { kind: "assistant", id: "r2", text: "It adds.", usage: { state: "reported", input: 300, output: 20, costMicros: 0, costBasis: "local" } },
  ]
  const projected = projectTranscript(items, ctx())
  const answer = projected.find((message) => message.info.role === "assistant")!.info
  expect(usageMarkerOf(answer)).toEqual({ usage: "reported", cost: "partial", costBasis: "local", contextTokens: 300 })
  expect((answer as { tokens: { input: number } }).tokens.input).toBe(300)
})
