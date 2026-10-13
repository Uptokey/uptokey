/**
 * Conversations — contrato canônico E2-01 (chat persistente compartilhado).
 *
 * schemaVersion=1. Parsers rejeitam propriedades desconhecidas, protótipos
 * especiais e revisões obsoletas. Nenhum parser recebe ou devolve segredos
 * ou credenciais: RunLink carrega `accountRef` opaco; projeções nunca expõem
 * valores de texto além do chamador autorizado. Parsing não é autorização.
 */

import { isDataRecord } from './plain-data.js';
import { canonicalJson } from './canonical.js';

export const CONVERSATION_SCHEMA_VERSION = 1;
export const CONVERSATION_CONTRACT_VERSION = 1;

export const CONVERSATION_TITLE_MIN = 1;
export const CONVERSATION_TITLE_MAX = 160;
export const CONVERSATION_MESSAGE_TEXT_MAX_BYTES = 64 * 1024;
export const CONVERSATION_MAX_PARTS_PER_MESSAGE = 32;
export const CONVERSATION_LIST_DEFAULT_LIMIT = 50;
export const CONVERSATION_LIST_MAX_LIMIT = 200;
export const CONVERSATION_MAX_MESSAGES_PER_CONVERSATION = 100000;
export const CONVERSATION_CLIENT_MESSAGE_ID_MAX = 100;
export const CONVERSATION_MAX_IMPORT_SESSIONS = 40;
export const CONVERSATION_MAX_IMPORT_MESSAGES = 5000;

export const CONVERSATION_ROLES = ['user', 'assistant', 'tool'];
export const CONVERSATION_PART_TYPES = [
  'text',
  'image',
  'audio',
  'video',
  'file',
  'tool_call',
  'tool_result',
  'citation',
  'status',
];
export const CONVERSATION_RUN_STATES = [
  'queued',
  'streaming',
  'awaiting_action',
  'completed',
  'interrupted',
  'failed',
  'cancelled',
  'unknown',
  'needs_attention',
];
export const CONVERSATION_EVENT_TYPES = [
  'message.created',
  'message.branch',
  'run.linked',
  'run.state',
  'conversation.updated',
  'conversation.archived',
];

/**
 * Onde a conversa é guardada: `local` (padrão, somente neste computador),
 * `temporary` (sem histórico durável; recursos de sessão) ou `cloud`
 * (sincronização em nuvem, somente com adesão explícita `cloudSyncOptIn`).
 */
export const CONVERSATION_STORAGE_POLICIES = ['local', 'temporary', 'cloud'];
/**
 * Onde o pedido pode ser processado: `local_only` bloqueia envio de conteúdo
 * a serviços externos; `external_allowed` permite provedores externos. A
 * escolha é independente do armazenamento e nunca promete retenção zero do
 * provedor externo.
 */
export const CONVERSATION_PROCESSING_POLICIES = ['local_only', 'external_allowed'];

export const CONVERSATION_ERROR_TYPES = [
  'conversation_invalid',
  'conversation_not_found',
  'conversation_conflict',
  'conversation_limit_exceeded',
  'invalid_part',
  'payload_too_large',
  'message_conflict',
  'message_not_found',
  'run_link_conflict',
  'import_invalid',
  'operation_replayed',
  'cloud_sync_not_opted_in',
];

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SECRET_PROTO_RE = /__proto__|constructor|prototype/;
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?Z$/;

const fail = (code) => {
  throw new Error(code);
};

function assertNoProtoKeys(value) {
  for (const key of Object.keys(value)) {
    if (SECRET_PROTO_RE.test(key)) fail('conversation_invalid');
  }
}

function assertExactKeys(value, allowed, code = 'conversation_invalid') {
  assertNoProtoKeys(value);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) fail(code);
  }
}

function parseId(value, field = 'id') {
  if (typeof value !== 'string' || !UUID_RE.test(value)) fail('conversation_invalid');
  return value;
}

function parseOptionalId(value) {
  if (value === undefined || value === null) return null;
  return parseId(value);
}

function parseIsoDate(value) {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value) || !Number.isFinite(Date.parse(value))) {
    fail('conversation_invalid');
  }
  return value;
}

function parseOptionalIsoDate(value) {
  if (value === undefined || value === null) return null;
  return parseIsoDate(value);
}

