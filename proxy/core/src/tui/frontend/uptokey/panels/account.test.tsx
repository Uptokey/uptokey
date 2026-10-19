/** @jsxImportSource @opentui/solid */
import { test, expect } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup, onMount } from "solid-js"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { resolve, join } from "node:path"
import { TuiAccount } from "../../../account.ts"
import { ACCOUNT_TEXT, accountText } from "../../../account-ui.ts"
import { getLang, setLang, type Lang } from "../../../i18n.ts"
import { AccountPanel } from "./account.tsx"
import { setBackend } from "../backend/registry.ts"
import { TuiPathsProvider } from "../../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../../vendor/opencode-tui/config"
import { KVProvider } from "../../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../../vendor/opencode-tui/context/theme"
import { ToastProvider } from "../../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../../vendor/opencode-tui/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../vendor/opencode-tui/keymap"
import { ClipboardProvider } from "../../vendor/opencode-tui/context/clipboard"

test("rendered account panel requests/adopts once, returns focus and exposes real localized state in ten languages", async () => {
  const previous = getLang(), parent = resolve("../../../output")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "tui-account-render-")); await writeFile(join(root, "kv.json"), "{}")
  const calls: string[] = [], ref = "synthetic-account-reference-01"
  let authenticated = false, approved = false, delayedConsumption = false
  let observedPlan: "none" | "active" = "none", delayedStatus = false, usageFails = false
  let finishConsumption: (() => void) | undefined
  let finishStatus: (() => void) | undefined
  const signedOut = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" as const }
  const session = { configured: true, authenticated: true, loginAvailable: true, state: "connected" as const, profile: { displayName: "Fixture", plan: "free" } }
  const account = new TuiAccount({
    getAccountSession: async () => { calls.push("status"); if (delayedStatus) await new Promise<void>(resolve => { finishStatus = resolve }); return authenticated ? session : signedOut },
    getAvailableAccounts: async () => ({ revision: authenticated ? 1 : 0, currentAccountRef: authenticated ? ref : null, currentOwned: authenticated ? false : null, accounts: approved ? [{ accountRef: ref, owned: false, session, expiresAt: Date.now() + 60_000 }] : [] }),
    getAccountRequests: async () => [],
    requestAccountAccess: async () => { calls.push("request"); return { id: "c7ec4e43-f72b-4166-b9fa-79f6e5daef3f", userCode: "ABCD1234", expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    consumeAccountAccess: async () => { if (delayedConsumption) await new Promise<void>(resolve => { finishConsumption = resolve }); if (!approved) throw Error("account_share_pending") },
    approveAccountRequest: async () => {},
    adoptAccount: async () => { calls.push("adopt"); authenticated = true; return { revision: 1, session } },
    unlinkAccount: async () => { calls.push("unlink"); authenticated = false; return { revision: 2, session: signedOut } },
    startAccountLogin: async () => { calls.push("login"); return { session } },
    signOutAccount: async () => signedOut,
    getAccountUsage: async () => { calls.push("usage"); if (usageFails) throw Error("private-upstream-detail"); return { state: "observed", verifiedAt: new Date().toISOString(), currency: "USD", unit: "micro_usd", availableMicros: 2_000_000, reservedMicros: 0, spentMicros: 0 } },
    getAccountPlan: async () => {
      calls.push("subscription.status")
      return { accountRef: "account_" + "b".repeat(64), subscription: { status: observedPlan, cancelAtPeriodEnd: false, currentPeriodEnd: observedPlan === "none" ? null : new Date(Date.now() + 86_400_000).toISOString() }, allowance: observedPlan === "none" ? null : { limitMicros: 3_000_000, usedMicros: 500_000, reservedMicros: 250_000, periodStart: new Date(Date.now() - 86_400_000).toISOString(), periodEnd: new Date(Date.now() + 86_400_000).toISOString() } }
    },
  }, { intervalMs: 10 })
  setLang("en")
  setBackend({ controller: { account }, onChange: (handler: () => void) => { account.on("change", handler); return () => account.off("change", handler) } } as never)
  let dialog!: DialogContext
  function Launch() { dialog = useDialog(); onMount(() => dialog.replace(() => <AccountPanel />)); return <box /> }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider><DialogProvider><Launch /></DialogProvider></ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider></TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 38, kittyKeyboard: true })
  const waitFrame = async (predicate: (frame: string) => boolean) => {
    const until = Date.now() + 3000
    do { await Bun.sleep(10); await app.renderOnce(); if (predicate(app.captureCharFrame())) return } while (Date.now() < until)
    expect(predicate(app.captureCharFrame()), JSON.stringify({ calls, authenticated, approved, challenge: account.view.challenge, busy: account.view.busy }) + "\n" + app.captureCharFrame()).toBe(true)
  }
  try {
    await app.renderOnce()
    await waitFrame(frame => frame.includes("Uptokey account") && frame.includes("Use another app on this computer"))
    expect(calls.includes("login")).toBe(false); expect(calls.includes("usage")).toBe(false)
    app.mockInput.pressArrow("down"); await app.flush()
    app.mockInput.pressEnter(); await app.flush()
    await waitFrame(frame => frame.includes("ABCD1234"))
    approved = true
    await waitFrame(frame => frame.includes("Fixture") && frame.includes("Free") && frame.includes("Disconnect this client"))
    expect(app.captureCharFrame()).toContain("Hosted AI included")
    expect(calls.filter(value => value === "request").length).toBe(1); expect(calls.filter(value => value === "adopt").length).toBe(1); expect(calls.includes("login")).toBe(false)
    app.mockInput.pressEnter(); await app.flush()
    await waitFrame(frame => frame.includes("Available: $2.00"))
    observedPlan = "active"; await account.loadPlan()
    await waitFrame(frame => frame.includes("Fixture") && frame.includes("Plus") && frame.includes("$2.25") && frame.includes("$3.00"))
    expect(app.captureCharFrame()).toContain("Local/BYOK always free")
    const planReadsBeforeCredits = calls.filter(value => value === "subscription.status").length
    usageFails = true; app.mockInput.pressEnter(); await app.flush()
    await waitFrame(frame => frame.includes("Fixture") && frame.includes("Plus") && frame.includes(accountText("usage_unavailable")))
    expect(account.view.error).toBe(null); expect(account.view.usage).toBe(null)
    expect(calls.filter(value => value === "subscription.status").length).toBe(planReadsBeforeCredits)
    expect(app.captureCharFrame()).not.toContain("private-upstream-detail")
    const count = calls.filter(value => ["login", "request", "adopt", "usage", "unlink"].includes(value)).length
    for (const lang of ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as Lang[]) {
      setLang(lang); dialog.replace(() => <AccountPanel />)
      await waitFrame(frame => frame.includes(accountText("title")) && frame.includes(accountText("disconnect")))
      expect(calls.filter(value => ["login", "request", "adopt", "usage", "unlink"].includes(value)).length).toBe(count)
      if (lang !== "en") expect(accountText("disconnect")).not.toBe(ACCOUNT_TEXT.disconnect[1])
    }
    app.mockInput.pressEscape(); await app.flush(); expect(dialog.stack.length).toBe(0)
    expect(account.view.session?.authenticated).toBe(true)
    setLang("en"); authenticated = false; approved = false; await account.refresh(); delayedConsumption = true
    dialog.replace(() => <AccountPanel />)
    await waitFrame(frame => frame.includes("Use another app on this computer"))
    app.mockInput.pressArrow("down"); await app.flush()
    app.mockInput.pressEnter(); await app.flush()
    await waitFrame(frame => Boolean(finishConsumption) && frame.includes("Cancel"))
    const adoptions = calls.filter(value => value === "adopt").length
    app.mockInput.pressEscape(); await app.flush()
    expect(dialog.stack.length).toBe(0); expect(account.view.challenge).toBe(null); expect(account.view.busy).toBe(false)
    approved = true; finishConsumption!(); await Bun.sleep(35)
    expect(calls.filter(value => value === "adopt").length).toBe(adoptions)
    expect(account.view.session?.authenticated).toBe(false)
    // A true close during the initial account status read must not start a subscription request later.
    delayedStatus = true; dialog.replace(() => <AccountPanel />)
    await waitFrame(() => Boolean(finishStatus))
    const planReads = calls.filter(value => value === "subscription.status").length
    app.mockInput.pressEscape(); await app.flush(); expect(dialog.stack.length).toBe(0)
    delayedStatus = false; finishStatus!(); await Bun.sleep(35); await app.renderOnce()
    expect(calls.filter(value => value === "subscription.status").length).toBe(planReads)
  } finally { app.renderer.destroy(); account.dispose(); setLang(previous) }
}, 15_000)

