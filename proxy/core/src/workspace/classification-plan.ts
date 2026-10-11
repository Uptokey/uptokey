/**
 * E2-16 — ClassificationRequest / plan (local, no W0 publish until coordinator).
 * Principal/owner are never taken from the browser as authorization.
 */

import { createHash, randomUUID } from "node:crypto";
import { USAGE_TAXONOMY_V1 } from "./classification-taxonomy.ts";
import { classifyByRules, type ObservedFacts, type ClassificationResult } from "./classification-rules.ts";
import { applySemanticFixture, DEFAULT_SEMANTIC_PROFILE, type SemanticCandidate } from "./classification-semantic.ts";
import type { HumanCorrection } from "./usage-classification.ts";
export type ClassificationMode = "rules" | "semantic";

export interface ClassificationPlan {
  planId: string;
  projectId: string;
  principalId: string;
  mode: ClassificationMode;
  taxonomyVersion: string;
  sourceDigest: string;
  candidateIds: string[];
  profileRevision: string | null;
  createdAt: string;
  cancelled: boolean;
  dispatched: boolean;
}

export interface PrepareClassificationInput {
  principalId: string;
  projectId: string;
  expectedRevision?: string;
  mode: ClassificationMode;
  facts: ObservedFacts;
  candidateIds?: string[];
  candidates?: SemanticCandidate[];
}

export class ClassificationDomainError extends Error {
  readonly code: string;
  readonly stage: "validate" | "prepare" | "dispatch" | "cancel";
  readonly effect: "not_sent" | "observed" | "uncertain";
  constructor(code: string, message: string, stage: ClassificationDomainError["stage"], effect: ClassificationDomainError["effect"] = "not_sent") {
    super(message);
    this.name = "ClassificationDomainError";
    this.code = code;
    this.stage = stage;
    this.effect = effect;
  }
}

export class ClassificationPlanner {
  private readonly plans = new Map<string, ClassificationPlan>();
  private readonly results = new Map<string, ClassificationResult>();

  prepare(input: PrepareClassificationInput): ClassificationPlan {
    if (!input.principalId || !input.projectId) {
      throw new ClassificationDomainError("source_not_authorized", "principal and project required", "validate");
    }
    if (input.facts.principalId && input.facts.principalId !== input.principalId) {
      throw new ClassificationDomainError("source_not_authorized", "fact principal mismatch", "validate");
    }
    if (input.mode === "semantic" && !DEFAULT_SEMANTIC_PROFILE.enabled) {
      // Preparing a semantic plan while disabled is allowed as a draft; dispatch will fail closed.
    }
    const facts: ObservedFacts = { ...input.facts, principalId: input.principalId, projectId: input.projectId };
    const preview = classifyByRules(facts);
    const plan: ClassificationPlan = {
      planId: randomUUID(),
      projectId: input.projectId,
      principalId: input.principalId,
      mode: input.mode,
      taxonomyVersion: USAGE_TAXONOMY_V1.version,
      sourceDigest: preview.sourceDigest,
      candidateIds: (input.candidateIds ?? input.candidates?.map((c) => c.id) ?? []).slice(0, 32),
      profileRevision: input.mode === "semantic" ? DEFAULT_SEMANTIC_PROFILE.questionVersion : null,
      createdAt: new Date().toISOString(),
      cancelled: false,
      dispatched: false,
    };
    this.plans.set(plan.planId, plan);
    return plan;
  }

  cancel(planId: string, principalId: string): ClassificationPlan {
    const plan = this.plans.get(planId);
    if (!plan || plan.principalId !== principalId) {
      throw new ClassificationDomainError("source_not_authorized", "plan not found for principal", "cancel");
    }
    if (plan.dispatched) {
      throw new ClassificationDomainError("outcome_unknown", "already dispatched; mark uncertain, do not silent-fallback", "cancel", "uncertain");
    }
    const next = { ...plan, cancelled: true };
    this.plans.set(planId, next);
    return next;
  }