function parseRevision(value) {
  if (!Number.isSafeInteger(value) || value < 1) fail('conversation_invalid');
  return value;
}

function parseTitle(value) {
  if (typeof value !== 'string') fail('conversation_invalid');
  const trimmed = value.trim();
  const length = [...trimmed].length;
  if (length < CONVERSATION_TITLE_MIN || length > CONVERSATION_TITLE_MAX) fail('conversation_invalid');
  return trimmed;
}

function parseBranchId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > 100) fail('conversation_invalid');
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) fail('conversation_invalid');
  return value;
}

function parseRole(value) {
  if (typeof value !== 'string' || !CONVERSATION_ROLES.includes(value)) fail('conversation_invalid');
  return value;
}

function parsePartType(value) {
  if (typeof value !== 'string' || !CONVERSATION_PART_TYPES.includes(value)) fail('invalid_part');
  return value;
}

function parseClientMessageId(value) {
  if (typeof value !== 'string' || value.length < 1 || value.length > CONVERSATION_CLIENT_MESSAGE_ID_MAX) {
    fail('conversation_invalid');
  }
  return value;
}

function parseTextPayload(value) {
  if (typeof value !== 'string') fail('invalid_part');
  if (new TextEncoder().encode(value).byteLength > CONVERSATION_MESSAGE_TEXT_MAX_BYTES) fail('payload_too_large');
  return value;
}

function parseArtifactRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail('invalid_part');
  return value;
}

function parseRunState(value) {
  if (typeof value !== 'string' || !CONVERSATION_RUN_STATES.includes(value)) fail('conversation_invalid');
  return value;
}

function parseEventType(value) {
  if (typeof value !== 'string' || !CONVERSATION_EVENT_TYPES.includes(value)) fail('conversation_invalid');
  return value;
}

function parseModelSelectionRef(value) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length < 1 || value.length > 200) fail('conversation_invalid');
  return value;
}

function parseContextRefs(value) {
  if (value === undefined || value === null) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > 64) fail('conversation_invalid');
  for (const ref of value) {
    if (typeof ref !== 'string' || ref.length < 1 || ref.length > 300) fail('conversation_invalid');
  }
  return Object.freeze([...value]);
}

/**
 * Política de conversa persistida (metadados indexáveis; texto fica selado no store).
 * Os campos de política são aditivos e opcionais: uma conversa sem eles segue
 * os padrões `local` + `local_only`, sem sincronização em nuvem.
 */
export function parseConversation(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, [
    'schemaVersion', 'id', 'workspaceId', 'projectId', 'title',
    'createdAt', 'updatedAt', 'revision', 'archivedAt', 'activeBranchId',
    'instructionProfileRef', 'instructionProfileRevision',
    'storagePolicy', 'processingPolicy', 'cloudSyncOptIn',
  ]);
  if (input.schemaVersion !== CONVERSATION_SCHEMA_VERSION) fail('conversation_invalid');
  const workspaceId = parseId(input.workspaceId, 'workspaceId');
  const out = {
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    id: parseId(input.id),
    workspaceId,
    projectId: parseOptionalId(input.projectId),
    title: parseTitle(input.title),
    createdAt: parseIsoDate(input.createdAt),
    updatedAt: parseIsoDate(input.updatedAt),
    revision: parseRevision(input.revision),
    archivedAt: parseOptionalIsoDate(input.archivedAt),
    activeBranchId: parseBranchId(input.activeBranchId),
  };
  if (input.storagePolicy !== undefined && input.storagePolicy !== null) {
    if (!CONVERSATION_STORAGE_POLICIES.includes(input.storagePolicy)) fail('conversation_invalid');
    out.storagePolicy = input.storagePolicy;
  }
  if (input.processingPolicy !== undefined && input.processingPolicy !== null) {
    if (!CONVERSATION_PROCESSING_POLICIES.includes(input.processingPolicy)) fail('conversation_invalid');
    out.processingPolicy = input.processingPolicy;
  }
  if (input.cloudSyncOptIn !== undefined && input.cloudSyncOptIn !== null) {
    if (typeof input.cloudSyncOptIn !== 'boolean') fail('conversation_invalid');
    out.cloudSyncOptIn = input.cloudSyncOptIn;
  }
  if (out.storagePolicy === 'cloud' && out.cloudSyncOptIn !== true) fail('cloud_sync_not_opted_in');
  if (out.cloudSyncOptIn === true && out.storagePolicy !== 'cloud') fail('conversation_invalid');
  if (input.instructionProfileRef !== undefined && input.instructionProfileRef !== null) {
    if (typeof input.instructionProfileRef !== 'string' || input.instructionProfileRef.length > 200) {
      fail('conversation_invalid');
    }
    out.instructionProfileRef = input.instructionProfileRef;
  }
  if (input.instructionProfileRevision !== undefined && input.instructionProfileRevision !== null) {
    if (!Number.isSafeInteger(input.instructionProfileRevision) || input.instructionProfileRevision < 1) {
      fail('conversation_invalid');
    }
    out.instructionProfileRevision = input.instructionProfileRevision;
  }
  return Object.freeze(out);
}

