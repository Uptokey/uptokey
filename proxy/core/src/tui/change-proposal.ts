/**
 * Uptokey TUI — reviewable change proposals.
 *
 * Model text → parsed edit blocks → application over the current bytes read
 * by the core → per-file diff and hunks → an exact ChangeSet (expected and new
 * SHA-256 per file) for the canonical writer. Partial approval (files and
 * hunks) builds a new, consistent ChangeSet with its own digest.
 */
import { createHash, randomUUID } from "node:crypto";
import { computeProjectChangeSetDigest, type ProjectChangeOperation } from "@uptokey/sync-contract/project-agent";
import { applyEditBlocks, parseEditBlocks, type ApplyFailure, type FileSnapshot } from "./edit-blocks.ts";
import { applySelectedHunks, diffLines, diffStats, splitLines, toHunks, type DiffHunk } from "./line-diff.ts";
import type { ProjectChangeSetInput, ProjectTextFile } from "./workspace.ts";
import { t } from "./i18n.ts";

export type ProposalState = "proposed" | "applying" | "applied" | "conflict" | "rejected" | "failed" | "unknown";

export interface ProposedFile {
  path: string;
  before: string | null;
  beforeSha256: string | null;
  after: string;
  added: number;
  removed: number;
  hunks: DiffHunk[];
  /** Same grouping is used by review and partial application; omitted legacy values use 3. */
  hunkContext?: 0 | 3;
  /** File-level choice. */
  selected: boolean;
  /** Hunk-level choice (indices); all hunks when the file is selected and this is null. */
  selectedHunks: Set<number> | null;
  /** Preflight outcome from the core, when checked. */
  preflight?: { status: string; issue?: string };
}

export interface ChangeProposal {
  id: string;
  /** Assistant message that proposed it (for continuity). */
  sourceMessageId: string | null;
  files: ProposedFile[];
  failures: ApplyFailure[];
  rejectedBlocks: Array<{ line: number; path: string | null; reason: string }>;
  state: ProposalState;
  runRequestId?: string;
  runId?: string;
  planId?: string;
  receiptId?: string;
  intention?: { messageId: string; requestId: string };
  message?: string;
}

const BOM = String.fromCodePoint(0xfeff);
const BOM_PREFIX = new RegExp(`^${BOM}`);

