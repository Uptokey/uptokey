/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useKeyboard, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup } from "solid-js"
import { createStore } from "solid-js/store"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { LocalProvider, useLocal } from "../vendor/opencode-tui/context/local"
import { SyncContext } from "../vendor/opencode-tui/context/sync"
import { SDKProvider } from "../vendor/opencode-tui/context/sdk"
import { ArgsProvider } from "../vendor/opencode-tui/context/args"
import { PermissionProvider } from "../vendor/opencode-tui/context/permission"
import { RouteProvider } from "../vendor/opencode-tui/context/route"
import { TuiPathsProvider, TuiStartupProvider } from "../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../vendor/opencode-tui/config"
import { KVProvider } from "../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../vendor/opencode-tui/context/theme"
import { ToastProvider, Toast } from "../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../vendor/opencode-tui/ui/dialog"
import { DialogModel } from "../vendor/opencode-tui/component/dialog-model"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../vendor/opencode-tui/keymap"
import { setBackend } from "./backend/registry.ts"
import { accountText } from "../../account-ui.ts"
import { getLang, setLang, type Lang } from "../../i18n.ts"

type Choice = { providerID: string; modelID: string }
const choice = (modelID: string, providerID = "connected") => ({ providerID, modelID })
const a = choice("model-a"), b = choice("model-b"), c = choice("model-c"), removed = choice("removed")

async function mount(recent: Choice[], available: Choice[], current = a, favorite: Choice[] = []) {
  const root = await mkdtemp(join(tmpdir(), "uptokey-model-cycle-"))
  const original = JSON.stringify({ recent, favorite, variant: {} })
  await Promise.all([
    writeFile(join(root, "model.json"), original),
    writeFile(join(root, "session.json"), '{"pinned":[]}'),
    writeFile(join(root, "kv.json"), "{}"),
  ])
  let catalogReads = 0
  const providerList = (items: Choice[]) => [...new Set(items.map(item => item.providerID))].map(id => ({
    id, name: id, models: Object.fromEntries(items.filter(item => item.providerID === id).map(item => [item.modelID, {
      id: item.modelID, name: item.modelID, providerID: id, status: "active", get release_date() { catalogReads++; return "" }, cost: { input: 0, output: 0 },
      options: id === "uptokey-hosted" ? { uptokeyFunding: "hosted-free" } : {},
    }])),
  }))
  const [data, setData] = createStore({
    provider: providerList(available), provider_default: {}, config: { model: `${current.providerID}/${current.modelID}` },
    agent: [{ name: "build", mode: "primary" }], session: [], mcp: {},
    provider_next: { all: [], default: {}, connected: available.map(item => item.providerID) },
    provider_auth: {}, console_state: { consoleManagedProviders: [] },
  })
  const events: unknown[] = [], changes = new Set<() => void>()
  const account = { view: { session: { configured: true, authenticated: true, state: "connected" } } }
  let retries = 0
  const controller = { account, hostedCatalogError: null as "account_reauthentication_required" | "hosted_model_unavailable" | null,
    async retryHostedModels() { retries++ },
  }
  setBackend({ directory: root, controller, client: {}, subscribe: () => () => {},
    emit: (event: unknown) => events.push(event),
    onChange: (handler: () => void) => { changes.add(handler); return () => changes.delete(handler) },
  } as never)
  let local!: ReturnType<typeof useLocal>
  let dialog!: DialogContext
  function Consumer() {
    local = useLocal()
    dialog = useDialog()
    useKeyboard(key => { if (key.name === "f2") local.model.cycle(key.shift ? -1 : 1) })
    return <text>{local.model.parsed().provider}:{local.model.parsed().model}</text>
  }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}>
      <TuiStartupProvider value={{ skipInitialLoading: true }}><OpencodeKeymapProvider keymap={keymap}><ArgsProvider><PermissionProvider><SDKProvider url="http://127.0.0.1">
        <SyncContext.Provider value={{ data } as never}><TuiConfigProvider config={config}><KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider><RouteProvider>
            <LocalProvider><DialogProvider><Consumer /></DialogProvider><Toast /></LocalProvider>
          </RouteProvider></ToastProvider></ThemeProvider>
        </KVProvider></TuiConfigProvider></SyncContext.Provider>
      </SDKProvider></PermissionProvider></ArgsProvider></OpencodeKeymapProvider></TuiStartupProvider>
    </TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 110, height: 34, kittyKeyboard: true })
  const until = Date.now() + 2000
  while (!local?.model.ready && Date.now() < until) { await Bun.sleep(5); await app.renderOnce() }
  expect(local.model.ready).toBe(true)
  return {
    local, app, original, root, events, account, controller, retries: () => retries,
    catalogReads: () => catalogReads,
    changeSubscribers: () => changes.size,
    async openModels() { dialog.replace(() => <DialogModel />); await app.flush(); await app.renderOnce() },
    dialog: () => dialog,
    async accountChanged() { for (const handler of changes) handler(); await Bun.sleep(160); await app.flush(); await app.renderOnce() },
    available(items: Choice[]) { setData("provider", providerList(items)) },
    updateModel(model: Choice, update: { name?: string; status?: string; options?: Record<string, string> }) {
      const index = data.provider.findIndex(provider => provider.id === model.providerID)
      if (index >= 0) setData("provider", index, "models", model.modelID, update)
    },
    async press(direction: 1 | -1) {
      app.mockInput.pressKey("F2", direction === -1 ? { shift: true } : {})
      await app.flush(); await app.renderOnce()
    },
    async unchanged() {
      expect(await Bun.file(join(root, "model.json")).text()).toBe(original)
    },
  }
}


