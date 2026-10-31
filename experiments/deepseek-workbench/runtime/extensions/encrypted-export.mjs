import {randomUUID} from 'node:crypto';
import {decryptGenericFileStream, encryptGenericFileStream} from './generic-secretstream.mjs';

export const ENCRYPTED_EXPORT_FORMAT = 'uptokey-encrypted-export-v1';
export const MAX_WORKSPACE_ARCHIVE_BYTES = 34 * 1024 * 1024;
export const MAX_ENCRYPTED_EXPORT_BYTES = 35 * 1024 * 1024;
const MAGIC = Buffer.from('UPTKEX01', 'ascii');
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const NAME = 'uptokey-workspace.zip';
const fail = code => Object.assign(Error(code), {code});

function key(value) {
  if (!(value instanceof Uint8Array) || value.byteLength !== 32) throw fail('workspace_export_key_invalid');
  return value;
}

export async function encryptWorkspaceExport(bytes, secret) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 22 || bytes.byteLength > MAX_WORKSPACE_ARCHIVE_BYTES
    || !Buffer.from(bytes.buffer, bytes.byteOffset, Math.min(4, bytes.byteLength)).equals(Buffer.from('PK\x03\x04', 'binary'))) {
    throw fail('workspace_export_zip_invalid');
  }
  const rootId = randomUUID(), objectId = randomUUID(), header = Buffer.from(JSON.stringify({format: ENCRYPTED_EXPORT_FORMAT, rootId, objectId}));
  if (header.length > 1024) throw fail('workspace_export_header_invalid');
  const prefix = Buffer.allocUnsafe(MAGIC.length + 2 + header.length); MAGIC.copy(prefix); prefix.writeUInt16BE(header.length, MAGIC.length); header.copy(prefix, MAGIC.length + 2);
  const output = [prefix];
  async function* source() { yield bytes; }
  for await (const chunk of encryptGenericFileStream(source(), {key: key(secret), rootId, objectId, name: NAME})) output.push(Buffer.from(chunk));
  const result = Buffer.concat(output);
  if (result.length > MAX_ENCRYPTED_EXPORT_BYTES) throw fail('workspace_export_encrypted_too_large');
  return result;
}

export async function decryptWorkspaceExport(bytes, secret) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < MAGIC.length + 3 || bytes.byteLength > MAX_ENCRYPTED_EXPORT_BYTES) throw fail('workspace_export_invalid');
  const input = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (!input.subarray(0, MAGIC.length).equals(MAGIC)) throw fail('workspace_export_invalid');
  const headerLength = input.readUInt16BE(MAGIC.length), offset = MAGIC.length + 2 + headerLength;
  if (!headerLength || headerLength > 1024 || offset >= input.length) throw fail('workspace_export_invalid');
  let header;
  try { header = JSON.parse(input.subarray(MAGIC.length + 2, offset).toString('utf8')); } catch { throw fail('workspace_export_invalid'); }
  if (!header || typeof header !== 'object' || Array.isArray(header) || Object.keys(header).sort().join(',') !== 'format,objectId,rootId'
    || header.format !== ENCRYPTED_EXPORT_FORMAT || !UUID.test(header.rootId) || !UUID.test(header.objectId)) throw fail('workspace_export_invalid');
  let metadata; const output = [];
  async function* source() { yield input.subarray(offset); }
  try {
    let length = 0;
    for await (const chunk of decryptGenericFileStream(source(), {key: key(secret), rootId: header.rootId, objectId: header.objectId,
      onComplete: value => { metadata = value; }})) {
      length += chunk.length; if (length > MAX_WORKSPACE_ARCHIVE_BYTES) throw fail('workspace_export_zip_invalid'); output.push(Buffer.from(chunk));
    }
    const result = Buffer.concat(output);
    if (!metadata || metadata.name !== NAME || metadata.bytes !== result.length || result.length < 22 || !result.subarray(0, 4).equals(Buffer.from('PK\x03\x04', 'binary'))) {
      throw fail('workspace_export_zip_invalid');
    }
    return result;
  } catch (error) {
    for (const chunk of output) chunk.fill(0);
    if (error?.code === 'workspace_export_zip_invalid') throw error;
    throw fail('workspace_export_authentication_failed');
  }
}
