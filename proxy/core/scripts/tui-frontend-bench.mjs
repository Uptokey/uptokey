import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * Measures the real frontend process in a real terminal: time to first frame and to a ready prompt, key echo latency
 * while idle and while an answer streams, resident memory idle / after a long history.
 *   node --experimental-strip-types scripts/tui-frontend-bench.mjs [--runs 3] [--lines 20000]
 * UPTOKEY_FRONTEND_BUNDLE=<dir> measures the distributable bundle instead of the sources.
 * Writes output/tui-canonica/<execution>/bench[-bundle].json (hardware, versions, every sample).
 */
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import { findExecutable, openPty } from "./lib/pty-session.mjs";

const core = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = tuiEvidenceDirectory(core);
const frontend = join(core, "src/tui/frontend");
const arg = (name, fallback) => { const index = process.argv.indexOf(name); return index >= 0 ? Number(process.argv[index + 1]) : fallback; };
const runs = arg("--runs", 3);
const bigLines = arg("--lines", 20000); // logical lines of history, in 1000-line turns (the core caps one answer)
const bundle = process.env.UPTOKEY_FRONTEND_BUNDLE;
const CLEAR_LINE = "\x15";

const percentile = (values, p) => { const sorted = [...values].sort((a, b) => a - b); return sorted.length ? sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] : null; };
const stats = (values) => ({ n: values.length, p50: percentile(values, 50), p95: percentile(values, 95), max: Math.max(...values, 0) });
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

async function startFixture() {
  // Keep benchmark state in the evidence tree. Some Windows security profiles allow
  // creating a temporary directory but deny a child runtime from reopening it.
  const workRoot = join(output, "work");
  await mkdir(workRoot, { recursive: true });
  const work = await mkdtemp(join(workRoot, "uptokey-tui-frontend-bench-"));
  const child = spawn(process.execPath, ["--experimental-strip-types", join(core, "scripts/tui-frontend-fixture.mjs"), work], { cwd: core, stdio: ["pipe", "pipe", "inherit"], windowsHide: true });
  const info = await new Promise((resolveInfo, reject) => {
    createInterface({ input: child.stdout }).once("line", (line) => resolveInfo(JSON.parse(line)));
    child.once("exit", (code) => reject(new Error(`fixture exited ${code}`)));
  });
  return { info, work, stop: () => { child.stdin.end(); setTimeout(() => void rm(work, { recursive: true, force: true }).catch(() => undefined), 1500); } };
}

function envFor(info, work, statsFile) {
  const allowed = /^(path|pathext|systemroot|windir|comspec|temp|tmp|userprofile|localappdata|appdata|programfiles|programfiles\(x86\)|processor_architecture)$/i;
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => allowed.test(key)));
  return Object.assign(env, { UPTOKEY_FIXTURE: JSON.stringify(info), UPTOKEY_QUIMERA_DATA_DIR: info.dirs.data, UPTOKEY_SETTINGS_DIR: info.dirs.settings, UPTOKEY_AUTOMATIONS_DIR: info.dirs.automations, UPTOKEY_TUI_HOME: join(work, "tui-home"), UPTOKEY_TUI_STATS: statsFile, UPTOKEY_TUI_DEBUG_LOG: join(work, "trace.jsonl"), UPTOKEY_LANG: "pt-BR", TERM: "xterm-256color", COLORTERM: "truecolor" });
}

/** Time from writing a key to seeing it on the terminal screen model (parse time of the harness included). */
async function echoLatency(term, text, gapMs = 60) {
  const samples = [];
  for (const ch of text) {
    const before = term.screen();
    const started = performance.now();
    term.child.write(ch);
    for (;;) {
      await term.until(() => true, "parsed", 1000);
      const now = term.screen();
      if (now !== before && now.includes(ch)) break;
      if (performance.now() - started > 3000) break;
      await wait(2);
    }
    samples.push(performance.now() - started);
    await wait(gapMs);
  }
  return samples;
}

async function readStats(file) { try { return JSON.parse(await readFile(file, "utf8")); } catch { return null; } }

