/**
 * E2-15 — exclusive persistence helper for UsageObservabilityStore.
 * Sidecar file (not WorkspaceBundle keys) so missing ⇒ empty store (absent≠0).
 * Called from store.ts writeSnapshot/readSnapshot via thin E2-15 hooks.
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import {createHash} from 'node:crypto';
import {writeJsonAtomic} from '../atomic-json.ts';
import type {WorkspaceBundle} from './store.ts';
import {
  UsageObservabilityStore,
  type DeliveryAck,
  type OutboxItem,
} from "./usage-observability-store.ts";
import type {
  DestinationConfigPublic,
  PrivateLoggingPlan,
  UsageRecord,
} from "./usage-observability-types.ts";

export const USAGE_OBSERVABILITY_SIDECAR = "usage-observability.json";
export const USAGE_OBSERVABILITY_SCHEMA = "uptokey-usage-observability-v1";

export type UsageObservabilityPersistSnap = {
  schema: typeof USAGE_OBSERVABILITY_SCHEMA;
  records: UsageRecord[];
  destinations: DestinationConfigPublic[];
  loggingPlans: PrivateLoggingPlan[];
  deliveries: DeliveryAck[];
  outbox: OutboxItem[];
};

export function usageObservabilitySidecarPath(projectDir: string): string {
  return join(projectDir, USAGE_OBSERVABILITY_SIDECAR);
}

/** Missing file / corrupt / wrong schema ⇒ empty snapshot (never fabricate zeros). */
export async function loadUsageObservabilityPersist(
  projectDir: string,
): Promise<UsageObservabilityPersistSnap | null> {
  const path = usageObservabilitySidecarPath(projectDir);
  try {
    const raw = await readFile(path, "utf8");
    const parsed = JSON.parse(raw) as Partial<UsageObservabilityPersistSnap>;
    if (!parsed || parsed.schema !== USAGE_OBSERVABILITY_SCHEMA) return null;
    return {
      schema: USAGE_OBSERVABILITY_SCHEMA,
      records: Array.isArray(parsed.records) ? parsed.records : [],
      destinations: Array.isArray(parsed.destinations) ? parsed.destinations : [],
      loggingPlans: Array.isArray(parsed.loggingPlans) ? parsed.loggingPlans : [],
      deliveries: Array.isArray(parsed.deliveries) ? parsed.deliveries : [],
      outbox: Array.isArray(parsed.outbox) ? parsed.outbox : [],
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === "ENOENT") return null;
    return null; // corrupt ⇒ empty (fail closed, no invented metrics)
  }
}

export async function saveUsageObservabilityPersist(
  projectDir: string,
  store: UsageObservabilityStore,
  principalId?: string,
  projectId?: string,
): Promise<void> {
  const snap = (principalId && projectId) ? store.snapshotProject(principalId, projectId) : store.snapshot();
  const payload: UsageObservabilityPersistSnap = {
    schema: USAGE_OBSERVABILITY_SCHEMA,
    records: snap.records,
    destinations: snap.destinations,
    loggingPlans: snap.loggingPlans,
    deliveries: snap.deliveries,
    outbox: snap.outbox,
  };
  await mkdir(dirname(usageObservabilitySidecarPath(projectDir)), { recursive: true, mode: 0o700 });
  await writeJsonAtomic(usageObservabilitySidecarPath(projectDir),payload);
}

/** Rebuild measured metadata from the authenticated journal, including late usage and privacy deletions. */
export function projectJournalUsage(store:UsageObservabilityStore,bundle:WorkspaceBundle):void {
  const principalId=bundle.project.ownerPrincipalId,projectId=bundle.project.id;
  const records:UsageRecord[]=bundle.runs.flatMap(slot=>slot.receipts.map(receipt=>{
    const value=bundle.usageValues.find(item=>item.runId===slot.run.id&&item.attemptId===receipt.attemptId);
    const amount=value?.referenceValue;
    const micros=amount?((BigInt(amount.numeratorMicros)+BigInt(amount.denominator)-1n)/BigInt(amount.denominator)).toString():null;
    return {id:'journal_'+createHash('sha256').update(principalId+'\0'+projectId+'\0'+receipt.attemptId).digest('hex'),principalId,projectId,runId:slot.run.id,attemptId:receipt.attemptId,generationRef:null,createdAt:receipt.startedAt,
      provider:value?.provider??'unknown',model:value?.model??'unknown',opaqueKeyId:null,appId:null,agentId:null,sessionId:null,
      status:receipt.status==='succeeded'?'succeeded' as const:receipt.status==='failed'?'failed' as const:'unknown' as const,
      latencyMs:receipt.finishedAt?Math.max(0,Date.parse(receipt.finishedAt)-Date.parse(receipt.startedAt)):null,ttftMs:null,
      usage:{...receipt.usage,reasoningTokens:null},cost:{providerReported:{kind:'absent' as const,micros:null,currency:null},estimatedReference:{kind:micros===null?'absent' as const:'estimated_reference' as const,micros,currency:micros===null?null:'USD' as const},confirmedCharge:{kind:'absent' as const,micros:null,currency:null}},
      cacheHits:value?value.cache==='none'?0:1:null,cacheMisses:value?value.cache==='none'?1:0:null,contentCaptured:false as const};
  }));
  store.replaceJournalRecords(principalId,projectId,bundle.runs.map(slot=>slot.run.id),records);
}

/** Apply sidecar into store; no-op when absent. */
export function restoreUsageObservabilityFromPersist(
  store: UsageObservabilityStore,
  snap: UsageObservabilityPersistSnap | null,
  principalId?: string,
  projectId?: string,
): void {
  if (!snap) return;
  if (principalId && projectId) {
    store.restoreProject(principalId, projectId, {
      records: snap.records,
      destinations: snap.destinations,
      loggingPlans: snap.loggingPlans,
      deliveries: snap.deliveries,
      outbox: snap.outbox,
    });
  } else {
    store.restore({
      records: snap.records,
      destinations: snap.destinations,
      loggingPlans: snap.loggingPlans,
      deliveries: snap.deliveries,
      outbox: snap.outbox,
    });
  }
}
