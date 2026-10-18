/** Structured questions from the model to the person, shown in the terminal's question prompt. The model waits
 * for the answer inside its turn; declining or cancelling returns that fact, never an invented choice. */
import type { TuiFunctionTool } from "./client.ts";
import type { NativeReadToolExecutor } from "./conversations.ts";

export interface QuestionInfo { question: string; header: string; options: Array<{ label: string; description: string }>; multiple?: boolean }

export const QUESTION_TOOLS: readonly TuiFunctionTool[] = [{
  type: "function",
  function: {
    name: "ask_user",
    description: "Ask the person up to 3 short multiple-choice questions when a decision is genuinely theirs (an ambiguous requirement, a trade-off). Do not ask what you can find out by reading the project.",
    parameters: {
      type: "object",
      properties: { questions: { type: "array", minItems: 1, maxItems: 3, items: { type: "object", properties: {
        question: { type: "string", maxLength: 300 }, header: { type: "string", maxLength: 30 },
        options: { type: "array", minItems: 2, maxItems: 6, items: { type: "object", properties: { label: { type: "string", maxLength: 60 }, description: { type: "string", maxLength: 200 } }, required: ["label"], additionalProperties: false } },
        multiple: { type: "boolean" } }, required: ["question", "options"], additionalProperties: false } } },
      required: ["questions"], additionalProperties: false,
    },
  },
}];

export function parseQuestions(value: unknown): QuestionInfo[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 3) return null;
  const out: QuestionInfo[] = [];
  for (const raw of value) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
    const row = raw as Record<string, unknown>;
    if (Object.keys(row).some((key) => !["question", "header", "options", "multiple"].includes(key)) || typeof row.question !== "string" || !row.question.trim() || row.question.length > 300 ||
      (row.header !== undefined && (typeof row.header !== "string" || row.header.length > 30)) || (row.multiple !== undefined && typeof row.multiple !== "boolean") ||
      !Array.isArray(row.options) || row.options.length < 2 || row.options.length > 6) return null;
    const options: QuestionInfo["options"] = [];
    for (const option of row.options) {
      if (!option || typeof option !== "object" || Array.isArray(option)) return null;
      const entry = option as Record<string, unknown>;
      if (Object.keys(entry).some((key) => !["label", "description"].includes(key)) || typeof entry.label !== "string" || !entry.label.trim() || entry.label.length > 60 ||
        (entry.description !== undefined && (typeof entry.description !== "string" || entry.description.length > 200))) return null;
      options.push({ label: entry.label.trim(), description: typeof entry.description === "string" ? entry.description : "" });
    }
    out.push({ question: row.question.trim(), header: typeof row.header === "string" && row.header.trim() ? row.header.trim() : row.question.trim().slice(0, 30), options, ...(row.multiple === true ? { multiple: true } : {}) });
  }
  return out;
}

export function questionExecutor(ask: (questions: QuestionInfo[], signal?: AbortSignal) => Promise<string[][] | null>): NativeReadToolExecutor {
  return async (call, signal) => {
    signal?.throwIfAborted();
    if (call.name !== "ask_user") throw new Error("conversation_tool_unavailable");
    const questions = Object.keys(call.arguments).every((key) => key === "questions") ? parseQuestions(call.arguments.questions) : null;
    if (!questions) {
      const outcome = { status: "not_completed", tool: call.name, reason: "questions_invalid" };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const answers = await ask(questions, signal);
    if (!answers) {
      const outcome = { status: "not_completed", tool: call.name, reason: "declined_by_person" };
      return { output: JSON.stringify(outcome), persistedOutput: outcome };
    }
    const outcome = { status: "succeeded", tool: call.name, answers: questions.map((item, index) => ({ question: item.question, answer: answers[index] ?? [] })) };
    return { output: JSON.stringify(outcome), persistedOutput: outcome };
  };
}
