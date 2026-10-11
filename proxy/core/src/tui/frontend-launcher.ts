/**
 * Launches the OpenTUI terminal frontend, which runs in its own Bun process while the core keeps its Node runtime.
 *
 * Installed artifacts and development sources use the same backend and presentation.
 */
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { currentCoreLaunchRuntime } from "./launch-runtime.ts";
import { resolvePortableRuntime } from "./portable-runtime.mjs";

export interface FrontendCommand {
  file: string;
  args: string[];
  cwd?: string;
  kind: "explicit" | "bundle" | "compiled" | "development";
  env?: Record<string, string>;
}

/** Preserve the launching core command when the presentation changes runtimes. */
export function frontendCoreLaunchEnv(runtime: { executable: string; entry?: string; execArgv: readonly string[] } = {
  ...currentCoreLaunchRuntime(),
}): Record<string, string> {
  const entry = runtime.entry && /cli\.[cm]?[jt]s$/.test(runtime.entry) ? resolve(runtime.entry) : "";
  return {
    UPTOKEY_TUI_CORE_EXECUTABLE: runtime.executable,
    UPTOKEY_TUI_CORE_ENTRY: entry,
    UPTOKEY_TUI_CORE_EXEC_ARGV: JSON.stringify(entry ? runtime.execArgv : []),
  };
}

function onPath(name: string, env: NodeJS.ProcessEnv): string | null {
  const extensions = process.platform === "win32" ? [".exe", ".cmd", ""] : [""];
  for (const dir of (env.PATH ?? env.Path ?? "").split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(dir, name + extension);
      if (dir && existsSync(candidate)) return candidate;
    }
  }
  return null;
}

function bundleIn(artifact: string): FrontendCommand | null {
  const manifest = join(artifact, "BUILD_INFO.json");
  if (existsSync(manifest)) {
    try {
      const info = JSON.parse(readFileSync(manifest, "utf8"));
      if (info.platform === "portable") {
        const { runtime, env } = resolvePortableRuntime(artifact);
        if (!existsSync(join(artifact, "main.js"))) return null;
        return { file: runtime, args: [join(artifact, "main.js")], kind: "bundle", env: { ...env, OTUI_TREE_SITTER_WORKER_PATH: join(artifact, "opentui-tree-sitter-worker.js") } };
      }
    } catch { return null; }
  }
  const runtime = join(artifact, "runtime", process.platform === "win32" ? "bun.exe" : "bun");
  const bundle = join(artifact, "main.js");
  if (!existsSync(runtime) || !existsSync(bundle)) return null;
  return { file: runtime, args: [bundle], kind: "bundle", env: { OTUI_TREE_SITTER_WORKER_PATH: join(artifact, "opentui-tree-sitter-worker.js") } };
}

export function resolveFrontendCommand(env: NodeJS.ProcessEnv = process.env, here: string = dirname(fileURLToPath(import.meta.url)), options: { next?: boolean } = {}): FrontendCommand | null {
  if (env.UPTOKEY_TUI_FRONTEND && existsSync(env.UPTOKEY_TUI_FRONTEND)) return { file: env.UPTOKEY_TUI_FRONTEND, args: [], kind: "explicit" };
  // An artifact chosen explicitly (installer sidecar, review builds) or promoted next to the CLI.
  if (env.UPTOKEY_TUI_FRONTEND_DIR) {
    return bundleIn(env.UPTOKEY_TUI_FRONTEND_DIR);
  }
  const promoted = bundleIn(join(here, "tui"));
  if (promoted) return promoted;
  const compiled = join(here, "tui", process.platform === "win32" ? "uptokey-tui.exe" : "uptokey-tui");
  if (existsSync(compiled)) return { file: compiled, args: [], kind: "compiled" };
  const source = join(here, "frontend", "uptokey", "main.tsx");
  const bun = existsSync(source) ? (env.UPTOKEY_BUN && existsSync(env.UPTOKEY_BUN) ? env.UPTOKEY_BUN : onPath("bun", env)) : null;
  if (bun) return { file: bun, args: ["run", source], cwd: join(here, "frontend"), kind: "development" };
  return null;
}

/** The accessible presentation shares the same backend. Node supplies portable console input and masked secrets. */
export function linearFrontendCommand(command:FrontendCommand):FrontendCommand|null {
  const artifact=command.kind==='bundle'?dirname(command.args[0]!):command.kind==='compiled'?dirname(command.file):null;
  if(artifact){const entry=join(artifact,'linear-entry.js');return existsSync(entry)?{...command,file:process.execPath,args:[entry],cwd:artifact}:null}
  if(command.kind==='development'){
    const entry=join(dirname(command.args.at(-1)!),'linear-entry.ts');
    return existsSync(entry)?{...command,file:process.execPath,args:['--experimental-transform-types',entry]}:null;
  }
  return command;
}

/**
 * Runs the frontend with the terminal attached. Returns its exit code, or null when no frontend can be started.
 * A fourth descriptor (fd 3, UPTOKEY_TUI_HANDOFF_FD) carries what the frontend hands back on exit, e.g. /leitor
 * asking to reopen the same conversation in the linear interface; no file is involved.
 */
export async function runFrontend(args: readonly string[], options: { next?: boolean; onHandoff?: (text: string) => void } = {}): Promise<number | null> {
  const resolved = resolveFrontendCommand(process.env, undefined, options);
  const command=resolved&&args.includes('--screen-reader')?linearFrontendCommand(resolved):resolved;
  if (!command) return null;
  return new Promise<number | null>((resolveExit) => {
    const child = spawn(command.file, [...command.args, ...args], {
      stdio: ["inherit", "inherit", "inherit", "pipe"],
      ...(command.cwd ? { cwd: command.cwd } : {}),
      env: { ...process.env, ...command.env, ...frontendCoreLaunchEnv(), UPTOKEY_TUI_CALLER_CWD: process.cwd(), UPTOKEY_TUI_HANDOFF_FD: "3" },
      windowsHide: false,
    });
    let handoff = "";
    const channel = child.stdio[3] as NodeJS.ReadableStream | null;
    channel?.on("data", (chunk: Buffer) => { if (handoff.length < 4096) handoff += chunk.toString("utf8"); });
    channel?.on("error", () => { /* the frontend may never use it */ });
    child.once("error", () => resolveExit(null));
    child.once("close", (code, signal) => {
      if (handoff && options.onHandoff) options.onHandoff(handoff);
      resolveExit(signal ? 1 : (code ?? 1));
    });
  });
}
