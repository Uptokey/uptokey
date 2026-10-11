/**
 * E2-16 — deterministic classifiers (no network, no authorization side effects).
 * Reuses error-classification + client-name semantics; does not grant actions.
 */

import { createHash } from "node:crypto";
import {
  USAGE_TAXONOMY_V1,
  assertLabelInTaxonomy,
  type Taxonomy,
  type TaxonomyDimension,
} from "./classification-taxonomy.ts";

export type ClassificationSource = "rule" | "model" | "user";

export interface ObservedFacts {
  modality?: string;
  clientName?: string;
  httpStatus?: number;
  errorKind?: string;
  modelId?: string;
  workspaceScope?: "project" | "personal" | "unknown";
  /** Optional free text for local intent hints only (never sent remotely here). */
  selectedText?: string;
  principalId?: string;
  projectId?: string;
}

export interface ClassificationLabelHit {
  dimension: TaxonomyDimension;
  labelId: string;
  source: ClassificationSource;
  ruleId: string;
  confidence?: number;
  abstained?: boolean;
}

export interface ClassificationResult {
  taxonomyId: string;
  taxonomyVersion: string;
  classifierVersion: string;
  sourceDigest: string;
  labels: ClassificationLabelHit[];
  abstained: boolean;
  evidenceRefs: string[];
  /** Probabilities only when explicitly provided — never invented. */
  probabilities?: Record<string, number>;
}

export const CLASSIFIER_RULES_VERSION = "e2-16.rules.1" as const;

const CLIENT_HINTS: Array<{ re: RegExp; label: string }> = [
  { re: /pwa|uptokey-template|browser/i, label: "client.pwa" },
  { re: /cli|proxy-local|terminal/i, label: "client.cli" },
  { re: /vscode|extension|cursor/i, label: "client.extension" },
  { re: /api|http|sdk/i, label: "client.api" },
];

const MODALITY_MAP: Record<string, string> = {
  text: "modality.text",
  chat: "modality.text",
  image: "modality.image",
  video: "modality.video",
  audio: "modality.audio",
  speech: "modality.audio",
  transcription: "modality.audio",
  tts: "modality.audio",
  embeddings: "modality.embeddings",
  embedding: "modality.embeddings",
  tool: "modality.tool",
  instrument: "modality.tool",
};

const ERROR_KIND_MAP: Record<string, string> = {
  auth: "error.auth",
  forbidden: "error.forbidden",
  billing: "error.billing",
  timeout: "error.timeout",
  rate_limit: "error.rate_limit",
  server: "error.server",
  client: "error.client",
  connection: "error.connection",
  unknown: "error.unknown",
};

const INTENT_HINTS: Array<{ label: string; terms: string[] }> = [
  { label: "intent.chat", terms: ["explica", "explain", "resumo", "summarize", "pergunta", "ask"] },
  { label: "intent.research", terms: ["search", "busca", "clima", "weather", "news", "notícia"] },
  { label: "intent.media", terms: ["image", "imagem", "video", "vídeo", "foto", "audio", "voz"] },
  { label: "intent.files", terms: ["arquivo", "file", "pdf", "pasta", "folder"] },
  { label: "intent.api", terms: ["api", "endpoint", "http", "fetch"] },
  { label: "intent.automation", terms: ["automat", "preset", "agenda", "workflow", "agente"] },
];

export function digestObservedFacts(facts: ObservedFacts): string {
  const payload = JSON.stringify({
    modality: facts.modality ?? null,
    clientName: facts.clientName ?? null,
    httpStatus: facts.httpStatus ?? null,
    errorKind: facts.errorKind ?? null,
    modelId: facts.modelId ?? null,
    workspaceScope: facts.workspaceScope ?? null,
    selectedText: facts.selectedText ?? null,
    principalId: facts.principalId ?? null,
    projectId: facts.projectId ?? null,
  });
  return createHash("sha256").update(payload).digest("hex");
}

function mapHttpStatusToErrorLabel(status: number): string {
  if (status === 401) return "error.auth";
  if (status === 403) return "error.forbidden";
  if (status === 402) return "error.billing";
  if (status === 408) return "error.timeout";
  if (status === 429) return "error.rate_limit";
  if (status >= 500 && status <= 599) return "error.server";
  if (status >= 400 && status < 500) return "error.client";
  return "error.unknown";
}

function classifyClient(name: string | undefined, taxonomy: Taxonomy): ClassificationLabelHit {
  if (!name || name.trim().length < 1) {
    return {
      dimension: "client",
      labelId: "client.unknown",
      source: "rule",
      ruleId: "client.empty",
    };
  }
  for (const hint of CLIENT_HINTS) {
    if (hint.re.test(name)) {
      assertLabelInTaxonomy(taxonomy, hint.label);
      return {
        dimension: "client",
        labelId: hint.label,
        source: "rule",
        ruleId: `client.re:${hint.label}`,
      };
    }
  }
  return {
    dimension: "client",
    labelId: "client.unknown",
    source: "rule",
    ruleId: "client.fallback",
  };
}

function classifyModality(raw: string | undefined, taxonomy: Taxonomy): ClassificationLabelHit {
  if (!raw) {
    return {
      dimension: "modality",
      labelId: "unknown",
      source: "rule",
      ruleId: "modality.empty",
      abstained: true,
    };
  }
  const key = raw.trim().toLowerCase();
  const label = MODALITY_MAP[key];
  if (!label) {
    return {
      dimension: "modality",
      labelId: "unknown",
      source: "rule",
      ruleId: "modality.unknown",
      abstained: true,
    };
  }
  assertLabelInTaxonomy(taxonomy, label);
  return {
    dimension: "modality",
    labelId: label,
    source: "rule",
    ruleId: `modality.map:${key}`,
  };
}

