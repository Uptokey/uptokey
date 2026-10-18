/**
 * Masked entry for credentials. The value lives only in this component until it is handed to the provider setup
 * service (which writes it straight to the OS vault); it is never rendered, logged or placed in the transcript.
 */
import { TextAttributes, type PasteEvent } from "@opentui/core"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSignal, onCleanup, onMount, Show, type JSX } from "solid-js"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { useDialog, type DialogContext } from "../../vendor/opencode-tui/ui/dialog"
import { ui } from "../i18n.ts"

export interface SecretPromptProps {
  title: string
  description?: () => JSX.Element
  error?: string
  /** Official page where this provider issues keys; shown after the field, never fetched by the terminal. */
  getKeyUrl?: string
  onConfirm: (value: string) => void
  onCancel: () => void
}

const MAX_SECRET = 4096

export function SecretPrompt(props: SecretPromptProps) {
  const dialog = useDialog()
  const renderer = useRenderer()
  const { theme } = useTheme()
  const [value, setValue] = createSignal("")

  onMount(() => dialog.setSize("medium"))

  useKeyboard((event) => {
    if (event.name === "return" || event.name === "enter") {
      event.preventDefault()
      if (value()) props.onConfirm(value())
      return
    }
    if (event.name === "backspace") {
      event.preventDefault()
      setValue((current) => current.slice(0, -1))
      return
    }
    if (event.ctrl && event.name === "u") {
      event.preventDefault()
      setValue("")
      return
    }
    if (event.ctrl || event.meta || event.option) return
    const sequence = event.sequence
    if (sequence && sequence.length === 1 && sequence >= " " && sequence !== "\x7f") {
      event.preventDefault()
      setValue((current) => (current.length < MAX_SECRET ? current + sequence : current))
    }
  })

  onMount(() => {
    const onPaste = (event: PasteEvent) => {
      event.preventDefault()
      const text = new TextDecoder().decode(event.bytes).replace(/[\r\n\t]/g, "").trim()
      setValue((current) => (current + text).slice(0, MAX_SECRET))
    }
    renderer.keyInput.on("paste", onPaste)
    onCleanup(() => {
      renderer.keyInput.off("paste", onPaste)
      setValue("")
    })
  })

  return (
    <box paddingLeft={2} paddingRight={2} gap={1}>
      <box flexDirection="row" justifyContent="space-between">
        <text attributes={TextAttributes.BOLD} fg={theme.text}>
          {props.title}
        </text>
        <text fg={theme.textMuted} onMouseUp={() => props.onCancel()}>
          esc
        </text>
      </box>
      <box gap={1}>
        {props.description?.()}
        <text fg={theme.textMuted}>{ui("secret_hint")}</text>
        <box border={["left"]} borderColor={theme.primary} paddingLeft={1}>
          <Show when={value().length > 0} fallback={<text fg={theme.textMuted}>{ui("secret_placeholder")}</text>}>
            <text fg={theme.text}>{"•".repeat(Math.min(value().length, 64))}</text>
          </Show>
        </box>
        <Show when={props.error}>
          <text fg={theme.error}>{props.error}</text>
        </Show>
        <Show when={props.getKeyUrl}>
          <text fg={theme.textMuted}>{ui("secret_get_key", { url: props.getKeyUrl! })}</text>
        </Show>
      </box>
      <box paddingBottom={1}>
        <text fg={theme.textMuted}>{ui("secret_submit")}</text>
      </box>
    </box>
  )
}

SecretPrompt.show = (dialog: DialogContext, title: string, options: Pick<SecretPromptProps, "description" | "error" | "getKeyUrl"> = {}) =>
  new Promise<string | null>((resolve) => {
    dialog.replace(
      () => <SecretPrompt title={title} {...options} onConfirm={(value) => resolve(value)} onCancel={() => dialog.clear()} />,
      () => resolve(null),
    )
  })
