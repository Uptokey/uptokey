/** @jsxImportSource @opentui/solid */
/**
 * Home-screen line under the composer: the temporary-conversation warning when that mode is on (otherwise invisible
 * on the home screen), or one tip about Uptokey's own features (the upstream tips describe OpenCode and stay
 * excluded). Only tips for flows the frontend actually serves; command names and markers (@, /x, Esc) are highlighted.
 */
import { For, Show, createSignal, onCleanup, onMount } from "solid-js"
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../../vendor/opencode-tui/feature-plugins/builtins"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { getBackend } from "../backend/registry.ts"
import { ui } from "../i18n.ts"

const TIP_KEYS = ["tip_commands", "tip_mention", "tip_folder", "tip_review", "tip_models", "tip_connections", "tip_compare", "tip_sessions", "tip_interrupt", "tip_usage"] as const

function parts(text: string) {
  return text.split(/(\s+)/).map((word) => ({ text: word, highlight: /^(?:\/\S*|@|Esc|Échap)$/.test(word.replace(/[;:,.]$/, "")) }))
}

function HomeLine(props: { index: number }) {
  const { theme } = useTheme()
  const backend = getBackend()
  const [temporary, setTemporary] = createSignal(backend.temporary)
  onCleanup(backend.onChange(() => setTemporary(backend.temporary)))
  onMount(() => backend.trace("boot.home_mounted", { sinceStartMs: Math.round(performance.now()) }))
  const text = () => ui(TIP_KEYS[props.index % TIP_KEYS.length]!)
  return (
    <box width="100%" maxWidth={75} alignItems="center" paddingTop={3} flexShrink={1}>
      <Show
        when={!temporary()}
        fallback={
          <text flexShrink={1} wrapMode="word" style={{ fg: theme.warning }}>
            {`◌ ${ui("temporary_home")}`}
          </text>
        }
      >
        <box flexDirection="row" maxWidth="100%">
          <text flexShrink={0} style={{ fg: theme.warning }}>
            {`● ${ui("tip_label")} `}
          </text>
          <text flexShrink={1} wrapMode="word">
            <For each={parts(text())}>{(part) => <span style={{ fg: part.highlight ? theme.text : theme.textMuted }}>{part.text}</span>}</For>
          </text>
        </box>
      </Show>
    </box>
  )
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  const index = Math.floor(Math.random() * TIP_KEYS.length)
  api.slots.register({ order: 100, slots: { home_bottom: () => <HomeLine index={index} /> } })
}

const plugin: BuiltinTuiPlugin = { id: "uptokey.home-tips", tui }

export default plugin
