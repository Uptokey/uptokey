/**
 * E2-16 — usage classification metadata persistence (local, principal-scoped).
 * Does not alter financial receipts; E2-15 may project allowed labels only.
 */

import { createHash } from "node:crypto";
import type { ClassificationResult, ClassificationSource } from "./classification-rules.ts";
import { digestObservedFacts, type ObservedFacts } from "./classification-rules.ts";
import { USAGE_TAXONOMY_V1 } from "./classification-taxonomy.ts";

export interface UsageClassificationRecord {
  runId: string;
  attemptId?: string;
  principalId: string;
  projectId: string;
  classifierVersion: string;
  taxonomyVersion: string;
  sourceDigest: string;
  labels: Array<{
    dimension: string;
    labelId: string;
    source: ClassificationSource;
    ruleId?: string;
    confidence?: number;
  }>;
  correctionRef?: string;
  visibility: "project" | "principal" | "private";
  createdAt: string;
  updatedAt: string;
}

export interface HumanCorrection {
  runId: string;
  principalId: string;
  projectId: string;
  dimension: string;
  labelId: string;
  note?: string;
  at: string;
}

export type ClassificationVisibility = UsageClassificationRecord["visibility"];

export const MAX_LABELS_PER_CLASSIFICATION = 64;
export const MAX_CLASSIFICATIONS_PER_PROJECT = 256;

const CLASSIFICATION_SOURCES = new Set<ClassificationSource>(["rule", "model", "user"]);
const CLASSIFICATION_VISIBILITIES = new Set<ClassificationVisibility>(["project", "principal", "private"]);
const RECORD_KEYS = new Set([
  "runId",
  "attemptId",
  "principalId",
  "projectId",
  "classifierVersion",
  "taxonomyVersion",
  "sourceDigest",
  "labels",
  "correctionRef",
  "visibility",
  "createdAt",
  "updatedAt",
]);
const LABEL_KEYS = new Set(["dimension", "labelId", "source", "ruleId", "confidence"]);
const ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;
const DIGEST_PATTERN = /^[a-f0-9]{64}$/;
const ISO_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3})?Z$/;

function classificationInvalid(): Error {
  return new Error("workspace_classification_invalid");
}

function parseClassificationLabel(value: unknown): UsageClassificationRecord["labels"][number] {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw classificationInvalid();
  const item = value as Record<string, unknown>;
  if (!Object.keys(item).every((key) => LABEL_KEYS.has(key))) throw classificationInvalid();
  if (typeof item.dimension !== "string" || item.dimension.length < 1 || item.dimension.length > 40) throw classificationInvalid();
  if (typeof item.labelId !== "string" || item.labelId.length < 1 || item.labelId.length > 100) throw classificationInvalid();
  if (typeof item.source !== "string" || !CLASSIFICATION_SOURCES.has(item.source as ClassificationSource)) throw classificationInvalid();
  if (item.ruleId !== undefined && (typeof item.ruleId !== "string" || item.ruleId.length > 200)) throw classificationInvalid();
  if (
    item.confidence !== undefined &&
    (typeof item.confidence !== "number" || !Number.isFinite(item.confidence) || item.confidence < 0 || item.confidence > 1)
  ) {
    throw classificationInvalid();
  }
  return {
    dimension: item.dimension,
    labelId: item.labelId,
    source: item.source as ClassificationSource,
    ...(item.ruleId !== undefined ? { ruleId: item.ruleId as string } : {}),
    ...(item.confidence !== undefined ? { confidence: item.confidence as number } : {}),
  };
}

/**
 * Validates a persisted classification record. Current-version records must use
 * labels from the current taxonomy; historical versions stay readable.
 */
