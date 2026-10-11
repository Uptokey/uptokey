/** E2-03 client keys + protocol capability (W0). Parsing is not authorization. */
import { isDataRecord } from './plain-data.js';
import { canonicalJson } from './canonical.js';

/** New enrollment never derives authority from a client-supplied display label.
 * PWA enrollment uses its separate browser-session protocol, not this grant.
 * 'tui' (additive, B9): requested explicitly and approved with the same audience; the
 * server binds it to an enrolled P-256 key at consume. Older values keep their meaning. */
export const PAIRING_AUDIENCES = Object.freeze(['legacy', 'vscode', 'browser-extension', 'tauri', 'tui']);
export function parsePairingAudience(value) {
  if (value === undefined) return 'legacy';
  if (typeof value !== 'string' || !PAIRING_AUDIENCES.includes(value)) throw new Error('pairing_audience_invalid');
  return value;
}

/**
 * Explicit, reversible audience transition of an EXISTING client identity. The clientId (and
 * therefore the data owner/principal) never changes. Only narrowing transitions are published;
 * nothing is inferred from a display name, Origin or label. Parsing is not authorization: the
 * core requires the local administrative authority and CAS on expectedPolicyRevision.
 */
export const CLIENT_AUDIENCE_TRANSITIONS = Object.freeze([Object.freeze({ from: 'pwa', to: 'tui' })]);
export function parseClientAudienceTransition(input) {
  const bad = () => { throw new Error('audience_transition_invalid'); };
  if (!isDataRecord(input)) bad();
  const keys = Object.keys(input).sort().join(',');
  if (typeof input.clientId !== 'string' || !UUID_V4.test(input.clientId)) bad();
  if (!Number.isSafeInteger(input.expectedPolicyRevision) || input.expectedPolicyRevision < 1) bad();
  if (input.kind === 'transition') {
    if (keys !== 'clientId,expectedPolicyRevision,from,kind,to') bad();
    if (!CLIENT_AUDIENCE_TRANSITIONS.some((t) => t.from === input.from && t.to === input.to)) bad();
    return Object.freeze({ kind: 'transition', clientId: input.clientId, from: input.from, to: input.to, expectedPolicyRevision: input.expectedPolicyRevision });
  }
  if (input.kind === 'revert') {
    if (keys !== 'clientId,expectedPolicyRevision,kind') bad();
    return Object.freeze({ kind: 'revert', clientId: input.clientId, expectedPolicyRevision: input.expectedPolicyRevision });
  }
  return bad();
}

export const CLIENT_KEY_CONTRACT_VERSION = 1;
export const CLIENT_KEY_SCHEMA_VERSION = 1;
export const CLIENT_KEY_MAX_KEYS = 128;
export const CLIENT_KEY_MAX_LIST = 100;
export const CLIENT_KEY_MAX_SCOPED_IDS = 64;
export const CLIENT_KEY_LABEL_MAX = 80;

export const CLIENT_KEY_SCOPES = [
  'inference:chat',
  'inference:responses',
  'inference:messages',
  'models:read',
  'usage:read',
];

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = (code) => { throw new Error(code); };

function idList(value, field) {
  if (!Array.isArray(value) || value.length > CLIENT_KEY_MAX_SCOPED_IDS) fail('client_key_invalid');
  for (const id of value) {
    if (typeof id !== 'string' || id.length < 1 || id.length > 200) fail('client_key_invalid');
  }
  return Object.freeze([...value]);
}

function parseScopes(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > CLIENT_KEY_SCOPES.length) fail('client_key_invalid');
  const seen = new Set();
  for (const scope of value) {
    if (typeof scope !== 'string' || !CLIENT_KEY_SCOPES.includes(scope) || seen.has(scope)) fail('client_key_invalid');
    seen.add(scope);
  }
  return Object.freeze([...value]);
}

