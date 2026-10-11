/**
 * Uptokey TUI — C7 reflection loop for SEARCH/REPLACE edits (Aider-style).
 *
 * When a model-proposed SEARCH block does not match the real file, this loop
 * re-prompts the coder with the actual current text around the failed region
 * ("Este SEARCH não bateu; aqui está o texto atual entre as linhas X–Y.
 * Corrija o bloco.") up to the grant's attempt limit, instead of aborting.
 *
 * Governance (single W5): the caller authorizes /aplicar once. The reflection
 * grant (`@uptokey/sync-contract/reflection-grant`), minted from that consent,
 * bounds this loop: ≤ 3 attempts, ≤ 4096 tokens per attempt, ≤ 12288 tokens
 * total, valid 5 minutes. This module performs no file effect and no network
 * call of its own — inference is injected, candidate bytes are returned for
 * the canonical write plan. When the loop still fails after the grant is
 * exhausted, the outcome is a conflict carrying every intent tried and
 * `newGrantRequired: true`; continuing requires a new consent.
 *
 * Token accounting is real: the usage reported by the injected coder is
 * recorded per attempt and cumulatively, and the ceilings are enforced on
 * those reported numbers. Nothing runs past the grant.
 */
import {
  applyEditBlocks,
  EDIT_PROTOCOL_INSTRUCTIONS,
  parseEditBlocks,
  type AppliedFile,
  type ApplyFailure,
  type EditBlock,
  type FileSnapshot,
} from "../tui/edit-blocks.ts";
import {
  parseReflectionGrant,
  reflectionGrantActive,
  reflectionGrantCovers,
  type ReflectionGrant,
} from "@uptokey/sync-contract/reflection-grant";

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface CoderResponse {
  text: string;
  /** Usage as reported by the provider for this call; enforced against the grant. */
  usage: TokenUsage;
}

/** Injected coder inference (the canonical gateway transport belongs to the caller). */
export type CoderInfer = (prompt: string, signal?: AbortSignal) => Promise<CoderResponse>;

export interface ReflectionIntent {
  attempt: number;
  /** Failed blocks addressed by this attempt, with their exact failure reasons. */
  failed: Array<{ path: string; line: number; reason: string; search: string }>;
  /** Correction blocks the coder proposed for this attempt. */
  corrections: EditBlock[];
  /** Malformed blocks in the correction response; they never apply. */
  rejected: Array<{ line: number; path: string | null; reason: string }>;
  promptBytes: number;
  responseBytes: number;
  usage: TokenUsage;
}

/** Usage already consumed under this grant by earlier reflections of the same consent. */
export interface PriorUsage extends TokenUsage {
  attempts: number;
}

export interface EditReflectionInput {
  /** Blocks from the original proposal (already parsed; prose never executes). */
  blocks: readonly EditBlock[];
  /** Current file snapshots read by the core; the loop never re-reads anything. */
  snapshots: ReadonlyMap<string, FileSnapshot>;
  /** Reflection grant minted from the single W5 consent of /aplicar. */
  grant: unknown;
  infer: CoderInfer;
  /** Usage already spent under the same grant (chained reflections stay bounded). */
  priorUsage?: PriorUsage;
  /** Injectable clock (ISO string); defaults to the current time. */
  now?: () => string;
  signal?: AbortSignal;
}

export type ReflectionOutcomeState = "converged" | "conflict" | "budget_exceeded" | "expired";

export interface EditReflectionResult {
  state: ReflectionOutcomeState;
  /** Every intent tried under the grant, in order — the conflict report. */
  attempts: ReflectionIntent[];
  /** Final merged block set (with corrections applied to the block list). */
  blocks: EditBlock[];
  /** Candidate bytes ready for the write plan; present only when converged. */
  files: AppliedFile[];
  /** Remaining failures when not converged. */
  failures: ApplyFailure[];
  usage: {
    total: TokenUsage;
    perAttempt: TokenUsage[];
    /** Attempts available before this call (prior usage under the same grant). */
    priorAttempts: number;
  };
  grant: ReflectionGrant;
  /** True when any further reflection requires a new W5 consent. */
  newGrantRequired: boolean;
}

const CONTEXT_LINES = 6;
const MAX_REGION_LINES = 120;

function addUsage(a: TokenUsage, b: TokenUsage): TokenUsage {
  return { inputTokens: a.inputTokens + b.inputTokens, outputTokens: a.outputTokens + b.outputTokens };
}

