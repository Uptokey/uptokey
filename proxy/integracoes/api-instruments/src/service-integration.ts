import { fetchAndNormalizeRss } from './adapters/rss-adapter.ts';
import { randomUUID, createHash } from 'node:crypto';
import {
  parseCapabilityDescriptor,
  parseExecutionPlan,
  parsePlanApproval,
  parseProjectGrant,
  validatePlanBindings,
  canonicalContextSnapshotPayload,
  canonicalPlanPayload,
  type CapabilityDescriptor,
  type ExecutionPlan,
  type PlanApproval,
  type ProjectGrant,
  type ContextSnapshot,
  type ExecutionReceipt,
} from '@uptokey/sync-contract/workflow';
import {
  WorkflowExecutor,
  type EffectDispatcher,
  type EffectRequest,
  type EffectOutcome,
  type PolicyEnvironment,
  type RunJournal,
} from "../../../core/src/workspace/executor.ts";
import { createRunJournal } from "../../../core/src/workspace/journal.ts";
import type { WorkspaceStore } from "../../../core/src/workspace/store.ts";
import { computePlanDigest } from "../../../core/src/workspace/planner.ts";
import type { CuratedOperation, PreparedApiCall } from './types.ts';
import { executeGovernedRead, prepareApiCall, type ExecuteReadOptions } from './governed-transport.ts';
import { ALL_CURATED_OPERATIONS } from './index.ts';
import { validateParameterWithAjv } from './importer.ts';
import type { CacheContext, ProvenanceCache } from './provenance-cache.ts';
import { createJournaledPageExecutor } from './pagination-execution.ts';
import { executeGovernedPagination } from './pagination.ts';

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

export interface DispatcherOptions {
  catalog?: readonly CuratedOperation[];
  fetchFn?: typeof fetch;
  allowLoopbackForTesting?: boolean;
  cache?: Pick<ProvenanceCache,'get'|'put'>;
  /** Server-supplied revision/policy context; a changed catalog or policy never reuses older entries. */
  cacheContext?: CacheContext;
  principalId?: string;
  projectId?: string;
  resolveStepOutput?: (stepId: string, output: string, binding?: Extract<EffectRequest['arguments'][string], {kind: 'step_output'}>, request?: EffectRequest) => Promise<unknown> | unknown;
  /**
   * Server-owned journal binding for catalogued pagination. Required only when the
   * operation declares pagination metadata; the identity fields must match the
   * EffectRequest exactly, so this option can never retarget another run/step.
   */
  pagination?: {
    journal: RunJournal;
    principalId: string;
    projectId: string;
    runId: string;
    stepId: string;
    planDigest: string;
    maxPages?: number;
    fetchFn?: typeof fetch;
    allowLoopbackForTesting?: boolean;
  };
}

/**
 * Creates an EffectDispatcher that handles execution of approved API instruments.
 * Catalog binding verification (R03, C03). Resolves operation by capability ID,
 * reconstructs canonical URL from operation and approved parameters, validates with Ajv,
 * resolves step outputs for composed plans (C07), enforces limit hierarchy (C04),
 * and checks provenance cache (C09).
 */
