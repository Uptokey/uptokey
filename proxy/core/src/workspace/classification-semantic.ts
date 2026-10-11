/**
 * E2-16 — optional semantic judgment adapter (TypeSafe-shaped).
 * Local accept uses fixtures only — no live inference, no paid calls.
 * Suggestions never authorize write/install/send.
 */

import type { ClassificationLabelHit, ClassificationResult } from "./classification-rules.ts";
import { CLASSIFIER_RULES_VERSION, digestObservedFacts, type ObservedFacts } from "./classification-rules.ts";
import {
  USAGE_TAXONOMY_V1,
  assertLabelInTaxonomy,
  type Taxonomy,
} from "./classification-taxonomy.ts";
import { suggestionAuthorizesAction } from "./classification-rules.ts";

export type SemanticMode = "disabled" | "fixture" | "typesafe";

export interface SemanticJudgmentProfile {
  provider: "typesafe" | "local_fixture";
  modelAlias: string;
  modelRevision: string | null;
  questionVersion: string;
  thresholds: { minConfidence: number; minSeparation: number };
  limits: { maxCandidates: number; maxQuestions: number; timeoutMs: number; maxTextBytes: number };
  enabled: boolean;
}

export const DEFAULT_SEMANTIC_PROFILE: SemanticJudgmentProfile = {
  provider: "local_fixture",
  modelAlias: "jev-latest",
  modelRevision: null,
  questionVersion: "e2-16.q.1",
  thresholds: { minConfidence: 0.55, minSeparation: 0.08 },
  limits: {
    maxCandidates: 32,
    maxQuestions: 8,
    timeoutMs: 10_000,
    maxTextBytes: 16 * 1024,
  },
  enabled: false,
};

export interface SemanticCandidate {
  id: string;
  labelId: string;
  dimension: "task_intent" | "instrument";
}

export interface SemanticFixtureAnswer {
  choice: string;
  distribution: Record<string, number>;
  confidence: number;
}

export interface SemanticEvalCase {
  id: string;
  text: string;
  expectedLabelId: string;
  candidates: SemanticCandidate[];
}

export class ClassifierDisabledError extends Error {
  readonly code = "classifier_disabled";
  constructor(message = "semantic classifier disabled") {
    super(message);
    this.name = "ClassifierDisabledError";
  }
}

export class ClassifierTimeoutError extends Error {
  readonly code = "classifier_timeout";
  constructor(message = "semantic classifier timeout") {
    super(message);
    this.name = "ClassifierTimeoutError";
  }
}

function assertTextBudget(text: string, limits: SemanticJudgmentProfile["limits"]): void {
  const bytes = Buffer.byteLength(text, "utf8");
  if (bytes > limits.maxTextBytes) {
    throw new Error("classification_input_too_large");
  }
}

/**
 * Fixture chooser: pick the candidate whose id/label appears in text, else abstain.
 * Mimics Choice primitive without network.
 */
export function fixtureChoose(
  text: string,
  candidates: SemanticCandidate[],
  profile: SemanticJudgmentProfile = DEFAULT_SEMANTIC_PROFILE,
): SemanticFixtureAnswer {
  assertTextBudget(text, profile.limits);
  if (candidates.length > profile.limits.maxCandidates) {
    throw new Error("too_many_candidates");
  }
  const lower = text.toLowerCase();
  const HINTS: Record<string, string[]> = {
    "intent.chat": ["explica", "explain", "resumo", "summarize", "pergunta", "ask", "chat"],
    "intent.research": ["search", "busca", "clima", "weather", "news", "notícia", "research"],
    "intent.media": ["image", "imagem", "video", "vídeo", "foto", "audio", "voz"],
    "intent.files": ["arquivo", "file", "pdf", "pasta", "folder"],
    "intent.api": ["api", "endpoint", "http", "fetch"],
    "intent.automation": ["automat", "preset", "agenda", "workflow", "agente"],
  };
  const scores: Record<string, number> = {};
  for (const c of candidates) {
    let score = 0;
    if (lower.includes(c.id.toLowerCase()) || lower.includes(c.labelId.toLowerCase())) score += 2;
    for (const term of HINTS[c.labelId] ?? []) {
      if (lower.includes(term)) score += 1;
    }
    scores[c.id] = score;
  }
  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = ranked[0];
  const second = ranked[1];
  if (!top || top[1] < 1) {
    return {
      choice: "no_match",
      distribution: Object.fromEntries(candidates.map((c) => [c.id, 0])),
      confidence: 0,
    };
  }
  const separation = top[1] - (second?.[1] ?? 0);
  if (separation < profile.thresholds.minSeparation) {
    return {
      choice: "no_match",
      distribution: Object.fromEntries(ranked),
      confidence: 0.2,
    };
  }
  const conf = Math.min(0.95, 0.5 + top[1] * 0.2);
  const dist: Record<string, number> = {};
  let rest = 1 - conf;
  for (const c of candidates) {
    dist[c.id] = c.id === top[0] ? conf : rest / Math.max(1, candidates.length - 1);
  }
  return { choice: top[0], distribution: dist, confidence: conf };
}

