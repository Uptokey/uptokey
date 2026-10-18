/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { type TextareaRenderable } from "@opentui/core"
import { createResource, onCleanup, onMount } from "solid-js"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TuiPathsProvider } from "../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../vendor/opencode-tui/config"
import { KVProvider } from "../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../vendor/opencode-tui/context/theme"
import { ToastProvider } from "../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../vendor/opencode-tui/ui/dialog"
import { DialogSelect } from "../vendor/opencode-tui/ui/dialog-select"
import { OpencodeKeymapProvider, registerOpencodeKeymap, useBindings } from "../vendor/opencode-tui/keymap"

type Option = { title: string; value: string }
async function mount(options: Option[] = [{ title: "Alpha model", value: "alpha" }], preregistered = false) {
  const root = await mkdtemp(join(tmpdir(), "uptokey-dialog-actions-"))
  await writeFile(join(root, "kv.json"), "{}")
  let dialog!: DialogContext, composer!: TextareaRenderable
  let resolveOptions!: (options: Option[]) => void
  const lateOptions = new Promise<Option[]>(resolve => { resolveOptions = resolve })
  const calls = { provider: 0, favorite: 0, selected: 0 }
  function Consumer() {
    dialog = useDialog()
    if (preregistered) useBindings(() => ({ commands: [
      { name: "model.dialog.provider", title: "Connect provider", run() {} },
      { name: "model.dialog.favorite", title: "Favorite", run() {} },
    ], bindings: [
      { key: "ctrl+a", cmd: "model.dialog.provider" },
      { key: "ctrl+f", cmd: "model.dialog.favorite" },
    ] }))
    onMount(() => composer.focus())
    return <textarea ref={value => { composer = value }} initialValue="unsent draft" height={3} />
  }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider><DialogProvider><Consumer /></DialogProvider></ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider></TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 32, kittyKeyboard: true })
  const settle = async () => { await app.flush(); await Bun.sleep(5); await app.flush(); await app.renderOnce() }
  await settle()
  const readyUntil = Date.now() + 2000
  while (!dialog || !composer) {
    if (Date.now() >= readyUntil) throw new Error("dialog action fixture did not mount its composer")
    await settle()
  }
  function Picker() {
    const [loaded] = createResource(() => preregistered ? lateOptions : Promise.resolve(options))
    return <DialogSelect title="Select model" flat preserveSelection options={preregistered ? loaded() ?? [] : options} onSelect={() => { calls.selected++ }} actions={[
      { command: "model.dialog.provider", title: "Connect provider", selection: "none", onTrigger() { calls.provider++; dialog.clear() } },
      { command: "model.dialog.favorite", title: "Favorite", onTrigger(option) { expect(option.value).toBe("alpha"); calls.favorite++ } },
    ]} />
  }
  dialog.replace(() => <Picker />)
  await settle()
  return { app, calls, composer, dialog, settle, resolveOptions }
}

test("dialog-level provider shortcut remains available after filtering every model out", async () => {
  const h = await mount()
  try {
    await h.app.mockInput.typeText("zzzz_no_such_model"); await h.settle()
    expect(h.app.captureCharFrame()).toContain("No results found")
    h.app.mockInput.pressKey("a", { ctrl: true }); await h.settle()
    expect(h.calls).toEqual({ provider: 1, favorite: 0, selected: 0 })
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.composer.plainText).toBe("unsent draft")
  } finally { h.app.renderer.destroy() }
})

test("Tab and Enter can run a dialog-level action with an empty model catalog", async () => {
  const h = await mount([])
  try {
    h.app.mockInput.pressTab(); await h.settle()
    h.app.mockInput.pressEnter(); await h.settle()
    expect(h.calls).toEqual({ provider: 1, favorite: 0, selected: 0 })
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
    expect(h.composer.plainText).toBe("unsent draft")
  } finally { h.app.renderer.destroy() }
})

test("selection-dependent favorite is blocked without a model and receives the actual option when available", async () => {
  const h = await mount([])
  try {
    h.app.mockInput.pressKey("f", { ctrl: true }); await h.settle()
    h.app.mockInput.pressEnter(); await h.settle()
    expect(h.calls).toEqual({ provider: 0, favorite: 0, selected: 0 })
    expect(h.dialog.stack).toHaveLength(1)
  } finally { h.app.renderer.destroy() }
  const available = await mount()
  try {
    available.app.mockInput.pressKey("f", { ctrl: true }); await available.settle()
    expect(available.calls).toEqual({ provider: 0, favorite: 1, selected: 0 })
  } finally { available.app.renderer.destroy() }
})

test("pre-registered actions survive an empty async session list and enable the loaded selection", async () => {
  const h = await mount([], true)
  try {
    expect(h.app.captureCharFrame()).toContain("No results found")
    h.app.mockInput.pressKey("f", { ctrl: true }); await h.settle()
    expect(h.calls.favorite).toBe(0)
    h.resolveOptions([{ title: "Alpha model", value: "alpha" }]); await h.settle()
    expect(h.app.captureCharFrame()).toContain("Alpha model")
    h.app.mockInput.pressKey("f", { ctrl: true }); await h.settle()
    expect(h.calls.favorite).toBe(1)
    h.app.mockInput.pressTab(); await h.settle()
    h.app.mockInput.pressEnter(); await h.settle()
    expect(h.calls.provider).toBe(1)
    expect(h.dialog.stack).toHaveLength(0)
    expect(h.app.renderer.currentFocusedRenderable).toBe(h.composer)
  } finally { h.app.renderer.destroy() }
})
