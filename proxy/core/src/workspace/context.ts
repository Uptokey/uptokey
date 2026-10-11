import { createHash } from "node:crypto";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import {
  type Artifact,
  type ContextEntry,
  type ContextSnapshot,
  type DataDestination,
  type ProjectContext,
  parseContextSnapshot,
  parseProjectContext,
  WorkflowContractError,
} from "@uptokey/sync-contract/workflow";

export type { ContextEntry, ContextSnapshot, ProjectContext };
export type ContextKind = ContextEntry["kind"];
export type ContextOrigin = ContextEntry["origin"];
export type ContextActor = "human" | "model";

export const CONTEXT_KINDS = ["fact", "decision", "hypothesis", "task"] as const;
export const CONTEXT_ORIGINS = ["user", "source", "model"] as const;

const WORKFLOW_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/;

export function assertSafeText(value: unknown, maximum: number, label: string): asserts value is string {
  if (typeof value !== "string" || value.length < 1 || value.length > maximum) throw new Error(`${label}_invalid`);
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 32 || code === 127) throw new Error(`${label}_control_char`);
  }
}

export function assertWorkflowId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !WORKFLOW_ID.test(value)) throw new Error(`${label}_invalid`);
}

export function assertOpaqueId(value: unknown, label: string): asserts value is string {
  assertWorkflowId(value, label);
}

export function assertIdentityId(value: unknown): asserts value is string {
  if (typeof value !== "string" || !WORKFLOW_ID.test(value)) throw new Error("workspace_identity_invalid");
}

export function assertIsoTime(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value)) throw new Error(`${label}_invalid`);
  const time = Date.parse(value);
  if (!Number.isFinite(time) || new Date(time).toISOString() !== value) throw new Error(`${label}_invalid`);
}

function asContract<T>(run: () => T, code: string): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof WorkflowContractError) throw new Error(code);
    throw error;
  }
}

function assertWritePolicy(entry: ContextEntry, actor?: ContextActor): void {
  if (entry.kind === "hypothesis" && entry.status === "confirmed") throw new Error("workspace_hypothesis_is_not_a_decision");
  if (entry.kind === "decision" && entry.status === "confirmed" && entry.origin === "model") {
    throw new Error("workspace_model_cannot_confirm_decision");
  }
  if (actor === "model" && entry.kind === "decision" && entry.status === "confirmed") {
    throw new Error("workspace_model_cannot_confirm_decision");
  }
  if (actor === "model" && entry.kind === "hypothesis" && entry.status !== "proposed") {
    throw new Error("workspace_model_hypothesis_not_proposed");
  }
}

function parseEntries(entries: unknown[], sources: ProjectContext["sources"] = []): ContextEntry[] {
  for (const item of entries) {
    if (item && typeof item === "object" && "kind" in item && "status" in item) {
      assertWritePolicy(item as ContextEntry);
    }
  }
  return asContract(() => parseProjectContext({
    schemaVersion: 1,
    id: "project_validate",
    createdAt: "2026-09-16T12:00:00.000Z",
    ownerPrincipalId: "principalA",
    revision: 1,
    name: "validate",
    goal: "",
    constraints: [],
    entries,
    sources,
    artifactRefs: [],
    updatedAt: "2026-09-16T12:00:00.000Z",
  }), "workspace_entry_invalid").entries;
}

export function assertContextEntry(value: unknown): ContextEntry {
  return parseEntries([value])[0]!;
}

export function assertContextEntries(value: unknown): ContextEntry[] {
  if (!Array.isArray(value)) throw new Error("workspace_entries_invalid");
  return parseEntries(value);
}

