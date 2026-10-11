import {
  createHash,
  generateKeyPairSync,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
} from "node:crypto";
import {
  type Recipe,
  type RecipeParameter,
  type RecipeInputShape,
  type JsonData,
  type RecipeStep,
  type ExecutionPlan,
  type PlanStep,
  type InputBinding,
  type ExecutionLimits,
  type WorkflowScope,
  type DataDestination,
  type CapabilityDescriptor,
  parseRecipe,
  parseExecutionPlan,
} from "@uptokey/sync-contract/workflow";
import { canonicalJson } from "@uptokey/sync-contract/canonical";
import { CapabilityRegistry } from "./capabilities.ts";
import {
  computePlanDigest,
  validateExecutionPlan,
  DEFAULT_EXECUTION_LIMITS,
} from "./planner.ts";

export interface InstantiateRecipeOptions {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly parameters: Record<string, unknown>;
  readonly registry: CapabilityRegistry;
  readonly contextSnapshotId: string;
  readonly contextSnapshotDigest: string;
  readonly grantedScopes?: readonly WorkflowScope[];
  readonly limits?: Partial<ExecutionLimits>;
}

import { assertNoForbiddenContent } from "@uptokey/sync-contract/recipe-safety";
export { assertNoForbiddenContent, assertNoSecretSolicitation, assertNoDangerousLinks } from "@uptokey/sync-contract/recipe-safety";

/**
 * Validates parameter values against recipe parameter definitions.
 */
/** Field names and types of a structured value, never the value itself (V1/V7 structured inputs). */
export function inputShape(value: unknown, depth = 0): RecipeInputShape | null {
  if (depth > 4) return null;
  if (typeof value === "string") return { type: "string" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "number") return Number.isSafeInteger(value) ? { type: "integer" } : Number.isFinite(value) ? { type: "number" } : null;
  if (Array.isArray(value)) {
    if (value.length > 256) return null;
    const first = value.find(item => item !== null);
    const items = first === undefined ? { type: "string" as const } : inputShape(first, depth + 1);
    return items ? { type: "array", items } : null;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== null);
    if (!entries.length || entries.length > 32) return null;
    const properties: Record<string, RecipeInputShape> = {};
    for (const [key, item] of entries) {
      if (!/^[A-Za-z0-9_.-]{1,64}$/.test(key) || ["__proto__", "constructor", "prototype"].includes(key)) return null;
      const shape = inputShape(item, depth + 1);
      if (!shape) return null;
      properties[key] = shape;
    }
    return { type: "object", properties, required: Object.keys(properties) };
  }
  return null;
}

/** Strict structural check of a recipient-provided structured value against its shape. */
function conformsToShape(value: unknown, shape: RecipeInputShape, path: string, depth = 0): JsonData {
  const invalid = () => { throw new Error(`invalid_parameter_structure:${path}`); };
  if (depth > 5) invalid();
  switch (shape.type) {
    case "string":
      if (typeof value !== "string" || value.length > 4000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) invalid();
      return value as string;
    case "integer": if (typeof value !== "number" || !Number.isSafeInteger(value)) invalid(); return value as number;
    case "number": if (typeof value !== "number" || !Number.isFinite(value)) invalid(); return value as number;
    case "boolean": if (typeof value !== "boolean") invalid(); return value as boolean;
    case "array": {
      if (!Array.isArray(value) || value.length > (shape.maxItems ?? 256)) invalid();
      return (value as unknown[]).map((item, index) => conformsToShape(item, shape.items, `${path}[${index}]`, depth + 1));
    }
    case "object": {
      if (!value || typeof value !== "object" || Array.isArray(value)) invalid();
      const record = value as Record<string, unknown>;
      if (Object.keys(record).some(key => !Object.hasOwn(shape.properties, key))) invalid();
      for (const key of shape.required ?? []) if (record[key] === undefined || record[key] === null || record[key] === "") throw new Error(`missing_required_parameter:${path}.${key}`);
      return Object.fromEntries(Object.entries(record).filter(([, item]) => item !== undefined && item !== null)
        .map(([key, item]) => [key, conformsToShape(item, shape.properties[key]!, `${path}.${key}`, depth + 1)]));
    }
  }
}

