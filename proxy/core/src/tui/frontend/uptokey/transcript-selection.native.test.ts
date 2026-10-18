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

function frameFixture(initial: string) {
  let source = initial, plain = initial, paints = 0
  const view = () => ({ setSelection() { paints++ }, resetSelection() {} })
  const native: any = {
    id: "leaf", x: 0, y: 0, width: 120, height: 1,
    get plainText() { return plain }, getChildren: () => [], getSelection: () => ({ start: 0, end: 4 }),
    textBuffer: { get length() { return plain.length }, getTextRange: (start: number, end: number) => plain.slice(start, end) },
    textBufferView: view(),
  }
  const sourceBox: any = { id: "source", x: 0, y: 0, width: 120, height: 1, getChildren: () => [native] }
  registerTranscriptSource(sourceBox, () => ({ kind: "assistant", id: "message", text: source }))
  let selected: any = { selectedRenderables: [native], isDragging: false }
  const renderer: any = { root: { getChildren: () => [sourceBox] }, getSelection: () => selected, clearSelection: () => { selected = null } }
  const selection = createTranscriptSelection({ renderer, context: () => "session", modal: () => false, restoreFocus() {}, notice() {} })
  return { selection, native, paints: () => paints, update(raw: string, displayed = raw) { source = raw; plain = displayed }, replaceView() { native.textBufferView = view() } }
}

test("unchanged selection frames neither resanitize source bodies nor serialize transcript text", () => {
  const f = frameFixture("safe " + "x".repeat(64 * 1024))
  f.selection.captureMouse(); f.selection.refresh()
  let scans = 0, serializations = 0
  const originalCodeAt = String.prototype.charCodeAt, originalStringify = JSON.stringify
  String.prototype.charCodeAt = function (index: number) { scans++; return originalCodeAt.call(this, index) }
  JSON.stringify = ((...args: Parameters<typeof JSON.stringify>) => { serializations++; return originalStringify(...args) }) as typeof JSON.stringify
  try { for (let frame = 0; frame < 30; frame++) f.selection.refresh() }
  finally { String.prototype.charCodeAt = originalCodeAt; JSON.stringify = originalStringify }
  expect(scans).toBe(0)
  expect(serializations).toBe(0)
  expect(f.selection.text()).toBe("safe")
  f.selection.clear()
})

test("cached source selection preserves streaming, sanitization, replacement and new native view boundaries", () => {
  const f = frameFixture("safe text")
  f.selection.captureMouse(); f.selection.refresh()
  expect(f.selection.text()).toBe("safe")
  f.update("safe text streamed"); f.selection.refresh()
  expect(f.selection.text()).toBe("safe")
  const beforeMove = f.paints()
  f.native.x++; f.selection.refresh()
  expect(f.paints()).toBeGreaterThan(beforeMove)
  const beforeView = f.paints()
  f.replaceView(); f.selection.refresh()
  expect(f.paints()).toBeGreaterThan(beforeView)
  f.update("safe\x1b]52;c;hidden\x07 text", "safe text"); f.selection.refresh()
  expect(f.selection.text()).toBe("safe")
  f.update("changed text"); f.selection.refresh()
  expect(f.selection.text()).toBeNull()
  f.selection.clear()
  expect(f.selection.active()).toBe(false)
})

test("collapsed caret reads only the first Unicode grapheme of a long source", () => {
  const f = frameFixture("e\u0301" + "x".repeat(64 * 1024))
  let segments = 0
  const original = Intl.Segmenter.prototype.segment
  Intl.Segmenter.prototype.segment = function (input: string) {
    const result = original.call(this, input)
    const iterator = result[Symbol.iterator].bind(result)
    return { ...result, [Symbol.iterator]() {
      const current = iterator()
      return { [Symbol.iterator]() { return this }, next() { const value = current.next(); if (!value.done) segments++; return value } }
    } } as Intl.Segments
  }
  try { expect(f.selection.begin()).toBe(true) }
  finally { Intl.Segmenter.prototype.segment = original }
  expect(segments).toBe(1)
  f.selection.clear()
})