export function applySemanticFixture(
  facts: ObservedFacts,
  candidates: SemanticCandidate[],
  profile: SemanticJudgmentProfile = { ...DEFAULT_SEMANTIC_PROFILE, enabled: true },
  taxonomy: Taxonomy = USAGE_TAXONOMY_V1,
): ClassificationResult {
  if (!profile.enabled || profile.provider === "typesafe" && false) {
    // typesafe live path intentionally not exercised in local accept
  }
  if (!profile.enabled) {
    throw new ClassifierDisabledError();
  }
  const text = facts.selectedText ?? "";
  const answer = fixtureChoose(text, candidates, profile);
  const chosen = candidates.find((c) => c.id === answer.choice);
  const labels: ClassificationLabelHit[] = [];
  let abstained = false;

  if (!chosen || answer.choice === "no_match" || answer.confidence < profile.thresholds.minConfidence) {
    abstained = true;
    labels.push({
      dimension: "task_intent",
      labelId: "unknown",
      source: "model",
      ruleId: `fixture:${profile.questionVersion}:abstain`,
      abstained: true,
      confidence: answer.confidence,
    });
  } else {
    assertLabelInTaxonomy(taxonomy, chosen.labelId);
    labels.push({
      dimension: chosen.dimension,
      labelId: chosen.labelId,
      source: "model",
      ruleId: `fixture:${profile.questionVersion}:${chosen.id}`,
      confidence: answer.confidence,
    });
  }

  // Always attach non-authorizing instrument marker
  labels.push({
    dimension: "instrument",
    labelId: abstained ? "instrument.none" : "instrument.suggest",
    source: "model",
    ruleId: "fixture.instrument_marker",
  });

  const result: ClassificationResult = {
    taxonomyId: taxonomy.id,
    taxonomyVersion: taxonomy.version,
    classifierVersion: `${CLASSIFIER_RULES_VERSION}+semantic.fixture`,
    sourceDigest: digestObservedFacts(facts),
    labels,
    abstained,
    evidenceRefs: [`fixture:${profile.questionVersion}`, `modelAlias:${profile.modelAlias}`],
    probabilities: answer.distribution,
  };

  // Hard invariant
  if (suggestionAuthorizesAction(result) !== false) {
    throw new Error("authorization_invariant_broken");
  }
  return result;
}

/** Synthetic evaluation matrix — code tests report abstention/errors; not model accuracy claims. */
export const SYNTHETIC_EVAL_CASES: SemanticEvalCase[] = [
  {
    id: "eval-chat",
    text: "explica este resumo",
    expectedLabelId: "intent.chat",
    candidates: [
      { id: "chat", labelId: "intent.chat", dimension: "task_intent" },
      { id: "research", labelId: "intent.research", dimension: "task_intent" },
    ],
  },
  {
    id: "eval-research",
    text: "busca o clima em SP",
    expectedLabelId: "intent.research",
    candidates: [
      { id: "chat", labelId: "intent.chat", dimension: "task_intent" },
      { id: "research", labelId: "intent.research", dimension: "task_intent" },
    ],
  },
  {
    id: "eval-ambiguous",
    text: "olá",
    expectedLabelId: "unknown",
    candidates: [
      { id: "chat", labelId: "intent.chat", dimension: "task_intent" },
      { id: "research", labelId: "intent.research", dimension: "task_intent" },
    ],
  },
];

export function runSyntheticEval(
  cases: SemanticEvalCase[] = SYNTHETIC_EVAL_CASES,
  profile: SemanticJudgmentProfile = { ...DEFAULT_SEMANTIC_PROFILE, enabled: true },
): {
  total: number;
  matched: number;
  abstained: number;
  confusion: Array<{ id: string; expected: string; got: string; abstained: boolean }>;
} {
  const confusion: Array<{ id: string; expected: string; got: string; abstained: boolean }> = [];
  let matched = 0;
  let abstained = 0;
  for (const c of cases) {
    const result = applySemanticFixture({ selectedText: c.text }, c.candidates, profile);
    const hit = result.labels.find((l) => l.dimension === "task_intent");
    const got = hit?.labelId ?? "unknown";
    if (result.abstained) abstained += 1;
    if (got === c.expectedLabelId || (c.expectedLabelId === "unknown" && result.abstained)) {
      matched += 1;
    }
    confusion.push({ id: c.id, expected: c.expectedLabelId, got, abstained: result.abstained });
  }
  return { total: cases.length, matched, abstained, confusion };
}
