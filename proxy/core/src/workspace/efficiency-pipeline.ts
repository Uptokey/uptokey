/**
 * E2-17 efficiency pipeline — Windows canonical API.
 * Uses projectToolResult / ToolResultInput / ProjectionOutcome from context-projection.ts.
 * Call BEFORE plan/payload digest and approval. Semantic / RTK / Headroom stay OFF.
 */
import { createHash, randomUUID } from "node:crypto";
import {
  assertEfficiencyPolicy,
  defaultEfficiencyPolicy,
  liveEfficiencyGuards,
  type EfficiencyPolicy,
} from "../efficiency-policy.ts";
import {
  bypassTransformationReceipt,
  type TransformationReceipt,
} from "../efficiency-receipts.ts";
import {
  defaultProjectionConfig,
  projectToolResult,
  type ProjectionConfig,
  type ProjectionOutcome,
  type ProjectedView,
  type ToolResultInput,
} from "./context-projection.ts";

export interface EfficiencyProjectionResult {
  /** Payload that must feed the digest (view content when projected, else original). */
  payloadForDigest: string | ToolResultInput;
  digest: string;
  originalRef: string | null;
  projected: ProjectedView | null;
  outcome: ProjectionOutcome | null;
  receipt: TransformationReceipt;
  policyRevision: number;
  /** Source artifact refs for recovery / journal. */
  sourceArtifactRefs: readonly string[];
}

let activePolicy: EfficiencyPolicy = defaultEfficiencyPolicy();

/** Local registry so tests can recover originals without Windows artifact store. */
const originalRegistry = new Map<string, ToolResultInput | string>();

function hashUtf8(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function hashUnknown(value: unknown): string {
  if (typeof value === "string") return hashUtf8(value);
  const canon = JSON.stringify(value, (_k, v) => {
    if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(o).sort()) sorted[key] = o[key];
      return sorted;
    }
    return v;
  });
  return createHash("sha256").update(canon ?? "null").digest("hex");
}

function isToolResultInput(value: unknown): value is ToolResultInput {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.callId === "string" &&
    typeof v.content === "string" &&
    typeof v.isError === "boolean" &&
    typeof v.truncatedUpstream === "boolean" &&
    typeof v.authoritative === "boolean" &&
    Array.isArray(v.sourceArtifactRefs)
  );
}

/** Adapt string content or partial shapes into ToolResultInput for projectToolResult. */
export function toToolResultInput(
  original: ToolResultInput | string | Record<string, unknown>,
  defaults: Partial<ToolResultInput> = {},
): ToolResultInput {
  if (isToolResultInput(original)) return original;
  if (typeof original === "string") {
    const callId = defaults.callId ?? "call_efficiency_adapt";
    return {
      callId,
      content: original,
      isError: defaults.isError ?? false,
      truncatedUpstream: defaults.truncatedUpstream ?? false,
      authoritative: defaults.authoritative ?? false,
      sourceArtifactRefs: defaults.sourceArtifactRefs ?? [`efficiency://inline/${callId}`],
      ...(defaults.sources ? { sources: defaults.sources } : {}),
      ...(defaults.declaredIds ? { declaredIds: defaults.declaredIds } : {}),
    };
  }
  const o = original as Record<string, unknown>;
  const callId =
    (typeof o.callId === "string" && o.callId) ||
    (typeof o.tool_call_id === "string" && o.tool_call_id) ||
    defaults.callId ||
    "call_efficiency_adapt";
  const content =
    typeof o.content === "string"
      ? o.content
      : JSON.stringify(original);
  return {
    callId,
    content,
    isError: typeof o.isError === "boolean" ? o.isError : defaults.isError ?? false,
    truncatedUpstream:
      typeof o.truncatedUpstream === "boolean"
        ? o.truncatedUpstream
        : defaults.truncatedUpstream ?? false,
    authoritative:
      typeof o.authoritative === "boolean"
        ? o.authoritative
        : defaults.authoritative ?? false,
    sourceArtifactRefs: Array.isArray(o.sourceArtifactRefs)
      ? (o.sourceArtifactRefs as string[])
      : defaults.sourceArtifactRefs ?? [`efficiency://inline/${callId}`],
    ...(Array.isArray(o.sources) || defaults.sources
      ? { sources: (o.sources as string[] | undefined) ?? defaults.sources }
      : {}),
    ...(Array.isArray(o.declaredIds) || defaults.declaredIds
      ? { declaredIds: (o.declaredIds as string[] | undefined) ?? defaults.declaredIds }
      : {}),
  };
}