function totalTokens(usage: TokenUsage): number {
  return usage.inputTokens + usage.outputTokens;
}

/** Real text region of the current file that a failed SEARCH was aiming at. */
function locateRegion(text: string, failure: ApplyFailure): { start: number; end: number; content: string } {
  const lines = text.split("\n");
  const similarLines = (failure.similar ?? "").split("\n").filter((l) => l.trim());
  let at = -1;
  if (similarLines.length) {
    const first = similarLines[0]!.trim();
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.trim() === first) { at = i; break; }
    }
  }
  if (at < 0) {
    if (lines.length <= MAX_REGION_LINES) return { start: 1, end: lines.length, content: text };
    at = 0;
  }
  const start = Math.max(0, at - CONTEXT_LINES);
  const end = Math.min(lines.length, at + Math.max(similarLines.length, 1) + CONTEXT_LINES);
  return { start: start + 1, end, content: lines.slice(start, end).join("\n") };
}

/**
 * Builds the Aider-style correction prompt: the failed block, the precise
 * failure reason, and the real current text between lines X–Y.
 */
export function buildCorrectionPrompt(
  failed: Array<{ block: EditBlock; failure: ApplyFailure }>,
  snapshots: ReadonlyMap<string, FileSnapshot>,
  attempt: number,
  maxAttempts: number,
): string {
  const parts: string[] = [
    `Um ou mais blocos SEARCH/REPLACE não puderam ser aplicados (tentativa ${attempt} de ${maxAttempts}).`,
    "Este SEARCH não bateu; abaixo está o texto atual real do arquivo entre as linhas indicadas. Corrija o bloco copiando o SEARCH exatamente do conteúdo atual.",
    "",
  ];
  for (const { block, failure } of failed) {
    parts.push(`Bloco na linha ${block.line} (arquivo ${block.path}): ${failure.reason}`);
    parts.push("SEARCH proposto:");
    parts.push(block.search.split("\n").map((l) => `  ${l}`).join("\n"));
    const snapshot = snapshots.get(block.path);
    if (snapshot?.text != null) {
      const region = locateRegion(snapshot.text, failure);
      parts.push(`Texto atual de ${block.path} entre as linhas ${region.start}–${region.end}:`);
      parts.push(region.content.split("\n").map((l) => `  ${l}`).join("\n"));
    } else {
      parts.push(`O arquivo ${block.path} não existe no snapshot atual; use SEARCH vazio para criar.`);
    }
    parts.push("");
  }
  parts.push("Responda APENAS com os blocos corrigidos no protocolo:");
  parts.push(EDIT_PROTOCOL_INSTRUCTIONS);
  return parts.join("\n");
}

/**
 * Merges correction blocks into the current block set: a failed block is
 * replaced in place by its corrections; a failed block WITHOUT a correction
 * is retained (the intent stays and keeps failing — an intended edit is never
 * silently dropped); other blocks are preserved; exact duplicates are dropped.
 */
export function mergeCorrections(
  current: readonly EditBlock[],
  failed: ReadonlySet<EditBlock>,
  corrections: readonly EditBlock[],
): EditBlock[] {
  const byFailedPath = new Map<string, EditBlock[]>();
  for (const block of corrections) {
    if (!byFailedPath.has(block.path)) byFailedPath.set(block.path, []);
    byFailedPath.get(block.path)!.push(block);
  }
  const seen = new Set<string>();
  const key = (b: EditBlock) => `${b.path}\u0000${b.search}\u0000${b.replace}`;
  const out: EditBlock[] = [];
  const pushUnique = (block: EditBlock): void => {
    const k = key(block);
    if (seen.has(k)) return;
    seen.add(k);
    out.push(block);
  };
  for (const block of current) {
    if (failed.has(block)) {
      const fixes = byFailedPath.get(block.path);
      if (fixes?.length) {
        for (const correction of fixes) pushUnique(correction);
        byFailedPath.delete(block.path);
      } else {
        pushUnique(block);
      }
      continue;
    }
    pushUnique(block);
  }
  // Corrections for paths with no failed slot (new files, or path untouched by failures).
  for (const list of byFailedPath.values()) for (const block of list) pushUnique(block);
  return out;
}

/**
 * Reflection loop under ONE grant. Returns candidate file bytes for the
 * canonical write plan when converged; otherwise a conflict with every intent
 * tried and `newGrantRequired: true`.
 */
