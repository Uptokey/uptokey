/**
 * Productivity operations: curated descriptors + governed preparation (etapa 15).
 *
 * Reads reuse the exact governed shape of the instruments layer; writes add a strict
 * body contract, an exact effect preview and an approval binding. Secrets never appear
 * in prepared calls, previews, plans or errors — the bearer reaches only the transport
 * at dispatch time.
 */
import { createHash } from 'node:crypto';
import { parseCapabilityDescriptor, type CapabilityDescriptor } from '@uptokey/sync-contract/workflow';
import { canonicalStringify } from '../importer.ts';
import {
  PROD_TASKS_METADATA,
  PROD_TASKS_OPERATIONS,
  PROD_TASKS_REVISION,
  PROD_TASKS_SERVER_URL,
  type ProdTasksOperationSpec,
} from './tasks-spec.ts';

export const PROD_TASKS_SERVICE_ID = 'prod_tasks';
export const PROD_TASKS_CAPABILITY_PREFIX = 'api.prod_tasks.';
/** Write retry class is forced by the W0 contract: write_external requires never_automatic. */
const WRITE_RETRY = 'never_automatic' as const;

export interface ProductivityOperation {
  schemaVersion: 1;
  id: string;
  serviceId: string;
  operationId: string;
  method: 'GET' | 'POST';
  path: string;
  serverUrl: string;
  summary: string;
  schemaDigest: string;
  documentDigest: string;
  effectClass: 'leitura' | 'rascunho_local' | 'escrita_externa';
  idempotencySupport: 'none' | 'key';
  reconciliationSupport: 'status_query' | 'none';
  requiredScopes: readonly ('run:execute' | 'project:read' | 'project:write')[];
  authMethod: 'bearer_vault';
  capability: CapabilityDescriptor;
}

export interface PreparedProductivityCall {
  schemaVersion: 1;
  operationId: string;
  capabilityId: string;
  serviceId: string;
  method: 'GET' | 'POST';
  url: string;
  origin: string;
  path: string;
  query: Record<string, string>;
  /** POST body only; absent for reads. Never carries secrets. */
  body?: Record<string, unknown>;
  accountId: string;
  previewDigest: string;
  callDigest: string;
  limits: { timeoutMs: number; maxOutputBytes: number };
}

export class ProductivityValidationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ProductivityValidationError';
    this.code = code;
  }
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

const BASE_LIMITS = { timeoutMs: 15_000, maxOutputBytes: 131_072 };

function capabilityFor(spec: ProdTasksOperationSpec): CapabilityDescriptor {
  const write = spec.effectClass === 'escrita_externa';
  return parseCapabilityDescriptor({
    schemaVersion: 1,
    id: `${PROD_TASKS_CAPABILITY_PREFIX}${spec.operationId}`,
    createdAt: '2026-09-19T00:00:00.000Z',
    version: 1,
    titleKey: `prod_tasks_${spec.operationId}_title`,
    descriptionKey: `prod_tasks_${spec.operationId}_description`,
    tags: ['productivity', 'tasks', 'fixture'],
    inputSchemaId: `prod_tasks.${spec.operationId}.input.v1`,
    outputSchemaId: `prod_tasks.${spec.operationId}.output.v1`,
    effect: write ? 'write_external' : 'read_external',
    dataDestination: { kind: 'provider', id: 'prod-tasks-fixture' },
    availability: 'executable',
    supportLevel: 'experimental',
    requiredScopes: write ? ['run:execute', 'project:write'] : ['run:execute', 'project:read'],
    retryClass: write ? WRITE_RETRY : 'read_only',
    limits: { maxSteps: 1, maxCalls: 1, maxOutputTokens: 512, ...BASE_LIMITS },
  });
}

function digestsFor(spec: ProdTasksOperationSpec): { schemaDigest: string; documentDigest: string } {
  const schemaDigest = sha256Hex(canonicalStringify({
    service: PROD_TASKS_SERVICE_ID, revision: PROD_TASKS_REVISION,
    operation: spec.operationId, method: spec.method, path: spec.path,
    effectClass: spec.effectClass, idempotency: spec.idempotencySupport,
  }));
  const documentDigest = sha256Hex(canonicalStringify({ ...PROD_TASKS_METADATA, revision: PROD_TASKS_REVISION }));
  return { schemaDigest, documentDigest };
}

