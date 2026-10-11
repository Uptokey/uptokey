/**
 * E2-15 — in-memory observability store (first slice before WorkspaceStore wiring).
 * Fixtures substitute external SaaS, NOT this store/outbox/policy under test.
 */

import { createHash, randomUUID } from "node:crypto";
import type {
  DestinationConfigPublic,
  PrivateLoggingPlan,
  SavedUsageView,
  UsageQueryInput,
  UsageRecord,
} from "./usage-observability-types.ts";
import { ObservabilityError } from "./usage-observability-types.ts";

export interface DeliveryAck {
  readonly destinationId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly revision: number;
  readonly deliveredAt: string;
  readonly status: "delivered" | "partial" | "unknown" | "failed";
}

export interface CapturedBody {
  readonly planId: string;
  readonly runId: string;
  readonly attemptId: string;
  readonly role: "input" | "output";
  readonly bytes: Uint8Array;
  readonly capturedAt: string;
  readonly expiresAt: string;
}

export interface OutboxItem {
  readonly id: string;
  readonly destinationId: string;
  readonly runId: string;
  readonly fingerprint: string;
  readonly payloadBytes: number;
  readonly attempts: number;
  readonly nextAttemptAt: number;
  readonly status: "queued" | "delivering" | "delivered" | "failed" | "revoked";
}

/** Principal-scoped local store used by query/detail/export/logging/destinations. */
export class UsageObservabilityStore {
  private readonly records = new Map<string, UsageRecord>();
  private readonly views = new Map<string, SavedUsageView>();
  private readonly destinations = new Map<string, DestinationConfigPublic>();
  private readonly loggingPlans = new Map<string, PrivateLoggingPlan>();
  private readonly bodies: CapturedBody[] = [];
  private readonly deliveries: DeliveryAck[] = [];
  private readonly outbox: OutboxItem[] = [];
  private inferenceDispatchCount = 0;

  /** Test/harness only: record that an inference was dispatched (must stay 0 on reload). */
  noteInferenceDispatch(): void {
    this.inferenceDispatchCount++;
  }
  getInferenceDispatchCount(): number {
    return this.inferenceDispatchCount;
  }

  putRecord(record: UsageRecord): UsageRecord {
    const key = `${record.principalId}\0${record.projectId}\0${record.attemptId}`;
    const existing = this.records.get(key);
    if (existing) return existing; // idempotent by attempt
    this.records.set(key, Object.freeze({ ...record, contentCaptured: false as const }));
    return this.records.get(key)!;
  }

  replaceJournalRecords(principalId:string,projectId:string,runIds:readonly string[],records:readonly UsageRecord[]):void {
    const owned=new Set(runIds);
    for(const [key,record] of this.records)if(record.principalId===principalId&&record.projectId===projectId&&owned.has(record.runId))this.records.delete(key);
    for(const record of records){if(record.principalId!==principalId||record.projectId!==projectId||!owned.has(record.runId))throw new ObservabilityError('scope_mismatch');this.putRecord(record);}
  }

  listRecords(principalId: string, projectId?: string): UsageRecord[] {
    const out: UsageRecord[] = [];
    for (const r of this.records.values()) {
      if (r.principalId !== principalId) continue;
      if (projectId && r.projectId !== projectId) continue;
      out.push(r);
    }
    return out;
  }

  getByRun(principalId: string, runId: string): UsageRecord[] {
    return [...this.records.values()].filter((r) => r.principalId === principalId && r.runId === runId);
  }

  getByAttempt(principalId: string, attemptId: string): UsageRecord | undefined {
    for (const r of this.records.values()) {
      if (r.principalId === principalId && r.attemptId === attemptId) return r;
    }
    return undefined;
  }

  /** Other principal must not read — returns empty / throws unauthorized at service layer. */
  assertPrincipal(principalId: string, record: UsageRecord): void {
    if (record.principalId !== principalId) throw new ObservabilityError("unauthorized");
  }

