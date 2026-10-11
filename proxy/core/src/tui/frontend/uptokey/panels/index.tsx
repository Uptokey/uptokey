/**
 * Panels opened by Uptokey commands (/projetos, /contexto, /arquivos, /git, /agentes…). Each reads the controller's
 * current view and acts through its methods, so effects keep their plan, approval and receipt.
 */
import { JevPanel } from "./jev.tsx"
import { AccountPanel } from "./account.tsx"
import { DebuggerPanel } from "./debugger.tsx"
import { createMemo, createResource, createSignal, For, Show } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../vendor/opencode-tui/ui/dialog-select"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { TextView } from "../dialogs/text-view.tsx"
import { getBackend } from "../backend/registry.ts"
import { getChildStatusText, getTaskStatusText } from "../../../delegation.ts"
import { ui } from "../i18n.ts"
import { useControllerTick } from "./use-controller.ts"
import { arch, platform, release } from "node:os"
import { connectionText, readUsageRows } from "../integration-connections.ts"
import { contextEntryDescription } from "../../../operation-ui.ts"

function tokens(count: number) {
  return count >= 1000 ? `${(count / 1000).toFixed(1)}k` : String(count)
}

export function ProjectsPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const view = backend.controller.view
    const rows: DialogSelectOption<string>[] = (view.bindingCandidates ?? []).map((candidate) => ({
      title: candidate.projectName,
      value: `${candidate.projectId}:${candidate.rootBindingId}`,
      description: `${candidate.accessMode === "read_only" ? ui("p_read_only") : ui("p_read_write")} · ${candidate.rootBindingId.slice(-8)}`,
      onSelect: () => {
        void backend.controller.chooseBinding(candidate)
        dialog.clear()
      },
    }))
    rows.push({
      title: ui("p_project_link_other"),
      value: "__other__",
      category: view.binding ? ui("p_project_bound", { name: view.binding.projectName, path: view.binding.rootPath }) : ui("p_project_none"),
      description: ui("p_project_exact"),
      onSelect: async () => {
        const path = await DialogPrompt.show(dialog, ui("p_project_link_other"), { placeholder: ui("project_path_prompt") })
        dialog.clear()
        if (path) await backend.controller.rebindProject(path)
      },
    })
    return rows
  })
  return <DialogSelect title={ui("p_project_link_other").replace("…", "")} options={options()} />
}

export function ContextPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const controller = backend.controller
    const dispatch = controller.view.lastDispatch
    const rows: DialogSelectOption<string>[] = [
      {
        title: ui("p_ctx_add"),
        value: "__add__",
        category: dispatch ? ui("p_usage_tokens", { tokens: tokens(dispatch.tokens?.input ?? controller.state.estimatedTokens) }) : ui("p_ctx_title"),
        onSelect: async () => {
          const path = await DialogPrompt.show(dialog, ui("p_ctx_add"), { placeholder: ui("p_ctx_path_prompt") })
          if (path) await controller.addContext(path.trim())
          dialog.replace(() => <ContextPanel />)
        },
      },
    ]
    for (const entry of controller.context.entries()) {
      rows.push({
        title: entry.relativePath,
        value: entry.id,
        description: contextEntryDescription(entry),
        footer: ui("p_ctx_remove"),
        onSelect: () => {
          controller.context.remove(entry.id)
          dialog.replace(() => <ContextPanel />)
        },
      })
    }
    return rows
  })
  return <DialogSelect title={ui("p_ctx_title")} options={options()} emptyView={<text>{ui("p_ctx_empty")}</text>} />
}

export function FilesPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const [query, setQuery] = createSignal("")
  const [files] = createResource(query, (value) => backend.searchPaths(value, 60))
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    (files() ?? []).map((file) => ({
      title: file.path,
      value: file.path,
      description: backend.controller.context.has(file.path) ? ui("p_files_in_context") : undefined,
      onSelect: async () => {
        dialog.clear()
        if (file.type === "file") await backend.controller.addContext(file.path)
        else toast.show({ variant: "info", message: file.path })
      },
    })),
  )
  return (
    <DialogSelect
      title={ui("p_files_title")}
      options={options()}
      skipFilter
      onFilter={setQuery}
      emptyView={<text fg={theme.textMuted}>{ui("p_files_empty")}</text>}
    />
  )
}

export function SkillsPanel() {
  const backend = getBackend()
  const tick = useControllerTick()
  const { theme } = useTheme()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const view = backend.controller.view
    return view.skills.map((skill) => ({
      title: `${view.activeSkills.includes(skill.id) ? "●" : "○"} ${skill.name}`,
      value: skill.id,
      description: skill.description || skill.origin,
      footer: view.activeSkills.includes(skill.id) ? ui("p_skill_active") : undefined,
      onSelect: () => backend.controller.toggleSkill(skill.id),
    }))
  })
  return <DialogSelect title={ui("p_skills_title")} options={options()} emptyView={<text fg={theme.textMuted}>{ui("p_skills_empty")}</text>} />
}