export function createApiInstrumentDispatcher(options?: DispatcherOptions): EffectDispatcher {
  return {
    async dispatch(request: EffectRequest): Promise<EffectOutcome> {
      const capId = request.capability.id;
      if (!capId.startsWith('api.')) {
        return { kind: 'not_sent', code: 'unsupported_capability' };
      }

      // Check if binding has prepared call
      const preparedBinding = request.arguments.prepared_call;
      if (!preparedBinding || preparedBinding.kind !== 'literal') {
        return { kind: 'not_sent', code: 'missing_prepared_call' };
      }

      const prepared = JSON.parse(JSON.stringify(preparedBinding.value)) as PreparedApiCall;
      if (!prepared || prepared.schemaVersion !== 1 || !prepared.url || !prepared.origin) {
        return { kind: 'not_sent', code: 'invalid_prepared_call' };
      }

      // Catalog binding verification (R03, C03) - Catalog is mandatory
      const catalogMap = new Map<string, CuratedOperation>();
      const ops = (options?.catalog && options.catalog.length > 0) ? options.catalog : ALL_CURATED_OPERATIONS;
      for (const o of ops) {
        catalogMap.set(o.id, o);
      }

      const op = catalogMap.get(capId);
      if (!op) {
        return { kind: 'not_sent', code: 'unknown_capability' };
      }

      if (prepared.operationId !== op.operationId || prepared.serviceId !== op.serviceId) {
        return { kind: 'not_sent', code: 'catalog_operation_mismatch' };
      }

      if (prepared.origin !== op.serverUrl) {
        return { kind: 'not_sent', code: 'unadmitted_destination_origin' };
      }

      if (prepared.schemaDigest !== op.schemaDigest) {
        return { kind: 'not_sent', code: 'schema_digest_mismatch' };
      }

      if (request.capability.version !== op.capability.version || prepared.capabilityId !== op.id || prepared.method !== op.method) {
        return { kind: 'not_sent', code: 'catalog_operation_mismatch' };
      }
      // Reconstruct the signed original before permitting any dependent materialization.
      const raw: Record<string, unknown> = { ...prepared.query };
      const templateParts = op.path.split('/');
      const actualParts = (prepared.path || '').split('/');
      if (templateParts.length !== actualParts.length) return { kind: 'not_sent', code: 'url_tampered_or_unapproved' };
      try {
        for (let i = 0; i < templateParts.length; i++) {
          const part = templateParts[i]!;
          if (part.startsWith('{') && part.endsWith('}')) raw[part.slice(1, -1)] = decodeURIComponent(actualParts[i]!);
          else if (part !== actualParts[i]) return { kind: 'not_sent', code: 'url_tampered_or_unapproved' };
        }
        for (const parameter of op.parameters) {
          if (raw[parameter.name] === undefined) {
            if (parameter.required) return { kind: 'not_sent', code: 'missing_required_parameter' };
          } else validateParameterWithAjv(parameter.name, parameter.schema, raw[parameter.name]);
        }
        const original = prepareApiCall(op, raw, {allowLoopbackForTesting: options?.allowLoopbackForTesting});
        if (new URL(prepared.url).origin !== op.serverUrl) return { kind: 'not_sent', code: 'unadmitted_destination_origin' };
        if (prepared.url !== original.url || prepared.path !== original.path || canonicalStringify(prepared.query) !== canonicalStringify(original.query)) {
          return { kind: 'not_sent', code: 'url_tampered_or_unapproved' };
        }
        if (prepared.callDigest !== original.callDigest) return { kind: 'not_sent', code: 'call_digest_mismatch' };
        if (canonicalStringify(prepared.limits) !== canonicalStringify(original.limits)) return { kind: 'not_sent', code: 'api_invalid_limits' };
      } catch {
        return { kind: 'not_sent', code: 'api_invalid_parameter' };
      }
      const depBinding = request.arguments.dependent_input;
      if (depBinding) {
        if (depBinding.kind !== 'step_output' || !options?.resolveStepOutput || !depBinding.artifactRefs?.length) {
          return { kind: 'not_sent', code: 'missing_dependency_output' };
        }
        // The signed binding admits only these two numeric arguments of a weather operation.
        if (op.serviceId !== 'open_meteo' || !op.parameters.some(p => p.name === 'latitude') || !op.parameters.some(p => p.name === 'longitude')) {
          return { kind: 'not_sent', code: 'unadmitted_dependency_binding' };
        }
        try {
          const data = await options.resolveStepOutput(depBinding.stepId, depBinding.output, depBinding, request) as any;
          if (!Array.isArray(data) || data.length !== 1 || !Array.isArray(data[0]?.capitalInfo?.latlng) || data[0].capitalInfo.latlng.length !== 2) {
            return { kind: 'not_sent', code: 'invalid_dependency_output' };
          }
          const [latitude, longitude] = data[0].capitalInfo.latlng;
          if (typeof latitude !== 'number' || typeof longitude !== 'number' || !Number.isFinite(latitude) || !Number.isFinite(longitude)) {
            return { kind: 'not_sent', code: 'invalid_dependency_output' };
          }
          // prepareApiCall revalidates ranges and computes the URL and digest together.
          Object.assign(prepared, prepareApiCall(op, {...raw, latitude, longitude}, {allowLoopbackForTesting: options?.allowLoopbackForTesting}));
        } catch {
          return { kind: 'not_sent', code: 'invalid_dependency_output' };
        }
      }
      if (request.signal.aborted) return {kind: 'not_sent', code: 'api_cancelled'};
      if (!Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= Date.now()) return {kind: 'not_sent', code: 'api_deadline_exceeded'};
      for (const limits of [prepared.limits, request.limits, op.capability.limits]) {
        if (!limits || !Number.isFinite(limits.timeoutMs) || limits.timeoutMs <= 0 || !Number.isFinite(limits.maxOutputBytes) || limits.maxOutputBytes <= 0) {
          return {kind: 'not_sent', code: 'api_invalid_limits'};
        }
      }

      const effectiveTimeout = Math.min(
        prepared.limits?.timeoutMs ?? 15_000,
        request.limits?.timeoutMs ?? 15_000,
        op.capability.limits.timeoutMs ?? 15_000
      );
      const effectiveMaxBytes = Math.min(
        prepared.limits?.maxOutputBytes ?? 131_072,
        request.limits?.maxOutputBytes ?? 131_072,
        op.capability.limits.maxOutputBytes ?? 131_072
      );

      // Cache lookup (C09)
      if (options?.cache) {
        const cachedOutcome = options.cache.get(request.principalId, request.projectId, prepared, Date.now(), options.cacheContext);
        if (cachedOutcome && cachedOutcome.kind === 'completed') {
          const compactJson = JSON.stringify(cachedOutcome.data);
          const artifactBytes = new TextEncoder().encode(compactJson);
          
          if (artifactBytes.length <= effectiveMaxBytes) {
            return {
              kind: 'completed',
              artifacts: [
                {
                  artifactId: `api_result_${request.attemptId}`,
                  mediaType: 'application/json',
                  bytes: artifactBytes,
                },
              ],
              outputArtifactRefs: [`api_result_${request.attemptId}`],
              sources: [
                {
                  id: `source_${request.attemptId}`,
                  sourceId: prepared.serviceId,
                  externalId: prepared.url,
                  title: `${prepared.serviceId}: ${prepared.operationId} (cache local)`,
                  url: prepared.url,
                  retrievedAt: cachedOutcome.retrievedAt,
                },
              ],
            };
          }
        }
      }

      // Catalogued pagination: every page is admitted by the server-owned journal
      // executor (prepare → dispatched → settle) before any bytes leave the
      // process. The aggregate stays inside the same effective budget.
      if (op.pagination && options?.pagination) {
        const bound = options.pagination;
        if (bound.principalId !== request.principalId || bound.projectId !== request.projectId || bound.runId !== request.runId || bound.stepId !== request.stepId) {
          return {kind: 'not_sent', code: 'pagination_identity_mismatch'};
        }
        const pageBudget = options.pagination.maxPages ?? prepared.limits.maxCalls ?? 1;
        const basePrepared = {
          ...prepared,
          limits: {
            ...prepared.limits,
            maxCalls: Math.min(prepared.limits.maxCalls ?? pageBudget, pageBudget, op.capability.limits.maxCalls ?? pageBudget),
            timeoutMs: effectiveTimeout,
            maxOutputBytes: effectiveMaxBytes,
          },
        };
        const executePage = createJournaledPageExecutor({
          journal: bound.journal,
          principalId: bound.principalId,
          projectId: bound.projectId,
          runId: bound.runId,
          stepId: bound.stepId,
          planDigest: bound.planDigest,
          capability: {id: request.capability.id, version: request.capability.version},
          fetchFn: bound.fetchFn ?? options.fetchFn,
          allowLoopbackForTesting: bound.allowLoopbackForTesting ?? options.allowLoopbackForTesting,
        });
        const paginated = await executeGovernedPagination(op, basePrepared, {
          maxPages: pageBudget,
          signal: request.signal,
          deadlineAt: request.deadlineAt,
          executePage: (page, context) => executePage(page, context),
        });
        if (paginated.reason === 'cancelled' || paginated.reason === 'timeout' || paginated.reason === 'error') {
          const pagesSent = paginated.receipts.some(receipt => receipt.status === 'completed');
          const code = paginated.error ?? `pagination_${paginated.reason}`;
          // Nothing left the process: still safe for a bounded retry. Otherwise the
          // step failed after real pages were admitted/answered; never claim success.
          return pagesSent
            ? {kind: 'failed', code, sent: 'unknown'}
            : {kind: 'not_sent', code};
        }
        const aggregate = {
          pages: paginated.pages,
          pageCount: paginated.pageCount,
          totalBytes: paginated.totalBytes,
          complete: paginated.reason === 'completed',
          reason: paginated.reason,
          receipts: paginated.receipts,
        };
        const aggregateBytes = new TextEncoder().encode(JSON.stringify(aggregate));
        if (aggregateBytes.byteLength > effectiveMaxBytes) {
          return {kind: 'failed', code: 'api_response_too_large', sent: 'yes'};
        }
        let retrievedAt = new Date().toISOString();
        for (let index = paginated.receipts.length - 1; index >= 0; index -= 1) {
          const receipt = paginated.receipts[index]!;
          if (receipt.retrievedAt) { retrievedAt = receipt.retrievedAt; break; }
        }
        const artifactId = `api_result_${request.attemptId}`;
        const outcome = {
          kind: 'completed' as const,
          artifacts: [{artifactId, mediaType: 'application/json' as const, bytes: aggregateBytes}],
          outputArtifactRefs: [artifactId],
          sources: paginated.receipts.map(receipt => ({
            id: `source_page_${receipt.receiptId}`,
            sourceId: prepared.serviceId,
            externalId: prepared.url,
            title: `${prepared.serviceId}: ${prepared.operationId} (page ${receipt.pageIndex})`,
            url: prepared.url,
            retrievedAt: receipt.retrievedAt ?? retrievedAt,
          })),
        };
        // A partial aggregate is never cached: a later read must be able to reach
        // the endpoint's explicit end marker instead of replaying a truncated list.
        if (options?.cache && paginated.reason === 'completed') {
          options.cache.put(request.principalId, request.projectId, prepared, {
            kind: 'completed',
            data: aggregate,
            origin: prepared.origin,
            operation: prepared.operationId,
            retrievedAt,
            byteLength: aggregateBytes.byteLength,
          }, undefined, Date.now(), options.cacheContext);
        }
        return outcome;
      }

      // Execute governed read with strict streaming boundaries and bounded limits.
      // Learned operations (stage 18) carry their recipe-scoped origin admission
      // from the server-side recipe record; every other guard still applies.
      const readOutcome = await executeGovernedRead(
        {
          ...prepared,
          limits: {
            ...prepared.limits,
            timeoutMs: effectiveTimeout,
            maxOutputBytes: effectiveMaxBytes,
          },
        },
        {
          signal: request.signal,
          deadlineAt: request.deadlineAt,
          fetchFn: options?.fetchFn,
          statusResult: op.statusResult,
          allowLoopbackForTesting: options?.allowLoopbackForTesting,
          // Feed operations (arXiv/RSS/Atom): the catalog-declared format must
          // reach the transport so XML MIME is admitted and parsed as feed text
          // instead of being rejected as api_invalid_mime.
          ...(op.responseFormat ? { responseFormat: op.responseFormat } : {}),
          ...(op.learnedRecipe ? { admittedOrigins: [op.serverUrl] } : {}),
        }
      );

      if (readOutcome.kind === 'failed') {
        if (readOutcome.sent === 'no') {
          return {
            kind: 'not_sent',
            code: readOutcome.code,
          };
        }
        return {
          kind: 'failed',
          code: readOutcome.code,
          sent: readOutcome.sent === 'yes' ? 'yes' : 'unknown',
        };
      }

      // Record in cache if enabled (C09)
      if (options?.cache) {
        options.cache.put(request.principalId, request.projectId, prepared, readOutcome, undefined, Date.now(), options.cacheContext);
      }

      // Limit artifact serialization byte size (C04: no unconstrained formatted expansion)
      const compactJson = JSON.stringify(readOutcome.data);
      const artifactBytes = new TextEncoder().encode(compactJson);

      if (artifactBytes.byteLength > effectiveMaxBytes) {
        return {
          kind: 'failed',
          code: 'api_response_too_large',
          sent: 'yes',
        };
      }

      const artifactId = `api_result_${request.attemptId}`;
      const sourceId = `source_${request.attemptId}`;

      return {
        kind: 'completed',
        artifacts: [
          {
            artifactId,
            mediaType: 'application/json',
            bytes: artifactBytes,
          },
        ],
        outputArtifactRefs: [artifactId],
        sources: [
          {
            id: sourceId,
            sourceId: prepared.serviceId,
            externalId: prepared.url,
            title: `${prepared.serviceId}: ${prepared.operationId}`,
            url: prepared.url,
            retrievedAt: readOutcome.retrievedAt,
          },
        ],
      };
    },
  };
}