async function oneRun() {
  const fixture = await startFixture();
  const statsFile = join(fixture.work, "stats.json");
  const env = envFor(fixture.info, fixture.work, statsFile);
  const spawnedAt = performance.now();
  const term = bundle
    ? await openPty({ file: join(bundle, "runtime", process.platform === "win32" ? "bun.exe" : "bun"), args: [join(bundle, "fixture-entry.js")], cwd: core, env: { ...env, OTUI_TREE_SITTER_WORKER_PATH: join(bundle, "opentui-tree-sitter-worker.js") } })
    : await openPty({ file: findExecutable("bun"), args: ["run", "uptokey/fixture-entry.tsx"], cwd: frontend, env });
  const result = {};
  try {
    await term.until(() => /█▀▀▀▄|▀▀▀▀▀▀/.test(term.screen()), "no first frame", 60000);
    result.firstFrameMs = performance.now() - spawnedAt;
    result.firstByteMs = (term.firstDataAt() ?? performance.now()) - spawnedAt;
    await term.until(() => term.screen().includes("fixture-coder"), "not ready", 60000);
    result.readyMs = performance.now() - spawnedAt;
    // In-process milestones (Bun's clock starts with the process): the part of the first frame owned by the frontend.
    try {
      const marks = Object.fromEntries((await readFile(join(fixture.work, "trace.jsonl"), "utf8")).split(String.fromCharCode(10)).filter(Boolean).map((line) => JSON.parse(line)).filter((entry) => typeof entry.sinceStartMs === "number").map((entry) => [entry.event, entry.sinceStartMs]));
      result.inProcessHomeMs = marks["boot.home_mounted"] ?? null;
      result.inProcessMainMs = marks["boot.main"] ?? null;
    } catch { /* trace unavailable */ }
    await wait(1200);
    result.idleRssMiB = (await readStats(statsFile))?.rss / 1048576;
    result.idleEchoMs = await echoLatency(term, "abcdefghij");
    term.child.write(CLEAR_LINE);
    await wait(300);
    // Echo latency while an answer streams.
    term.child.write("LONGA resposta\r");
    await term.until(() => /LINHA_?010/.test(term.screen()), "stream did not start", 30000);
    result.streamEchoMs = await echoLatency(term, "klmnopqrstuv");
    await term.until(() => /LINHA_?160/.test(term.screen()), "stream did not finish", 60000);
    // A long history: many turns of 1000 lines each, then memory and responsiveness.
    const turns = Math.max(1, Math.round(bigLines / 1000));
    const heavyStart = performance.now();
    for (let turn = 0; turn < turns; turn++) {
      term.child.write(CLEAR_LINE);
      await wait(150);
      term.child.write("ENORME1000\r");
      await wait(400);
      await term.until(() => /Linha 001000/.test(term.screen()) && !/esc\s+(interromper|interrupt)/.test(term.screen()), `turn ${turn + 1} did not finish`, 120000);
    }
    result.hugeAnswerSeconds = (performance.now() - heavyStart) / 1000;
    result.historyLines = turns * 1000;
    await wait(1000);
    const after = await readStats(statsFile);
    result.hugeRssMiB = after?.rss / 1048576;
    result.hugePeakRssMiB = after?.peakRss / 1048576;
    result.afterHugeEchoMs = await echoLatency(term, "uvwxyz");
  } finally {
    await term.close();
    fixture.stop();
  }
  return result;
}

/**
 * Host baseline under the same ConPTY + xterm harness: the same runtime starting a trivial script that prints at
 * once and echoes raw input. Its first byte is the process-spawn cost of this host; its echo is the terminal path.
 */
async function baseline() {
  const runtime = bundle ? join(bundle, "runtime", process.platform === "win32" ? "bun.exe" : "bun") : findExecutable("bun");
  const script = "process.stdout.write('ready');process.stdin.setRawMode?.(true);process.stdin.on('data',(d)=>process.stdout.write(d));";
  const spawnedAt = performance.now();
  const term = await openPty({ file: runtime, args: ["-e", script], cwd: core, env: { ...process.env } });
  try {
    await term.until(() => term.screen().includes("ready"), "baseline did not start", 30000);
    const firstByteMs = (term.firstDataAt() ?? performance.now()) - spawnedAt;
    const echoMs = await echoLatency(term, "abcdefghijklmnopqrst");
    return { firstByteMs, echoMs };
  } finally {
    await term.close();
  }
}

const baselines = [];
for (let index = 0; index < runs; index++) baselines.push(await baseline());

const samples = [];
for (let index = 0; index < runs; index++) {
  const sample = await oneRun();
  samples.push(sample);
  process.stdout.write(`run ${index + 1}: first byte ${Math.round(sample.firstByteMs)} ms, first frame ${Math.round(sample.firstFrameMs)} ms, ready ${Math.round(sample.readyMs)} ms, idle ${sample.idleRssMiB?.toFixed(0)} MiB, history ${sample.historyLines} lines ${sample.hugeRssMiB?.toFixed(0)} MiB\n`);
}

const summary = {
  hostBaselineFirstByteMs: stats(baselines.map((entry) => entry.firstByteMs)),
  hostBaselineEchoMs: stats(baselines.flatMap((entry) => entry.echoMs)),
  inProcessHomeMs: stats(samples.map((entry) => entry.inProcessHomeMs).filter((value) => typeof value === "number")),
  inProcessMainMs: stats(samples.map((entry) => entry.inProcessMainMs).filter((value) => typeof value === "number")),
  firstByteMs: stats(samples.map((entry) => entry.firstByteMs)),
  firstFrameMs: stats(samples.map((entry) => entry.firstFrameMs)),
  readyMs: stats(samples.map((entry) => entry.readyMs)),
  idleRssMiB: stats(samples.map((entry) => entry.idleRssMiB)),
  idleEchoMs: stats(samples.flatMap((entry) => entry.idleEchoMs)),
  streamEchoMs: stats(samples.flatMap((entry) => entry.streamEchoMs)),
  hugeAnswerSeconds: stats(samples.map((entry) => entry.hugeAnswerSeconds)),
  hugeRssMiB: stats(samples.map((entry) => entry.hugeRssMiB)),
  hugePeakRssMiB: stats(samples.map((entry) => entry.hugePeakRssMiB)),
  afterHugeEchoMs: stats(samples.flatMap((entry) => entry.afterHugeEchoMs)),
};
await mkdir(output, { recursive: true });
await writeFile(join(output, bundle ? "bench-bundle.json" : "bench.json"), JSON.stringify({
  date: new Date().toISOString(), runtime: bundle ? "bundle (bun runtime)" : "sources (bun run)", node: process.version,
  hardware: { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memoryGiB: Math.round(os.totalmem() / 1073741824), platform: `${os.platform()} ${os.release()}` },
  terminal: "ConPTY + xterm/headless 120x36 (harness parse time is part of every echo sample)", core: "isolated real app with scripted upstream", historyLines: bigLines, runs, summary, samples,
}, null, 2));
console.log(JSON.stringify(summary, null, 1));