export function BranchesPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const { theme } = useTheme()
  const [items] = createResource(async () => {
    const id = backend.controller.state.activeConversation?.id
    return id ? backend.controller.conversations.branches(id).catch(() => []) : []
  })
  const options = createMemo<DialogSelectOption<string>[]>(() =>
    (items() ?? []).map((branch) => ({
      title: branch.branchId === "main" ? ui("p_branch_main") : branch.branchId.slice(-8),
      value: branch.branchId,
      description: `${ui("p_branch_messages", { count: branch.messages })}${branch.active ? ` · ${ui("p_branch_active")}` : ""}`,
      onSelect: async () => {
        dialog.clear()
        await backend.controller.switchBranch(branch.branchId)
      },
    })),
  )
  return <DialogSelect title={ui("p_branches_title")} options={options()} emptyView={<text fg={theme.textMuted}>{ui("p_branches_title")}</text>} />
}

export function GitPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const tick = useControllerTick()
  const { theme } = useTheme()
  void backend.controller.refreshGit()

  async function showDiff(path: string, staged: boolean) {
    try {
      const diff = await backend.controller.gitDiff(path, staged)
      dialog.replace(() => <TextView title={`${path} · ${staged ? "index" : "worktree"}`} text={diff || "—"} diff />)
    } catch {
      toast.show({ variant: "error", message: ui("p_git_loading") })
    }
  }

  function fileMenu(path: string, staged: boolean) {
    dialog.replace(() => (
      <DialogSelect
        title={path}
        options={[
          { title: ui("p_git_diff"), value: "diff", onSelect: () => void showDiff(path, staged) },
          {
            title: ui("p_git_stage"),
            value: "stage",
            description: ui("p_git_note"),
            onSelect: async () => {
              dialog.clear()
              await backend.controller.gitApply({ kind: "stage", paths: [path] })
            },
          },
          {
            title: ui("p_git_unstage"),
            value: "unstage",
            description: ui("p_git_note"),
            onSelect: async () => {
              dialog.clear()
              await backend.controller.gitApply({ kind: "unstage", paths: [path] })
            },
          },
        ]}
      />
    ))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const git = backend.controller.view.git
    if (!git || !git.repository) return []
    const rows: DialogSelectOption<string>[] = git.entries
      .filter((entry) => entry.kind !== "ignored")
      .map((entry) => {
        const code = entry.kind === "untracked" ? "??" : `${entry.index === "." ? " " : entry.index}${entry.worktree === "." ? " " : entry.worktree}`
        return {
          title: entry.origPath ? `${entry.origPath} → ${entry.path}` : entry.path,
          value: entry.path,
          description: code,
          onSelect: () => fileMenu(entry.path, entry.index !== "."),
        }
      })
    rows.push({
      title: ui("p_git_commit"),
      value: "__commit__",
      category: ui("p_git_note"),
      onSelect: async () => {
        const message = await DialogPrompt.show(dialog, ui("p_git_commit_prompt"), { placeholder: ui("p_git_commit_prompt") })
        dialog.clear()
        if (message?.trim()) await backend.controller.gitApply({ kind: "commit", message: message.trim() })
      },
    })
    return rows
  })

  const title = createMemo(() => {
    tick()
    const git = backend.controller.view.git
    return ui("p_git_title", { branch: git?.branch ?? "HEAD" })
  })
  const empty = createMemo(() => {
    tick()
    const git = backend.controller.view.git
    return !git ? ui("p_git_loading") : !git.repository ? ui("p_git_not_repo") : ui("p_git_clean")
  })
  return <DialogSelect title={title()} options={options()} emptyView={<text fg={theme.textMuted}>{empty()}</text>} />
}

export function TasksPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const tick = useControllerTick()
  const { theme } = useTheme()
  void backend.controller.refreshTasks()
  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const rows: DialogSelectOption<string>[] = []
    for (const { task, labels } of backend.controller.view.tasks) {
      const active = !["succeeded", "cancelled", "expired"].includes(task.status)
      rows.push({
        title: task.objective.replace(/\s+/g, " "),
        value: task.id,
        category: `${getTaskStatusText(task.status)}${task.blockedReason ? ` (${task.blockedReason})` : ""}`,
        description: `${task.children.length}`,
        onSelect: () => {
          dialog.replace(() => (
            <DialogSelect
              title={task.objective.replace(/\s+/g, " ")}
              options={[
                ...(active ? [{ title: ui("p_task_cancel"), value: "cancel", onSelect: async () => { dialog.clear(); await backend.controller.cancelTask(task.id) } }] : []),
                ...(task.status === "ready" ? [{ title: ui("p_task_resume"), value: "resume", onSelect: async () => { dialog.clear(); await backend.controller.resumeTask(task.id) } }] : []),
                ...task.children.map((child, index) => ({
                  title: labels[index]?.label ?? `${index + 1} · ${child.planId.slice(0, 8)}`,
                  value: `child-${index}`,
                  description: `${getChildStatusText(child.status) ?? child.status}${labels[index]?.model ? ` · ${labels[index]!.model}` : ""}`,
                })),
              ]}
            />
          ))
        },
      })
    }
    return rows
  })
  return <DialogSelect title={ui("p_tasks_title")} options={options()} emptyView={<text fg={theme.textMuted}>{ui("p_tasks_empty")}</text>} />
}

