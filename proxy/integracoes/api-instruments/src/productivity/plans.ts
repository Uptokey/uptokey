/**
 * Provisional productivity plans (etapa 15). Stores plan + snapshot ONLY — never grants
 * or approves. The write step binds the prepared call AND the exact effect preview;
 * approval (W5 P-256 via approveApiInstrumentPlan) and the executor consume it.
 */
import { randomUUID, createHash } from 'node:crypto';
import {
  parseExecutionPlan,
  validatePlanBindings,
  canonicalContextSnapshotPayload,
  type ExecutionPlan,
  type ContextSnapshot,
} from '@uptokey/sync-contract/workflow';
import type { WorkspaceStore } from "../../../../core/src/workspace/store.ts";
import { computePlanDigest } from "../../../../core/src/workspace/planner.ts";
import type { PreparedProductivityCall, ProductivityOperation } from './operations.ts';
import type { EffectPreview } from './operations.ts';

export async function createProvisionalProductivityPlan(
  store: WorkspaceStore,
  principalId: string,
  projectId: string,
  operation: ProductivityOperation,
  prepared: PreparedProductivityCall,
  preview: EffectPreview | null,
): Promise<{ plan: ExecutionPlan; snapshot: ContextSnapshot }> {
  if (operation.effectClass === 'escrita_externa' && (!preview || preview.previewDigest !== prepared.previewDigest)) {
    throw new Error('productivity_preview_required');
  }
  const bundle = await store.getBundle(principalId, projectId);
  const project = bundle.project;
  const snapshot = await store.snapshotContext(principalId, projectId, {
    selectedEntryIds: [],
    selectedArtifactIds: [],
    excludedEntryIds: project.entries.map((e) => e.id),
    allowedDestinations: [operation.capability.dataDestination],
    maxContextBytes: 32_000,
  });
  const snapshotDigest = createHash('sha256').update(canonicalContextSnapshotPayload(snapshot), 'utf8').digest('hex');
  let plan: ExecutionPlan = {
    schemaVersion: 1,
    id: randomUUID(),
    createdAt: new Date().toISOString(),
    projectId,
    projectRevision: project.revision,
    contextSnapshotId: snapshot.id,
    contextSnapshotDigest: snapshotDigest,
    steps: [
      {
        id: 'execute_productivity',
        capabilityId: operation.id,
        capabilityVersion: operation.capability.version,
        arguments: {
          prepared_write: { kind: 'literal', value: JSON.parse(JSON.stringify(prepared)) },
          ...(preview ? { preview: { kind: 'literal', value: JSON.parse(JSON.stringify(preview)) } } : {}),
        },
      },
    ],
    limits: { ...operation.capability.limits },
    digest: '0'.repeat(64),
  };
  plan = { ...plan, digest: computePlanDigest(plan) };
  plan = parseExecutionPlan(plan);
  validatePlanBindings(plan, snapshot, [operation.capability]);
  await store.putPlan(principalId, plan, snapshot);
  return { plan, snapshot };
}