export function validateParameters(
  parameters: readonly RecipeParameter[],
  input: Record<string, unknown>
): Record<string, JsonData> {
  const sanitized: Record<string, JsonData> = {};

  for (const param of parameters) {
    const val = input[param.name];
    if (val === undefined || val === null) {
      if (param.required) {
        throw new Error(`missing_required_parameter:${param.name}`);
      }
      continue;
    }

    if (param.type === "string") {
      if (typeof val !== "string") {
        throw new Error(`invalid_parameter_type:${param.name}_expected_string`);
      }
      const trimmed = val.trim();
      if (/[\u0000-\u001f]/.test(trimmed)) {
        throw new Error(`invalid_parameter_control_characters:${param.name}`);
      }
      if (trimmed.length < 2) {
        throw new Error(`parameter_too_short:${param.name}`);
      }
      sanitized[param.name] = trimmed;
    } else if (param.type === "integer") {
      if (typeof val !== "number" || !Number.isSafeInteger(val)) {
        throw new Error(`invalid_parameter_type:${param.name}_expected_integer`);
      }
      sanitized[param.name] = val;
    } else if (param.type === "boolean") {
      if (typeof val !== "boolean") {
        throw new Error(`invalid_parameter_type:${param.name}_expected_boolean`);
      }
      sanitized[param.name] = val;
    } else if (param.type === "json") {
      if (!param.schema) throw new Error(`invalid_parameter_type:${param.name}_schema_missing`);
      const value = conformsToShape(val, param.schema, param.name);
      // Reviewed defaults complete a partially varying structure; recipient fields never get overridden.
      sanitized[param.name] = param.defaults && value && typeof value === "object" && !Array.isArray(value) ? { ...param.defaults, ...value } as JsonData : value;
    }
  }

  return sanitized;
}

/**
 * Instantiates a Recipe into a validated ExecutionPlan conforming to W0.
 */