export function UsagePanel() {
  const backend = getBackend()
  const controller = backend.controller
  const dialog = useDialog()
  const tick = useControllerTick()
  const { theme } = useTheme()
  const [usage, { refetch }] = createResource(async () => {
    try { return readUsageRows(await controller.client.getUsage()) } catch { return null }
  })
  const money = (micros: number | null | undefined) => (micros === null || micros === undefined ? "—" : `US$ ${(micros / 1_000_000).toFixed(4)}`)
  const lines = createMemo(() => {
    tick()
    const budget = controller.view.budget
    return [
      ui("p_usage_tokens", { tokens: tokens(controller.state.estimatedTokens) }),
      ui("p_usage_cost", { cost: controller.state.sessionCost.toFixed(4) }),
      budget && budget.limitMicros !== null
        ? ui("p_usage_budget", { limit: money(budget.limitMicros), spent: money(budget.spentMicros), reserved: money(budget.reservedMicros) })
        : ui("p_usage_no_budget"),
      usage.loading ? connectionText("loading") : usage() === null || usage() === undefined ? connectionText("unavailable") : connectionText("usage_total", { tokens: tokens(usage()!.reduce((sum, row) => sum + row.totalTokens, 0)) }),
    ]
  })
  const details = () => [
    ...lines(), "", connectionText("usage_scope"),
    ...(usage() ?? []).flatMap((row) => ["", row.provider, connectionText("usage_provider", {
      input: row.inputTokens, output: row.outputTokens, reported: row.responsesWithUsage,
      unreported: row.responsesWithoutUsage, interrupted: row.interruptedResponses, active: row.responsesInFlight,
    })]),
  ].join("\n")
  return <DialogSelect title={ui("p_usage_title")} titleView={<box flexDirection="column"><For each={lines()}>{line => <text fg={theme.text}>{line}</text>}</For></box>} renderFilter={false} options={[
    { title: connectionText("details"), value: "details", onSelect: () => dialog.replace(() => <TextView title={ui("p_usage_title")} text={details()} />) },
    { title: connectionText("refresh"), value: "refresh", onSelect: () => { void refetch() } },
  ]} />
}

export function DoctorPanel() {
  const backend = getBackend()
  const controller = backend.controller
  const dialog = useDialog()
  const tick = useControllerTick()
  const { theme } = useTheme()
  const [health, { refetch }] = createResource(() => controller.client.health())
  const summary = createMemo(() => {
    tick()
    return health.loading ? connectionText("loading") : health()?.status === "ok" && controller.state.connection === "authenticated" ? connectionText("ready") : connectionText("attention")
  })
  const details = () => {
    tick()
    const state = controller.state
    const destination = controller.client.getSelectedDestination()
    return [
      summary(),
      connectionText("core", { version: health()?.version || state.coreVersion || "—", url: controller.client.url }),
      ui("p_doctor_destination", { destination: `${destination.providerId ?? ui("p_none")} · ${state.selectedModel || ui("p_none")}` }),
      ui("p_doctor_project", { project: controller.view.binding ? `${controller.view.binding.projectName} (${controller.view.binding.rootPath})` : ui("p_none") }),
      ui("p_doctor_identity", { state: controller.view.signerAvailable ? ui("p_yes") : ui("p_no") }),
      connectionText("host", { platform: platform(), arch: arch(), release: release() }),
      connectionText("runtime", { runtime: typeof Bun === "undefined" ? `Node.js ${process.versions.node}` : `Bun ${Bun.version}` }),
    ].join("\n")
  }
  return <DialogSelect title={ui("p_doctor_title")} titleView={<text fg={theme.text}>{summary()}</text>} renderFilter={false} options={[
    { title: connectionText("details"), value: "details", onSelect: () => dialog.replace(() => <TextView title={ui("p_doctor_title")} text={details()} />) },
    { title: connectionText("refresh"), value: "refresh", onSelect: () => { void refetch() } },
  ]} />
}

export const PANEL_COMPONENTS: Record<string, (arg?: string) => unknown> = {
  account: () => <AccountPanel />,
  projects: () => <ProjectsPanel />,
  context: () => <ContextPanel />,
  files: () => <FilesPanel />,
  skills: () => <SkillsPanel />,
  branches: () => <BranchesPanel />,
  git: () => <GitPanel />,
  agents: () => <TasksPanel />,
  usage: () => <UsagePanel />,
  doctor: () => <DoctorPanel />,
  jev: () => <JevPanel />,
  debugger: () => <DebuggerPanel />,
}

export { For, Show }
