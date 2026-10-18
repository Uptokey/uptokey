/**
 * Pending redirections (text typed while a turn runs) survive the loss of the process. The file under the TUI state
 * directory mirrors the queue of the active conversation only; a delivered, cancelled or deliberately dropped
 * redirection (switching conversations drops the queue) leaves the file. After a crash the texts return to the
 * composer of their conversation, never sent by themselves. Temporary conversations never reach the disk.
 */
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"

export const PENDING_STEER_FILE = "pending-steer.json"
const MAX_ITEMS = 20
const MAX_TEXT = 20_000

type Saved = { conversationId: string; texts: string[]; savedAt: string }

export class PendingSteerStore {
  private readonly file: string
  /** Conversations whose queue came from a previous process and has not been handed back yet. */
  private readonly recovered = new Map<string, string[]>()
  /** What this process wrote last: conversation id and the exact queue. */
  private written: { conversationId: string; signature: string } | null = null

  constructor(stateDirectory: string) {
    this.file = join(stateDirectory, PENDING_STEER_FILE)
    for (const entry of this.read()) if (entry.texts.length) this.recovered.set(entry.conversationId, entry.texts)
  }

  /** Mirrors the queue of the active conversation after each change. Returns texts recovered for it, at most once. */
  update(activeId: string | undefined, texts: readonly string[], temporary: boolean): string[] | null {
    const queue = texts.map((text) => text.slice(0, MAX_TEXT)).filter(Boolean).slice(0, MAX_ITEMS)
    // Only entries this process wrote or recovered can change; the file is read just before a write, so another
    // window sharing the state directory keeps its own conversation's entry.
    const remove = new Set<string>()
    let put: Saved | null = null
    // The queue this process wrote belongs to a conversation that is no longer active, or became empty: the switch
    // dropped it on purpose, or it was delivered/cancelled.
    if (this.written && (this.written.conversationId !== activeId || !queue.length || temporary)) {
      remove.add(this.written.conversationId)
      this.written = null
    }
    let restored: string[] | null = null
    if (activeId && this.recovered.has(activeId)) {
      restored = this.recovered.get(activeId) ?? null
      this.recovered.delete(activeId)
      remove.add(activeId)
    }
    if (activeId && !temporary && queue.length) {
      const signature = JSON.stringify(queue)
      if (this.written?.conversationId !== activeId || this.written.signature !== signature) {
        put = { conversationId: activeId, texts: queue, savedAt: new Date().toISOString() }
        this.written = { conversationId: activeId, signature }
      }
    }
    if (remove.size || put) {
      const entries = new Map(this.read().map((entry) => [entry.conversationId, entry] as const))
      for (const id of remove) entries.delete(id)
      if (put) entries.set(put.conversationId, put)
      this.write([...entries.values()])
    }
    return restored
  }

  private read(): Saved[] {
    try {
      const value = JSON.parse(readFileSync(this.file, "utf8")) as unknown
      if (!Array.isArray(value)) return []
      return value.filter((entry): entry is Saved => typeof entry?.conversationId === "string" && Array.isArray(entry.texts) && entry.texts.every((text: unknown) => typeof text === "string"))
    } catch {
      return []
    }
  }

  private write(entries: Saved[]) {
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      const temporary = `${this.file}.${process.pid}.tmp`
      writeFileSync(temporary, JSON.stringify(entries) + "\n", { mode: 0o600 })
      renameSync(temporary, this.file)
    } catch {
      /* best effort: the in-memory queue is still delivered normally */
    }
  }
}
