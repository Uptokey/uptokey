/**
 * Tool set offered to the model in a native turn. "full" offers every built-in tool; "compact" keeps the core
 * read/edit/run tools for small local models, where a long tool list costs prompt and attention. Services and MCP
 * tools the person connected are always kept. Measured in the coding battery before any default changes.
 */
import type { TuiFunctionTool } from "./client.ts";

export type ToolsetMode = "full" | "compact";

/** Built-in tools of the compact set. */
export const COMPACT_TOOL_NAMES: ReadonlySet<string> = new Set([
  "list_directory", "read_file", "find_files", "search_in_files", "edit_file", "write_file", "execute_command",
]);

/** Experimental selection for measurement (UPTOKEY_TUI_TOOLSET=compact); full otherwise. */
export function toolsetMode(env: NodeJS.ProcessEnv = process.env): ToolsetMode {
  return env.UPTOKEY_TUI_TOOLSET === "compact" ? "compact" : "full";
}

/** Parameter count declared in a model id ("qwen3:4b", "llama3.2-3b", "phi3:3.8b"), in billions; null when absent. */
export function declaredBillions(model: string): number | null {
  const match = model.toLowerCase().match(/(?:^|[:\-_/ .])(\d+(?:\.\d+)?)b(?![a-z0-9])/);
  return match ? Number(match[1]) : null;
}

/**
 * Automatic choice: compact for a local runtime model that declares 8B parameters or fewer; full otherwise (unknown
 * size, hosted, BYOK cloud). UPTOKEY_TUI_TOOLSET=full|compact always wins.
 */
export function chooseToolset(input: { providerKind: string | null | undefined; model: string; env?: NodeJS.ProcessEnv }): ToolsetMode {
  const forced = (input.env ?? process.env).UPTOKEY_TUI_TOOLSET;
  if (forced === "compact" || forced === "full") return forced;
  const size = declaredBillions(input.model);
  return input.providerKind === "local" && size !== null && size <= 8 ? "compact" : "full";
}

export function selectToolset(tools: readonly TuiFunctionTool[], mode: ToolsetMode, connected: ReadonlySet<string>): TuiFunctionTool[] {
  if (mode === "full") return [...tools];
  return tools.filter((tool) => COMPACT_TOOL_NAMES.has(tool.function.name) || connected.has(tool.function.name));
}

/** The coding protocol names only the tools that are actually offered. */
export function compactEditProtocol(offered: ReadonlySet<string>): string {
  const writers = ["edit_file", "write_file"].filter((name) => offered.has(name));
  const readers = ["read_file", "search_in_files", "find_files"].filter((name) => offered.has(name));
  return [
    `Coding protocol. You change files only through the ${writers.join(" and ")} tools; code blocks in your reply are never applied.`,
    `- Before editing, read the relevant files (${readers.join(", ")}). Never edit a file you have not read in this turn.`,
    "- edit_file: copy old_string exactly from the current file, with enough surrounding lines to be unique. Batch several edits of the same file in one call. On edit_not_found use the returned closest text; on edit_not_unique add context.",
    "- write_file creates new files or rewrites small files entirely; do not use it to change a few lines of a large file.",
    "- Every successful write returns the language-server errors of the file. Fix the errors you introduced before moving on.",
    ...(offered.has("execute_command") ? ["- When the project has tests, a build or a type check, run them with execute_command after your changes and fix failures. Report a check as passing only when its result says so."] : ["- Report a check as passing only when an actual result says so."]),
    "- Follow the project's existing style, structure and libraries. Make the smallest complete change that solves the task; do not leave placeholders or simulated behaviour.",
    "- Finish with a short summary of what changed and how it was verified.",
  ].join("\n");
}
