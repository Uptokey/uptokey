/**
 * Productivity dispatcher: single governed write path + authenticated reads (etapa 15).
 *
 * Approval binds plan digest + preview digest + account. The dispatcher re-verifies every
 * binding, checks grant scopes, resolves the vault bearer, and dispatches exactly once per
 * admitted attempt with a stable idempotency key. No automatic retries (W0 forces
 * never_automatic for write_external); uncertain outcomes reconcile via status query,
 * never via resend.
 */
import { createHash } from 'node:crypto';
import type {ExecutionPlan} from '@uptokey/sync-contract/workflow';
import type { EffectDispatcher, EffectOutcome, EffectRequest } from "../../../../core/src/workspace/executor.ts";
import { canonicalStringify } from '../importer.ts';
import { verifyPreparedProductivityCall, type PreparedProductivityCall, type ProductivityOperation } from './operations.ts';
import { sendProductivityCall } from './transport.ts';

export interface ProductivityCredential {
  token: string;
  accountId: string;
}

export interface ProductivityGrant {
  scopes: readonly string[];
}

export interface ProductivityAdmission {
  running: boolean;
  planDigest: string;
  planMaxOutputBytes: number;
  stepArguments: ExecutionPlan['steps'][number]['arguments'];
}

export interface ProductivityDispatcherOptions {
  operations: readonly ProductivityOperation[];
  fetchFn?: typeof fetch;
  /** Vault resolution at dispatch; null means no credential (fail closed, zero network). */
  getBearer: (accountId: string, request:EffectRequest, operation:ProductivityOperation) => Promise<ProductivityCredential | null>;
  verifyPrepared?: (prepared:PreparedProductivityCall)=>ProductivityOperation;
  /** Grant lookup against the durable store; null denies. */
  getGrant: (principalId: string, projectId: string) => Promise<ProductivityGrant | null>;
  /** Run/plan/step/admission lookup against the durable store; null denies. */
  getAdmission: (principalId: string, projectId: string, runId: string, stepId: string, attemptId: string) => Promise<ProductivityAdmission | null>;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

export function createProductivityDispatcher(options: ProductivityDispatcherOptions): EffectDispatcher {
  return {
    async dispatch(request: EffectRequest): Promise<EffectOutcome> {
      const op = options.operations.find((item) => item.id === request.capability.id);
      if (!op) return { kind: 'not_sent', code: 'productivity_unknown_capability' };
      const write = op.effectClass === 'escrita_externa';

      const binding = request.arguments.prepared_write ?? request.arguments.prepared_call;
      if (!binding || binding.kind !== 'literal') return { kind: 'not_sent', code: 'productivity_missing_prepared_call' };
      const prepared = JSON.parse(JSON.stringify(binding.value)) as PreparedProductivityCall;
      try {
        const verified = (options.verifyPrepared??verifyPreparedProductivityCall)(prepared);
        if (verified.id !== op.id) return { kind: 'not_sent', code: 'productivity_operation_mismatch' };
      } catch {
        return { kind: 'not_sent', code: 'productivity_binding_changed' };
      }

      // Scope gate before any network: writes need project:write, reads project:read.
      let grant: ProductivityGrant | null;
      try {
        grant = await options.getGrant(request.principalId, request.projectId);
      } catch {
        return { kind: 'not_sent', code: 'productivity_scope_insufficient' };
      }
      const needed = write ? ['run:execute', 'project:write'] : ['run:execute', 'project:read'];
      if (!grant || !needed.every((scope) => grant.scopes.includes(scope))) {
        return { kind: 'not_sent', code: 'productivity_scope_insufficient' };
      }

      let admission: ProductivityAdmission | null;
      try {
        admission = await options.getAdmission(request.principalId, request.projectId, request.runId, request.stepId, request.attemptId);
      } catch {
        return { kind: 'not_sent', code: 'productivity_admission_required' };
      }
      if (!admission || !admission.running) return { kind: 'not_sent', code: 'productivity_admission_required' };
      if (write) {
        const previewBinding = admission.stepArguments.preview;
        if (!previewBinding || previewBinding.kind !== 'literal' ||
          (previewBinding.value as { previewDigest?: unknown }).previewDigest !== prepared.previewDigest) {
          return { kind: 'not_sent', code: 'productivity_preview_changed' };
        }
      }
      for (const [name, stepBinding] of Object.entries(admission.stepArguments)) {
        const resolved = request.arguments[name];
        if (!resolved || resolved.kind !== stepBinding.kind ||
          (stepBinding.kind === 'literal' && canonicalStringify(resolved) !== canonicalStringify(stepBinding))) {
          return { kind: 'not_sent', code: 'productivity_argument_binding_mismatch' };
        }
      }

      // Credential + account binding: the bearer account must equal the approved account.
      let credential: ProductivityCredential | null;
      try {
        credential = await options.getBearer(prepared.accountId,request,op);
      } catch {
        return { kind: 'not_sent', code: 'productivity_credential_missing' };
      }
      if (!credential || !credential.token) {
        return { kind: 'not_sent', code: 'productivity_credential_missing' };
      }
      if (credential.accountId !== prepared.accountId) {
        return { kind: 'not_sent', code: 'productivity_account_mismatch' };
      }

      if (request.signal.aborted) return { kind: 'not_sent', code: 'productivity_cancelled' };
      if (!Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= Date.now()) {
        return { kind: 'not_sent', code: 'productivity_deadline_exceeded' };
      }
      const remaining = Math.min(request.limits.maxOutputBytes, admission.planMaxOutputBytes);
      if (!Number.isSafeInteger(remaining) || remaining <= 0) return { kind: 'not_sent', code: 'productivity_limits_invalid' };

      const idempotencyKey = write&&op.idempotencySupport==='key' ? sha256Hex(canonicalStringify([admission.planDigest, request.attemptId, prepared.callDigest])) : undefined;
      const outcome = await sendProductivityCall(prepared, {
        fetchFn: options.fetchFn,
        signal: request.signal,
        deadlineAt: request.deadlineAt,
        bearer: credential.token,
        idempotencyKey,
        maxOutputBytes: remaining,
        allowedOrigin:op.serverUrl,
      });
      if (outcome.kind === 'failed') {
        if (outcome.sent === 'no') return { kind: 'not_sent', code: outcome.code };
        return { kind: 'failed', code: outcome.code, sent: outcome.sent };
      }
      const artifactId = `api_result_${request.attemptId}`;
      const bytes = new TextEncoder().encode(JSON.stringify(outcome.data));
      const data = outcome.data as { id?: unknown };
      const externalId = typeof data.id === 'string' ? data.id : prepared.url;
      return {
        kind: 'completed',
        artifacts: [{ artifactId, mediaType: 'application/json', bytes }],
        outputArtifactRefs: [artifactId],
        sources: [{
          id: `source_${request.attemptId}`,
          sourceId: prepared.serviceId,
          externalId,
          title: `${prepared.serviceId}: ${prepared.operationId}`,
          url: prepared.url,
          retrievedAt: new Date().toISOString(),
        }],
      };
    },
  };
}
