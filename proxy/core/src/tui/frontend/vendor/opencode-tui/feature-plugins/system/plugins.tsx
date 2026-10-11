import type { TuiPlugin, TuiPluginApi, TuiPluginStatus } from "@opencode-ai/plugin/tui"
import type { BuiltinTuiPlugin } from "../builtins"
import { useTerminalDimensions } from "@opentui/solid"
import { fileURLToPath } from "url"
import { DialogSelect, type DialogSelectOption } from "../../ui/dialog-select"
import { Show, createEffect, createMemo, createSignal } from "solid-js"
import { useBindings } from "../../keymap"
import { tr } from "../../../../uptokey/tr.ts"

const id = "internal:plugin-manager"

function state(api: TuiPluginApi, item: TuiPluginStatus) {
  if (!item.enabled) {
    return <span style={{ fg: api.theme.current.textMuted }}>{tr("disabled")}</span>
  }

  return (
    <span style={{ fg: item.active ? api.theme.current.success : api.theme.current.error }}>
      {item.active ? tr("active") : tr("inactive")}
    </span>
  )
}

function source(spec: string) {
  if (!spec.startsWith("file://")) return
  return fileURLToPath(spec)
}

function meta(item: TuiPluginStatus, width: number) {
  if (item.source === "internal") {
    if (width >= 120) return "Built-in plugin"
    return "Built-in"
  }
  const next = source(item.spec)
  if (next) return next
  return item.spec
}

function Install(props: { api: TuiPluginApi }) {
  const [global, setGlobal] = createSignal(false)
  const [busy, setBusy] = createSignal(false)

  useBindings(() => ({
    enabled: !busy(),
    bindings: [{ key: "tab", desc: tr("Toggle install scope"), group: "Plugins", cmd: () => setGlobal((value) => !value) }],
  }))

  return (
    <props.api.ui.DialogPrompt
      title={tr("Install plugin")}
      placeholder={tr("npm package name")}
      busy={busy()}
      busyText="Installing plugin…"
      description={() => (
        <box flexDirection="row" gap={1}>
          <text fg={props.api.theme.current.textMuted}>scope:</text>
          <text fg={busy() ? props.api.theme.current.textMuted : props.api.theme.current.text}>
            {global() ? tr("global") : tr("local")}
          </text>
          <Show when={!busy()}>
            <text fg={props.api.theme.current.textMuted}>{tr("(tab toggle)")}</text>
          </Show>
        </box>
      )}
      onConfirm={(raw) => {
        if (busy()) return
        const mod = raw.trim()
        if (!mod) {
          props.api.ui.toast({
            variant: "error",
            message: tr("Plugin package name is required"),
          })
          return
        }

        setBusy(true)
        void props.api.plugins
          .install(mod, { global: global() })
          .then((out) => {
            if (!out.ok) {
              props.api.ui.toast({
                variant: "error",
                message: (out as any).message,
              })
              if ((out as any).missing) {
                props.api.ui.toast({
                  variant: "info",
                  message: tr("Check npm registry/auth settings and try again."),
                })
              }
              show(props.api)
              return
            }

            props.api.ui.toast({
              variant: "success",
              message: `Installed ${mod} (${global() ? "global" : "local"}: ${out.dir})`,
            })
            if (!out.tui) {
              props.api.ui.toast({
                variant: "info",
                message: tr("Package has no TUI target to load in this app."),
              })
              show(props.api)
              return
            }

            return props.api.plugins.add(mod).then((ok) => {
              if (!ok) {
                props.api.ui.toast({
                  variant: "warning",
                  message: tr("Installed plugin, but runtime load failed. See console/logs; restart TUI to retry."),
                })
                show(props.api)
                return
              }

              props.api.ui.toast({
                variant: "success",
                message: `Loaded ${mod} in current session.`,
              })
              show(props.api)
            })
          })
          .finally(() => {
            setBusy(false)
          })
      }}
      onCancel={() => {
        show(props.api)
      }}
    />
  )
}

function row(api: TuiPluginApi, item: TuiPluginStatus, width: number): DialogSelectOption<string> {
  return {
    title: item.id,
    value: item.id,
    category: item.source === "internal" ? "Internal" : "External",
    description: meta(item, width),
    footer: state(api, item),
    disabled: item.id === id,
  }
}

function showInstall(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <Install api={api} />)
}

function View(props: { api: TuiPluginApi }) {
  const size = useTerminalDimensions()
  const [list, setList] = createSignal(props.api.plugins.list())
  const [cur, setCur] = createSignal<string | undefined>()
  const [lock, setLock] = createSignal(false)

  createEffect(() => {
    const width = size().width
    if (width >= 128) {
      props.api.ui.dialog.setSize("xlarge")
      return
    }
    if (width >= 96) {
      props.api.ui.dialog.setSize("large")
      return
    }
    props.api.ui.dialog.setSize("medium")
  })

  const rows = createMemo(() =>
    [...list()]
      .sort((a, b) => {
        const x = a.source === "internal" ? 1 : 0
        const y = b.source === "internal" ? 1 : 0
        if (x !== y) return x - y
        return a.id.localeCompare(b.id)
      })
      .map((item) => row(props.api, item, size().width)),
  )

  const flip = (x: string) => {
    if (lock()) return
    const item = list().find((entry) => entry.id === x)
    if (!item) return
    setLock(true)
    const task = item.active ? props.api.plugins.deactivate(x) : props.api.plugins.activate(x)
    void task
      .then((ok) => {
        if (!ok) {
          props.api.ui.toast({
            variant: "error",
            message: `Failed to update plugin ${item.id}`,
          })
        }
        setList(props.api.plugins.list())
      })
      .finally(() => {
        setLock(false)
      })
  }

  return (
    <DialogSelect
      title={tr("Plugins")}
      options={rows()}
      current={cur()}
      onMove={(item) => setCur(item.value)}
      actions={[
        {
          title: tr("toggle"),
          command: "plugins.toggle",
          hidden: lock(),
          onTrigger: (item) => {
            setCur(item.value)
            flip(item.value)
          },
        },
        {
          title: tr("install"),
          command: "dialog.plugins.install",
          hidden: lock(),
          onTrigger: () => {
            showInstall(props.api)
          },
        },
      ]}
      onSelect={(item) => {
        setCur(item.value)
        flip(item.value)
      }}
    />
  )
}

function show(api: TuiPluginApi) {
  api.ui.dialog.replace(() => <View api={api} />)
}

const tui: TuiPlugin = async (api) => {
  api.keymap.registerLayer({
    commands: [
      {
        name: "plugins.list",
        title: tr("Plugins"),
        category: tr("System"),
        namespace: "palette",
        run() {
          show(api)
        },
      },
      {
        name: "plugins.install",
        title: tr("Install plugin"),
        category: tr("System"),
        namespace: "palette",
        run() {
          showInstall(api)
        },
      },
    ],
    bindings: api.tuiConfig.keybinds.gather("plugins.palette", ["plugins.list", "plugins.install"]),
  })
}

const plugin: BuiltinTuiPlugin = {
  id,
  tui,
}

export default plugin
