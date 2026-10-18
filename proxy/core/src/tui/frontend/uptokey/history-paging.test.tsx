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
import { historyPage } from "./history"

async function mount() {
  const root = await mkdtemp(join(tmpdir(), "uptokey-history-paging-"))
  await writeFile(join(root, "kv.json"), "{}")
  const ok = (data: unknown) => Promise.resolve({ data, error: undefined })
  const empty = () => ok({})
  let event: (value: any) => void = () => {}
  let messages: (params: any) => Promise<any> = () => ok([])
  let history: (params: any) => Promise<any> = () => ok([])
  let reads = 0
  const client = {
    path: { get: () => ok({ home: root, state: root, config: root, worktree: root, directory: root }) },
    project: { current: () => ok({ id: "project", worktree: root }), directories: () => ok([]) },
    config: { get: empty, providers: () => ok({ providers: [], default: {} }) },
    provider: { list: () => ok({ all: [], default: {}, connected: [] }), auth: empty },
    experimental: { capabilities: { get: empty }, console: { get: () => ok({ consoleManagedProviders: [], switchableOrgCount: 0 }) }, resource: { list: empty }, workspace: { list: () => ok([]), status: () => ok([]) } },
    app: { agents: () => ok([]) }, command: { list: () => ok([]) }, lsp: { status: () => ok([]) }, mcp: { status: empty }, formatter: { status: () => ok([]) }, vcs: { get: () => ok(undefined) },
    session: { list: () => ok([]), status: empty, get: ({ sessionID }: any) => ok({ id: sessionID, time: { created: 1, updated: 2 } }),
      messages: (params: any) => { reads++; return messages(params) }, history: (params: any) => history(params), todo: () => ok([]), diff: () => ok([]) },
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
    messages: (next: typeof messages) => { messages = next }, history: (next: typeof history) => { history = next }, reads: () => reads,
    async dispose() {
      dispose()
      await Bun.sleep(10)
      const target = resolve(root), withinTemp = relative(resolve(tmpdir()), target)
      if (!withinTemp || withinTemp.startsWith("..") || isAbsolute(withinTemp)) throw new Error("invalid fixture cleanup path")
      await rm(target, { recursive: true, force: true })
    },
  }
}

const row = (n: number, sessionID = "session-a") => ({
  info: { id: `m${String(n).padStart(4, "0")}`, sessionID, role: n % 2 ? "assistant" : "user", time: { created: 1_700_000_000_000 + n, completed: 1_700_000_000_000 + n } },
  parts: [{ id: `p${String(n).padStart(4, "0")}`, sessionID, messageID: `m${String(n).padStart(4, "0")}`, type: "text", text: `text ${n}` }],
})
const conversation = (count: number, sessionID = "session-a") => Array.from({ length: count }, (_, n) => row(n, sessionID))

test("older pages load on request with a stable cursor and every message stays reachable", async () => {
  const f = await mount()
  try {
    const all = conversation(250)
    f.messages(params => Promise.resolve(historyPage(all, params.before, params.limit)))
    f.history(() => Promise.resolve({ data: all, error: undefined, meta: { more: false } }))
    await f.sync.session.sync("session-a")
    expect(f.sync.data.message["session-a"]).toHaveLength(100)
    expect(f.sync.data.message["session-a"]![0]!.id).toBe("m0150")
    expect(f.sync.session.message.more("session-a")).toBe(true)
    const reads = f.reads()
    await Promise.all([f.sync.session.message.loadMore("session-a"), f.sync.session.message.loadMore("session-a")])
    expect(f.reads()).toBe(reads + 1)
    expect(f.sync.data.message["session-a"]).toHaveLength(200)
    expect(f.sync.data.message["session-a"]![0]!.id).toBe("m0050")
    expect((f.sync.data.part["m0050"]![0] as { text?: string }).text).toBe("text 50")
    await f.sync.session.message.loadMore("session-a")
    expect(f.sync.data.message["session-a"]).toHaveLength(250)
    expect(f.sync.session.message.more("session-a")).toBe(false)
    const complete = await f.sync.session.message.all("session-a")
    expect(complete.map(m => m.info.id)).toEqual(all.map(m => m.info.id))
    // A new prompt returns the expanded window to the live tail; older pages stay reloadable.
    f.emit("message.updated", { sessionID: "session-a", info: row(250).info })
    await f.settle()
    expect(f.sync.data.message["session-a"]).toHaveLength(100)
    expect(f.sync.data.part["m0050"]).toBeUndefined()
    expect(f.sync.session.message.more("session-a")).toBe(true)
  } finally { await f.dispose() }
})

test("deleting a session while a page is loading discards that page", async () => {
  const f = await mount()
  try {
    const all = conversation(150)
    let release!: () => void
    f.messages(params => params.before ? new Promise(resolve => { release = () => resolve(historyPage(all, params.before, params.limit)) }) : Promise.resolve(historyPage(all, params.before, params.limit)))
    await f.sync.session.sync("session-a")
    const paging = f.sync.session.message.loadMore("session-a")
    await f.settle()
    f.emit("session.deleted", { info: { id: "session-a" } })
    await f.settle()
    release()
    await paging.catch(() => undefined)
    await f.settle()
    expect(f.sync.data.message["session-a"]).toBeUndefined()
    expect(Object.keys(f.sync.data.part).some(id => id.startsWith("m00"))).toBe(false)
    expect(f.sync.session.message.more("session-a")).toBe(false)
  } finally { await f.dispose() }
})

test("visiting many sessions keeps the current one and three recent ones; evicted sessions rehydrate canonically", async () => {
  const f = await mount()
  try {
    const sessions = ["s1", "s2", "s3", "s4", "s5", "s6"]
    f.messages(params => Promise.resolve(historyPage(conversation(5, params.sessionID), params.before, params.limit)))
    for (const id of sessions) await f.sync.session.sync(id)
    const loaded = sessions.filter(id => f.sync.data.message[id]?.length)
    expect(loaded).toEqual(["s3", "s4", "s5", "s6"])
    expect(Object.keys(f.sync.data.part).filter(id => f.sync.data.part[id]!.some(p => p.sessionID === "s1"))).toHaveLength(0)
    const reads = f.reads()
    await f.sync.session.sync("s1")
    expect(f.reads()).toBe(reads + 1)
    expect(f.sync.data.message["s1"]).toHaveLength(5)
  } finally { await f.dispose() }
})

test("an inactive session with an unfinished answer is never evicted", async () => {
  const f = await mount()
  try {
    f.messages(params => Promise.resolve(historyPage(conversation(3, params.sessionID), params.before, params.limit)))
    await f.sync.session.sync("busy")
    f.emit("message.updated", { sessionID: "busy", info: { id: "streaming", sessionID: "busy", role: "assistant", time: { created: 1_800_000_000_000 } } })
    await f.settle()
    for (const id of ["a", "b", "c", "d", "e"]) await f.sync.session.sync(id)
    expect(f.sync.data.message["busy"]?.some(m => m.id === "streaming")).toBe(true)
  } finally { await f.dispose() }
})
