#!/usr/bin/env node
// Clean-install acceptance harness: installs a candidate tarball in an
// isolated npm prefix and temporary profile, then exercises the real CLI.
// The user's daemon, profile and vault are never touched. Port 21435
// occupancy is probed first: with a free port the full start/health flow
// runs; with an occupied port (user daemon running) the harness records the
// real conflict behavior instead of pretending a second instance started.
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, lstatSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { frontendPackageFiles } from "./beta-runtime-contract.mjs";
import { resolvePortableRuntime } from "../src/tui/portable-runtime.mjs";

const coreRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const evidenceRoot = resolve(coreRoot, "../../output/beta-clean-install");

/** Argument validation is side-effect free; evidence directories are created only by main. */
export function parseCleanInstallArguments(args, cwd = process.cwd()) {
  if (!Array.isArray(args) || args.some(arg => typeof arg !== "string" || !arg.trim() || arg.includes("\0"))) throw new Error("clean_install_arguments_invalid");
  let candidate, outDir;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out-dir") {
      const value = args[++index];
      if (outDir !== undefined || value === undefined || value.startsWith("-")) throw new Error("clean_install_arguments_invalid");
      outDir = resolve(cwd, value);
    } else if (arg.startsWith("-") || candidate !== undefined) throw new Error("clean_install_arguments_invalid");
    else candidate = arg;
  }
  if (candidate === undefined || !/\.(?:tgz|tar\.gz)$/i.test(candidate)) throw new Error("clean_install_arguments_invalid");
  return { tarball: resolve(cwd, candidate), ...(outDir !== undefined ? { outDir } : {}) };
}

function createEvidenceDirectory(requested) {
  if (requested) {
    mkdirSync(requested, { recursive: true });
    if (!lstatSync(requested).isDirectory() || lstatSync(requested).isSymbolicLink()) throw new Error("clean_install_evidence_directory_invalid");
    if (existsSync(join(requested, "clean-install-receipt.json"))) throw new Error("clean_install_evidence_exists");
    return requested;
  }
  mkdirSync(evidenceRoot, { recursive: true });
  return mkdtempSync(join(evidenceRoot, `${new Date().toISOString().replaceAll(":", "-")}-`));
}

const NPM_CLI = process.platform === "win32"
  ? join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js")
  : null;

function run(command, args, options = {}) {
  return spawnSync(command, args, { encoding: "utf8", windowsHide: true, timeout: options.timeout ?? 180_000, ...options });
}

export function isolatedCleanInstallEnv(base, inherited = process.env) {
  const env = {
    ...inherited,
    HOME: join(base, "home"),
    USERPROFILE: join(base, "home"),
    APPDATA: join(base, "home", "AppData", "Roaming"),
    LOCALAPPDATA: join(base, "home", "AppData", "Local"),
    XDG_CONFIG_HOME: join(base, "config"),
    XDG_DATA_HOME: join(base, "data"),
    XDG_STATE_HOME: join(base, "state"),
    XDG_CACHE_HOME: join(base, "cache"),
    UPTOKEY_QUIMERA_DATA_DIR: join(base, "data"),
    UPTOKEY_QUIMERA_CONTROL_DATA_DIR: join(base, "control"),
    CONTROL_DATA_DIR: join(base, "control"),
    UPTOKEY_SETTINGS_DIR: join(base, "settings"),
    UPTOKEY_AUTOMATIONS_DIR: join(base, "automations"),
    UPTOKEY_CONVERSATIONS_DIR: join(base, "conversations"),
    UPTOKEY_OFFLINE_TTL_DISABLED: "1",
    UPTOKEY_TUI_CONFIG_DIR: join(base, "tui-config"),
    UPTOKEY_TUI_HOME: join(base, "tui-home"),
    UPTOKEY_LANG: "en",
    LANG: "en_US.UTF-8",
    LC_ALL: "en_US.UTF-8",
  };
  // A developer's selected frontend must never replace the frontend installed from this candidate.
  for (const key of ["UPTOKEY_TUI_FRONTEND", "UPTOKEY_TUI_FRONTEND_DIR", "UPTOKEY_BUN", "UPTOKEY_TUI_CALLER_CWD", "UPTOKEY_TUI_HANDOFF_FD", "UPTOKEY_TUI_STATS"]) delete env[key];
  return env;
}

/** Resolve both installed presentations from the validated product manifest. */
export function installedTerminalSmokePlan(packageRoot, info, node = process.execPath) {
  frontendPackageFiles(info);
  const frontend = join(packageRoot, "dist", "tui");
  const cli = join(packageRoot, "dist", "cli.js");
  return [
    { step: "tui_frontend_help", command: info.platform === "portable" ? resolvePortableRuntime(frontend).runtime : join(frontend, info.runtime), args: [join(frontend, info.entry), "--help"] },
    { step: "tui_accessible_help", command: node, args: [join(frontend, info.accessibleEntry), "--help"] },
    ...["tui", "code", "forge"].map(alias => ({ step: `cli_${alias}_help`, command: node, args: [cli, alias, "--lang", "en", "--help"] })),
  ];
}

