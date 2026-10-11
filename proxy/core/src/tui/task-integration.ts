/** Reload a delegated task's confirmed results after the terminal was closed.
 * Reads existing plans, receipts and artifacts; never starts or retries a child. */
import { TASK_TERMINAL, integrationPrompt, type ChildResult, getChildStatusText, getTaskStatusText } from "./delegation.ts";
import { interpretReport } from "./verification.ts";
import { WorkspaceServiceError, type WorkspaceService, type WorkspacePlanStep } from "./workspace.ts";

export interface RecoveredTaskIntegration {
  taskId: string;
  rootRunId: string;
  objective: string;
  prompt: string;
  results: ChildResult[];
}
type TaskReader = Pick<WorkspaceService, "getTask" | "refreshPlan" | "readArtifact">;
const record = (value: unknown): value is Record<string, unknown> => Boolean(value && typeof value === "object" && !Array.isArray(value));
function invalid(code: string): never { throw new WorkspaceServiceError(code); }
function literal(step: WorkspacePlanStep, key: string): Record<string, unknown> | null {
  const binding = step.arguments?.[key];
  return record(binding) && binding.kind === "literal" && record(binding.value) ? binding.value : null;
}

export async function loadTaskIntegration(
  workspace: TaskReader,
  input: { projectId: string; rootBindingId: string; taskId: string },
  signal?: AbortSignal,
): Promise<RecoveredTaskIntegration> {
  signal?.throwIfAborted();
  const task = await workspace.getTask(input.projectId, input.taskId, signal);
  if (task.id !== input.taskId || task.rootBindingId !== input.rootBindingId) invalid("task_integration_binding_mismatch");
  if (!TASK_TERMINAL.has(task.status)) invalid("task_integration_not_settled");
  const results: ChildResult[] = [];
  for (const [index, child] of task.children.entries()) {
    signal?.throwIfAborted();
    const view = await workspace.refreshPlan(input.projectId, child.planId, signal);
    if (view.projectId !== input.projectId || view.plan?.id !== child.planId) invalid("task_integration_plan_mismatch");
    const step = view.plan.steps.find(item => ["inference.chat.9router", "workspace.project.run"].includes(item.capabilityId ?? ""));
    if (!step) invalid("task_integration_child_unsupported");
    const verification = step.capabilityId === "workspace.project.run";
    const chat = verification ? null : literal(step, "chat");
    const request = verification ? literal(step, "request") : null;
    const model = typeof chat?.model === "string" ? chat.model : null;
    const label = verification ? `verificação ${String(request?.runtimeProfileId ?? "")}: ${String(request?.actionId ?? "")}`.trim()
      : `filho ${index + 1}${model ? ` · ${model}` : ""}`;
    let receiptId: string | null = null, text = "";
    if (child.runId) {
      if (view.run?.id !== child.runId || view.run.planId !== child.planId || view.run.requestId !== child.requestId) invalid("task_integration_run_mismatch");
      if (view.run.status !== child.status) invalid("task_integration_state_changed");
      const receipts = view.receipts.filter(receipt => receipt.runId === child.runId && child.receiptIds.includes(receipt.id)
        && receipt.capabilityId === step.capabilityId && receipt.status === "succeeded");
      if (child.status === "succeeded") {
        const ids = child.artifactIds.filter(id => receipts.some(receipt => receipt.outputArtifactRefs.includes(id)));
        if (!ids.length || ids.length !== child.artifactIds.length) invalid("task_integration_receipt_missing");
        receiptId = receipts.at(-1)!.id;
        const outputs: string[] = [];
        for (const id of ids) {
          const raw = await workspace.readArtifact(input.projectId, id, signal);
          if (verification) { const report = interpretReport(raw); outputs.push(`${report.summary}\n${report.failureText}`.trim()); }
          else outputs.push(raw);
        }
        text = outputs.join("\n\n");
      }
    } else if (child.status === "succeeded" || child.artifactIds.length || child.receiptIds.length) invalid("task_integration_run_missing");
    results.push({ label, kind: verification ? "verification" : "subagent", status: getChildStatusText(child.status) ?? child.status, receiptId, text });
  }
  signal?.throwIfAborted();
  // A policy/authority failure is never converted to an empty successful result.
  const latest = await workspace.getTask(input.projectId, input.taskId, signal);
  if (JSON.stringify(latest) !== JSON.stringify(task)) invalid("task_integration_state_changed");
  if (!results.some(result => result.kind === "subagent" && result.receiptId && result.text.trim())) invalid("task_integration_no_results");
  return { taskId: task.id, rootRunId: task.rootRunId, objective: task.objective, results, prompt: integrationPrompt(task.objective, results) };
}
