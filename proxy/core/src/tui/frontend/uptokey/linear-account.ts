import type { TuiAccount } from "../../account.ts"
import { accountErrorText, accountText } from "../../account-ui.ts"
import { accountPlanPresentation, accountViewSummary } from "../../account-plan.ts"
import { getLang } from "../../i18n.ts"
import { ui as text } from "./i18n.ts"
import { writeClipboard as copy } from "../../clipboard.ts"

export function accountSummary(account: TuiAccount): string {
  return accountViewSummary(account.view)
}

/** The screen-reader presentation uses the same account consumer and explicit approval as the fullscreen menu. */
export async function runLinearAccount(account: TuiAccount, ui: {
  say: (text: string) => void
  choose: <T>(rows: readonly T[], label: (value: T) => string) => Promise<T | undefined>
}): Promise<void> {
  await account.refresh()
  await account.loadPlan()
  ui.say(`${accountText("title")}\n${accountSummary(account)}`)
  const showLoginLink = () => {
    const link = account.view.connection ?? account.view.login
    if (!link) return
    ui.say(link.loginUrl)
    if (account.view.error) ui.say(accountErrorText(account.view.error))
  }
  showLoginLink()
  if (account.view.session?.authenticated) {
    for (const line of accountPlanPresentation(account.view.plan).details) ui.say(line)
    ui.say(accountText("local_byok_free"))
  }
  const actions: Array<{ label: string; run: () => Promise<void> | void }> = []
  const view = account.view
  if (view.login) {
    actions.push({ label: accountText("open_browser"), run: () => account.reopenLogin() })
    actions.push({ label: accountText("cancel"), run: () => account.cancelPending() })
  }
  else if (view.challenge) {
    if (view.session?.loginAvailable) actions.push({ label: accountText("sign_in"), run: () => { account.cancelPending(); return account.login() } })
    actions.push({ label: accountText("cancel"), run: () => account.cancelPending() })
  }
  else if (!view.session?.authenticated) {
    for (const item of view.available?.accounts ?? []) actions.push({ label: accountText("use", { name: item.session.profile?.displayName ?? item.session.profile?.email ?? accountText("title") }), run: () => account.adopt(item.accountRef) })
    if (view.session?.configured) {
      if (view.session.loginAvailable) actions.push({ label: accountText("sign_in"), run: () => account.login() })
      actions.push({ label: accountText("share"), run: () => account.requestAccess() })
    }
  } else {
    if (view.connectionNeeded) actions.push({ label: accountText("connect_terminal"), run: () => account.connectHosted() })
    if (view.connection) {
      actions.push({ label: accountText("open_browser"), run: () => account.connectHosted() })
      actions.push({ label: accountText("copy_link"), run: async () => {
        const link = account.view.connection?.loginUrl
        if (!link) return
        try { await copy(link); ui.say(accountText("link_copied")) } catch { ui.say(accountText("browser_fallback")) }
      } })
    }
    const disconnect = async () => {
      ui.say(text("provider_disconnect_account_hint"))
      const binding = `${view.available?.currentAccountRef}:${view.available?.revision}`
      const choice = await ui.choose(["cancel", "disconnect"] as const, value => value === "cancel" ? accountText("cancel") : text("provider_disconnect_short"))
      if (choice !== "disconnect" || `${account.view.available?.currentAccountRef}:${account.view.available?.revision}` !== binding) return
      if (view.available?.currentOwned) await account.logout(); else await account.disconnect()
    }
    actions.push({ label: accountText("usage"), run: async () => {
      await account.loadUsage()
      const usage = account.view.usage
      ui.say(usage?.state === "observed" ? accountText("balance", { value: new Intl.NumberFormat(getLang(), { style: "currency", currency: "USD" }).format(usage.availableMicros! / 1_000_000) }) : accountText("usage_unavailable"))
    } })
    const available = view.available
    if (available?.currentOwned) {
      for (const request of view.requests) actions.push({ label: accountText("approve", { name: request.clientName, code: request.userCode }), run: async () => {
        ui.say(accountText("consent"))
        const choice = await ui.choose(["allow", "cancel"] as const, value => accountText(value))
        if (choice === "allow") await account.approve(request, available.currentAccountRef!)
      } })
      actions.push({ label: accountText("sign_out"), run: disconnect })
    } else actions.push({ label: accountText("disconnect"), run: disconnect })
  }
  actions.push({ label: accountText("refresh"), run: async () => { await account.refresh(); await account.loadPlan() } })
  if (view.error) actions.push({ label: accountText("details"), run: () => ui.say(view.error!) })
  const selected = await ui.choose(actions, item => item.label)
  if (selected) { await selected.run(); ui.say(accountSummary(account)); showLoginLink() }
}
