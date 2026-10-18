/** Task progress the model keeps for the person: a bounded todo list shown beside the conversation. It has no
 * external effect, so it needs no approval; it is stored in the durable tool result of the turn, which is how
 * reopening a conversation shows the last list again. */
import type { TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor } from "./conversations.ts";

export interface TodoItem { content: string; status: "pending" | "in_progress" | "completed" | "cancelled"; priority: "high" | "medium" | "low" }

const STATUSES = new Set(["pending", "in_progress", "completed", "cancelled"]);
const PRIORITIES = new Set(["high", "medium", "low"]);

export const PROGRESS_TOOLS: readonly TuiFunctionTool[] = [{
  type: "function",
  function: {
    name: "update_todos",
    description: "Replace the visible task list for this request (at most 30 items). Use it for multi-step work: keep exactly one item in_progress, mark items completed as soon as they are done. It changes nothing in the project.",
    parameters: {
      type: "object",
      properties: { todos: { type: "array", maxItems: 30, items: { type: "object", properties: {
        content: { type: "string", maxLength: 200 }, status: { type: "string", enum: ["pending", "in_progress", "completed", "cancelled"] },
        priority: { type: "string", enum: ["high", "medium", "low"] } }, required: ["content", "status"], additionalProperties: false } } },
      required: ["todos"], additionalProperties: false,
    },
  },
}];

export function parseTodos(value: unknown): TodoItem[] | null {
  if (!Array.isArray(value) || value.length > 30) return null;
  const todos: TodoItem[] = [];
  for (const item of value) {
    if (!item || typeof item !== "object" || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["content", "status", "priority"].includes(key)) || typeof row.content !== "string" || !row.content.trim() || row.content.length > 200 ||
      typeof row.status !== "string" || !STATUSES.has(row.status) || (row.priority !== undefined && (typeof row.priority !== "string" || !PRIORITIES.has(row.priority)))) return null;
    todos.push({ content: row.content.trim(), status: row.status as TodoItem["status"], priority: (row.priority as TodoItem["priority"] | undefined) ?? "medium" });
  }
  return todos;
}

/** The last list recorded in a conversation's tool results (persisted output of update_todos). */
export function todosFromResults(results: ReadonlyArray<{ output: string }>): TodoItem[] {
  for (const result of [...results].reverse()) {
    try {
      const value = JSON.parse(result.output) as { tool?: unknown; status?: unknown; todos?: unknown };
      if (value.tool !== "update_todos" || value.status !== "succeeded") continue;
      return parseTodos(value.todos) ?? [];
    } catch { /* other tools' outputs */ }
  }
  return [];
}

export function progressExecutor(onTodos: (todos: TodoItem[]) => void): NativeReadToolExecutor {
  return async (call, signal) => {
    signal?.throwIfAborted();
    if (call.name !== "update_todos") throw new Error("conversation_tool_unavailable");
    const todos = Object.keys(call.arguments).every((key) => key === "todos") ? parseTodos(call.arguments.todos) : null;
    if (!todos) {
      const outcome = { status: "not_completed", tool: call.name, reason: "todos_invalid" };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    onTodos(todos);
    const outcome = { status: "succeeded", tool: call.name, todos };
    return { output: JSON.stringify({ status: "succeeded", tool: call.name, count: todos.length }), persistedOutput: outcome };
  };
}
