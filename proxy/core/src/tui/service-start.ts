import { spawn } from "node:child_process";
import { lstatSync, statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { createInterface } from "node:readline";
import { QUIMERA_ROOT } from "../../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import { TuiClient, type CoreHealth } from "./client.ts";
import { readLiveProxyPid } from "../daemon-lifecycle.ts";
import { assertQuimeraDataPath, resolveQuimeraDataDir } from "../paths.ts";
import { t } from "./i18n.ts";
import { currentCoreLaunchRuntime } from "./launch-runtime.ts";
import { PACKAGE_VERSION } from "../version.ts";
import { compareVersions, validUpdateVersion } from "../update-manifest.ts";
import { localAdminRequest } from "../local-admin-client.ts";
import { createOfficialSecretStore, resolveOfficialSecretService } from "../secret-store.ts";
import { serviceUpdateAccepted, serviceUpdateText } from "./service-update-ui.ts";

declare const UPTOKEY_BUILD_VERSION: string | undefined;

export type ServicePlan = { executable?: string; cwd: string; args: string[]; env: NodeJS.ProcessEnv };
const starting = new Map<string, Promise<void>>();
const adoptedPlans = new WeakMap<NodeJS.ProcessEnv, { dataDir: string; plan: ServicePlan }>();

export interface TuiServiceProfile {
  dataDir: string;
  source: "explicit" | "live-home" | "live-workspace" | "launcher";
  pid?: number;
}
export interface TuiServiceProfileDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  plan?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<ServicePlan>;
  readPid?: (path: string) => number;
}

/** Align local management with the existing daemon before loading identity/config.
 * Only known PID records are inspected; no configuration, credential or user data is read/moved.
 * An explicit caller profile always wins. Without one, ambiguity is an actionable error.
 */
export async function adoptTuiServiceProfile(cwd: string, deps: TuiServiceProfileDependencies = {}): Promise<TuiServiceProfile> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? homedir();
  const homeDir = resolveQuimeraDataDir(env, home);
  if (env.UPTOKEY_QUIMERA_DATA_DIR !== undefined) return { dataDir: homeDir, source: "explicit" };
  const plan = await (deps.plan ?? tuiServicePlan)(cwd, env);
  const workspaceDir = resolveQuimeraDataDir(plan.env, home);
  const pidReader = deps.readPid ?? readLiveProxyPid;
  const livePid = (directory: string): number | undefined => {
    try { return pidReader(join(directory, "proxy.pid")); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "proxy_not_running") return undefined;
      throw new Error("tui_service_profile_unreadable");
    }
  };
  const homePid = livePid(homeDir);
  const samePath = process.platform === "win32" ? homeDir.toLowerCase() === workspaceDir.toLowerCase() : homeDir === workspaceDir;
  const workspacePid = samePath ? undefined : livePid(workspaceDir);
  if (homePid !== undefined && workspacePid !== undefined) throw new Error("tui_service_profile_ambiguous");
  const useHome = homePid !== undefined;
  const selected = useHome ? homeDir : workspaceDir;
  // Validate all adopted paths before changing the environment (all-or-nothing).
  const controlDir = !useHome && plan.env.UPTOKEY_QUIMERA_CONTROL_DATA_DIR
    ? assertQuimeraDataPath(plan.env.UPTOKEY_QUIMERA_CONTROL_DATA_DIR) : undefined;
  env.UPTOKEY_QUIMERA_DATA_DIR = selected;
  if (controlDir && env.UPTOKEY_QUIMERA_CONTROL_DATA_DIR === undefined) env.UPTOKEY_QUIMERA_CONTROL_DATA_DIR = controlDir;
  if (!useHome) adoptedPlans.set(env, { dataDir: selected, plan });
  return { dataDir: selected, source: useHome ? "live-home" : workspacePid !== undefined ? "live-workspace" : "launcher", ...((homePid ?? workspacePid) === undefined ? {} : { pid: homePid ?? workspacePid }) };
}

