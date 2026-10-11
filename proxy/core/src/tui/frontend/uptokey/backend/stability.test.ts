import { describe, expect, test } from "bun:test"
import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import type { TranscriptItem } from "../../../transcript.ts"
import { SessionMirror } from "./mirror.ts"
import type { ProjectedMessage } from "./projection.ts"
import { StableIds } from "./stable-ids.ts"

function projection(count: number): ProjectedMessage[] {
  return Array.from({ length: count }, (_, index) => {
    const id = `msg-${index}`
    const info: UserMessage | AssistantMessage = index % 2 === 0
      ? { id, sessionID: "session", role: "user", time: { created: index }, agent: "build", model: { providerID: "test", modelID: "test" } }
      : { id, sessionID: "session", role: "assistant", time: { created: index }, parentID: `msg-${index - 1}`, modelID: "test", providerID: "test", mode: "build", agent: "build", path: { cwd: ".", root: "." }, cost: 0, tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } }
    const part: Part = { id: `part-${index}`, sessionID: "session", messageID: id, type: "text", text: `message ${index}` }
    return { info, parts: [part] }
  })
}

describe("large transcript stability", () => {
  test("stable ids preserve a canonical 10k-item history without quadratic scans", () => {
    const stable = new StableIds()
    const items: TranscriptItem[] = Array.from({ length: 10_000 }, (_, index) => ({
      kind: index % 2 === 0 ? "user" as const : "assistant" as const,
      id: `item-${index}`,
      text: `message ${index}`,
    }))
    stable.apply(items)
    const started = performance.now()
    const next = stable.apply(items)
    expect(next).toHaveLength(items.length)
    expect(performance.now() - started).toBeLessThan(500)
  })

  test("session mirror updates a 10k-message history without quadratic membership scans", () => {
    const mirror = new SessionMirror("session")
    const messages = projection(10_000)
    expect(mirror.diff(messages).events).toHaveLength(20_000)
    const started = performance.now()
    const result = mirror.diff(messages)
    expect(result).toEqual({ events: [], resync: false })
    expect(performance.now() - started).toBeLessThan(500)
  })
})
