/** OpenTUI presentation; service, identity and controller startup are shared with accessible mode. */
import { Effect } from "effect"
import os from "node:os"
import { run } from "../vendor/opencode-tui/app.tsx"
import { TuiConfig } from "../vendor/opencode-tui/config/index.tsx"
import { Service as GlobalService, Path as GlobalPath } from "../vendor/opencode-core/global.ts"
import { createUptokeyPluginHost } from "./plugin-host.ts"
import { bootstrapFrontend, linearMain, mainOptionsFromArgs, type UptokeyMainOptions } from "./bootstrap.ts"

export type { UptokeyMainOptions } from "./bootstrap.ts"

export async function main(options: UptokeyMainOptions) {
  if (options.screenReader) return linearMain(options)
  const runtime = await bootstrapFrontend(options)
  if (options.resume) await runtime.backend.whenReady()
  const config = TuiConfig.resolve(options.theme ? { theme: options.theme } : {}, { terminalSuspend: process.platform !== "win32" })
  const program = run({
    url: runtime.url,
    args: options.resume ? { sessionID: runtime.controller.state.activeConversation?.id } : {},
    config,
    directory: options.cwd,
    pluginHost: createUptokeyPluginHost(),
  }).pipe(Effect.provideService(GlobalService, { ...GlobalPath, home: os.homedir() }))
  try { await Effect.runPromise(program) }
  finally { runtime.dispose() }
}

if (import.meta.main) {
  try { await main(mainOptionsFromArgs()) }
  catch (error) {
    if (!(error instanceof Error) || error.name !== "AbortError") throw error
    process.exitCode = 130
  }
  process.exit(process.exitCode ?? 0)
}