export function instantiateRecipe(
  recipeInput: unknown,
  options: InstantiateRecipeOptions
): ExecutionPlan {
  const recipe = parseRecipe(recipeInput);
  assertNoForbiddenContent(recipe);
  assertNoForbiddenContent(options.parameters);

  const sanitizedParams = validateParameters(recipe.parameters, options.parameters);
  const grantedScopes = options.grantedScopes ?? ["run:execute"];

  const steps: PlanStep[] = [];
  for (const step of recipe.steps) {
    options.registry.assertExecutable(step.capabilityId, step.capabilityVersion, grantedScopes);

    const stepArgs: Record<string, InputBinding> = {};
    for (const [argName, binding] of Object.entries(step.arguments)) {
      if (binding.kind === "parameter") {
        const paramValue = sanitizedParams[binding.parameter];
        if (paramValue === undefined) {
          throw new Error(`unbound_recipe_parameter:${binding.parameter}`);
        }
        stepArgs[argName] = {
          kind: "literal",
          value: paramValue,
        };
      } else {
        stepArgs[argName] = binding;
      }
    }

    steps.push({
      id: step.id,
      capabilityId: step.capabilityId,
      capabilityVersion: step.capabilityVersion,
      arguments: stepArgs,
    });
  }

  if (
    !options.contextSnapshotId ||
    typeof options.contextSnapshotId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(options.contextSnapshotId)
  ) {
    throw new Error("invalid_context_snapshot_id");
  }

  if (
    !options.contextSnapshotDigest ||
    typeof options.contextSnapshotDigest !== "string" ||
    !/^[a-f0-9]{64}$/.test(options.contextSnapshotDigest) ||
    options.contextSnapshotDigest === "0".repeat(64)
  ) {
    throw new Error("invalid_context_snapshot_digest");
  }

  const limits: ExecutionLimits = {
    maxSteps: Math.min(options.limits?.maxSteps ?? recipe.limits.maxSteps ?? DEFAULT_EXECUTION_LIMITS.maxSteps, 12),
    maxCalls: Math.min(options.limits?.maxCalls ?? recipe.limits.maxCalls ?? DEFAULT_EXECUTION_LIMITS.maxCalls, 12),
    maxOutputTokens: options.limits?.maxOutputTokens ?? recipe.limits.maxOutputTokens ?? DEFAULT_EXECUTION_LIMITS.maxOutputTokens,
    timeoutMs: options.limits?.timeoutMs ?? recipe.limits.timeoutMs ?? DEFAULT_EXECUTION_LIMITS.timeoutMs,
    maxOutputBytes: options.limits?.maxOutputBytes ?? recipe.limits.maxOutputBytes ?? DEFAULT_EXECUTION_LIMITS.maxOutputBytes,
  };

  const createdAt = new Date().toISOString();
  const planSignature = JSON.stringify({
    recipeId: recipe.id,
    projectId: options.projectId,
    projectRevision: options.projectRevision,
    contextSnapshotId: options.contextSnapshotId,
    contextSnapshotDigest: options.contextSnapshotDigest,
    steps,
    limits,
  });
  const planId = `plan_rec_${createHash("sha256").update(planSignature).digest("hex").slice(0, 24)}`;

  const provisionalPlan = {
    schemaVersion: 1 as const,
    id: planId,
    createdAt,
    projectId: options.projectId,
    projectRevision: options.projectRevision,
    contextSnapshotId: options.contextSnapshotId,
    contextSnapshotDigest: options.contextSnapshotDigest,
    steps,
    limits,
    digest: "0".repeat(64),
  };

  const digest = computePlanDigest(provisionalPlan);
  const finalPlan: ExecutionPlan = parseExecutionPlan({
    ...provisionalPlan,
    digest,
  });

  const validation = validateExecutionPlan(finalPlan, options.registry, grantedScopes);
  if (!validation.valid) {
    throw new Error(`instantiated_plan_invalid:${validation.errors.join(";")}`);
  }

  return finalPlan;
}

/**
 * Built-in standard research recipe template validated against W0 parseRecipe.
 */
export const STANDARD_RESEARCH_RECIPE: Recipe = parseRecipe({
  schemaVersion: 1,
  id: "recipe_academic_research",
  createdAt: "2026-09-16T12:00:00.000Z",
  version: 1,
  title: "Academic and Book Literature Research",
  description: "Cross-queries Crossref and Open Library for verified papers and books",
  parameters: [
    {
      name: "topic",
      type: "string",
      required: true,
    },
  ],
  steps: [
    {
      id: "search_papers",
      capabilityId: "sources.crossref.search",
      capabilityVersion: 1,
      arguments: {
        query: {
          kind: "parameter",
          parameter: "topic",
        },
      },
    },
    {
      id: "search_books",
      capabilityId: "sources.open-library.search",
      capabilityVersion: 1,
      arguments: {
        query: {
          kind: "parameter",
          parameter: "topic",
        },
      },
    },
  ],
  limits: {
    maxSteps: 12,
    maxCalls: 12,
    maxOutputTokens: 4096,
    timeoutMs: 120_000,
    maxOutputBytes: 1_048_576,
  },
  expectedOutputs: ["search_papers", "search_books"],
});

/* ------------------------------------------------------------------ *
 * Provenance, technical signature and scope comparison                *
 *                                                                     *
 * These helpers describe declarative recipe packages before anything  *
 * is executed. A technical signature proves package integrity and     *
 * possession of the signing key; it is NOT verification of a human    *
 * identity, authorship claim or content review. Execution stays       *
 * gated by W5 plan approval and the capability registry.              *
 * ------------------------------------------------------------------ */

export type RecipeEffect = CapabilityDescriptor["effect"];

