/**
 * Transcript renderers for Uptokey's own parts: notices, change proposals, runs and delegated tasks. They use the
 * same InlineTool/BlockTool frames as the vendored tool displays so spacing, selection and copy behave identically.
 */
import { createMemo, For, Show } from "solid-js"
import type { ToolPart } from "@opencode-ai/sdk/v2"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { BlockTool, InlineTool } from "../../vendor/opencode-tui/routes/session/index"
import { ui } from "../i18n.ts"

type Props = { input: Record<string, unknown>; part: ToolPart }

const text = (value: unknown) => (typeof value === "string" ? value : "")

function ChangeView(props: Props) {
  const { theme } = useTheme()
  const files = createMemo(() => (Array.isArray(props.input.files) ? (props.input.files as Array<{ path: string; added: number; removed: number }>) : []))
  const state = () => text(props.input.state)
  const label = createMemo(() => {
    const key = ({ proposed: "state_proposed", reviewing: "state_proposed", approved: "state_applying", applying: "state_applying", applied: "state_applied", conflict: "state_conflict", rejected: "state_rejected", failed: "state_failed" } as Record<string, string>)[state()]
    const base = key ? ui(key) : state()
    const receipt = text(props.input.receipt)
    return receipt ? `${base} · ${ui("receipt")} ${receipt.slice(0, 8)}` : base
  })
  const color = () => (state() === "applied" ? theme.success : state() === "conflict" || state() === "failed" ? theme.error : state() === "rejected" ? theme.textMuted : theme.warning)
  return (
    <BlockTool title={`✎ ${text(props.input.title)} · ${label()}`} part={props.part}>
      <box>
        <For each={files()}>
          {(file) => (
            <box flexDirection="row" gap={1}>
              <text fg={theme.text}>{file.path}</text>
              <text fg={theme.diffHighlightAdded}>{`+${file.added}`}</text>
              <text fg={theme.diffHighlightRemoved}>{`-${file.removed}`}</text>
            </box>
          )}
        </For>
        <Show when={text(props.input.hint) && ["conflict", "failed"].includes(state())}>
          <text fg={color()}>{text(props.input.hint)}</text>
        </Show>
      </box>
    </BlockTool>
  )
}

function RunView(props: Props) {
  const { theme } = useTheme()
  const state = () => text(props.input.state)
  const label = () => {
    const key = ({ preparing: "run_preparing", awaiting_approval: "run_awaiting", running: "run_running", passed: "run_passed", failed: "run_failed", blocked: "run_blocked", cancelled: "run_cancelled" } as Record<string, string>)[state()]
    return key ? ui(key) : state()
  }
  const color = () => (state() === "passed" ? theme.success : state() === "failed" || state() === "blocked" ? theme.error : theme.textMuted)
  return (
    <InlineTool icon="▶" iconColor={color()} pending={label()} complete={true} part={props.part}>
      {text(props.input.title)} · {label()}
      <Show when={text(props.input.detail)}>
        <span style={{ fg: theme.textMuted }}>{` — ${text(props.input.detail)}`}</span>
      </Show>
    </InlineTool>
  )
}

function TaskView(props: Props) {
  const { theme } = useTheme()
  const children = createMemo(() => (Array.isArray(props.input.children) ? (props.input.children as Array<{ label: string; status: string; model?: string | null }>) : []))
  return (
    <BlockTool title={`◉ ${text(props.input.title)} · ${text(props.input.state)}`} part={props.part}>
      <box>
        <For each={children()}>
          {(child) => (
            <text fg={theme.text}>
              {child.label} <span style={{ fg: theme.textMuted }}>{`${child.status}${child.model ? ` · ${child.model}` : ""}`}</span>
            </text>
          )}
        </For>
        <Show when={text(props.input.detail)}>
          <text fg={theme.textMuted}>{text(props.input.detail)}</text>
        </Show>
      </box>
    </BlockTool>
  )
}

function NoticeView(props: Props) {
  const { theme } = useTheme()
  const level = () => text(props.input.level)
  const color = () => (level() === "error" ? theme.error : level() === "warning" ? theme.warning : theme.textMuted)
  const icon = () => (level() === "error" ? "✗" : level() === "warning" ? "△" : "ℹ")
  return (
    <InlineTool icon={icon()} iconColor={color()} color={color()} pending="" complete={true} part={props.part}>
      {text(props.input.text)}
      <Show when={text(props.input.hint)}>
        <span style={{ fg: theme.textMuted }}>{` — ${text(props.input.hint)}`}</span>
      </Show>
    </InlineTool>
  )
}

export function UptokeyToolView(props: { tool: string } & Props) {
  return (
    <Show
      when={props.tool === "uptokey_change"}
      fallback={
        <Show
          when={props.tool === "uptokey_run"}
          fallback={
            <Show when={props.tool === "uptokey_task"} fallback={<NoticeView input={props.input} part={props.part} />}>
              <TaskView input={props.input} part={props.part} />
            </Show>
          }
        >
          <RunView input={props.input} part={props.part} />
        </Show>
      }
    >
      <ChangeView input={props.input} part={props.part} />
    </Show>
  )
}