/** Reuse the development launcher without bundling its executable main into the CLI. */
export async function tuiServicePlan(cwd: string, env = process.env, developmentPlan?: (env: NodeJS.ProcessEnv, root: string) => ServicePlan[]): Promise<ServicePlan> {
  const adopted = adoptedPlans.get(env);
  if (adopted && env.UPTOKEY_QUIMERA_DATA_DIR === adopted.dataDir) return adopted.plan;
  // The frontend can run in Bun or in the accessible Node entry. Neither is the
  // CLI entry; use only the exact core command transported by its launcher.
  const core = transportedCoreCommand(env);
  if (QUIMERA_ROOT && !env.UPTOKEY_QUIMERA_DATA_DIR) {
    const launcher = pathToFileURL(join(QUIMERA_ROOT, "scripts/quimera-local-dev.mjs")).href;
    const { localDevPlan } = developmentPlan ? { localDevPlan: developmentPlan } : await import(launcher) as {
      localDevPlan(env: NodeJS.ProcessEnv, root: string, options: Record<string, unknown>): ServicePlan[];
    };
    // A clone on disk does not mean a configured integration. The optional gateway
    // must be selected by its launcher; it must not prevent opening the base TUI.
    const plan = localDevPlan(env, QUIMERA_ROOT, {})[0];
    if (!plan) throw new Error("tui_service_plan_unavailable");
    return core ? { ...plan, executable: core.executable } : plan;
  }
  if (core) return { executable: core.executable, cwd, args: [...core.args, "start", "--no-tailnet"], env };
  const { executable, entry, execArgv } = currentCoreLaunchRuntime();
  // Installed Node/Bun CLI and compiled executable use the same profile they were launched with.
  const args = entry && /cli\.[cm]?[jt]s$/.test(entry)
    ? [...execArgv, resolve(entry), "start", "--no-tailnet"] : ["start", "--no-tailnet"];
  return { executable, cwd, args, env };
}

function transportedCoreCommand(env: NodeJS.ProcessEnv): { executable: string; args: string[] } | undefined {
  const executable = env.UPTOKEY_TUI_CORE_EXECUTABLE;
  const entry = env.UPTOKEY_TUI_CORE_ENTRY;
  const execArgv = env.UPTOKEY_TUI_CORE_EXEC_ARGV;
  if (executable === undefined && entry === undefined && execArgv === undefined) return undefined;
  try {
    if (!executable || !isAbsolute(executable) || !statSync(executable).isFile() || entry === undefined || execArgv === undefined) throw new Error();
    const prefix: unknown = JSON.parse(execArgv);
    if (!Array.isArray(prefix) || prefix.some(arg => typeof arg !== "string" || arg.includes("\0"))) throw new Error();
    if (entry && (!isAbsolute(entry) || !/cli\.[cm]?[jt]s$/.test(entry) || !statSync(entry).isFile())) throw new Error();
    if (!entry && prefix.length) throw new Error();
    return { executable, args: entry ? [...prefix, entry] : [] };
  } catch { throw new Error("tui_service_plan_unavailable"); }
}

export interface TuiServiceStartupDependencies {
  env?: NodeJS.ProcessEnv;
  home?: string;
  /** Injected only by isolated tests; normal launches use the compiled package version. */
  currentVersion?: string;
  interactive?: boolean;
  signal?: AbortSignal;
  health?: () => Promise<CoreHealth>;
  plan?: (cwd: string, env: NodeJS.ProcessEnv) => Promise<ServicePlan>;
  readPid?: (path: string) => number;
  pidRecordExists?: (path: string) => boolean;
  readAdminToken?: () => Promise<string | undefined>;
  authorizeStop?: (pid: number, token: string, signal?: AbortSignal) => Promise<number>;
  confirmUpdate?: () => Promise<boolean>;
  notice?: (message: string) => void;
  launch?: (plan: ServicePlan) => { failure?: Error; exit?: number | null };
  wait?: () => Promise<void>;
  stopAttempts?: number;
  readyAttempts?: number;
}

class ServiceUpdateError extends Error {
  constructor() { super(serviceUpdateText("failed")); this.name = "TuiServiceUpdateError"; }
}

const SERVICE_CHECK_ENV = "UPTOKEY_TUI_SERVICE_CHECK";
const releaseVersion = (value: string | undefined): string | undefined => {
  const prefixed = value?.startsWith("v") ? value : `v${value ?? ""}`;
  return validUpdateVersion(prefixed) ? prefixed : undefined;
};

/** Compare only a known compiled release; source-development's 0.1.0 fallback never replaces a release. */
export function olderTuiService(running: string | undefined, current: string): boolean {
  const previous = releaseVersion(running), next = releaseVersion(current);
  return previous !== undefined && next !== undefined && compareVersions(previous, next) < 0;
}

