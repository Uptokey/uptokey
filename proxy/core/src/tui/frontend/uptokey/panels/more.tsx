/**
 * Panels that the previous interface had and the new frontend still lacked: /recursos, /versoes, /hooks, /artefatos,
 * /buscar, /aprovacoes, /recuperar, /revisar and /editar. Each one reads the controller's real state and acts only
 * through the controller (plans, approvals, receipts); nothing here writes files or decides an effect by itself.
 */
import { createMemo, createResource, createSignal } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../vendor/opencode-tui/ui/dialog-select"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { DialogConfirm } from "../../vendor/opencode-tui/ui/dialog-confirm"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { TextView } from "../dialogs/text-view.tsx"
import { getBackend } from "../backend/registry.ts"
import { COMMANDS, runCommand } from "../../../commands.ts"
import { ui } from "../i18n.ts"
import { intlLocale } from "../tr.ts"
import { useControllerTick } from "./use-controller.ts"
import { FileEditorPanel } from "./file-editor.tsx"

const when = (iso: string) => {
  const date = new Date(iso)
  return Number.isNaN(date.getTime()) ? iso : date.toLocaleString(intlLocale())
}
const size = (bytes: number) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : bytes >= 1024 ? `${(bytes / 1024).toFixed(1)} kB` : `${bytes} B`)
const reason = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** /recursos — every capability command, run directly or prefilled when it needs an argument. */
export function CapabilitiesPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    COMMANDS.filter((command) => command.id.startsWith("features.") && command.id !== "features.menu").map((command) => ({
      title: command.title,
      value: command.id,
      description: `/${command.slash[0]}${command.arg ? ` ${command.arg}` : ""}`,
      onSelect: () => {
        dialog.clear()
        if (command.arg) backend.appendToPrompt(`/${command.slash[0]} `)
        else void backend.runUptokeyCommand(command)
      },
    })),
  )
  return <DialogSelect title={ui("pnl_caps_title")} options={options()} />
}

/** /versoes <arquivo> — earlier versions kept by the canonical writer; restoring is a new reviewed operation. */
export function VersionsPanel(props: { path: string }) {
  const backend = getBackend()
  const dialog = useDialog()
  const [items] = createResource(() => props.path, (path) => backend.controller.listVersions(path))
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (!props.path) return [{ title: ui("pnl_versions_usage"), value: "usage", onSelect: () => dialog.clear() }]
    if (items.error) return [{ title: ui("pnl_files_failed", { reason: reason(items.error) }), value: "error", onSelect: () => dialog.clear() }]
    if (items.loading) return [{ title: ui("pnl_loading"), value: "loading", onSelect: () => undefined }]
    const list = items() ?? []
    if (!list.length) return [{ title: ui("pnl_versions_none"), value: "none", onSelect: () => dialog.clear() }]
    return list.map((item) => ({
      title: when(item.createdAt),
      value: item.operationId,
      description: item.operationId.slice(0, 12),
      onSelect: async () => {
        const ok = await DialogConfirm.show(dialog, ui("pnl_versions_restore_title", { path: props.path }), ui("pnl_versions_restore_body", { when: when(item.createdAt) }))
        dialog.clear()
        if (ok) await backend.controller.restoreVersion(props.path, item.operationId)
      },
    }))
  })
  return <DialogSelect title={ui("pnl_versions_title", { path: props.path || "—" })} options={options()} />
}

