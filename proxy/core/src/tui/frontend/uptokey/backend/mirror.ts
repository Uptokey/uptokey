/**
 * Turns successive projections of one session into the minimal OpenCode events the vendored sync store
 * understands. Replays are idempotent: the store reconciles by id, so a repeated event cannot duplicate a part.
 */
import type { Event, Part } from "@opencode-ai/sdk/v2"
import type { ProjectedMessage } from "./projection.ts"

type Payload = Event

interface Seen {
  info: string
  parts: Map<string, { json: string; text?: string }>
}

export interface MirrorResult {
  events: Payload[]
  /** The projection reorders or inserts before existing messages: the caller must renumber and replay from empty. */
  resync: boolean
}

export class SessionMirror {
  private seen = new Map<string, Seen>()
  private order: string[] = []
  private counter = 0

  private id() {
    return `uptokey-${++this.counter}`
  }

  clear(): Payload[] {
    const removed = this.order.map(
      (messageID) => ({ id: this.id(), type: "message.removed", properties: { sessionID: this.sessionID, messageID } }) as Payload,
    )
    this.seen.clear()
    this.order = []
    return removed
  }

  private sessionID: string

  constructor(sessionID: string) {
    this.sessionID = sessionID
  }

  setSession(sessionID: string) {
    this.sessionID = sessionID
    this.seen.clear()
    this.order = []
  }

  get id_(): string {
    return this.sessionID
  }

  diff(next: ProjectedMessage[]): MirrorResult {
    const nextIds = next.map((message) => message.info.id)
    const nextIdSet = new Set(nextIds)
    const existingInNext = nextIds.filter((id) => this.seen.has(id))
    const previousInNext = this.order.filter((id) => nextIdSet.has(id))
    const sameOrder = existingInNext.length === previousInNext.length && existingInNext.every((id, index) => id === previousInNext[index])
    const lastExisting = existingInNext.length ? nextIds.lastIndexOf(existingInNext.at(-1)!) : -1
    const insertedBeforeExisting = nextIds.some((id, index) => !this.seen.has(id) && index < lastExisting)
    if (!sameOrder || insertedBeforeExisting) return { events: [], resync: true }

    const events: Payload[] = []
    for (const messageID of this.order) {
      if (nextIdSet.has(messageID)) continue
      events.push({ id: this.id(), type: "message.removed", properties: { sessionID: this.sessionID, messageID } } as Payload)
      this.seen.delete(messageID)
    }

    for (const message of next) {
      const info = JSON.stringify(message.info)
      const known = this.seen.get(message.info.id)
      if (!known || known.info !== info) {
        events.push({ id: this.id(), type: "message.updated", properties: { sessionID: this.sessionID, info: message.info } } as Payload)
      }
      const parts = known?.parts ?? new Map<string, { json: string; text?: string }>()
      const nextPartIds = new Set(message.parts.map((part) => part.id))
      for (const partID of [...parts.keys()]) {
        if (nextPartIds.has(partID)) continue
        events.push({ id: this.id(), type: "message.part.removed", properties: { sessionID: this.sessionID, messageID: message.info.id, partID } } as Payload)
        parts.delete(partID)
      }
      for (const part of message.parts) {
        const json = JSON.stringify(part)
        const previous = parts.get(part.id)
        if (previous?.json === json) continue
        const text = part.type === "text" || part.type === "reasoning" ? part.text : undefined
        const growth =
          previous && previous.text !== undefined && text !== undefined && text.length > previous.text.length && text.startsWith(previous.text)
            ? text.slice(previous.text.length)
            : undefined
        const onlyTextChanged = growth !== undefined && JSON.stringify({ ...part, text: previous!.text }) === previous!.json
        if (onlyTextChanged) {
          events.push({
            id: this.id(),
            type: "message.part.delta",
            properties: { sessionID: this.sessionID, messageID: message.info.id, partID: part.id, field: "text", delta: growth },
          } as Payload)
        } else {
          events.push({ id: this.id(), type: "message.part.updated", properties: { sessionID: this.sessionID, part: part as Part } } as Payload)
        }
        parts.set(part.id, { json, ...(text !== undefined ? { text } : {}) })
      }
      this.seen.set(message.info.id, { info, parts })
    }
    this.order = nextIds
    return { events, resync: false }
  }
}
