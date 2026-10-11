/**
 * C6 / step 3 — patch validation in an isolated sandbox (Agentless stage 3).
 *
 * The candidate bytes are written into a throwaway sandbox copy of the task
 * repository (never the user's worktree, never the dataset source), then the
 * task's test command runs through an injected runner. On failure the harness
 * may repair (re-prompt the coder with the failing output) up to
 * `maxRepairAttempts`; every attempt is recorded.
 *
 * The runner is always injected: synthetic rounds use a local child-process
 * runner; governed rounds bind the canonical OCI runner — this module never
 * spawns anything on its own.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { PatchSet } from "./patcher.ts";

export interface RunnerResult {
  exit: number | null;
  stdout: string;
  stderr: string;
}

/** Injected command runner (local child process in synthetic rounds; OCI runner when governed). */
export type PatchRunner = (command: string, cwd: string) => Promise<RunnerResult>;

export interface ValidationResult {
  pass: boolean;
  attempts: number;
  exit: number | null;
  stdout: string;
  stderr: string;
  /** Output of the last failing run, for the repair prompt and the report. */
  failureText?: string;
}

const FAILING_OUTPUT_MAX = 8000;

function truncate(text: string): string {
  return text.length > FAILING_OUTPUT_MAX ? `${text.slice(0, FAILING_OUTPUT_MAX)}\n… (saída truncada)` : text;
}

/** Guard: the test command must not walk out of the sandbox (`../`). */
function assertSandboxSafe(sandbox: string, command: string): void {
  void sandbox;
  if (/\.\.[/\\]/.test(command)) throw new Error("swe_command_escapes_sandbox");
}

/** Writes the candidate bytes into the sandbox (create/replace; deletes are out of scope). */
export async function applyPatchInSandbox(sandbox: string, patchSet: PatchSet): Promise<void> {
  for (const file of patchSet.patches) {
    const target = join(sandbox, ...file.path.split("/"));
    if (!resolve(target).startsWith(resolve(sandbox))) throw new Error("swe_patch_escapes_sandbox");
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, Buffer.from(file.after, "utf-8"));
  }
}

export interface ValidateOptions {
  runner: PatchRunner;
  /** Injected repair step: re-prompt the coder with the failing output. */
  repair?: (failureText: string) => Promise<PatchSet>;
  maxRepairAttempts?: number;
}

export async function validate(
  patchSet: PatchSet,
  sandbox: string,
  testCommand: string,
  options: ValidateOptions,
): Promise<ValidationResult> {
  assertSandboxSafe(sandbox, testCommand);
  const maxAttempts = Math.max(1, (options.maxRepairAttempts ?? 3) + 1);
  let current = patchSet;
  let last: ValidationResult = { pass: false, attempts: 0, exit: null, stdout: "", stderr: "" };

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    await applyPatchInSandbox(sandbox, current);
    const outcome = await options.runner(testCommand, sandbox);
    last = {
      pass: outcome.exit === 0,
      attempts: attempt,
      exit: outcome.exit,
      stdout: outcome.stdout,
      stderr: outcome.stderr,
      ...(outcome.exit === 0 ? {} : { failureText: truncate(`${outcome.stdout}\n${outcome.stderr}`.trim()) }),
    };
    if (last.pass) return last;
    if (!options.repair || attempt === maxAttempts) break;
    current = await options.repair(last.failureText!);
    if (!current.patches.length) break; // nothing new to apply: stop early
  }
  return last;
}
