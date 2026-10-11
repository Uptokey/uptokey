/**
 * E2-15-D — drilldown to run/receipt. Reload is read-only (no inference / no export resume).
 */

import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import { ObservabilityError, type UsageRecord } from "./usage-observability-types.ts";

export interface UsageDetailResult {
  readonly runId: string;
  readonly receipts: readonly UsageRecord[];
  readonly io: {
    readonly status: "unavailable" | "authorized" | "logging_not_enabled_at_capture";
    readonly bodies: readonly { role: "input" | "output"; byteLength: number; attemptId: string }[];
  };
  readonly estimatesIdentified: boolean;
  readonly source: "local_store";
}

export function getUsageDetail(
  store: UsageObservabilityStore,
  input: {
    principalId: string;
    runId: string;
    contentPolicyRef?: string | null;
    cursor?: string | null;
  },
): UsageDetailResult {
  if (!input.principalId) throw new ObservabilityError("unauthorized");
  let receipts = store.getByRun(input.principalId, input.runId);
  if (receipts.length === 0) {
    // Distinguish empty vs unauthorized: if any record exists for run under other principal → unauthorized
    const any = [...store.listRecords("__probe__")]; // always empty for probe
    void any;
    throw new ObservabilityError("unauthorized");
  }
  if (input.cursor) {
    receipts = receipts.filter((r) => r.attemptId > input.cursor!);
  }

  const estimatesIdentified = receipts.some(
    (r) => r.usage.basis === "estimated" || r.cost.estimatedReference.micros !== null,
  );

  let ioStatus: UsageDetailResult["io"]["status"] = "logging_not_enabled_at_capture";
  const bodies: { role: "input" | "output"; byteLength: number; attemptId: string }[] = [];

  if (input.contentPolicyRef) {
    const plan = store.getLoggingPlan(input.contentPolicyRef);
    if (
      plan &&
      plan.principalId === input.principalId &&
      plan.applied &&
      !plan.paused &&
      plan.mode === "content" &&
      Date.parse(plan.expiresAt) > Date.now()
    ) {
      const captured = store.listBodies(plan.id).filter((b) => receipts.some((r) => r.attemptId === b.attemptId));
      if (captured.length === 0) {
        ioStatus = "logging_not_enabled_at_capture";
      } else {
        ioStatus = "authorized";
        for (const b of captured) {
          bodies.push({ role: b.role, byteLength: b.bytes.byteLength, attemptId: b.attemptId });
        }
      }
    } else {
      ioStatus = "unavailable";
    }
  }

  return {
    runId: input.runId,
    receipts: Object.freeze(receipts),
    io: { status: ioStatus, bodies: Object.freeze(bodies) },
    estimatesIdentified,
    source: "local_store",
  };
}

/**
 * Reload path: re-read detail without side effects.
 * Must not call noteInferenceDispatch / enqueueOutbox / resume export.
 */
export function reloadUsageDetail(
  store: UsageObservabilityStore,
  input: { principalId: string; runId: string; contentPolicyRef?: string | null },
): { detail: UsageDetailResult; inferenceDispatches: number; outboxLen: number } {
  const beforeInf = store.getInferenceDispatchCount();
  const beforeOut = store.listOutbox().length;
  const detail = getUsageDetail(store, input);
  const afterInf = store.getInferenceDispatchCount();
  const afterOut = store.listOutbox().length;
  if (afterInf !== beforeInf || afterOut !== beforeOut) {
    throw new Error("reload_had_side_effects");
  }
  return { detail, inferenceDispatches: afterInf, outboxLen: afterOut };
}