export interface RecipeProvenance {
  /** Package id declared on the wire (publisher side). */
  originId: string;
  /** Package version declared on the wire. */
  originVersion: number;
  /** Local lineage id derived from the origin id: import_<sha256(originId)>. */
  lineageId: string;
  /** sha256 of the canonical package JSON. */
  packageDigest: string;
  /** ISO timestamp when the provenance was recorded locally. */
  recordedAt: string;
  /** Key id of the verified technical signature, or null when unsigned. */
  signatureKeyId: string | null;
  /** SPKI SHA-256 fingerprint of the verified public key, or null when unsigned. */
  signatureFingerprint: string | null;
  /** Whether an author signature verified against the provided public key. */
  signatureVerified: boolean;
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function computePublicKeyFingerprint(publicKeyPem: string): string {
  try {
    const key = createPublicKey(publicKeyPem.trim());
    const spkiDer = key.export({ type: "spki", format: "der" });
    return `ed25519:sha256:${createHash("sha256").update(spkiDer).digest("hex")}`;
  } catch {
    return `invalid_key:${sha256Hex(publicKeyPem).slice(0, 16)}`;
  }
}

export function recipePackageDigest(packageJson: unknown): string {
  return sha256Hex(canonicalJson(packageJson));
}

export function recipeLineageId(originId: string): string {
  return `import_${sha256Hex(originId).slice(0, 40)}`;
}

/** Durable per-version revocation record id for a local recipe id. */
export function recipeRevocationRecordId(recipeId: string): string {
  return `revoke_${sha256Hex(recipeId).slice(0, 40)}`;
}

export function buildRecipeProvenance(
  recipe: Recipe,
  recordedAt = new Date().toISOString()
): RecipeProvenance {
  return {
    originId: recipe.id,
    originVersion: recipe.version,
    lineageId: recipeLineageId(recipe.id),
    packageDigest: recipePackageDigest(recipe),
    recordedAt,
    signatureKeyId: null,
    signatureFingerprint: null,
    signatureVerified: false,
  };
}

export type RecipeSignatureAlgorithm = "ed25519";

export interface RecipeAuthorSignature {
  alg: RecipeSignatureAlgorithm;
  keyId: string;
  /** base64url of the raw signature over the canonical package JSON. */
  signature: string;
}

export interface RecipeAuthorKeyPair {
  privateKeyPem: string;
  publicKeyPem: string;
}

export function generateRecipeAuthorKeyPair(): RecipeAuthorKeyPair {
  const pair = generateKeyPairSync("ed25519", {
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
    publicKeyEncoding: { type: "spki", format: "pem" },
  });
  return { privateKeyPem: pair.privateKey, publicKeyPem: pair.publicKey };
}

function signaturePayload(packageJson: unknown): Buffer {
  return Buffer.from(canonicalJson(packageJson), "utf8");
}

export function signRecipePackage(
  packageJson: unknown,
  privateKeyPem: string,
  keyId: string
): RecipeAuthorSignature {
  const signature = sign(
    null,
    signaturePayload(packageJson),
    createPrivateKey(privateKeyPem)
  );
  return { alg: "ed25519", keyId, signature: signature.toString("base64url") };
}

/**
 * Verifies the technical signature of a package. False on any mismatch,
 * malformed key or signature. This check never establishes who a human
 * author is; it only ties the package bytes to the holder of the key.
 */
export function verifyRecipeSignature(
  packageJson: unknown,
  publicKeyPem: string,
  signature: RecipeAuthorSignature
): boolean {
  if (
    !signature ||
    signature.alg !== "ed25519" ||
    typeof signature.keyId !== "string" ||
    typeof signature.signature !== "string"
  ) {
    return false;
  }
  try {
    const bytes = Buffer.from(signature.signature, "base64url");
    if (bytes.length === 0) return false;
    return verify(
      null,
      signaturePayload(packageJson),
      createPublicKey(publicKeyPem),
      bytes
    );
  } catch {
    return false;
  }
}

export interface RecipeCapabilityView {
  id: string;
  version: number;
  effect: RecipeEffect;
  destination: DataDestination;
  requiredScopes: WorkflowScope[];
  executable: boolean;
}

export interface RecipeLimitSummary {
  maxSteps: number;
  maxCalls: number;
  maxOutputTokens: number;
  timeoutMs: number;
  maxOutputBytes: number;
}

export interface RecipeAuthorizationSummary {
  /** deduped capability ids, sorted */
  capabilityIds: string[];
  /** deduped scopes required by every step, sorted */
  requiredScopes: WorkflowScope[];
  /** deduped destinations (kind+id), sorted */
  destinations: DataDestination[];
  /** deduped effects, sorted by strength */
  effects: RecipeEffect[];
  /** one entry per distinct step capability (id@version) */
  capabilities: RecipeCapabilityView[];
  /** outputs declared by the recipe */
  expectedOutputs: string[];
  /** execution resource limits declared by the recipe */
  limits: RecipeLimitSummary;
}

export const RECIPE_EFFECT_STRENGTH: Readonly<Record<RecipeEffect, number>> =
  Object.freeze({
    read_external: 1,
    inference: 2,
    produce_artifact: 3,
    write_external: 4,
    execute_local: 5,
  });

export function summarizeRecipeAuthorization(
  recipe: Recipe,
  registry: CapabilityRegistry
): RecipeAuthorizationSummary {
  const capabilities: RecipeCapabilityView[] = [];
  const seen = new Set<string>();
  for (const step of recipe.steps) {
    const key = `${step.capabilityId}@${step.capabilityVersion}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const descriptor = registry.get(step.capabilityId, step.capabilityVersion);
    if (descriptor) {
      capabilities.push({
        id: step.capabilityId,
        version: step.capabilityVersion,
        effect: descriptor.effect,
        destination: descriptor.dataDestination,
        requiredScopes: [...descriptor.requiredScopes],
        executable: descriptor.availability === "executable",
      });
    } else {
      capabilities.push({
        id: step.capabilityId,
        version: step.capabilityVersion,
        effect: "read_external",
        destination: { kind: "public_source", id: step.capabilityId },
        requiredScopes: ["run:execute"],
        executable: false,
      });
    }
  }
  return {
    capabilityIds: [...new Set(capabilities.map(item => item.id))].sort(),
    requiredScopes: [...new Set(capabilities.flatMap(item => item.requiredScopes))].sort(),
    destinations: uniqueDestinations(capabilities.map(item => item.destination)),
    effects: [...new Set(capabilities.map(item => item.effect))].sort(
      (a, b) => RECIPE_EFFECT_STRENGTH[a] - RECIPE_EFFECT_STRENGTH[b]
    ),
    capabilities,
    expectedOutputs: [...recipe.expectedOutputs].sort(),
    limits: {
      maxSteps: recipe.limits.maxSteps,
      maxCalls: recipe.limits.maxCalls,
      maxOutputTokens: recipe.limits.maxOutputTokens,
      timeoutMs: recipe.limits.timeoutMs,
      maxOutputBytes: recipe.limits.maxOutputBytes,
    },
  };
}

function uniqueDestinations(items: DataDestination[]): DataDestination[] {
  const seen = new Set<string>();
  const result: DataDestination[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(item);
  }
  return result.sort((a, b) => `${a.kind}:${a.id}` < `${b.kind}:${b.id}` ? -1 : 1);
}

export interface RecipeLimitEscalation {
  limit: keyof RecipeLimitSummary;
  from: number;
  to: number;
}

export interface RecipeScopeDiff {
  addedCapabilities: string[];
  removedCapabilities: string[];
  /** same capability id, different version (informational, not escalating) */
  versionChangedCapabilities: string[];
  addedRequiredScopes: WorkflowScope[];
  addedDestinations: DataDestination[];
  effectEscalations: Array<{ capabilityId: string; from: RecipeEffect; to: RecipeEffect }>;
  limitEscalations: RecipeLimitEscalation[];
  addedOutputs: string[];
  removedOutputs: string[];
  reasons: string[];
  /**
   * True when the candidate amplifies destinations, permissions, effects,
   * capabilities or execution limits beyond the previous package. An escalating
   * update must not inherit previous authorization; it requires a new explicit review.
   */
  escalates: boolean;
}

export function compareRecipeAuthorization(
  previous: RecipeAuthorizationSummary,
  next: RecipeAuthorizationSummary
): RecipeScopeDiff {
  const previousSet = new Set(previous.capabilityIds);
  const nextSet = new Set(next.capabilityIds);
  const addedCapabilities = next.capabilityIds.filter(id => !previousSet.has(id));
  const removedCapabilities = previous.capabilityIds.filter(id => !nextSet.has(id));
  const versionChangedCapabilities: string[] = [];
  for (const before of previous.capabilities) {
    const after = next.capabilities.find(
      item => item.id === before.id && item.version !== before.version
    );
    if (after) versionChangedCapabilities.push(`${before.id}@${before.version}->${after.version}`);
  }
  const previousScopes = new Set(previous.requiredScopes);
  const addedRequiredScopes = next.requiredScopes.filter(scope => !previousScopes.has(scope));
  const previousDestinationKeys = new Set(previous.destinations.map(item => `${item.kind}:${item.id}`));
  const addedDestinations = next.destinations.filter(item => !previousDestinationKeys.has(`${item.kind}:${item.id}`));
  const effectEscalations: RecipeScopeDiff["effectEscalations"] = [];
  for (const after of next.capabilities) {
    const before = previous.capabilities.find(item => item.id === after.id);
    if (before && RECIPE_EFFECT_STRENGTH[after.effect] > RECIPE_EFFECT_STRENGTH[before.effect]) {
      effectEscalations.push({ capabilityId: after.id, from: before.effect, to: after.effect });
    }
  }

  const limitEscalations: RecipeLimitEscalation[] = [];
  const limitKeys: Array<keyof RecipeLimitSummary> = [
    "maxSteps",
    "maxCalls",
    "maxOutputTokens",
    "timeoutMs",
    "maxOutputBytes",
  ];
  for (const key of limitKeys) {
    if (next.limits[key] > previous.limits[key]) {
      limitEscalations.push({ limit: key, from: previous.limits[key], to: next.limits[key] });
    }
  }

  const previousOutputs = new Set(previous.expectedOutputs);
  const nextOutputs = new Set(next.expectedOutputs);
  const addedOutputs = next.expectedOutputs.filter(output => !previousOutputs.has(output));
  const removedOutputs = previous.expectedOutputs.filter(output => !nextOutputs.has(output));

  const reasons: string[] = [];
  for (const cap of addedCapabilities) reasons.push(`added_capability:${cap}`);
  for (const scope of addedRequiredScopes) reasons.push(`added_required_scope:${scope}`);
  for (const dest of addedDestinations) reasons.push(`added_destination:${dest.kind}:${dest.id}`);
  for (const esc of effectEscalations) reasons.push(`effect_escalation:${esc.capabilityId}:${esc.from}->${esc.to}`);
  for (const lim of limitEscalations) reasons.push(`limit_escalation:${lim.limit}:${lim.from}->${lim.to}`);

  const escalates =
    addedCapabilities.length > 0 ||
    addedRequiredScopes.length > 0 ||
    addedDestinations.length > 0 ||
    effectEscalations.length > 0 ||
    limitEscalations.length > 0;

  return {
    addedCapabilities,
    removedCapabilities,
    versionChangedCapabilities,
    addedRequiredScopes,
    addedDestinations,
    effectEscalations,
    limitEscalations,
    addedOutputs,
    removedOutputs,
    reasons,
    escalates,
  };
}

export function evaluateRecipeUpdate(
  current: Recipe,
  candidate: Recipe,
  registry: CapabilityRegistry
): { escalates: boolean; diff: RecipeScopeDiff } {
  const diff = compareRecipeAuthorization(
    summarizeRecipeAuthorization(current, registry),
    summarizeRecipeAuthorization(candidate, registry)
  );
  return { escalates: diff.escalates, diff };
}
