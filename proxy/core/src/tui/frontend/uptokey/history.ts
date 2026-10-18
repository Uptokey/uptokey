import type { Message, Part } from "@opencode-ai/sdk/v2"

export type HistoryMessage = { info: Message; parts: Part[] }
export type HistoryPage = { data: HistoryMessage[]; error?: unknown; meta?: { before?: string; more: boolean } }
export type HistoryClient = { session: {
  messages(params: { sessionID: string; limit?: number; before?: string }): Promise<HistoryPage>
  history?: (params: { sessionID: string }) => Promise<HistoryPage>
} }

/** Stable parent identities make appends harmless to a backwards page cursor. */
export function historyPage<T extends { info: { id: string } }>(messages: readonly T[], before?: string, requested = 100) {
  const limit = Math.max(1, Math.min(500, Number.isFinite(requested) ? Math.floor(requested) : 100))
  const end = before === undefined ? messages.length : messages.findIndex(message => message.info.id === before)
  if (end < 0) throw Error("conversation_history_cursor_changed")
  const start = Math.max(0, end - limit)
  const data = messages.slice(start, end)
  return { data, error: undefined, meta: { before: data[0]?.info.id, more: start > 0 } }
}

export async function completeHistory(client: HistoryClient, sessionID: string): Promise<HistoryMessage[]> {
  if (client.session.history) {
    const result = await client.session.history({ sessionID })
    if (result.error || !Array.isArray(result.data)) throw Error("conversation_history_unavailable")
    return result.data
  }
  const messages = new Map<string, HistoryMessage>()
  let before: string | undefined
  for (;;) {
    const page = await client.session.messages({ sessionID, limit: 100, ...(before ? { before } : {}) })
    if (page.error || !Array.isArray(page.data)) throw Error("conversation_history_unavailable")
    for (const message of page.data) if (!messages.has(message.info.id)) messages.set(message.info.id, message)
    if (!page.meta?.more) break
    if (!page.meta.before || page.meta.before === before) throw Error("conversation_history_cursor_changed")
    before = page.meta.before
  }
  return [...messages.values()].sort((a, b) => a.info.time.created - b.info.time.created || a.info.id.localeCompare(b.info.id))
}

/** Adapted from OpenCode's MIT session-retention and mount-budget mechanisms.
 * Reference: anomalyco/opencode, 8c173a8f3805d8e749d44311054b07e37a1b2ce1.
 * Metadata and drafts stay owned by their existing stores; only rehydratable history is evicted.
 */
export function historyEvictions(recent: readonly string[], current: string | undefined, protectedIDs: ReadonlySet<string>, limit = 3) {
  let retained = 0
  return recent.filter(id => {
    if (id === current || protectedIDs.has(id)) return false
    return retained++ >= limit
  })
}

export function historyRowsBefore(weights: readonly number[], end: number, budget: number) {
  let start = end
  for (let count = 0; start > 0 && count < budget;) count += weights[--start] ?? 1
  return start
}

type HistoryMount = { ensure: () => Promise<void> }
const mounts = new WeakMap<object, HistoryMount>()
export function registerHistoryMount(renderer: object, mount: HistoryMount) {
  mounts.set(renderer, mount)
  return () => { if (mounts.get(renderer) === mount) mounts.delete(renderer) }
}
export async function ensureSelectionHistory(renderer: object) { await mounts.get(renderer)?.ensure() }
