/** E2-03 OpenRouter management command (W0). Remote key hash is an opaque id, never the key. */
import { isDataRecord } from './plain-data.js';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const fail = () => { throw new Error('management_key_command_invalid'); };

export const MANAGEMENT_KEY_COMMANDS = ['create', 'list', 'get', 'update', 'disable', 'delete'];

export function parseManagementKeyCommand(input) {
  if (!isDataRecord(input)) fail();
  const kind = input.kind;
  if (!MANAGEMENT_KEY_COMMANDS.includes(kind)) fail();
  if (typeof input.operationId !== 'string' || !UUID_V4.test(input.operationId)) fail();
  if (kind === 'create') {
    const allowed = ['kind', 'operationId', 'name', 'expiresAt', 'limit', 'limitReset', 'includeByokInLimit'];
    if (Object.keys(input).some((k) => !allowed.includes(k))) fail();
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 80) fail();
    const out = { kind, operationId: input.operationId, name: input.name };
    if (input.expiresAt !== undefined) {
      if (input.expiresAt !== null && (typeof input.expiresAt !== 'string' || !Number.isFinite(Date.parse(input.expiresAt)))) fail();
      out.expiresAt = input.expiresAt === null ? null : new Date(Date.parse(input.expiresAt)).toISOString();
    }
    if (input.limit !== undefined) {
      if (input.limit !== null && (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit < 0)) fail();
      out.limit = input.limit ?? null;
    }
    if (input.limitReset !== undefined) {
      if (input.limitReset !== null && !['daily', 'weekly', 'monthly'].includes(input.limitReset)) fail();
      out.limitReset = input.limitReset ?? null;
    }
    if (input.includeByokInLimit !== undefined) {
      if (typeof input.includeByokInLimit !== 'boolean') fail();
      out.includeByokInLimit = input.includeByokInLimit;
    }
    return Object.freeze(out);
  }
  if (kind === 'list') {
    if (Object.keys(input).sort().join(',') !== 'kind,operationId') fail();
    return Object.freeze({ kind, operationId: input.operationId });
  }
  if (kind === 'get' || kind === 'disable' || kind === 'delete') {
    if (Object.keys(input).sort().join(',') !== 'kind,operationId,remoteKeyHash') fail();
    if (typeof input.remoteKeyHash !== 'string' || input.remoteKeyHash.length < 8 || input.remoteKeyHash.length > 128) fail();
    return Object.freeze({ kind, operationId: input.operationId, remoteKeyHash: input.remoteKeyHash });
  }
  // update
  const allowed = ['kind', 'operationId', 'remoteKeyHash', 'name', 'limit', 'includeByokInLimit', 'disabled'];
  if (Object.keys(input).some((k) => !allowed.includes(k))) fail();
  if (typeof input.remoteKeyHash !== 'string' || input.remoteKeyHash.length < 8 || input.remoteKeyHash.length > 128) fail();
  const out = { kind, operationId: input.operationId, remoteKeyHash: input.remoteKeyHash };
  if (input.name !== undefined) {
    if (typeof input.name !== 'string' || input.name.length < 1 || input.name.length > 80) fail();
    out.name = input.name;
  }
  if (input.limit !== undefined) {
    if (input.limit !== null && (typeof input.limit !== 'number' || !Number.isFinite(input.limit) || input.limit < 0)) fail();
    out.limit = input.limit ?? null;
  }
  if (input.includeByokInLimit !== undefined) {
    if (typeof input.includeByokInLimit !== 'boolean') fail();
    out.includeByokInLimit = input.includeByokInLimit;
  }
  if (input.disabled !== undefined) {
    if (typeof input.disabled !== 'boolean') fail();
    out.disabled = input.disabled;
  }
  return Object.freeze(out);
}
