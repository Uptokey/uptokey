/**
 * Uptokey TUI — delegated tasks ("subagentes").
 *
 * A delegation is a core project task (`workspace.project.task`): exact child
 * plans prepared first, one W5 consent for the root plan, a grant aggregated
 * by the core from the children (a child never widens it), children started
 * in order by the core executor and reserved on the same conversation ledger.
 * Subagents here are read-only inference children on the governed gateway
 * lane (plus an optional verification child); none of them writes files. Their
 * results come back as artifacts and are integrated by the main conversation
 * into ONE reviewable proposal, applied by the canonical writer.
 */
import type { ProjectTaskView } from "./workspace.ts";
import { routeCodingTask, type ClassifyTaskOptions, type CodingRoute } from "../coding/route-intent.ts";

export const MAX_SUBTASKS = 8;
export const SUBAGENT_MAX_TOKENS = 2048;
const MAX_TEXT = 2000;

export type DelegationSubtask = string | { task: string; model: string | null };

export interface DelegationSpec {
  objective: string;
  subtasks: DelegationSubtask[];
  verify: boolean;
}

/**
 * `/delegate objective | subtask 1 | subtask 2 [--verify] [--model m1,m2]`
 * (`--verificar` and `--modelo` remain accepted aliases).
 */
export function parseDelegation(arg: string): DelegationSpec | { error: string } {
  const verify = /(^|\s)--verificar\b|(^|\s)--verify\b/.test(arg);
  const modelMatch = arg.match(/(^|\s)--(?:modelo|model)\s+([^\s]+)/);
  const models = modelMatch ? modelMatch[2]!.split(",").map(s => s.trim()).filter(Boolean) : [];
  
  const text = arg
    .replace(/(^|\s)--(verificar|verify)\b/g, " ")
    .replace(/(^|\s)--(?:modelo|model)\s+[^\s]+/g, " ")
    .trim();
    
  if (!text) return { error: t("delegation_err_usage") };
  const lines = text.split(/\r?\n/);
  const bullets = lines.slice(1).filter((l) => /^\s*[-*]\s+\S/.test(l)).map((l) => l.replace(/^\s*[-*]\s+/, "").trim());
  const head = [lines[0]!, ...lines.slice(1).filter((l) => !/^\s*[-*]\s+\S/.test(l))].join(" ").trim();
  const parts = head.split("|").map((p) => p.trim()).filter(Boolean);
  const objective = parts[0] ?? "";
  const subtasks = [...parts.slice(1), ...bullets];
  if (!objective) return { error: t("delegation_err_empty") };
  if (objective.length > MAX_TEXT || subtasks.some((s) => s.length > MAX_TEXT)) return { error: t("delegation_err_too_long", { max: MAX_TEXT }) };
  if (subtasks.length > MAX_SUBTASKS) return { error: t("delegation_err_too_many", { max: MAX_SUBTASKS }) };
  
  const finalTasks = subtasks.length ? subtasks : [objective];
  if (models.length > 1 && models.length !== finalTasks.length) {
    return { error: t("delegation_err_models", { models: models.length, tasks: finalTasks.length }) };
  }
  
  const finalSubtasks = finalTasks.map((t, i) => ({
    task: t,
    model: models.length === 1 ? models[0]! : (models[i] || null)
  }));
  
  return { objective, subtasks: finalSubtasks, verify };
}

import { t } from "./i18n.ts";

/** Minimal inherited context: objective, own subtask, project file list and the files the person chose. */
export function subagentMessages(input: { objective: string; subtask: string; index: number; total: number; files: readonly string[]; contextBlock: string }): Array<{ role: "system" | "user"; content: string }> {
  const files = input.files.length ? `\n\n${t("subagent_files_list")}:\n${input.files.slice(0, 300).join("\n")}` : "";
  const context = input.contextBlock ? `\n\n${input.contextBlock}` : "";
  return [
    { role: "system", content: t("subagent_system") },
    { role: "user", content: `${t("subagent_objective")}: ${input.objective}\n${t("subagent_subtask")} (${input.index + 1} / ${input.total}): ${input.subtask}${files}${context}` },
  ];
}

export interface ChildLabel { label: string; kind: "subagent" | "verification"; model: string | null }

export interface ChildResult { label: string; kind: ChildLabel["kind"]; status: string; receiptId: string | null; text: string }

/** One integration turn: results are labelled data; the person still reviews and authorizes the single patch. */
export function integrationPrompt(objective: string, results: readonly ChildResult[]): string {
  const body = results.map((r, i) => `### ${t("subagent_title")} ${i + 1} — ${r.label} (${r.status}${r.receiptId ? `, ${t("subagent_receipt")} ${r.receiptId}` : ""})\n${r.text.slice(0, 12_000) || `(${t("subagent_no_output")})`}`).join("\n\n");
  return `${t("integration_prompt_prefix")} "${objective}" ${t("integration_prompt_suffix")}\n\n[${t("integration_results_header")}]\n${body}`;
}

export const TASK_TERMINAL: ReadonlySet<ProjectTaskView["status"]> = new Set(["succeeded", "blocked", "needs_attention", "cancelled", "expired"]);
export function getTaskStatusText(status: ProjectTaskView["status"]): string {
  switch (status) {
    case "ready": return t("task_status_ready");
    case "running": return t("task_status_running");
    case "succeeded": return t("task_status_succeeded");
    case "blocked": return t("task_status_blocked");
    case "needs_attention": return t("task_status_needs_attention");
    case "cancelled": return t("task_status_cancelled");
    case "expired": return t("task_status_expired");
    default: return status;
  }
}

export function getChildStatusText(status: string): string {
  switch (status) {
    case "pending": return t("child_status_pending");
    case "ready": return t("child_status_ready");
    case "awaiting_approval": return t("child_status_awaiting");
    case "running": return t("child_status_running");
    case "succeeded": return t("child_status_succeeded");
    case "failed": return t("child_status_failed");
    case "cancelled": return t("child_status_cancelled");
    case "needs_attention": return t("child_status_needs_attention");
    default: return status;
  }
}

export interface DelegationStrategyOptions extends ClassifyTaskOptions {
  principalModel?: string;
  architectModel?: string;
  coderModel?: string;
}

export async function delegationStrategy(objective: string, options: DelegationStrategyOptions = {}): Promise<CodingRoute> {
  const fallback = options.coderModel ?? options.architectModel ?? options.principalModel ?? "auto";
  return routeCodingTask({
    text: objective,
    repoMapSummary: options.repoMapSummary,
    ...(options.apiKey === undefined ? {} : { apiKey: options.apiKey }),
    ...(options.intent === undefined ? {} : { intent: options.intent }),
    models: {
      architectModel: options.architectModel ?? fallback,
      coderModel: options.coderModel ?? fallback,
    },
  });
}