/**
 * Prepares a provisional ExecutionPlan and ContextSnapshot for an API instrument in WorkspaceStore.
 * STORES PLAN AND SNAPSHOT ONLY. DOES NOT GRANT OR APPROVE! (R01)
 */
export async function createProvisionalApiInstrumentPlan(
  store: WorkspaceStore,
  principalId: string,
  projectId: string,
  operation: CuratedOperation,
  prepared: PreparedApiCall
): Promise<{
  plan: ExecutionPlan;
  snapshot: ContextSnapshot;
}> {
  const bundle = await store.getBundle(principalId, projectId);
  const project = bundle.project;

  // Create isolated ContextSnapshot
  const snapshot = await store.snapshotContext(principalId, projectId, {
    selectedEntryIds: [],
    selectedArtifactIds: [],
    excludedEntryIds: project.entries.map(e => e.id),
    allowedDestinations: [operation.capability.dataDestination],
    maxContextBytes: 32_000,
  });

  const snapshotDigest = sha256Hex(canonicalContextSnapshotPayload(snapshot));
  const planId = randomUUID();
  const createdAt = new Date().toISOString();

  let plan: ExecutionPlan = {
    schemaVersion: 1,
    id: planId,
    createdAt,
    projectId,
    projectRevision: project.revision,
    contextSnapshotId: snapshot.id,
    contextSnapshotDigest: snapshotDigest,
    steps: [
      {
        id: 'execute_api_read',
        capabilityId: operation.id,
        capabilityVersion: operation.capability.version,
        arguments: {
          prepared_call: {
            kind: 'literal',
            value: JSON.parse(JSON.stringify(prepared)),
          },
        },
      },
    ],
    limits: { ...operation.capability.limits },
    digest: '0'.repeat(64),
  };

  plan = { ...plan, digest: computePlanDigest(plan) };
  plan = parseExecutionPlan(plan);

  // Validate bindings against capability
  validatePlanBindings(plan, snapshot, [operation.capability]);

  // Persist plan in store (provisional, unapproved)
  await store.putPlan(principalId, plan, snapshot);

  return { plan, snapshot };
}

