/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useKeyboard, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { type InputRenderable, type TextareaRenderable, type TextRenderable } from "@opentui/core"
import { onCleanup, onMount } from "solid-js"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TuiPathsProvider } from "../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../vendor/opencode-tui/config"
import { KVProvider } from "../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../vendor/opencode-tui/context/theme"
import { ClipboardProvider } from "../vendor/opencode-tui/context/clipboard"
import { ToastProvider, useToast } from "../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../vendor/opencode-tui/ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../vendor/opencode-tui/ui/dialog-select"
import { handleSelectionKey } from "../vendor/opencode-tui/util/selection"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings, useOpencodeKeymap } from "../vendor/opencode-tui/keymap"

async function mount() {
  const root = await mkdtemp(join(tmpdir(), "uptokey-dialog-dismissal-"))
  await writeFile(join(root, "kv.json"), "{}")
  let dialog!: DialogContext, composer!: TextareaRenderable, source!: TextRenderable
  let picker: DialogSelectRef<string> | undefined
  let leakedDismissals = 0
  const calls = { selected: 0, closed: 0, submitted: 0, exited: 0 }
  const copied: string[] = []
  const clipboard = { read: async () => undefined, write: async (text: string) => { copied.push(text) } }
  function open(title = "Choose a model") {
    picker = undefined
    dialog.replace(() => <DialogSelect title={title} ref={value => { picker = value }} options={[
      { title: "Alpha model", value: "alpha" }, { title: "Beta model", value: "beta" },
    ]} onSelect={() => { calls.selected++ }} />, () => { calls.closed++ })
  }
  function Consumer() {
    dialog = useDialog()
    const keymap = useOpencodeKeymap(), renderer = useRenderer(), toast = useToast()
    const offSelection = keymap.intercept("key", ({ event }) => handleSelectionKey(renderer, toast, event, clipboard), { priority: 1 })
    onCleanup(offSelection)
    useBindings(() => ({ mode: "base", bindings: [
      { key: "f2", cmd: () => open() },
      { key: "escape", cmd: () => { calls.exited++ } },
      { key: "ctrl+c", cmd: () => { calls.exited++ } },
    ] }))
    useKeyboard(key => { if (key.name === "escape" || (key.ctrl && key.name === "c")) leakedDismissals++ })
    onMount(() => composer.focus())
    return <box>
      <text ref={value => { source = value }}>Background selectable source</text>
      <textarea id="composer" ref={value => { composer = value }} initialValue="unsent draft" onSubmit={() => { calls.submitted++ }} height={3} />
    </box>
  }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ClipboardProvider value={clipboard}><ToastProvider><DialogProvider><Consumer /></DialogProvider></ToastProvider></ClipboardProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider></TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 32, kittyKeyboard: true })
  const settle = async () => { await app.flush(); await Bun.sleep(5); await app.flush(); await app.renderOnce() }
  await settle()
  const readyUntil = Date.now() + 2000
  while (!dialog || !composer || !source) {
    if (Date.now() >= readyUntil) throw new Error("dialog dismissal fixture did not mount its composer and selectable source")
    await settle()
  }
  return {
    app, dialog, composer, calls, copied, open, settle, picker: () => picker, leakedDismissals: () => leakedDismissals,
    selectSource() {
      app.renderer.startSelection(source, source.x, source.y)
      app.renderer.updateSelection(source, source.x + 10, source.y, { finishDragging: true })
      expect(app.renderer.getSelection()?.getSelectedText()).toBe("Background")
    },
  }
}

test("rapid open and Escape dismisses without submitting, exiting or stealing restored composer focus", async () => {
  const h = await mount()
  try {
    for (let index = 0; index < 10; index++) {
      h.app.mockInput.pressKey("F2")
      h.app.mockInput.pressEscape()
      await h.settle()
      expect(h.dialog.stack).toHaveLength(0)
      expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    }
    expect(h.composer.plainText).toBe("unsent draft")
    expect(h.leakedDismissals()).toBe(0)
    expect(h.calls).toEqual({ selected: 0, closed: 10, submitted: 0, exited: 0 })
  } finally { h.app.renderer.destroy() }
})

