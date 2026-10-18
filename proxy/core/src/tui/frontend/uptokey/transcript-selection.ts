import { createSelection, extendSelection, extractSelection, locateSelection, moveSelection, selectionRanges, selectionSource, type SelectionState } from "../../selection.ts"
import { graphemes, graphemeWidth } from "../../unicode.ts"
import type { Line, TranscriptItem } from "../../transcript.ts"
import type { SourceSelection } from "../vendor/opencode-tui/util/selection.ts"

type NativeText = {
  id: string
  x: number
  y: number
  width: number
  height: number
  visible?: boolean
  isDestroyed?: boolean
  parent?: NativeText | null
  plainText?: string
  lineInfo?: { lineStartCols: number[]; lineWidthCols: number[]; lineSources: number[] }
  getChildren(): NativeText[]
  getSelection?(): { start: number; end: number } | null
  getSelectedText?(): string
  requestRender?(): void
  findDescendantById?(id: string): NativeText | undefined
  textBuffer?: { readonly length: number; getTextRange(start: number, end: number): string }
  textBufferView?: {
    logicalLineInfo?: { lineStartCols: number[]; lineWidthCols: number[] }
    setSelection(start: number, end: number): void
    resetSelection(): void
  }
}
type NativeRenderer = {
  root: NativeText
  getSelection(): { selectedRenderables: NativeText[]; isDragging?: boolean } | null
  clearSelection(): void
}
type NativeScroll = NativeText & {
  viewport: NativeText
  scrollTop: number
  scrollBy(delta: number): void
}
type Key = { name: string; ctrl?: boolean; shift?: boolean; preventDefault(): void; stopPropagation(): void }
type SourceGetter = () => TranscriptItem
type SelectableSource = Extract<TranscriptItem, { kind: "assistant" | "user" }>
const transcriptSources = new WeakMap<object, SourceGetter>()
type CollectionCache = {
  sources: WeakMap<object, { raw: string; id: string; kind: string; item: SelectableSource }>
  native: WeakMap<object, { source: string; cursor: number; plain: string; offsets: number[] | null; buffer: NativeText["textBuffer"]; view: NativeText["textBufferView"] }>
}
const collectionCache = (): CollectionCache => ({ sources: new WeakMap(), native: new WeakMap() })
const firstGrapheme = new Intl.Segmenter(undefined, { granularity: "grapheme" })

/** Source registration belongs to the actual message renderable, never a global matching string. */
export function registerTranscriptSource(target: object, source: SourceGetter): void {
  transcriptSources.set(target, source)
}

type Leaf = { native: NativeText; item: TranscriptItem; plain: string; offsets: number[] }
function children(node: NativeText): NativeText[] { return node.getChildren?.() ?? [] }

/** Map native buffer text within its own source block. Ordered offsets distinguish repeated text. */
export function sourceOffsets(source: string, plain: string, from = 0): number[] | null {
  const exact = source.indexOf(plain, from)
  if (exact >= 0) return Array.from({ length: plain.length + 1 }, (_, index) => exact + index)
  const offsets: number[] = []
  let cursor = from
  for (let index = 0; index < plain.length; index++) {
    const found = source.indexOf(plain[index]!, cursor)
    if (found < 0) return null
    offsets.push(found)
    cursor = found + 1
  }
  offsets.push(cursor)
  return offsets
}

