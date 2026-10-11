/**
 * Uptokey TUI — repository hooks (declarative, reviewed, executed only by the
 * isolated runner).
 *
 * Security model:
 * - Hooks are data: `{phase, command, match?, blocking?}` in `.uptokey/hooks.json`
 *   or `.agents/hooks.json`. No `script`, no eval, no in-process execution.
 * - Discovery executes nothing. The person first sees the exact hooks and the
 *   file hash (review), and only then may trust that hash; any edit to the file
 *   invalidates the trust.
 * - `match` is a regular expression tested against the phase target; an invalid
 *   pattern rejects the hook at load time (no substring fallback), and the same
 *   filter selects exactly the hooks that run.
 * - Commands become structured argv (no shell) and run through the canonical
 *   project runner (`exec`, rootless OCI, network none, read-only snapshot).
 *   When the isolated runner is unavailable the hook is reported as not run —
 *   never executed on the host.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseCommandLine } from "./shell-words.ts";
import { t } from "./i18n.ts";

export type HookPhase =
  | "pre-send"       // Before sending a message to the model
  | "post-tool"      // After a tool call completes
  | "pre-write"      // Before applying an approved change
  | "post-response"  // After a full assistant response
  | "pre-approve"    // Before an approval is sent
  | "on-error";      // When an error occurs

export interface HookDefinition {
  phase: HookPhase;
  command: string;
  /** Regular expression tested against the phase target (tool name, file path, message). */
  match?: string;
  /** Blocking hooks stop the operation when they fail or cannot run. */
  blocking?: boolean;
  /** Structured argv derived from `command` at load time. */
  argv: string[];
}

export interface HooksSource {
  hooks: HookDefinition[];
  /** Raw file content (for the trust hash). Empty when absent. */
  raw: string;
  path: string | null;
  rejected: Array<{ index: number; reason: string }>;
}

const PHASES: readonly HookPhase[] = ["pre-send", "post-tool", "pre-write", "post-response", "pre-approve", "on-error"];

function isValidPhase(value: unknown): value is HookPhase {
  return typeof value === "string" && (PHASES as readonly string[]).includes(value);
}

/** Reads and validates hooks; nothing is executed or trusted here. */
export async function loadHooksSource(projectRoot: string): Promise<HooksSource> {
  for (const path of [join(projectRoot, ".uptokey", "hooks.json"), join(projectRoot, ".agents", "hooks.json")]) {
    let content: string;
    try { content = await readFile(path, "utf-8"); } catch { continue; }
    let parsed: unknown;
    try { parsed = JSON.parse(content); } catch { return { hooks: [], raw: content, path, rejected: [{ index: -1, reason: t("hk_invalid_json") }] }; }
    const list = Array.isArray(parsed) ? parsed
      : parsed && typeof parsed === "object" && Array.isArray((parsed as { hooks?: unknown }).hooks) ? (parsed as { hooks: unknown[] }).hooks : null;
    if (!list) return { hooks: [], raw: content, path, rejected: [{ index: -1, reason: t("hk_unknown_format") }] };
    const hooks: HookDefinition[] = [];
    const rejected: HooksSource["rejected"] = [];
    list.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") { rejected.push({ index, reason: t("hk_invalid_entry") }); return; }
      const hook = entry as Record<string, unknown>;
      if ("script" in hook) { rejected.push({ index, reason: t("hk_inline_script") }); return; }
      if (!isValidPhase(hook.phase)) { rejected.push({ index, reason: "fase desconhecida" }); return; }
      if (typeof hook.command !== "string" || !hook.command.trim()) { rejected.push({ index, reason: "comando ausente" }); return; }
      if (hook.match !== undefined) {
        if (typeof hook.match !== "string") { rejected.push({ index, reason: t("hk_invalid_match") }); return; }
        try { new RegExp(hook.match); } catch { rejected.push({ index, reason: t("hk_match_not_regex") }); return; }
      }
      const parsedCommand = parseCommandLine(hook.command);
      if (!parsedCommand.ok) { rejected.push({ index, reason: (parsedCommand as { ok: false; reason: string }).reason }); return; }
      hooks.push({ phase: hook.phase, command: hook.command, argv: parsedCommand.argv, ...(typeof hook.match === "string" ? { match: hook.match } : {}), ...(hook.blocking === true ? { blocking: true } : {}) });
    });
    return { hooks, raw: content, path, rejected };
  }
  return { hooks: [], raw: "", path: null, rejected: [] };
}

export async function loadHooks(projectRoot: string): Promise<HookDefinition[]> {
  return (await loadHooksSource(projectRoot)).hooks;
}

/** Exactly the hooks that run for a phase and target (same filter for check and execution). */
export function matchingHooks(hooks: readonly HookDefinition[], phase: HookPhase, target: string): HookDefinition[] {
  return hooks.filter((hook) => hook.phase === phase && (hook.match === undefined || new RegExp(hook.match).test(target)));
}

export interface HookRunner {
  /** Runs argv in the isolated runner; resolves with the exit code or a reason it could not run. */
  (hook: HookDefinition): Promise<{ ran: true; exitCode: number; output: string } | { ran: false; reason: string }>;
}

export interface HookOutcome {
  allow: boolean;
  results: Array<{ hook: HookDefinition; ran: boolean; exitCode?: number; reason?: string }>;
  message?: string;
}

/**
 * Executes the matching hooks of a phase through `run` (the runner adapter),
 * only when the hooks file hash is trusted. Untrusted hooks never run; a
 * blocking hook that fails or cannot run blocks the operation.
 */
export async function executeHooks(hooks: readonly HookDefinition[], phase: HookPhase, target: string, options: { trusted: boolean; run: HookRunner }): Promise<HookOutcome> {
  const selected = matchingHooks(hooks, phase, target);
  if (!selected.length) return { allow: true, results: [] };
  if (!options.trusted) return { allow: true, results: selected.map((hook) => ({ hook, ran: false, reason: "hooks_not_trusted" })), message: "hooks_not_trusted" };
  const results: HookOutcome["results"] = [];
  for (const hook of selected) {
    const outcome = await options.run(hook);
    if (outcome.ran) {
      results.push({ hook, ran: true, exitCode: outcome.exitCode });
      if (outcome.exitCode !== 0 && hook.blocking) return { allow: false, results, message: t("hk_failed", { command: hook.command, code: String(outcome.exitCode) }) };
    } else {
      const failed = outcome as { ran: false; reason: string };
      results.push({ hook, ran: false, reason: failed.reason });
      if (hook.blocking) return { allow: false, results, message: t("hk_blocking_not_run", { command: hook.command, reason: failed.reason }) };
    }
  }
  return { allow: true, results };
}
