/**
 * Real-terminal journeys for the OpenTUI frontend: isolated real core + Bun child in ConPTY + xterm screen model.
 *   node --experimental-strip-types scripts/tui-frontend-pty.mjs [journey...]
 * Each execution writes its own terminal, trace and result evidence.
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { createHash } from 'node:crypto';
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import assert from "node:assert/strict";
import { findExecutable, openPty } from "./lib/pty-session.mjs";
import { resolvePortableRuntime } from "../src/tui/portable-runtime.mjs";
import { connectJourney } from "./lib/journey-connect.mjs";
import { editJourney } from "./lib/journey-edit.mjs";
import { commandsJourney } from "./lib/journey-commands.mjs";
import { folderJourney } from "./lib/journey-folder.mjs";
import { scrollJourney } from "./lib/journey-scroll.mjs";
import { copyJourney } from "./lib/journey-copy.mjs";
import { exitJourney, cancelJourney } from "./lib/journey-lifecycle.mjs";
import { panelsJourney } from "./lib/journey-panels.mjs";
import { slashList } from "./lib/journey-slash-list.mjs";
import { sessionsJourney } from "./lib/journey-sessions.mjs";
import { delegateJourney } from "./lib/journey-delegate.mjs";
import { LOCALES, localeJourney } from "./lib/journey-locales.mjs";
import { reopenJourney, pasteJourney, conflictJourney, networkJourney, switchJourney, switchProjectJourney } from "./lib/journey-robustness.mjs";
import { exportJourney, temporaryJourney } from "./lib/journey-privacy.mjs";
import { homonymJourney } from "./lib/journey-homonym.mjs";
import { revokeJourney } from "./lib/journey-revoke.mjs";
import { gitJourney } from "./lib/journey-git.mjs";
import { runnerJourney } from "./lib/journey-runner.mjs";
import { jevJourney } from "./lib/journey-jev.mjs";
import { toolsJourney } from "./lib/journey-tools.mjs";
import { voiceJourney } from "./lib/journey-voice.mjs";
import { debugJourney } from "./lib/journey-debug.mjs";
import { lspJourney } from "./lib/journey-lsp.mjs";
import { restartJourney } from "./lib/journey-restart.mjs";
import { panelsMoreJourney } from "./lib/journey-panels-more.mjs";
import { clickJourney } from "./lib/journey-click.mjs";
import { searchJourney } from "./lib/journey-search.mjs";
import { updateJourney } from "./lib/journey-update.mjs";
import { appJourney, HostCapabilityUnavailableError } from "./lib/journey-app.mjs";
import { runnerRealJourney } from "./lib/journey-runner-real.mjs";
import { startCoreProxy } from "./lib/core-proxy.mjs";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = process.env.UPTOKEY_TUI_EVIDENCE_DIR
  ? resolve(process.env.UPTOKEY_TUI_EVIDENCE_DIR)
  : resolve(core, "../../output/tui-canonica", new Date().toISOString().replace(/[:.]/g, "-"));
const frontend = join(core, "src/tui/frontend");
async function fingerprint(directory) {
  const files=[];
  const walk=async(dir)=>{for(const item of await readdir(dir,{withFileTypes:true})){
    if(item.name==='node_modules'||item.name==='.git'||item.isSymbolicLink())continue;
    const file=join(dir,item.name);
    if(item.isDirectory())await walk(file);
    else if(/\.(ts|tsx|js|json|mjs)$/.test(item.name))files.push([file.slice(directory.length),createHash('sha256').update(await readFile(file)).digest('hex')]);
  }};
  await walk(directory);files.sort(([a],[b])=>a.localeCompare(b));
  return createHash('sha256').update(JSON.stringify(files)).digest('hex');
}
const sourceHash=await fingerprint(join(core,'src'));
const wanted = process.argv.slice(2);
// Default suite. Run the others by name: slashlist (diagnostic) and delegate (blocked until the core resolves delegation
// connections by the same identity the TUI snapshot lists: connection-profile id versus provider id; multimodel front).
const LOCALE_JOURNEYS = LOCALES.map((lang) => `locale-${lang}`);
const KNOWN_JOURNEYS = ["boot", "chat", "connect", "edit", "commands", "folder", "scroll", "copy", "exit", "cancel", "panels", "sessions", "slashlist", "delegate", "reopen", "paste", "conflict", "network", "export", "temporary", "homonym", "switch", "revoke", "git", "runner", "jev", "tools", "voice", "debug", "lsp", "restart", "switch-project", "panels-more", "click", "search", "update", "runner-real", "app", "linear", ...LOCALE_JOURNEYS];
const DEFAULT_JOURNEYS = KNOWN_JOURNEYS.filter((name) => !["slashlist", "delegate", "update", "runner-real", "app", "search"].includes(name));
// "locales" expands to the ten language runs.
const journeys = (wanted.length ? wanted.flatMap((name) => (name === "locales" ? LOCALE_JOURNEYS : [name])) : DEFAULT_JOURNEYS).filter((name) => KNOWN_JOURNEYS.includes(name));

async function startFixture(extra = [], reuse = null) {
  // The distributable runtime may only write below its own install tree on hosts with path-scoped write policies.
  const parent = process.env.UPTOKEY_FRONTEND_BUNDLE || process.platform === "win32" ? join(core, "output") : tmpdir();
  await mkdir(parent, { recursive: true });
  // J21 restarts the core on the same directory (same data, vault file and pairing).
  const work = reuse ?? (await mkdtemp(join(parent, "uptokey-tui-frontend-")));
  await mkdir(join(work, "tui-home"), { recursive: true });
  await mkdir(join(work, "host-temp"), { recursive: true });
  const child = spawn(process.execPath, ["--experimental-strip-types", join(core, "scripts/tui-frontend-fixture.mjs"), work, ...extra], { cwd: core, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const lines = createInterface({ input: child.stdout });
  const info = await new Promise((resolveInfo, reject) => {
    const timer = setTimeout(() => reject(new Error("fixture core did not start")), 30000);
    lines.once("line", (line) => { clearTimeout(timer); try { resolveInfo(JSON.parse(line)); } catch (error) { reject(error); } });
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  const exited = new Promise((done) => child.once("exit", done));
  // Only the directory created above is ever removed; a restart keeps it.
  return {
    info,
    work,
    exited,
    stop: (keep = false) => {
      child.stdin.end();
      if (!keep) setTimeout(() => { if (work.includes("uptokey-tui-frontend-")) void rm(work, { recursive: true, force: true }).catch(() => undefined); }, 1500);
    },
  };
}

function childEnv(info, work, lang = "pt-BR") {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|processor_architecture|homedrive|homepath|uptokey_ffmpeg_path|uptokey_journey_open)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  const hostTemp = join(work, "host-temp");
  return Object.assign(env, { UPTOKEY_FIXTURE: JSON.stringify(info), UPTOKEY_QUIMERA_DATA_DIR: info.dirs.data, UPTOKEY_SETTINGS_DIR: info.dirs.settings, UPTOKEY_AUTOMATIONS_DIR: info.dirs.automations, UPTOKEY_TUI_HOME: join(work, "tui-home"), UPTOKEY_TUI_DEBUG_LOG: join(work, "backend-trace.jsonl"), UPTOKEY_LANG: lang, TEMP: hostTemp, TMP: hostTemp, TMPDIR: hostTemp, TERM: "xterm-256color", COLORTERM: "truecolor" });
}

async function run(name, body, extra = [], lang = "pt-BR") {
  await mkdir(output, { recursive: true });
  // J21 places a relay between the window and the core to cut it or lose an acknowledgement on purpose.
  const proxy = name === "restart" ? await startCoreProxy() : null;
  const fixtureArgs = proxy ? [...extra, "--allow-host", `127.0.0.1:${proxy.port}`, "--persist-secrets"] : extra;
  let fixture = await startFixture(fixtureArgs);
  if (proxy) {
    const direct = new URL(fixture.info.baseUrl);
    proxy.setTarget(direct.hostname, Number(direct.port));
    fixture.info.directBaseUrl = fixture.info.baseUrl;
    fixture.info.baseUrl = `http://127.0.0.1:${proxy.port}`;
  }
  // J21: the core process exits and a new one starts on the same data, vault file and pairing; the relay keeps the
  // window's address, as a daemon restarting on its fixed port would.
  const restartCore = async () => {
    const previous = fixture;
    previous.stop(true);
    await previous.exited;
    const next = await startFixture(fixtureArgs, previous.work);
    const direct = new URL(next.info.baseUrl);
    proxy.setTarget(direct.hostname, Number(direct.port));
    next.info.directBaseUrl = next.info.baseUrl;
    next.info.baseUrl = `http://127.0.0.1:${proxy.port}`;
    fixture = next;
    return next.info;
  };
  const bun = findExecutable("bun");
  // UPTOKEY_FRONTEND_BUNDLE=<dir> runs the distributable bundle (runtime/bun + fixture-entry.js) instead of the sources.
  const bundle = process.env.UPTOKEY_FRONTEND_BUNDLE;
  const env = childEnv(fixture.info, fixture.work, lang);
  if(name==='linear'){env.UPTOKEY_FIXTURE_LINEAR='1';env.UPTOKEY_LANG='en'}
  const open = async (dir = bundle) => {
    if (dir && name !== "linear") {
      const info = JSON.parse(await readFile(join(dir, "BUILD_INFO.json"), "utf8"));
      if (info.platform === "portable") {
        const runtime = resolvePortableRuntime(dir);
        return openPty({ file: runtime.runtime, args: [join(core, "scripts/lib/tui-packaged-fixture.mjs")], cwd: core,
          env: { ...env, ...runtime.env, UPTOKEY_FRONTEND_BUNDLE: resolve(dir), OTUI_TREE_SITTER_WORKER_PATH: join(dir, "opentui-tree-sitter-worker.js"), UPTOKEY_JS_DEBUG_ADAPTER: join(core, "vendor", "js-debug", "src", "dapDebugServer.js") } });
      }
    }
    return name === "linear"
    ? openPty({ file: process.execPath, args: dir ? [join(dir, "fixture-linear-entry.js")] : ["--experimental-transform-types", join(frontend, "uptokey/fixture-linear-entry.ts")], cwd: frontend, env })
    : dir
    ? openPty({ file: join(dir, "runtime", process.platform === "win32" ? "bun.exe" : "bun"), args: [join(dir, "fixture-entry.js")], cwd: core, env: { ...env, OTUI_TREE_SITTER_WORKER_PATH: join(dir, "opentui-tree-sitter-worker.js"), UPTOKEY_JS_DEBUG_ADAPTER: join(core, "vendor", "js-debug", "src", "dapDebugServer.js") } })
    : openPty({ file: bun, args: ["run", "uptokey/fixture-entry.tsx"], cwd: frontend, env });
  };
  let term = await open();
  // A second window on the same profile and core (J03): the previous one is closed first. J22 passes another
  // distributable directory to open the same profile with an updated (or the previous) frontend.
  const relaunch = async (dir) => { await term.close(); term = await open(dir); return term; };
  const checks = {};
  const shots = [];
  const capture = (title) => shots.push(`--- ${title} ---\n${term.screen()}`);
  let failure = null;
  let missingCapability = null;
  let result = "passed";
  const started = Date.now();
  try { await body({ term, checks, capture, info: fixture.info, relaunch, proxy, restartCore }); }
  catch (error) {
    failure = error;
    if (error instanceof HostCapabilityUnavailableError) missingCapability = error.missingCapability;
    result = missingCapability ? Object.keys(checks).length ? "partial" : "not_executed" : "failed";
    capture(`${missingCapability ? "UNEXECUTED CAPABILITY" : "FALHA"}: ${error.message.split("\n")[0]}`);
  }
  finally {
    // Bundle runs keep their own evidence next to the source runs (J22: the distributable outside the source tree).
    const tag = bundle ? `${name}-bundle` : name;
    await writeFile(join(output, `${tag}.txt`), shots.join("\n\n"));
    try { await writeFile(join(output, `${tag}.trace.jsonl`), await readFile(join(fixture.work, "backend-trace.jsonl"), "utf8")); } catch { /* no trace written */ }
    await writeFile(join(output, `${tag}.json`), JSON.stringify({ journey: name, date: new Date().toISOString(), runtime: bundle ? `bundle ${bundle}` : name==='linear'?'node':'bun', node:process.version, sourceHash, sourceStable:sourceHash===await fingerprint(join(core,'src')), artifactManifestSha256:bundle?createHash('sha256').update(await readFile(join(bundle,'BUILD_INFO.json'))).digest('hex'):null, command:[process.execPath,...process.argv.slice(1)], exitCode:missingCapability?2:failure?1:0, terminal: "ConPTY + xterm/headless", core: "isolated real app with scripted upstream", result, error: missingCapability ? null : failure?.message ?? null, missingCapability, unexecuted: missingCapability ? { code: failure.code, cause: failure.cause, steps: ["npm test", "npm run build"] } : null, checks, durationMs: Date.now() - started }, null, 2));
    await term.close();
    proxy?.close();
    fixture.stop();
  }
  if (failure && !missingCapability) throw failure;
  return { result, checks, ...(missingCapability ? { missingCapability, unexecuted: { code: failure.code, cause: failure.cause } } : {}) };
}