export function canonicalConversation(input) {
  return canonicalJson(parseConversation(input));
}

/**
 * Patch de política de uma conversa existente. Mudanças são escolhas explícitas
 * do usuário: `temporary` é decisão de criação e não vira permanente por patch;
 * subir para `cloud` exige `cloudSyncOptIn: true` no mesmo patch; revogar a
 * nuvem usa `storagePolicy: 'local'` (a remoção de cópias remotas é operação
 * separada, com confirmação própria). `processingPolicy` alterna livremente.
 */
export function parseConversationPolicyPatch(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, ['storagePolicy', 'processingPolicy', 'cloudSyncOptIn']);
  const out = {};
  if (input.storagePolicy !== undefined && input.storagePolicy !== null) {
    if (!CONVERSATION_STORAGE_POLICIES.includes(input.storagePolicy) || input.storagePolicy === 'temporary') {
      fail('conversation_invalid');
    }
    out.storagePolicy = input.storagePolicy;
  }
  if (input.processingPolicy !== undefined && input.processingPolicy !== null) {
    if (!CONVERSATION_PROCESSING_POLICIES.includes(input.processingPolicy)) fail('conversation_invalid');
    out.processingPolicy = input.processingPolicy;
  }
  if (input.cloudSyncOptIn !== undefined && input.cloudSyncOptIn !== null) {
    if (typeof input.cloudSyncOptIn !== 'boolean') fail('conversation_invalid');
    out.cloudSyncOptIn = input.cloudSyncOptIn;
  }
  if (out.storagePolicy === 'cloud' && out.cloudSyncOptIn !== true) fail('cloud_sync_not_opted_in');
  if (out.cloudSyncOptIn === true && out.storagePolicy !== 'cloud') fail('conversation_invalid');
  if (!Object.keys(out).length) fail('conversation_invalid');
  return Object.freeze(out);
}

/**
 * Parte de mensagem (validação discriminada por tipo).
 * `text` carrega texto (até 64 KiB); demais tipos referenciam artefato/recibo.
 */
export function parseMessagePart(input) {
  if (!isDataRecord(input)) fail('invalid_part');
  assertExactKeys(input, ['id', 'messageId', 'type', 'text', 'artifactRef', 'callId', 'name'], 'invalid_part');
  const type = parsePartType(input.type);
  const out = {
    id: parseId(input.id),
    messageId: parseId(input.messageId),
    type,
  };
  if (type === 'text' || type === 'status') {
    out.text = parseTextPayload(input.text);
  } else if (type === 'tool_call') {
    if (!isDataRecord(input.text)) fail('invalid_part');
    assertExactKeys(input.text, ['callId', 'name', 'arguments'], 'invalid_part');
    if (typeof input.text.callId !== 'string' || input.text.callId.length < 1 || input.text.callId.length > 200) {
      fail('invalid_part');
    }
    if (typeof input.text.name !== 'string' || input.text.name.length < 1 || input.text.name.length > 200) {
      fail('invalid_part');
    }
    if (!isDataRecord(input.text.arguments)) fail('invalid_part');
    out.text = Object.freeze({
      callId: input.text.callId,
      name: input.text.name,
      arguments: Object.freeze({ ...input.text.arguments }),
    });
  } else if (type === 'tool_result') {
    if (!isDataRecord(input.text)) fail('invalid_part');
    assertExactKeys(input.text, ['callId', 'receiptId', 'output'], 'invalid_part');
    if (typeof input.text.callId !== 'string' || input.text.callId.length < 1 || input.text.callId.length > 200) {
      fail('invalid_part');
    }
    if (typeof input.text.receiptId !== 'string' || input.text.receiptId.length > 200) fail('invalid_part');
    out.text = Object.freeze({ ...input.text });
  } else {
    // image/audio/video/file/citation: referência a artefato + legenda opcional.
    out.artifactRef = parseArtifactRef(input.artifactRef);
    if (input.text !== undefined && input.text !== null) out.text = parseTextPayload(input.text);
  }
  if (input.callId !== undefined && input.callId !== null) {
    if (typeof input.callId !== 'string' || input.callId.length > 200) fail('invalid_part');
    out.callId = input.callId;
  }
  if (input.name !== undefined && input.name !== null) {
    if (typeof input.name !== 'string' || input.name.length > 200) fail('invalid_part');
    out.name = input.name;
  }
  return Object.freeze(out);
}

