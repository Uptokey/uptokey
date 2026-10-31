import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CONVERSATION_SCHEMA_VERSION,
  CONVERSATION_STORAGE_POLICIES,
  CONVERSATION_PROCESSING_POLICIES,
  parseConversation,
  canonicalConversation,
  parseConversationPolicyPatch,
  parseMessage,
  parseMessagePart,
  parseSendMessage,
  parseRunLink,
  parseConversationEvent,
  parseListQuery,
  parseImportSessions,
  canonicalImportPayload,
} from '../conversation.js';

const UUID = '11111111-1111-4111-8111-111111111111';
const UUID2 = '22222222-2222-4222-8222-222222222222';
const NOW = '2026-09-20T12:00:00.000Z';

const conversation = {
  schemaVersion: 1,
  id: UUID,
  workspaceId: UUID2,
  projectId: null,
  title: 'Plano de estudos',
  createdAt: NOW,
  updatedAt: NOW,
  revision: 1,
  archivedAt: null,
  activeBranchId: 'main',
};

test('conversation: accepts a valid conversation and rejects unknown fields', () => {
  assert.equal(parseConversation(conversation).title, 'Plano de estudos');
  assert.equal(canonicalConversation(conversation), canonicalConversation({ ...conversation }));
  assert.throws(() => parseConversation({ ...conversation, admin: true }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, title: '  ' }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, title: 'x'.repeat(161) }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, schemaVersion: 2 }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, id: 'c_local' }), /conversation_invalid/);
});

test('message: roles, branches and client message ids are validated', () => {
  const message = {
    schemaVersion: 1, id: UUID, conversationId: UUID2, parentId: null,
    branchId: 'main', role: 'user', clientMessageId: 'cm_1', createdAt: NOW, revision: 1,
  };
  assert.equal(parseMessage(message).role, 'user');
  assert.throws(() => parseMessage({ ...message, role: 'system' }), /conversation_invalid/);
  assert.throws(() => parseMessage({ ...message, clientMessageId: '' }), /conversation_invalid/);
});

test('part: discriminated validation per type; oversized text refused', () => {
  const part = { id: UUID, messageId: UUID2, type: 'text', text: 'olá' };
  assert.equal(parseMessagePart(part).text, 'olá');
  assert.throws(
    () => parseMessagePart({ id: UUID, messageId: UUID2, type: 'text', text: 'x'.repeat(65537) }),
    /payload_too_large/,
  );
  assert.throws(() => parseMessagePart({ id: UUID, messageId: UUID2, type: 'html', text: '<b>x</b>' }), /invalid_part/);
  const toolCall = {
    id: UUID, messageId: UUID2, type: 'tool_call',
    text: { callId: 'call_1', name: 'read_text_file', arguments: { path: '.' } },
  };
  assert.equal(parseMessagePart(toolCall).text.name, 'read_text_file');
  assert.throws(
    () => parseMessagePart({ id: UUID, messageId: UUID2, type: 'tool_call', text: { callId: 'c' } }),
    /invalid_part/,
  );
  const image = { id: UUID, messageId: UUID2, type: 'image', artifactRef: 'a1', text: 'legenda' };
  assert.equal(parseMessagePart(image).artifactRef, 'a1');
});

test('send: requires parts within limits and a valid revision', () => {
  const send = {
    conversationId: UUID, parentId: null, clientMessageId: 'cm_1', expectedRevision: 2,
    parts: [{ type: 'text', text: 'explique outage' }], modelSelectionRef: 'uptokey-auto', contextRefs: [],
  };
  assert.equal(parseSendMessage(send).expectedRevision, 2);
  assert.throws(() => parseSendMessage({ ...send, parts: [] }), /invalid_part/);
  assert.throws(() => parseSendMessage({ ...send, expectedRevision: 0 }), /conversation_invalid/);
  assert.throws(
    () => parseSendMessage({ ...send, parts: [{ type: 'text', text: 'x'.repeat(65537) }] }),
    /payload_too_large/,
  );
});

test('run link: binds message, request and run without credentials', () => {
  const link = {
    conversationId: UUID, messageId: UUID2, requestId: 'req_1', runId: 'run_1',
    projectId: UUID, modelId: 'uptokey-auto', state: 'streaming', lastSequence: 3,
  };
  assert.equal(parseRunLink(link).state, 'streaming');
  assert.throws(() => parseRunLink({ ...link, state: 'done' }), /conversation_invalid/);
  assert.throws(() => parseRunLink({ ...link, admin: true }), /conversation_invalid/);
});