function parseLimits(value) {
  if (value === undefined || value === null) return undefined;
  if (!isDataRecord(value)) fail('client_key_invalid');
  const allowed = ['requestsPerMinute', 'maxConcurrent', 'maxOutputTokens', 'maxCostMicros'];
  if (Object.keys(value).some((k) => !allowed.includes(k))) fail('client_key_invalid');
  const out = {};
  if (value.requestsPerMinute !== undefined) {
    if (!Number.isSafeInteger(value.requestsPerMinute) || value.requestsPerMinute < 1 || value.requestsPerMinute > 10000) fail('client_key_invalid');
    out.requestsPerMinute = value.requestsPerMinute;
  }
  if (value.maxConcurrent !== undefined) {
    if (!Number.isSafeInteger(value.maxConcurrent) || value.maxConcurrent < 1 || value.maxConcurrent > 64) fail('client_key_invalid');
    out.maxConcurrent = value.maxConcurrent;
  }
  if (value.maxOutputTokens !== undefined) {
    if (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 1 || value.maxOutputTokens > 1000000) fail('client_key_invalid');
    out.maxOutputTokens = value.maxOutputTokens;
  }
  if (value.maxCostMicros !== undefined && value.maxCostMicros !== null) {
    if (typeof value.maxCostMicros !== 'string' || !/^\d{1,20}$/.test(value.maxCostMicros)) fail('client_key_invalid');
    out.maxCostMicros = value.maxCostMicros;
  } else if (value.maxCostMicros === null) {
    out.maxCostMicros = null;
  }
  return Object.freeze(out);
}

function parseRetentionMode(value) {
  if (value !== 'standard' && value !== 'ephemeral') fail('client_key_invalid');
  return value;
}

/** Full persisted policy. New fields get restricted compatible defaults, never admin. */
export function parseClientKeyPolicy(input) {
  if (!isDataRecord(input)) fail('client_key_invalid');
  const required = ['schemaVersion', 'id', 'revision', 'label', 'principalId', 'projectIds', 'providerIds', 'modelIds', 'scopes', 'enabled'];
  const optional = ['expiresAt', 'limits', 'retentionMode'];
  const keys = Object.keys(input);
  if (required.some((k) => !Object.hasOwn(input, k)) || keys.some((k) => ![...required, ...optional].includes(k))) fail('client_key_invalid');
  if (input.schemaVersion !== CLIENT_KEY_SCHEMA_VERSION) fail('client_key_version_unsupported');
  if (typeof input.id !== 'string' || !UUID_V4.test(input.id)) fail('client_key_invalid');
  if (!Number.isSafeInteger(input.revision) || input.revision < 1) fail('client_key_invalid');
  if (typeof input.label !== 'string' || input.label.length < 1 || input.label.length > CLIENT_KEY_LABEL_MAX) fail('client_key_invalid');
  if (typeof input.principalId !== 'string' || input.principalId.length < 1 || input.principalId.length > 200) fail('client_key_invalid');
  if (typeof input.enabled !== 'boolean') fail('client_key_invalid');
  let expiresAt = null;
  if (input.expiresAt !== undefined && input.expiresAt !== null) {
    if (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt))) fail('client_key_invalid');
    expiresAt = new Date(Date.parse(input.expiresAt)).toISOString();
  }
  return Object.freeze({
    schemaVersion: 1,
    id: input.id,
    revision: input.revision,
    label: input.label,
    principalId: input.principalId,
    projectIds: idList(input.projectIds),
    providerIds: idList(input.providerIds),
    modelIds: idList(input.modelIds),
    scopes: parseScopes(input.scopes),
    expiresAt,
    enabled: input.enabled,
    ...(input.retentionMode !== undefined ? { retentionMode: parseRetentionMode(input.retentionMode) } : {}),
    ...(parseLimits(input.limits) !== undefined ? { limits: parseLimits(input.limits) } : {}),
  });
}

export function canonicalClientKeyPolicy(input) {
  return canonicalJson(parseClientKeyPolicy(input));
}

