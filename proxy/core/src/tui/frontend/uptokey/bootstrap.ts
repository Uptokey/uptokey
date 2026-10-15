/** Shared initialization for both presentations of the canonical terminal frontend. */
import { writeFileSync } from "node:fs"
import os from "node:os"
import { createInterface } from "node:readline/promises"
import { TuiClient, discoverCoreUrl } from "../../client.ts"
import { TuiController } from "../../controller.ts"
import { resolveInteractiveToken, getStoredNativeKey, signChallenge } from "../../auth.ts"
import { adoptTuiServiceProfile, startSharedService } from "../../service-start.ts"
import { setLang, autoDetect, type Lang } from "../../i18n.ts"
import { createProviderSetupService, type ProviderSetupService } from "../../provider-setup.ts"
import { createOfficialSecretStore } from "../../../secret-store.ts"
import { parseArgs } from "../../index.ts"
import { Path as GlobalPath } from "../vendor/opencode-core/global.ts"
import { UptokeyBackend } from "./backend/index.ts"
import { setBackend } from "./backend/registry.ts"
import { JevClient, setJev } from "../../jev-client.ts"
import { terminalText, pairingAccepted } from "./integration-terminal.ts"
import { runLinearFrontend } from "./linear.ts"

export interface UptokeyMainOptions {
  cwd: string
  /** --lang wins over the environment's language. */
  lang?: Lang
  port?: number
  model?: string
  resume?: string
  project?: string
  temporary?: boolean
  external?: boolean
  screenReader?: boolean
  connect?: string
  theme?: string
  /** Test seam: a pre-built controller (never used by the shipped entry). */
  controller?: TuiController
  providerSetup?: ProviderSetupService
}

/** Development measurements never affect interaction or persist prompt contents. */
function startStats() {
  const file = process.env.UPTOKEY_TUI_STATS
  if (!file) return () => {}
  const started = performance.now()
  let peak = 0
  const sample = () => {
    const usage = process.memoryUsage()
    peak = Math.max(peak, usage.rss)
    try {
      writeFileSync(file, JSON.stringify({ rss: usage.rss, peakRss: peak, heapUsed: usage.heapUsed, uptimeMs: Math.round(performance.now() - started) }))
    } catch {
      // measurement must never affect the interface
    }
  }
  sample()
  const timer = setInterval(sample, 500)
  timer.unref()
  return () => clearInterval(timer)
}

export async function bootstrapFrontend(options: UptokeyMainOptions) {
  const stopStats = startStats()
  setLang(options.lang ?? autoDetect([], process.env))
  const url = discoverCoreUrl(options.port)
  let controller = options.controller
  if (!controller) {
    await adoptTuiServiceProfile(options.cwd)
    // Direct frontend launches use the same version/consent boundary as the Node CLI.
    // Service failures must not be mislabeled as an identity or credential failure.
    try { await startSharedService(url, options.cwd) }
    catch (error) { stopStats(); throw error }
    const probe = new TuiClient({ baseUrl: url })
    let token: string | undefined
    try {
      if ((await probe.health()).status === "ok") {
        token = await resolveInteractiveToken(probe, {
          show: message => void process.stderr.write(`${message}\n`),
          confirmPairing: async info => {
            const input = createInterface({ input: process.stdin, output: process.stderr })
            try {
              process.stderr.write(`\n${terminalText("pairing")} · ${info.publicKeyFingerprint.slice(0, 16)}\n`)
              if (info.ownerChange) process.stderr.write(`${terminalText("preserve_identity")}\n`)
              return pairingAccepted(await input.question(terminalText("pairing_confirm")))
            } finally {
              input.close()
            }
          },
        })
      }
    } catch {
      process.stderr.write(`${terminalText("identity_unavailable")}\n`)
    } finally {
      probe.destroy()
    }
    controller = new TuiController({
      cwd: options.cwd,
      baseUrl: url,
      ...(token ? { token } : {}),
      ...(options.project ? { projectHint: options.project } : {}),
      ...(options.model ? { model: options.model } : {}),
      ...(options.resume ? { resume: options.resume } : {}),
      temporary: options.temporary === true,
      folderMentionBinding: "off" as const,
      ...(options.external ? { processingPolicy: "external_allowed" as const } : {}),
      loadSigner: async () => {
        const key = await getStoredNativeKey()
        return key ? (nonce: string) => signChallenge(key.privateKeyPem, nonce) : null
      },
    })
  }

  setJev(new JevClient({ core: controller.client }))
  const backend = new UptokeyBackend({
    controller,
    cwd: options.cwd,
    home: os.homedir(),
    state: GlobalPath.state,
    config: GlobalPath.config,
    exit: (code?: number) => process.exit(code ?? 0),
    providerSetup: options.providerSetup ?? createProviderSetupService({ secrets: createOfficialSecretStore() }),
    initialConnect: options.connect,
  })
  setBackend(backend)
  backend.trace("boot.main", { sinceStartMs: Math.round(performance.now()) })
  void backend.whenReady().then(() => backend.trace("boot.controller_ready", { sinceStartMs: Math.round(performance.now()) }))
  let disposed = false
  return {
    backend, controller, url,
    dispose() {
      if (disposed) return
      disposed = true
      backend.dispose()
      controller.dispose()
      stopStats()
    },
  }
}

export async function linearMain(options: UptokeyMainOptions) {
  const runtime = await bootstrapFrontend(options)
  try { await runLinearFrontend(runtime.backend, options.connect) }
  finally { runtime.dispose() }
}

/** Relative CLI paths belong to the invoking process, including after a presentation handoff. */
export function mainOptionsFromArgs(args = process.argv.slice(2)): UptokeyMainOptions {
  if (process.env.UPTOKEY_TUI_CALLER_CWD) process.chdir(process.env.UPTOKEY_TUI_CALLER_CWD)
  const parsed = parseArgs(args)
  return {
    cwd: parsed.cwd ?? parsed.targetPath ?? process.cwd(),
    ...(parsed.lang ? { lang: parsed.lang } : {}),
    ...(parsed.port ? { port: parsed.port } : {}),
    ...(parsed.model ? { model: parsed.model } : {}),
    ...(parsed.resume ? { resume: parsed.resume } : {}),
    ...(parsed.project ? { project: parsed.project } : {}),
    temporary: parsed.temporary === true,
    external: parsed.external === true,
    screenReader: parsed.screenReader === true,
    ...(parsed.connect ? { connect: parsed.connect } : {}),
    ...(parsed.theme ? { theme: parsed.theme } : {}),
  }
}
