import { spawn } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { homedir } from "node:os";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import { QUIMERA_ROOT } from "../../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import { TuiClient } from "./client.ts";
import { readLiveProxyPid } from "../daemon-lifecycle.ts";
import { assertQuimeraDataPath, resolveQuimeraDataDir } from "../paths.ts";
import { t } from "./i18n.ts";
import { currentCoreLaunchRuntime } from "./launch-runtime.ts";

export type ServicePlan = { executable?: string; cwd: string; args: string[]; env: NodeJS.ProcessEnv };
let starting: Promise<void> | undefined;
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

/** Join concurrent starts; never restart a running service or silently select a different port. */
export async function startSharedService(url: string, cwd: string): Promise<void> {
  const probe = new TuiClient({ baseUrl: url });
  try { if ((await probe.health()).status === "ok") return; } finally { probe.destroy(); }
  if (new URL(url).port !== "21435") throw new Error(t("svc_port_mismatch"));
  if (starting) return starting;
  starting = (async () => {
    const plan = await tuiServicePlan(cwd);
    let failure: Error | undefined;
    let exit: number | null | undefined;
    const child = spawn(plan.executable ?? process.execPath, plan.args, { cwd: plan.cwd, env: plan.env, detached: true, stdio: "ignore", windowsHide: true });
    child.once("error", () => { failure = new Error(t("svc_start_failed")); });
    child.once("exit", code => { exit = code; });
    child.unref();
    const client = new TuiClient({ baseUrl: url });
    try {
      for (let i = 0; i < 120; i++) {
        if ((await client.health()).status === "ok") return;
        if (failure) throw failure;
        if (exit !== undefined) throw new Error(t("svc_exited", { code: exit ?? t("svc_signal") }));
        await delay(250);
      }
      throw new Error(t("svc_not_ready"));
    } finally { client.destroy(); }
  })();
  try { await starting; } finally { starting = undefined; }
}