/** Metadata projection: never includes value/hash/credentialRef. */
export function parseClientKeyView(input) {
  if (!isDataRecord(input)) fail('client_key_view_invalid');
  const policy = parseClientKeyPolicy({
    schemaVersion: 1, id: input.id, revision: input.revision, label: input.label,
    principalId: input.principalId, projectIds: input.projectIds, providerIds: input.providerIds,
    modelIds: input.modelIds, scopes: input.scopes, expiresAt: input.expiresAt ?? null,
    enabled: input.enabled, ...(input.limits !== undefined ? { limits: input.limits } : {}),
    ...(input.retentionMode !== undefined ? { retentionMode: input.retentionMode } : {}),
  });
  for (const forbidden of ['value', 'hash', 'credentialRef', 'token', 'secret']) {
    if (Object.hasOwn(input, forbidden)) fail('client_key_view_invalid');
  }
  if (typeof input.prefixMasked !== 'string' || input.prefixMasked.length < 4 || input.prefixMasked.length > 64) fail('client_key_view_invalid');
  if (typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) fail('client_key_view_invalid');
  for (const field of ['lastUsedAt', 'revokedAt']) {
    const value = input[field] ?? null;
    if (value !== null && (typeof value !== 'string' || !Number.isFinite(Date.parse(value)))) fail('client_key_view_invalid');
  }
  if (typeof input.usageBasis !== 'string' || input.usageBasis.length < 1 || input.usageBasis.length > 120) fail('client_key_view_invalid');
  return Object.freeze({ ...policy, prefixMasked: input.prefixMasked, createdAt: input.createdAt, lastUsedAt: input.lastUsedAt ?? null, revokedAt: input.revokedAt ?? null, usageBasis: input.usageBasis });
}

/** Mutations require expectedRevision + operationId (idempotency/CAS). */
export function parseKeyMutation(input) {
  if (!isDataRecord(input)) fail('key_mutation_invalid');
  if (typeof input.operationId !== 'string' || !UUID_V4.test(input.operationId)) fail('key_mutation_invalid');
  if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) fail('key_mutation_invalid');
  const kind = input.kind;
  if (kind === 'create') {
    if (Object.keys(input).filter(key => key !== 'retentionMode').sort().join(',') !== 'expectedRevision,kind,label,limits,operationId,scopes') fail('key_mutation_invalid');
    // create uses expectedRevision:1 as sentinel; real revision assigned by store.
    if (input.expectedRevision !== 1) fail('key_mutation_invalid');
    if (typeof input.label !== 'string' || input.label.length < 1 || input.label.length > CLIENT_KEY_LABEL_MAX) fail('key_mutation_invalid');
    return Object.freeze({ kind, operationId: input.operationId, expectedRevision: 1, label: input.label, scopes: parseScopes(input.scopes), limits: parseLimits(input.limits ?? null) ?? null,
      ...(input.retentionMode !== undefined ? { retentionMode: parseRetentionMode(input.retentionMode) } : {}) });
  }
  if (kind === 'update') {
    const allowed = ['kind', 'operationId', 'expectedRevision', 'label', 'projectIds', 'providerIds', 'modelIds', 'scopes', 'expiresAt', 'enabled', 'limits', 'retentionMode'];
    if (!allowed.includes('kind') || Object.keys(input).some((k) => !allowed.includes(k))) fail('key_mutation_invalid');
    const out = { kind, operationId: input.operationId, expectedRevision: input.expectedRevision };
    if (input.label !== undefined) {
      if (typeof input.label !== 'string' || input.label.length < 1 || input.label.length > CLIENT_KEY_LABEL_MAX) fail('key_mutation_invalid');
      out.label = input.label;
    }
    for (const field of ['projectIds', 'providerIds', 'modelIds']) {
      if (input[field] !== undefined) out[field] = idList(input[field]);
    }
    if (input.scopes !== undefined) out.scopes = parseScopes(input.scopes);
    if (input.expiresAt !== undefined) {
      if (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) fail('key_mutation_invalid');
      out.expiresAt = input.expiresAt === null ? null : new Date(Date.parse(input.expiresAt)).toISOString();
    }
    if (input.enabled !== undefined) {
      if (typeof input.enabled !== 'boolean') fail('key_mutation_invalid');
      out.enabled = input.enabled;
    }
    if (input.limits !== undefined) out.limits = parseLimits(input.limits) ?? null;
    if (input.retentionMode !== undefined) out.retentionMode = parseRetentionMode(input.retentionMode);
    return Object.freeze(out);
  }
  if (kind === 'rotate' || kind === 'revoke') {
    if (Object.keys(input).sort().join(',') !== 'expectedRevision,kind,operationId') fail('key_mutation_invalid');
    return Object.freeze({ kind, operationId: input.operationId, expectedRevision: input.expectedRevision });
  }
  fail('key_mutation_invalid');
}