export function getActiveEfficiencyPolicy(): EfficiencyPolicy {
  return activePolicy;
}

export function setActiveEfficiencyPolicy(value: unknown): EfficiencyPolicy {
  activePolicy = assertEfficiencyPolicy(value);
  return activePolicy;
}

export function resetEfficiencyPolicyForTests(): void {
  activePolicy = defaultEfficiencyPolicy();
  originalRegistry.clear();
}

export function __resetEfficiencyOriginalsForTests(): void {
  originalRegistry.clear();
}

/**
 * Canonical pre-digest hook for tool results.
 * - default policy: projection OFF → digest of original, bypass receipt
 * - policy with deterministic_projection enabled → projectToolResult; original in registry
 */
export function applyEfficiencyBeforeDigest(
  original: ToolResultInput | string | Record<string, unknown>,
  config: ProjectionConfig = defaultProjectionConfig(),
  policy: EfficiencyPolicy = activePolicy,
  options:{retainOriginal?:boolean}={},
): EfficiencyProjectionResult {
  const guards = liveEfficiencyGuards(policy);
  const input = toToolResultInput(original);

  if (!guards.allowDeterministicProjection) {
    const digest = hashUnknown(typeof original === "string" ? original : input.content);
    return {
      payloadForDigest: typeof original === "string" ? original : input,
      digest,
      originalRef: null,
      projected: null,
      outcome: null,
      receipt: bypassTransformationReceipt(digest),
      policyRevision: policy.revision,
      sourceArtifactRefs: input.sourceArtifactRefs,
    };
  }

  const outcome = projectToolResult(input, config);
  if (outcome.status === "bypass") {
    const digest = hashUtf8(input.content);
    return {
      payloadForDigest: input,
      digest,
      originalRef: null,
      projected: null,
      outcome,
      receipt: bypassTransformationReceipt(digest),
      policyRevision: policy.revision,
      sourceArtifactRefs: input.sourceArtifactRefs,
    };
  }

  const originalRef = options.retainOriginal===false?(input.sourceArtifactRefs[0]??null):`efficiency-original:${randomUUID()}`;
  if(options.retainOriginal!==false&&originalRef){originalRegistry.set(originalRef,input);while(originalRegistry.size>128)originalRegistry.delete(originalRegistry.keys().next().value!);}
  const { view, record } = outcome;
  const receipt: TransformationReceipt = {
    sourceHash: record.sourceHash,
    viewHash: record.viewHash,
    sourceArtifactRefs: [...new Set([...record.sourceArtifactRefs,...(originalRef?[originalRef]:[])])],
    transformer: record.transformer,
    version: String(record.transformerVersion),
    configHash: hashUnknown(record.config),
    bytesBefore: record.bytesBefore,
    bytesAfter: record.bytesAfter,
    tokensBefore: record.tokensBefore,
    tokensAfter: record.tokensAfter,
    tokenizer: record.tokenizer,
    latencyMs: record.projectorMs,
    costMicros: null,
    knownLosses: [...record.knownLosses],
    fidelity: record.knownLosses.length ? "lossy_declared" : "full",
  };

  return {
    payloadForDigest: view.content,
    digest: record.viewHash,
    originalRef,
    projected: view,
    outcome,
    receipt,
    policyRevision: policy.revision,
    sourceArtifactRefs: receipt.sourceArtifactRefs,
  };
}

export function recoverEfficiencyOriginal(
  originalRef: string,
): ToolResultInput | string | undefined {
  return originalRegistry.get(originalRef);
}
