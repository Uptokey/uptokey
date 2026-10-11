import type { ClipboardService } from "../context/clipboard-types.ts"
import { clipboardErrorMessage } from "../clipboard.ts"
import { selectionUi } from "../../../uptokey/integration-selection.ts"

type Toast = {
  show: (input: { message: string; variant: "info" | "success" | "warning" | "error" }) => void
  error: (err: unknown) => void
}

type FocusableSelectionTarget = {
  hasSelection: () => boolean
  getClipboardText?: (text: string) => string
}

type Renderer = {
  getSelection: () => { getSelectedText: () => string; selectedRenderables: FocusableSelectionTarget[] } | null
  clearSelection: () => void
  currentFocusedRenderable?: FocusableSelectionTarget | null
}

type SelectionKeyEvent = {
  ctrl?: boolean
  name: string
  preventDefault: () => void
  stopPropagation: () => void
}

export type SourceSelection = {
  /** Undefined delegates to a non-transcript selection; null rejects changed source. */
  text: () => string | null | undefined
  clear: () => void
  version: () => number
}
const sources = new WeakMap<object, SourceSelection>()
const copying = new WeakSet<object>()
export function registerSourceSelection(renderer: Renderer, source: SourceSelection): () => void {
  sources.set(renderer, source)
  return () => { if (sources.get(renderer) === source) sources.delete(renderer) }
}

export function copy(renderer: Renderer, toast: Toast, clipboard: ClipboardService): boolean {
  const selection = renderer.getSelection()
  const source = sources.get(renderer)
  const sourceText = source?.text()
  if (sourceText === null) {
    toast.show({ message: selectionUi("selection_stale"), variant: "warning" })
    return true
  }
  if (!selection && sourceText === undefined) return false

  const text = sourceText ?? selection?.getSelectedText()
  if (!text) return false
  if (copying.has(renderer)) return true

  const focus = renderer.currentFocusedRenderable
  const clipboardText =
    sourceText === undefined && focus?.getClipboardText && selection?.selectedRenderables.includes(focus) ? focus.getClipboardText(text) : text

  copying.add(renderer)
  const version = source?.version()
  Promise.resolve()
    .then(() => {
      if (!clipboard?.write) throw new Error("clipboard_unavailable")
      return clipboard.write(clipboardText)
    })
    .then(() => {
      toast.show({ message: selectionUi("copied"), variant: "info" })
      if (sourceText !== undefined && source && source.version() === version) source.clear()
      else if (sourceText === undefined && renderer.getSelection() === selection) renderer.clearSelection()
    })
    .catch((error) => toast.show({ message: clipboardErrorMessage(error), variant: "error" }))
    .finally(() => copying.delete(renderer))
  return true
}

export function handleSelectionKey(
  renderer: Renderer,
  toast: Toast,
  event: SelectionKeyEvent,
  clipboard: ClipboardService,
) {
  const selection = renderer.getSelection()
  const source = sources.get(renderer)
  if (!selection && source?.text() === undefined) return

  if (event.ctrl && event.name === "c") {
    if (!copy(renderer, toast, clipboard)) {
      // An empty keyboard caret remains available for Shift+arrows.
      event.preventDefault()
      event.stopPropagation()
      return
    }

    event.preventDefault()
    event.stopPropagation()
    return
  }

  if (event.name === "escape") {
    source?.clear()
    renderer.clearSelection()
    event.preventDefault()
    event.stopPropagation()
    return
  }

  const focus = renderer.currentFocusedRenderable
  if (focus?.hasSelection() && selection?.selectedRenderables.includes(focus)) return

  if (["up", "down", "left", "right", "pageup", "pagedown", "home", "end"].includes(event.name)) return

  source?.clear()
  renderer.clearSelection()
}

export * as Selection from "./selection.ts"