/** /hooks — the repository's hooks exactly as they will run, what was refused, and the trust decision. */
export function HooksPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const defs = backend.controller.hookDefinitions()
    if (!defs || (!defs.hooks.length && !defs.rejected.length)) return [{ title: ui("pnl_hooks_none"), value: "none", onSelect: () => dialog.clear() }]
    const rows: DialogSelectOption<string>[] = defs.hooks.map((hook, index) => ({
      title: hook.argv.join(" "),
      value: `hook:${index}`,
      description: `${hook.phase}${hook.blocking ? ` · ${ui("pnl_hooks_blocking")}` : ""}${hook.match ? ` · ${hook.match}` : ""}`,
      category: `${ui("pnl_hooks_title")} · ${defs.trusted ? ui("pnl_hooks_trusted") : ui("pnl_hooks_untrusted")}`,
      onSelect: () => undefined,
    }))
    for (const rejected of defs.rejected) {
      rows.push({ title: rejected.index >= 0 ? `#${rejected.index + 1}` : "—", value: `rejected:${rejected.index}`, description: rejected.reason, category: ui("pnl_hooks_rejected"), onSelect: () => undefined })
    }
    if (defs.hooks.length && !defs.trusted) {
      rows.push({
        title: ui("pnl_hooks_trust", { hash: defs.hash.slice(0, 12) }),
        value: "trust",
        category: ui("pnl_actions"),
        onSelect: () => void backend.controller.trustReviewedHooks(defs.hash),
      })
    }
    if (defs.trusted) rows.push({ title: ui("pnl_hooks_revoke"), value: "revoke", category: ui("pnl_actions"), onSelect: () => void backend.controller.revokeHooks() })
    return rows
  })
  return <DialogSelect title={ui("pnl_hooks_title")} options={options()} />
}

/** /artefatos — outputs recorded by runs: text is shown here, anything can be saved into the project. */
export function ArtifactsPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const tick = useControllerTick()
  void backend.controller.refreshArtifacts().catch((error) => toast.show({ variant: "error", message: ui("pnl_art_read_failed", { reason: reason(error) }) }))
  async function save(id: string, suggested: string) {
    const target = await DialogPrompt.show(dialog, ui("pnl_art_save_prompt"), { value: suggested, placeholder: suggested })
    dialog.clear()
    if (target?.trim()) await backend.controller.saveArtifact(id, target.trim())
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const view = backend.controller.view
    if (!view.artifacts.length) return [{ title: ui("pnl_art_none"), value: "none", onSelect: () => dialog.clear() }]
    const rows: DialogSelectOption<string>[] = view.artifacts.map((artifact) => {
      const name = artifact.filename ?? `artifact-${artifact.id.slice(0, 8)}`
      const text = artifact.mediaType.startsWith("text/") || artifact.mediaType === "application/json"
      return {
        title: name,
        value: artifact.id,
        description: `${artifact.mediaType} · ${size(artifact.byteLength)} · ${when(artifact.createdAt)}`,
        onSelect: async () => {
          if (!text) return void save(artifact.id, name)
          try {
            const content = await backend.controller.readTextArtifact(artifact.id)
            dialog.replace(() => <TextView title={name} text={content} footer={ui("pnl_art_save_hint")} />)
          } catch (error) {
            toast.show({ variant: "error", message: ui("pnl_art_read_failed", { reason: reason(error) }) })
          }
        },
      }
    })
    rows.push(...view.artifacts.map((artifact) => ({ title: ui("pnl_art_save", { name: artifact.filename ?? artifact.id.slice(0, 8) }), value: `save:${artifact.id}`, category: ui("pnl_actions"), onSelect: () => void save(artifact.id, artifact.filename ?? `artifact-${artifact.id.slice(0, 8)}`) })))
    if (view.artifactsNextCursor) rows.push({ title: ui("pnl_art_more"), value: "more", category: ui("pnl_actions"), onSelect: () => void backend.controller.refreshArtifacts({ more: true }).catch((error) => toast.show({ variant: "error", message: ui("pnl_art_read_failed", { reason: reason(error) }) })) })
    return rows
  })
  return <DialogSelect title={ui("pnl_art_title")} options={options()} />
}

/** /buscar — search across the person's conversations (the core searches; results open the conversation). */
export function SearchPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const [query, setQuery] = createSignal("")
  const [results] = createResource(query, async (text) => (text.trim().length >= 2 ? backend.controller.conversations.search(text.trim()) : []))
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (query().trim().length < 2) return [{ title: ui("pnl_search_hint"), value: "hint", onSelect: () => undefined }]
    if (results.error) return [{ title: ui("pnl_files_failed", { reason: reason(results.error) }), value: "error", onSelect: () => undefined }]
    if (results.loading) return [{ title: ui("pnl_loading"), value: "loading", onSelect: () => undefined }]
    const list = results() ?? []
    if (!list.length) return [{ title: ui("pnl_search_none", { query: query().trim() }), value: "none", onSelect: () => undefined }]
    return list.map((hit) => ({
      title: hit.preview.replace(/\s+/g, " ").slice(0, 110),
      value: hit.messageId,
      description: hit.conversationId.slice(0, 12),
      onSelect: () => {
        dialog.clear()
        void backend.openConversation(hit.conversationId)
      },
    }))
  })
  return <DialogSelect title={ui("pnl_search_title")} options={options()} skipFilter onFilter={(text) => setQuery(text)} placeholder={ui("pnl_search_placeholder")} />
}