test("Escape after typing in the real picker closes it and preserves the composer draft", async () => {
  const h = await mount()
  try {
    h.open(); await h.settle()
    await h.app.mockInput.typeText("beta"); await h.settle()
    expect(h.picker()?.filter).toBe("beta")
    expect(h.picker()?.filtered.map(option => option.value)).toEqual(["beta"])
    await h.app.waitForFrame(frame => frame.includes("Beta model"))
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.composer.plainText).toBe("unsent draft")
    expect(h.calls).toEqual({ selected: 0, closed: 1, submitted: 0, exited: 0 })
  } finally { h.app.renderer.destroy() }
})

test("a native selection present at opening clears on first Escape and the next Escape dismisses", async () => {
  const h = await mount()
  try {
    h.selectSource()
    h.open(); await h.settle()
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.app.renderer.getSelection()).toBe(null)
    expect(h.dialog.stack).toHaveLength(1)
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.calls).toEqual({ selected: 0, closed: 1, submitted: 0, exited: 0 })
  } finally { h.app.renderer.destroy() }
})

test("copying a native selection while a picker is open leaves Escape able to dismiss it", async () => {
  const h = await mount()
  try {
    h.selectSource()
    h.open(); await h.settle()
    h.app.mockInput.pressCtrlC(); await h.settle()
    expect(h.copied).toEqual(["Background"])
    expect(h.app.renderer.getSelection()).toBe(null)
    expect(h.dialog.stack).toHaveLength(1)
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.calls).toEqual({ selected: 0, closed: 1, submitted: 0, exited: 0 })
  } finally { h.app.renderer.destroy() }
})

test("a keyboard selection in the filter clears before Escape dismisses and Ctrl+C still closes without a selection", async () => {
  const h = await mount()
  try {
    h.open(); await h.settle()
    await h.app.mockInput.typeText("beta"); await h.settle()
    h.app.mockInput.pressKey("HOME", { shift: true }); await h.settle()
    expect(h.app.renderer.getSelection()?.getSelectedText()).toBe("beta")
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.app.renderer.getSelection()).toBe(null)
    expect(h.dialog.stack).toHaveLength(1)
    expect(h.picker()?.filter).toBe("beta")
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    h.open(); await h.settle()
    h.app.mockInput.pressCtrlC(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.composer.plainText).toBe("unsent draft")
    expect(h.copied).toEqual([])
    expect(h.calls).toEqual({ selected: 0, closed: 2, submitted: 0, exited: 0 })
  } finally { h.app.renderer.destroy() }
})

test("nested modal receives Escape once and restores its parent before the composer", async () => {
  const h = await mount()
  try {
    let firstClosed = 0, secondClosed = 0, outerInput!: InputRenderable, inner!: DialogContext
    function Nested() {
      inner = useDialog()
      onMount(() => {
        outerInput.focus()
        inner.replace(() => <text>Second modal</text>, () => { secondClosed++ })
      })
      return <box />
    }
    h.dialog.replace(() => <box><text>First modal</text><input ref={value => { outerInput = value }} /><DialogProvider><Nested /></DialogProvider></box>, () => { firstClosed++ })
    await h.settle()
    h.app.mockInput.pressEscape(); await h.settle()
    expect(secondClosed).toBe(1)
    expect(firstClosed).toBe(0)
    expect(inner.stack).toHaveLength(0)
    expect(h.dialog.stack).toHaveLength(1)
    expect(h.app.captureCharFrame()).toContain("First modal")
    expect(h.app.renderer.currentFocusedRenderable).toBe(outerInput)
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
    expect(firstClosed).toBe(1)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.calls.exited).toBe(0)
  } finally { h.app.renderer.destroy() }
})