  execute(planId: string, principalId: string, facts: ObservedFacts, candidates: SemanticCandidate[] = []): ClassificationResult {
    const plan = this.plans.get(planId);
    if (!plan || plan.principalId !== principalId) {
      throw new ClassificationDomainError("source_not_authorized", "plan not found for principal", "dispatch");
    }
    if (plan.cancelled) {
      throw new ClassificationDomainError("classifier_disabled", "plan cancelled before dispatch", "dispatch", "not_sent");
    }
    const scoped: ObservedFacts = { ...facts, principalId, projectId: plan.projectId };
    const preview = classifyByRules(scoped);
    if (preview.sourceDigest !== plan.sourceDigest) {
      throw new ClassificationDomainError("classification_stale", "facts changed after prepare", "dispatch");
    }
    plan.dispatched = true;
    this.plans.set(planId, plan);
    const result =
      plan.mode === "rules"
        ? preview
        : applySemanticFixture(scoped, candidates, { ...DEFAULT_SEMANTIC_PROFILE, enabled: true });
    this.results.set(planId, result);
    return result;
  }

  getResult(planId: string, principalId: string): ClassificationResult | undefined {
    const plan = this.plans.get(planId);
    if (!plan || plan.principalId !== principalId) return undefined;
    return this.results.get(planId);
  }

  getPlan(planId: string, principalId: string): ClassificationPlan | undefined {
    const plan = this.plans.get(planId);
    if (!plan || plan.principalId !== principalId) return undefined;
    return plan;
  }

  planDigest(plan: ClassificationPlan): string {
    return createHash("sha256")
      .update(
        JSON.stringify({
          projectId: plan.projectId,
          principalId: plan.principalId,
          mode: plan.mode,
          taxonomyVersion: plan.taxonomyVersion,
          sourceDigest: plan.sourceDigest,
          candidateIds: plan.candidateIds,
          profileRevision: plan.profileRevision,
        }),
      )
      .digest("hex");
  }
}