/**
 * Consent verification options for W5 plan authorization.
 */
export interface PlanConsentVerificationOptions {
  expiresInMs?: number;
  consentService?: {
    consume(
      binding: {
        principalId: string;
        projectId: string;
        planId: string;
        planDigest: string;
      },
      challengeId: string,
      signature: string
    ): void;
  };
  consentChallengeId?: string;
  consentSignature?: string;
}

/**
 * Explicitly approves an ExecutionPlan and grants necessary scopes in WorkspaceStore.
 * Separated from preparation to require deliberate authorization (R01, R02, C01).
 * Verifies W5 consent challenge/signature when consentService is provided.
 */
export async function approveApiInstrumentPlan(
  store: WorkspaceStore,
  principalId: string,
  projectId: string,
  plan: ExecutionPlan,
  operation: CuratedOperation,
  options: PlanConsentVerificationOptions
): Promise<{
  approval: PlanApproval;
  grant: ProjectGrant;
}> {
  const storedPlan = await store.getPlan(principalId, projectId, plan.id);
  if (!storedPlan || storedPlan.digest !== plan.digest || computePlanDigest(plan) !== plan.digest || plan.projectId !== projectId || plan.steps.some(step => step.capabilityId !== operation.id)) throw new Error('consent_invalid');
  // W5 consent is enforced and required for production endpoints
  if (!options || !options.consentService || !options.consentChallengeId || !options.consentSignature) {
    throw new Error('consent_invalid');
  }
  options.consentService.consume(
    {
      principalId,
      projectId,
      planId: plan.id,
      planDigest: plan.digest,
    },
    options.consentChallengeId,
    options.consentSignature
  );

  const createdAt = new Date().toISOString();
  const expiresInMs = options?.expiresInMs ?? 3_600_000;
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

  const approvalId = randomUUID();
  const approval = parsePlanApproval({
    id: approvalId,
    projectId,
    planId: plan.id,
    planDigest: plan.digest,
    principalId,
    destinations: [operation.capability.dataDestination],
    expiresAt,
    consumedByRunId: null,
  });

  await store.putApprovalOccupancy(principalId, projectId, approval);

  // Authorize grant for principal on this project
  const existingGrant = await store.getGrant(principalId, projectId, principalId);
  let grant: ProjectGrant;
  if (!existingGrant) {
    const grantId = randomUUID();
    grant = parseProjectGrant({
      schemaVersion: 1,
      id: grantId,
      createdAt,
      principalId,
      projectId,
      revision: 1,
      scopes: ['run:execute'],
      capabilityIds: [operation.id],
      destinations: [operation.capability.dataDestination],
      limits: { ...operation.capability.limits },
      expiresAt,
      revokedAt: null,
    });
    await store.putGrant(principalId, grant);
  } else {
    const capIds = Array.from(new Set([...existingGrant.capabilityIds, operation.id]));
    const dests = Array.from(
      new Set([
        ...existingGrant.destinations.map(d => JSON.stringify(d)),
        JSON.stringify(operation.capability.dataDestination),
      ])
    ).map(s => JSON.parse(s));

    grant = parseProjectGrant({
      ...existingGrant,
      revision: existingGrant.revision + 1,
      capabilityIds: capIds,
      destinations: dests,
      expiresAt: existingGrant.expiresAt > expiresAt ? existingGrant.expiresAt : expiresAt,
    });
    await store.putGrant(principalId, grant);
  }

  return { approval, grant };
}

