import { expect, test } from "bun:test"
import { createComponent, createRoot } from "solid-js"
import { mkdtemp, writeFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { isAbsolute, join, relative, resolve } from "node:path"
import { ArgsProvider } from "../vendor/opencode-tui/context/args"
import { KVProvider } from "../vendor/opencode-tui/context/kv"
import { ProjectProvider } from "../vendor/opencode-tui/context/project"
import { SDKProvider } from "../vendor/opencode-tui/context/sdk"
import { SyncProvider, useSync } from "../vendor/opencode-tui/context/sync"
import { PermissionProvider } from "../vendor/opencode-tui/context/permission"
import { ExitProvider } from "../vendor/opencode-tui/context/exit"
import { TuiPathsProvider, TuiStartupProvider } from "../vendor/opencode-tui/context/runtime"
import { setBackend } from "./backend/registry"

async function mount() {
  const root = await mkdtemp(join(tmpdir(), "uptokey-sync-retention-"))
  await writeFile(join(root, "kv.json"), "{}")
  const ok = (data: unknown) => Promise.resolve({ data, error: undefined })
  const empty = () => ok({})
  let event: (value: any) => void = () => {}
  let messages = () => ok([])
  let reads = 0
  const client = {
    path: { get: () => ok({ home: root, state: root, config: root, worktree: root, directory: root }) },
    project: { current: () => ok({ id: "project", worktree: root }), directories: () => ok([]) },
    config: { get: empty, providers: () => ok({ providers: [], default: {} }) },
    provider: { list: () => ok({ all: [], default: {}, connected: [] }), auth: empty },
    experimental: { capabilities: { get: empty }, console: { get: () => ok({ consoleManagedProviders: [], switchableOrgCount: 0 }) }, resource: { list: empty }, workspace: { list: () => ok([]), status: () => ok([]) } },
    app: { agents: () => ok([]) }, command: { list: () => ok([]) }, lsp: { status: () => ok([]) }, mcp: { status: empty }, formatter: { status: () => ok([]) }, vcs: { get: () => ok(undefined) },
    session: { list: () => ok([]), status: empty, get: ({ sessionID }: any) => ok({ id: sessionID, time: { created: 1, updated: 2 } }),
      messages: () => { reads++; return messages() }, todo: () => ok([]), diff: () => ok([]) },
  }
  setBackend({ directory: root, client, subscribe: (handler: any) => { event = handler; return () => { event = () => {} } } } as never)
  let sync!: ReturnType<typeof useSync>, dispose!: () => void
  const providers: Array<[any, any]> = [[TuiPathsProvider, { value: { cwd: root, home: root, state: root, worktree: root } }], [TuiStartupProvider, { value: { skipInitialLoading: true } }], [ArgsProvider, {}], [KVProvider, {}], [SDKProvider, { url: "http://fixture.invalid" }], [PermissionProvider, {}], [ProjectProvider, {}], [ExitProvider, { exit: (error: unknown) => { throw error } }], [SyncProvider, {}]]
  const Probe = () => { sync = useSync(); return null }
  const nest = (index = 0): any => index === providers.length ? createComponent(Probe, {}) : createComponent(providers[index]![0], { ...providers[index]![1], get children() { return nest(index + 1) } })
  createRoot(off => { dispose = off; return nest() })
  const until = Date.now() + 2000
  while (!sync || sync.status !== "complete") { if (Date.now() > until) throw new Error("sync fixture bootstrap timeout"); await Bun.sleep(5) }
  let sequence = 0
  return {
    sync,
    emit: (type: string, properties: unknown) => event({ directory: root, payload: { id: `event-${sequence++}`, type, properties } }),
    settle: () => Bun.sleep(25),
    messages: (next: typeof messages) => { messages = next }, reads: () => reads,
    async dispose() {
      dispose()
      await Bun.sleep(10)
      const target = resolve(root), withinTemp = relative(resolve(tmpdir()), target)
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("invalid fixture cleanup path")
      await rm(target, { recursive: true, force: true })
    },
  }
}

const info = (id: string, sessionID = "session-a") => ({ id, sessionID, role: "assistant", time: { created: 1_700_000_000_000 + (Number(id.replace(/\D/g, "")) || 1), completed: 1_700_000_000_200 } })
const part = (messageID: string, sessionID = "session-a", text = "Retained content") => ({ id: `part-${messageID}`, sessionID, messageID, type: "text", text })

test("removing a message releases its text and tools, including repeated resync replacements", async () => {
  const f = await mount()
  try {
    for (let index = 0; index < 12; index++) {
      const id = `message-${index}`
      f.emit("message.updated", { sessionID: "session-a", info: info(id) })
      f.emit("message.part.updated", { sessionID: "session-a", part: part(id, "session-a", "x".repeat(256 * 1024)) })
      f.emit("message.part.updated", { sessionID: "session-a", part: { ...part(id), id: `tool-${id}`, type: "tool", state: { status: "completed", output: "y".repeat(256 * 1024) } } })
      await f.settle()
      expect(f.sync.data.part[id]).toHaveLength(2)
      f.emit("message.removed", { sessionID: "session-a", messageID: id })
      await f.settle()
      expect(f.sync.data.message["session-a"]).toHaveLength(0)
      expect(Object.keys(f.sync.data.part)).toHaveLength(0)
    }
  } finally { await f.dispose() }
})

test("removing an unknown message is safe and preserves another session's parts", async () => {
  const f = await mount()
  try {
    f.emit("message.updated", { sessionID: "session-b", info: info("shared-id", "session-b") })
    f.emit("message.part.updated", { sessionID: "session-b", part: part("shared-id", "session-b") })
    await f.settle()
    f.emit("message.removed", { sessionID: "missing-session", messageID: "shared-id" })
    f.emit("message.removed", { sessionID: "missing-session", messageID: "missing-message" })
    await f.settle()
    expect(f.sync.data.part["shared-id"]?.[0]).toMatchObject({ sessionID: "session-b", text: "Retained content" })
    expect(f.sync.data.message["session-b"]).toHaveLength(1)
  } finally { await f.dispose() }
})

test("a same-tick resync can remove and recreate the same message without retaining the old parts", async () => {
  const f = await mount()
  try {
    const messageID = "message-resync"
    f.emit("message.updated", { sessionID: "session-a", info: info(messageID) })
    f.emit("message.part.updated", { sessionID: "session-a", part: part(messageID, "session-a", "before") })
    await f.settle()
    f.emit("message.removed", { sessionID: "session-a", messageID })
    f.emit("message.updated", { sessionID: "session-a", info: info(messageID) })
    f.emit("message.part.updated", { sessionID: "session-a", part: { ...part(messageID, "session-a", "after"), id: "replacement-part" } })
    await f.settle()
    expect(f.sync.data.message["session-a"]).toHaveLength(1)
    expect(f.sync.data.part[messageID]).toHaveLength(1)
    expect(f.sync.data.part[messageID]?.[0]).toMatchObject({ id: "replacement-part", text: "after" })
  } finally { await f.dispose() }
})

test("deleting a session releases its data while another active session keeps streaming", async () => {
  const f = await mount()
  try {
    for (const sessionID of ["session-a", "session-b"]) {
      f.emit("session.updated", { info: { id: sessionID, time: { created: 1, updated: 2 } } })
      f.emit("message.updated", { sessionID, info: info(sessionID, sessionID) })
      f.emit("message.part.updated", { sessionID, part: part(sessionID, sessionID) })
      f.emit("session.status", { sessionID, status: { type: "busy" } })
      f.emit("todo.updated", { sessionID, todos: [] })
      f.emit("session.diff", { sessionID, diff: [] })
    }
    await f.settle()
    f.emit("session.deleted", { info: { id: "session-a" } })
    f.emit("message.part.delta", { sessionID: "session-b", messageID: "session-b", partID: "part-session-b", field: "text", delta: " still streaming" })
    await f.settle()
    expect(f.sync.data.message["session-a"]).toBeUndefined()
    expect(f.sync.data.part["session-a"]).toBeUndefined()
    expect(f.sync.data.session_status["session-a"]).toBeUndefined()
    expect(f.sync.data.todo["session-a"]).toBeUndefined()
    expect(f.sync.data.session_diff["session-a"]).toBeUndefined()
    expect(f.sync.data.part["session-b"]?.[0]).toMatchObject({ text: "Retained content still streaming" })
  } finally { await f.dispose() }
})

test("deleting during hydration cannot resurrect data, and retry is not stuck in the old promise", async () => {
  const f = await mount()
  try {
    let resolve!: (value: any) => void
    f.messages(() => new Promise(done => { resolve = done }))
    const hydration = f.sync.session.sync("session-a")
    await f.settle()
    f.emit("session.deleted", { info: { id: "session-a" } })
    await f.settle()
    resolve({ data: [{ info: info("message-late"), parts: [part("message-late")] }], error: undefined })
    await hydration
    expect(f.sync.data.message["session-a"]).toBeUndefined()
    expect(f.sync.data.part["message-late"]).toBeUndefined()
    expect(f.sync.session.get("session-a")).toBeUndefined()
    f.messages(() => Promise.resolve({ data: [], error: undefined }))
    await f.sync.session.sync("session-a")
    expect(f.reads()).toBe(2)
  } finally { await f.dispose() }
})

test("deleting a previously hydrated session clears its completion marker", async () => {
  const f = await mount()
  try {
    await f.sync.session.sync("session-a")
    expect(f.reads()).toBe(1)
    f.emit("session.deleted", { info: { id: "session-a" } })
    await f.settle()
    await f.sync.session.sync("session-a")
    expect(f.reads()).toBe(2)
  } finally { await f.dispose() }
})

test("late part removals and deltas after session deletion are ignored without resurrecting data", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a", messageID = "message-deleted-session", original = part(messageID)
    f.emit("message.updated", { sessionID, info: info(messageID) })
    f.emit("message.part.updated", { sessionID, part: original })
    await f.settle()
    f.emit("session.deleted", { info: { id: sessionID } })
    await f.settle()
    f.emit("message.part.removed", { sessionID, messageID, partID: original.id })
    f.emit("message.part.delta", { sessionID, messageID, partID: original.id, field: "text", delta: "late" })
    f.emit("message.part.updated", { sessionID, part: { ...original, text: "late restored content" } })
    await f.settle()
    expect(f.sync.data.message[sessionID]).toBeUndefined()
    expect(f.sync.data.part[messageID]).toBeUndefined()
    expect(f.sync.session.get(sessionID)).toBeUndefined()
  } finally { await f.dispose() }
})