test("account starts browser sign-in first and keeps the same usable link, copy and refresh actions while polling", async () => {
  const previous = getLang(), parent = resolve("../../../output")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "tui-account-login-render-")); await writeFile(join(root, "kv.json"), "{}")
  const calls: string[] = [], copied: string[] = [], opened: string[] = []
  const url = "https://app.uptokey.com/api/account/native/authorize?id=af4b344f-1848-4016-9c42-f3b3454fe9c1"
  const signedOut = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" as const }
  const connected = { ...signedOut, authenticated: true, state: "connected" as const, profile: { displayName: "Fixture" } }
  const ref = "acc_" + "c".repeat(64)
  let authenticated = false, delayStatus = false, loginStarted = false, finishStatus: (() => void) | undefined
  const account = new TuiAccount({
    getAccountSession: async () => { calls.push("status"); if (delayStatus) await new Promise<void>(resolve => { finishStatus = resolve }); return authenticated ? connected : loginStarted ? { ...signedOut, state: "connecting" } : signedOut },
    getAvailableAccounts: async () => ({ revision: authenticated ? 1 : 0, currentAccountRef: authenticated ? ref : null, currentOwned: authenticated ? true : null, accounts: [] }),
    getAccountRequests: async () => [],
    requestAccountAccess: async () => { calls.push("share"); throw Error("unexpected_local_share") },
    consumeAccountAccess: async () => {}, approveAccountRequest: async () => {},
    adoptAccount: async () => { throw Error("unexpected_adoption") }, unlinkAccount: async () => { throw Error("unexpected_unlink") },
    startAccountLogin: async () => { loginStarted = true; calls.push("login"); return { loginUrl: url, userCode: "1234ABCD", expiresAt: Date.now() + 60_000 } },
    getAccountConnection: async () => { calls.push("connection"); return { loginUrl: url, expiresAt: Date.now() + 60_000 } },
    signOutAccount: async () => signedOut,
    getAccountUsage: async () => ({ state: "unavailable", verifiedAt: new Date().toISOString() }),
    getAccountPlan: async () => { calls.push("subscription.status"); return { accountRef: "account_" + "d".repeat(64), subscription: { status: "none", cancelAtPeriodEnd: false, currentPeriodEnd: null }, allowance: null } },
  }, { intervalMs: 60_000 })
  const login = account.login.bind(account), reopen = account.reopenLogin.bind(account)
  account.login = () => login(async value => { opened.push(value); return false })
  account.reopenLogin = () => reopen(async value => { opened.push(value); return true })
  setLang("en")
  setBackend({ controller: { account }, onChange: (handler: () => void) => { account.on("change", handler); return () => account.off("change", handler) } } as never)
  let dialog!: DialogContext
  function Launch() { dialog = useDialog(); onMount(() => dialog.replace(() => <AccountPanel />)); return <box /> }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ClipboardProvider value={{ write: async value => { copied.push(value) } }}><ToastProvider><DialogProvider><Launch /></DialogProvider></ToastProvider></ClipboardProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider></TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 120, height: 38, kittyKeyboard: true })
  const waitFrame = async (predicate: (frame: string) => boolean) => {
    const until = Date.now() + 3000
    do { await Bun.sleep(10); await app.renderOnce(); if (predicate(app.captureCharFrame())) return } while (Date.now() < until)
    expect(predicate(app.captureCharFrame())).toBe(true)
  }
  try {
    await waitFrame(frame => frame.includes("Sign in") && frame.includes("Use another app on this computer"))
    expect(app.captureCharFrame().indexOf("Sign in")).toBeLessThan(app.captureCharFrame().indexOf("Use another app on this computer"))
    app.mockInput.pressEnter(); await app.flush()
    await waitFrame(frame => frame.includes("Open browser") && frame.includes("Copy link"))
    expect(calls.filter(value => value === "login")).toHaveLength(1)
    expect(calls).not.toContain("share")
    expect(opened).toEqual([url])
    expect(account.view.error).toBe("account_browser_unavailable")
    expect(app.captureCharFrame().replace(/\s/g, "")).toContain(url)
    expect(app.captureCharFrame()).toContain("Open or copy the link to sign in.")
    for (const lang of ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as Lang[]) {
      setLang(lang); dialog.replace(() => <AccountPanel />)
      await waitFrame(frame => frame.includes(accountText("open_browser")) && frame.includes(accountText("copy_link")))
      expect(app.captureCharFrame().replace(/\s/g, "")).toContain(url)
      expect(calls.filter(value => value === "login")).toHaveLength(1)
    }
    setLang("en"); dialog.replace(() => <AccountPanel />)
    await waitFrame(frame => frame.includes("Open browser"))
    app.mockInput.pressArrow("down"); await app.flush(); app.mockInput.pressEnter(); await app.flush()
    await waitFrame(() => copied.length === 1)
    expect(copied).toEqual([url])
    // Reopening the browser reuses the pending authorization rather than generating another code.
    app.mockInput.pressArrow("up"); await app.flush(); app.mockInput.pressEnter(); await app.flush()
    await waitFrame(() => opened.length === 2)
    expect(opened).toEqual([url, url]); expect(calls.filter(value => value === "login")).toHaveLength(1)
    delayStatus = true; const refresh = account.refresh()
    await waitFrame(frame => Boolean(finishStatus) && frame.includes("Open browser") && frame.includes("Copy link") && frame.includes("Refresh"))
    expect(account.view.busy).toBe(true)
    app.mockInput.pressArrow("down"); await app.flush(); app.mockInput.pressEnter(); await app.flush()
    await waitFrame(() => copied.length === 2)
    expect(copied).toEqual([url, url])
    expect(opened).toEqual([url, url])
    authenticated = true; delayStatus = false; finishStatus!(); await refresh
    await waitFrame(frame => frame.includes("Fixture") && frame.includes("Free") && frame.includes("Hosted AI included"))
    expect(account.view.login).toBe(null)
    expect(calls.filter(value => value === "login")).toHaveLength(1)
    // Recovery of an already signed-in terminal keeps its own URL and copy path, without another login.
    account.offerHostedConnection()
    await account.connectHosted(async value => { opened.push(value); return false })
    dialog.replace(() => <AccountPanel />)
    await waitFrame(frame => frame.includes(accountText("connect_terminal")) && frame.includes("Copy link") && frame.includes("Open or copy the link to sign in."))
    expect(app.captureCharFrame().replace(/\s/g, "")).toContain(url)
    expect(account.view.session?.authenticated).toBe(true); expect(account.view.login).toBe(null)
    app.mockInput.pressKey("HOME"); await app.flush(); app.mockInput.pressArrow("down"); app.mockInput.pressArrow("down"); await app.flush(); app.mockInput.pressEnter(); await app.flush()
    await waitFrame(() => copied.length === 3)
    expect(copied.at(-1)).toBe(url); expect(calls.filter(value => value === "connection")).toHaveLength(1); expect(calls.filter(value => value === "login")).toHaveLength(1)
  } finally { app.renderer.destroy(); account.dispose(); setLang(previous) }
}, 15_000)