export const PROTOCOL_CAPABILITY_PROTOCOLS = ['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'openai-completions-legacy'];

export function parseProtocolCapability(input) {
  if (!isDataRecord(input)) fail('protocol_capability_invalid');
  const required = ['protocol', 'version', 'stream', 'toolCalls', 'structuredOutput', 'modalities', 'unsupportedFields', 'evidenceAt'];
  if (required.some((k) => !Object.hasOwn(input, k)) || Object.keys(input).some((k) => !required.includes(k))) fail('protocol_capability_invalid');
  if (!PROTOCOL_CAPABILITY_PROTOCOLS.includes(input.protocol)) fail('protocol_capability_invalid');
  if (typeof input.version !== 'string' || input.version.length < 1 || input.version.length > 40) fail('protocol_capability_invalid');
  for (const field of ['stream', 'toolCalls', 'structuredOutput']) {
    if (typeof input[field] !== 'boolean') fail('protocol_capability_invalid');
  }
  if (!Array.isArray(input.modalities) || input.modalities.length > 16 || input.modalities.some((m) => typeof m !== 'string' || m.length < 1 || m.length > 40)) fail('protocol_capability_invalid');
  if (!Array.isArray(input.unsupportedFields) || input.unsupportedFields.length > 64 || input.unsupportedFields.some((m) => typeof m !== 'string' || m.length < 1 || m.length > 80)) fail('protocol_capability_invalid');
  if (typeof input.evidenceAt !== 'string' || !Number.isFinite(Date.parse(input.evidenceAt))) fail('protocol_capability_invalid');
  return Object.freeze({ ...input, modalities: Object.freeze([...input.modalities]), unsupportedFields: Object.freeze([...input.unsupportedFields]) });
}

/** Published matrix: supported | rejected | unverified per endpoint/field. */
export const PROTOCOL_CAPABILITY_MATRIX = Object.freeze([
  { protocol: 'openai-chat-completions', version: '2026-09-20', stream: true, toolCalls: true, structuredOutput: true, modalities: ['text'], unsupportedFields: [], evidenceAt: '2026-09-20T00:00:00.000Z' },
  // Direct Responses text.format maps to Chat response_format; unsupported provider paths are excluded before dispatch.
  { protocol: 'openai-responses', version: '2026-09-25.1', stream: true, toolCalls: true, structuredOutput: true, modalities: ['text', 'image'], unsupportedFields: ['response_format', 'reasoning', 'previous_response_id', 'store', 'text.verbosity', 'hosted_tools', 'input_file'], evidenceAt: '2026-09-25T20:03:35.000Z' },
  { protocol: 'anthropic-messages', version: '2026-09-25', stream: true, toolCalls: true, structuredOutput: false, modalities: ['text'], unsupportedFields: ['parallel_tool_calls', 'response_format', 'logprobs', 'seed', 'thinking', 'server_tools', 'tool_result.is_error'], evidenceAt: '2026-09-25T00:00:00.000Z' },
  { protocol: 'openai-completions-legacy', version: '2026-09-20', stream: true, toolCalls: false, structuredOutput: false, modalities: ['text'], unsupportedFields: ['tools', 'tool_choice', 'response_format', 'messages'], evidenceAt: '2026-09-20T00:00:00.000Z' },
]);