function portInUse(port) {
  return new Promise(resolveUse => {
    const probe = createServer();
    probe.once("error", () => resolveUse(true));
    probe.once("listening", () => probe.close(() => resolveUse(false)));
    probe.listen(port, "127.0.0.1");
  });
}

async function fetchJson(url) {
  try {
    const response = await fetch(url, { redirect: "error", signal: AbortSignal.timeout(5000), headers: { Host: "127.0.0.1:21435" } });
    return { status: response.status, body: await response.text().catch(() => "") };
  } catch (error) {
    return { status: 0, error: error instanceof Error ? error.code ?? "fetch_failed" : "fetch_failed" };
  }
}

async function main() {
  let parsed, outputDir;
  try {
    parsed = parseCleanInstallArguments(process.argv.slice(2));
    if (!existsSync(parsed.tarball) || !lstatSync(parsed.tarball).isFile()) throw new Error("clean_install_candidate_missing");
    outputDir = createEvidenceDirectory(parsed.outDir);
  } catch (error) {
    const publicCode = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : "clean_install_arguments_invalid";
    process.stderr.write(`${publicCode}\nusage: node beta-clean-install.mjs <candidate.tgz> [--out-dir <unique-evidence-dir>]\n`);
    process.exitCode = 1;
    return;
  }
  const { tarball } = parsed;
  const work = mkdtempSync(join(tmpdir(), "uptokey-clean-install-"));
  const prefix = join(work, "prefix");
  const profile = join(work, "profile");
  const observations = [];
  const start = Date.now();
  try {
    const npmExecutable = NPM_CLI ? process.execPath : "npm";
    const npmArgs = NPM_CLI
      ? [NPM_CLI, "install", "--prefix", prefix, tarball, "--no-audit", "--no-fund", "--loglevel=error"]
      : ["install", "--prefix", prefix, tarball, "--no-audit", "--no-fund", "--loglevel=error"];
    const install = run(npmExecutable, npmArgs, { env: process.env });
    observations.push({ step: "npm_install", exitCode: install.status, passed: install.status === 0, stderrTail: (install.stderr || "").split("\n").filter(Boolean).at(-1) ?? "" });
    if (install.status !== 0) throw new Error("clean_install_npm_failed");

    const packageRoot = join(prefix, "node_modules", "uptokey");
    const cli = join(packageRoot, "dist", "cli.js");
    const env = isolatedCleanInstallEnv(profile);
    const frontend = join(packageRoot, "dist", "tui");
    const frontendInfo = JSON.parse(readFileSync(join(frontend, "BUILD_INFO.json"), "utf8"));
    const terminalEnv = { ...env, ...(frontendInfo.platform === "portable" ? resolvePortableRuntime(frontend).env : {}), OTUI_TREE_SITTER_WORKER_PATH: join(frontend, "opentui-tree-sitter-worker.js") };
    for (const smoke of installedTerminalSmokePlan(packageRoot, frontendInfo)) {
      const result = run(smoke.command, smoke.args, { env: terminalEnv, cwd: work, timeout: 30_000 });
      observations.push({ step: smoke.step, exitCode: result.status,
        passed: result.status === 0 && /^Usage: uptokey \[folder\] \[options\]/m.test(result.stdout || ""),
        stdoutTail: (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) ?? "",
        stderrTail: (result.stderr || "").trim().split("\n").filter(Boolean).at(-1) ?? "" });
    }
    for (const [step, argv] of [["version", ["version"]], ["license", ["license"]], ["doctor", ["doctor"]]]) {
      const result = run(process.execPath, [cli, ...argv], { env });
      observations.push({ step, exitCode: result.status, passed: result.status === 0, stdout: (result.stdout || "").trim().split("\n").filter(Boolean).at(-1) ?? "", stderrTail: (result.stderr || "").trim().split("\n").filter(Boolean).at(-1) ?? "" });
    }

    const occupied = await portInUse(21435);
    if (occupied) {
      observations.push({ step: "port_probe", port: 21435, state: "occupied", passed: true, note: "user daemon detected; start scenario exercised as expected conflict" });
      const result = run(process.execPath, [cli, "start", "--no-tailnet"], { env, timeout: 30_000 });
      observations.push({ step: "start_occupied_port", exitCode: result.status, passed: result.status !== 0 && /port_in_use|EADDRINUSE|uptokey_command_failed/i.test(`${result.stdout}\n${result.stderr}`), stdoutTail: (result.stdout || "").split("\n").filter(Boolean).at(-1) ?? "", stderrTail: (result.stderr || "").split("\n").filter(Boolean).at(-1) ?? "" });
    } else {
      observations.push({ step: "port_probe", port: 21435, state: "free", passed: true });
      const child = spawn(process.execPath, [cli, "start", "--no-tailnet"], { env, stdio: ["ignore", "ignore", "ignore"], windowsHide: true });
      let health = { status: 0 };
      for (let attempt = 0; attempt < 30; attempt += 1) {
        await new Promise(resolveDelay => setTimeout(resolveDelay, 1000));
        health = await fetchJson("http://127.0.0.1:21435/health");
        if (health.status !== 0) break;
      }
      const ui = health.status !== 0 ? await fetchJson("http://127.0.0.1:21435/ui") : { status: 0 };
      const models = health.status !== 0 ? await fetchJson("http://127.0.0.1:21435/v1/models") : { status: 0 };
      observations.push(
        { step: "daemon_health", status: health.status, passed: health.status === 200 },
        { step: "daemon_ui", status: ui.status, passed: ui.status === 200 },
        { step: "daemon_v1_models_unauthenticated", status: models.status, passed: models.status === 401 },
      );
      child.kill();
      await new Promise(resolveWait => setTimeout(resolveWait, 1500));
      observations.push({ step: "daemon_stop", passed: child.exitCode !== null || child.killed });
      // POSIX npm exposes a symlink named `uptokey`, not dist/cli.js.
      // Exercise that actual interactive entry on Linux/macOS as well as the
      // explicit service command above; help alone cannot prove auto-start.
      if (process.platform !== "win32") {
        const requireInstalled = createRequire(join(packageRoot, "package.json"));
        const pty = requireInstalled("@lydell/node-pty");
        const installedBin = join(prefix, "node_modules", ".bin", "uptokey");
        let stopped = false;
        const terminal = pty.spawn(installedBin, ["--screen-reader", "--cwd", work], {
          name: "xterm-256color", cols: 100, rows: 30, cwd: work,
          env: { ...terminalEnv, TERM: "xterm-256color" },
        });
        terminal.onData(() => {}); // Do not retain conversation or credential output.
        terminal.onExit(() => { stopped = true; });
        let ready = { status: 0 };
        try {
          for (let attempt = 0; attempt < 40; attempt++) {
            ready = await fetchJson("http://127.0.0.1:21435/health");
            if (ready.status || stopped) break;
            await new Promise(wait => setTimeout(wait, 250));
          }
          observations.push({ step: "npm_bin_auto_start", passed: ready.status === 200, status: ready.status, entry: "npm bin symlink with real PTY" });
        } finally {
          if (!stopped) terminal.kill();
          const pidFile = join(env.UPTOKEY_QUIMERA_DATA_DIR, "proxy.pid");
          if (existsSync(pidFile)) {
            const pid = Number(readFileSync(pidFile, "utf8").trim());
            if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("clean_install_pid_invalid");
            try { process.kill(pid, "SIGTERM"); } catch (error) { if (error.code !== "ESRCH") throw error; }
          }
          let closed = false;
          for (let attempt = 0; attempt < 20; attempt++) {
            if ((await fetchJson("http://127.0.0.1:21435/health")).status === 0) { closed = true; break; }
            await new Promise(wait => setTimeout(wait, 250));
          }
          observations.push({ step: "npm_bin_daemon_stop", passed: closed });
        }
      }
    }

    const passed = observations.filter(item => item.passed).length;
    const receipt = {
      schema: "uptokey-beta-clean-install-v1",
      checkedAtUtc: new Date().toISOString(),
      tarball,
      evidenceDirectory: outputDir,
      node: process.version,
      durationMs: Date.now() - start,
      observations,
      summary: { steps: observations.length, passed, result: passed === observations.length ? "approved" : "partial" },
      redactions: ["no_secrets_printed", "synthetic_temp_profile_only"],
    };
    writeFileSync(join(outputDir, "clean-install-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", { flag: "wx" });
    process.stdout.write(JSON.stringify({ ...receipt.summary, receipt: join(outputDir, "clean-install-receipt.json") }) + "\n");
    process.exitCode = passed === observations.length ? 0 : 2;
  } catch (error) {
    const errorCode = error instanceof Error && /^[a-z0-9_:-]+$/i.test(error.message) ? error.message : "unexpected";
    writeFileSync(join(outputDir, "clean-install-receipt.json"), JSON.stringify({
      schema: "uptokey-beta-clean-install-v1",
      checkedAtUtc: new Date().toISOString(),
      tarball,
      evidenceDirectory: outputDir,
      error: errorCode,
      observations,
    }, null, 2) + "\n", { flag: "wx" });
    process.exitCode = 1;
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
