import { createHash } from "node:crypto";
import {
  type ExecutionPlan,
  type PlanStep,
  type ExecutionLimits,
  type WorkflowScope,
  canonicalPlanPayload,
  parseExecutionPlan,
} from "@uptokey/sync-contract/workflow";
import {
  CapabilityRegistry,
  CROSSREF_CAPABILITY,
  OPEN_LIBRARY_CAPABILITY,
  PUBMED_CAPABILITY,
  OPENALEX_CAPABILITY,
} from "./capabilities.ts";

export interface ResearchPlanRequest {
  readonly projectId: string;
  readonly projectRevision: number;
  readonly query: string;
  readonly contextSnapshotId: string;
  readonly contextSnapshotDigest: string;
  readonly selectedSources?: readonly ("crossref" | "open-library" | "pubmed" | "openalex")[];
  readonly limits?: Partial<ExecutionLimits>;
}

export interface CapabilityMatch {
  readonly capability: typeof CROSSREF_CAPABILITY;
  readonly reason: string;
}

export const DEFAULT_EXECUTION_LIMITS: ExecutionLimits = {
  maxSteps: 12,
  maxCalls: 12,
  maxOutputTokens: 4096,
  timeoutMs: 60_000,
  maxOutputBytes: 1_048_576,
};

function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

/**
 * Intent-based selector matching query against capability tags and descriptions.
 */
export function selectCapabilitiesForGoal(
  goal: string,
  registry: CapabilityRegistry,
  grantedScopes: readonly WorkflowScope[] = ["run:execute"]
): readonly CapabilityMatch[] {
  const normalized = fold(goal);
  const words = normalized.split(/\s+/u).filter((w) => w.length >= 2);
  const executable = registry.listExecutable(grantedScopes);
  const matches: CapabilityMatch[] = [];

  for (const cap of executable) {
    let matchedTag: string | undefined;
    for (const tag of cap.tags) {
      if (words.some((word) => word === tag || (word.length >= 4 && (tag.startsWith(word) || word.startsWith(tag))))) {
        matchedTag = tag;
        break;
      }
    }

    if (matchedTag) {
      matches.push({
        capability: cap,
        reason: `Matched research tag '${matchedTag}' relevant to query`,
      });
    } else if (
      (cap.id === CROSSREF_CAPABILITY.id && (normalized.includes("paper") || normalized.includes("artigo") || normalized.includes("doi") || normalized.includes("pesquisa"))) ||
      (cap.id === OPEN_LIBRARY_CAPABILITY.id && (normalized.includes("book") || normalized.includes("livro") || normalized.includes("autor") || normalized.includes("obra")))
    ) {
      matches.push({
        capability: cap,
        reason: `Explicit bibliographic research source matching '${cap.id}'`,
      });
    }
  }

  if (matches.length === 0 && executable.length > 0) {
    for (const cap of executable.slice(0, 2)) {
      matches.push({
        capability: cap,
        reason: "Default verified public bibliographic source for general inquiry",
      });
    }
  }

  return matches;
}

/**
 * Computes canonical SHA-256 digest of an execution plan using W0 canonicalPlanPayload.
 */