test('event: monotonic sequence and typed payload', () => {
  const event = {
    id: UUID, conversationId: UUID2, runId: null, sequence: 1,
    type: 'message.created', payload: { messageId: UUID }, createdAt: NOW,
  };
  assert.equal(parseConversationEvent(event).sequence, 1);
  assert.throws(() => parseConversationEvent({ ...event, sequence: 0 }), /conversation_invalid/);
  assert.throws(() => parseConversationEvent({ ...event, type: 'message.sent' }), /conversation_invalid/);
});

test('list: cursor pagination defaults and ceilings', () => {
  assert.deepEqual(parseListQuery({}), { after: null, limit: 50, query: null, includeArchived: false });
  assert.equal(parseListQuery({ limit: 200 }).limit, 200);
  assert.throws(() => parseListQuery({ limit: 201 }), /conversation_invalid/);
  assert.throws(() => parseListQuery({ limit: 0 }), /conversation_invalid/);
});

test('policy: optional storage/processing fields with explicit cloud opt-in', () => {
  assert.deepEqual(CONVERSATION_STORAGE_POLICIES, ['local', 'temporary', 'cloud']);
  assert.deepEqual(CONVERSATION_PROCESSING_POLICIES, ['local_only', 'external_allowed']);
  // Campos aditivos: conversa legada sem política continua válida.
  assert.equal(parseConversation(conversation).storagePolicy, undefined);
  const local = parseConversation({ ...conversation, storagePolicy: 'local', processingPolicy: 'external_allowed' });
  assert.equal(local.storagePolicy, 'local');
  assert.equal(local.processingPolicy, 'external_allowed');
  const cloud = parseConversation({ ...conversation, storagePolicy: 'cloud', cloudSyncOptIn: true });
  assert.equal(cloud.cloudSyncOptIn, true);
  // Nuvem sem adesão explícita falha fechado; opt-in sem nuvem é contraditório.
  assert.throws(() => parseConversation({ ...conversation, storagePolicy: 'cloud' }), /cloud_sync_not_opted_in/);
  assert.throws(() => parseConversation({ ...conversation, cloudSyncOptIn: true }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, storagePolicy: 'vault' }), /conversation_invalid/);
  assert.throws(() => parseConversation({ ...conversation, processingPolicy: 'remote' }), /conversation_invalid/);
});

test('policy patch: explicit transitions; temporary is creation-only', () => {
  assert.deepEqual(parseConversationPolicyPatch({ processingPolicy: 'local_only' }), { processingPolicy: 'local_only' });
  assert.deepEqual(
    parseConversationPolicyPatch({ storagePolicy: 'cloud', cloudSyncOptIn: true }),
    { storagePolicy: 'cloud', cloudSyncOptIn: true },
  );
  // Revogação de nuvem: volta a local; remoção de cópias remotas é operação separada.
  assert.deepEqual(parseConversationPolicyPatch({ storagePolicy: 'local' }), { storagePolicy: 'local' });
  assert.throws(() => parseConversationPolicyPatch({ storagePolicy: 'temporary' }), /conversation_invalid/);
  assert.throws(() => parseConversationPolicyPatch({ storagePolicy: 'cloud' }), /cloud_sync_not_opted_in/);
  assert.throws(() => parseConversationPolicyPatch({ cloudSyncOptIn: true }), /conversation_invalid/);
  assert.throws(() => parseConversationPolicyPatch({}), /conversation_invalid/);
  assert.throws(() => parseConversationPolicyPatch({ processingPolicy: 'local_only', admin: true }), /conversation_invalid/);
});

test('import: legacy localStorage sessions validate; digest is stable', () => {
  const input = {
    origin: 'quimera-chat-sessions-v1',
    sessions: [{ id: 'c_abc', title: 'Sessão', messages: [{ role: 'user', content: 'oi ≥ unicode ✓' }] }],
  };
  assert.equal(parseImportSessions(input).sessions.length, 1);
  assert.equal(canonicalImportPayload(input), canonicalImportPayload(structuredClone(input)));
  assert.throws(() => parseImportSessions({ origin: 'other', sessions: [] }), /import_invalid/);
  assert.throws(
    () => parseImportSessions({ origin: 'quimera-chat-sessions-v1', sessions: [{ id: 'x' }] }),
    /import_invalid/,
  );
});
