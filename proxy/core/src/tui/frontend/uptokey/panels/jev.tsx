/**
 * /jev — Jev (TypeSafe System One) for this terminal: state, the TypeSafe key (masked, stored by the core in the
 * vault for this terminal's identity), on/off. Jev judges requests before sending, decisions waiting for approval and
 * compaction summaries; it never authorizes an effect.
 */
import { createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../vendor/opencode-tui/ui/dialog-select"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { getBackend } from "../backend/registry.ts"
import { SecretPrompt } from "../dialogs/secret-prompt.tsx"
import { ui } from "../i18n.ts"

interface ProfileView {
  revision: number
  enabled: boolean
  configured: boolean
  keyPresent: boolean
  model: string
}

async function readProfile(): Promise<ProfileView | null> {
  const response = await getBackend().controller.client.fetchRaw("/v1/workspace/classification/config")
  if (!response.ok) return null
  const body = (await response.json()) as Partial<ProfileView>
  return { revision: Number(body.revision ?? 0), enabled: Boolean(body.enabled), configured: Boolean(body.configured), keyPresent: Boolean(body.keyPresent), model: String(body.model ?? "") }
}

async function writeProfile(input: { expectedRevision: number; enabled: boolean; model: string; apiKey?: string }) {
  const response = await getBackend().controller.client.fetchRaw("/v1/workspace/classification/config", { method: "POST", body: JSON.stringify(input) })
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { error?: { type?: string; code?: string } }
    throw new Error(body.error?.code ?? body.error?.type ?? `http_${response.status}`)
  }
}

export function JevPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const [tick, setTick] = createSignal(0)
  const [data] = createResource(tick, async () => {
    backend.resetJev()
    const [profile, status] = await Promise.all([readProfile().catch(() => null), backend.jevStatus()])
    return { profile, status }
  })

  async function configureKey() {
    const profile = data()?.profile
    const key = await SecretPrompt.show(dialog, ui("jev_key_title"), { description: () => <text>{ui("jev_key_hint")}</text> })
    if (!key) return
    try {
      await writeProfile({ expectedRevision: profile?.revision ?? 0, enabled: true, model: profile?.model || "jev-latest", apiKey: key })
      toast.show({ variant: "success", message: ui("jev_key_saved") })
    } catch (error) {
      toast.show({ variant: "error", message: ui("jev_save_failed", { reason: error instanceof Error ? error.message : String(error) }) })
    }
    dialog.replace(() => <JevPanel />)
  }

  async function toggle() {
    const profile = data()?.profile
    if (!profile?.keyPresent) return void configureKey()
    try {
      await writeProfile({ expectedRevision: profile.revision, enabled: !profile.enabled, model: profile.model || "jev-latest" })
    } catch (error) {
      toast.show({ variant: "error", message: ui("jev_save_failed", { reason: error instanceof Error ? error.message : String(error) }) })
    }
    setTick((value) => value + 1)
  }

  const options = (): DialogSelectOption<string>[] => {
    const value = data()
    const status = value?.status
    const headline = !value
      ? ui("jev_judging")
      : status?.active
        ? ui("jev_status_active", { model: status.model, latency: status.lastLatencyMs ?? "—", source: status.source ?? "—" })
        : ui("jev_status_inactive", { reason: ui(`jev_reason_${status?.reason ?? "no_profile"}`) })
    return [
      { title: headline, value: "status", category: ui("jev_title"), description: ui("jev_scope"), onSelect: () => setTick((tickValue) => tickValue + 1) },
      { title: value?.profile?.keyPresent ? ui("jev_key_replace") : ui("jev_key_add"), value: "key", category: ui("jev_title"), onSelect: () => void configureKey() },
      ...(value?.profile?.keyPresent
        ? [{ title: value.profile.enabled ? ui("jev_disable") : ui("jev_enable"), value: "toggle", category: ui("jev_title"), onSelect: () => void toggle() }]
        : []),
    ]
  }

  return <DialogSelect title={ui("jev_title")} options={options()} />
}