export const PROD_TASKS_OPERATIONS_FULL: readonly ProductivityOperation[] = PROD_TASKS_OPERATIONS.map((spec) => ({
  schemaVersion: 1 as const,
  id: `${PROD_TASKS_CAPABILITY_PREFIX}${spec.operationId}`,
  serviceId: PROD_TASKS_SERVICE_ID,
  operationId: spec.operationId,
  method: spec.method,
  path: spec.path,
  serverUrl: PROD_TASKS_SERVER_URL,
  summary: spec.summary,
  ...digestsFor(spec),
  effectClass: spec.effectClass,
  idempotencySupport: spec.idempotencySupport,
  reconciliationSupport: spec.reconciliationSupport,
  requiredScopes: spec.effectClass === 'escrita_externa' ? ['run:execute', 'project:write'] : ['run:execute', 'project:read'],
  authMethod: 'bearer_vault' as const,
  capability: capabilityFor(spec),
}));

export function getProductivityOperation(operationId: string): ProductivityOperation {
  const op = PROD_TASKS_OPERATIONS_FULL.find((item) => item.operationId === operationId);
  if (!op) throw new ProductivityValidationError('unknown_operation', `operation ${operationId} is not admitted`);
  return op;
}

const TITLE_MAX = 200;
const NOTES_MAX = 2000;
const ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

export interface CreateTaskParams {
  accountId: unknown;
  title: unknown;
  notes?: unknown;
  dueDate?: unknown;
}

function invalid(code: string, message: string): never {
  throw new ProductivityValidationError(code, message);
}

/** Strict body contract for create_task. Unknown fields, wrong types and hostile shapes fail closed. */
export function parseCreateTaskBody(input: unknown): { title: string; notes?: string; dueDate?: string } {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('body_invalid', 'body must be an object');
  const record = input as Record<string, unknown>;
  const keys = Object.keys(record).sort().join(',');
  if (keys !== 'accountId,title' && keys !== 'accountId,notes,title' && keys !== 'accountId,dueDate,title' && keys !== 'accountId,dueDate,notes,title') {
    invalid('unexpected_argument', `admitted keys are accountId/title/notes/dueDate, got: ${keys || '(none)'}`);
  }
  if (typeof record.accountId !== 'string' || !ID_PATTERN.test(record.accountId)) invalid('account_invalid', 'accountId must be [A-Za-z0-9_-]{1,64}');
  if (typeof record.title !== 'string' || !record.title.trim() || record.title.length > TITLE_MAX) invalid('title_invalid', 'title must be 1..200 chars');
  const body: { title: string; notes?: string; dueDate?: string } = { title: record.title.trim() };
  if (record.notes !== undefined) {
    if (typeof record.notes !== 'string' || record.notes.length > NOTES_MAX) invalid('notes_invalid', 'notes must be a string up to 2000 chars');
    body.notes = record.notes;
  }
  if (record.dueDate !== undefined) {
    if (typeof record.dueDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(record.dueDate) || !Number.isFinite(Date.parse(record.dueDate))) {
      invalid('due_date_invalid', 'dueDate must be YYYY-MM-DD');
    }
    body.dueDate = record.dueDate;
  }
  return body;
}

export function parseAccountId(input: unknown): string {
  if (typeof input !== 'string' || !ID_PATTERN.test(input)) invalid('account_invalid', 'accountId must be [A-Za-z0-9_-]{1,64}');
  return input;
}

export interface EffectPreview {
  schemaVersion: 1;
  serviceId: string;
  operationId: string;
  accountId: string;
  action: string;
  object: string;
  fields: Record<string, unknown>;
  irreversibility: 'reversible_by_delete' | 'irreversible_no_rollback';
  cost: 'unknown';
  previewDigest: string;
}

/**
 * Exact effect preview (rascunho local, zero rede). The digest binds account, action,
 * object, fields and irreversibility; any change invalidates a prior approval.
 */