/**
 * Test helper combining provisional plan creation and explicit approval.
 * FOR UNIT TEST SUITES ONLY.
 */
export async function createApprovedApiInstrumentPlan(
  store: WorkspaceStore, principalId: string, projectId: string,
  operation: CuratedOperation, prepared: PreparedApiCall
): Promise<{plan: ExecutionPlan; approval: PlanApproval}> {
  // Cannot sign a plan before it exists: callers should use the provisional + W5 path.
  // Kept only as a rejecting compatibility boundary; never auto-grants.
  throw new Error('use_provisional_plan_and_w5_consent');
}

export interface ComposedStepConfig {
  stepId: string;
  operation: CuratedOperation;
  prepared: PreparedApiCall;
  dependencyStepId?: string;
}

/**
 * Creates a provisional composed plan chaining multiple read operations with step output dependencies.
 * Stores plan and snapshot in WorkspaceStore ONLY. Zero approvals, zero grants created (C01).
 * Requires explicit call to approveComposedApiInstrumentPlan to authorize execution.
 */
export async function createProvisionalComposedApiInstrumentPlan(
  store: WorkspaceStore,
  principalId: string,
  projectId: string,
  stepConfigs: ComposedStepConfig[]
): Promise<{
  plan: ExecutionPlan;
  snapshot: ContextSnapshot;
}> {
  if (stepConfigs.length < 1 || stepConfigs.length > 12 || new Set(stepConfigs.map(s => s.stepId)).size !== stepConfigs.length) throw new Error('invalid_composed_steps');
  for (let i = 0; i < stepConfigs.length; i++) {
    const config = stepConfigs[i]!;
    if (!config.dependencyStepId) continue;
    const prior = stepConfigs.slice(0, i).find(item => item.stepId === config.dependencyStepId);
    if (!prior || prior.operation.serviceId !== 'rest_countries' || config.operation.serviceId !== 'open_meteo' || !config.operation.parameters.some(p => p.name === 'latitude') || !config.operation.parameters.some(p => p.name === 'longitude')) {
      throw new Error('unadmitted_dependency_binding');
    }
  }
  const bundle = await store.getBundle(principalId, projectId);
  const project = bundle.project;

  const allDestinations = Array.from(
    new Set(stepConfigs.map(c => JSON.stringify(c.operation.capability.dataDestination)))
  ).map(s => JSON.parse(s));

  const snapshot = await store.snapshotContext(principalId, projectId, {
    selectedEntryIds: [],
    selectedArtifactIds: [],
    excludedEntryIds: project.entries.map(e => e.id),
    allowedDestinations: allDestinations,
    maxContextBytes: 64_000,
  });

  const snapshotDigest = sha256Hex(canonicalContextSnapshotPayload(snapshot));
  const planId = randomUUID();
  const createdAt = new Date().toISOString();

  // Aggregate limits
  const maxSteps = stepConfigs.length;
  const maxCalls = stepConfigs.length;
  const timeoutMs = stepConfigs.reduce((acc, c) => acc + (c.operation.capability.limits.timeoutMs || 15_000), 0);
  const maxOutputBytes = stepConfigs.reduce((acc, c) => acc + (c.operation.capability.limits.maxOutputBytes || 131_072), 0);

  const steps = stepConfigs.map(config => {
    const args: Record<string, any> = {
      prepared_call: {
        kind: 'literal',
        value: JSON.parse(JSON.stringify(config.prepared)),
      },
    };

    if (config.dependencyStepId) {
      args['dependent_input'] = {
        kind: 'step_output',
        stepId: config.dependencyStepId,
        output: 'api_result',
      };
    }

    return {
      id: config.stepId,
      capabilityId: config.operation.id,
      capabilityVersion: config.operation.capability.version,
      arguments: args,
    };
  });

  let plan: ExecutionPlan = {
    schemaVersion: 1,
    id: planId,
    createdAt,
    projectId,
    projectRevision: project.revision,
    contextSnapshotId: snapshot.id,
    contextSnapshotDigest: snapshotDigest,
    steps,
    limits: {
      maxSteps,
      maxCalls,
      maxOutputTokens: 4096,
      timeoutMs,
      maxOutputBytes,
    },
    digest: '0'.repeat(64),
  };

  plan = { ...plan, digest: computePlanDigest(plan) };
  plan = parseExecutionPlan(plan);

  validatePlanBindings(
    plan,
    snapshot,
    stepConfigs.map(c => c.operation.capability)
  );

  await store.putPlan(principalId, plan, snapshot);

  return { plan, snapshot };
}

