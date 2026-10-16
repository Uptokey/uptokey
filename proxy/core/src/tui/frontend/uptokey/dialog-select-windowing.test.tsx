/** @jsxImportSource @opentui/solid */
import { expect, test } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { ScrollBoxRenderable } from "@opentui/core"
import { onCleanup } from "solid-js"
import { mkdtemp, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { tmpdir } from "node:os"
import { TuiPathsProvider } from "../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../vendor/opencode-tui/config"
import { KVProvider } from "../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../vendor/opencode-tui/context/theme"
import { ToastProvider } from "../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../vendor/opencode-tui/ui/dialog"
import { DialogSelect, type DialogSelectRef } from "../vendor/opencode-tui/ui/dialog-select"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../vendor/opencode-tui/keymap"

async function mount(virtualize: boolean, count = 2000, current = "model-0000") {
  const root = await mkdtemp(join(tmpdir(), "uptokey-dialog-window-"))
  await writeFile(join(root, "kv.json"), "{}")
  let dialog!: DialogContext, picker!: DialogSelectRef<string>
  let mounted = 0, selected = ""
  const options = Array.from({ length: count }, (_, i) => ({
    title: `Model ${i.toString().padStart(4, "0")}`, value: `model-${i.toString().padStart(4, "0")}`,
    category: `Provider ${Math.floor(i / 100)}`,
    details: i % 100 === 0 ? ["Model details"] : undefined,
    gutter: () => { mounted++; return <text>·</text> },
  }))
  function Consumer() { dialog = useDialog(); return <text>Composer draft</text> }
  function Harness() {
    const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer), config = resolveConfig({}, { terminalSuspend: false })
    const off = registerOpencodeKeymap(keymap, renderer, config); onCleanup(off)
    return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}><OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider><ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider><DialogProvider><Consumer /></DialogProvider></ToastProvider></ThemeProvider></KVProvider></TuiConfigProvider></OpencodeKeymapProvider></TuiPathsProvider>
  }
  const app = await testRender(() => <Harness />, { width: 100, height: 34, kittyKeyboard: true })
  const settle = async () => { await app.flush(); await Bun.sleep(5); await app.renderOnce(); await app.flush(); await app.renderOnce() }
  await settle()
  dialog.replace(() => <DialogSelect title="Models" virtualize={virtualize} current={current} options={options}
    ref={value => { picker = value }} onSelect={option => { selected = option.value; dialog.clear() }} />)
  await settle()
  const findScroll = (node: any): ScrollBoxRenderable | undefined => {
    if (node instanceof ScrollBoxRenderable) return node
    for (const child of node.getChildren()) { const match = findScroll(child); if (match) return match }
  }
  return { app, dialog, picker, settle, mounted: () => mounted, selected: () => selected, scroll: () => findScroll(app.renderer.root)! }
}

test("a large catalog mounts only viewport rows and still searches and selects its final model", async () => {
  const h = await mount(true)
  try {
    expect(h.mounted()).toBeLessThan(50)
    expect(h.picker.filtered).toHaveLength(2000)
    expect(h.app.captureCharFrame()).toContain("Model 0000")
    h.picker.moveTo("model-1999"); await h.settle()
    expect(h.app.captureCharFrame()).toContain("Model 1999")
    expect(h.mounted()).toBeLessThan(100)
    h.app.mockInput.pressEnter(); await h.settle()
    expect(h.selected()).toBe("model-1999")
    expect(h.dialog.stack).toHaveLength(0)
  } finally { h.app.renderer.destroy() }
})

test("native scroll, keyboard wrap and filter share the complete virtual catalog", async () => {
  const h = await mount(true)
  try {
    h.scroll().scrollTo(205); await h.settle()
    expect(h.app.captureCharFrame()).toContain("Model 0200")
    h.picker.moveTo("model-1999"); await h.settle()
    h.app.mockInput.pressArrow("down"); await h.settle()
    expect(h.app.captureCharFrame()).toContain("Model 0000")
    await h.app.mockInput.typeText("1999"); await h.settle()
    expect(h.picker.filtered.map(option => option.value)).toContain("model-1999")
    expect(h.app.captureCharFrame()).toContain("Model 1999")
    h.app.mockInput.pressEnter(); await h.settle()
    expect(h.selected()).toBe("model-1999")
  } finally { h.app.renderer.destroy() }
})

test("an existing selected model near the end is visible on opening and Escape closes the virtual list", async () => {
  const h = await mount(true, 2000, "model-1999")
  try {
    expect(h.app.captureCharFrame()).toContain("Model 1999")
    expect(h.mounted()).toBeLessThan(100)
    h.app.mockInput.pressEscape(); await h.settle()
    expect(h.dialog.stack).toHaveLength(0)
  } finally { h.app.renderer.destroy() }
})

test("windowing remains opt-in for other existing dialogs", async () => {
  const h = await mount(false, 100)
  try {
    expect(h.mounted()).toBe(100)
    h.picker.moveTo("model-0099"); await h.settle()
    expect(h.app.captureCharFrame()).toContain("Model 0099")
  } finally { h.app.renderer.destroy() }
})
