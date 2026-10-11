/**
 * /depurar — the Node debugger (js-debug over DAP) started by the controller after the person confirmed the
 * prepared session. Shows the real adapter state: stop reason, stack, variables of the selected frame, breakpoints
 * and program output; every action is a DAP request through the controller's DebuggerClient.
 */
import { createMemo } from "solid-js"
import { isAbsolute, relative } from "node:path"
import { DialogSelect, type DialogSelectOption, type DialogSelectRef } from "../../vendor/opencode-tui/ui/dialog-select"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"
import { useControllerTick } from "./use-controller.ts"

export function DebuggerPanel() {
  const backend = getBackend()
  const dialog = useDialog()
  const toast = useToast()
  const tick = useControllerTick(100)
  const client = () => backend.controller.features.debugger
  // Paths inside the project are shown relative to it: the absolute root says nothing the footer does not.
  const shown = (path: string | undefined) => {
    const debug = client()
    if (!path || !debug) return path ?? "?"
    const rel = relative(debug.prepared.rootPath, path)
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : path
  }

  let select: DialogSelectRef<string> | undefined

  async function act(name: string, run: () => Promise<unknown>) {
    // An action chosen through the filter clears it, so the new state (location, variables) is visible again.
    if (select?.filter) dialog.replace(() => <DebuggerPanel />)
    try {
      await run()
    } catch (error) {
      toast.show({ variant: "error", message: ui("dbg_action_failed", { action: name, reason: error instanceof Error ? error.message : String(error) }) })
    }
  }

  async function addBreakpoint() {
    const value = await DialogPrompt.show(dialog, ui("dbg_breakpoint_title"), { placeholder: "src/app.js:12" })
    dialog.replace(() => <DebuggerPanel />)
    const match = /^(.+):(\d+)$/.exec((value ?? "").trim())
    const debug = client()
    if (!match || !debug) return
    const path = match[1]!
    const line = Number(match[2])
    const current = (debug.snapshot.breakpoints[path] ?? []).map((item) => item.line).filter((item): item is number => typeof item === "number")
    await act(ui("dbg_breakpoint_title"), () => debug.setBreakpoints(path, [...current, line]))
  }

  const options = createMemo<DialogSelectOption<string>[]>(() => {
    tick()
    const debug = client()
    if (!debug) return [{ title: ui("dbg_not_started"), value: "none", description: ui("dbg_usage"), onSelect: () => dialog.clear() }]
    const snap = debug.snapshot
    const top = snap.frames.find((frame) => frame.id === snap.frameId) ?? snap.frames[0]
    const where = top ? `${shown(top.source?.path ?? top.source?.name)}:${top.line}` : "—"
    const state = ui(`dbg_state_${snap.state}`)
    const rows: DialogSelectOption<string>[] = [
      {
        title: `${state}${snap.reason ? ` · ${snap.reason}` : ""}${snap.state === "stopped" ? ` · ${where}` : ""}`,
        value: "status",
        category: ui("dbg_title"),
        ...(snap.error ? { description: snap.error } : {}),
        onSelect: () => void act("refresh", () => debug.refreshStopped()),
      },
    ]
    // When paused, the variables of the selected frame come first: that is what the stop is for.
    for (const scope of snap.scopes.filter((item) => !item.expensive)) {
      for (const variable of (snap.variables[scope.variablesReference] ?? []).slice(0, 40)) {
        rows.push({
          title: `${variable.name} = ${variable.value}`.slice(0, 120),
          value: `var:${scope.variablesReference}:${variable.name}`,
          ...(variable.type && variable.type !== variable.value ? { description: variable.type } : {}),
          category: `${ui("dbg_variables")} · ${scope.name}`,
          onSelect: () => (variable.variablesReference ? void act("variables", () => debug.variables(variable.variablesReference)) : undefined),
        })
      }
    }
    const stopped = snap.state === "stopped"
    const action = (value: string, title: string, run: () => Promise<unknown>, enabled = true): DialogSelectOption<string>[] =>
      enabled ? [{ title, value, category: ui("dbg_actions"), onSelect: () => void act(title, run) }] : []
    rows.push(
      ...action("continue", ui("dbg_continue"), () => debug.continue(), stopped),
      ...action("next", ui("dbg_next"), () => debug.next(), stopped),
      ...action("in", ui("dbg_step_in"), () => debug.stepIn(), stopped),
      ...action("out", ui("dbg_step_out"), () => debug.stepOut(), stopped),
      ...action("pause", ui("dbg_pause"), () => debug.pause(), snap.state === "running"),
      { title: ui("dbg_breakpoint_add"), value: "breakpoint", category: ui("dbg_actions"), onSelect: () => void addBreakpoint() },
      ...action("stop", ui("dbg_stop"), () => debug.stop(), !["terminated", "failed", "idle"].includes(snap.state)),
    )
    // Program output comes before breakpoints and the stack: blank lines carry nothing on a list.
    for (const [index, line] of snap.output.filter((item) => item.trim()).slice(-8).entries()) {
      rows.push({ title: line.slice(0, 120), value: `out:${index}`, category: ui("dbg_output") })
    }
    for (const [path, list] of Object.entries(snap.breakpoints)) {
      for (const item of list) {
        rows.push({ title: `${shown(path)}:${item.line ?? "?"}`, value: `bp:${path}:${item.line}`, description: item.verified ? ui("dbg_verified") : (item.message ?? ui("dbg_unverified")), category: ui("dbg_breakpoints") })
      }
    }
    for (const frame of snap.frames.slice(0, 12)) {
      rows.push({
        title: `${frame.id === snap.frameId ? "› " : "  "}${frame.name}`,
        value: `frame:${frame.id}`,
        description: `${shown(frame.source?.path ?? frame.source?.name)}:${frame.line}`,
        category: ui("dbg_stack"),
        onSelect: () => void act("frame", () => debug.selectFrame(frame.id)),
      })
    }
    return rows
  })

  // The keys every debugger uses (VS Code, Visual Studio, Chrome DevTools): F5 continue, F10 next line,
  // F11 into, Shift+F11 out, F9 breakpoint, Shift+F5 stop. They act without leaving the list.
  const when = (states: string[], name: string, run: (debug: NonNullable<ReturnType<typeof client>>) => Promise<unknown>) => () => {
    const debug = client()
    if (debug && states.includes(debug.snapshot.state)) void act(name, () => run(debug))
  }
  const bindings = [
    { key: "f5", desc: ui("dbg_continue"), group: "Dialog", cmd: when(["stopped"], ui("dbg_continue"), (debug) => debug.continue()) },
    { key: "f10", desc: ui("dbg_next"), group: "Dialog", cmd: when(["stopped"], ui("dbg_next"), (debug) => debug.next()) },
    { key: "f11", desc: ui("dbg_step_in"), group: "Dialog", cmd: when(["stopped"], ui("dbg_step_in"), (debug) => debug.stepIn()) },
    { key: "shift+f11", desc: ui("dbg_step_out"), group: "Dialog", cmd: when(["stopped"], ui("dbg_step_out"), (debug) => debug.stepOut()) },
    { key: "shift+f5", desc: ui("dbg_stop"), group: "Dialog", cmd: when(["starting", "running", "stopped"], ui("dbg_stop"), (debug) => debug.stop()) },
    { key: "f9", desc: ui("dbg_breakpoint_add"), group: "Dialog", cmd: () => void addBreakpoint() },
  ]
  const footerHints = [
    { label: "F5", title: ui("dbg_key_continue") },
    { label: "F10", title: ui("dbg_key_next") },
    { label: "F11", title: ui("dbg_key_in") },
    { label: "⇧F11", title: ui("dbg_key_out") },
    { label: "F9", title: ui("dbg_key_breakpoint") },
  ]

  return <DialogSelect title={ui("dbg_title")} options={options()} bindings={bindings} footerHints={footerHints} ref={(ref) => (select = ref)} />
}