/**
 * Explicitly approves a composed ExecutionPlan with all involved capabilities and destinations (C01).
 * Verifies W5 consent challenge/signature when consentService is provided.
 */
export async function approveComposedApiInstrumentPlan(
  store: WorkspaceStore,
  principalId: string,
  projectId: string,
  plan: ExecutionPlan,
  stepConfigs: ComposedStepConfig[],
  options: PlanConsentVerificationOptions
): Promise<{
  approval: PlanApproval;
  grant: ProjectGrant;
}> {
  const storedPlan = await store.getPlan(principalId, projectId, plan.id);
  if (!storedPlan || storedPlan.digest !== plan.digest || computePlanDigest(plan) !== plan.digest || plan.projectId !== projectId || plan.steps.some(step => step.capabilityId !== stepConfigs.find(config => config.stepId === step.id)?.operation.id)) throw new Error('consent_invalid');
  // W5 consent is enforced and required for production endpoints
  if (!options || !options.consentService || !options.consentChallengeId || !options.consentSignature) {
    throw new Error('consent_invalid');
  }
  options.consentService.consume(
    {
      principalId,
      projectId,
      planId: plan.id,
      planDigest: plan.digest,
    },
    options.consentChallengeId,
    options.consentSignature
  );

  const createdAt = new Date().toISOString();
  const expiresInMs = options?.expiresInMs ?? 3_600_000;
  const expiresAt = new Date(Date.now() + expiresInMs).toISOString();

  const allDestinations = Array.from(
    new Set(stepConfigs.map(c => JSON.stringify(c.operation.capability.dataDestination)))
  ).map(s => JSON.parse(s));

  const approval = parsePlanApproval({
    id: randomUUID(),
    projectId,
    planId: plan.id,
    planDigest: plan.digest,
    principalId,
    destinations: allDestinations,
    expiresAt,
    consumedByRunId: null,
  });

  await store.putApprovalOccupancy(principalId, projectId, approval);

  const grant = parseProjectGrant({
    schemaVersion: 1,
    id: randomUUID(),
    createdAt,
    principalId,
    projectId,
    revision: 1,
    scopes: ['run:execute'],
    capabilityIds: Array.from(new Set(stepConfigs.map(c => c.operation.id))),
    destinations: allDestinations,
    limits: { ...plan.limits },
    expiresAt,
    revokedAt: null,
  });
  await store.putGrant(principalId, grant);

  return { approval, grant };
}

