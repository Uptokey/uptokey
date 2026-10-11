/**
 * Minimal host for the built-in OpenCode feature plugins (sidebar, home footer, which-key, diff viewer).
 * External plugin loading is intentionally absent: Uptokey extends the interface through its own modules.
 */
import { createBuiltinPlugins } from "../vendor/opencode-tui/feature-plugins/builtins.ts"
import UptokeyPanels from "./plugin/panels.tsx"
import UptokeyHomeTips from "./plugin/home-tips.tsx"
import { traceBoot } from "./boot-trace.ts"
import { createCommandShim } from "../vendor/opencode-tui/plugin/command-shim.ts"
import type { TuiPluginHost } from "../vendor/opencode-tui/plugin/runtime.tsx"
import type { TuiPluginApi, TuiSlotPlugin } from "@opencode-ai/plugin/tui"

/** Built-in modules that depend on features Uptokey does not provide (external plugins, OpenCode promos, git/session diff service). */
const EXCLUDED = new Set(["internal:plugin-manager", "internal:sidebar-footer", "internal:home-tips", "diff-viewer"])

export function createUptokeyPluginHost(): TuiPluginHost {
  const disposers: Array<() => void | Promise<void>> = []
  const controller = new AbortController()
  return {
    async start(input) {
      const slotsHost = input.runtime.setupSlots(input.api)
      const lifecycle: TuiPluginApi["lifecycle"] = {
        signal: controller.signal,
        onDispose(fn) {
          disposers.push(fn)
          return () => {
            const index = disposers.indexOf(fn)
            if (index >= 0) disposers.splice(index, 1)
          }
        },
      }
      for (const plugin of [...createBuiltinPlugins({ experimentalEventSystem: false }), UptokeyPanels, UptokeyHomeTips]) {
        if (plugin.enabled === false || EXCLUDED.has(plugin.id)) continue
        let count = 0
        const api: TuiPluginApi = {
          ...input.api,
          command: createCommandShim(input.api.keymap, input.api.ui.dialog, input.api.tuiConfig.keybinds),
          slots: {
            register(slot: TuiSlotPlugin) {
              const id = count ? `${plugin.id}:${count}` : plugin.id
              count += 1
              const off = slotsHost.register({ ...slot, id })
              disposers.push(off)
              return id
            },
          },
          plugins: {
            list: () => [],
            activate: async () => false,
            deactivate: async () => false,
            add: async () => false,
            install: async () => ({ ok: false, message: "Uptokey does not install external TUI plugins." }),
          } as unknown as TuiPluginApi["plugins"],
          lifecycle,
        }
        try {
          const started = performance.now()
          await plugin.tui(api, undefined, { state: "same", id: plugin.id, source: "internal", spec: plugin.id, target: plugin.id } as never)
          traceBoot("boot.plugin", { id: plugin.id, ms: Math.round(performance.now() - started) })
        } catch (error) {
          console.error(`Built-in TUI module ${plugin.id} failed`, error)
        }
      }
      input.dispose?.()
    },
    async dispose() {
      controller.abort()
      for (const dispose of disposers.splice(0).reverse()) await dispose()
    },
  }
}
