import type { TuiAccount } from "../../account.ts"
import { accountText, accountErrorText, type AccountTextKey } from "../../account-ui.ts"
import { getLang } from "../../i18n.ts"

export function accountSummary(account: TuiAccount): string {
  const view = account.view
  if (view.error) return accountErrorText(view.error)
  if (view.challenge) return accountText("waiting", { code: view.challenge.userCode })
  if (view.login) return accountText("browser", { code: view.login.userCode })
  const session = view.session
  if (!session) return accountText("loading")
  if (!session.configured) return accountText("unavailable")
  if (!session.authenticated) return accountText("signed_out")
  return `${session.profile?.displayName ?? session.profile?.email ?? accountText("connected")}${session.profile?.plan ? ` · ${accountText(session.profile.plan as AccountTextKey)}` : ""}`
}

/** The screen-reader presentation uses the same account consumer and explicit approval as the fullscreen menu. */
export async function runLinearAccount(account: TuiAccount, ui: {
  say: (text: string) => void
  choose: <T>(rows: readonly T[], label: (value: T) => string) => Promise<T | undefined>
}): Promise<void> {
  await account.refresh()
  ui.say(`${accountText("title")}\n${accountSummary(account)}`)
  const actions: Array<{ label: string; run: () => Promise<void> | void }> = []
  const view = account.view
  if (view.challenge || view.login) actions.push({ label: accountText("cancel"), run: () => account.cancelPending() })
  else if (!view.session?.authenticated) {
    for (const item of view.available?.accounts ?? []) actions.push({ label: accountText("use", { name: item.session.profile?.displayName ?? item.session.profile?.email ?? accountText("title") }), run: () => account.adopt(item.accountRef) })
    if (view.session?.configured) {
      actions.push({ label: accountText("share"), run: () => account.requestAccess() })
      if (view.session.loginAvailable) actions.push({ label: accountText("sign_in"), run: () => account.login() })
    }
  } else {
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
      actions.push({ label: accountText("sign_out"), run: () => account.logout() })
    } else actions.push({ label: accountText("disconnect"), run: () => account.disconnect() })
  }
  actions.push({ label: accountText("refresh"), run: () => account.refresh() })
  if (view.error) actions.push({ label: accountText("details"), run: () => ui.say(view.error!) })
  const selected = await ui.choose(actions, item => item.label)
  if (selected) { await selected.run(); ui.say(accountSummary(account)) }
}
