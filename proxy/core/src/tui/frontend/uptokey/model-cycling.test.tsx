/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useKeyboard, useRenderer } from "@opentui/solid"
import { InputRenderable } from "@opentui/core"
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
import { ToastProvider } from "../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../vendor/opencode-tui/ui/dialog"
import { DialogModel } from "../vendor/opencode-tui/component/dialog-model"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../vendor/opencode-tui/keymap"
import { getBackend, setBackend } from "./backend/registry.ts"
import { accountText } from "../../account-ui.ts"
import { getLang, setLang, type Lang } from "../../i18n.ts"
import { tr } from "./tr.ts"

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
  const panelEvents = new Map<string, (event: any) => void>()
  const account = { view: { session: { configured: true, authenticated: true, state: "connected" } } }
  let retries = 0
  const controller = { account, view: { connections: null }, hostedCatalogError: null as "account_reauthentication_required" | "hosted_model_unavailable" | null,
    async retryHostedModels() { retries++ },
  }
  setBackend({ directory: root, controller, client: {}, subscribe: () => () => {},
    providerChoices: () => [],
    emit: (event: any) => { events.push(event); panelEvents.get(event.type)?.(event) },
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
            <LocalProvider><DialogProvider><Consumer /></DialogProvider></LocalProvider>
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
    async installPanels() {
      const plugin = (await import("./plugin/panels.tsx")).default
      await plugin.tui!({ event: { on: (type: string, handler: (event: any) => void) => panelEvents.set(type, handler) },
        ui: { dialog, toast: () => {} }, slots: { register: () => {} }, route: { navigate: () => { throw Error("login_must_not_navigate") } },
      } as never, undefined, { id: "uptokey.panels", source: "internal", state: "same" } as never)
    },
    async openModels() {
      dialog.replace(() => <DialogModel />)
      const focusedUntil = Date.now() + 2000
      for (;;) {
        await app.flush(); await app.renderOnce()
        const focused = app.renderer.currentFocusedRenderable
        if (focused instanceof InputRenderable && !focused.isDestroyed && focused.traits.status === "FILTER") return
        if (Date.now() >= focusedUntil) throw new Error("model picker fixture did not focus its filter input")
        await Bun.sleep(1)
      }
    },
    filterValue() {
      const focused = app.renderer.currentFocusedRenderable
      return focused instanceof InputRenderable ? focused.value : undefined
    },
    dialog: () => dialog,
    async accountChanged() { for (const handler of changes) handler(); await Bun.sleep(160); await app.flush(); await app.renderOnce() },
    available(items: Choice[]) { setData("provider", providerList(items)) },
    disconnectedProviders(items: { id: string; name: string }[]) { setData("provider_next", "all", items as never) },
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

test("unrelated controller changes leave a large open model catalog intact and closing removes its subscription", async () => {
  const models = Array.from({ length: 750 }, (_, index) => choice(`catalog-model-${index.toString().padStart(4, "0")}`))
  const h = await mount([], models, models[0])
  try {
    await h.openModels()
    expect(h.changeSubscribers()).toBe(1)
    const reads = h.catalogReads()
    expect(reads).toBeGreaterThanOrEqual(models.length)
    await h.accountChanged()
    expect(h.catalogReads()).toBe(reads)
    h.dialog().clear()
    await h.app.flush(); await h.app.renderOnce()
    expect(h.changeSubscribers()).toBe(0)
    await h.accountChanged()
    expect(h.catalogReads()).toBe(reads)
  } finally { h.app.renderer.destroy() }
})

test("Uptokey Free sign-in is visible without scrolling a large catalog and catalog recovery never sends inference", async () => {
  const previous = getLang(); setLang("en")
  const models = Array.from({ length: 750 }, (_, index) => choice(`model-${index.toString().padStart(4, "0")}`))
  const h = await mount([], models, models[0])
  try {
    h.account.view.session.authenticated = false
    await h.openModels()
    expect(h.app.captureCharFrame()).toContain("Sign in · Free")
    expect(h.events).toEqual([])
    expect(h.retries()).toBe(0)
    h.account.view.session.authenticated = true
    h.controller.hostedCatalogError = "hosted_model_unavailable"
    await h.accountChanged()
    expect(h.app.captureCharFrame()).toContain("Refresh · Free")
    await h.app.mockInput.typeText("Uptokey"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush()
    expect(h.retries()).toBe(1)
    expect(h.events).toEqual([])
    h.controller.hostedCatalogError = null
    const free = choice("Recovered-free-model", "uptokey-hosted")
    h.available([models[0]!, free]); await h.accountChanged()
    expect(h.app.captureCharFrame()).not.toContain("Refresh · Free")
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("searching a large model catalog does not re-project every model on each query key", async () => {
  const models = Array.from({ length: 750 }, (_, index) => choice(`catalog-model-${index.toString().padStart(4, "0")}`))
  const h = await mount([], models, models[0])
  try {
    await h.openModels()
    await Bun.sleep(5); await h.app.flush()
    const reads = h.catalogReads()
    expect(reads).toBeGreaterThanOrEqual(models.length)
    await h.app.mockInput.typeText("0749"); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("catalog-model-0749")
    expect(h.catalogReads()).toBe(reads)
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(models[749])
    expect(h.dialog().stack).toHaveLength(0)
  } finally { h.app.renderer.destroy() }
})

test("the memoized catalog follows metadata, funding and favorite changes under an active query", async () => {
  const previous = getLang()
  setLang("en")
  const h = await mount([b], [a, b])
  try {
    await h.openModels()
    await Bun.sleep(5); await h.app.flush()
    await h.app.mockInput.typeText("renamed"); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).not.toContain("model-b")
    h.updateModel(b, { name: "renamed-model" })
    await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("renamed-model")
    h.updateModel(b, { status: "deprecated" })
    await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).not.toContain("renamed-model")
    const reads = h.catalogReads()
    h.updateModel(b, { status: "active", options: { uptokeyFunding: "hosted-free" } })
    await h.app.flush(); await h.app.renderOnce()
    expect(h.catalogReads()).toBeGreaterThan(reads)
    h.local.model.toggleFavorite(b)
    await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("(Favorite)")
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(b)
    expect(h.local.model.parsed().hostedFree).toBe(true)
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("an open model dialog follows account visibility and catalog revocation without reopening", async () => {
  const previous = getLang(), free = choice("Hosted-live-model", "uptokey-hosted")
  setLang("en")
  const h = await mount([], [a, free])
  try {
    await h.openModels()
    expect(h.app.captureCharFrame()).not.toContain("Sign in · Free")
    h.account.view.session.authenticated = false
    h.available([a])
    await h.accountChanged()
    expect(h.app.captureCharFrame()).toContain("Sign in · Free")
    expect(h.app.captureCharFrame()).not.toContain("Hosted-live-model")
    h.account.view.session.configured = false
    await h.accountChanged()
    expect(h.app.captureCharFrame()).not.toContain("Sign in · Free")
    h.account.view.session.configured = true
    h.account.view.session.authenticated = true
    h.available([a, free])
    await h.accountChanged()
    expect(h.app.captureCharFrame()).toContain("Hosted-live-model")
    expect(h.app.captureCharFrame()).not.toContain("Sign in · Free")
    await h.app.mockInput.typeText("Hosted-live-model"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(free)
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("F2 skips a removed recent model instead of repeatedly returning to the fallback", async () => {
  const h = await mount([a, removed, b], [a, b])
  try {
    await h.press(1); expect(h.local.model.current()).toEqual(b)
    expect(h.app.captureCharFrame()).toContain("connected:model-b")
    await h.press(1); expect(h.local.model.current()).toEqual(a)
    await h.press(-1); expect(h.local.model.current()).toEqual(b)
    await h.unchanged()
  } finally { h.app.renderer.destroy() }
})

test("both directions skip several removed entries and wrap across valid recent models", async () => {
  const h = await mount([removed, a, choice("gone-2"), b, choice("gone-3"), c], [a, b, c])
  try {
    for (const expected of [b, c, a]) { await h.press(1); expect(h.local.model.current()).toEqual(expected) }
    for (const expected of [c, b, a]) { await h.press(-1); expect(h.local.model.current()).toEqual(expected) }
    await h.unchanged()
  } finally { h.app.renderer.destroy() }
})

test("a current model outside recent history enters at the first or last valid choice", async () => {
  const h = await mount([removed, a, b], [a, b, c], c)
  try {
    await h.press(1); expect(h.local.model.current()).toEqual(a)
    h.local.model.set(c)
    await h.press(-1); expect(h.local.model.current()).toEqual(b)
    await h.unchanged()
  } finally { h.app.renderer.destroy() }
})

test("empty or wholly removed recents preserve the current model and its persisted preferences", async () => {
  for (const recent of [[], [removed, choice("gone-2")]]) {
    const h = await mount(recent, [a])
    try {
      await h.press(1); await h.press(-1)
      expect(h.local.model.current()).toEqual(a)
      await h.unchanged()
    } finally { h.app.renderer.destroy() }
  }
})

test("catalog removal while open is applied to the next shortcut without pruning saved history", async () => {
  const h = await mount([a, b, c], [a, b, c])
  try {
    await h.press(1); expect(h.local.model.current()).toEqual(b)
    h.available([a, c])
    await h.press(1); expect(h.local.model.current()).toEqual(c)
    h.available([])
    await h.press(1); expect(h.local.model.current()).toBeUndefined()
    expect(h.local.model.recent()).toEqual([a, b, c])
    await h.unchanged()
  } finally { h.app.renderer.destroy() }
})

test("same provider/model across two account UUIDs remains two distinct destinations", async () => {
  const personal = choice("same-model", "conn:11111111-1111-4111-8111-111111111111")
  const work = choice("same-model", "conn:22222222-2222-4222-8222-222222222222")
  const disconnected = choice("same-model", "conn:33333333-3333-4333-8333-333333333333")
  const h = await mount([personal, disconnected, work], [personal, work], personal, [work, personal])
  try {
    await h.press(1); expect(h.local.model.current()).toEqual(work)
    await h.press(-1); expect(h.local.model.current()).toEqual(personal)
    expect(h.local.model.favorite()).toEqual([work, personal])
    await h.unchanged()
  } finally { h.app.renderer.destroy() }
})

test("the real model dialog keeps connected BYOK/local before Free, including saved Free favorites", async () => {
  const free = choice("Free-model-one", "uptokey-hosted"), local = choice("Local-model", "ollama")
  const h = await mount([free], [a, free, local], a, [free])
  try {
    await h.openModels()
    const frame = h.app.captureCharFrame()
    expect(frame).toContain("Free-model-one")
    expect(frame.indexOf("model-a")).toBeLessThan(frame.indexOf("Free-model-one"))
    expect(frame.indexOf("Local-model")).toBeLessThan(frame.indexOf("Free-model-one"))
    expect(h.local.model.parsed().hostedFree).toBe(false)
    await h.app.mockInput.typeText("Free-model-one"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(free)
    expect(h.local.model.parsed().hostedFree).toBe(true)
    expect(h.dialog().stack).toHaveLength(0)
    expect(h.events).toEqual([])
  } finally { h.app.renderer.destroy() }
})

test("Free model labels and the optional sign-in entry are localized in all ten languages", async () => {
  const previous = getLang(), free = choice("Hosted-model", "uptokey-hosted")
  const h = await mount([], [a, free], a)
  try {
    for (const lang of ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as Lang[]) {
      setLang(lang)
      await h.openModels()
      expect(h.app.captureCharFrame()).toContain(accountText("free"))
      expect(h.app.captureCharFrame()).not.toContain(`${accountText("sign_in")} · ${accountText("free")}`)
      h.account.view.session.authenticated = false
      h.available([a])
      await h.openModels()
      expect(h.app.captureCharFrame()).toContain(`${accountText("sign_in")} · ${accountText("free")}`)
      expect(h.app.captureCharFrame()).not.toContain("Hosted-model")
      h.account.view.session.authenticated = true
      h.available([a, free])
    }
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("the complete model dialog chrome uses the selected language while model identifiers remain unchanged", async () => {
  const previous = getLang()
  const labels: [Lang, string, string, string, string][] = [
    ["en", "Select model", "Favorites", "Recent", "Providers"],
    ["pt-BR", "Selecionar modelo", "Favoritos", "Recentes", "Provedores"],
    ["es", "Seleccionar modelo", "Favoritos", "Recientes", "Proveedores"],
    ["fr", "Choisir un modèle", "Favoris", "Récents", "Fournisseurs"],
    ["de", "Modell auswählen", "Favoriten", "Zuletzt verwendet", "Anbieter"],
    ["it", "Seleziona modello", "Preferiti", "Recenti", "Provider"],
    ["ja", "モデルを選択", "お気に入り", "最近使用", "プロバイダー"],
    ["ko", "모델 선택", "즐겨찾기", "최근 사용", "제공업체"],
    ["zh-CN", "选择模型", "收藏", "最近使用", "提供商"],
    ["ar", "اختيار نموذج", "المفضلة", "المستخدمة مؤخرًا", "المزوّدون"],
  ]
  try {
    for (const [lang, title, favorites, recent, providers] of labels) {
      setLang(lang)
      const h = await mount([c], [a, b, c], a, [b])
      try {
        await h.openModels()
        const frame = h.app.captureCharFrame()
        for (const label of [title, favorites, recent, `${providers} ctrl+a`, "model-a", "model-b", "model-c"]) {
          expect(frame).toContain(label)
        }
        if (lang !== "en") {
          const lines = frame.split("\n").map(line => line.trim())
          for (const source of ["Select model", "Favorites", "Recent"]) expect(lines).not.toContain(source)
          expect(frame).not.toContain("Providers ctrl+a")
        }
        await h.app.mockInput.typeText("model-b"); await h.app.flush(); await h.app.renderOnce()
        expect(h.filterValue()).toBe("model-b")
        expect(h.app.captureCharFrame()).toContain(`(${tr("Favorite")})`)
        if (lang !== "en") expect(h.app.captureCharFrame()).not.toContain("(Favorite)")
        h.available([])
        await h.openModels()
        const emptyCatalogSelection = h.local.model.current()
        // The current provider action manages both new and saved connections.
        // Exercise its real shortcut with an empty model catalog, in every language.
        expect(h.app.captureCharFrame()).toContain(`${providers} ctrl+a`)
        h.app.mockInput.pressKey("a", { ctrl: true }); await h.app.flush(); await h.app.renderOnce()
        expect(h.app.captureCharFrame()).toContain(providers)
        expect(h.app.captureCharFrame()).toContain("Brave Search")
        expect(h.app.captureCharFrame()).not.toContain(title)
        expect(h.local.model.current()).toEqual(emptyCatalogSelection)
        await h.unchanged()
      } finally { h.app.renderer.destroy() }
    }
  } finally { setLang(previous) }
})

test("a popular provider from an empty model catalog uses masked canonical key entry", async () => {
  const previous = getLang(); setLang("en")
  const h = await mount([], [])
  const provider = { id: "synthetic-cloud", label: "Synthetic Cloud", local: false, configured: false, executable: true, endpointUrl: "https://example.test/v1" }
  let preparations = 0
  const unexpectedPrepare = async () => { preparations++; throw Error("must_not_submit_cancelled_key") }
  Object.assign(getBackend(), { providerChoices: () => [provider], providerSetup: { prepare: unexpectedPrepare, prepareManual: unexpectedPrepare } })
  h.disconnectedProviders([{ id: provider.id, name: provider.label }])
  try {
    await h.openModels(); await Bun.sleep(5); await h.app.flush()
    expect(h.app.captureCharFrame()).toContain(provider.label)
    await h.app.mockInput.typeText(provider.label); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain(`Connect ${provider.label}`)
    await h.app.mockInput.typeText("synthetic-not-a-real-key"); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).not.toContain("synthetic-not-a-real-key")
    expect(h.app.captureCharFrame()).toContain("••")
    h.app.mockInput.pressEscape(); await h.app.flush()
    expect(h.dialog().stack).toHaveLength(0)
    expect(preparations).toBe(0)
    await h.unchanged()
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("browser sign-in returns through the panel plugin to the same filtered model chooser without changing the model", async () => {
  const previous = getLang(); setLang("en")
  const free = choice("hosted-model", "uptokey-hosted"), h = await mount([], [a, free], a)
  let loginCalls = 0
  Object.assign(h.account.view, { session: { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" },
    login: null, challenge: null, busy: false, requests: [], available: null, error: null, plan: { state: "unknown" } })
  Object.assign(h.account, {
    refresh: async () => {}, loadPlan: async () => {}, cancelPlanRead: () => {}, cancelPending: () => {},
    login: async () => { loginCalls++; Object.assign(h.account.view, { login: { userCode: "1234ABCD", loginUrl: "https://app.uptokey.com/api/account/native/authorize?id=af4b344f-1848-4016-9c42-f3b3454fe9c1", expiresAt: Date.now() + 60_000 } }); await h.accountChanged() },
  })
  try {
    await h.installPanels(); await h.openModels()
    await h.app.mockInput.typeText("uptokey"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("Uptokey account")
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.accountChanged()
    expect(loginCalls).toBe(1); expect(h.app.captureCharFrame()).toContain("1234ABCD")
    Object.assign(h.account.view, { login: null, session: { configured: true, authenticated: true, loginAvailable: true, state: "connected" } })
    await h.accountChanged(); await Bun.sleep(10); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).toContain("Select model")
    expect(h.app.captureCharFrame()).toContain(free.modelID)
    expect(h.filterValue()).toBe("uptokey")
    expect(h.local.model.current()).toEqual(a)
    expect(h.dialog().stack).toHaveLength(1)
    expect(loginCalls).toBe(1); await h.unchanged()
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("signed-out Free entry opens the existing account panel only on explicit selection", async () => {
  const previous = getLang(), h = await mount([], [a])
  setLang("en")
  h.account.view.session.authenticated = false
  try {
    await h.openModels()
    expect(h.events).toEqual([])
    await h.app.mockInput.typeText("Sign in"); await h.app.flush(); await h.app.renderOnce()
    h.app.mockInput.pressEnter(); await h.app.flush()
    expect(h.events).toEqual([{ type: "uptokey.panel.open", properties: { name: "account", returnTo: "models", query: "Sign in" } }])
    expect(h.local.model.current()).toEqual(a)
    await h.unchanged()
    h.account.view.session.configured = false
    await h.accountChanged()
    expect(h.app.captureCharFrame()).not.toContain("Sign in · Free")
  } finally { h.app.renderer.destroy(); setLang(previous) }
})

test("Uptokey, Free and Plus searches find the real hosted model in all ten languages without replacing its identity", async () => {
  const previous = getLang(), free = choice("gemini-real-catalog-id", "uptokey-hosted")
  const h = await mount([], [a, free], a)
  h.updateModel(free, { name: "Gemini real catalog model" })
  try {
    for (const lang of ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as Lang[]) {
      setLang(lang)
      for (const query of ["uptokey", "free", "plus"]) {
        await h.openModels()
        await h.app.mockInput.typeText(query); await h.app.flush(); await h.app.renderOnce()
        const frame = h.app.captureCharFrame()
        expect(frame).toContain("Gemini real catalog model")
        expect(frame.split("\n").some(line => /^model-a(?:\s|$)/.test(line.trim()))).toBe(false)
        expect(h.local.model.current()).toEqual(a)
      }
    }
    h.app.mockInput.pressEnter(); await h.app.flush(); await h.app.renderOnce()
    expect(h.local.model.current()).toEqual(free)
    expect(h.dialog().stack).toHaveLength(0)
    expect(h.events).toEqual([])
  } finally { h.app.renderer.destroy(); setLang(previous) }
}, 15_000)

test("revocation hides stale hosted search rows and offers account access without inventing a destination", async () => {
  const previous = getLang(); setLang("en")
  const free = choice("hosted-stale-model", "uptokey-hosted"), h = await mount([free], [a, free], a, [free])
  try {
    await h.openModels()
    expect(h.app.captureCharFrame()).toContain(free.modelID)
    h.account.view.session.authenticated = false
    await h.accountChanged()
    await h.app.mockInput.typeText("uptokey"); await h.app.flush(); await h.app.renderOnce()
    expect(h.app.captureCharFrame()).not.toContain(free.modelID)
    expect(h.app.captureCharFrame()).toContain("Sign in")
    h.app.mockInput.pressEnter(); await h.app.flush()
    expect(h.events).toEqual([{ type: "uptokey.panel.open", properties: { name: "account", returnTo: "models", query: "uptokey" } }])
    expect(h.local.model.current()).toEqual(a)
    await h.unchanged()
  } finally { h.app.renderer.destroy(); setLang(previous) }
})
