import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import type { GlobalEvent } from "@opencode-ai/sdk/v2"
import type { TuiController } from "../../../controller.ts"
import type { TranscriptItem } from "../../../transcript.ts"
import { UptokeyBackend } from "./index.ts"

function fixture() {
  let reads = 0
  const events: GlobalEvent[] = []
  let text = "first"
  const controller = Object.assign(new EventEmitter(), {
    start: async () => undefined,
    client: { getSelectedDestination: () => ({ providerId: "test" }), fetchAuth: async () => { throw new Error("no network in fixture") } },
    workspace: {}, store: { conversationRevision: 1 }, busy: false,
    state: {
      activeConversation: { id: "s1", title: "Test", updatedAt: "2026-10-12T00:00:00.000Z" },
      messages: [], conversations: [], selectedModel: "test-model", turn: "idle", storagePolicy: "local"
    },
    view: { mode: "build", autonomy: false, approvals: [], binding: null },
    features: { audio: { active: false } },
    items: (): TranscriptItem[] => {
      reads++
      return [{ kind: "user", id: "u1", text: "Question" }, { kind: "assistant", id: "streaming", text, streaming: true }]
    }
  })
  const backend = new UptokeyBackend({ controller: controller as unknown as TuiController, cwd: "/work", home: "/home", state: "/state", config: "/config" })
  backend.subscribe(event => events.push(event))
  return { backend, controller, events, reads: () => reads, text: (value: string) => { text = value } }
}

test("one backend sync reads one transcript snapshot for notices, compaction and projection", async () => {
  const f = fixture()
  try {
    await f.backend.whenReady()
    for (let index = 0; index < 100; index += 1) { f.text(`chunk-${index}`); f.controller.emit("change"); await Promise.resolve() }
    await Bun.sleep(30)
    expect(f.reads()).toBe(1)
    const updates = f.events.filter(event => event.payload.type === "message.part.updated")
    expect(updates).toHaveLength(2)
    const last = updates.at(-1)!.payload
    expect(last.type === "message.part.updated" && last.properties.part.type === "text" && last.properties.part.text).toBe("chunk-99")
  } finally { f.backend.dispose() }
})

test("pending projection uses the latest session and model, then dispose removes queued work", async () => {
  const f = fixture()
  try {
    await f.backend.whenReady()
    f.controller.emit("change")
    f.controller.state.activeConversation.id = "s2"
    f.controller.state.selectedModel = "new-model"
    f.controller.store.conversationRevision++
    await Bun.sleep(30)
    expect(f.reads()).toBe(1)
    const updated = f.events.filter(event => event.payload.type === "message.updated")
    expect(updated).toHaveLength(2)
    for (const event of updated) {
      const payload = event.payload
      expect(payload.type === "message.updated" && payload.properties.sessionID).toBe("s2")
      if (payload.type === "message.updated" && payload.properties.info.role === "assistant") expect(payload.properties.info.modelID).toBe("new-model")
    }
    f.controller.emit("change")
    f.backend.dispose()
    await Bun.sleep(30)
    expect(f.reads()).toBe(1)
  } finally { f.backend.dispose() }
})