/**
 * Mensagem (metadados; partes via parseMessagePart).
 */
export function parseMessage(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, [
    'schemaVersion', 'id', 'conversationId', 'parentId', 'branchId',
    'role', 'clientMessageId', 'createdAt', 'revision',
  ]);
  if (input.schemaVersion !== CONVERSATION_SCHEMA_VERSION) fail('conversation_invalid');
  return Object.freeze({
    schemaVersion: CONVERSATION_SCHEMA_VERSION,
    id: parseId(input.id),
    conversationId: parseId(input.conversationId),
    parentId: parseOptionalId(input.parentId),
    branchId: parseBranchId(input.branchId),
    role: parseRole(input.role),
    clientMessageId: parseClientMessageId(input.clientMessageId),
    createdAt: parseIsoDate(input.createdAt),
    revision: parseRevision(input.revision),
  });
}

/**
 * Entrada de envio (Send): mensagem do usuário + intenção de inferência.
 */
export function parseSendMessage(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, [
    'conversationId', 'parentId', 'clientMessageId', 'expectedRevision',
    'parts', 'modelSelectionRef', 'contextRefs',
  ]);
  const parts = input.parts;
  if (!Array.isArray(parts) || parts.length < 1 || parts.length > CONVERSATION_MAX_PARTS_PER_MESSAGE) {
    fail('invalid_part');
  }
  const textBytes = parts.reduce((n, p) => {
    if (isDataRecord(p) && typeof p.text === 'string') return n + Buffer.byteLength(p.text, 'utf8');
    return n;
  }, 0);
  if (textBytes > CONVERSATION_MESSAGE_TEXT_MAX_BYTES) fail('payload_too_large');
  return Object.freeze({
    conversationId: parseId(input.conversationId),
    parentId: parseOptionalId(input.parentId),
    clientMessageId: parseClientMessageId(input.clientMessageId),
    expectedRevision: parseRevision(input.expectedRevision),
    parts,
    modelSelectionRef: parseModelSelectionRef(input.modelSelectionRef),
    contextRefs: parseContextRefs(input.contextRefs),
  });
}

/**
 * Ligação mensagem ↔ execução W5 (sem credencial).
 */
export function parseRunLink(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, [
    'conversationId', 'messageId', 'requestId', 'runId', 'projectId',
    'providerId', 'accountRef', 'modelId', 'state', 'lastSequence',
  ]);
  if (typeof input.requestId !== 'string' || input.requestId.length < 1 || input.requestId.length > 100) {
    fail('conversation_invalid');
  }
  if (typeof input.runId !== 'string' || input.runId.length < 1 || input.runId.length > 100) {
    fail('conversation_invalid');
  }
  if (input.providerId !== undefined && input.providerId !== null) {
    if (typeof input.providerId !== 'string' || input.providerId.length > 100) fail('conversation_invalid');
  }
  if (input.accountRef !== undefined && input.accountRef !== null) {
    if (typeof input.accountRef !== 'string' || input.accountRef.length > 200) fail('conversation_invalid');
  }
  if (typeof input.modelId !== 'string' || input.modelId.length < 1 || input.modelId.length > 200) {
    fail('conversation_invalid');
  }
  if (!Number.isSafeInteger(input.lastSequence) || input.lastSequence < 0) fail('conversation_invalid');
  return Object.freeze({
    conversationId: parseId(input.conversationId),
    messageId: parseId(input.messageId),
    requestId: input.requestId,
    runId: input.runId,
    projectId: parseId(input.projectId),
    ...(input.providerId === undefined || input.providerId === null ? {} : { providerId: input.providerId }),
    ...(input.accountRef === undefined || input.accountRef === null ? {} : { accountRef: input.accountRef }),
    modelId: input.modelId,
    state: parseRunState(input.state),
    lastSequence: input.lastSequence,
  });
}

