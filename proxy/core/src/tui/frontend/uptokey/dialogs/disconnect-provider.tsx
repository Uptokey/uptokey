import { createEffect, createSignal, onCleanup } from "solid-js"
import { DialogSelect, type DialogSelectRef } from "../../vendor/opencode-tui/ui/dialog-select"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"
import { accountText } from "../../../account-ui.ts"
import { HOSTED_PROVIDER } from "../../../hosted.ts"
import { disconnectProvider, disconnectTargets, type DisconnectTarget } from "../provider-actions.ts"

/** Cancel is first: Enter from the previous list can never accidentally remove access. */
export function DisconnectProvider(props: { providerId: string; label: string; onBack: () => void }) {
  const backend = getBackend(), dialog = useDialog(), toast = useToast(), { theme } = useTheme()
  const targets = disconnectTargets(backend, props.providerId, props.label)
  const [target, setTarget] = createSignal<DisconnectTarget | undefined>(targets.length === 1 ? targets[0] : undefined)
  const [busy, setBusy] = createSignal(false)
  let active = true
  let selection: DialogSelectRef<string> | undefined
  createEffect(() => { target(); queueMicrotask(() => selection?.moveTo("cancel")) })
  onCleanup(() => { active = false })
  async function confirm() {
    const selected = target()
    if (!selected || busy()) return
    setBusy(true)
    try {
      await disconnectProvider(backend, selected)
      if (!active) return
      dialog.clear()
      toast.show({ variant: "success", message: ui("provider_disconnected", { name: selected.label }) })
    } catch {
      if (active) { setBusy(false); toast.show({ variant: "error", message: ui("provider_disconnect_failed") }) }
    }
  }
  return <DialogSelect title={ui("provider_disconnect", { name: target()?.label ?? props.label })}
    titleView={<box flexDirection="column"><text fg={theme.text}>{ui("provider_disconnect", { name: target()?.label ?? props.label })}</text><text fg={theme.textMuted}>{ui(props.providerId === HOSTED_PROVIDER ? "provider_disconnect_account_hint" : "provider_disconnect_key_hint")}</text></box>}
    ref={value => { selection = value }} renderFilter={false} locked={busy()} options={busy() ? [{ title: ui("provider_disconnecting"), value: "busy" }] : target() ? [
      { title: accountText("cancel"), value: "cancel", onSelect: props.onBack },
      { title: ui("provider_disconnect_short"), value: "confirm", onSelect: () => { void confirm() } },
    ] : [
      { title: accountText("cancel"), value: "cancel", onSelect: props.onBack },
      ...targets.map(item => ({ title: item.label, value: item.connectionId, onSelect: () => setTarget(item) })),
    ]} />
}
