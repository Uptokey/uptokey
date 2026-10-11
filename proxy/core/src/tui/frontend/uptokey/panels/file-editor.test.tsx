/** @jsxImportSource @opentui/solid */
import { describe, test, expect } from "bun:test"
import { testRender, useRenderer } from "@opentui/solid"
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui"
import { onCleanup, onMount } from "solid-js"
import { TextareaRenderable } from "@opentui/core"
import { createHash } from "node:crypto"
import { resolve, join, dirname } from "node:path"
import { mkdir, mkdtemp, writeFile, rm } from "node:fs/promises"
import { EditorSession } from "../../../editor/session.ts"
import { WorkspaceServiceError, type WorkspaceView, type RunCommand } from "../../../workspace.ts"
import { FileEditorPanel, editorSessionFor, ManualFileEditor, applyEditorDisplayText, editorDisplayText, captureEditorSelection, restoreEditorSelection } from "./file-editor.tsx"
import { EDITOR_STRINGS, EDITOR_LANGS, editorText } from "../i18n/editor-integration.ts"
import { setBackend } from "../backend/registry.ts"
import { setLang, getLang } from "../../../i18n.ts"
import { TuiPathsProvider } from "../../vendor/opencode-tui/context/runtime"
import { TuiConfigProvider, resolve as resolveConfig } from "../../vendor/opencode-tui/config"
import { KVProvider } from "../../vendor/opencode-tui/context/kv"
import { ThemeProvider } from "../../vendor/opencode-tui/context/theme"
import { ToastProvider } from "../../vendor/opencode-tui/ui/toast"
import { DialogProvider, useDialog, type DialogContext } from "../../vendor/opencode-tui/ui/dialog"
import { OpencodeKeymapProvider, registerOpencodeKeymap } from "../../vendor/opencode-tui/keymap"

const binding = { projectId: "synthetic-project", rootBindingId: "synthetic-root", rootPath: resolve("synthetic-editor-project") }
const sha = (text: string) => createHash("sha256").update(text).digest("hex")
const digest = "a".repeat(64)

function fixture() {
  const files = new Map([["a.ts", "const value = 1;\r\n"], ["b.ts", "second"]])
  const session = new EditorSession("fixture"), commands: RunCommand[] = [], changes: Array<{path: string; content: string; type?: "replace" | "create"; expectedSha256?: string}> = []
  let current = true, identity = true, status = "succeeded", receipt = true, unknownAck = false
  const view = (): WorkspaceView => ({ projectId: binding.projectId, revision: 1, plan: { id: "plan", digest, steps: [] },
    run: { id: "run", planId: "plan", requestId: commands[0]?.requestId, status }, artifact: null,
    receipts: receipt ? [{ id: "receipt", runId: "run", status: "succeeded", capabilityId: "workspace.project.write", outputArtifactRefs: [] }] : [] })
  const workspace = {
    readProjectFile: async (_pid: string, _rid: string, path: string) => {
      const text = files.get(path)
      return text === undefined ? null : { text, sha256: sha(text), relativePath: path, byteLength: text.length, mediaType: "text/plain" }
    },
    createWritePlan: async (_pid: string, _rid: string, values: typeof changes) => { changes.push(...values); return { id: "plan", digest } },
    approveAndStart: async (_pid: string, command: RunCommand, sign: (nonce: string) => string) => {
      expect(sign("synthetic-nonce")).toBe("synthetic-signature"); commands.push(command)
      if (unknownAck) throw new WorkspaceServiceError("ack_lost", 502, "unknown")
      return view()
    },
    waitForSettledRun: async () => view(), refreshPlan: async () => view(),
  }
  const editor = new ManualFileEditor(session, binding, workspace, () => identity ? () => "synthetic-signature" : null, () => current)
  return { editor, session, workspace, commands, changes,
    setCurrent: (value: boolean) => current = value, setIdentity: (value: boolean) => identity = value,
    setStatus: (value: string) => status = value, setReceipt: (value: boolean) => receipt = value, loseAck: () => unknownAck = true }
}