/** /aprovacoes — pending requests bound to verified plans; approving still signs W5 and records a receipt. */
export function ApprovalsPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const approvals = backend.controller.view.approvals
    if (!approvals.length) return [{ title: ui("pnl_appr_none"), value: "none", onSelect: () => dialog.clear() }]
    return approvals.flatMap((request) => [
      { title: request.description, value: `info:${request.id}`, description: request.riskSummary || request.detail || "", category: request.tool || request.type, onSelect: () => undefined },
      { title: ui("pnl_appr_approve"), value: `ok:${request.id}`, category: request.tool || request.type, onSelect: () => void backend.permissionReply(request.id, "once") },
      { title: ui("pnl_appr_reject"), value: `no:${request.id}`, category: request.tool || request.type, onSelect: () => void backend.permissionReply(request.id, "reject") },
    ])
  })
  return <DialogSelect title={ui("pnl_appr_title")} options={options()} />
}

/** /recuperar — an uncertain run: the core's review first, then keep it stopped or prepare a retry (a new W5). */
export function AttentionPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const attention = backend.controller.view.attention
  const [review] = createResource(() => attention, (current) => backend.controller.workspace.reviewRunAttention(current.projectId, current.planId, current.runId))
  async function decide(action: "keep_stopped" | "retry") {
    const current = review()
    if (!attention || !current) return
    if (action === "retry" && current.write?.entries.some((entry) => entry.state === "conflict")) {
      toast.show({ variant: "warning", message: ui("pnl_att_conflict") })
      return
    }
    const ok = await DialogConfirm.show(dialog, ui("pnl_att_title"), action === "retry" ? ui("pnl_att_confirm_retry") : ui("pnl_att_confirm_keep"))
    if (!ok) return void dialog.replace(() => <AttentionPanel />)
    try {
      await backend.controller.workspace.resolveRunAttention(attention.projectId, attention.runId, { action, ...(current.write ? { expectedRunRevision: current.write.expectedRunRevision, reviewDigest: current.write.digest } : {}) })
      backend.controller.setAttention(null)
      dialog.clear()
      toast.show({ variant: "info", message: ui("pnl_att_done") })
    } catch (error) {
      toast.show({ variant: "error", message: ui("pnl_att_failed", { reason: reason(error) }) })
    }
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (!attention) return [{ title: ui("pnl_att_none"), value: "none", onSelect: () => dialog.clear() }]
    if (review.loading) return [{ title: ui("pnl_att_loading"), value: "loading", onSelect: () => undefined }]
    if (review.error) return [{ title: ui("pnl_att_review_failed", { reason: reason(review.error) }), value: "error", onSelect: () => dialog.clear() }]
    const current = review()
    const rows: DialogSelectOption<string>[] = [
      ...(current?.view.receipts ?? []).map((receipt) => ({ title: ui("pnl_att_receipt", { id: receipt.id.slice(0, 12), status: receipt.status }), value: `r:${receipt.id}`, category: ui("pnl_att_state"), onSelect: () => undefined })),
      ...(current?.write?.entries ?? []).map((entry, index) => ({ title: `${entry.path}: ${entry.state}`, value: `w:${index}`, category: ui("pnl_att_state"), onSelect: () => undefined })),
      { title: ui("pnl_att_keep"), value: "keep", category: ui("pnl_actions"), onSelect: () => void decide("keep_stopped") },
      { title: ui("pnl_att_retry"), value: "retry", category: ui("pnl_actions"), onSelect: () => void decide("retry") },
    ]
    return rows
  })
  return <DialogSelect title={ui("pnl_att_title_run", { run: attention?.runId.slice(0, 12) ?? "—" })} options={options()} />
}

