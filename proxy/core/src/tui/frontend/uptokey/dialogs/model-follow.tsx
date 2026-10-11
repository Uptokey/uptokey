/** @jsxImportSource @opentui/solid */
/**
 * The core changed the model by itself (/modelo <id>, --model, a provider just connected, a restored choice): the
 * prompt follows it, so the next message goes to the model the person chose instead of the one the window had
 * selected before. Mounted once in the app's bottom slot without drawing anything: it never opens, replaces or closes
 * a dialog (an approval can be open). A model of a provider connected a moment ago may not be in the window's
 * provider list yet; the choice waits until it appears instead of being dropped.
 */
import { createEffect, createSignal } from "solid-js"
import { useLocal } from "../../vendor/opencode-tui/context/local"
import { useSync } from "../../vendor/opencode-tui/context/sync"

const [target, setTarget] = createSignal<{ providerID: string; modelID: string } | undefined>(undefined)

export function followModel(providerID: string, modelID: string) {
  setTarget({ providerID, modelID })
}

const [agentTarget, setAgentTarget] = createSignal<string | undefined>(undefined)

/** The core switched autonomy or mode (/autonomy, /plan): the prompt's agent (cycled with Tab) shows it. */
export function followAgent(name: string) {
  setAgentTarget(name)
}

export function ModelFollower() {
  const local = useLocal()
  const sync = useSync()
  createEffect(() => {
    const next = target()
    if (!next) return
    const provider = sync.data.provider.find((item) => item.id === next.providerID)
    if (!provider?.models[next.modelID]) return
    const current = local.model.current()
    if (current?.providerID !== next.providerID || current?.modelID !== next.modelID) local.model.set(next, { recent: true })
    setTarget(undefined)
  })
  createEffect(() => {
    const name = agentTarget()
    if (!name || !sync.data.agent.some((agent) => agent.name === name)) return
    if (local.agent.current()?.name !== name) local.agent.set(name)
    setAgentTarget(undefined)
  })
  return null
}