  saveView(input: {
    ownerPrincipalId: string;
    name: string;
    query: UsageQueryInput;
    expectedRevision?: number;
    id?: string;
  }): SavedUsageView {
    if (input.query.principalId !== input.ownerPrincipalId) {
      throw new ObservabilityError("scope_mismatch");
    }
    const id = input.id ?? `view_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    const existing = this.views.get(id);
    if (existing) {
      if (existing.ownerPrincipalId !== input.ownerPrincipalId) throw new ObservabilityError("unauthorized");
      if (input.expectedRevision !== undefined && input.expectedRevision !== existing.revision) {
        throw new ObservabilityError("revision_conflict");
      }
    }
    const view: SavedUsageView = Object.freeze({
      id,
      ownerPrincipalId: input.ownerPrincipalId,
      name: input.name.slice(0, 128),
      query: structuredClone(input.query),
      revision: (existing?.revision ?? 0) + 1,
      updatedAt: new Date().toISOString(),
    });
    this.views.set(id, view);
    return view;
  }

  getView(principalId: string, id: string): SavedUsageView | undefined {
    const v = this.views.get(id);
    if (!v) return undefined;
    if (v.ownerPrincipalId !== principalId) throw new ObservabilityError("unauthorized");
    return v;
  }

  listViews(principalId: string): SavedUsageView[] {
    return [...this.views.values()].filter((v) => v.ownerPrincipalId === principalId);
  }

  upsertDestination(cfg: DestinationConfigPublic, actorPrincipalId: string, expectedRevision?: number): DestinationConfigPublic {
    void actorPrincipalId;
    const existing = this.destinations.get(cfg.id);
    if (existing && expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new ObservabilityError("revision_conflict");
    }
    const next = Object.freeze({ ...cfg, revision: (existing?.revision ?? 0) + 1 });
    this.destinations.set(cfg.id, next);
    return next;
  }

  getDestination(id: string): DestinationConfigPublic | undefined {
    return this.destinations.get(id);
  }

  listDestinations(): DestinationConfigPublic[] {
    return [...this.destinations.values()];
  }

  putLoggingPlan(plan: PrivateLoggingPlan, expectedRevision?: number): PrivateLoggingPlan {
    const existing = this.loggingPlans.get(plan.id);
    if (existing && expectedRevision !== undefined && expectedRevision !== existing.revision) {
      throw new ObservabilityError("revision_conflict");
    }
    const next = Object.freeze({ ...plan, revision: (existing?.revision ?? 0) + 1 });
    this.loggingPlans.set(plan.id, next);
    return next;
  }

  getLoggingPlan(id: string): PrivateLoggingPlan | undefined {
    return this.loggingPlans.get(id);
  }

  listLoggingPlans(principalId: string): PrivateLoggingPlan[] {
    return [...this.loggingPlans.values()].filter((p) => p.principalId === principalId);
  }

  captureBody(body: CapturedBody): void {
    this.bodies.push(body);
  }

  listBodies(planId: string): CapturedBody[] {
    return this.bodies.filter((b) => b.planId === planId);
  }

  purgeBodies(planId: string): number {
    let n = 0;
    for (let i = this.bodies.length - 1; i >= 0; i--) {
      if (this.bodies[i]!.planId === planId) {
        this.bodies.splice(i, 1);
        n++;
      }
    }
    return n;
  }

  acknowledgeDelivery(ack: DeliveryAck): void {
    const dup = this.deliveries.find(
      (d) => d.destinationId === ack.destinationId && d.runId === ack.runId && d.fingerprint === ack.fingerprint,
    );
    if (dup) return;
    this.deliveries.push(Object.freeze({ ...ack }));
  }

  listDeliveries(destinationId?: string): DeliveryAck[] {
    return destinationId
      ? this.deliveries.filter((d) => d.destinationId === destinationId)
      : [...this.deliveries];
  }

  enqueueOutbox(item: Omit<OutboxItem, "attempts" | "nextAttemptAt" | "status"> & Partial<Pick<OutboxItem, "attempts" | "status">>): OutboxItem {
    const row: OutboxItem = Object.freeze({
      id: item.id,
      destinationId: item.destinationId,
      runId: item.runId,
      fingerprint: item.fingerprint,
      payloadBytes: item.payloadBytes,
      attempts: item.attempts ?? 0,
      nextAttemptAt: Date.now(),
      status: item.status ?? "queued",
    });
    this.outbox.push(row);
    return row;
  }

  listOutbox(destinationId?: string): OutboxItem[] {
    return destinationId ? this.outbox.filter((o) => o.destinationId === destinationId) : [...this.outbox];
  }

  updateOutbox(id: string, patch: Partial<OutboxItem>): OutboxItem | undefined {
    const idx = this.outbox.findIndex((o) => o.id === id);
    if (idx < 0) return undefined;
    const next = Object.freeze({ ...this.outbox[idx]!, ...patch, id });
    this.outbox[idx] = next;
    return next;
  }

  /** Snapshot for restart simulation — deliveries and queue survive; consent expiry checked separately. */

  /** Project-isolated snapshot: only exports records for the specified principal & project. */
  snapshotProject(principalId: string, projectId: string) {
    return {
      records: [...this.records.values()].filter(r => r.principalId === principalId && r.projectId === projectId),
      destinations: [...this.destinations.values()],
      loggingPlans: [...this.loggingPlans.values()],
      deliveries: [...this.deliveries],
      outbox: [...this.outbox],
    };
  }

  /** Project-isolated restore: replaces only this project's records without clobbering other projects. */
  restoreProject(principalId: string, projectId: string, snap: {
    records: UsageRecord[];
    destinations: DestinationConfigPublic[];
    loggingPlans: PrivateLoggingPlan[];
    deliveries: DeliveryAck[];
    outbox: OutboxItem[];
  }): void {
    for (const [id, r] of [...this.records.entries()]) {
      if (r.principalId === principalId && r.projectId === projectId) {
        this.records.delete(id);
      }
    }
    for (const r of snap.records) {
      if (r.principalId === principalId && r.projectId === projectId) {
        this.putRecord(r);
      }
    }
    for (const d of snap.destinations) {
      if (!this.destinations.has(d.id)) this.destinations.set(d.id, d);
    }
    for (const p of snap.loggingPlans) {
      if (!this.loggingPlans.has(p.id)) this.loggingPlans.set(p.id, p);
    }
  }
  snapshot(): {
    records: UsageRecord[];
    destinations: DestinationConfigPublic[];
    loggingPlans: PrivateLoggingPlan[];
    deliveries: DeliveryAck[];
    outbox: OutboxItem[];
  } {
    return {
      records: [...this.records.values()],
      destinations: [...this.destinations.values()],
      loggingPlans: [...this.loggingPlans.values()],
      deliveries: [...this.deliveries],
      outbox: [...this.outbox],
    };
  }

  restore(snap: ReturnType<UsageObservabilityStore["snapshot"]>): void {
    this.records.clear();
    for (const r of snap.records) this.putRecord(r);
    this.destinations.clear();
    for (const d of snap.destinations) this.destinations.set(d.id, d);
    this.loggingPlans.clear();
    for (const p of snap.loggingPlans) this.loggingPlans.set(p.id, p);
    this.deliveries.length = 0;
    this.deliveries.push(...snap.deliveries);
    this.outbox.length = 0;
    this.outbox.push(...snap.outbox);
    // inferenceDispatchCount intentionally NOT restored from snap — reload must not redispatch
  }
}

export function fingerprintSpans(parts: readonly string[]): string {
  const h = createHash("sha256");
  for (const p of parts) h.update(p).update("\n");
  return h.digest("hex");
}
