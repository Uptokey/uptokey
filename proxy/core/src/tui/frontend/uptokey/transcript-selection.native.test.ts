import { expect, test } from "bun:test"
import { MarkdownRenderable, ScrollBoxRenderable, SyntaxStyle, TextRenderable } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { createTranscriptSelection, registerTranscriptSource } from "./transcript-selection.ts"

test("OpenTUI native Unicode selection offsets and wrap preserve source copy", async () => {
  const setup = await createTestRenderer({ width: 24, height: 12 })
  const { renderer } = setup
  const text = "e\u0301界 👨‍👩‍👧‍👦 repeat repeat\nالعربية نهاية"
  const scroll = new ScrollBoxRenderable(renderer, { id: "uptokey-transcript", width: "100%", height: "100%" })
  const renderable = new TextRenderable(renderer, { content: text, width: "100%", wrapMode: "word" })
  registerTranscriptSource(renderable, () => ({ kind: "assistant", id: "a", text }))
  scroll.add(renderable); renderer.root.add(scroll)
  const selection = createTranscriptSelection({ renderer: renderer as never, context: () => "project/a", modal: () => false, restoreFocus() {}, notice() {} })
  try {
    await setup.renderOnce()
    const view = (renderable as any).textBufferView
    view.setSelection(0, 3)
    expect(renderable.getSelectedText()).toBe("e\u0301界")
    expect(renderable.getSelection()).toEqual({ start: 0, end: 3 })
    expect(selection.begin()).toBe(true)
    for (const prefix of ["e\u0301", "e\u0301界", "e\u0301界 ", "e\u0301界 👨‍👩‍👧‍👦"]) {
      selection.key({ name: "right", shift: true, preventDefault() {}, stopPropagation() {} })
      expect(selection.text()).toBe(prefix)
      expect(renderable.getSelectedText()).toBe(prefix)
    }
    selection.key({ name: "end", ctrl: true, shift: true, preventDefault() {}, stopPropagation() {} })
    expect(selection.text()).toBe(text)
    setup.resize(60, 12)
    await setup.renderOnce(); selection.refresh()
    expect(selection.text()).toBe(text)
    expect(renderable.getSelectedText()).toBe(text)
  } finally { renderer.destroy() }
})

test("OpenTUI Markdown and code source copy includes original fences and whitespace", async () => {
  const setup = await createTestRenderer({ width: 30, height: 16 })
  const { renderer } = setup
  const source = "  # title\n\n**repeat** repeat\n\n```ts\n\tconst value = '界';\n```\n\nending  "
  const syntax = SyntaxStyle.fromStyles({ default: { fg: "#ffffff" } })
  const scroll = new ScrollBoxRenderable(renderer, { id: "uptokey-transcript", width: "100%", height: "100%" })
  const renderable = new MarkdownRenderable(renderer, { content: source, syntaxStyle: syntax, internalBlockMode: "top-level", width: "100%", conceal: true })
  registerTranscriptSource(renderable, () => ({ kind: "assistant", id: "markdown-a", text: source }))
  scroll.add(renderable); renderer.root.add(scroll)
  const selection = createTranscriptSelection({ renderer: renderer as never, context: () => "project/a", modal: () => false, restoreFocus() {}, notice() {} })
  try {
    await setup.renderOnce()
    expect(selection.begin()).toBe(true)
    selection.key({ name: "end", ctrl: true, shift: true, preventDefault() {}, stopPropagation() {} })
    expect(selection.text()).toBe(source)
    setup.resize(18, 10)
    await setup.renderOnce(); selection.refresh()
    expect(selection.text()).toBe(source)
  } finally { renderer.destroy(); syntax.destroy() }
})

test("native mouse selection and keyboard paging retain source bounds outside the viewport", async () => {
  const setup = await createTestRenderer({ width: 28, height: 10 })
  const { renderer } = setup
  const source = Array.from({ length: 120 }, (_, i) => `row ${i} repeat repeat 界`).join("\n")
  const scroll = new ScrollBoxRenderable(renderer, { id: "uptokey-transcript", width: "100%", height: "100%" })
  const native = new TextRenderable(renderer, { content: source, width: "100%", wrapMode: "word" })
  registerTranscriptSource(native, () => ({ kind: "assistant", id: "long-a", text: source }))
  scroll.add(native); renderer.root.add(scroll)
  const selection = createTranscriptSelection({ renderer: renderer as never, context: () => "project/a", modal: () => false, restoreFocus() {}, notice() {} })
  try {
    await setup.renderOnce()
    renderer.startSelection(native, native.x + 6, native.y)
    renderer.updateSelection(native, native.x + 12, native.y, { finishDragging: true })
    selection.captureMouse()
    expect(selection.text()).toBe("repeat")
    scroll.scrollTop = 90
    await setup.renderOnce(); selection.refresh()
    expect(selection.text()).toBe("repeat")
    selection.begin()
    await setup.renderOnce()
    selection.key({ name: "right", shift: true, preventDefault() {}, stopPropagation() {} })
    expect(scroll.scrollTop).toBe(0)
    selection.key({ name: "pagedown", shift: true, preventDefault() {}, stopPropagation() {} })
    const text = selection.text()
    expect(text?.startsWith("row 0 repeat repeat 界\nrow 1")).toBe(true)
    setup.resize(16, 8)
    await setup.renderOnce(); selection.refresh()
    expect(selection.text()).toBe(text)
  } finally { renderer.destroy() }
})

test("native completed selection captures an exact Unicode drag released beyond the text", async () => {
  const setup = await createTestRenderer({ width: 120, height: 10 })
  const { renderer, mockMouse } = setup
  const source = "Texto: Olá, 世界! café 👨‍👩‍👧 fim"
  const scroll = new ScrollBoxRenderable(renderer, { id: "uptokey-transcript", width: "100%", height: "100%" })
  const native = new TextRenderable(renderer, { content: source, width: "100%", wrapMode: "word" })
  registerTranscriptSource(native, () => ({ kind: "assistant", id: "unicode-a", text: source }))
  scroll.add(native); renderer.root.add(scroll)
  const selection = createTranscriptSelection({ renderer: renderer as never, context: () => "project/a", modal: () => false, restoreFocus() {}, notice() {} })
  const completed: string[] = []
  const finish = () => { selection.captureMouse(); const value = selection.text(); if (value) completed.push(value) }
  renderer.on("selection", finish)
  try {
    await setup.renderOnce()
    await mockMouse.drag(native.x, native.y, 117, native.y)
    expect(native.getSelectedText()).toBe(source)
    expect(completed).toEqual([source])
    expect(selection.text()).toBe(source)
    selection.clear()
    setup.resize(92, 10)
    await setup.renderOnce()
    await mockMouse.drag(native.x, native.y, 89, native.y)
    expect(native.getSelectedText()).toBe(source)
    expect(completed).toEqual([source, source])
    expect(selection.text()).toBe(source)
  } finally { renderer.off("selection", finish); renderer.destroy() }
})