/**
 * Evento de conversa (sequência monotônica por conversa; duplicata descartada por ID).
 */
export function parseConversationEvent(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, ['id', 'conversationId', 'runId', 'sequence', 'type', 'payload', 'createdAt']);
  if (!Number.isSafeInteger(input.sequence) || input.sequence < 1) fail('conversation_invalid');
  if (!isDataRecord(input.payload)) fail('conversation_invalid');
  assertNoProtoKeys(input.payload);
  return Object.freeze({
    id: parseId(input.id),
    conversationId: parseId(input.conversationId),
    runId: input.runId === undefined || input.runId === null ? null : String(input.runId),
    sequence: input.sequence,
    type: parseEventType(input.type),
    payload: Object.freeze({ ...input.payload }),
    createdAt: parseIsoDate(input.createdAt),
  });
}

/**
 * Paginação de lista (cursor estável `after`, limite 1..200, padrão 50).
 */
export function parseListQuery(input) {
  if (!isDataRecord(input)) fail('conversation_invalid');
  assertExactKeys(input, ['after', 'limit', 'query', 'includeArchived']);
  const out = {};
  if (input.after === undefined || input.after === null || input.after === '') out.after = null;
  else if (typeof input.after !== 'string' || input.after.length > 200) fail('conversation_invalid');
  else out.after = input.after;
  if (input.limit === undefined || input.limit === null) out.limit = CONVERSATION_LIST_DEFAULT_LIMIT;
  else {
    if (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > CONVERSATION_LIST_MAX_LIMIT) {
      fail('conversation_invalid');
    }
    out.limit = input.limit;
  }
  if (input.query === undefined || input.query === null || input.query === '') out.query = null;
  else {
    if (typeof input.query !== 'string' || input.query.length > 200) fail('conversation_invalid');
    out.query = input.query;
  }
  out.includeArchived = input.includeArchived === true;
  return Object.freeze(out);
}

/**
 * Importação do histórico local (`quimera-chat-sessions-v1`).
 * Retorna forma canônica para digest de idempotência (origem+digest).
 */
export function parseImportSessions(input) {
  if (!isDataRecord(input)) fail('import_invalid');
  assertExactKeys(input, ['origin', 'sessions'], 'import_invalid');
  if (!['quimera-chat-sessions-v1','utk-chat'].includes(input.origin)) fail('import_invalid');
  if (!Array.isArray(input.sessions) || input.sessions.length > CONVERSATION_MAX_IMPORT_SESSIONS) {
    fail('import_invalid');
  }
  const sessions = input.sessions.map((session) => {
    if (!isDataRecord(session)) fail('import_invalid');
    assertExactKeys(session, ['id', 'title', 'messages', 'createdAt', 'updatedAt'], 'import_invalid');
    if (typeof session.id !== 'string' || session.id.length < 1 || session.id.length > 100) fail('import_invalid');
    if (session.title !== undefined && session.title !== null && typeof session.title !== 'string') {
      fail('import_invalid');
    }
    if (!Array.isArray(session.messages) || session.messages.length > CONVERSATION_MAX_IMPORT_MESSAGES) {
      fail('import_invalid');
    }
    const messages = session.messages.map((message) => {
      if (!isDataRecord(message)) fail('import_invalid');
      assertExactKeys(message, ['role', 'content', 'createdAt'], 'import_invalid');
      if (message.role !== 'user' && message.role !== 'assistant') fail('import_invalid');
      if (typeof message.content !== 'string') fail('import_invalid');
      if (new TextEncoder().encode(message.content).byteLength > CONVERSATION_MESSAGE_TEXT_MAX_BYTES) fail('payload_too_large');
      return Object.freeze({ role: message.role, content: message.content });
    });
    return Object.freeze({
      id: session.id,
      title: typeof session.title === 'string' ? session.title.slice(0, CONVERSATION_TITLE_MAX) : '',
      messages: Object.freeze(messages),
    });
  });
  return Object.freeze({ origin: input.origin, sessions: Object.freeze(sessions) });
}

export function canonicalImportPayload(input) {
  return canonicalJson(parseImportSessions(input));
}