export function parseUsageClassificationRecord(value: unknown): UsageClassificationRecord {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw classificationInvalid();
  const item = value as Record<string, unknown>;
  if (!Object.keys(item).every((key) => RECORD_KEYS.has(key))) throw classificationInvalid();
  if (typeof item.runId !== "string" || !ID_PATTERN.test(item.runId)) throw classificationInvalid();
  if (item.attemptId !== undefined && (typeof item.attemptId !== "string" || !ID_PATTERN.test(item.attemptId))) throw classificationInvalid();
  if (typeof item.principalId !== "string" || !ID_PATTERN.test(item.principalId)) throw classificationInvalid();
  if (typeof item.projectId !== "string" || !ID_PATTERN.test(item.projectId)) throw classificationInvalid();
  if (typeof item.classifierVersion !== "string" || item.classifierVersion.length < 1 || item.classifierVersion.length > 120) throw classificationInvalid();
  if (typeof item.taxonomyVersion !== "string" || item.taxonomyVersion.length < 1 || item.taxonomyVersion.length > 64) throw classificationInvalid();
  if (typeof item.sourceDigest !== "string" || !DIGEST_PATTERN.test(item.sourceDigest)) throw classificationInvalid();
  if (typeof item.visibility !== "string" || !CLASSIFICATION_VISIBILITIES.has(item.visibility as ClassificationVisibility)) throw classificationInvalid();
  if (typeof item.createdAt !== "string" || !ISO_PATTERN.test(item.createdAt)) throw classificationInvalid();
  if (typeof item.updatedAt !== "string" || !ISO_PATTERN.test(item.updatedAt)) throw classificationInvalid();
  if (item.correctionRef !== undefined && (typeof item.correctionRef !== "string" || item.correctionRef.length < 1 || item.correctionRef.length > 64)) throw classificationInvalid();
  if (!Array.isArray(item.labels) || item.labels.length < 1 || item.labels.length > MAX_LABELS_PER_CLASSIFICATION) throw classificationInvalid();
  const labels = item.labels.map(parseClassificationLabel);
  if (item.taxonomyVersion === USAGE_TAXONOMY_V1.version) {
    for (const label of labels) {
      const known = USAGE_TAXONOMY_V1.labels.find((entry) => entry.id === label.labelId);
      if (!known || known.dimension !== label.dimension) throw classificationInvalid();
    }
  }
  return {
    runId: item.runId,
    ...(item.attemptId !== undefined ? { attemptId: item.attemptId as string } : {}),
    principalId: item.principalId,
    projectId: item.projectId,
    classifierVersion: item.classifierVersion,
    taxonomyVersion: item.taxonomyVersion,
    sourceDigest: item.sourceDigest,
    labels,
    ...(item.correctionRef !== undefined ? { correctionRef: item.correctionRef as string } : {}),
    visibility: item.visibility as ClassificationVisibility,
    createdAt: item.createdAt,
    updatedAt: item.updatedAt,
  };
}

/** Pure record builder shared by the in-memory store and the persistent workspace store. */
export function classificationRecordFromResult(
  ids: { runId: string; attemptId?: string; principalId: string; projectId: string },
  result: ClassificationResult,
  options: { now: string; createdAt?: string; visibility?: ClassificationVisibility; correctionRef?: string },
): UsageClassificationRecord {
  if (!ids.principalId || !ids.projectId || !ids.runId) throw new Error("principalId, projectId and runId are required");
  return {
    runId: ids.runId,
    ...(ids.attemptId ? { attemptId: ids.attemptId } : {}),
    principalId: ids.principalId,
    projectId: ids.projectId,
    classifierVersion: result.classifierVersion,
    taxonomyVersion: result.taxonomyVersion,
    sourceDigest: result.sourceDigest,
    labels: result.labels.map((label) => ({
      dimension: label.dimension,
      labelId: label.labelId,
      source: label.source,
      ruleId: label.ruleId,
      ...(typeof label.confidence === "number" ? { confidence: label.confidence } : {}),
    })),
    ...(options.correctionRef ? { correctionRef: options.correctionRef } : {}),
    visibility: options.visibility ?? "project",
    createdAt: options.createdAt ?? options.now,
    updatedAt: options.now,
  };
}

/** Pure human correction applied to a record (owner/project binding checked by caller). */
export function applyClassificationCorrection(
  row: UsageClassificationRecord,
  correction: HumanCorrection,
  taxonomyVersion = USAGE_TAXONOMY_V1.version,
): UsageClassificationRecord {
  const corrId = createHash("sha256")
    .update(`${correction.runId}:${correction.dimension}:${correction.labelId}:${correction.at}`)
    .digest("hex")
    .slice(0, 16);
  const labels = row.labels.filter((label) => label.dimension !== correction.dimension);
  labels.push({
    dimension: correction.dimension,
    labelId: correction.labelId,
    source: "user",
    ruleId: `user.correction:${corrId}`,
  });
  return {
    ...row,
    labels,
    taxonomyVersion,
    correctionRef: corrId,
    updatedAt: correction.at,
  };
}