import { getBackend } from "./backend/registry.ts"
import { ConnectProvider } from "./dialogs/connect-provider.tsx"
import { DialogSelect } from "../vendor/opencode-tui/ui/dialog-select"
import { ui } from "./i18n.ts"
const provider = { id: "synthetic-local", label: "Synthetic local", executable: true, local: true, configured: true, endpointUrl: "http://127.0.0.1:9999/v1" }
const result = { providerId: provider.id, modelId: "synthetic-model", routingComboId: "synthetic-combo", reloaded: true as const }
function deferred<T>() { let resolve!: (value: T) => void, reject!: (reason: unknown) => void; const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no }); return { resolve, reject, promise } }

test("provider list exposes Uptokey Disconnect and requires a safe explicit confirmation", async () => {
  const previous=getLang();setLang("en");const h=await mount([], [a]);let logouts=0,invalidations=0
  Object.assign(h.account.view,{available:{currentAccountRef:"acc_"+"a".repeat(64),revision:3,currentOwned:true}})
  Object.assign(h.account,{async logout(){logouts++;h.account.view.session.authenticated=false}})
  Object.assign(h.controller,{async refreshHostedModels(){invalidations++}})
  Object.assign(getBackend(),{providerChoices:()=>[],refreshAll(){}})
  const settle=async()=>{await h.app.flush();await h.app.renderOnce()}
  const openDisconnect=async()=>{h.dialog().replace(()=><ConnectProvider/>);await settle();await h.app.mockInput.typeText("uptokey");await settle();h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle()}
  try {
    await openDisconnect();expect(h.app.captureCharFrame()).toContain(ui("provider_disconnect_account_hint"));expect(logouts).toBe(0)
    h.app.mockInput.pressEnter();await settle();expect(logouts).toBe(0)
    await openDisconnect();h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle()
    expect(logouts).toBe(1);expect(invalidations).toBe(1);expect(h.account.view.session.authenticated).toBe(false);expect(h.local.model.current()).toEqual(a)
  } finally {h.app.renderer.destroy();setLang(previous)}
})