function classifyError(facts: ObservedFacts, taxonomy: Taxonomy): ClassificationLabelHit | null {
  if (typeof facts.httpStatus === "number") {
    const label = mapHttpStatusToErrorLabel(facts.httpStatus);
    assertLabelInTaxonomy(taxonomy, label);
    return {
      dimension: "error_kind",
      labelId: label,
      source: "rule",
      ruleId: `error.http:${facts.httpStatus}`,
    };
  }
  if (facts.errorKind) {
    const mapped = ERROR_KIND_MAP[facts.errorKind] ?? "error.unknown";
    assertLabelInTaxonomy(taxonomy, mapped);
    return {
      dimension: "error_kind",
      labelId: mapped,
      source: "rule",
      ruleId: `error.kind:${facts.errorKind}`,
    };
  }
  return null;
}

function classifyIntentLocal(text: string | undefined, taxonomy: Taxonomy): ClassificationLabelHit {
  if (!text || text.trim().length < 1) {
    return {
      dimension: "task_intent",
      labelId: "unknown",
      source: "rule",
      ruleId: "intent.empty",
      abstained: true,
    };
  }
  const lower = text.toLowerCase();
  let best: { label: string; score: number } | null = null;
  for (const row of INTENT_HINTS) {
    let score = 0;
    for (const term of row.terms) {
      if (lower.includes(term)) score += 1;
    }
    if (score > 0 && (!best || score > best.score)) {
      best = { label: row.label, score };
    }
  }
  if (!best || best.score < 1) {
    return {
      dimension: "task_intent",
      labelId: "no_match",
      source: "rule",
      ruleId: "intent.no_match",
      abstained: true,
    };
  }
  // Ambiguous: two labels with same score → abstain
  const tied = INTENT_HINTS.filter((row) => {
    let score = 0;
    for (const term of row.terms) if (lower.includes(term)) score += 1;
    return score === best!.score;
  });
  if (tied.length > 1) {
    return {
      dimension: "task_intent",
      labelId: "unknown",
      source: "rule",
      ruleId: "intent.ambiguous",
      abstained: true,
    };
  }
  assertLabelInTaxonomy(taxonomy, best.label);
  return {
    dimension: "task_intent",
    labelId: best.label,
    source: "rule",
    ruleId: `intent.hint:${best.label}`,
    confidence: Math.min(0.99, 0.55 + best.score * 0.1),
  };
}

function classifyScope(scope: ObservedFacts["workspaceScope"], taxonomy: Taxonomy): ClassificationLabelHit {
  const label =
    scope === "project"
      ? "scope.project"
      : scope === "personal"
        ? "scope.personal"
        : "scope.unknown";
  assertLabelInTaxonomy(taxonomy, label);
  return {
    dimension: "workspace_scope",
    labelId: label,
    source: "rule",
    ruleId: `scope.${scope ?? "unknown"}`,
  };
}

/**
 * Pure rules classification. Never triggers tools, grants, or network I/O.
 */
export function classifyByRules(
  facts: ObservedFacts,
  taxonomy: Taxonomy = USAGE_TAXONOMY_V1,
): ClassificationResult {
  const labels: ClassificationLabelHit[] = [];
  labels.push(classifyModality(facts.modality, taxonomy));
  labels.push(classifyClient(facts.clientName, taxonomy));
  const err = classifyError(facts, taxonomy);
  if (err) labels.push(err);
  labels.push(classifyIntentLocal(facts.selectedText, taxonomy));
  labels.push(classifyScope(facts.workspaceScope, taxonomy));
  // Instrument suggestion is always non-authorizing placeholder from rules path
  labels.push({
    dimension: "instrument",
    labelId: "instrument.none",
    source: "rule",
    ruleId: "instrument.rules_path",
  });

  const abstained = labels.some((l) => l.abstained === true);
  return {
    taxonomyId: taxonomy.id,
    taxonomyVersion: taxonomy.version,
    classifierVersion: CLASSIFIER_RULES_VERSION,
    sourceDigest: digestObservedFacts(facts),
    labels,
    abstained,
    evidenceRefs: ["rule:e2-16.rules.1"],
  };
}

/**
 * Rejects model/user labels that are not in taxonomy or have invalid probabilities.
 */
export function validateClassificationResult(
  result: ClassificationResult,
  taxonomy: Taxonomy = USAGE_TAXONOMY_V1,
): { ok: true } | { ok: false; code: string; message: string } {
  if (result.taxonomyVersion !== taxonomy.version || result.taxonomyId !== taxonomy.id) {
    return { ok: false, code: "classification_stale", message: "taxonomy revision mismatch" };
  }
  for (const hit of result.labels) {
    if (!taxonomy.labels.some((l) => l.id === hit.labelId)) {
      return { ok: false, code: "classifier_output_invalid", message: `unknown label ${hit.labelId}` };
    }
  }
  if (result.probabilities) {
    for (const [k, v] of Object.entries(result.probabilities)) {
      if (typeof v !== "number" || !Number.isFinite(v) || Number.isNaN(v) || v < 0 || v > 1) {
        return { ok: false, code: "classifier_output_invalid", message: `invalid probability for ${k}` };
      }
    }
  }
  return { ok: true };
}

/**
 * Authorization boundary: a semantic/instrument suggestion NEVER authorizes.
 * Callers must re-check grants in code before any write/install/send.
 */
export function suggestionAuthorizesAction(_result: ClassificationResult): false {
  return false;
}
