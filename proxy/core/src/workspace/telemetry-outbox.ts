import { createHash } from 'node:crypto';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { projectExecutionSpans } from './telemetry.ts';
import type { WorkspaceTelemetryExporter } from './telemetry-exporter.ts';
import type { WorkspaceStore } from './store.ts';

/** The encrypted journal is the outbox source. Only delivery acknowledgements add persisted state. */
export class WorkspaceTelemetryOutbox {
  private closed = false;
  private tail: Promise<unknown> = Promise.resolve();
  private scheduled = new Map<string, { dirty: boolean }>();
  private readonly store: WorkspaceStore;
  private readonly exporter: WorkspaceTelemetryExporter;
  readonly destinationId: string;
  constructor(store: WorkspaceStore, exporter: WorkspaceTelemetryExporter, destinationId: string) {
    if (!/^[a-f0-9]{64}$/.test(destinationId)) throw new Error('workspace_telemetry_destination_invalid');
    this.store = store; this.exporter = exporter; this.destinationId = destinationId;
  }

  /** Called after journal commit; never waits for network and never throws into execution. */
  notify(identityId: string, projectId: string): void {
    if (this.closed) return;
    const key = `${identityId}:${projectId}`, existing = this.scheduled.get(key);
    if (existing) { existing.dirty = true; return; }
    // This is a wakeup bound, not a persisted-data bound. Resume can always rediscover journal entries.
    if (this.scheduled.size >= 128) return;
    const state = { dirty: true }; this.scheduled.set(key, state);
    void (async () => {
      try {
        while (state.dirty && !this.closed) {
          state.dirty = false;
          await this.flushProject(identityId, projectId);
        }
      } finally { this.scheduled.delete(key); }
    })().catch(() => undefined);
  }

  /** Explicit opt-in composition resumes metadata delivery, never workflow effects. */
  async resume(): Promise<void> {
    try {
      for (const target of await this.store.listJournalProjects()) {
        if (this.closed) break;
        await this.flushProject(target.identityId, target.projectId);
      }
    } catch { /* Journal failures do not change the execution result. */ }
  }

  flushProject(identityId: string, projectId: string): Promise<boolean> {
    const task = this.tail.then(() => this.deliver(identityId, projectId)).catch(() => false);
    this.tail = task;
    return task;
  }

  private async deliver(identityId: string, projectId: string): Promise<boolean> {
    if (this.closed) return false;
    const bundle = await this.store.getBundle(identityId, projectId);
    for (const slot of bundle.runs) {
      if (this.closed) return false;
      if (!['succeeded', 'failed', 'cancelled', 'needs_attention'].includes(slot.run.status) ||
          slot.receipts.some(receipt => receipt.status === 'prepared' || receipt.status === 'dispatched')) continue;
      const spans = projectExecutionSpans(slot.run, slot.receipts);
      if (!spans.length) continue;
      // Incremental hashing avoids the canonical serializer's array-size limit.
      const hash = createHash('sha256');
      for (const span of spans) hash.update(canonicalJson(span)).update('\n');
      const fingerprint = hash.digest('hex');
      const delivered = bundle.telemetryDeliveries?.find(item => item.destinationId === this.destinationId && item.runId === slot.run.id);
      if (delivered?.fingerprint === fingerprint) continue;
      for (let offset = 0; offset < spans.length; offset += 128) {
        if (this.closed || !await this.exporter.export(spans.slice(offset, offset + 128))) return false;
      }
      if (!await this.store.acknowledgeTelemetry(identityId, projectId,
        { destinationId: this.destinationId, runId: slot.run.id, runRevision: slot.revision, fingerprint })) return false;
    }
    return true;
  }

  async close(): Promise<void> {
    this.closed = true;
    try { await this.exporter.shutdown(); } catch { /* No exception text or credentials are logged. */ }
    await this.tail;
  }
}
