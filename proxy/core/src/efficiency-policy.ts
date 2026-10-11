/**
 * E2-17 EfficiencyPolicy — local module aligned to SPECS.
 * Defaults: exact ON; semantic / Headroom / RTK / styles OFF.
 * deterministic_projection is opt-in (default OFF) but wired and testable.
 */
export type EfficiencyTransformKind =
  | "deterministic_projection"
  | "rtk"
  | "headroom";

export type ResponseStyleKind = "default" | "concise" | "caveman" | "ponytail";
export type ResponseStyleLevel = "lite" | "full" | "ultra";

export interface ResponseStyle {
  kind: ResponseStyleKind;
  level: ResponseStyleLevel;
  codeOnly: boolean;
}

export interface EfficiencyTransformStep {
  kind: EfficiencyTransformKind;
  enabled: boolean;
}

export interface EfficiencyPolicy {
  schemaVersion: 1;
  id: string;
  revision: number;
  exactCache: boolean;
  semanticCache: boolean;
  provenanceCache: boolean;
  providerPromptCache: boolean;
  transforms: EfficiencyTransformStep[];
  responseStyle: ResponseStyle;
  enabled: boolean;
  scope: "request" | "conversation" | "project" | "tenant";
}

export const EFFICIENCY_POLICY_SCHEMA_VERSION = 1 as const;

/** Defaults: exact cache ON; semantic / Headroom / RTK / styles OFF; projection OFF. */
export function defaultEfficiencyPolicy(
  overrides: Partial<EfficiencyPolicy> = {},
): EfficiencyPolicy {
  const base: EfficiencyPolicy = {
    schemaVersion: EFFICIENCY_POLICY_SCHEMA_VERSION,
    id: "efficiency-default",
    revision: 1,
    exactCache: true,
    semanticCache: false,
    provenanceCache: false,
    providerPromptCache: false,
    transforms: [
      { kind: "deterministic_projection", enabled: false },
      { kind: "rtk", enabled: false },
      { kind: "headroom", enabled: false },
    ],
    responseStyle: { kind: "default", level: "lite", codeOnly: false },
    enabled: true,
    scope: "request",
  };
  return { ...base, ...overrides, schemaVersion: 1 };
}

export function assertEfficiencyPolicy(value: unknown): EfficiencyPolicy {
  if (!value || typeof value !== "object") throw new Error("efficiency_policy_invalid");
  const v = value as Record<string, unknown>;
  if(Object.keys(v).some(key=>!['schemaVersion','id','revision','exactCache','semanticCache','provenanceCache','providerPromptCache','transforms','responseStyle','enabled','scope'].includes(key)))throw Error('efficiency_policy_invalid');
  if (v.schemaVersion !== 1) throw new Error("efficiency_policy_invalid");
  if (typeof v.id !== "string" || v.id.length < 1) throw new Error("efficiency_policy_invalid");
  if (typeof v.revision !== "number" || !Number.isSafeInteger(v.revision) || v.revision < 1) {
    throw new Error("efficiency_policy_invalid");
  }
  for (const flag of [
    "exactCache",
    "semanticCache",
    "provenanceCache",
    "providerPromptCache",
    "enabled",
  ] as const) {
    if (typeof v[flag] !== "boolean") throw new Error("efficiency_policy_invalid");
  }
  if (!Array.isArray(v.transforms) || v.transforms.length > 4) {
    throw new Error("efficiency_policy_invalid");
  }
  if(new Set(v.transforms.map(s=>s?.kind)).size!==v.transforms.length)throw Error("efficiency_policy_invalid");
  let semanticCompressorCount = 0;
  for (const step of v.transforms) {
    if (!step || typeof step !== "object") throw new Error("efficiency_policy_invalid");
    const s = step as Record<string, unknown>;
    if(Object.keys(s).some(key=>!['kind','enabled'].includes(key)))throw Error('efficiency_policy_invalid');
    if (
      s.kind !== "deterministic_projection" &&
      s.kind !== "rtk" &&
      s.kind !== "headroom"
    ) {
      throw new Error("efficiency_policy_invalid");
    }
    if (typeof s.enabled !== "boolean") throw new Error("efficiency_policy_invalid");
    if ((s.kind === "rtk" || s.kind === "headroom") && s.enabled) semanticCompressorCount += 1;
  }
  if (semanticCompressorCount > 1) throw new Error("efficiency_policy_invalid");
  const style = v.responseStyle as Record<string, unknown> | undefined;
  if (!style || typeof style !== "object") throw new Error("efficiency_policy_invalid");
  if(Object.keys(style).some(key=>!['kind','level','codeOnly'].includes(key)))throw Error('efficiency_policy_invalid');
  if (
    style.kind !== "default" &&
    style.kind !== "concise" &&
    style.kind !== "caveman" &&
    style.kind !== "ponytail"
  ) {
    throw new Error("efficiency_policy_invalid");
  }
  if (style.level !== "lite" && style.level !== "full" && style.level !== "ultra") {
    throw new Error("efficiency_policy_invalid");
  }
  if (typeof style.codeOnly !== "boolean") throw new Error("efficiency_policy_invalid");
  if (
    v.scope !== "request" &&
    v.scope !== "conversation" &&
    v.scope !== "project" &&
    v.scope !== "tenant"
  ) {
    throw new Error("efficiency_policy_invalid");
  }
  return v as unknown as EfficiencyPolicy;
}

/**
 * Live path guards.
 * - semantic lookup is guarded by its dedicated context/identity path.
 * - transforms and response styles require the explicit enabled policy.
 * - deterministic_projection follows policy.transforms (default OFF, testable ON).
 */
export function liveEfficiencyGuards(policy: EfficiencyPolicy): {
  allowExactCache: boolean;
  allowSemanticCache: boolean;
  allowDeterministicProjection: boolean;
  allowTransforms: boolean;
  allowNonDefaultStyle: boolean;
} {
  const projectionOn = policy.transforms.some(
    (s) => s.kind === "deterministic_projection" && s.enabled,
  );
  return {
    allowExactCache: policy.enabled && policy.exactCache,
    allowSemanticCache: false,
    allowDeterministicProjection: policy.enabled && projectionOn,
    allowTransforms: policy.enabled&&policy.transforms.some(s=>s.enabled&&s.kind!=="deterministic_projection"),
    allowNonDefaultStyle: policy.enabled&&(policy.responseStyle.kind!=="default"||policy.responseStyle.codeOnly),
  };
}