function collect(root: NativeText, cache: CollectionCache): { items: TranscriptItem[]; leaves: Leaf[] } {
  const items: TranscriptItem[] = [], leaves: Leaf[] = []
  const visit = (node: NativeText) => {
    if (node.isDestroyed || node.visible === false) return
    const getter = transcriptSources.get(node)
    if (!getter) { for (const child of children(node)) visit(child); return }
    const registered = getter()
    if (registered.kind !== "assistant" && registered.kind !== "user") return
    // Source strings are immutable. A stationary selection must not sanitize and concatenate
    // megabytes again on every renderer frame; a changed source/id still invalidates the cache.
    const priorSource = cache.sources.get(node)
    const cachedSource = priorSource?.raw === registered.text && priorSource.id === registered.id && priorSource.kind === registered.kind
    const item = cachedSource ? priorSource.item : { ...registered, text: selectionSource(registered)! }
    if (!cachedSource) cache.sources.set(node, { raw: registered.text, id: registered.id, kind: registered.kind, item })
    items.push(item)
    let cursor = 0
    const leaf = (candidate: NativeText) => {
      if (candidate.isDestroyed) return
      if (candidate.textBufferView) {
        const previous = cache.native.get(candidate)
        const cached = previous?.source === item.text && previous.cursor === cursor && previous.buffer === candidate.textBuffer && previous.view === candidate.textBufferView ? previous : undefined
        const plain = cached?.plain ?? candidate.plainText
        if (!plain) return
        const offsets = cached ? cached.offsets : sourceOffsets(item.text, plain, cursor)
        if (!cached) cache.native.set(candidate, { source: item.text, cursor, plain, offsets, buffer: candidate.textBuffer, view: candidate.textBufferView })
        if (!offsets) return
        leaves.push({ native: candidate, item, plain, offsets })
        cursor = offsets.at(-1)!
        return
      }
      for (const child of children(candidate)) leaf(child)
    }
    leaf(node)
  }
  visit(root)
  return { items, leaves }
}

function codePointOffset(text: string, count: number): number {
  let offset = 0
  for (const point of text) { if (count-- <= 0) break; offset += point.length }
  return offset
}
function plainOffset(leaf: Leaf, native: number): number {
  return leaf.native.textBuffer ? leaf.native.textBuffer.getTextRange(0, native).length : codePointOffset(leaf.plain, native)
}
/** Native buffer offsets depend on its width method; query its own range API rather than counting code points. */
function nativeOffset(leaf: Leaf, utf16: number): number {
  const buffer = leaf.native.textBuffer
  if (!buffer) return [...leaf.plain.slice(0, utf16)].length
  const logical = leaf.native.textBufferView?.logicalLineInfo
  const last = (logical?.lineStartCols.length ?? 0) - 1
  // Buffer length excludes line separators; native range offsets include them.
  let low = 0, high = last >= 0 ? logical!.lineStartCols[last]! + logical!.lineWidthCols[last]!
    : buffer.length + leaf.plain.split("\n").length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (buffer.getTextRange(0, middle).length <= utf16) low = middle
    else high = middle - 1
  }
  return low
}

/** Rows are derived from OpenTUI's native wrapping, while copy bounds stay in source offsets. */
function nativeRows(leaves: Leaf[]): { line: Line; leaf: Leaf; row: number }[] {
  const result: { line: Line; leaf: Leaf; row: number }[] = []
  for (const leaf of leaves) {
    const info = leaf.native.lineInfo
    const lines = leaf.plain.split("\n")
    const starts: number[] = []
    const startColumns: number[] = []
    let offset = 0, logicalColumn = 0
    for (const line of lines) {
      starts.push(offset); startColumns.push(logicalColumn); offset += line.length + 1
      let width = 0
      for (const character of graphemes(line)) width += character === "\t" ? 4 - width % 4 : graphemeWidth(character)
      logicalColumn += width + 1
    }
    for (let row = 0; row < (info?.lineSources.length ?? lines.length); row++) {
      const logical = info?.lineSources[row] ?? row
      const startColumn = (info?.lineStartCols[row] ?? startColumns[logical] ?? 0) - (startColumns[logical] ?? 0)
      const endColumn = startColumn + (info?.lineWidthCols[row] ?? Number.MAX_SAFE_INTEGER)
      let column = 0, index = starts[logical] ?? 0
      const spans: Line["spans"] = []
      for (const character of graphemes(lines[logical] ?? "")) {
        const width = character === "\t" ? 4 - column % 4 : graphemeWidth(character)
        if (column + Math.max(1, width) > startColumn && column < endColumn) {
          spans.push({ text: character, sourceStart: leaf.offsets[index], sourceEnd: leaf.offsets[index + character.length], sourceAtomic: true })
        }
        column += width; index += character.length
      }
      if (spans.length) result.push({ line: { itemId: leaf.item.id, spans }, leaf, row })
    }
  }
  return result
}

