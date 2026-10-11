/** Manual editing uses the shared ephemeral buffers and canonical writer, without an inference. */
import { TextAttributes, type TextareaRenderable } from "@opentui/core"
import { useRenderer, useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js"
import { resolve } from "node:path"
import { createPatch } from "diff"
import { Buffer as EditorBuffer } from "../../../editor/buffer.ts"
import { EditorSession, type EditorDocument } from "../../../editor/session.ts"
import { findHelix, launchHelix } from "../../../editor/helix.ts"
import { canonicalProjectRelativePath, saveEditorBuffer, type EditorSaveResult } from "../../../editor-save.ts"
import type { WorkspaceService } from "../../../workspace.ts"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { useTuiConfig } from "../../vendor/opencode-tui/config"
import { useBindings } from "../../vendor/opencode-tui/keymap"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { DialogConfirm } from "../../vendor/opencode-tui/ui/dialog-confirm"
import { DialogSelect } from "../../vendor/opencode-tui/ui/dialog-select"
import { useClipboard } from "../../vendor/opencode-tui/context/clipboard"
import { getBackend } from "../backend/registry.ts"
import { editorText as e } from "../i18n/editor-integration.ts"
import { TextView } from "../dialogs/text-view.tsx"
import { getScrollAcceleration } from "../../vendor/opencode-tui/util/scroll"
import { useControllerTick } from "./use-controller.ts"

export interface EditorBinding { projectId: string; rootBindingId: string; rootPath: string }
type EditorWorkspace = Pick<WorkspaceService, "readProjectFile" | "createWritePlan" | "approveAndStart" | "waitForSettledRun" | "refreshPlan">
const sessions = new WeakMap<object, Map<string, EditorSession>>()
const openings = new WeakMap<EditorSession, number>()
const contextKey = (binding: EditorBinding) => JSON.stringify([binding.projectId, binding.rootBindingId, binding.rootPath])

/** Owner lifetime bounds retention; changing project/root never exposes another project's drafts. */
export function editorSessionFor(owner: object, binding: EditorBinding): EditorSession {
  let owned = sessions.get(owner)
  if (!owned) { owned = new Map(); sessions.set(owner, owned) }
  const key = contextKey(binding)
  let session = owned.get(key)
  if (!session) { session = new EditorSession(key); owned.set(key, session) }
  return session
}

export function editorDisplayText(doc: EditorDocument): string { return doc.buffer.getText().replace(/\r\n/g, "\n") }

/** Adapt the native LF textarea to the shared grapheme transactions, preserving untouched original bytes. */
export function applyEditorDisplayText(doc: EditorDocument, next: string): void {
  const previous = editorDisplayText(doc)
  if (previous === next) return
  const before = new EditorBuffer(doc.buffer.path, previous), after = new EditorBuffer(doc.buffer.path, next)
  let from = 0, oldEnd = previous.length, newEnd = next.length
  while (from < oldEnd && from < newEnd && previous[from] === next[from]) from++
  const boundary = (buffer: EditorBuffer, offset: number) => buffer.offsetAt(buffer.positionAt(offset)) === offset
  while (from > 0 && (!boundary(before, from) || !boundary(after, from))) from--
  while (oldEnd > from && newEnd > from && previous[oldEnd - 1] === next[newEnd - 1]) { oldEnd--; newEnd-- }
  while (!boundary(before, oldEnd) || !boundary(after, newEnd)) { oldEnd++; newEnd++ }
  const start = before.positionAt(from), end = before.positionAt(oldEnd)
  const original = doc.buffer.getText()
  const eol = original.includes("\r\n") ? "\r\n" : "\n"
  doc.buffer.applyOffsetChanges([{ from: doc.buffer.offsetAt(start), to: doc.buffer.offsetAt(end), insert: next.slice(from, newEnd).replace(/\n/g, eol) }])
}

/** Small adapter over the existing session and W5 save protocol, also usable by focused tests. */
export class ManualFileEditor {
  constructor(readonly session: EditorSession, readonly binding: EditorBinding, private workspace: EditorWorkspace,
    private signer: () => ((nonce: string) => string) | null, readonly isCurrent: () => boolean) {}

  relativePath(path: string): string | null { return canonicalProjectRelativePath(this.binding.rootPath, resolve(this.binding.rootPath, path)) }

  async open(path: string): Promise<EditorDocument | null> {
    const relative = this.relativePath(path)
    if (!relative) throw new Error("editor_path_outside_root")
    if (!this.isCurrent()) throw new Error("editor_context_changed")
    const absolute = resolve(this.binding.rootPath, relative)
    const generation = (openings.get(this.session) ?? 0) + 1
    openings.set(this.session, generation)
    const cached = this.session.documents.get(absolute)
    if (cached) { this.session.activate(absolute); return cached }
    const file = await this.workspace.readProjectFile(this.binding.projectId, this.binding.rootBindingId, relative)
    if (!this.isCurrent()) throw new Error("editor_context_changed")
    if (openings.get(this.session) !== generation) throw new Error("editor_open_superseded")
    return file ? this.session.open(absolute, file.text, file.sha256) : null
  }

  async save(doc: EditorDocument): Promise<EditorSaveResult | null> {
    if (doc.saving || !doc.buffer.modified && !doc.operation) return null
    if (!this.isCurrent()) throw new Error("editor_context_changed")
    const requireCurrent = () => { if (!this.isCurrent()) throw new Error("editor_context_changed") }
    doc.saving = true
    try {
      const result = await saveEditorBuffer({
        createWritePlan: (pid, rid, changes) => { requireCurrent(); return this.workspace.createWritePlan(pid, rid, changes) },
        approveAndStart: (pid, command, sign) => { requireCurrent(); return this.workspace.approveAndStart(pid, command, sign) },
        waitForSettledRun: (pid, association, options) => this.workspace.waitForSettledRun(pid, association, options),
        refreshPlan: (pid, planId) => this.workspace.refreshPlan(pid, planId),
        sign: (nonce) => { requireCurrent(); const signer = this.signer(); if (!signer) throw new Error("editor_save_identity_missing"); return signer(nonce) },
      }, {
        projectId: this.binding.projectId, rootBindingId: this.binding.rootBindingId, projectRoot: this.binding.rootPath,
        filePath: doc.buffer.path, content: doc.buffer.getText(), expectedSha256: doc.diskHash ?? undefined,
        privateKeyPem: null, hasIdentity: Boolean(this.signer()), bufferVersion: doc.buffer.version,
        operation: doc.operation, onOperation: (operation) => { doc.operation = operation },
      })
      if (result.ok === true) {
        doc.operation = undefined
        doc.diskHash = result.contentSha256
        doc.buffer.confirmSavedContent(result.operation.content)
      } else doc.operation = result.retryable ? result.operation : undefined
      return result
    } finally { doc.saving = false }
  }
}

/** OpenTUI offsets are display cells, while the shared buffer uses UTF-16 offsets and grapheme columns. */
export function captureEditorSelection(doc: EditorDocument, textarea: TextareaRenderable): void {
  const normalized = new EditorBuffer(doc.buffer.path, textarea.plainText)
  const selection = textarea.getSelection()
  const cursor = textarea.cursorOffset
  const head = selection ? cursor === selection.start ? selection.start : selection.end : cursor
  const anchor = selection ? head === selection.start ? selection.end : selection.start : head
  const position = (offset: number) => normalized.positionAt(textarea.getTextRange(0, offset).length)
  doc.buffer.setSelections([{ anchor: position(anchor), head: position(head) }])
}

export function restoreEditorSelection(doc: EditorDocument, textarea: TextareaRenderable): void {
  const { anchor, head } = doc.buffer.primarySelection
  const nativeOffset = (position: typeof head) => {
    const length = doc.buffer.lineGraphemes(position.line).slice(0, position.col).join("").length
    const info = textarea.editorView.getLogicalLineInfo()
    let low = 0, high = info.lineWidthCols[position.line] ?? 0
    // Ask the native editor for its cell boundaries, including its tab/width policy.
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      const prefix = textarea.getTextRangeByCoords(position.line, 0, position.line, middle)
      if (prefix.length <= length) low = middle
      else high = middle - 1
    }
    return textarea.editBuffer.positionToOffset(position.line, low)
  }
  const from = nativeOffset(anchor), to = nativeOffset(head)
  textarea.cursorOffset = to
  if (from !== to) textarea.setSelection(from, to)
  else textarea.clearSelection()
}

