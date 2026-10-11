/** Optional local Helix handoff. ONE buffer is staged; importing returns memory text,
 * never writes the project. A native process is not an OS sandbox: the UI requires
 * separate, explicit local-execution consent and an import review before W5 save. */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, readFile, realpath, lstat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, extname, join, resolve } from "node:path";
import { resolveProgram } from "../lsp.ts";
import { canonicalProjectRelativePath } from "../editor-save.ts";
export interface HelixBinary { path: string; sha256: string }
export interface HelixProcessResult { exitCode: number; signal?: string; error?: string }
/** Synchronous terminal ownership prevents React from consuming editor input. */
export type HelixTerminal = (launch: () => HelixProcessResult) => HelixProcessResult;
export interface HelixEditInput {
  binary: HelixBinary; projectId: string; rootBindingId: string; projectRoot: string;
  filePath: string; content: string; line?: number;
  /** Set only after the UI's explicit local-process consent. */
  consent: boolean;
}
export interface HelixEditResult { content: string; changed: boolean; exitCode: number; message?: string }
export interface HelixLaunchSpec { binary: string; args: string[]; cwd: string; env: NodeJS.ProcessEnv; timeoutMs: number }
const MAX_BYTES = 8 * 1024 * 1024;
const fingerprint = async (path: string): Promise<HelixBinary> => ({ path: await realpath(path), sha256: createHash("sha256").update(await readFile(path)).digest("hex") });
/** Discovery does not execute --version, a shell, or project configuration. */
export async function findHelix(): Promise<{ available: boolean; path?: string; binary?: HelixBinary }> {
  for (const name of ["hx", "helix"]) {
    const path = resolveProgram(name);
    if (!path || (process.platform === "win32" && extname(path).toLowerCase() !== ".exe")) continue;
    try { const binary = await fingerprint(path); return { available: true, path: binary.path, binary }; } catch { /* unavailable executable */ }
  }
  return { available: false };
}
export function helixEnvironment(stage: string, inherited: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(inherited)) if (["systemroot", "windir", "lang", "lc_all", "term", "colorterm"].includes(key.toLowerCase()) && value !== undefined) env[key] = value;
  return { ...env, HOME: stage, USERPROFILE: stage, APPDATA: stage, LOCALAPPDATA: stage, XDG_CONFIG_HOME: stage, XDG_CACHE_HOME: stage, XDG_DATA_HOME: stage, TEMP: stage, TMP: stage, TMPDIR: stage, TERM: env.TERM ?? "xterm-256color", COLORTERM: "truecolor" };
}
function runProcess(spec: HelixLaunchSpec): HelixProcessResult {
  const result = spawnSync(spec.binary, spec.args, { cwd: spec.cwd, env: spec.env, shell: false, stdio: "inherit", timeout: spec.timeoutMs, windowsHide: true });
  return { exitCode: result.status ?? 1, ...(result.signal ? { signal: result.signal } : {}), ...(result.error ? { error: result.error.message } : {}) };
}
/** Dependency injection is for the focused process-boundary test; production uses spawnSync. */
export async function launchHelix(input: HelixEditInput, terminal: HelixTerminal, run: (spec: HelixLaunchSpec) => HelixProcessResult = runProcess): Promise<HelixEditResult> {
  if (!input.consent) throw new Error("Confirme a execução local do Helix antes de abrir o processo.");
  if (!input.projectId || !input.rootBindingId || !canonicalProjectRelativePath(input.projectRoot, input.filePath)) throw new Error("Helix exige arquivo e raiz de projeto vinculados.");
  if (Buffer.byteLength(input.content, "utf8") > MAX_BYTES) throw new Error("Buffer excede o limite de 8 MiB do editor externo.");
  const current = await fingerprint(input.binary.path);
  if (current.path !== input.binary.path || current.sha256 !== input.binary.sha256) throw new Error("O executável Helix mudou desde a confirmação. Revise novamente.");
  const tempRoot = await realpath(tmpdir());
  const stage = await mkdtemp(join(tempRoot, "uptokey-helix-"));
  const stagedFile = join(stage, `buffer${extname(basename(input.filePath)).replace(/[^.a-zA-Z0-9]/g, "").slice(0, 16) || ".txt"}`);
  try {
    await mkdir(join(stage, ".helix"), { mode: 0o700 });
    await writeFile(stagedFile, input.content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    const config = join(stage, "config.toml");
    await writeFile(config, '[editor]\nauto-format = false\nclipboard-provider = "none"\nshell = ["uptokey-disabled-shell"]\n[editor.lsp]\nenable = false\n', { mode: 0o600, flag: "wx" });
    if ((await fingerprint(current.path)).sha256 !== current.sha256) throw new Error("O executável Helix mudou durante a preparação; abertura recusada.");
    const exit = terminal(() => run({ binary: current.path, args: ["--config", config, "--log", join(stage, "helix.log"), "--working-dir", stage, `+${Math.max(1, Math.trunc(input.line ?? 1))}`, "--", stagedFile], cwd: stage, env: helixEnvironment(stage), timeoutMs: 30 * 60 * 1000 }));
    if (exit.exitCode !== 0 || exit.error || exit.signal) return { content: input.content, changed: false, exitCode: exit.exitCode || 1, message: exit.error ?? `Helix encerrou sem sucesso (${exit.signal ?? exit.exitCode}); buffer original preservado.` };
    const stat = await lstat(stagedFile);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_BYTES || resolve(await realpath(stagedFile)) !== resolve(stagedFile)) throw new Error("Saída do editor recusada: deve ser o arquivo regular de staging de até 8 MiB.");
    const bytes = await readFile(stagedFile);
    const content = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { content, changed: content !== input.content, exitCode: 0 };
  } finally {
    // Only delete this exact temporary directory, never a project path or replaced link.
    const actual = await realpath(stage).catch(() => null);
    if (actual && resolve(actual) === resolve(stage) && dirname(resolve(stage)) === resolve(tempRoot) && basename(stage).startsWith("uptokey-helix-")) await rm(stage, { recursive: true, force: true });
  }
}
export async function resolveEditorMode(): Promise<"helix-native" | "helix-builtin"> { return (await findHelix()).available ? "helix-native" : "helix-builtin"; }