/** One conservative choice before changing a shared local process. Empty input/EOF decline; Ctrl+C cancels. */
async function confirmServiceUpdate(signal?: AbortSignal): Promise<boolean> {
  signal?.throwIfAborted();
  const input = createInterface({ input: process.stdin, output: process.stderr });
  return new Promise<boolean>((resolveChoice, reject) => {
    let finished = false;
    const finish = (answer: boolean, error?: Error) => {
      if (finished) return;
      finished = true;
      signal?.removeEventListener("abort", abort);
      input.close();
      if (error) reject(error); else resolveChoice(answer);
    };
    const abort = () => finish(false, Object.assign(new Error("service_update_cancelled"), { name: "AbortError" }));
    signal?.addEventListener("abort", abort, { once: true });
    input.once("SIGINT", abort);
    input.once("close", () => finish(false));
    input.question(serviceUpdateText("confirm"), answer => finish(serviceUpdateAccepted(answer)));
    if (signal?.aborted) abort();
  });
}

/** Join concurrent starts. An older service is replaced only after explicit opt-in and scoped administrative stop. */
export async function startSharedService(url: string, cwd: string, deps: TuiServiceStartupDependencies = {}): Promise<void> {
  const env = deps.env ?? process.env, home = deps.home ?? homedir();
  const profile = resolveQuimeraDataDir(env, home), namespace = resolveOfficialSecretService(env);
  const current = deps.currentVersion ?? PACKAGE_VERSION;
  const knownRelease = deps.currentVersion !== undefined || typeof UPTOKEY_BUILD_VERSION === "string";
  const key = JSON.stringify([url, profile, namespace, current]);
  const existing = starting.get(key);
  if (existing) return existing;
  const operation = (async () => {
    const signal = deps.signal;
    const interactive = deps.interactive ?? Boolean(process.stdin.isTTY && process.stdout.isTTY);
    const probe = deps.health ? undefined : new TuiClient({ baseUrl: url, ...(signal ? { signal } : {}) });
    const health = deps.health ?? (() => probe!.health());
    const readPid = deps.readPid ?? readLiveProxyPid;
    const pidPath = join(profile, "proxy.pid");
    const notice = deps.notice ?? ((message: string) => { process.stderr.write(`${message}\n`); });
    const wait = deps.wait ?? (() => delay(250, undefined, signal ? { signal } : undefined));
    const recordExists = deps.pidRecordExists ?? ((name: string) => {
      try { lstatSync(name); return true; }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error; }
    });
    const scopeUnchanged = () => {
      signal?.throwIfAborted();
      if (resolveQuimeraDataDir(env, home) !== profile || resolveOfficialSecretService(env) !== namespace) throw new ServiceUpdateError();
    };
    const planForProfile = async () => {
      const plan = await (deps.plan ?? tuiServicePlan)(cwd, env);
      scopeUnchanged();
      if (resolveQuimeraDataDir(plan.env, home) !== profile || resolveOfficialSecretService(plan.env) !== namespace) throw new ServiceUpdateError();
      return plan;
    };
    const acknowledge = (version: string, pid?: number) => {
      // A transient parent→frontend handoff only. No preference/file is persisted; no authority is granted.
      env[SERVICE_CHECK_ENV] = JSON.stringify({ url, profile, namespace, current, version, pid, at: Date.now() });
    };
    const acknowledged = (version: string, pid?: number): boolean => {
      try {
        const seen = JSON.parse(env[SERVICE_CHECK_ENV] ?? "null");
        return seen?.url === url && seen.profile === profile && seen.namespace === namespace && seen.current === current
          && seen.version === version && seen.pid === pid && Number.isFinite(seen.at) && Date.now() >= seen.at && Date.now() - seen.at < 300_000;
      } catch { return false; }
    };
    const launch = (plan: ServicePlan) => {
      if (deps.launch) return deps.launch(plan);
      const state: { failure?: Error; exit?: number | null } = {};
      const child = spawn(plan.executable ?? process.execPath, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: "ignore", windowsHide: true });
      child.once("error", () => { state.failure = new Error(t("svc_start_failed")); });
      child.once("exit", code => { state.exit = code; });
      child.unref();
      return state;
    };
    const start = async (plan: ServicePlan, updated: boolean) => {
      scopeUnchanged();
      const child = launch(plan);
      const deadline = Date.now() + 30_000;
      for (let i = 0; i < (deps.readyAttempts ?? 120) && Date.now() < deadline; i++) {
        const state = await health();
        scopeUnchanged();
        if (state.status === "ok") {
          if (knownRelease && (!releaseVersion(state.version) || olderTuiService(state.version, current))) throw new ServiceUpdateError();
          delete env[SERVICE_CHECK_ENV];
          return;
        }
        if (child.failure) throw child.failure;
        if (child.exit !== undefined) throw new Error(t("svc_exited", { code: child.exit ?? t("svc_signal") }));
        await wait();
      }
      if (updated) throw new ServiceUpdateError();
      throw new Error(t("svc_not_ready"));
    };
    let updating = false;
    try {
      scopeUnchanged();
      const initial = await health();
      scopeUnchanged();
      if (initial.status !== "ok") {
        if (new URL(url).port !== "21435") throw new Error(t("svc_port_mismatch"));
        await start(await planForProfile(), false);
        return;
      }
      if (!knownRelease) return;
      const running = releaseVersion(initial.version);
      if (!running) {
        const unknown = (initial.version ?? "").slice(0, 100);
        if (!acknowledged(unknown)) notice(serviceUpdateText("unknown"));
        acknowledge(unknown);
        return;
      }
      if (!olderTuiService(running, current)) { delete env[SERVICE_CHECK_ENV]; return; }
      // The administrative endpoint intentionally targets this exact local management origin.
      if (new URL(url).href !== "http://127.0.0.1:21435/") {
        if (!acknowledged(initial.version ?? "")) notice(serviceUpdateText("needed"));
        acknowledge(initial.version ?? "");
        return;
      }
      let pid: number;
      try { pid = readPid(pidPath); } catch {
        if (!acknowledged(initial.version ?? "")) notice(serviceUpdateText("needed"));
        acknowledge(initial.version ?? "");
        return;
      }
      if (acknowledged(initial.version ?? "", pid)) return;
      if (!interactive || !await (deps.confirmUpdate ?? (() => confirmServiceUpdate(signal)))()) {
        scopeUnchanged();
        notice(serviceUpdateText("needed"));
        acknowledge(initial.version ?? "", pid);
        return;
      }
      updating = true;
      const plan = await planForProfile();
      const token = await (deps.readAdminToken ?? (() => createOfficialSecretStore(process.platform, process.execPath, undefined, namespace).get("local:api-token")))();
      scopeUnchanged();
      if (!token) throw new ServiceUpdateError();
      const check = await health();
      scopeUnchanged();
      if (check.status !== "ok" || check.version !== initial.version || readPid(pidPath) !== pid) throw new ServiceUpdateError();
      const authorizeStop = deps.authorizeStop ?? ((expected: number, admin: string, abortSignal?: AbortSignal) => {
        // localAdminRequest uses only the fetch call; Bun's optional preconnect extension is not involved.
        const scopedFetch = ((target, init) => fetch(target, { ...init, signal: AbortSignal.any([...(init?.signal ? [init.signal] : []), ...(abortSignal ? [abortSignal] : [])]) })) as typeof fetch;
        return localAdminRequest("/local/update/authorize-stop", admin, { pid: expected }, scopedFetch);
      });
      const status = await authorizeStop(pid, token, signal);
      scopeUnchanged();
      if (status !== 204) throw new ServiceUpdateError();
      let stopped = false;
      const stopDeadline = Date.now() + 20_000;
      for (let i = 0; i < (deps.stopAttempts ?? 80) && Date.now() < stopDeadline; i++) {
        const state = await health();
        scopeUnchanged();
        if (!recordExists(pidPath) && state.status !== "ok") { stopped = true; break; }
        // A replacement PID belongs to a concurrent launcher; do not touch or replace it.
        if (recordExists(pidPath)) {
          try { if (readPid(pidPath) !== pid) throw new ServiceUpdateError(); }
          catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT" && (!(error instanceof Error) || error.message !== "proxy_not_running")) throw error;
          }
        }
        await wait();
      }
      scopeUnchanged();
      if (!stopped || recordExists(pidPath) || (await health()).status === "ok") throw new ServiceUpdateError();
      scopeUnchanged();
      await start(plan, true);
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") throw error;
      if (updating) throw new ServiceUpdateError();
      throw error;
    } finally { probe?.destroy(); }
  })();
  starting.set(key, operation);
  try { await operation; } finally { if (starting.get(key) === operation) starting.delete(key); }
}
