/**
 * E2-17 receipt types (CacheLookupReceipt / TransformationReceipt).
 */
export type CacheLookupKind = "exact" | "semantic" | "provenance" | "provider";
export type CacheLookupStatus =
  | "hit"
  | "miss"
  | "expired"
  | "revoked"
  | "ineligible"
  | "corrupt";

export interface CacheLookupReceipt {
  kind: CacheLookupKind;
  status: CacheLookupStatus;
  scopeHash: string;
  ageMs: number | null;
  avoidedCallObserved: boolean;
}

export interface TransformationReceipt {
  sourceHash: string;
  viewHash: string;
  sourceArtifactRefs: string[];
  transformer: string;
  version: string;
  configHash: string;
  bytesBefore: number;
  bytesAfter: number;
  tokensBefore: number | null;
  tokensAfter: number | null;
  tokenizer: string;
  latencyMs: number;
  costMicros: number | null;
  knownLosses: string[];
  fidelity: "full" | "lossy_declared" | "bypassed";
}

export type ResponseStyle = import("./efficiency-policy.ts").ResponseStyle;

export function exactLookupReceipt(
  status: CacheLookupStatus,
  scopeHash: string,
  ageMs: number | null = null,
): CacheLookupReceipt {
  return {
    kind: "exact",
    status,
    scopeHash,
    ageMs,
    avoidedCallObserved: status === "hit",
  };
}

export function bypassTransformationReceipt(sourceHash: string): TransformationReceipt {
  return {
    sourceHash,
    viewHash: sourceHash,
    sourceArtifactRefs: [],
    transformer: "none",
    version: "0",
    configHash: "bypass",
    bytesBefore: 0,
    bytesAfter: 0,
    tokensBefore: null,
    tokensAfter: null,
    tokenizer: "none",
    latencyMs: 0,
    costMicros: null,
    knownLosses: [],
    fidelity: "bypassed",
  };
}
