import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"

const require = createRequire(import.meta.url)
const ts = require("../src/tui/frontend/node_modules/typescript")
const entry = new URL("../src/tui/index.ts", import.meta.url)

// Run the actual entry with service and terminal process boundaries inert.
function fixture(start: () => Promise<void> = async () => {}) {
  const source = readFileSync(process.env.UPTOKEY_TEST_TUI_SOURCE ?? entry, "utf8")
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText
  const calls: Array<{ name: string; args?: any }> = []
  let stderr = ""
  const processFixture: any = { env: {}, stdin: { isTTY: true }, stdout: { isTTY: true, write() {} }, stderr: { write: (text: string) => { stderr += text } }, cwd: () => process.cwd(), exitCode: undefined }
  const exports: any = {}
  runInNewContext(compiled, { exports, process: processFixture, require: (id: string) => {
    if (id === "node:path") return require(id)
    if (id === "../version.ts") return { PACKAGE_VERSION: "fixture-version" }
    if (id === "./service-start.ts") return {
      adoptTuiServiceProfile: async (cwd: string) => { calls.push({ name: "adopt", args: cwd }) },
      startSharedService: async (url: string, cwd: string) => { calls.push({ name: "start", args: { url, cwd } }); await start() },
    }
    if (id === "./client.ts") return { discoverCoreUrl: (port?: number) => `http://127.0.0.1:${port ?? 21435}` }
    if (id === "./i18n.ts") return { autoDetect: () => "en", setLang() {}, getLang: () => "en", t: (key: string) => `localized:${key}` }
    if (id === "./messages/terminal.ts") return { terminalHelp: () => "fixture-help" }
    if (id === "./frontend/uptokey/integration-terminal.ts") return { terminalText: (key: string) => `localized:${key}` }
    if (id === "./frontend-launcher.ts") return { runFrontend: async (args: string[]) => { calls.push({ name: "frontend", args }); return 0 } }
    if (id === "./pipe.ts") return { runPipe: async (args: any) => { calls.push({ name: "pipe", args }); return 0 } }
    throw new Error(`Unexpected TUI entry dependency: ${id}`)
  } })
  return { runTui: exports.runTui, calls, process: processFixture, stderr: () => stderr }
}

test("interactive Node entry adopts the profile and waits for core readiness before opening the frontend", async t => {
  let release!: () => void
  const gate = new Promise<void>(resolve => { release = resolve })
  t.after(() => release())
  const h = fixture(() => gate)
  const started = h.runTui(["--resume", "conversation-1", "--next"])
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "start"])
  assert.deepEqual(JSON.parse(JSON.stringify(h.calls[1]!.args)), { url: "http://127.0.0.1:21435", cwd: process.cwd() })
  release()
  await started
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "start", "frontend"])
  assert.deepEqual(Array.from(h.calls[2]!.args), ["--resume", "conversation-1"])
  assert.equal(h.process.exitCode, 0)
})

test("core startup failure exits with a localized diagnosis before any frontend onboarding", async () => {
  const h = fixture(async () => { throw new Error("fixture_private_start_failure") })
  await h.runTui([])
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "start"])
  assert.equal(h.process.exitCode, 3)
  assert.equal(h.stderr(), "localized:svc_start_failed\n")
  assert.equal(h.stderr().includes("fixture_private_start_failure"), false)
})

test("cancelling the shared service update exits130 without onboarding or a false identity error", async () => {
  const h = fixture(async () => { throw Object.assign(new Error("cancelled"), { name: "AbortError" }) })
  await h.runTui([])
  assert.equal(h.process.exitCode, 130)
  assert.equal(h.stderr(), "")
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "start"])
})

test("a localized service update failure remains a service diagnosis rather than an identity failure", async () => {
  const h = fixture(async () => { throw Object.assign(new Error("localized:update_recovery"), { name: "TuiServiceUpdateError" }) })
  await h.runTui([])
  assert.equal(h.process.exitCode, 3)
  assert.equal(h.stderr(), "localized:update_recovery\n")
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "start"])
})

test("pipe mode retains its existing profile adoption and dispatch without interactive service startup", async () => {
  const h = fixture(async () => { assert.fail("interactive starter must not affect pipe semantics") })
  await h.runTui(["--pipe", "--model", "fixture-model"])
  assert.deepEqual(h.calls.map(call => call.name), ["adopt", "pipe"])
  assert.equal(h.calls[1]!.args.model, "fixture-model")
  assert.equal(h.process.exitCode, 0)
})
