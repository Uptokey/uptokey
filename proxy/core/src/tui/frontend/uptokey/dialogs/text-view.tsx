/** Scrollable read-only text (diagnostics, diffs, artifacts). Diff lines are coloured when `diff` is set. */
import { TextAttributes } from "@opentui/core"
import { createMemo, For, onMount, Show } from "solid-js"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { useTuiConfig } from "../../vendor/opencode-tui/config"
import { getScrollAcceleration } from "../../vendor/opencode-tui/util/scroll"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"

export function TextView(props: { title: string; text: string; diff?: boolean; footer?: string }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  const config = useTuiConfig()
  onMount(() => dialog.setSize("large"))
  const lines = createMemo(() => props.text.replace(/\r\n/g, "\n").split("\n"))
  const color = (line: string) => {
    if (!props.diff) return theme.text
    if (line.startsWith("+") && !line.startsWith("+++")) return theme.diffHighlightAdded
    if (line.startsWith("-") && !line.startsWith("---")) return theme.diffHighlightRemoved
    if (line.startsWith("@@")) return theme.primary
    return theme.text
  }
  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => dialog.clear()}>
          esc
        </text>
      </box>
      <scrollbox height={Math.min(24, Math.max(6, lines().length))} scrollAcceleration={getScrollAcceleration(config)}>
        <For each={lines()}>{(line) => <text fg={color(line)}>{line.replace(/\t/g, "    ") || " "}</text>}</For>
      </scrollbox>
      <Show when={props.footer}>
        <box paddingBottom={1}>
          <text fg={theme.textMuted}>{props.footer}</text>
        </box>
      </Show>
    </box>
  )
}
