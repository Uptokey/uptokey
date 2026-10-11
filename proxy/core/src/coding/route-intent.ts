import { classifyIntent, type IntentResult } from "../tui/jev-intent.ts";
import { architectTask } from "./prompts/architect.ts";

export type TaskComplexity = "trivial" | "straightforward" | "complex" | "refactor";
export type CodingMode = "coder_only" | "architect_coder";

export interface CodingModels {
  architectModel: string;
  coderModel: string;
}

export interface ArchCoderMember {
  role: "analyst" | "writer";
  modelId: string;
  task: string;
}

export interface CodingRoute {
  complexity: TaskComplexity;
  mode: CodingMode;
  calls: 1 | 2;
  architectModel: string | null;
  coderModel: string;
  reason: string;
  members: ArchCoderMember[];
}

export interface ClassifyTaskOptions {
  repoMapSummary?: string;
  apiKey?: string;
  intent?: (text: string, opts?: { apiKey?: string; timeoutMs?: number }) => Promise<IntentResult>;
}

export interface RouteTaskInput extends ClassifyTaskOptions {
  text: string;
  complexity?: TaskComplexity;
  models: CodingModels;
}

const REFACTOR_RE = /\b(refator\w*|refactor\w*|renomeie todos|rename all|migra\w*|migrate\w*|reescrev\w*|rewrite|redesign|rearquitet\w*|injeção de dependência|dependency injection)\b/i;
const COMPLEX_RE = /\b(implemente\w*|implement\w*|adicione (?:uma )?(?:nova )?(?:feature|funcionalidade)|new feature|corrija (?:o )?bug\w*|fix (?:the )?bug\w*|em todos os|em todo o|across (?:the )?(?:repo|files)|múltiplos arquivos|multiple files|integra\w*|integrat\w*|oauth|autentica\w*|auth(?:entication)?|ponta a ponta|end[- ]to[- ]end|arquitetura|pipeline|webhook)\b/i;
const TRIVIAL_RE = /\b(console\.log|typo\w*|erro de digitação|renomeie (?:a|o) (?:função|variável|constante|método)|rename (?:the )?(?:function|variable|constant|method)|ajuste (?:o )?texto|adjust (?:the )?text|coment\w*|comment out|uma linha|one[- ]line)\b/i;

function requireModel(value: string, code: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(code);
  const model = value.trim();
  if (model.length > 200) throw new Error(code);
  return model;
}

export function classifyComplexity(text: string, repoMapSummary = ""): TaskComplexity {
  if (typeof text !== "string" || !text.trim()) throw new Error("route_text_required");
  const refactor = REFACTOR_RE.test(text);
  const complex = COMPLEX_RE.test(text);
  const trivial = TRIVIAL_RE.test(text);
  if (refactor && !trivial) return "refactor";
  if (complex) return "complex";
  if (trivial) return "trivial";
  if (refactor) return "refactor";
  const manyFiles = typeof repoMapSummary === "string" && repoMapSummary.split("\n").filter((line) => line.trim()).length > 40;
  return text.length > 600 || manyFiles ? "complex" : "straightforward";
}

export async function classifyTask(userText: string, options: ClassifyTaskOptions = {}): Promise<TaskComplexity> {
  const heuristic = classifyComplexity(userText, options.repoMapSummary ?? "");
  let intent: IntentResult | undefined;
  try {
    const run = options.intent ?? classifyIntent;
    intent = await run(userText, options.apiKey === undefined ? undefined : { apiKey: options.apiKey });
  } catch {
    intent = undefined;
  }
  if (intent?.category === "destructive_action" && intent.confidence >= 0.65 &&
      (heuristic === "trivial" || heuristic === "straightforward")) {
    return "complex";
  }
  return heuristic;
}

export function architectCoderMembers(objective: string, models: CodingModels): ArchCoderMember[] {
  const architectModel = requireModel(models.architectModel, "architect_model_required");
  const coderModel = requireModel(models.coderModel, "coder_model_required");
  const task = typeof objective === "string" ? objective.trim().slice(0, 2000) : "";
  if (!task) throw new Error("route_text_required");
  return [
    { role: "analyst", modelId: architectModel, task: architectTask(objective) },
    { role: "writer", modelId: coderModel, task },
  ];
}

export async function routeCodingTask(input: RouteTaskInput): Promise<CodingRoute> {
  const complexity = input.complexity ?? await classifyTask(input.text, input);
  const coderModel = requireModel(input.models.coderModel, "coder_model_required");
  if (complexity === "complex" || complexity === "refactor") {
    const architectModel = requireModel(input.models.architectModel, "architect_model_required");
    return {
      complexity, mode: "architect_coder", calls: 2, architectModel, coderModel,
      reason: complexity === "refactor" ? "refactor_requires_plan" : "complex_requires_plan",
      members: architectCoderMembers(input.text, { architectModel, coderModel }),
    };
  }
  return {
    complexity, mode: "coder_only", calls: 1, architectModel: null, coderModel,
    reason: complexity === "trivial" ? "trivial_edit" : "single_pass_edit",
    members: [{ role: "writer", modelId: coderModel, task: input.text.trim().slice(0, 2000) }],
  };
}
