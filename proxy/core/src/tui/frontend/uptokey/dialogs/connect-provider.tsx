/**
 * Provider onboarding: provider → key (masked) → models discovered from the account → connected and selected.
 * All persistence goes through the existing provider-setup service and OS vault; this dialog only drives it.
 */
import { createMemo, onCleanup, onMount, Show, type JSX } from "solid-js"
import { TextAttributes } from "@opentui/core"
import { DialogSelect } from "../../vendor/opencode-tui/ui/dialog-select"
import { DialogPrompt } from "../../vendor/opencode-tui/ui/dialog-prompt"
import { useDialog } from "../../vendor/opencode-tui/ui/dialog"
import { useToast } from "../../vendor/opencode-tui/ui/toast"
import { useTheme } from "../../vendor/opencode-tui/context/theme"
import { Spinner } from "../../vendor/opencode-tui/component/spinner"
import { PROVIDER_SETUP_PRESETS, type PreparedProviderSetup } from "../../../provider-setup.ts"
import { getBackend } from "../backend/registry.ts"
import { SecretPrompt } from "./secret-prompt.tsx"
import { ui } from "../i18n.ts"
import { connectionText, prepareConnection, setupErrorText } from "../integration-connections.ts"
import { HOSTED_PROVIDER } from "../../../hosted.ts"
import { accountText } from "../../../account-ui.ts"
import { DialogModel } from "../../vendor/opencode-tui/component/dialog-model"
import { useControllerTick } from "../panels/use-controller.ts"
import { DisconnectProvider } from "./disconnect-provider.tsx"
import { tr } from "../tr.ts"

export { setupErrorText }

function Busy(props: { text: string; onDispose?: () => void }) {
  const { theme } = useTheme()
  const dialog = useDialog()
  dialog.setSize("medium")
  onCleanup(() => props.onDispose?.())
  return (
    <box paddingLeft={2} paddingRight={2} paddingBottom={1} gap={1}>
      <text attributes={TextAttributes.BOLD} fg={theme.text}>
        {props.text}
      </text>
      <Spinner color={theme.textMuted}>{props.text}</Spinner>
    </box>
  )
}