test("late part removals and deltas after message removal are ignored without resurrecting parts", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a", messageID = "message-deleted", original = part(messageID)
    f.emit("message.updated", { sessionID, info: info(messageID) })
    f.emit("message.part.updated", { sessionID, part: original })
    await f.settle()
    f.emit("message.removed", { sessionID, messageID })
    await f.settle()
    f.emit("message.part.removed", { sessionID, messageID, partID: original.id })
    f.emit("message.part.delta", { sessionID, messageID, partID: original.id, field: "text", delta: "late" })
    f.emit("message.part.updated", { sessionID, part: { ...original, text: "late restored content" } })
    await f.settle()
    expect(f.sync.data.message[sessionID]).toHaveLength(0)
    expect(f.sync.data.part[messageID]).toBeUndefined()
  } finally { await f.dispose() }
})

test("a part that arrives before its new parent message remains available for hydration", async () => {
  const f = await mount()
  try {
    const sessionID = "session-new", messageID = "message-new"
    f.emit("message.part.updated", { sessionID, part: part(messageID, sessionID, "arrived first") })
    await f.settle()
    expect(f.sync.data.part[messageID]?.[0]).toMatchObject({ text: "arrived first" })
    f.emit("message.updated", { sessionID, info: info(messageID, sessionID) })
    await f.settle()
    expect(f.sync.data.message[sessionID]).toHaveLength(1)
    expect(f.sync.data.part[messageID]?.[0]).toMatchObject({ text: "arrived first" })
  } finally { await f.dispose() }
})

