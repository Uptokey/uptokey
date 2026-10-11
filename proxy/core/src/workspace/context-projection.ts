import { createHash } from "node:crypto";

/**
 * Stage 10 deterministic tool_result/context projection (opt-in).
 *
 * First choice per the stage spec: deterministic projection of the needed
 * fields, pagination, artifact references and exact-repetition removal.
 * The original is always preserved by the caller (artifact store); this module
 * never deletes, rewrites authoritatively, or summarizes user/client system
 * prompts (it offers no system-prompt transform at all).
 *
 * Authorization, hierarchy, rules and limits are never compression candidates:
 * `authoritative: true` inputs are bypassed, and a projected view must be bound
 * to the approved payload digest BEFORE approval (the caller computes the plan
 * digest over the final view). Any post-approval alteration is refused by the
 * existing W0 digest checks (`plan_digest_mismatch` / `plan_changed`).
 *
 * No model, no network, no inference: model-based compression stays an isolated,
 * opt-in candidate behind `compareProjection` evidence and is never activated
 * by this module.
 */

export const CONTEXT_PROJECTION_TRANSFORMER = "uptokey-deterministic-projection" as const;
export const CONTEXT_PROJECTION_VERSION = 1 as const;
/** Bytes are authoritative; tokens use the ~4-chars-per-token convention shared with token-estimate.ts. */
export const CONTEXT_PROJECTION_TOKENIZER = "uptokey-bytes-chars4-v1" as const;

export interface ToolResultInput {
  readonly callId: string;
  readonly content: string;
  readonly sources?: readonly string[];
  readonly isError: boolean;
  readonly truncatedUpstream: boolean;
  /** Identifiers the caller knows must survive (attempt/artifact/step ids). */
  readonly declaredIds?: readonly string[];
  /** Refs where the caller persisted the integral original. */
  readonly sourceArtifactRefs: readonly string[];
  /** Authoritative scopes (policy, consent, grants, limits) are never projected. */
  readonly authoritative: boolean;
}

export interface ProjectionConfig {
  readonly maxBytes: number;
  readonly firstPageBytes: number;
  readonly dedupExactRepetitions: boolean;
}

export interface TransformationRecord {
  readonly sourceArtifactRefs: readonly string[];
  readonly sourceHash: string;
  readonly transformer: typeof CONTEXT_PROJECTION_TRANSFORMER;
  readonly transformerVersion: typeof CONTEXT_PROJECTION_VERSION;
  readonly config: ProjectionConfig;
  readonly tokenizer: typeof CONTEXT_PROJECTION_TOKENIZER;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly tokensBefore: number | null;
  readonly tokensAfter: number | null;
  readonly knownLosses: readonly string[];
  readonly viewHash: string;
  readonly projectorMs: number;
}

export interface ProjectedView {
  readonly callId: string;
  /** tool_call_id linkage is always first: history stays syntactically valid. */
  readonly content: string;
  readonly page: number;
  readonly pages: number;
  readonly continuedIn: readonly string[];
  readonly isError: boolean;
  readonly truncatedUpstream: boolean;
}

export type ProjectionBypassReason =
  | "disabled"
  | "authoritative_scope"
  | "empty_content"
  | "oversized_config"
  | "fidelity_tool_call_id"
  | "fidelity_error"
  | "fidelity_invariant"
  | "fidelity_invention"
  | "fidelity_pagination";

export type ProjectionOutcome =
  | { readonly status: "projected"; readonly view: ProjectedView; readonly record: TransformationRecord }
  | { readonly status: "bypass"; readonly reason: ProjectionBypassReason };

export interface ProjectionComparison {
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly tokensBefore: number | null;
  readonly tokensAfter: number | null;
  readonly projectorMs: number;
  readonly fidelity: "pass" | ProjectionBypassReason;
  readonly netBytesSaved: number;
}

