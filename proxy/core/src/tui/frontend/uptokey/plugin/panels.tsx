/** @jsxImportSource @opentui/solid */
/**
 * Opens the dialog for a panel requested by an Uptokey command (/modelos, /sessoes, /conexoes…).
 * Panels without a frontend implementation say so; they never pretend to have done something.
 */
import type { TuiPlugin, TuiPluginApi } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../../vendor/opencode-tui/feature-plugins/builtins"
import { DialogModel } from "../../vendor/opencode-tui/component/dialog-model"
import { DialogSessionList } from "../../vendor/opencode-tui/component/dialog-session-list"
import { DialogHelp } from "../../vendor/opencode-tui/ui/dialog-help"
import { ConnectProvider } from "../dialogs/connect-provider.tsx"
import { PANEL_COMPONENTS } from "../panels/index.tsx"
import { ComparisonPanel } from "../panels/comparison.tsx"
import { ui } from "../i18n.ts"
import { tr } from "../tr.ts"
import { write as writeClipboard, clipboardErrorMessage } from "../../vendor/opencode-tui/clipboard"
import { MORE_PANELS } from "../panels/more.tsx"
import { ModelFollower, followAgent, followModel } from "../dialogs/model-follow.tsx"
import { getBackend } from "../backend/registry.ts"

const PANELS: Record<string, (arg?: string) => unknown> = {
  models: () => <DialogModel />,
  sessions: () => <DialogSessionList />,
  help: () => <DialogHelp />,
  connections: (providerId) => <ConnectProvider providerId={providerId} />,
  ...PANEL_COMPONENTS,
  ...MORE_PANELS,
  comparison: (arg) => <ComparisonPanel delegate={Boolean(arg?.startsWith("delegate:"))} objective={arg?.replace(/^delegate:/, "")} />,
}

const tui: TuiPlugin = async (api: TuiPluginApi) => {
  // The controller changed the active conversation by itself (/novo, /retomar, --resume): the frontend follows it.
  api.event.on("uptokey.session.navigate" as never, ((event: { properties: { sessionID: string | null } }) => {
    if (event.properties.sessionID) api.route.navigate("session", { sessionID: event.properties.sessionID })
    else api.route.navigate("home")
  }) as never)
  api.event.on("uptokey.panel.open" as never, ((event: { properties: { name: string; arg?: string } }) => {
    const factory = PANELS[event.properties.name]
    if (!factory) {
      api.ui.toast({ variant: "info", message: ui("panel_unavailable", { name: event.properties.name }) })
      return
    }
    api.ui.dialog.replace((() => factory(event.properties.arg)) as never)
  }) as never)
  api.event.on("uptokey.panel.close" as never, (() => api.ui.dialog.clear()) as never)
  // The core selected another model (/modelo <id>): the prompt follows it.
  api.event.on("uptokey.model.follow" as never, ((event: { properties: { providerID: string; modelID: string } }) => {
    const { providerID, modelID } = event.properties
    followModel(providerID, modelID)
  }) as never)
  api.event.on("uptokey.agent.follow" as never, ((event: { properties: { name: string } }) => followAgent(event.properties.name)) as never)
  api.slots.register({ order: 1000, slots: { app_bottom: () => <ModelFollower /> } })
  try {
    const backend = getBackend()
    void backend.whenReady().then(() => {
      backend.replayModel(); backend.replayAgent()
      if(backend.initialConnect)backend.emit({type:'uptokey.panel.open',properties:{name:'connections',arg:backend.initialConnect}})
    })
  } catch {
    // no Uptokey backend (plugin loaded outside the Uptokey frontend)
  }
  // Commands mapped to the frontend's own actions (tool details, theme list).
  api.event.on("uptokey.keymap.dispatch" as never, ((event: { properties: { command: string } }) => {
    api.keymap.dispatchCommand(event.properties.command)
  }) as never)
  api.event.on("uptokey.theme" as never, ((event: { properties: { name: string } }) => {
    const name = event.properties.name.trim()
    if (name && name !== "auto" && api.theme.has(name)) {
      api.theme.set(name)
      api.ui.toast({ variant: "info", message: ui("theme_set", { name }) })
      return
    }
    if (name && name !== "auto") api.ui.toast({ variant: "warning", message: ui("theme_unknown", { name }) })
    api.keymap.dispatchCommand("theme.switch")
  }) as never)
  // /copiar: the same clipboard path as a mouse selection (OSC 52 for the terminal, plus the system clipboard).
  api.event.on("uptokey.copy" as never, ((event: { properties: { text: string; message: string } }) => {
    void writeClipboard(event.properties.text)
      .then(() => api.ui.toast({ variant: "info", message: event.properties.message }))
      .catch((error) => api.ui.toast({ variant: "error", message: clipboardErrorMessage(error) }))
  }) as never)
}

const plugin: BuiltinTuiPlugin = { id: "uptokey.panels", tui }

export default plugin