test("an explicit parent update starts a new lifetime after removal without restoring stale parts", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a", messageID = "message-recreated"
    f.emit("message.updated", { sessionID, info: info(messageID) })
    f.emit("message.part.updated", { sessionID, part: part(messageID, sessionID, "old") })
    await f.settle()
    f.emit("session.deleted", { info: { id: sessionID } })
    f.emit("message.part.updated", { sessionID, part: part(messageID, sessionID, "late") })
    await f.settle()
    expect(f.sync.data.part[messageID]).toBeUndefined()
    f.emit("session.updated", { info: { id: sessionID, time: { created: 1, updated: 3 } } })
    f.emit("message.updated", { sessionID, info: info(messageID) })
    f.emit("message.part.updated", { sessionID, part: part(messageID, sessionID, "new lifetime") })
    await f.settle()
    expect(f.sync.data.part[messageID]).toHaveLength(1)
    expect(f.sync.data.part[messageID]?.[0]).toMatchObject({ text: "new lifetime" })
  } finally { await f.dispose() }
})

test("acknowledged canonical hydration can restore a removed session without accepting its older inflight response", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a", messageID = "message-canonical"
    f.emit("message.updated", { sessionID, info: info(messageID) })
    f.emit("message.part.updated", { sessionID, part: part(messageID) })
    await f.settle()
    f.emit("session.deleted", { info: { id: sessionID } })
    await f.settle()
    f.messages(() => Promise.resolve({ data: [{ info: info(messageID), parts: [part(messageID, sessionID, "confirmed canonical")] }], error: undefined }))
    await f.sync.session.sync(sessionID)
    expect(f.sync.data.message[sessionID]).toHaveLength(1)
    expect(f.sync.data.part[messageID]?.[0]).toMatchObject({ text: "confirmed canonical" })
  } finally { await f.dispose() }
})

