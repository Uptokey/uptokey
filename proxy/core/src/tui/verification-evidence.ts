/** A command receipt proves an attempt, not passing tests. Unknown commands stay unverified. */
import type { NativeReadToolCall, NativeReadToolResult } from "./conversations.ts";
import { parseCommandLine } from "./shell-words.ts";

const DIGEST = /^[a-f0-9]{64}$/;

/** Recognize explicit test runners/scripts, never help, version, collection-only or arbitrary shell expressions. */
export function isTestCommand(call: Pick<NativeReadToolCall, "name" | "arguments">): boolean {
  let argv: string[];
  if (call.name === "execute_command") {
    if (!Array.isArray(call.arguments.argv) || call.arguments.argv.some(arg => typeof arg !== "string")) return false;
    argv = call.arguments.argv as string[];
  } else if (call.name === "shadow_bash_run" && typeof call.arguments.command === "string") {
    // Shell expansion can turn an apparent test invocation into something else.
    if (/[\r\n$`|&;<>]/.test(call.arguments.command)) return false;
    const parsed = parseCommandLine(call.arguments.command);
    if (!parsed.ok) return false;
    argv = parsed.argv;
  } else return false;
  if (!argv.length || argv.some(arg => /^(?:--(?:help|version|list(?:Tests)?|collect-only|watch)(?:=|$)|-[hvV]$)/i.test(arg))) return false;
  const program = argv[0]!.replaceAll("\\", "/").split("/").at(-1)!.replace(/\.(?:cmd|exe)$/i, "");
  const args = argv.slice(1);
  const testScript = (script: string | undefined) => script !== undefined && /^test(?:$|[:_-][a-z0-9:_-]+$)/i.test(script);
  if (["npm", "pnpm", "yarn", "bun"].includes(program)) return testScript(args[0] === "run" ? args[1] : args[0]);
  if (program === "node") return args[0] === "--test" || args[0]?.startsWith("--test=") === true;
  if (program === "pytest" || program === "jest") return args[0] !== "list";
  if (program === "vitest") return args[0] === "run";
  return /^python(?:3(?:\.\d+)?)?$/.test(program) && args[0] === "-m" && (args[1] === "pytest" || args[1] === "unittest");
}

export function successfulWrite(result: NativeReadToolResult): boolean {
  const output = result.persistedOutput as { status?: unknown } | null;
  return Boolean(result.receiptId && output?.status === "succeeded");
}

/** Exact snapshot checked by a successful test command; null for failed, blocked or unrelated attempts. */
export function passedVerificationDigest(call: NativeReadToolCall, result: NativeReadToolResult, hostSnapshot?: string | null): string | null {
  if (!result.receiptId || !isTestCommand(call)) return null;
  try {
    const output = JSON.parse(result.output);
    if (output.error !== undefined) return null;
    if (call.name === "shadow_bash_run") return output.status === "completed" && output.exitCode === 0 && hostSnapshot && DIGEST.test(hostSnapshot) ? hostSnapshot : null;
    const report = output.report;
    if (output.status !== "succeeded" || !report || !DIGEST.test(report.manifestDigest) || !Array.isArray(report.checks) || !report.checks.length
      || report.checks.some((check: { status?: unknown; exitCode?: unknown }) => check.status !== "pass" || check.exitCode !== 0)) return null;
    return report.manifestDigest;
  } catch { return null; }
}