export function computePlanDigest(plan: unknown): string {
  const canonical = canonicalPlanPayload(plan);
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Validates an execution plan:
 * 1. Checks W0 structural schema via parseExecutionPlan.
 * 2. Checks canonical digest integrity against canonicalPlanPayload.
 * 3. Asserts that capabilities are executable and registered in registry.
 * 4. Ensures step_output bindings strictly reference prior steps.
 */
export function validateExecutionPlan(
  plan: unknown,
  registry: CapabilityRegistry,
  grantedScopes: readonly WorkflowScope[] = ["run:execute"]
): { valid: boolean; errors: readonly string[] } {
  const errors: string[] = [];
  let parsed: ExecutionPlan;

  try {
    parsed = parseExecutionPlan(plan);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "schema_invalid";
    return { valid: false, errors: [`plan_schema_invalid:${msg}`] };
  }

  const expectedDigest = computePlanDigest(parsed);
  if (parsed.digest !== expectedDigest) {
    errors.push(`plan_digest_mismatch:expected_${expectedDigest}_got_${parsed.digest}`);
  }

  const seenStepIds = new Set<string>();
  for (const step of parsed.steps) {
    if (seenStepIds.has(step.id)) {
      errors.push(`step_id_duplicate:${step.id}`);
    }
    seenStepIds.add(step.id);

    for (const [argKey, binding] of Object.entries(step.arguments)) {
      if (binding.kind === "step_output") {
        if (!seenStepIds.has(binding.stepId) || binding.stepId === step.id) {
          errors.push(`invalid_dependency:${step.id}->${binding.stepId}`);
        }
      }
    }

    try {
      registry.assertExecutable(step.capabilityId, step.capabilityVersion, grantedScopes);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "capability_validation_failed";
      errors.push(`step_${step.id}_capability_error:${msg}`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

/**
 * Deterministic Research Planner (v1).
 * Generates an ExecutionPlan conforming 100% to W0.
 * Requires real context snapshot ID and digest (no zero fallbacks).
 * Guarantees that different plans never share an ID.
 */
export class DeterministicResearchPlanner {
  private readonly registry: CapabilityRegistry;

  constructor(registry: CapabilityRegistry = new CapabilityRegistry()) {
    this.registry = registry;
  }

  buildPlan(request: ResearchPlanRequest): ExecutionPlan {
    const query = request.query?.trim();
    if (!query || query.length < 2 || query.length > 300 || /[\u0000-\u001f]/.test(query)) {
      throw new Error("invalid_research_query");
    }

    // Require valid, non-fallback real snapshot identity and digest
    if (
      !request.contextSnapshotId ||
      typeof request.contextSnapshotId !== "string" ||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(request.contextSnapshotId)
    ) {
      throw new Error("invalid_context_snapshot_id");
    }

    if (
      !request.contextSnapshotDigest ||
      typeof request.contextSnapshotDigest !== "string" ||
      !/^[a-f0-9]{64}$/.test(request.contextSnapshotDigest) ||
      request.contextSnapshotDigest === "0".repeat(64)
    ) {
      throw new Error("invalid_context_snapshot_digest");
    }

    const sources = request.selectedSources && request.selectedSources.length > 0
      ? request.selectedSources
      : ["crossref", "open-library"] as const;

    const steps: PlanStep[] = [];
    let stepIndex = 1;
    const SOURCE_CAPABILITIES = {
      "crossref": CROSSREF_CAPABILITY,
      "open-library": OPEN_LIBRARY_CAPABILITY,
      "pubmed": PUBMED_CAPABILITY,
      "openalex": OPENALEX_CAPABILITY,
    } as const;

    for (const source of sources) {
      const capability = SOURCE_CAPABILITIES[source];
      if (!capability) continue;
      steps.push({
        id: `step_${stepIndex++}`,
        capabilityId: capability.id,
        capabilityVersion: capability.version,
        arguments: {
          query: {
            kind: "literal",
            value: query,
          },
        },
      });
    }

    const limits: ExecutionLimits = {
      maxSteps: Math.min(request.limits?.maxSteps ?? DEFAULT_EXECUTION_LIMITS.maxSteps, 12),
      maxCalls: Math.min(request.limits?.maxCalls ?? DEFAULT_EXECUTION_LIMITS.maxCalls, 12),
      maxOutputTokens: request.limits?.maxOutputTokens ?? DEFAULT_EXECUTION_LIMITS.maxOutputTokens,
      timeoutMs: request.limits?.timeoutMs ?? DEFAULT_EXECUTION_LIMITS.timeoutMs,
      maxOutputBytes: request.limits?.maxOutputBytes ?? DEFAULT_EXECUTION_LIMITS.maxOutputBytes,
    };

    const createdAt = new Date().toISOString();

    // Generate unique plan ID committing to all contents (projectId, revision, snapshot, steps and limits)
    // Guarantees that different plans never share an ID.
    const planSignature = JSON.stringify({
      projectId: request.projectId,
      projectRevision: request.projectRevision,
      contextSnapshotId: request.contextSnapshotId,
      contextSnapshotDigest: request.contextSnapshotDigest,
      steps,
      limits,
    });
    const planId = `plan_${createHash("sha256").update(planSignature).digest("hex").slice(0, 24)}`;

    const provisionalPlan = {
      schemaVersion: 1 as const,
      id: planId,
      createdAt,
      projectId: request.projectId,
      projectRevision: request.projectRevision,
      contextSnapshotId: request.contextSnapshotId,
      contextSnapshotDigest: request.contextSnapshotDigest,
      steps,
      limits,
      digest: "0".repeat(64),
    };

    const digest = computePlanDigest(provisionalPlan);
    const finalPlan: ExecutionPlan = {
      ...provisionalPlan,
      digest,
    };

    const validation = validateExecutionPlan(finalPlan, this.registry);
    if (!validation.valid) {
      throw new Error(`generated_plan_invalid:${validation.errors.join(";")}`);
    }

    return finalPlan;
  }
}