export function buildEffectPreview(operationId: 'create_task', params: { accountId: string; body: Record<string, unknown> }): EffectPreview {
  const op = getProductivityOperation(operationId);
  const preview = {
    schemaVersion: 1 as const,
    serviceId: op.serviceId,
    operationId: op.operationId,
    accountId: params.accountId,
    action: 'create_task',
    object: 'task',
    fields: { ...params.body },
    irreversibility: 'irreversible_no_rollback' as const,
    cost: 'unknown' as const,
  };
  return { ...preview, previewDigest: sha256Hex(canonicalStringify(preview)) };
}

/**
 * Governed preparation. Reads produce url+query; writes additionally bind body, account
 * and preview digest. Zero network. Secrets never included.
 */
export function prepareProductivityCall(
  operationId: 'list_tasks' | 'get_task' | 'create_task',
  params: Record<string, unknown>,
): PreparedProductivityCall {
  const op = getProductivityOperation(operationId);
  if (operationId === 'list_tasks') {
    if (Object.keys(params).sort().join(',') !== 'accountId') invalid('unexpected_argument', 'list_tasks admits only accountId');
    const accountId = parseAccountId(params.accountId);
    const url = `${op.serverUrl}/v1/tasks`;
    return {
      schemaVersion: 1, operationId: op.operationId, capabilityId: op.id, serviceId: op.serviceId,
      method: 'GET', url, origin: op.serverUrl, path: '/v1/tasks', query: {},
      accountId, previewDigest: 'none_read',
      callDigest: sha256Hex(canonicalStringify({ op: op.operationId, url, account: accountId })),
      limits: { ...BASE_LIMITS },
    };
  }
  if (operationId === 'get_task') {
    if (Object.keys(params).sort().join(',') !== 'accountId,id') invalid('unexpected_argument', 'get_task admits only accountId/id');
    const accountId = parseAccountId(params.accountId);
    if (typeof params.id !== 'string' || !ID_PATTERN.test(params.id)) invalid('id_invalid', 'id must be [A-Za-z0-9_-]{1,64}');
    const path = `/v1/tasks/${params.id}`;
    return {
      schemaVersion: 1, operationId: op.operationId, capabilityId: op.id, serviceId: op.serviceId,
      method: 'GET', url: `${op.serverUrl}${path}`, origin: op.serverUrl, path, query: {},
      accountId, previewDigest: 'none_read',
      callDigest: sha256Hex(canonicalStringify({ op: op.operationId, path, account: accountId })),
      limits: { ...BASE_LIMITS },
    };
  }
  const body = parseCreateTaskBody(params);
  const accountId = params.accountId as string;
  const preview = buildEffectPreview('create_task', { accountId, body });
  const url = `${op.serverUrl}/v1/tasks`;
  return {
    schemaVersion: 1, operationId: op.operationId, capabilityId: op.id, serviceId: op.serviceId,
    method: 'POST', url, origin: op.serverUrl, path: '/v1/tasks', query: {},
    body: { ...body },
    accountId, previewDigest: preview.previewDigest,
    callDigest: sha256Hex(canonicalStringify({ op: op.operationId, url, body, account: accountId, preview: preview.previewDigest })),
    limits: { ...BASE_LIMITS },
  };
}

/** Re-verify a prepared call against the catalog before dispatch. Any drift fails closed. */
export function verifyPreparedProductivityCall(prepared: PreparedProductivityCall): ProductivityOperation {
  const op = getProductivityOperation(prepared.operationId);
  if (prepared.capabilityId !== op.id || prepared.serviceId !== op.serviceId || prepared.method !== op.method) {
    invalid('catalog_operation_mismatch', 'prepared call does not match the admitted operation');
  }
  if (prepared.origin !== op.serverUrl || prepared.url !== `${op.serverUrl}${prepared.path}`) {
    invalid('unadmitted_destination_origin', 'prepared call leaves the admitted origin');
  }
  const rebuilt = prepareProductivityCall(prepared.operationId as 'list_tasks' | 'get_task' | 'create_task',
    prepared.method === 'POST'
      ? { accountId: prepared.accountId, ...prepared.body }
      : prepared.path === '/v1/tasks' ? { accountId: prepared.accountId } : { accountId: prepared.accountId, id: prepared.path.slice('/v1/tasks/'.length) });
  if (rebuilt.callDigest !== prepared.callDigest || rebuilt.previewDigest !== prepared.previewDigest) {
    invalid('call_digest_mismatch', 'prepared call was altered after preparation');
  }
  return op;
}