/**
 * Creates and immediately approves a composed plan.
 * Provided for compatibility and multi-step test suites.
 */
export async function createComposedApiInstrumentPlan(
  store: WorkspaceStore, principalId: string, projectId: string,
  stepConfigs: ComposedStepConfig[]
): Promise<{plan: ExecutionPlan; approval: PlanApproval; grant: ProjectGrant}> {
  throw new Error('use_provisional_plan_and_w5_consent');
}

/**
 * Creates a PolicyEnvironment configured for API instrument capabilities.
 * Enforces principal active status, grant expiration, grant revocation, and offline access gates (C16).
 */
export function createApiInstrumentPolicyEnvironment(
  store: WorkspaceStore,
  ownerPrincipalId: string,
  capabilities: readonly CapabilityDescriptor[],
  options?: {
    getPolicyRevision?: () => Promise<number> | number;
    revokedPrincipals?: Set<string> | string[];
    isOffline?: boolean | (() => boolean);
  }
): PolicyEnvironment {
  const capMap = new Map<string, CapabilityDescriptor>();
  for (const cap of capabilities) {
    capMap.set(`${cap.id}@${cap.version}`, cap);
  }

  return {
    isPrincipalActive: async (principalId: string) => {
      if (options?.revokedPrincipals) {
        const set = Array.isArray(options.revokedPrincipals)
          ? new Set(options.revokedPrincipals)
          : options.revokedPrincipals;
        if (set.has(principalId)) return false;
      }
      return principalId === ownerPrincipalId;
    },
    accessGate: async () => {
      const offline = typeof options?.isOffline === 'function' ? options.isOffline() : !!options?.isOffline;
      if (offline) return { allowed: false, code: 'offline_mode' };
      return { allowed: true };
    },
    loadGrant: async (principalId: string, projectId: string) => {
      const grant = (await store.getGrant(ownerPrincipalId, projectId, principalId)) ?? null;
      if (!grant) return null;
      if (grant.revokedAt && new Date(grant.revokedAt).getTime() <= Date.now()) {
        return null;
      }
      if (new Date(grant.expiresAt).getTime() <= Date.now()) {
        return null;
      }
      return grant;
    },
    loadPlan: async (projectId: string, planId: string) => {
      return (await store.getPlan(ownerPrincipalId, projectId, planId)) ?? null;
    },
    resolveCapability: async (id: string, version: number) => {
      return capMap.get(`${id}@${version}`) ?? null;
    },
    policyRevision: async () => (options?.getPolicyRevision ? options.getPolicyRevision() : 1),
  };
}