test("provider recovery opens the existing Account panel before connecting so browser fallback stays visible", async () => {
  const previous = getLang(); setLang("en"); const h = await mount([], [a])
  let connections = 0
  Object.assign(h.account.view, { connectionNeeded: true })
  Object.assign(h.account, { async connectHosted() { expect(h.events.at(-1)).toEqual({ type: "uptokey.panel.open", properties: { name: "account" } }); connections++ } })
  Object.assign(getBackend(), { providerChoices: () => [] })
  try {
    h.dialog().replace(() => <ConnectProvider />); await h.app.flush(); await h.app.renderOnce()
    await h.app.mockInput.typeText(accountText("connect_terminal")); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain(accountText("connect_terminal"))
    h.app.mockInput.pressEnter(); await h.app.flush()
    expect(connections).toBe(1); expect(h.local.model.current()).toEqual(a); expect(h.account.view.session.authenticated).toBe(true)
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("provider Disconnect remains visible for named-only accounts and removes only the confirmed version", async()=>{
  const previous=getLang();setLang("en");const h=await mount([], [a]);const id="11111111-1111-4111-8111-111111111111",calls:unknown[]=[]
  const choice={id:"groq",label:"Groq",configured:false,eligible:true,local:false,executable:true,endpointUrl:"https://api.groq.com/openai/v1/chat/completions"}
  Object.assign(h.controller,{view:{connections:{providers:[{id:"groq",configured:true}],connections:[{id,providerId:"groq",label:"Work account",enabled:true,revision:5}]}},client:{url:"http://127.0.0.1:21435",getSelectedDestination:()=>({providerId:"connected",connectionId:"connected"})},async refreshConnections(){calls.push("refresh")}})
  Object.assign(getBackend(),{providerChoices:()=>[choice],providerSetup:{async disconnect(...args:unknown[]){calls.push(args)}},refreshAll(){calls.push("frontend")}})
  const settle=async()=>{await h.app.flush();await h.app.renderOnce()}
  try {
    h.dialog().replace(()=><ConnectProvider/>);await settle();await h.app.mockInput.typeText("groq");await settle()
    expect(h.app.captureCharFrame()).toContain(ui("provider_disconnect",{name:"Groq"}))
    h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle();expect(h.app.captureCharFrame()).toContain("Work account");expect(calls).toEqual([])
    h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle()
    expect(calls).toEqual([["groq",id,"http://127.0.0.1:21435",5],"refresh","frontend"]);expect(h.local.model.current()).toEqual(a);expect(h.account.view.session.authenticated).toBe(true)
    calls.length=0
    getBackend().providerSetup!.disconnect=async(_provider,_id,_url,revision)=>{calls.push(revision);throw Error('provider_connection_conflict')}
    h.dialog().replace(()=><ConnectProvider/>);await settle();await h.app.mockInput.typeText("groq");await settle();h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle()
    ;(h.controller as any).view.connections.connections[0].revision=6
    h.app.mockInput.pressArrow("down");h.app.mockInput.pressEnter();await settle()
    expect(calls).toEqual([5]);expect(h.app.captureCharFrame().replace(/\s|┃/g,"")).toContain(ui("provider_disconnect_failed").replace(/\s/g,""));expect(h.local.model.current()).toEqual(a);expect(h.account.view.session.authenticated).toBe(true)
  } finally {h.app.renderer.destroy();setLang(previous)}
})

test("Escape cancels discovery and a late preparation is disposed without reopening or replacing the next dialog", async () => {
  setLang("en")
  const h = await mount([], [a]), waiting = deferred<unknown>()
  let disposed = 0, signal: AbortSignal | undefined
  Object.assign(getBackend(), { providerChoices: () => [provider], providerSetup: {
    prepare: (_id: string, _key: unknown, _endpoint: unknown, value: AbortSignal) => { signal = value; return waiting.promise },
  } })
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEscape(); await h.app.flush(); await h.app.renderOnce()
    expect(h.dialog().stack).toHaveLength(0)
    expect(signal?.aborted).toBe(true)
    h.dialog().replace(() => <DialogSelect title="Next task" options={[{ title: "Next task draft", value: "next" }]} />)
    waiting.resolve({ ...result, label: provider.label, models: [{ id: result.modelId }], source: "discovered", dispose: () => { disposed++ } })
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("Next task draft")
    expect(h.app.captureCharFrame()).not.toContain("synthetic-model")
    expect(disposed).toBe(1)
  } finally { h.app.renderer.destroy() }
})

test("a late discovery failure cannot clear a newer dialog or emit a replacement prompt", async () => {
  setLang("en")
  const h = await mount([], [a]), waiting = deferred<unknown>()
  Object.assign(getBackend(), { providerChoices: () => [provider], providerSetup: { prepare: () => waiting.promise } })
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEscape(); await h.app.flush()
    h.dialog().replace(() => <DialogSelect title="Next task" options={[{ title: "Preserved choice", value: "next" }]} />)
    waiting.reject(new Error("provider_key_required"))
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("Preserved choice")
    expect(h.dialog().stack).toHaveLength(1)
  } finally { h.app.renderer.destroy() }
})

test("Escape during a confirmed save lets it finish but never selects a model or replaces the next dialog", async () => {
  setLang("en")
  const h = await mount([], [a]), waiting = deferred<typeof result>()
  let commits = 0, finished = 0, refreshed = 0, signals = 0, signal: AbortSignal | undefined
  Object.assign(getBackend().controller, { refreshConnections: async () => { refreshed++ } })
  Object.assign(getBackend(), {
    providerChoices: () => [provider], refreshAll: () => { signals++ }, finishProviderSetup: async () => { finished++ },
    providerSetup: { prepare: async (_id: string, _key: unknown, _endpoint: unknown, value: AbortSignal) => {
      signal = value
      return { ...result, label: provider.label, models: [{ id: result.modelId }], source: "discovered", dispose() {}, commit() { commits++; return waiting.promise } }
    } },
  })
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("synthetic-model")
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(commits).toBe(1)
    h.app.mockInput.pressEscape(); await h.app.flush()
    expect(signal?.aborted).toBe(false)
    h.dialog().replace(() => <DialogSelect title="Next task" options={[{ title: "Preserved next choice", value: "next" }]} />)
    waiting.resolve(result)
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(finished).toBe(0)
    expect(refreshed).toBe(1)
    expect(signals).toBe(1)
    expect(h.local.model.current()).toEqual(a)
    expect(h.app.captureCharFrame()).toContain("Preserved next choice")
  } finally { h.app.renderer.destroy() }
})