/** Rollback flag for stage 10: default off (integral payloads); "on" enables the opt-in path. */
export function contextProjectionEnabled(env: Readonly<Record<string, string | undefined>>): boolean {
  return env.UPTOKEY_CONTEXT_PROJECTION?.trim().toLowerCase() === "on";
}

export function defaultProjectionConfig(): ProjectionConfig {
  return Object.freeze({ maxBytes: 65_536, firstPageBytes: 16_384, dedupExactRepetitions: true });
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function estimateTokens(chars: number): number | null {
  if (!Number.isSafeInteger(chars) || chars < 0) return null;
  return Math.max(chars === 0 ? 0 : 1, Math.ceil(chars / 4));
}

const NEGATION = /n[ãa]o|nunca|jamais|nem\b|sem\b|never\b|not\b|no\b|n't\b|without\b|denied\b|failed\b|error\b/i;
const NUMBER_UNIT = /\d[\d.,]*\s*(?:%|°[CF]?|[a-zA-Z]{1,6}\b|\$|€|£|¥)/;
const ISO_DATE = /\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?Z?)?\b/;
const BR_DATE = /\b\d{2}\/\d{2}\/\d{4}\b/;
const URL = /https?:\/\/[^\s"'<>]+/;
const UUID = /\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b/i;
const CALL_ID = /\bcall_[A-Za-z0-9_-]+\b/;

/** Lines carrying load-bearing meaning are never silently dropped, only deduplicated. */
const NEGATION_LINES = (lines: readonly string[]): string[] =>
  [...new Set(lines.filter((line) => NEGATION.test(line)))];

function extractInvariants(text: string, declaredIds: readonly string[]): string[] {
  const found = new Set<string>();
  const patterns = [NUMBER_UNIT, ISO_DATE, BR_DATE, URL, UUID, CALL_ID];
  for (const line of text.split("\n")) {
    for (const pattern of patterns) {
      const global = new RegExp(pattern.source, pattern.flags.includes("i") ? "gi" : "g");
      for (const match of line.matchAll(global)) found.add(match[0]);
    }
  }
  for (const id of declaredIds) if (id) found.add(id);
  return [...found];
}

export function projectToolResult(
  input: ToolResultInput,
  config: ProjectionConfig = defaultProjectionConfig(),
  now: () => number = Date.now,
): ProjectionOutcome {
  const started = now();
  if (input.authoritative) return { status: "bypass", reason: "authoritative_scope" };
  if (!Number.isSafeInteger(config.maxBytes) || !Number.isSafeInteger(config.firstPageBytes) ||
      config.maxBytes < 256 || config.maxBytes > 1_048_576 || config.firstPageBytes < 256 || config.firstPageBytes > config.maxBytes) {
    return { status: "bypass", reason: "oversized_config" };
  }
  if (typeof input.content !== "string" || input.content.length === 0) return { status: "bypass", reason: "empty_content" };
  if (typeof input.callId !== "string" || !input.callId) return { status: "bypass", reason: "fidelity_tool_call_id" };

  const sourceBytes = Buffer.byteLength(input.content, "utf8");
  const sourceHash = sha256Hex(input.content);
  const knownLosses: string[] = [];
  let lines = input.content.split("\n");

  // Exact-repetition removal only: first occurrence of every line is kept, so no
  // invariant can be lost here; the count removed is recorded, not the content.
  if (config.dedupExactRepetitions) {
    const seen = new Set<string>();
    const kept: string[] = [];
    let removed = 0;
    for (const line of lines) {
      if (line.trim() === "" || !seen.has(line)) { seen.add(line); kept.push(line); }
      else removed += 1;
    }
    if (removed > 0) knownLosses.push(`${removed} exact-duplicate lines removed, first occurrence kept`);
    lines = kept;
  }

  const header = `tool_call_id: ${input.callId}`;
  const flags: string[] = [];
  if (input.isError) flags.push("[error: upstream outcome preserved]");
  if (input.truncatedUpstream) flags.push("[truncated upstream: marker preserved, full content in source refs]");
  const body = [...flags, ...lines].join("\n");
  const framed = `${header}\n${body}`;
  const invariants = extractInvariants(input.content, [...(input.declaredIds ?? []), input.callId, ...(input.sources ?? [])]);

  // Fidelity gate on the full deduped text before any pagination.
  const fidelity = checkFidelity(input.content, framed, invariants, input.isError);
  if (fidelity !== "pass") return { status: "bypass", reason: fidelity };

  let viewText = framed;
  const continuedIn: string[] = [];
  let pages = 1;
  if (Buffer.byteLength(framed, "utf8") > config.maxBytes) {
    // Paginate only when the invariant core fits on page one; otherwise bypass
    // with the integral payload BEFORE any send, never repeating an effect after.
    const firstPage = cutAtLineBoundary(framed, config.firstPageBytes);
    const rest = framed.slice(firstPage.length);
    // Declared ids/callId/sources, measurement tokens AND negation-bearing lines
    // must all be on page one; anything else forces the integral version.
    const negationLines = NEGATION_LINES(input.content.split("\n"));
    const missing = [...invariants, ...negationLines].filter((token) => !firstPage.includes(token));
    if (missing.length > 0) return { status: "bypass", reason: "fidelity_pagination" };
    pages = Math.max(2, Math.ceil(Buffer.byteLength(framed, "utf8") / config.firstPageBytes));
    for (let page = 2; page <= pages; page += 1) continuedIn.push(`${input.sourceArtifactRefs[0] ?? "source"}#page-${page}`);
    knownLosses.push(`paginated into ${pages} pages; pages 2..${pages} in source refs, original recoverable`);
    viewText = `${firstPage}\n[continued in ${continuedIn.join(", ")}]`;
    void rest;
  }

  const finalCheck = checkFidelity(input.content, viewText, invariants, input.isError);
  if (finalCheck !== "pass") return { status: "bypass", reason: finalCheck };

  const bytesAfter = Buffer.byteLength(viewText, "utf8");
  const record: TransformationRecord = {
    sourceArtifactRefs: [...input.sourceArtifactRefs],
    sourceHash,
    transformer: CONTEXT_PROJECTION_TRANSFORMER,
    transformerVersion: CONTEXT_PROJECTION_VERSION,
    config: { ...config },
    tokenizer: CONTEXT_PROJECTION_TOKENIZER,
    bytesBefore: sourceBytes,
    bytesAfter,
    tokensBefore: estimateTokens(input.content.length),
    tokensAfter: estimateTokens(viewText.length),
    knownLosses: [...knownLosses],
    viewHash: sha256Hex(viewText),
    projectorMs: Math.max(0, now() - started),
  };
  return {
    status: "projected",
    view: Object.freeze({
      callId: input.callId,
      content: viewText,
      page: 1,
      pages,
      continuedIn: Object.freeze([...continuedIn]),
      isError: input.isError,
      truncatedUpstream: input.truncatedUpstream,
    }),
    record: Object.freeze(record),
  };
}

function checkFidelity(original: string, view: string, invariants: readonly string[], isError: boolean): "pass" | ProjectionBypassReason {
  for (const token of invariants) {
    if (!view.includes(token)) return "fidelity_invariant";
  }
  if (isError && !/\[error/.test(view)) return "fidelity_error";
  // No invention: every view line is either framing we added or verbatim from the original.
  const originalLines = new Set(original.split("\n"));
  for (const line of view.split("\n")) {
    if (line.startsWith("tool_call_id: ") || line.startsWith("[error") || line.startsWith("[truncated") || line.startsWith("[continued in ")) continue;
    if (!originalLines.has(line)) return "fidelity_invention";
  }
  return "pass";
}

function cutAtLineBoundary(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text, "utf8");
  if (bytes.length <= maxBytes) return text;
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end -= 1;
  const cut = bytes.subarray(0, end).toString("utf8");
  const newline = cut.lastIndexOf("\n");
  return newline > 0 ? cut.slice(0, newline) : cut;
}

/**
 * Baseline-vs-candidate comparison for the stage gate: same cases and inputs,
 * bytes/tokens by the declared tokenizer (bytes authoritative), projector cost
 * included. A candidate is only eligible when fidelity passes and the net
 * result (including projectorMs) improves; otherwise the integral stays.
 */
export function compareProjection(
  original: string,
  outcome: ProjectionOutcome,
): ProjectionComparison {
  const bytesBefore = Buffer.byteLength(original, "utf8");
  if (outcome.status === "bypass") {
    return {
      bytesBefore, bytesAfter: bytesBefore,
      tokensBefore: estimateTokens(original.length), tokensAfter: estimateTokens(original.length),
      projectorMs: 0, fidelity: outcome.reason, netBytesSaved: 0,
    };
  }
  return {
    bytesBefore,
    bytesAfter: outcome.record.bytesAfter,
    tokensBefore: outcome.record.tokensBefore,
    tokensAfter: outcome.record.tokensAfter,
    projectorMs: outcome.record.projectorMs,
    fidelity: "pass",
    netBytesSaved: bytesBefore - outcome.record.bytesAfter,
  };
}

export interface ExternalCompressionCandidate {
  readonly name: string;
  readonly version: string;
  readonly text: string;
  /** Total compressor cost (load + inference + extra calls), measured by the caller. */
  readonly compressorMs: number;
}

export interface CandidateComparison {
  readonly candidate: string;
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly tokensBefore: number | null;
  readonly tokensAfter: number | null;
  readonly compressorMs: number;
  readonly fidelity: "pass" | ProjectionBypassReason;
  readonly netBytesSaved: number;
  /**
   * Measured net gain only (fidelity pass, bytes saved, cost recorded).
   * Activation stays an explicit operator decision after this evidence;
   * this module never enables a candidate by itself.
   */
  readonly measuredGain: boolean;
}

/**
 * Measures an optional external compressor (e.g. a trained extractive model)
 * against the same fidelity gates as the deterministic projection. Model
 * compressors stay isolated from action dispatch; a failed acceptance keeps
 * the candidate off, which is a valid outcome of the evaluation.
 */
export function compareExternalCandidate(
  original: string,
  callId: string,
  declaredIds: readonly string[],
  candidate: ExternalCompressionCandidate,
): CandidateComparison {
  const bytesBefore = Buffer.byteLength(original, "utf8");
  const invariants = [...extractInvariants(original, [callId, ...declaredIds]), ...NEGATION_LINES(original.split("\n"))];
  let fidelity: "pass" | ProjectionBypassReason = "pass";
  for (const token of invariants) {
    if (!candidate.text.includes(token)) { fidelity = "fidelity_invariant"; break; }
  }
  if (fidelity === "pass" && !candidate.text.includes(callId)) fidelity = "fidelity_tool_call_id";
  if (fidelity === "pass") {
    const originalLines = new Set(original.split("\n"));
    for (const line of candidate.text.split("\n")) {
      if (line.startsWith("tool_call_id: ") || line.startsWith("[compressed ") || line.trim() === "") continue;
      if (!originalLines.has(line)) { fidelity = "fidelity_invention"; break; }
    }
  }
  const bytesAfter = Buffer.byteLength(candidate.text, "utf8");
  const netBytesSaved = bytesBefore - bytesAfter;
  return {
    candidate: `${candidate.name}@${candidate.version}`,
    bytesBefore,
    bytesAfter,
    tokensBefore: estimateTokens(original.length),
    tokensAfter: estimateTokens(candidate.text.length),
    compressorMs: candidate.compressorMs,
    fidelity,
    netBytesSaved,
    measuredGain: fidelity === "pass" && netBytesSaved > 0 && Number.isFinite(candidate.compressorMs) && candidate.compressorMs >= 0,
  };
}