const available = {
  async linear({term,checks,capture,info}) {
    await term.until(()=>term.screen().includes('/help lists commands.'),'linear entry did not start',30000);
    assert.ok(!term.raw().includes('\x1b[?1049h'),'linear mode must not open an alternate screen');
    await term.send('mcp ordinary letters\r');
    await term.until(()=>term.raw().includes('Resposta do modelo de teste para: mcp ordinary letters'),'ordinary text did not reach the model',30000);
    await term.send('/models\r');
    await term.until(()=>term.screen().includes('Enter a number'),'linear model picker did not open');
    await term.send('1\r');
    await term.send('CORRIJA_SOMA\r');
    await term.until(()=>term.raw().includes('/approve accepts; /reject declines.'),'linear review did not appear',40000);
    await term.send('/approve\r');
    await term.until(async()=>/a \+ b/.test(await readFile(join(info.cwd,'math.js'),'utf8')),'linear approval did not apply',40000);
    checks.sameCoreApproval=true;checks.ordinaryLettersAreText=true;checks.noAlternateScreen=true;
    await term.send('/quit\r');
    await term.until(()=>term.exited().exited,'linear quit did not exit',10000);
    checks.exitsCleanly=true;capture('Linear output and approval');
  },
  async boot({ term, checks, capture }) {
    await term.until(() => /Uptokey|uptokey/i.test(term.screen()), "interface did not draw the brand", 30000);
    checks.brandVisible = true;
    await term.until(() => term.screen().includes("fixture-coder"), "selected model is not visible");
    checks.modelVisible = true;
    capture("1. primeira abertura");
    await term.send("\x03");
    await term.until(() => term.exited().exited, "Ctrl+C did not exit", 8000).catch(() => {});
  },
  async chat({ term, checks, capture, info }) {
    await term.until(() => term.screen().includes("fixture-coder"), "selected model is not visible", 30000);
    await term.send("mcp letras comuns");
    await term.until(() => term.screen().includes("mcp letras comuns"), "ordinary letters did not reach the composer");
    checks.ordinaryLettersAreText = true;
    await term.send("\x15");
    await term.send("Explique a soma");
    await term.send("\r");
    await term.until(() => term.screen().includes("Resposta do modelo de teste para: Explique a soma"), "streamed answer did not render", 30000);
    checks.streamedAnswerRendered = true;
    // The completed answer is replaced by the canonical message reloaded from the core: it must not blink.
    const samples = [];
    for (let index = 0; index < 50; index++) {
      samples.push(term.screen().includes("Resposta do modelo de teste para: Explique a soma") ? 1 : 0);
      await new Promise((done) => setTimeout(done, 40));
    }
    checks.answerVisibleSamples = samples.join("");
    assert.ok(samples.every(Boolean), `answer blinked after completion: ${samples.join("")}`);
    capture("2. resposta transmitida");
    assert.equal(info.provider, "custom-fixture");
  },
};