const REQUEST_KEYS = new Set(["expectedRevision", "runId", "attemptId", "mode", "taxonomyVersion", "candidateIds", "facts", "processingPolicy", "profileRevision"]);
const FACT_KEYS = new Set(["modality", "clientName", "httpStatus", "errorKind", "modelId", "workspaceScope", "selectedText"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const LABEL_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/;
const MAX_SELECTED_TEXT_BYTES = 16 * 1024;

export interface ParsedClassificationRequest {
  expectedRevision: number;
  runId: string;
  attemptId?: string;
  mode: ClassificationMode;
  facts: ObservedFacts;
  candidates: SemanticCandidate[];
}

function invalid(message: string): ClassificationDomainError {
  return new ClassificationDomainError("taxonomy_invalid", message, "validate");
}

/**
 * Validates a browser-supplied classification request. Principal/project come
 * from the authenticated session, never from this payload.
 */
export function parseClassificationRequestInput(input: unknown): ParsedClassificationRequest {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw invalid("request must be an object");
  const value = input as Record<string, unknown>;
  if (!Object.keys(value).every((key) => REQUEST_KEYS.has(key))) throw invalid("unknown request field");
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw invalid("expectedRevision required");
  if (typeof value.runId !== "string" || !ID_PATTERN.test(value.runId)) throw invalid("runId required");
  if (value.attemptId !== undefined && (typeof value.attemptId !== "string" || !ID_PATTERN.test(value.attemptId))) throw invalid("attemptId invalid");
  if (value.mode !== "rules" && value.mode !== "semantic") throw invalid("mode invalid");
  if (value.taxonomyVersion !== undefined && value.taxonomyVersion !== USAGE_TAXONOMY_V1.version) {
    throw new ClassificationDomainError("classification_stale", "taxonomy version mismatch", "validate");
  }

  let candidates: SemanticCandidate[] = [];
  if (value.candidateIds !== undefined) {
    if (!Array.isArray(value.candidateIds) || value.candidateIds.length > DEFAULT_SEMANTIC_PROFILE.limits.maxCandidates) throw invalid("candidateIds invalid");
    const seen = new Set<string>();
    candidates = value.candidateIds.map((candidateId) => {
      if (typeof candidateId !== "string" || !LABEL_ID_PATTERN.test(candidateId) || seen.has(candidateId)) throw invalid("candidateId invalid");
      seen.add(candidateId);
      const label = USAGE_TAXONOMY_V1.labels.find((entry) => entry.id === candidateId);
      if (!label || (label.dimension !== "task_intent" && label.dimension !== "instrument")) {
        throw new ClassificationDomainError("classifier_output_invalid", "candidate not in taxonomy", "validate");
      }
      return { id: candidateId, labelId: candidateId, dimension: label.dimension };
    });
  }

  const rawFacts = value.facts;
  if (!rawFacts || typeof rawFacts !== "object" || Array.isArray(rawFacts)) throw invalid("facts required");
  const factRecord = rawFacts as Record<string, unknown>;
  if (!Object.keys(factRecord).every((key) => FACT_KEYS.has(key))) throw invalid("unknown fact field");
  const facts: ObservedFacts = {};
  if (factRecord.modality !== undefined) {
    if (typeof factRecord.modality !== "string" || factRecord.modality.length > 32) throw invalid("modality invalid");
    facts.modality = factRecord.modality;
  }
  if (factRecord.clientName !== undefined) {
    if (typeof factRecord.clientName !== "string" || factRecord.clientName.length > 80) throw invalid("clientName invalid");
    facts.clientName = factRecord.clientName;
  }
  if (factRecord.httpStatus !== undefined) {
    if (!Number.isSafeInteger(factRecord.httpStatus) || (factRecord.httpStatus as number) < 100 || (factRecord.httpStatus as number) > 599) throw invalid("httpStatus invalid");
    facts.httpStatus = factRecord.httpStatus as number;
  }
  if (factRecord.errorKind !== undefined) {
    if (typeof factRecord.errorKind !== "string" || factRecord.errorKind.length > 40) throw invalid("errorKind invalid");
    facts.errorKind = factRecord.errorKind;
  }
  if (factRecord.modelId !== undefined) {
    if (typeof factRecord.modelId !== "string" || factRecord.modelId.length > 200) throw invalid("modelId invalid");
    facts.modelId = factRecord.modelId;
  }
  if (factRecord.workspaceScope !== undefined) {
    if (!["project", "personal", "unknown"].includes(factRecord.workspaceScope as string)) throw invalid("workspaceScope invalid");
    facts.workspaceScope = factRecord.workspaceScope as ObservedFacts["workspaceScope"];
  }
  if (factRecord.selectedText !== undefined) {
    if (typeof factRecord.selectedText !== "string" || Buffer.byteLength(factRecord.selectedText, "utf8") > MAX_SELECTED_TEXT_BYTES) throw invalid("selectedText invalid");
    facts.selectedText = factRecord.selectedText;
  }

  return {
    expectedRevision: value.expectedRevision as number,
    runId: value.runId,
    ...(value.attemptId !== undefined ? { attemptId: value.attemptId as string } : {}),
    mode: value.mode,
    facts,
    candidates,
  };
}

const CORRECTION_KEYS = new Set(["dimension", "labelId", "note"]);

/** Validates a human correction payload; identity/project/run come from the session and path. */
export function parseHumanCorrectionInput(
  input: unknown,
  ids: { principalId: string; projectId: string; runId: string; at: string },
): HumanCorrection {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ClassificationDomainError("taxonomy_invalid", "correction must be an object", "validate");
  }
  const value = input as Record<string, unknown>;
  if (!Object.keys(value).every((key) => CORRECTION_KEYS.has(key))) {
    throw new ClassificationDomainError("taxonomy_invalid", "unknown correction field", "validate");
  }
  if (typeof value.dimension !== "string" || typeof value.labelId !== "string") {
    throw new ClassificationDomainError("taxonomy_invalid", "dimension and labelId required", "validate");
  }
  const label = USAGE_TAXONOMY_V1.labels.find((entry) => entry.id === value.labelId);
  if (!label || label.dimension !== value.dimension) {
    throw new ClassificationDomainError("classifier_output_invalid", "label not in taxonomy", "validate");
  }
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 200)) {
    throw new ClassificationDomainError("taxonomy_invalid", "note invalid", "validate");
  }
  return {
    runId: ids.runId,
    principalId: ids.principalId,
    projectId: ids.projectId,
    dimension: value.dimension,
    labelId: value.labelId,
    ...(value.note !== undefined ? { note: value.note as string } : {}),
    at: ids.at,
  };
}