describe("manual editor integration", () => {
  test("editing preserves BOM, CRLF, graphemes and real undo/redo", () => {
    const doc = new EditorSession().open("a.txt", "\uFEFFa👩‍💻é\r\nunchanged\r\n", sha("original"))
    applyEditorDisplayText(doc, "\uFEFFa👩‍💻ê\nunchanged\n")
    expect(doc.buffer.getText()).toBe("\uFEFFa👩‍💻ê\r\nunchanged\r\n")
    expect(doc.buffer.modified).toBe(true)
    expect(doc.buffer.undo()).toBe(true)
    expect(doc.buffer.getText()).toBe("\uFEFFa👩‍💻é\r\nunchanged\r\n")
    expect(doc.buffer.modified).toBe(false)
    expect(doc.buffer.redo()).toBe(true)
    expect(editorDisplayText(doc)).toBe("\uFEFFa👩‍💻ê\nunchanged\n")
  })

  test("drafts and undo survive file switches, and each exact owner/root stays isolated", async () => {
    const f = fixture(), first = await f.editor.open("a.ts")
    applyEditorDisplayText(first!, "const value = 2;\n")
    await f.editor.open("b.ts")
    expect(await f.editor.open("a.ts")).toBe(first)
    expect(first!.buffer.getText()).toBe("const value = 2;\r\n")
    expect(first!.buffer.undo()).toBe(true)
    const owner = {}
    expect(editorSessionFor(owner, binding)).toBe(editorSessionFor(owner, { ...binding }))
    expect(editorSessionFor(owner, binding)).not.toBe(editorSessionFor({}, binding))
    expect(editorSessionFor(owner, binding)).not.toBe(editorSessionFor(owner, { ...binding, rootBindingId: "other" }))
  })

  test("outside paths and a late read after a project switch never enter the session", async () => {
    const f = fixture()
    await expect(f.editor.open("../outside.ts")).rejects.toThrow("editor_path_outside_root")
    f.workspace.readProjectFile = async () => { f.setCurrent(false); return { text: "late", sha256: sha("late"), relativePath: "a.ts", byteLength: 4, mediaType: "text/plain" } }
    await expect(f.editor.open("a.ts")).rejects.toThrow("editor_context_changed")
    expect(f.session.documents.size).toBe(0)
  })

  test("a slower file open cannot take focus from the person's newer file choice", async () => {
    const f = fixture()
    let release!: () => void
    const originalRead = f.workspace.readProjectFile
    f.workspace.readProjectFile = async (pid, rid, path) => {
      if (path === "a.ts") await new Promise<void>(resolve => release = resolve)
      return originalRead(pid, rid, path)
    }
    const slow = f.editor.open("a.ts")
    await f.editor.open("b.ts"); release()
    await expect(slow).rejects.toThrow("editor_open_superseded")
    expect(f.session.current!.buffer.path).toBe(resolve(binding.rootPath, "b.ts"))
    expect(f.session.documents.size).toBe(1)
  })

  test("save confirms only the submitted snapshot and matching receipt, retaining newer edits", async () => {
    const f = fixture(), doc = (await f.editor.open("a.ts"))!
    applyEditorDisplayText(doc, "submitted\n")
    f.workspace.waitForSettledRun = async () => {
      applyEditorDisplayText(doc, "newer\n")
      return { projectId: binding.projectId, revision: 1, plan: { id: "plan", digest, steps: [] }, artifact: null,
        run: { id: "run", planId: "plan", status: "succeeded", requestId: f.commands[0]!.requestId },
        receipts: [{ id: "receipt", runId: "run", status: "succeeded", capabilityId: "workspace.project.write", outputArtifactRefs: [] }] }
    }
    const result = await f.editor.save(doc)
    expect(result?.ok).toBe(true)
    expect(f.changes[0]).toEqual({ path: "a.ts", content: "submitted\r\n", type: "replace", expectedSha256: sha("const value = 1;\r\n") })
    expect(doc.diskHash).toBe(sha("submitted\r\n"))
    expect(doc.buffer.getText()).toBe("newer\r\n")
    expect(doc.buffer.modified).toBe(true)
    expect(doc.saving).toBe(false)
  })

  test("missing identity or receipt cannot clear a draft", async () => {
    const f = fixture(), doc = (await f.editor.open("a.ts"))!
    applyEditorDisplayText(doc, "edited\n"); f.setIdentity(false)
    const identity = await f.editor.save(doc)
    expect(identity?.ok).toBe(false)
    expect(f.changes.length).toBe(0)
    expect(doc.buffer.modified).toBe(true)
    f.setIdentity(true); f.setReceipt(false)
    const receipt = await f.editor.save(doc)
    expect(receipt?.ok).toBe(false)
    expect(doc.buffer.modified).toBe(true)
    expect(doc.operation?.runId).toBe("run")
  })

  test("a disk hash conflict never consents or clears the draft", async () => {
    const f = fixture(), doc = (await f.editor.open("a.ts"))!
    applyEditorDisplayText(doc, "edited\n")
    const hash = doc.diskHash
    f.workspace.createWritePlan = async () => { throw new WorkspaceServiceError("base_hash_mismatch", 409) }
    const result = await f.editor.save(doc)
    expect(result?.ok).toBe(false)
    expect(f.commands.length).toBe(0)
    expect(doc.diskHash).toBe(hash)
    expect(doc.buffer.modified).toBe(true)
  })

  test("lost ACK reuses the exact operation, without a second plan or consent", async () => {
    const f = fixture(), doc = (await f.editor.open("a.ts"))!
    applyEditorDisplayText(doc, "submitted\n"); f.loseAck()
    expect((await f.editor.save(doc))?.ok).toBe(false)
    const request = doc.operation!.requestId
    applyEditorDisplayText(doc, "newer\n")
    const result = await f.editor.save(doc)
    expect(result?.ok).toBe(true)
    expect(result?.requestId).toBe(request)
    expect(f.commands.length).toBe(1)
    expect(f.changes.length).toBe(1)
    expect(doc.buffer.modified).toBe(true)
  })

  test("OpenTUI selections round trip wide characters, emoji, tabs and CRLF", async () => {
    const doc = new EditorSession().open("a.txt", "a👩‍💻é中\r\n\tword\r\n", sha("original"))
    let textarea!: TextareaRenderable
    const app = await testRender(() => <textarea ref={(value: TextareaRenderable) => textarea = value} initialValue={editorDisplayText(doc)} height={5} width={40} />)
    try {
      doc.buffer.setSelections([{ anchor: { line: 0, col: 1 }, head: { line: 0, col: 4 } }])
      restoreEditorSelection(doc, textarea); captureEditorSelection(doc, textarea)
      expect(doc.buffer.selectedTexts()).toEqual(["👩‍💻é中"])
      doc.buffer.setSelections([{ anchor: { line: 1, col: 1 }, head: { line: 1, col: 5 } }])
      restoreEditorSelection(doc, textarea); captureEditorSelection(doc, textarea)
      expect(doc.buffer.selectedTexts()).toEqual(["word"])
      expect(doc.buffer.getText()).toBe("a👩‍💻é中\r\n\tword\r\n")
    } finally { app.renderer.destroy() }
  })

  test("rendered canonical panel edits, undoes, saves with receipt, closes and restores its draft", async () => {
    const parent = resolve("../../../output"), previousLang = getLang()
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, "manual-editor-test-"))
    await writeFile(join(root, "kv.json"), "{}")
    setLang("en")
    const f = fixture(), notices: string[] = []
    const controller = { view: { binding }, workspace: f.workspace, signer: () => "synthetic-signature",
      store: { conversationRevision: 0 }, notice: (_kind: string, text: string) => notices.push(text), setAttention() {} }
    setBackend({ controller, onChange: () => () => undefined } as never)
    let dialog!: DialogContext
    function Launch() { dialog = useDialog(); onMount(() => dialog.replace(() => <FileEditorPanel path="a.ts" />)); return <box /> }
    function Harness() {
      const renderer = useRenderer(), keymap = createDefaultOpenTuiKeymap(renderer)
      const config = resolveConfig({}, { terminalSuspend: false })
      const off = registerOpencodeKeymap(keymap, renderer, config)
      onCleanup(off)
      return <TuiPathsProvider value={{ cwd: root, home: root, state: root, worktree: root }}>
        <OpencodeKeymapProvider keymap={keymap}><TuiConfigProvider config={config}><KVProvider>
          <ThemeProvider mode="dark" source={{ discover: async () => ({}) }}><ToastProvider><DialogProvider><Launch /></DialogProvider></ToastProvider></ThemeProvider>
        </KVProvider></TuiConfigProvider></OpencodeKeymapProvider>
      </TuiPathsProvider>
    }
    const app = await testRender(() => <Harness />, { width: 120, height: 38, kittyKeyboard: true })
    try {
      const wait = async (predicate: () => boolean) => {
        const until = Date.now() + 2000
        while (!predicate() && Date.now() < until) { await Bun.sleep(10); await app.renderOnce() }
        expect(predicate()).toBe(true)
      }
      await app.renderOnce()
      await wait(() => app.renderer.currentFocusedEditor instanceof TextareaRenderable)
      await app.waitForFrame(frame => frame.includes("File editor") && frame.includes("const value = 1;"))
      const textarea = app.renderer.currentFocusedEditor as TextareaRenderable
      textarea.gotoBufferEnd(); await app.mockInput.typeText("manual")
      app.mockInput.pressEnter(); await app.flush()
      const session = editorSessionFor(controller, binding), doc = session.current!
      expect(doc.buffer.getText()).toBe("const value = 1;\r\nmanual\r\n")
      expect(f.commands.length).toBe(0)
      app.mockInput.pressKey("z", { ctrl: true }); await app.flush()
      expect(doc.buffer.getText()).toBe("const value = 1;\r\nmanual")
      app.mockInput.pressKey("y", { ctrl: true }); await app.flush()
      expect(doc.buffer.getText()).toBe("const value = 1;\r\nmanual\r\n")
      app.mockInput.pressKey("s", { ctrl: true }); await wait(() => notices.some(text => text.includes("receipt")))
      expect(doc.buffer.modified).toBe(false)
      await app.mockInput.typeText("draft"); await app.flush()
      app.mockInput.pressEscape(); await app.flush()
      expect(dialog.stack.length).toBe(0)
      expect(doc.buffer.getText()).toBe("const value = 1;\r\nmanual\r\ndraft")
      dialog.replace(() => <FileEditorPanel path="a.ts" />)
      await app.waitForFrame(frame => frame.includes("draft"))
      expect((app.renderer.currentFocusedEditor as TextareaRenderable).plainText).toBe(editorDisplayText(doc))
      expect(doc.buffer.modified).toBe(true)
      const original = doc.buffer.getText()
      const imported = { doc, version: doc.buffer.version, content: "external draft\r\n", patch: "-draft\n+external draft" }
      dialog.replace(() => <FileEditorPanel path="a.ts" externalImport={imported} />)
      await app.waitForFrame(frame => frame.includes("Review external edits"))
      app.mockInput.pressEscape(); await app.flush()
      expect(doc.buffer.getText()).toBe(original)
      dialog.replace(() => <FileEditorPanel path="a.ts" externalImport={imported} />)
      await app.renderOnce(); app.mockInput.pressEnter(); await app.flush()
      expect(doc.buffer.getText()).toBe("external draft\r\n")
      expect(f.commands.length).toBe(1)
      expect(doc.buffer.undo()).toBe(true)
      expect(doc.buffer.getText()).toBe(original)
    } finally {
      app.renderer.destroy(); setLang(previousLang)
      expect(dirname(root)).toBe(parent)
      await rm(root, { recursive: true, force: true })
    }
  })

  test("every editor string has all ten locales and placeholders interpolate", () => {
    for (const [key, row] of Object.entries(EDITOR_STRINGS)) {
      expect(row.length).toBe(10)
      for (const lang of EDITOR_LANGS) expect(editorText(key as keyof typeof EDITOR_STRINGS, { path: "a.ts", receipt: "r1", line: 2, column: 3, count: 5, query: "needle", code: "failure", binary: "hx" }, lang)).not.toMatch(/\{\w+\}/)
      for (const text of row) expect(text.trim().length).toBeGreaterThan(0)
    }
    expect(editorText("title", undefined, "en")).toBe("File editor")
    expect(editorText("saved", { path: "a.ts", receipt: "r1" }, "ja")).toContain("a.ts")
  })
})
