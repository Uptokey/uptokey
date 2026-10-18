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

test("rendered account panel requests/adopts once, returns focus and exposes real localized state in ten languages", async () => {
  const previous = getLang(), parent = resolve("../../../output")
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, "tui-account-render-")); await writeFile(join(root, "kv.json"), "{}")
  const calls: string[] = [], ref = "synthetic-account-reference-01"
  let authenticated = false, approved = false, delayedConsumption = false
  let observedPlan: "none" | "active" = "none", delayedStatus = false
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
    getAccountUsage: async () => { calls.push("usage"); return { state: "observed", verifiedAt: new Date().toISOString(), currency: "USD", unit: "micro_usd", availableMicros: 2_000_000, reservedMicros: 0, spentMicros: 0 } },
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
    expect(predicate(app.captureCharFrame())).toBe(true)
  }
  try {
    await app.renderOnce()
    await waitFrame(frame => frame.includes("Uptokey account") && frame.includes("Use account on this computer"))
    expect(calls.includes("login")).toBe(false); expect(calls.includes("usage")).toBe(false)
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
    await waitFrame(frame => frame.includes("Use account on this computer"))
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