export async function editWithReflection(input: EditReflectionInput): Promise<EditReflectionResult> {
  const now = input.now ?? (() => new Date().toISOString());
  const grant = parseReflectionGrant(input.grant);
  const prior = input.priorUsage ?? { attempts: 0, inputTokens: 0, outputTokens: 0 };
  const attempts: ReflectionIntent[] = [];
  const perAttempt: TokenUsage[] = [];
  let total: TokenUsage = { inputTokens: prior.inputTokens, outputTokens: prior.outputTokens };
  const exhausted = (state: ReflectionOutcomeState, blocks: EditBlock[], failures: ApplyFailure[]): EditReflectionResult => ({
    state,
    attempts,
    blocks,
    files: [],
    failures,
    usage: { total: { inputTokens: total.inputTokens - prior.inputTokens, outputTokens: total.outputTokens - prior.outputTokens }, perAttempt, priorAttempts: prior.attempts },
    grant,
    newGrantRequired: true,
  });

  if (!reflectionGrantActive(grant, now())) return exhausted("expired", [...input.blocks], []);
  if (prior.attempts >= grant.maxAttempts || !reflectionGrantCovers(grant, prior)) {
    return exhausted("conflict", [...input.blocks], []);
  }

  let current: EditBlock[] = [...input.blocks];
  const apply = (): { files: AppliedFile[]; failures: ApplyFailure[] } =>
    applyEditBlocks(current, input.snapshots);

  let applied = apply();
  for (let attempt = prior.attempts + 1; attempt <= grant.maxAttempts; attempt++) {
    if (input.signal?.aborted || !reflectionGrantActive(grant, now())) return exhausted("expired", current, applied.failures);
    if (!applied.failures.length) {
      return {
        state: "converged",
        attempts,
        blocks: current,
        files: applied.files,
        failures: [],
        usage: { total: { inputTokens: total.inputTokens - prior.inputTokens, outputTokens: total.outputTokens - prior.outputTokens }, perAttempt, priorAttempts: prior.attempts },
        grant,
        newGrantRequired: false,
      };
    }
    // Only blocks that actually failed go back to the coder.
    const failedKeys = new Set(applied.failures.map((f) => `${f.path}\u0000${f.line}`));
    const failedBlocks = current.filter((b) => failedKeys.has(`${b.path}\u0000${b.line}`));
    const failedWithReasons = failedBlocks.map((block) => ({
      block,
      failure: applied.failures.find((f) => f.path === block.path && f.line === block.line)!,
    }));
    const prompt = buildCorrectionPrompt(failedWithReasons, input.snapshots, attempt, grant.maxAttempts);
    const response = await input.infer(prompt, input.signal);
    const usage = response.usage;
    if (!Number.isSafeInteger(usage.inputTokens) || usage.inputTokens < 0 || !Number.isSafeInteger(usage.outputTokens) || usage.outputTokens < 0) {
      return exhausted("budget_exceeded", current, applied.failures);
    }
    const parsed = parseEditBlocks(response.text);
    attempts.push({
      attempt,
      failed: failedWithReasons.map(({ block, failure }) => ({ path: block.path, line: block.line, reason: failure.reason, search: block.search })),
      corrections: parsed.blocks,
      rejected: parsed.rejected,
      promptBytes: Buffer.byteLength(prompt, "utf8"),
      responseBytes: Buffer.byteLength(response.text, "utf8"),
      usage: { ...usage },
    });
    perAttempt.push({ ...usage });
    total = addUsage(total, usage);
    if (totalTokens(usage) > grant.maxTokensPerAttempt) return exhausted("budget_exceeded", current, applied.failures);
    if (totalTokens(total) > grant.totalTokenCeiling) return exhausted("budget_exceeded", current, applied.failures);
    current = mergeCorrections(current, new Set(failedBlocks), parsed.blocks);
    applied = apply();
  }
  // Grant exhausted: converged on the last attempt, or a conflict carrying
  // every intent tried — further reflection requires a new W5 consent.
  if (!applied.failures.length) {
    return {
      state: "converged",
      attempts,
      blocks: current,
      files: applied.files,
      failures: [],
      usage: { total: { inputTokens: total.inputTokens - prior.inputTokens, outputTokens: total.outputTokens - prior.outputTokens }, perAttempt, priorAttempts: prior.attempts },
      grant,
      newGrantRequired: false,
    };
  }
  return exhausted("conflict", current, applied.failures);
}
