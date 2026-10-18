import { test, expect } from "bun:test"
import { TuiAccount } from "../../account.ts"
import { accountText } from "../../account-ui.ts"
import { getLang, setLang } from "../../i18n.ts"
import { runLinearAccount } from "./linear-account.ts"

test("linear account makes browser sign-in primary and prints the exact pending URL on initial entry and reopen", async () => {
  const before = getLang(); setLang("en")
  const calls: string[] = [], output: string[] = [], opened: string[] = [], choices: string[][] = []
  const url = "https://app.uptokey.com/api/account/native/authorize?id=5bf37e97-92cf-42fb-8c3d-29f8095552e2"
  const session = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" as const }
  const account = new TuiAccount({
    getAccountSession: async () => session,
    getAvailableAccounts: async () => ({ revision: 0, currentAccountRef: null, currentOwned: null, accounts: [] }),
    getAccountRequests: async () => [],
    requestAccountAccess: async () => { calls.push("share"); return { id: "synthetic", userCode: "ABCD1234", expiresAt: new Date(Date.now() + 60_000).toISOString() } },
    consumeAccountAccess: async () => {}, approveAccountRequest: async () => {},
    adoptAccount: async () => { throw Error("unused") }, unlinkAccount: async () => { throw Error("unused") },
    startAccountLogin: async () => { calls.push("login"); return { loginUrl: url, userCode: "5678ABCD", expiresAt: Date.now() + 60_000 } },
    signOutAccount: async () => session,
    getAccountUsage: async () => ({ state: "unavailable", verifiedAt: new Date().toISOString() }),
  }, { intervalMs: 60_000 })
  const login = account.login.bind(account), reopen = account.reopenLogin.bind(account)
  account.login = () => login(async value => { opened.push(value); return false })
  account.reopenLogin = () => reopen(async value => { opened.push(value); return true })
  const ui = {
    say: (text: string) => { output.push(text) },
    choose: async <T>(rows: readonly T[], label: (value: T) => string): Promise<T | undefined> => { choices.push(rows.map(label)); return rows[0] },
  }
  try {
    await runLinearAccount(account, ui)
    expect(choices[0]?.[0]).toBe("Sign in")
    expect(calls).toEqual(["login"]); expect(opened).toEqual([url])
    expect(output).toContain(url)
    expect(output).toContain("Open or copy the link to sign in.")
    output.length = 0
    await runLinearAccount(account, ui)
    expect(choices[1]?.[0]).toBe("Open browser")
    expect(output.filter(value => value === url)).toHaveLength(2)
    expect(opened).toEqual([url, url]); expect(calls).toEqual(["login"])
    await runLinearAccount(account, { ...ui, choose: async <T>(rows: readonly T[], label: (value: T) => string) => rows.find(value => label(value) === accountText("cancel")) })
    expect(account.view.login).toBe(null)
  } finally { account.dispose(); setLang(before) }
})

test("linear account can leave a local sharing challenge for browser sign-in without an impossible website code", async () => {
  const before = getLang(); setLang("en")
  const calls: string[] = [], output: string[] = []
  const session = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" as const }
  const url = "https://app.uptokey.com/api/account/native/authorize?id=b909cc78-80fd-4a12-a130-e6931e69c9e1"
  const account = new TuiAccount({
    getAccountSession: async () => session,
    getAvailableAccounts: async () => ({ revision: 0, currentAccountRef: null, currentOwned: null, accounts: [] }),
    getAccountRequests: async () => [],
    requestAccountAccess: async () => ({ id: "synthetic", userCode: "ABCD1234", expiresAt: new Date(Date.now() + 60_000).toISOString() }),
    consumeAccountAccess: async () => {}, approveAccountRequest: async () => {},
    adoptAccount: async () => { throw Error("unused") }, unlinkAccount: async () => { throw Error("unused") },
    startAccountLogin: async () => { calls.push("login"); return { loginUrl: url, userCode: "5678ABCD", expiresAt: Date.now() + 60_000 } },
    signOutAccount: async () => session,
    getAccountUsage: async () => ({ state: "unavailable", verifiedAt: new Date().toISOString() }),
  }, { intervalMs: 60_000 })
  const login = account.login.bind(account); account.login = () => login(() => false)
  try {
    await account.refresh(); await account.requestAccess()
    await runLinearAccount(account, { say: value => { output.push(value) }, choose: async <T>(rows: readonly T[]) => rows[0] })
    expect(output.some(value => value.includes("another Uptokey app on this computer"))).toBe(true)
    expect(account.view.challenge).toBe(null)
    expect(account.view.login?.loginUrl).toBe(url)
    expect(output).toContain(url)
    expect(calls).toEqual(["login"])
  } finally { account.dispose(); setLang(before) }
})