test("Escape after commit but during finishProviderSetup invalidates the caller guard without changing the next task", async () => {
  setLang("en")
  const h = await mount([], [a]), waiting = deferred<void>()
  let finished = 0, selected = 0, callerGuard: (() => boolean) | undefined
  Object.assign(getBackend(), {
    providerChoices: () => [provider],
    providerSetup: { prepare: async () => ({ ...result, label: provider.label, models: [{ id: result.modelId }], source: "discovered", dispose() {}, commit: async () => result }) },
    finishProviderSetup: async (_provider: string, _model: string, _combo: string, current?: () => boolean) => {
      callerGuard = current; finished++
      await waiting.promise
      if (current?.() ?? true) selected++
    },
  })
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(finished).toBe(1)
    h.app.mockInput.pressEscape(); await h.app.flush()
    h.dialog().replace(() => <DialogSelect title="Next task" options={[{ title: "Independent next task", value: "next" }]} />)
    waiting.resolve()
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(callerGuard).toBeFunction()
    expect(callerGuard?.()).toBe(false)
    expect(selected).toBe(0)
    expect(h.local.model.current()).toEqual(a)
    expect(h.app.captureCharFrame()).toContain("Independent next task")
  } finally { h.app.renderer.destroy() }
})

test("discovery keeps two thousand models searchable while mounting only the viewport and selecting its final model", async () => {
  setLang("en")
  const h = await mount([], [a])
  const models = Array.from({ length: 2000 }, (_, index) => ({ id: `discovered-${index.toString().padStart(4, "0")}` }))
  let selected = "", followed = ""
  Object.assign(getBackend(), {
    providerChoices: () => [provider],
    providerSetup: { prepare: async () => ({ ...result, label: provider.label, models, source: "discovered", dispose() {}, commit: async (model: string) => { selected = model; return { ...result, modelId: model } } }) },
    finishProviderSetup: async (_provider: string, model: string) => { followed = model },
  })
  const settle = async () => { await h.app.flush(); await Bun.sleep(5); await h.app.renderOnce(); await h.app.flush(); await h.app.renderOnce() }
  const count = (node: { getChildren(): unknown[] }): number => 1 + node.getChildren().reduce<number>((total, child) => total + count(child as typeof node), 0)
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await settle()
    expect(h.app.captureCharFrame()).toContain("discovered-0000")
    expect(count(h.app.renderer.root)).toBeLessThan(200)
    h.app.mockInput.pressKey("END"); await settle()
    expect(h.app.captureCharFrame()).toContain("discovered-1999")
    h.app.mockInput.pressArrow("up"); await settle()
    expect(h.app.captureCharFrame()).toContain("discovered-1998")
    h.app.mockInput.pressEnter(); await settle()
    expect(selected).toBe("discovered-1998")
    expect(followed).toBe(selected)
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await settle()
    await h.app.mockInput.typeText("1999"); await settle()
    expect(h.app.captureCharFrame()).toContain("discovered-1999")
    h.app.mockInput.pressEnter(); await settle()
    expect(selected).toBe("discovered-1999")
    expect(followed).toBe(selected)
    expect(h.dialog().stack).toHaveLength(0)
    expect(models).toHaveLength(2000)
  } finally { h.app.renderer.destroy() }
})