/** /revisar — shows the pending change proposal again (the same review the answer opened). */
export function ReviewPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  dialog.clear()
  if (!backend.controller.view.proposal && !backend.controller.view.approvals.length) toast.show({ variant: "info", message: ui("pnl_review_none") })
  else backend.showPendingDecisions()
  return <box />
}

/** /edit <file> — direct local buffers; Save uses the shared signed plan and receipt protocol. */
export function EditorPanel(props: { path: string }) { return <FileEditorPanel path={props.path} /> }

/** /arquivos-chat — files and artifacts named in this conversation: view, copy content or path, save into the project. */
export function ChatFilesPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const [refs] = createResource(() => backend.controller.chatFileReferences())
  const label = (ref: Awaited<ReturnType<typeof backend.controller.chatFileReferences>>[number]) => (ref.kind === "project-file" ? ref.path : ref.filename)
  async function act(run: () => Promise<unknown>) {
    try {
      await run()
    } catch (error) {
      toast.show({ variant: "error", message: ui("pnl_files_failed", { reason: reason(error) }) })
    }
  }
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    if (refs.error) return [{ title: ui("pnl_files_failed", { reason: reason(refs.error) }), value: "error", onSelect: () => dialog.clear() }]
    if (refs.loading) return [{ title: ui("pnl_loading"), value: "loading", onSelect: () => undefined }]
    const list = refs() ?? []
    if (!list.length) return [{ title: ui("pnl_files_none"), value: "none", onSelect: () => dialog.clear() }]
    return list.flatMap((ref, index) => {
      const name = label(ref)
      return [
        {
          title: ui("pnl_files_view"),
          value: `view:${index}`,
          category: name,
          onSelect: () =>
            void act(async () => {
              const value = await backend.controller.readChatFile(ref)
              dialog.replace(() => <TextView title={value.path} text={value.text ?? ui("pnl_files_binary")} />)
            }),
        },
        { title: ui("pnl_files_copy_content"), value: `copy:${index}`, category: name, onSelect: () => void act(() => backend.controller.copyChatFile(ref, "content")) },
        { title: ui("pnl_files_copy_path"), value: `path:${index}`, category: name, onSelect: () => void act(() => backend.controller.copyChatFile(ref, "path")) },
        {
          title: ui("pnl_files_save"),
          value: `save:${index}`,
          category: name,
          onSelect: () =>
            void act(async () => {
              const target = await DialogPrompt.show(dialog, ui("pnl_art_save_prompt"), { value: name, placeholder: name })
              dialog.clear()
              if (target?.trim()) await backend.controller.saveChatFile(ref, target.trim())
            }),
        },
      ]
    })
  })
  return <DialogSelect title={ui("pnl_files_title")} options={options()} />
}

export const MORE_PANELS: Record<string, (arg?: string) => unknown> = {
  capabilities: () => <CapabilitiesPanel />,
  versions: (arg) => <VersionsPanel path={arg ?? ""} />,
  hooks: () => <HooksPanel />,
  artifacts: () => <ArtifactsPanel />,
  search: () => <SearchPanel />,
  approvals: () => <ApprovalsPanel />,
  attention: () => <AttentionPanel />,
  review: () => <ReviewPanel />,
  editor: (arg) => <EditorPanel path={arg ?? ""} />,
  "file-actions": () => <ChatFilesPanel />,
  locations: () => <LocationsPanel />,
}

/** /referencias, /definicao — locations from the language server with the line text; Enter shows the file. */
export function LocationsPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const result = backend.controller.view.lspLocations
    if (!result?.items.length) return [{ title: ui("pnl_loading"), value: "none", onSelect: () => dialog.clear() }]
    return result.items.map((item, index) => ({
      title: `${item.path}:${item.line}:${item.column}`,
      value: `${index}`,
      description: item.preview,
      onSelect: () => dialog.replace(() => <EditorPanel path={item.path} />),
    }))
  })
  const title = createMemo(() => {
    tick()
    const result = backend.controller.view.lspLocations
    return result ? ui(result.kind === "references" ? "pnl_loc_references" : "pnl_loc_definition", { target: result.target, count: result.items.length }) : ""
  })
  return <DialogSelect title={title()} options={options()} />
}
