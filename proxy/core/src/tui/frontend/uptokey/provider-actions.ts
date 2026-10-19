import type { TuiController } from "../../controller.ts"
import type { ProviderSetupService } from "../../provider-setup.ts"
import { HOSTED_PROVIDER } from "../../hosted.ts"
import { ui } from "./i18n.ts"
import { accountText } from "../../account-ui.ts"

export interface DisconnectTarget {
  providerId: string
  connectionId: string
  label: string
  accountRef?: string | null
  revision?: number
}
interface DisconnectBackend { controller: TuiController; providerSetup?: Pick<ProviderSetupService, "disconnect">; refreshAll(): void }

/** A provider can own several credentials. Never turn one selected connection into a provider-wide revoke. */
export function disconnectTargets(backend: Pick<DisconnectBackend, "controller">, providerId: string, label: string): DisconnectTarget[] {
  const controller = backend.controller
  if (providerId === HOSTED_PROVIDER) {
    const account = controller.account.view
    return account.session?.authenticated && account.available?.currentAccountRef ? [{ providerId, connectionId: providerId, label: "Uptokey", accountRef: account.available.currentAccountRef, revision: account.available.revision }] : []
  }
  const profiles = controller.view.connections?.connections?.filter(item => item.providerId === providerId) ?? []
  const saved = profiles.filter(item => item.id === providerId || /^[0-9a-f-]{36}$/i.test(item.id))
  if (saved.length) return saved.map(item => ({ providerId, connectionId: item.id, label: item.label || label, revision: item.revision }))
  return [{ providerId, connectionId: providerId, label }]
}

/** The screen-reader path has the same explicit, cancel-first confirmation and executor. */
export async function runLinearProviderDisconnect(backend: DisconnectBackend, providerId: string, label: string, output: {
  say(text: string): void
  choose<T>(rows: readonly T[], label: (row: T) => string): Promise<T | undefined>
}): Promise<void> {
  const targets = disconnectTargets(backend, providerId, label)
  const selected = targets.length === 1 ? targets[0] : await output.choose(targets, item => item.label)
  if (!selected) return
  output.say(`${ui("provider_disconnect", { name: selected.label })}\n${ui(providerId === HOSTED_PROVIDER ? "provider_disconnect_account_hint" : "provider_disconnect_key_hint")}`)
  const confirm = await output.choose(["cancel", "disconnect"] as const, item => item === "cancel" ? accountText("cancel") : ui("provider_disconnect_short"))
  if (confirm !== "disconnect") return
  try { await disconnectProvider(backend, selected); output.say(ui("provider_disconnected", { name: selected.label })) }
  catch { output.say(ui("provider_disconnect_failed")) }
}

/** Runs only after explicit UI confirmation; no history or unrelated credential is changed. */
export async function disconnectProvider(backend: DisconnectBackend, target: DisconnectTarget): Promise<void> {
  const controller = backend.controller
  if (target.providerId === HOSTED_PROVIDER) {
    const account = controller.account, current = account.view.available
    if (!account.view.session?.authenticated || current?.currentAccountRef !== target.accountRef || current?.revision !== target.revision) throw Error("account_share_conflict")
    if (current?.currentOwned) await account.logout(); else await account.disconnect()
    if (account.view.error || account.view.session?.authenticated) throw Error(account.view.error ?? "account_disconnect_failed")
    await controller.refreshHostedModels()
    backend.refreshAll()
    return
  }
  const service = backend.providerSetup
  if (!service?.disconnect) throw Error("provider_disconnect_unavailable")
  const before = controller.client.getSelectedDestination(), selection = controller.modelSelectionRevision
  await service.disconnect(target.providerId, target.connectionId, controller.client.url, target.revision)
  // A legacy provider alias is not bound to one credential: removing a profile
  // can change its active account. Clear it instead of silently retargeting.
  const selectedTarget = before.providerId === target.providerId && ((before.connectionId ?? before.providerId) === target.connectionId || !before.connectionId || before.connectionId === before.providerId)
  const unchanged = () => controller.modelSelectionRevision === selection && controller.client.getSelectedDestination() === before
  if (selectedTarget && unchanged()) { controller.cancel(); controller.setModel("") }
  await controller.refreshConnections()
  backend.refreshAll()
}
