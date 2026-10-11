/**
 * E2-15-AC04/AC07 — outbox delivery with retry, backpressure, partial success.
 * Synthetic collector only in tests; does not redeploy inference on reload.
 * Reuses fingerprint ACK pattern from WorkspaceTelemetryOutbox.
 */

import { randomUUID } from "node:crypto";
import { fingerprintSpans, type UsageObservabilityStore, type OutboxItem } from "./usage-observability-store.ts";
import type { DestinationConfigPublic } from "./usage-observability-types.ts";

export interface SyntheticCollector {
  readonly received: { fingerprint: string; bytes: number }[];
  readonly failUntilAttempt: number;
  readonly maxBatchBytes: number;
  accept(fingerprint: string, bytes: number, attempt: number): "ok" | "partial" | "reject" | "backpressure";
}

export function createSyntheticCollector(opts?: {
  failUntilAttempt?: number;
  maxBatchBytes?: number;
}): SyntheticCollector {
  const received: { fingerprint: string; bytes: number }[] = [];
  const failUntilAttempt = opts?.failUntilAttempt ?? 0;
  const maxBatchBytes = opts?.maxBatchBytes ?? 256 * 1024;
  return {
    received,
    failUntilAttempt,
    maxBatchBytes,
    accept(fingerprint, bytes, attempt) {
      if (bytes > maxBatchBytes) return "backpressure";
      if (attempt < failUntilAttempt) return "reject";
      if (bytes > maxBatchBytes / 2 && attempt === failUntilAttempt) return "partial";
      received.push({ fingerprint, bytes });
      return "ok";
    },
  };
}

export function enqueueRunDelivery(
  store: UsageObservabilityStore,
  dest: DestinationConfigPublic,
  runId: string,
  spanParts: readonly string[],
): string {
  if (!dest.enabled) return "";
  const fp = fingerprintSpans(spanParts);
  const existing = store.listDeliveries(dest.id).find((d) => d.runId === runId && d.fingerprint === fp);
  if (existing) return existing.fingerprint; // already delivered — no requeue
  const id = `obx_${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  store.enqueueOutbox({
    id,
    destinationId: dest.id,
    runId,
    fingerprint: fp,
    payloadBytes: spanParts.join("\n").length,
  });
  return fp;
}

export function flushOutbox(
  store: UsageObservabilityStore,
  collector: SyntheticCollector,
  opts?: { maxAttempts?: number; now?: number },
): { delivered: number; failed: number; partial: number; backpressure: number } {
  const maxAttempts = opts?.maxAttempts ?? 5;
  let delivered = 0,
    failed = 0,
    partial = 0,
    backpressure = 0;

  for (const item of store.listOutbox()) {
    if (item.status === "delivered" || item.status === "revoked") continue;
    const dest = store.getDestination(item.destinationId);
    if (!dest || !dest.enabled) {
      store.updateOutbox(item.id, { status: "revoked" });
      continue;
    }

    let attempts = item.attempts;
    let status: OutboxItem["status"] = item.status;
    while (attempts < maxAttempts && status !== "delivered") {
      attempts++;
      const result = collector.accept(item.fingerprint, item.payloadBytes, attempts);
      if (result === "backpressure") {
        backpressure++;
        // Limited backoff
        store.updateOutbox(item.id, {
          attempts,
          status: "queued",
          nextAttemptAt: (opts?.now ?? Date.now()) + Math.min(30_000, 500 * 2 ** attempts),
        });
        break;
      }
      if (result === "reject") {
        store.updateOutbox(item.id, { attempts, status: "queued" });
        continue;
      }
      if (result === "partial") {
        partial++;
        store.acknowledgeDelivery({
          destinationId: item.destinationId,
          runId: item.runId,
          fingerprint: item.fingerprint,
          revision: dest.revision,
          deliveredAt: new Date().toISOString(),
          status: "partial",
        });
        store.updateOutbox(item.id, { attempts, status: "delivered" });
        status = "delivered";
        break;
      }
      // ok
      delivered++;
      store.acknowledgeDelivery({
        destinationId: item.destinationId,
        runId: item.runId,
        fingerprint: item.fingerprint,
        revision: dest.revision,
        deliveredAt: new Date().toISOString(),
        status: "delivered",
      });
      store.updateOutbox(item.id, { attempts, status: "delivered" });
      status = "delivered";
    }
    if (status !== "delivered" && attempts >= maxAttempts) {
      failed++;
      store.updateOutbox(item.id, { attempts, status: "failed" });
      store.acknowledgeDelivery({
        destinationId: item.destinationId,
        runId: item.runId,
        fingerprint: item.fingerprint,
        revision: dest.revision,
        deliveredAt: new Date().toISOString(),
        status: "unknown",
      });
    }
  }
  return { delivered, failed, partial, backpressure };
}

/** After disable/revoke: queued items become revoked; no new accepts. */
export function revokeDestinationQueue(store: UsageObservabilityStore, destinationId: string): number {
  let n = 0;
  for (const item of store.listOutbox(destinationId)) {
    if (item.status === "queued" || item.status === "delivering") {
      store.updateOutbox(item.id, { status: "revoked" });
      n++;
    }
  }
  return n;
}
