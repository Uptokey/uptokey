import { createEffect, createMemo, on, onCleanup, onMount, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../vendor/opencode-tui/ui/dialog-select"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { getBackend } from "../backend/registry.ts"
import { TextView } from "../dialogs/text-view.tsx"
import { useControllerTick } from "./use-controller.ts"
import { accountErrorText, accountText } from "../../../account-ui.ts"
import { accountPlanPresentation, accountViewSummary, loadAccountPlanForView } from "../../../account-plan.ts"
import { getLang } from "../../../i18n.ts"
import type { TuiAccountRequest } from "../../../client.ts"
import { useBindings } from "../../vendor/opencode-tui/keymap"
import { useClipboard } from "../../vendor/opencode-tui/context/clipboard"
import { clipboardErrorMessage } from "../../vendor/opencode-tui/clipboard"
import { useToast } from "../../vendor/opencode-tui/ui/toast"

/** A compact account menu; every operation is explicit and uses the core's existing authority. */
export function AccountPanel() {
  const account = getBackend().controller.account
  const dialog = useDialog(), { theme } = useTheme(), tick = useControllerTick()
  const clipboard = useClipboard(), toast = useToast()
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
  async function copyLoginLink() {
    const url = account.view.login?.loginUrl
    if (!url) return
    try {
      if (!clipboard.write) throw Error("clipboard_unavailable")
      await clipboard.write(url)
      toast.show({ message: accountText("link_copied"), variant: "success" })
    } catch (error) { toast.show({ message: clipboardErrorMessage(error), variant: "warning" }) }
  }
  function approve(request: TuiAccountRequest, accountRef: string) {
    dialog.replace(() => <DialogSelect title={accountText("approve", { name: request.clientName, code: request.userCode })} titleView={<box flexDirection="column"><text fg={theme.text}>{accountText("approve", { name: request.clientName, code: request.userCode })}</text><text fg={theme.textMuted}>{accountText("consent")}</text></box>} renderFilter={false} options={[
      { title: accountText("allow"), value: "allow", onSelect: async () => { await account.approve(request, accountRef); dialog.replace(() => <AccountPanel />) } },
      { title: accountText("cancel"), value: "cancel", onSelect: () => dialog.replace(() => <AccountPanel />) },
    ]} />)
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    const view = state(), rows: DialogSelectOption<string>[] = []
    if (view.busy && !view.session && !view.login && !view.challenge) return [{ title: accountText("loading"), value: "busy", disabled: true }]
    if (view.login) {
      rows.push({ title: accountText("open_browser"), value: "open-browser", onSelect: () => { void account.reopenLogin() } })
      rows.push({ title: accountText("copy_link"), value: "copy-link", onSelect: () => { void copyLoginLink() } })
      rows.push({ title: accountText("cancel"), value: "cancel", onSelect: () => account.cancelPending() })
    }
    else if (view.challenge) {
      if (view.session?.loginAvailable) rows.push({ title: accountText("sign_in"), value: "sign-in", onSelect: () => { account.cancelPending(); void account.login() } })
      rows.push({ title: accountText("cancel"), value: "cancel", onSelect: () => account.cancelPending() })
    }
    else if (!view.session?.authenticated) {
      for (const item of view.available?.accounts ?? []) rows.push({
        title: accountText("use", { name: item.session.profile?.displayName ?? item.session.profile?.email ?? accountText("title") }),
        value: item.accountRef, onSelect: () => { void account.adopt(item.accountRef) },
      })
      if (view.session?.configured) {
        if (view.session.loginAvailable) rows.push({ title: accountText("sign_in"), value: "sign-in", onSelect: () => { void account.login() } })
        rows.push({ title: accountText("share"), value: "share", onSelect: () => { void account.requestAccess() } })
      }
    } else {
      rows.push({ title: accountText("usage"), value: "usage", description: view.usage ? view.usage.state === "observed" ? accountText("balance", { value: new Intl.NumberFormat(getLang(), { style: "currency", currency: "USD" }).format(view.usage.availableMicros! / 1_000_000) }) : accountText("usage_unavailable") : undefined, onSelect: () => { void account.loadUsage() } })
      const available = view.available
      if (available?.currentOwned) {
        for (const request of view.requests) rows.push({ title: accountText("approve", { name: request.clientName, code: request.userCode }), value: request.id, onSelect: () => approve(request, available.currentAccountRef!) })
        rows.push({ title: accountText("sign_out"), value: "sign-out", onSelect: () => { void account.logout() } })
      } else rows.push({ title: accountText("disconnect"), value: "disconnect", onSelect: () => { void account.disconnect() } })
    }
    rows.push({ title: accountText("refresh"), value: "refresh", description: view.busy ? accountText("loading") : undefined, onSelect: () => { void loadAccountPlanForView(account, lifetime.signal) } })
    if (view.error) rows.push({ title: accountText("details"), value: "details", onSelect: () => dialog.replace(() => <TextView title={accountText("details")} text={view.error!} />) })
    return rows
  })
  let selection: DialogSelectRef<string> | undefined
  // A successful sign-in must not turn the prior action's row index into Sign out/Disconnect.
  // Polling within the same phase leaves the person's keyboard selection where it is.
  createEffect(on(() => state().session?.authenticated ? "connected" : state().login ? "browser" : state().challenge ? "local-share" : "signed-out", () => {
    const first = options()[0]
    if (first) selection?.moveTo(first.value)
  }))
  return <DialogSelect title={accountText("title")} titleView={<box flexDirection="column"><text fg={theme.text}>{accountText("title")}</text><text fg={state().session?.authenticated && !state().error ? theme.success : theme.textMuted}>{summary()}</text><Show when={state().login}>{login => <text fg={theme.primary} wrapMode="char">{login().loginUrl}</text>}</Show><Show when={state().login && state().error}><text fg={theme.textMuted}>{accountErrorText(state().error!)}</text></Show>{planDetails().map(line => <text fg={theme.textMuted}>{line}</text>)}</box>} ref={value => { selection = value }} renderFilter={false} options={options()} />
}
