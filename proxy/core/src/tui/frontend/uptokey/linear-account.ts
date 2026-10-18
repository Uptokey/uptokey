import type { TuiAccount } from "../../account.ts"
import { accountText } from "../../account-ui.ts"
import { accountPlanPresentation, accountViewSummary } from "../../account-plan.ts"
import { getLang } from "../../i18n.ts"

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
  if (account.view.session?.authenticated) {
    for (const line of accountPlanPresentation(account.view.plan).details) ui.say(line)
    ui.say(accountText("local_byok_free"))
  }
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
  actions.push({ label: accountText("refresh"), run: async () => { await account.refresh(); await account.loadPlan() } })
  if (view.error) actions.push({ label: accountText("details"), run: () => ui.say(view.error!) })
  const selected = await ui.choose(actions, item => item.label)
  if (selected) { await selected.run(); ui.say(accountSummary(account)) }
}