test("a context-cancelled destination follow stops its own saving dialog without claiming success", async () => {
  setLang("en")
  const h = await mount([], [a])
  let commits = 0, followed = 0
  Object.assign(getBackend(), {
    providerChoices: () => [provider],
    providerSetup: { prepare: async () => ({ ...result, label: provider.label, models: [{ id: result.modelId }], source: "discovered", dispose() {}, commit: async () => { commits++; return result } }) },
    finishProviderSetup: async () => { followed++; return false },
  })
  try {
    h.dialog().replace(() => <ConnectProvider providerId={provider.id} />)
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(commits).toBe(1)
    expect(followed).toBe(1)
    expect(h.dialog().stack).toHaveLength(0)
    expect(h.local.model.current()).toEqual(a)
    expect(h.app.captureCharFrame()).not.toContain("Connected to")
  } finally { h.app.renderer.destroy() }
})

test("Uptokey provider search opens account access in ten languages, never API-key onboarding", async () => {
  const previous = getLang(), h = await mount([], [a])
  let preparations = 0
  h.account.view.session.authenticated = false
  Object.assign(getBackend(), { providerChoices: () => [provider], providerSetup: { prepare: () => { preparations++; throw Error("uptokey_must_not_request_key") } } })
  try {
    for (const lang of ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as Lang[]) {
      setLang(lang); h.dialog().replace(() => <ConnectProvider />)
      await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
      const before = h.app.captureCharFrame()
      expect(before.indexOf(provider.label)).toBeLessThan(before.indexOf("Uptokey"))
      expect(before).toContain(accountText("sign_in"))
      await h.app.mockInput.typeText("uptokey"); await h.app.flush(); await h.app.renderOnce()
      expect(h.app.captureCharFrame()).toContain("Uptokey")
      h.app.mockInput.pressEnter(); await h.app.flush()
      expect(h.events.at(-1)).toEqual({ type: "uptokey.panel.open", properties: { name: "account" } })
      expect(h.local.model.current()).toEqual(a)
    }
    expect(preparations).toBe(0)
    await h.unchanged()
  } finally { h.app.renderer.destroy(); setLang(previous) }
}, 15_000)

test("authenticated Uptokey provider opens only current hosted models and preserves the selected real ID", async () => {
  const previous = getLang(); setLang("en")
  const free = choice("gemini-real-catalog-id", "uptokey-hosted"), h = await mount([], [a, free])
  const ref = "acc_" + "a".repeat(64)
  Object.assign(h.account.view, { available: { currentAccountRef: ref, revision: 3 } })
  Object.assign(h.controller, { hostedModels: [{ modelId: free.modelID, accountRef: ref, revision: 3 }] })
  let preparations = 0
  Object.assign(getBackend(), { providerChoices: () => [provider], providerSetup: { prepare: () => { preparations++; throw Error("uptokey_must_not_request_key") } } })
  try {
    h.dialog().replace(() => <ConnectProvider />)
    await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    await h.app.mockInput.typeText("uptokey"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain(free.modelID)
    expect(h.app.captureCharFrame().split("\n").some(line => /^model-a(?:\s|$)/.test(line.trim()))).toBe(false)
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(free)
    expect(h.dialog().stack).toHaveLength(0)
    expect(h.events).toEqual([])
    expect(preparations).toBe(0)
  } finally { h.app.renderer.destroy(); setLang(previous) }
})