/** In-memory store for local tests / first slice before WorkspaceStore wiring. */
export class UsageClassificationStore {
  private readonly byKey = new Map<string, UsageClassificationRecord>();
  private readonly corrections: HumanCorrection[] = [];

  private key(principalId: string, projectId: string, runId: string): string {
    return `${principalId}\0${projectId}\0${runId}`;
  }

  putFromResult(
    ids: { runId: string; attemptId?: string; principalId: string; projectId: string },
    result: ClassificationResult,
    visibility: UsageClassificationRecord["visibility"] = "project",
  ): UsageClassificationRecord {
    if (!ids.principalId || !ids.projectId || !ids.runId) {
      throw new Error("principalId, projectId and runId are required");
    }
    const existing = this.byKey.get(this.key(ids.principalId, ids.projectId, ids.runId));
    const record = classificationRecordFromResult(ids, result, {
      now: new Date().toISOString(),
      ...(existing?.createdAt ? { createdAt: existing.createdAt } : {}),
      ...(existing?.correctionRef ? { correctionRef: existing.correctionRef } : {}),
      visibility,
    });
    this.byKey.set(this.key(ids.principalId, ids.projectId, ids.runId), record);
    return record;
  }

  get(principalId: string, projectId: string, runId: string): UsageClassificationRecord | undefined {
    return this.byKey.get(this.key(principalId, projectId, runId));
  }

  /**
   * Reload path: return stored classification only when sourceDigest still matches.
   * Stale digests do not trigger silent re-inference.
   */
  getIfFresh(
    principalId: string,
    projectId: string,
    runId: string,
    currentDigest: string,
  ): UsageClassificationRecord | undefined {
    const row = this.get(principalId, projectId, runId);
    if (!row) return undefined;
    if (row.sourceDigest !== currentDigest) return undefined;
    return row;
  }

  applyCorrection(correction: HumanCorrection, taxonomyVersion = USAGE_TAXONOMY_V1.version): UsageClassificationRecord {
    const row = this.get(correction.principalId, correction.projectId, correction.runId);
    if (!row) throw new Error("classification_missing");
    if (row.principalId !== correction.principalId || row.projectId !== correction.projectId) {
      throw new Error("source_not_authorized");
    }
    this.corrections.push(correction);
    const updated = applyClassificationCorrection(row, correction, taxonomyVersion);
    this.byKey.set(this.key(row.principalId, row.projectId, row.runId), updated);
    return updated;
  }

  /** Cross-principal leak guard for projections (E2-15 consumer). */
  listForPrincipal(principalId: string, projectId?: string): UsageClassificationRecord[] {
    const out: UsageClassificationRecord[] = [];
    for (const row of this.byKey.values()) {
      if (row.principalId !== principalId) continue;
      if (projectId && row.projectId !== projectId) continue;
      out.push(row);
    }
    return out;
  }

  /** Telemetry-safe projection: labels only, never selected text. */
  projectForTelemetry(row: UsageClassificationRecord): {
    runId: string;
    taxonomyVersion: string;
    classifierVersion: string;
    labelIds: string[];
    sources: ClassificationSource[];
  } {
    return {
      runId: row.runId,
      taxonomyVersion: row.taxonomyVersion,
      classifierVersion: row.classifierVersion,
      labelIds: row.labels.map((l) => l.labelId),
      sources: row.labels.map((l) => l.source),
    };
  }
}

export function factsDigest(facts: ObservedFacts): string {
  return digestObservedFacts(facts);
}

/** Authorized cache key — principal + policy + digests (no cross-context reuse). */
export function classificationCacheKey(parts: {
  principalId: string;
  projectId: string;
  sourceDigest: string;
  taxonomyVersion: string;
  questionVersion?: string;
  modelRevision?: string | null;
  policyId?: string;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        p: parts.principalId,
        j: parts.projectId,
        d: parts.sourceDigest,
        t: parts.taxonomyVersion,
        q: parts.questionVersion ?? null,
        m: parts.modelRevision ?? null,
        pol: parts.policyId ?? null,
      }),
    )
    .digest("hex");
}