test("a late child update cannot restore parts evicted by the existing message window", async () => {
  const f = await mount()
  try {
    for (let index = 1; index <= 101; index++) {
      const messageID = `message-${index}`
      f.emit("message.updated", { sessionID: "session-a", info: info(messageID) })
      f.emit("message.part.updated", { sessionID: "session-a", part: part(messageID) })
    }
    await f.settle()
    expect(f.sync.data.message["session-a"]).toHaveLength(100)
    f.emit("message.part.updated", { sessionID: "session-a", part: part("message-1", "session-a", "late old output") })
    await f.settle()
    expect(f.sync.data.part["message-1"]).toBeUndefined()
    expect(Object.keys(f.sync.data.part)).toHaveLength(100)
  } finally { await f.dispose() }
})

test("a removal during hydration keeps its tombstone after the older acknowledgement arrives", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a", messageID = "message-removed-during-hydration"
    let acknowledge!: (response: any) => void
    f.messages(() => new Promise(done => { acknowledge = done }))
    const hydration = f.sync.session.sync(sessionID)
    await f.settle()
    f.emit("message.removed", { sessionID, messageID })
    await f.settle()
    acknowledge({ data: [{ info: info(messageID), parts: [part(messageID, sessionID, "old acknowledged body")] }], error: undefined })
    await hydration
    f.emit("message.part.updated", { sessionID, part: part(messageID, sessionID, "late body after acknowledgement") })
    await f.settle()
    expect(f.sync.data.message[sessionID]).toHaveLength(0)
    expect(f.sync.data.part[messageID]).toBeUndefined()
  } finally { await f.dispose() }
})

test("the hydrated message window does not admit late parts for its evicted messages", async () => {
  const f = await mount()
  try {
    const sessionID = "session-a"
    f.messages(() => Promise.resolve({ data: Array.from({ length: 101 }, (_, offset) => {
      const messageID = `message-${offset + 1}`
      return { info: info(messageID), parts: [part(messageID)] }
    }), error: undefined }))
    await f.sync.session.sync(sessionID)
    expect(f.sync.data.message[sessionID]).toHaveLength(100)
    f.emit("message.part.updated", { sessionID, part: part("message-1", sessionID, "late evicted hydrated body") })
    await f.settle()
    expect(f.sync.data.part["message-1"]).toBeUndefined()
    expect(Object.keys(f.sync.data.part)).toHaveLength(100)
  } finally { await f.dispose() }
})