export function createContextEntry(input: {
  id: string;
  kind: ContextKind;
  origin: ContextOrigin;
  status: ContextEntry["status"];
  content: string;
  sourceRefs?: string[];
  createdAt: string;
  supersedes?: string | null;
}): ContextEntry {
  return assertContextEntry({
    id: input.id,
    kind: input.kind,
    origin: input.origin,
    status: input.status,
    content: input.content,
    sourceRefs: input.sourceRefs ?? [],
    createdAt: input.createdAt,
    supersedes: input.supersedes ?? null,
  });
}

/**
 * Human confirmation of a hypothesis creates a new user decision.
 * The hypothesis is superseded; its kind never mutates into a decision.
 */
export function confirmHypothesisAsDecision(
  entries: ContextEntry[],
  hypothesisId: string,
  decisionId: string,
  actor: ContextActor,
  createdAt: string,
): ContextEntry[] {
  if (actor !== "human") throw new Error("workspace_model_cannot_confirm_decision");
  const current = assertContextEntries(entries);
  const hypothesis = current.find((entry) => entry.id === hypothesisId);
  if (!hypothesis) throw new Error("workspace_entry_not_found");
  if (hypothesis.kind !== "hypothesis") throw new Error("workspace_not_a_hypothesis");
  if (hypothesis.status === "superseded" || hypothesis.status === "done") throw new Error("workspace_hypothesis_not_confirmable");
  const next = current.map((entry) => (
    entry.id === hypothesisId ? { ...entry, status: "superseded" as const } : entry
  ));
  next.push({
    id: decisionId,
    kind: "decision",
    origin: "user",
    status: "confirmed",
    content: hypothesis.content,
    sourceRefs: hypothesis.sourceRefs,
    createdAt,
    supersedes: hypothesisId,
  });
  return parseEntries(next);
}

export function appendContextEntry(entries: ContextEntry[], entry: ContextEntry, actor: ContextActor): ContextEntry[] {
  const next = createContextEntry(entry);
  assertWritePolicy(next, actor);
  return assertContextEntries([...entries, next]);
}

export function createContextSnapshot(input: {
  id: string;
  createdAt: string;
  project: ProjectContext;
  artifacts: Artifact[];
  selectedEntryIds: string[];
  excludedEntryIds: string[];
  selectedArtifactIds: string[];
  allowedDestinations: DataDestination[];
  maxContextBytes: number;
}): ContextSnapshot {
  const entryIds = new Set(input.project.entries.map((entry) => entry.id));
  const artifactIds = new Set(input.project.artifactRefs);
  for (const id of input.selectedEntryIds) {
    if (!entryIds.has(id)) throw new Error("workspace_snapshot_entry_unknown");
  }
  for (const id of input.excludedEntryIds) {
    if (!entryIds.has(id)) throw new Error("workspace_snapshot_entry_unknown");
  }
  for (const id of input.selectedArtifactIds) {
    if (!artifactIds.has(id)) throw new Error("workspace_snapshot_artifact_unknown");
  }
  const selected = new Set(input.selectedEntryIds);
  const sourceRefs = [...new Set(
    input.project.entries.filter((entry) => selected.has(entry.id)).flatMap((entry) => entry.sourceRefs),
  )];
  return asContract(() => parseContextSnapshot({
    schemaVersion: 1,
    id: input.id,
    createdAt: input.createdAt,
    projectId: input.project.id,
    projectRevision: input.project.revision,
    entries: input.selectedEntryIds.map((id) => {
      const entry = input.project.entries.find((item) => item.id === id)!;
      return { id, sha256: createHash("sha256").update(canonicalJson(entry), "utf8").digest("hex") };
    }),
    artifacts: input.selectedArtifactIds.map((id) => {
      const artifact = input.artifacts.find((item) => item.id === id);
      if (!artifact) throw new Error("workspace_snapshot_artifact_unknown");
      return { id, sha256: artifact.sha256 };
    }),
    sourceRefs,
    allowedDestinations: input.allowedDestinations,
    maxContextBytes: input.maxContextBytes,
    excludedEntryIds: input.excludedEntryIds,
  }), "workspace_snapshot_invalid");
}
