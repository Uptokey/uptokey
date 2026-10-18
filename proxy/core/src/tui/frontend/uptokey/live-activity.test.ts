import { expect, test } from "bun:test"
import { createTimeAssigner, projectTranscript } from "./backend/projection.ts"
import type { TranscriptItem } from "../../transcript.ts"

const ctx = () => {
  const times = createTimeAssigner(() => 1_000)
  return { sessionID: "s", providerID: "local", modelID: "qwen", agent: "build", cwd: "/p", time: times.assign, hint: () => undefined, now: () => 1_000 }
}

test("live reasoning becomes a reasoning part, open while the model thinks and timed once it ends", () => {
  const thinking: TranscriptItem[] = [
    { kind: "user", id: "u1", text: "fix it" },
    { kind: "reasoning", id: "live-reasoning", text: "I should read the file.", done: false, startedAt: 5_000 },
    { kind: "assistant", id: "streaming", text: "", streaming: true },
  ]
  const open = projectTranscript(thinking, ctx())[1]!.parts.find((part) => part.type === "reasoning")
  expect(open).toMatchObject({ type: "reasoning", text: "I should read the file.", time: { start: 5_000 } })
  expect((open as { time: { end?: number } }).time.end).toBeUndefined()

  const closed: TranscriptItem[] = [
    thinking[0]!,
    { kind: "reasoning", id: "live-reasoning", text: "I should read the file.", done: true, startedAt: 5_000, endedAt: 9_000 },
    { kind: "tool", id: "live-tool-0-0", name: "read_file", summary: "{\"path\":\"a.js\"}", status: "running" },
    { kind: "assistant", id: "streaming", text: "", streaming: true },
  ]
  const parts = projectTranscript(closed, ctx())[1]!.parts
  expect(parts.map((part) => part.type)).toEqual(["reasoning", "tool", "text"])
  expect(parts[0]).toMatchObject({ time: { start: 5_000, end: 9_000 } })
  // The running tool is shown with its real name and input, in the running state.
  expect(parts[1]).toMatchObject({ type: "tool", tool: "read", state: { status: "running", input: { filePath: "a.js" } } })
})

test("terminal tool outcomes retain failure versus neutral non-execution in the SDK projection", () => {
  for (const [status, projected] of [["done", "completed"], ["error", "error"], ["rejected", "completed"]] as const) {
    const item: TranscriptItem = { kind: "tool", id: `tool-${status}`, name: "execute_command", summary: "{}", status, detail: "canonical result" }
    const part = projectTranscript([item], ctx())[0]!.parts.find(part => part.type === "tool")
    expect(part?.type === "tool" && part.state.status).toBe(projected)
    if (part?.type !== "tool") throw Error("missing tool part")
    if (status === "rejected") {
      expect(part.metadata).toMatchObject({ uptokeyOutcome: "not_executed" })
      expect(part.state.status !== "pending" && part.state.metadata).toMatchObject({ uptokeyOutcome: "not_executed" })
      expect(part.state.status).not.toBe("error")
    } else expect(part.metadata?.uptokeyOutcome).toBeUndefined()
  }
})
