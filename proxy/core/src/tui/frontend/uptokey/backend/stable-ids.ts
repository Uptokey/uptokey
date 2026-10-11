/**
 * Keeps the display ids of transcript items stable when the controller replaces an optimistic item (pending user
 * message, streaming answer, interrupted partial, completed answer) by the canonical message reloaded from the core.
 *
 * Without it the frontend sees a removed message and a new one: the markdown view of the new text part is mounted
 * from scratch and draws an empty frame first (a visible flicker after every answer and after a failure). Matching is
 * deterministic: same kind, same ordinal among items of that kind, a transient id that just disappeared and compatible
 * text. Anything else keeps its own id.
 */
import type { TranscriptItem } from "../../../transcript.ts"

const TRANSIENT = /^(?:pending-|partial-|answer-|streaming$)/

interface Seen {
  root: string
  display: string
  kind: TranscriptItem["kind"]
  ordinal: number
  text: string
}

function rootOf(id: string) {
  const index = id.indexOf(":")
  return index < 0 ? id : id.slice(0, index)
}

function textOf(item: TranscriptItem) {
  return "text" in item && typeof item.text === "string" ? item.text : ""
}

function compatible(before: string, after: string) {
  if (before === after) return true
  const a = before.slice(0, 200)
  const b = after.slice(0, 200)
  return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a))
}

export class StableIds {
  private alias = new Map<string, string>()
  private previous: Seen[] = []
  private streamingDisplay: string | undefined
  private turn = 0

  reset() {
    this.alias.clear()
    this.previous = []
    this.streamingDisplay = undefined
  }

  private display(root: string): string {
    const known = this.alias.get(root)
    if (known) return known
    // The controller reuses "streaming" for every turn; each turn gets its own display id.
    if (root === "streaming") {
      this.streamingDisplay ??= `streaming-${++this.turn}`
      return this.streamingDisplay
    }
    return root
  }

  apply(items: readonly TranscriptItem[]): TranscriptItem[] {
    const roots = items.map((item) => rootOf(item.id))
    const present = new Set(roots)
    const previousRoots = new Set(this.previous.map((entry) => entry.root))
    const replacementByPosition = new Map<string, Seen>()
    for (const entry of this.previous) {
      if (!TRANSIENT.test(entry.root) || present.has(entry.root)) continue
      replacementByPosition.set(`${entry.kind}:${entry.ordinal}`, entry)
    }
    const ordinals = new Map<TranscriptItem["kind"], number>()
    const seen: Seen[] = []
    const out = items.map((item, index) => {
      const root = roots[index]!
      const ordinal = ordinals.get(item.kind) ?? 0
      ordinals.set(item.kind, ordinal + 1)
      if (!this.alias.has(root) && root !== "streaming" && !previousRoots.has(root)) {
        const candidate = replacementByPosition.get(`${item.kind}:${ordinal}`)
        const match = candidate && compatible(candidate.text, textOf(item)) ? candidate : undefined
        if (match) this.alias.set(root, match.display)
      }
      const display = this.display(root)
      seen.push({ root, display, kind: item.kind, ordinal, text: textOf(item) })
      return display === root ? item : ({ ...item, id: `${display}${item.id.slice(root.length)}` } as TranscriptItem)
    })
    if (!present.has("streaming")) this.streamingDisplay = undefined
    this.previous = seen
    return out
  }
}