export function createTranscriptSelection(options: {
  renderer: NativeRenderer
  /** Modal input owns every key while a dialog is open. */
  modal: () => boolean
  context: () => string
  restoreFocus: () => void
  notice: (message: "selection_hint" | "selection_empty") => void
}): SourceSelection & {
  begin(): boolean
  key(event: Key): boolean
  captureMouse(): void
  refresh(): void
  active(): boolean
} {
  let state: SelectionState | null = null, revision = 0, context = "", stale = false
  let painted: NativeText[] = [], paintKey: unknown[] = []
  let cache = collectionCache()
  const scroll = () => options.renderer.root.findDescendantById?.("uptokey-transcript") as NativeScroll | undefined
  const clear = () => {
    for (const node of painted) if (!node.isDestroyed) { node.textBufferView?.resetSelection(); node.requestRender?.() }
    painted = []; paintKey = []; state = null; stale = false; revision++
    // Offset arrays can be much larger than the selected text. Esc/copy releases them even
    // while the underlying transcript renderables remain mounted for the conversation.
    cache = collectionCache()
    options.renderer.clearSelection()
    options.restoreFocus()
  }
  const current = () => collect(options.renderer.root, cache)
  const validContext = () => {
    if (state && context !== options.context()) { clear(); return false }
    return Boolean(state)
  }
  const refresh = () => {
    if (!validContext() || options.modal() || options.renderer.getSelection()?.isDragging) return
    const { items, leaves } = current()
    const nextPaintKey: unknown[] = [state!.anchor.itemId, state!.anchor.offset, state!.focus.itemId, state!.focus.offset, state!.keyboard, leaves.length]
    for (const leaf of leaves) nextPaintKey.push(leaf.native, leaf.native.textBufferView, leaf.item.id, "text" in leaf.item ? leaf.item.text : undefined, leaf.native.x, leaf.native.y, leaf.native.width, leaf.native.height, leaf.plain, leaf.offsets)
    if (paintKey.length === nextPaintKey.length && paintKey.every((value, index) => Object.is(value, nextPaintKey[index]))) return
    paintKey = nextPaintKey
    const ranges = selectionRanges(state!, items)
    stale = !ranges
    if (!ranges) return
    for (const node of painted) if (!node.isDestroyed) node.textBufferView?.resetSelection()
    painted = []
    const collapsed = state!.keyboard && state!.anchor.itemId === state!.focus.itemId && state!.anchor.offset === state!.focus.offset
    for (const leaf of leaves) {
      const range = ranges.get(leaf.item.id)
      if (!range) continue
      if (collapsed && leaf.item.id === state!.focus.itemId && leaf.offsets[0]! <= range.from && leaf.offsets.at(-1)! >= range.from) {
        const index = leaf.offsets.findIndex(offset => offset >= range.from)
        const from = Math.min(leaf.plain.length - 1, Math.max(0, index))
        const next = firstGrapheme.segment(leaf.plain.slice(from))[Symbol.iterator]().next().value?.segment.length ?? 1
        leaf.native.textBufferView!.setSelection(nativeOffset(leaf, from), nativeOffset(leaf, from + next))
        leaf.native.requestRender?.(); painted.push(leaf.native)
        continue
      }
      if (leaf.offsets.at(-1)! <= range.from || leaf.offsets[0]! >= range.to) continue
      const first = leaf.offsets.findIndex(offset => offset >= range.from)
      const last = leaf.offsets.findIndex(offset => offset >= range.to)
      const from = Math.max(0, first), to = last < 0 ? leaf.plain.length : last
      if (to <= from) continue
      leaf.native.textBufferView!.setSelection(nativeOffset(leaf, from), nativeOffset(leaf, to))
      leaf.native.requestRender?.(); painted.push(leaf.native)
    }
  }
  const captureMouse = () => {
    const native = options.renderer.getSelection()
    if (!native || options.modal()) return
    const { items, leaves } = current()
    const selected = leaves.filter(leaf => native.selectedRenderables.includes(leaf.native))
    const first = selected[0], last = selected.at(-1)
    if (!first || !last) return
    const a = first.native.getSelection?.(), b = last.native.getSelection?.()
    if (!a || !b) return
    const anchor = { itemId: first.item.id, offset: first.offsets[plainOffset(first, Math.min(a.start, a.end))]! }
    const focus = { itemId: last.item.id, offset: last.offsets[plainOffset(last, Math.max(b.start, b.end))]! }
    state = extendSelection(createSelection(items, anchor), items, focus)
    state.dragging = false; context = options.context(); stale = false; revision++
  }
  const begin = () => {
    if (options.modal()) return false
    const { items } = current()
    const item = [...items].reverse().find(item => item.kind === "assistant" || item.kind === "user")
    if (!item) { options.notice("selection_empty"); return false }
    clear()
    state = createSelection(items, { itemId: item.id, offset: 0 }, true)
    context = options.context(); revision++
    const leaf = current().leaves.find(leaf => leaf.item.id === item.id)
    if (leaf && scroll()) scroll()!.scrollBy(leaf.native.y - scroll()!.viewport.y)
    options.notice("selection_hint"); refresh()
    return true
  }
  return {
    begin, clear, refresh, captureMouse,
    active: () => validContext(),
    version: () => revision,
    text: () => {
      if (options.modal()) return undefined
      if (!validContext()) { captureMouse(); if (!state) return undefined }
      return stale ? null : extractSelection(current().items, state!)
    },
    key: (event) => {
      if (!validContext() || options.modal()) return false
      if (event.name === "escape") { clear(); event.preventDefault(); event.stopPropagation(); return true }
      if (event.ctrl && event.name === "c") return false
      if (!["left", "right", "up", "down", "home", "end", "pageup", "pagedown"].includes(event.name)) {
        event.preventDefault(); event.stopPropagation(); return true
      }
      const { items, leaves } = current(), rows = nativeRows(leaves), lines = rows.map(row => row.line)
      const direction = event.ctrl && event.name === "home" ? "start" : event.ctrl && event.name === "end" ? "finish" : event.name
      const index = items.findIndex(item => item.id === state!.focus.itemId)
      const item = items[index]
      const adjacent = direction === "left" && state!.focus.offset === 0 ? items[index - 1]
        : direction === "right" && item && "text" in item && state!.focus.offset === item.text.length ? items[index + 1] : undefined
      const boundary = direction === "start" ? items[0] : direction === "finish" ? items.at(-1) : undefined
      if (boundary && (boundary.kind === "assistant" || boundary.kind === "user")) {
        const target = { itemId: boundary.id, offset: direction === "start" ? 0 : boundary.text.length }
        state = extendSelection({ ...state!, anchor: event.shift ? state!.anchor : target, keyboard: true, dragging: false }, items, target)
      } else if (adjacent && (adjacent.kind === "assistant" || adjacent.kind === "user")) {
        const target = { itemId: adjacent.id, offset: direction === "left" ? adjacent.text.length : 0 }
        state = extendSelection({ ...state!, anchor: event.shift ? state!.anchor : target, keyboard: true, dragging: false }, items, target)
      } else state = moveSelection(state!, items, lines, direction, Boolean(event.shift), Math.max(1, (scroll()?.viewport.height ?? 12) - 1))
      revision++; stale = false
      const position = locateSelection(lines, state!.focus)
      const row = position ? rows[position.row] : undefined
      const viewport = scroll()
      if (viewport && row) {
        const y = row.leaf.native.y + row.row
        if (y < viewport.viewport.y) viewport.scrollBy(y - viewport.viewport.y)
        else if (y >= viewport.viewport.y + viewport.viewport.height) viewport.scrollBy(y - viewport.viewport.y - viewport.viewport.height + 1)
      }
      refresh(); event.preventDefault(); event.stopPropagation(); return true
    },
  }
}