function errorCode(error: unknown): string {
  const value = error && typeof error === "object" && "code" in error ? String(error.code) : error instanceof Error ? error.message : "editor_action_failed"
  return /^[a-z][a-z0-9_]{0,100}$/.test(value) ? value : "editor_action_failed"
}

type ExternalImport = { doc: EditorDocument; content: string; version: number; patch: string }

export function FileEditorPanel(props: { path: string; line?: number; column?: number; externalImport?: ExternalImport }) {
  const backend = getBackend(), controller = backend.controller, binding = controller.view.binding
  const dialog = useDialog(), renderer = useRenderer(), dimensions = useTerminalDimensions(), clipboard = useClipboard()
  const config = useTuiConfig(), { theme } = useTheme(), tick = useControllerTick()
  const [revision, refresh] = createSignal(0), [loading, setLoading] = createSignal(false), [message, setMessage] = createSignal("")
  const [target, setTarget] = createSignal<TextareaRenderable>()
  const [externalReview] = createSignal(props.externalImport)
  let attached: EditorDocument | undefined, painting = false, alive = true
  const currentContext = () => Boolean(binding && controller.view.binding && contextKey(binding) === contextKey(controller.view.binding))
  const session = binding ? editorSessionFor(controller, binding) : new EditorSession()
  const editor = binding ? new ManualFileEditor(session, binding, controller.workspace, () => controller.signer, currentContext) : null
  const bump = () => refresh((value) => value + 1)
  const active = createMemo(() => { revision(); return session.current }, undefined, { equals: false })
  const bound = createMemo(() => { tick(); return currentContext() })
  const relative = (doc: EditorDocument) => editor?.relativePath(doc.buffer.path) ?? doc.buffer.path
  const restore = () => dialog.replace(() => <FileEditorPanel path={active() ? relative(active()!) : props.path} />)

  function flush() {
    const textarea = target()
    if (painting || !textarea || textarea.isDestroyed || !attached) return
    applyEditorDisplayText(attached, textarea.plainText)
    captureEditorSelection(attached, textarea)
    session.capture()
    bump()
  }

  function attach(doc = session.current) {
    const textarea = target()
    attached = doc
    if (!textarea || textarea.isDestroyed || !doc) { bump(); return }
    painting = true
    try {
      if (textarea.plainText !== editorDisplayText(doc)) textarea.setText(editorDisplayText(doc))
      restoreEditorSelection(doc, textarea)
      if (currentContext() && !externalReview()) textarea.focus()
    } finally { painting = false }
    bump()
  }

  function showFailure(error: unknown) {
    const code = errorCode(error)
    setMessage(code === "editor_context_changed" ? e("changed") : code === "editor_path_outside_root" ? e("outside") : e("failed", { code }))
  }

  async function open(path: string) {
    if (!editor || !path.trim()) return
    flush(); setLoading(true); setMessage("")
    try {
      const doc = await editor.open(path.trim())
      if (!alive) return
      if (!doc) setMessage(e("missing", { path }))
      else {
        if (props.line && relative(doc) === editor.relativePath(props.path)) {
          doc.buffer.setCursor({ line: Math.max(0, props.line - 1), col: Math.max(0, (props.column ?? 1) - 1) })
          session.capture()
        }
        attach(doc)
      }
    } catch (error) { if (alive) showFailure(error) }
    finally { if (alive) { setLoading(false); bump() } }
  }

  async function save() {
    flush()
    const doc = active()
    if (!editor || !doc) return
    const promise = editor.save(doc)
    bump()
    try {
      const result = await promise
      if (!alive || !currentContext() || !result) return
      if (result.ok === true) {
        const message = e(doc.buffer.modified ? "newer" : "saved", { path: result.relativePath, receipt: result.receiptId.slice(0, 12) })
        setMessage(message); controller.notice("info", message)
      } else {
        const conflict = /conflict|hash_mismatch|preimage/i.test(result.message)
        setMessage(result.code === "editor_save_identity_missing" ? e("identity") : result.code === "editor_run_attention" ? e("attention") : conflict ? e("conflict") : e("failed", { code: result.code }))
        if (result.code === "editor_run_attention" && result.operation?.plan && result.runId) {
          controller.setAttention({ projectId: binding!.projectId, planId: result.operation.plan.id, runId: result.runId, requestId: result.requestId,
            id: result.requestId, type: "file_write", description: e("save"), risk: "medium", conversationRevision: controller.store.conversationRevision })
        }
      }
    } catch (error) { if (alive) showFailure(error) }
    finally { if (alive) bump() }
  }

  async function promptOpen() {
    flush()
    const path = await DialogPrompt.show(dialog, e("open"), { placeholder: e("path") })
    if (path?.trim() && editor) {
      try { const doc = await editor.open(path.trim()); if (!doc) controller.notice("warning", e("missing", { path })); }
      catch (error) { controller.notice("warning", e("failed", { code: errorCode(error) })) }
    }
    restore()
  }

  function buffers() {
    flush()
    dialog.replace(() => <DialogSelect title={e("files")} options={[...session.documents.values()].map((doc) => ({
      title: relative(doc), value: doc.buffer.path, description: e(doc.saving ? "saving" : doc.buffer.modified ? "dirty" : "clean"),
      onSelect: () => { session.activate(doc.buffer.path); restore() },
    }))} />)
  }

  async function find() {
    flush()
    const doc = active()
    if (!doc) return
    const query = await DialogPrompt.show(dialog, e("find_prompt"), { value: session.search })
    if (query) {
      session.search = query
      const selection = doc.buffer.find(query, doc.buffer.range(doc.buffer.primarySelection).to)
      if (selection) { session.rememberJump(); doc.buffer.setSelections([selection]); session.capture() }
      else controller.notice("info", e("not_found", { query }))
    }
    restore()
  }

  async function reviewDisk() {
    flush()
    const doc = active()
    if (!editor || !doc || !currentContext()) return
    try {
      const path = relative(doc)
      const file = await controller.workspace.readProjectFile(editor.binding.projectId, editor.binding.rootBindingId, path)
      if (!alive || !currentContext()) return
      if (!file) { setMessage(e("missing", { path })); return }
      dialog.replace(() => <TextView title={`${e("disk")} · ${path}`} text={file.text} footer={e("drafts")} />)
    } catch (error) { if (alive) showFailure(error) }
  }

  async function discard() {
    flush()
    const doc = active()
    if (!doc || doc.saving || doc.operation) { setMessage(e("external_busy")); return }
    if (doc.buffer.modified) {
      const ok = await DialogConfirm.show(dialog, e("discard"), e("discard_body", { path: relative(doc) }))
      if (!ok) { restore(); return }
    }
    session.closeBuffer(doc.buffer.path, true)
    if (session.current) restore()
    else dialog.clear()
  }

  async function external() {
    flush()
    const doc = active()
    if (!editor || !doc) return
    if (doc.saving || doc.operation) { setMessage(e("external_busy")); return }
    try {
      const found = await findHelix()
      if (!found.binary) { if (alive) setMessage(e("external_missing")); return }
      const original = doc.buffer.getText(), version = doc.buffer.version, binary = found.binary
      const ok = await DialogConfirm.show(dialog, e("external"), e("external_consent", { binary: binary.path }))
      if (!ok || !currentContext()) { restore(); return }
      const result = await launchHelix({ binary, ...editor.binding, projectRoot: editor.binding.rootPath,
        filePath: doc.buffer.path, content: original, line: doc.buffer.primarySelection.head.line + 1, consent: true }, (launch) => {
        renderer.suspend(); renderer.currentRenderBuffer.clear()
        try { return launch() } finally { renderer.currentRenderBuffer.clear(); renderer.resume(); renderer.requestRender() }
      })
      if (!currentContext()) { restore(); return }
      if (result.exitCode !== 0) { controller.notice("warning", e("failed", { code: "editor_external_failed" })); restore(); return }
      if (!result.changed) { controller.notice("info", e("external_unchanged")); restore(); return }
      const patch = createPatch(relative(doc), original, result.content, "", "")
      dialog.replace(() => <FileEditorPanel path={relative(doc)} externalImport={{ doc, content: result.content, version, patch }} />)
    } catch (error) { controller.notice("warning", e("failed", { code: errorCode(error) })); restore() }
  }

  function importExternal() {
    const review = externalReview()
    if (!review) return
    if (!currentContext() || review.doc.buffer.version !== review.version) controller.notice("warning", e("external_stale"))
    else {
      const selections = review.doc.buffer.selections
      review.doc.buffer.applyOffsetChanges([{ from: 0, to: review.doc.buffer.getText().length, insert: review.content }])
      review.doc.buffer.setSelections(selections)
      session.capture()
    }
    restore()
  }

  useBindings(() => ({
    enabled: Boolean(externalReview()), priority: 2,
    bindings: [
      { key: "return", desc: e("import"), cmd: importExternal },
      { key: "escape", desc: e("cancel"), cmd: restore },
    ],
  }))

  useBindings(() => ({
    enabled: !target() && Boolean(binding) && !externalReview(), priority: 2,
    bindings: [
      { key: "f2", desc: e("open"), cmd: () => void promptOpen() },
      { key: "ctrl+o", desc: e("open"), cmd: () => void promptOpen() },
      { key: "f4", desc: e("files"), cmd: buffers },
    ],
  }))

  useBindings(() => ({
    target,
    enabled: Boolean(target()) && !externalReview(),
    priority: 2,
    bindings: [
      { key: "ctrl+s", desc: e("save"), cmd: () => void save() },
      { key: "ctrl+z", desc: e("undo"), cmd: () => { flush(); active()?.buffer.undo(); attach() } },
      { key: "ctrl+y", desc: e("redo"), cmd: () => { flush(); active()?.buffer.redo(); attach() } },
      { key: "ctrl+shift+z", desc: e("redo"), cmd: () => { flush(); active()?.buffer.redo(); attach() } },
      { key: "return", desc: e("title"), cmd: () => { if (bound()) target()?.insertText("\n") } },
      { key: "tab", desc: e("title"), cmd: () => { if (bound()) target()?.insertText("\t") } },
      { key: "ctrl+o", desc: e("open"), cmd: () => void promptOpen() },
      { key: "f2", desc: e("open"), cmd: () => void promptOpen() },
      { key: "ctrl+f", desc: e("find"), cmd: () => void find() },
      { key: "f3", desc: e("find"), cmd: () => void find() },
      { key: "f4", desc: e("files"), cmd: buffers },
      { key: "f6", desc: e("external"), cmd: () => void external() },
      { key: "f8", desc: e("disk"), cmd: () => void reviewDisk() },
      { key: "ctrl+w", desc: e("discard"), cmd: () => void discard() },
      { key: "ctrl+a", desc: e("select_all"), cmd: () => { target()?.selectAll(); flush() } },
      { key: "alt+w", desc: e("select_word"), cmd: () => { flush(); active()?.buffer.selectWord(); attach() } },
      { key: "ctrl+c", desc: e("copy"), cmd: () => { const text = target()?.getSelectedText(); if (text) void clipboard.write?.(text).catch(showFailure); else { flush(); dialog.clear() } } },
      { key: "escape", desc: e("close"), cmd: () => { flush(); dialog.clear() } },
    ],
  }))

  onMount(() => { dialog.setSize("xlarge"); if (!binding || externalReview()) return; if (props.path) void open(props.path); else if (session.current) attach(); else void promptOpen() })
  onCleanup(() => { flush(); alive = false })

  const height = () => Math.max(4, Math.min(28, Math.floor(dimensions().height * 0.7) - 12))
  const documents = createMemo(() => { revision(); return [...session.documents.values()] })
  const position = createMemo(() => { revision(); const buffer = active()?.buffer; return buffer ? e("position", { line: buffer.primarySelection.head.line + 1, column: buffer.primarySelection.head.col + 1, count: buffer.lineCount }) : "" })
  return <box paddingLeft={2} paddingRight={2}>
    <box flexDirection="row" justifyContent="space-between" marginBottom={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>{e("title")}</text>
      <text fg={theme.textMuted} onMouseUp={() => { flush(); dialog.clear() }}>{e("close")} · Esc</text>
    </box>
    <Show when={binding} fallback={<text fg={theme.textMuted}>{e("no_project")}</text>}>
      <Show when={externalReview()} fallback={<>
      <box flexDirection="row" gap={2} marginBottom={1}>
        <text fg={theme.primary} onMouseUp={() => void promptOpen()}>F2 {e("open")}</text>
        <text fg={theme.primary} onMouseUp={buffers}>F4 {e("files")} ({documents().length})</text>
        <text fg={theme.primary} onMouseUp={() => void find()}>F3 {e("find")}</text>
        <text fg={theme.primary} onMouseUp={() => void external()}>F6 {e("external")}</text>
      </box>
      <Show when={message()}><text fg={theme.primary}>{message()}</text></Show>
      <Show when={active()}>
        {(doc) => <>
          <box flexDirection="row" justifyContent="space-between">
            <text fg={theme.text}>{relative(doc())}</text>
            <text fg={doc().buffer.modified ? theme.warning : theme.textMuted}>{e(doc().saving ? "saving" : doc().buffer.modified ? "dirty" : "clean")}</text>
          </box>
          <textarea ref={(value: TextareaRenderable) => { setTarget(value); value.traits = { capture: ["navigate", "submit", "tab"] }; attach() }}
            height={height()} width="100%" wrapMode="none" scrollMargin={2}
            textColor={theme.text} focusedTextColor={theme.text} backgroundColor={theme.backgroundElement}
            cursorColor={theme.text} cursorStyle={config.cursor} selectionBg={theme.primary} selectionFg={theme.selectedListItemText}
            onContentChange={flush} onCursorChange={flush}
            onKeyDown={(event: { preventDefault(): void }) => { if (!bound()) event.preventDefault() }} />
          <text fg={theme.textMuted}>{position()}</text>
          <text fg={theme.textMuted} onMouseUp={() => void reviewDisk()}>F8 {e("disk")}</text>
          <box flexDirection="row" gap={2}>
            <text fg={theme.primary} onMouseUp={() => void save()}>Ctrl+S {doc().operation ? e("reconcile") : e("save")}</text>
            <text fg={theme.textMuted} onMouseUp={() => { flush(); doc().buffer.undo(); attach() }}>Ctrl+Z {e("undo")}</text>
            <text fg={theme.textMuted} onMouseUp={() => { flush(); doc().buffer.redo(); attach() }}>Ctrl+Y {e("redo")}</text>
            <text fg={theme.textMuted} onMouseUp={() => void discard()}>Ctrl+W {e("discard")}</text>
          </box>
        </>}
      </Show>
      <Show when={loading()}><text fg={theme.textMuted}>{e("loading")}</text></Show>
      <Show when={!bound()}><text fg={theme.warning}>{e("changed")}</text></Show>
      </>}>
        {(review) => <>
          <text attributes={TextAttributes.BOLD} fg={theme.text}>{e("external_review")}</text>
          <scrollbox height={height()} scrollAcceleration={getScrollAcceleration(config)}>
            <For each={review().patch.split("\n")}>
              {(line) => <text fg={line.startsWith("+") ? theme.diffHighlightAdded : line.startsWith("-") ? theme.diffHighlightRemoved : theme.text}>{line || " "}</text>}
            </For>
          </scrollbox>
          <box flexDirection="row" gap={2}>
            <text fg={theme.primary} onMouseUp={importExternal}>Enter {e("import")}</text>
            <text fg={theme.textMuted} onMouseUp={restore}>Esc {e("cancel")}</text>
          </box>
        </>}
      </Show>
    </Show>
    <text fg={theme.textMuted}>{e("drafts")}</text>
  </box>
}
