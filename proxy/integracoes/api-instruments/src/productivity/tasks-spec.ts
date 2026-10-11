/**
 * Prod Tasks — fixture-profile service specification (etapa 15, entrega vertical 1).
 *
 * Generic task-service shape (Todoist-like: list/get/create + status + webhooks). This is a
 * FIXTURE profile: serverUrl uses the non-resolvable `.invalid` TLD so even a missing mock
 * cannot reach a real destination. No official service was selected (accounts are out of
 * scope for this provisioning); selecting one must only change auth/origin/schemas, never
 * the governed path implemented here.
 *
 * Terms: fixture-only. No commercial terms, no real data rights. contentRights stay
 * 'unknown' everywhere except the synthetic fixture records created in tests.
 */
export const PROD_TASKS_METADATA = {
  serviceId: 'prod_tasks',
  domain: 'productivity_tasks',
  officialUrl: 'https://tasks-fixture.invalid',
  specUrl: 'https://tasks-fixture.invalid/openapi.json',
  revision: '2026.09.19-fixture.1',
  codeLicense: 'MIT (Uptokey)',
  dataLicense: 'fixture-only; no real data',
  commercialTerms: 'No commercial service selected. This profile talks only to a local fake server in tests.',
  authentication: 'bearer (vault-held API token, fixture value in tests only)',
  rateLimit: 'fixture: 100 requests/minute/account; quota return on refused dispatch is local-only',
  attribution: 'Synthetic fixture records created by the local fake server',
  consultedAt: '2026-09-19T00:00:00.000Z',
} as const;

export const PROD_TASKS_SERVER_URL = 'https://tasks-fixture.invalid';
export const PROD_TASKS_REVISION = '2026.09.19-fixture.1';

/** Effect classes: leitura (list/get), rascunho local (preview, zero rede) e escrita externa (create). */
export type ProdTasksEffectClass = 'leitura' | 'rascunho_local' | 'escrita_externa';

export interface ProdTasksOperationSpec {
  operationId: 'list_tasks' | 'get_task' | 'create_task';
  method: 'GET' | 'POST';
  path: '/v1/tasks' | '/v1/tasks/{id}';
  effectClass: ProdTasksEffectClass;
  summary: string;
  idempotencySupport: 'none' | 'key';
  reconciliationSupport: 'status_query' | 'none';
}

export const PROD_TASKS_OPERATIONS: readonly ProdTasksOperationSpec[] = [
  {
    operationId: 'list_tasks',
    method: 'GET',
    path: '/v1/tasks',
    effectClass: 'leitura',
    summary: 'Listar tarefas da conta autenticada',
    idempotencySupport: 'none',
    reconciliationSupport: 'none',
  },
  {
    operationId: 'get_task',
    method: 'GET',
    path: '/v1/tasks/{id}',
    effectClass: 'leitura',
    summary: 'Consultar status de uma tarefa pelo identificador',
    idempotencySupport: 'none',
    reconciliationSupport: 'status_query',
  },
  {
    operationId: 'create_task',
    method: 'POST',
    path: '/v1/tasks',
    effectClass: 'escrita_externa',
    summary: 'Criar uma tarefa (efeito externo, sem rollback garantido)',
    idempotencySupport: 'key',
    reconciliationSupport: 'status_query',
  },
];