export function sha256Text(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function normalizedForDiff(text: string | null): string {
  return (text ?? "").replace(BOM_PREFIX, "").replace(/\r\n/g, "\n");
}

export function describeFile(path: string, before: string | null, beforeSha256: string | null, after: string, hunkContext: 0 | 3 = 3): ProposedFile {
  const ops = diffLines(splitLines(normalizedForDiff(before)), splitLines(normalizedForDiff(after)));
  const stats = diffStats(ops);
  return { path, before, beforeSha256, after, added: stats.added, removed: stats.removed, hunks: toHunks(ops, hunkContext), hunkContext, selected: true, selectedHunks: null };
}

/** Explicitly split nearby edits; old hunk indices must never authorize different changes. */
export function splitFileHunks(file: ProposedFile): boolean {
  if (file.before === null || file.hunkContext === 0) return false;
  const ops = diffLines(splitLines(normalizedForDiff(file.before)), splitLines(normalizedForDiff(file.after)));
  file.hunks = toHunks(ops, 0);
  file.hunkContext = 0;
  file.selected = true;
  file.selectedHunks = new Set();
  return true;
}

/**
 * Builds a proposal from assistant text. Only files whose every block applies
 * are proposed; failures are reported with the most similar current lines.
 * Returns null when the text contains no edit blocks at all.
 */
export async function buildProposal(text: string, read: (path: string) => Promise<ProjectTextFile | null>, sourceMessageId: string | null = null): Promise<ChangeProposal | null> {
  const parsed = parseEditBlocks(text);
  if (!parsed.blocks.length && !parsed.rejected.length) return null;
  const snapshots = new Map<string, FileSnapshot>();
  const readFailures: ApplyFailure[] = [];
  for (const path of new Set(parsed.blocks.map((b) => b.path))) {
    try {
      const file = await read(path);
      snapshots.set(path, file ? { text: file.text, sha256: file.sha256 } : { text: null, sha256: null });
    } catch (error) {
      readFailures.push({ path, line: parsed.blocks.find((b) => b.path === path)!.line, reason: `leitura recusada pelo proxy: ${error instanceof Error ? error.message : "falha"}` });
    }
  }
  const applied = applyEditBlocks(parsed.blocks.filter((b) => snapshots.has(b.path)), snapshots);
  return {
    id: randomUUID(),
    sourceMessageId,
    files: applied.files.map((f) => describeFile(f.path, f.before, f.beforeSha256, f.after)),
    failures: [...readFailures, ...applied.failures],
    rejectedBlocks: parsed.rejected,
    state: applied.files.length ? "proposed" : "failed",
  };
}

/** Content to write for one file honoring the hunk selection. */
export function selectedContent(file: ProposedFile): string {
  if (!file.selectedHunks || file.before === null) return file.after;
  if (file.selectedHunks.size === file.hunks.length) return file.after;
  const crlf = file.before.includes("\r\n");
  const bom = file.before.startsWith(BOM);
  let merged = applySelectedHunks(normalizedForDiff(file.before), normalizedForDiff(file.after), file.selectedHunks, file.hunkContext ?? 3);
  if (crlf) merged = merged.replace(/\n/g, "\r\n");
  if (bom) merged = `${BOM}${merged}`;
  return merged;
}

/** Exact ChangeSet for the selected files/hunks, digest computed with the shared contract. */
export function changeSetFor(proposal: ChangeProposal, baseManifestDigest: string): { changeSet: ProjectChangeSetInput; paths: string[] } {
  const operations: ProjectChangeOperation[] = [];
  const paths: string[] = [];
  for (const file of proposal.files) {
    if (!file.selected || (file.selectedHunks && file.selectedHunks.size === 0)) continue;
    const content = selectedContent(file);
    if (file.before !== null && content === file.before) continue;
    const newSha256 = sha256Text(content);
    if (file.before === null) operations.push({ type: "create", path: file.path, newSha256, content } as ProjectChangeOperation);
    else operations.push({ type: "replace", path: file.path, expectedSha256: file.beforeSha256!, newSha256, content } as ProjectChangeOperation);
    paths.push(file.path);
  }
  if (!operations.length) throw new Error("change_selection_empty");
  const raw = { id: `cs-${randomUUID()}`, taskId: `tui-${proposal.id}`, baseManifestDigest, revision: 1, operations };
  return { changeSet: { ...raw, digest: computeProjectChangeSetDigest(raw) }, paths };
}

/** Human summary for the approval intention recorded in the conversation. */
export function intentionText(proposal: ChangeProposal, paths: readonly string[]): string {
  const files = proposal.files.filter((f) => paths.includes(f.path));
  const changes = files.map(file => diffStats(diffLines(splitLines(normalizedForDiff(file.before)), splitLines(normalizedForDiff(selectedContent(file))))));
  const added = changes.reduce((n, change) => n + change.added, 0);
  const removed = changes.reduce((n, change) => n + change.removed, 0);
  return t(paths.length === 1 ? "cp_intent_apply_one" : "cp_intent_apply", { count: paths.length, added, removed, paths: paths.join(", ") });
}

/** Feedback for a follow-up turn when blocks could not be applied. */
export function failureFeedback(proposal: ChangeProposal): string {
  const lines = ["Alguns blocos de edição não puderam ser aplicados ao conteúdo atual:"];
  for (const failure of proposal.failures) {
    lines.push(`- ${failure.path} (bloco na linha ${failure.line}): ${failure.reason}`);
    if (failure.similar) lines.push(`  Trecho mais parecido no arquivo atual:\n${failure.similar.split("\n").map((l) => `    ${l}`).join("\n")}`);
  }
  for (const rejected of proposal.rejectedBlocks) lines.push(`- ${rejected.path ?? "(sem caminho)"} (linha ${rejected.line}): ${rejected.reason}`);
  lines.push("Reenvie somente os blocos corrigidos, copiando o SEARCH exatamente do conteúdo atual.");
  return lines.join("\n");
}
