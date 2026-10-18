import { createMemo, onCleanup, onMount } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../vendor/opencode-tui/ui/dialog-select"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { getBackend } from "../backend/registry.ts"
import { TextView } from "../dialogs/text-view.tsx"
import { useControllerTick } from "./use-controller.ts"
import { accountText } from "../../../account-ui.ts"
import { accountPlanPresentation, accountViewSummary, loadAccountPlanForView } from "../../../account-plan.ts"
import { getLang } from "../../../i18n.ts"
import type { TuiAccountRequest } from "../../../client.ts"
import { useBindings } from "../../vendor/opencode-tui/keymap"

/** A compact account menu; every operation is explicit and uses the core's existing authority. */
export function AccountPanel() {
  const account = getBackend().controller.account
  const dialog = useDialog(), { theme } = useTheme(), tick = useControllerTick()
  const lifetime = new AbortController()
  onMount(() => { void loadAccountPlanForView(account, lifetime.signal) })
  const state = createMemo(() => { tick(); return { ...account.view } })
  const pending = () => { tick(); return Boolean(account.view.challenge || account.view.login || account.view.busy && !account.view.session?.authenticated) }
  useBindings(() => ({ enabled: pending(), priority: 2, bindings: [
    { key: "escape", desc: accountText("cancel"), cmd: () => { account.cancelPending(); dialog.clear() } },
  ] }))
  // A true modal close cancels pending access; replacing the panel for language/details preserves its state.
  onCleanup(() => { lifetime.abort(); if (!dialog.stack.length) { account.cancelPlanRead(); if (pending()) account.cancelPending() } })
  const summary = createMemo(() => accountViewSummary(state()))
  const planDetails = createMemo(() => state().session?.authenticated ? [...accountPlanPresentation(state().plan).details, accountText("local_byok_free")] : [])
  function approve(request: TuiAccountRequest, accountRef: string) {
    dialog.replace(() => <DialogSelect title={accountText("approve", { name: request.clientName, code: request.userCode })} titleView={<box flexDirection="column"><text fg={theme.text}>{accountText("approve", { name: request.clientName, code: request.userCode })}</text><text fg={theme.textMuted}>{accountText("consent")}</text></box>} renderFilter={false} options={[
      { title: accountText("allow"), value: "allow", onSelect: async () => { await account.approve(request, accountRef); dialog.replace(() => <AccountPanel />) } },
      { title: accountText("cancel"), value: "cancel", onSelect: () => dialog.replace(() => <AccountPanel />) },
    ]} />)
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const view = state(), rows: DialogSelectOption<string>[] = []
    if (view.busy) return pending() ? [{ title: accountText("cancel"), value: "cancel", onSelect: () => account.cancelPending() }] : [{ title: accountText("loading"), value: "busy" }]
    if (view.challenge || view.login) rows.push({ title: accountText("cancel"), value: "cancel", onSelect: () => account.cancelPending() })
    else if (!view.session?.authenticated) {
      for (const item of view.available?.accounts ?? []) rows.push({
        title: accountText("use", { name: item.session.profile?.displayName ?? item.session.profile?.email ?? accountText("title") }),
        value: item.accountRef, onSelect: () => { void account.adopt(item.accountRef) },
      })
      if (view.session?.configured) {
        rows.push({ title: accountText("share"), value: "share", onSelect: () => { void account.requestAccess() } })
        if (view.session.loginAvailable) rows.push({ title: accountText("sign_in"), value: "sign-in", onSelect: () => { void account.login() } })
      }
    } else {
      rows.push({ title: accountText("usage"), value: "usage", description: view.usage ? view.usage.state === "observed" ? accountText("balance", { value: new Intl.NumberFormat(getLang(), { style: "currency", currency: "USD" }).format(view.usage.availableMicros! / 1_000_000) }) : accountText("usage_unavailable") : undefined, onSelect: () => { void account.loadUsage() } })
      const available = view.available
      if (available?.currentOwned) {
        for (const request of view.requests) rows.push({ title: accountText("approve", { name: request.clientName, code: request.userCode }), value: request.id, onSelect: () => approve(request, available.currentAccountRef!) })
        rows.push({ title: accountText("sign_out"), value: "sign-out", onSelect: () => { void account.logout() } })
      } else rows.push({ title: accountText("disconnect"), value: "disconnect", onSelect: () => { void account.disconnect() } })
    }
    rows.push({ title: accountText("refresh"), value: "refresh", onSelect: () => { void loadAccountPlanForView(account, lifetime.signal) } })
    if (view.error) rows.push({ title: accountText("details"), value: "details", onSelect: () => dialog.replace(() => <TextView title={accountText("details")} text={view.error!} />) })
    return rows
  })
  return <DialogSelect title={accountText("title")} titleView={<box flexDirection="column"><text fg={theme.text}>{accountText("title")}</text><text fg={state().session?.authenticated && !state().error ? theme.success : theme.textMuted}>{summary()}</text>{planDetails().map(line => <text fg={theme.textMuted}>{line}</text>)}</box>} renderFilter={false} options={options()} />
}
