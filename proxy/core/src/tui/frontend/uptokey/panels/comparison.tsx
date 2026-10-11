/**
 * Compare or delegate across models: pick 2–8 exact (connection, model) pairs, an objective, a USD cap and — when
 * delegating — one subtask per model. The controller turns this into a plan that still needs the person's approval.
 */
import { createSignal, createMemo } from "solid-js"
import { DialogSelect, type DialogSelectOption } from "../../vendor/opencode-tui/ui/dialog-select"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { useDialog, type DialogContext } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"
import { comparisonCandidates, type ComparisonCandidate } from "../../../connections.ts"

type Candidate = ComparisonCandidate

function candidates(): Candidate[] {
  return comparisonCandidates(getBackend().controller.view.connections)
}

export function ComparisonPanel(props: { delegate: boolean; objective?: string }) {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const all = candidates()
  const [selected, setSelected] = createSignal<readonly string[]>([])

  async function collect(host: DialogContext) {
    const chosen = all.filter((entry) => selected().includes(entry.key))
    // Order of selection is the order of subtasks when delegating.
    const ordered = selected().flatMap((key) => chosen.filter((entry) => entry.key === key))
    if (ordered.length < 2) {
      toast.show({ variant: "warning", message: ui("cmp_invalid") })
      return
    }
    const objective = await DialogPrompt.show(host, props.delegate ? ui("cmp_title_delegate") : ui("cmp_title_compare"), {
      placeholder: ui("cmp_objective"),
      value: props.objective ?? "",
    })
    if (!objective?.trim()) return
    const budget = await DialogPrompt.show(host, ui("cmp_budget"), { placeholder: "0.50" })
    const dollars = Number((budget ?? "").trim().replace(",", "."))
    if (!/^\d+(?:[.,]\d{1,6})?$/.test((budget ?? "").trim()) || !Number.isFinite(dollars) || dollars <= 0) {
      toast.show({ variant: "warning", message: ui("cmp_invalid") })
      return
    }
    let tasks: string[] = []
    if (props.delegate) {
      const text = await DialogPrompt.show(host, ui("cmp_tasks"), { placeholder: "a | b" })
      tasks = (text ?? "").split("|").map((task) => task.trim())
      if (tasks.length !== ordered.length || tasks.some((task) => !task)) {
        toast.show({ variant: "warning", message: ui("cmp_tasks_invalid") })
        return
      }
    }
    host.clear()
    await backend.controller.features.compare(
      {
        objective: objective.trim(),
        members: ordered.map((entry, index) => ({ modelId: entry.modelId, connectionId: entry.connectionId, ...(props.delegate ? { task: tasks[index]! } : {}) })),
        maxCostMicros: String(Math.round(dollars * 1_000_000)),
      },
      props.delegate,
    )
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => [
    {
      title: ui("cmp_continue"),
      value: "__continue__",
      description: ui("cmp_pick_models"),
      category: ui("cmp_selected_count", { count: selected().length }),
      onSelect: () => void collect(dialog),
    },
    ...all.map((entry) => ({
      title: `${selected().includes(entry.key) ? "☑" : "☐"} ${entry.modelId}`,
      value: entry.key,
      description: entry.label,
      onSelect: () => {
        setSelected((current) => (current.includes(entry.key) ? current.filter((key) => key !== entry.key) : current.length < 8 ? [...current, entry.key] : current))
      },
    })),
  ])

  return (
    <DialogSelect
      title={props.delegate ? ui("cmp_title_delegate") : ui("cmp_title_compare")}
      options={options()}
      preserveSelection
      emptyView={<text fg={theme.textMuted}>{ui("cmp_no_models")}</text>}
    />
  )
}