export function ConnectProvider(props:{providerId?:string}={}) {
  const dialog = useDialog()
  const toast = useToast()
  const { theme } = useTheme()
  const backend = getBackend()
  const tick = useControllerTick()
  const accountAuthenticated = createMemo(() => { tick(); return backend.controller.account.view.session?.authenticated === true })

  const choices = createMemo(() => { tick(); return backend.providerChoices() })
  const hasSavedConnection = (id: string) => backend.controller.view.connections?.connections?.some(item => item.providerId === id && /^[0-9a-f-]{36}$/i.test(item.id)) === true
  const configured = (choice: ReturnType<typeof backend.providerChoices>[number]) => choice.configured || hasSavedConnection(choice.id)
  const disconnectOption = (id: string, label: string) => ({
    title: ui("provider_disconnect", { name: label }), value: `disconnect:${id}`, category: ui("connect_ready"),
    onSelect: () => dialog.replace(() => <DisconnectProvider providerId={id} label={label} onBack={() => dialog.replace(() => <ConnectProvider />)} />),
  })

  function openUptokey() {
    const controller = backend.controller
    const available = controller.account.view.available
    if (controller.account.view.session?.authenticated && controller.hostedModels?.some(model => model.accountRef === available?.currentAccountRef && model.revision === available?.revision)) {
      dialog.replace(() => <DialogModel providerID={HOSTED_PROVIDER} />)
      return
    }
    backend.emit({ type: "uptokey.panel.open", properties: { name: "account" } })
  }

  function connectionFlow() {
    const abort = new AbortController()
    let generation = 0
    let active = true
    let committing = false
    const cancel = () => {
      active = false
      // A confirmed save may already be writing the vault/configuration. Let it settle,
      // while preventing its late result from taking over the person's next dialog.
      if (!committing) abort.abort()
    }
    return {
      signal: abort.signal,
      active: () => active,
      beginCommit() { committing = true },
      handoff() { generation++ },
      busy(text: string) {
        const current = ++generation
        const closed = () => { if (current === generation) cancel() }
        dialog.replace(() => <Busy text={text} onDispose={closed} />, closed)
      },
      replace(view: () => JSX.Element, closed?: () => void) {
        const current = ++generation
        const close = () => {
          if (current === generation) cancel()
          closed?.()
        }
        dialog.replace(() => { onCleanup(close); return view() }, close)
      },
    }
  }

  async function prepare(choice: ReturnType<typeof backend.providerChoices>[number], endpoint: string | undefined, flow: ReturnType<typeof connectionFlow>): Promise<PreparedProviderSetup | null> {
    const setup = backend.providerSetup
    if (!setup) {
      toast.show({ variant: "error", message: ui("connect_unavailable") })
      return null
    }
    try {
      return await prepareConnection({
        service: setup, choice, endpoint,
        signal: flow.signal,
        requestKey: (error) => { flow.handoff(); return SecretPrompt.show(dialog, ui("connect_title", { provider: choice.label }), {
          ...(error instanceof Error && error.message !== "provider_key_required" ? { error: setupErrorText(error) } : {}),
          ...(PROVIDER_SETUP_PRESETS.find((preset) => preset.id === choice.id)?.getKeyUrl ? { getKeyUrl: PROVIDER_SETUP_PRESETS.find((preset) => preset.id === choice.id)!.getKeyUrl! } : {}),
        }) },
        requestModel: (error) => { flow.handoff(); return DialogPrompt.show(dialog, connectionText("manual_model"), {
          placeholder: connectionText("manual_model"),
          description: () => <text fg={error ? theme.warning : theme.textMuted}>{connectionText(error ? "model_invalid" : "manual_hint")}</text>,
        }) },
        requestEndpoint: () => { flow.handoff(); return DialogPrompt.show(dialog, ui("connect_endpoint"), { placeholder: PROVIDER_SETUP_PRESETS.find(preset=>preset.id===choice.id)?.endpointPlaceholder ?? "https://…/v1" }) },
        busy: () => flow.busy(ui("connect_loading")),
      })
    } catch (caught) {
      if (!flow.active()) return null
      dialog.clear()
      toast.show({ variant: "error", message: setupErrorText(caught) })
      return null
    }
  }

  async function connectBrave() {
    const flow = connectionFlow()
    let error: string | undefined
    for (;;) {
      flow.handoff()
      const key = await SecretPrompt.show(dialog, ui("connect_brave_title"), { ...(error ? { error } : {}) })
      if (key === null) return
      flow.beginCommit()
      flow.busy(ui("connect_loading"))
      try {
        const result = await backend.configureWebSearchKey(key.trim())
        if (!flow.active()) return
        dialog.clear()
        toast.show({ variant: result.braveAvailable ? "success" : "warning", message: result.braveAvailable ? ui("connect_brave_done") : ui("connect_brave_unavailable") })
        return
      } catch (caught) {
        if (!flow.active()) return
        error = ui("connect_brave_failed", { code: "web_config_failed" })
      }
    }
  }

  async function connect(choice: ReturnType<typeof backend.providerChoices>[number]) {
    if (!choice.executable) {
      toast.show({ variant: "info", message: ui("connect_catalog_only") })
      return
    }
    const flow = connectionFlow()
    let endpoint: string | undefined = choice.endpointUrl || undefined
    const preset = PROVIDER_SETUP_PRESETS.find(preset=>preset.id===choice.id)
    if (!endpoint && !choice.configured && !preset?.endpointRequired) {
      const entered = await DialogPrompt.show(dialog, ui("connect_endpoint"), { placeholder: "https://…/v1" })
      if (!entered) return
      endpoint = entered.trim()
    }
    const prepared = await prepare(choice, choice.endpointUrl ? undefined : endpoint, flow)
    if (!prepared) return
    if (!flow.active()) { prepared.dispose(); return }
    const modelId = await new Promise<string | null>((resolve) => {
      flow.replace(
        () => (
          <DialogSelect
            virtualize
            title={ui("connect_choose_model", { provider: prepared.label })}
            placeholder={ui("connect_search")}
            footer={
              <box flexDirection="column">
                <Show when={prepared.notice}><text fg={theme.warning}>{prepared.notice}</text></Show>
                <Show when={prepared.source === "declared"}><text fg={theme.textMuted}>{connectionText(PROVIDER_SETUP_PRESETS.find(preset=>preset.id===prepared.providerId)?.discovery==='catalog'?"catalog_declared":"manual_declared")}</text></Show>
              </box>
            }
            options={prepared.models.map((model) => ({ title: model.name ?? model.id, value: model.id, description: model.name ? model.id : undefined }))}
            onSelect={(option) => resolve(option.value)}
          />
        ),
        () => resolve(null),
      )
    })
    if (!modelId || !flow.active()) {
      prepared.dispose()
      return
    }
    flow.beginCommit()
    flow.busy(ui("connect_saving"))
    try {
      const result = await prepared.commit(modelId, { acceptNotice: true })
      if (!flow.active()) {
        prepared.dispose()
        // The connection was explicitly saved. Refresh its inventory without selecting
        // a destination or replacing whatever the person opened while it completed.
        if (getBackend() === backend) {
          await backend.controller.refreshConnections()
          backend.refreshAll()
        }
        return
      }
      const selected = await backend.finishProviderSetup(result.providerId, modelId, result.routingComboId, flow.active)
      if (!flow.active()) return
      if (selected === false) { dialog.clear(); return }
      dialog.clear()
      toast.show({ variant: "success", message: ui("connect_done", { provider: prepared.label, model: modelId }) })
    } catch (caught) {
      if (!flow.active()) { prepared.dispose(); return }
      getBackend().trace("provider.commit_failed")
      prepared.dispose()
      dialog.clear()
      toast.show({ variant: "error", message: `${ui("connect_failed")} ${setupErrorText(caught)}` })
    }
  }

  onMount(()=>{
    if (props.providerId === HOSTED_PROVIDER || props.providerId?.toLowerCase() === "uptokey") { openUptokey(); return }
    const choice=props.providerId?backend.providerChoices().find(item=>item.id===props.providerId):undefined
    if(choice)void connect(choice)
  })
  return (
    <DialogSelect
      title={tr("Providers")}
      placeholder={ui("connect_search")}
      emptyView={<text fg={theme.textMuted}>{ui("connect_providers_empty")}</text>}
      options={[
        ...choices().filter(configured).flatMap(choice => [providerOption(choice), ...(!choice.local ? [disconnectOption(choice.id, choice.label)] : [])]),
        {
          title: "Uptokey",
          value: HOSTED_PROVIDER,
          description: accountAuthenticated() ? `${ui("provider_models")} · Free / Plus` : `${accountText("sign_in")} · Free / Plus`,
          category: ui(accountAuthenticated() ? "connect_ready" : "connect_title_list"),
          onSelect: openUptokey,
        },
        ...(accountAuthenticated() ? [disconnectOption(HOSTED_PROVIDER, "Uptokey")] : []),
        ...(accountAuthenticated() && backend.controller.account.view.connectionNeeded ? [{ title: accountText("connect_terminal"), value: "uptokey-connect-terminal", category: "Uptokey", onSelect: () => { backend.emit({ type: "uptokey.panel.open", properties: { name: "account" } }); void backend.controller.account.connectHosted() } }] : []),
        ...choices().filter(choice => !configured(choice)).map(providerOption),
        {
          title: "Brave Search",
          value: "web:brave",
          description: ui("connect_brave_description"),
          category: ui("connect_web_search"),
          onSelect: () => void connectBrave(),
        },
      ]}
    />
  )

  function providerOption(choice: ReturnType<typeof backend.providerChoices>[number]) {
    return {
        title: choice.label,
        value: choice.id,
        description: choice.executable ? (choice.local ? ui("connect_local_no_key") : undefined) : ui("connect_catalog_only"),
        category: configured(choice) ? ui("connect_ready") : ui("connect_title_list"),
        gutter: choice.eligible ? () => <text fg={theme.success}>✓</text> : undefined,
        disabled: false,
        onSelect: () => void connect(choice),
    }
  }
}

export { PROVIDER_SETUP_PRESETS }