available.connect = connectJourney;
available.edit = editJourney;
available.commands = commandsJourney;
available.folder = folderJourney;
available.scroll = scrollJourney;
available.copy = copyJourney;
available.exit = exitJourney;
available.cancel = cancelJourney;
available.panels = panelsJourney;
available.slashlist = slashList;
available.sessions = sessionsJourney;
available.delegate = delegateJourney;
available.reopen = reopenJourney;
available.paste = pasteJourney;
available.conflict = conflictJourney;
available.network = networkJourney;
available.export = exportJourney;
available.temporary = temporaryJourney;
available.homonym = homonymJourney;
available.switch = switchJourney;
available.revoke = revokeJourney;
available.git = gitJourney;
available.runner = runnerJourney;
available.jev = jevJourney;
available.tools = toolsJourney;
available.voice = voiceJourney;
available.debug = debugJourney;
available.lsp = lspJourney;
available.restart = restartJourney;
available["switch-project"] = switchProjectJourney;
available["panels-more"] = panelsMoreJourney;
available.click = clickJourney;
available.search = searchJourney;
available.update = updateJourney;
available["runner-real"] = runnerRealJourney;
available.app = appJourney;
for (const lang of LOCALES) available[`locale-${lang}`] = localeJourney(lang);

const results = {};
for (const name of journeys) {
  try { results[name] = await run(name, available[name], name === "connect" ? ["--empty"] : name === "homonym" ? ["--homonym"] : name === "tools" || name === "search" ? ["--tools"] : name === "voice" ? ["--voice"] : [], name.startsWith("locale-") ? name.slice("locale-".length) : "pt-BR"); process.stdout.write(`${name}: ${results[name].result}${results[name].missingCapability ? ` (${results[name].missingCapability.capability}: ${results[name].missingCapability.cause})` : ""}\n`); }
  catch (error) { results[name] = { result: "failed", error: error.message.split("\n")[0] }; process.stdout.write(`${name}: FAILED ${error.message.split("\n").slice(0, 25).join("\n")}\n`); }
}
process.exit(Object.values(results).some((entry) => entry.result === "failed") ? 1 : Object.values(results).every((entry) => entry.result === "passed") ? 0 : 2);
