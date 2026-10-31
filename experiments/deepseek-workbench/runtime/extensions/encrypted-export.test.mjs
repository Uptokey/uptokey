import assert from 'node:assert/strict';
import test from 'node:test';
import {decryptWorkspaceExport, encryptWorkspaceExport} from './encrypted-export.mjs';

const zip = Buffer.concat([Buffer.from('PK\x03\x04', 'binary'), Buffer.alloc(18), Buffer.from('PRIVATE_EXPORT_CANARY')]);
const key = Buffer.alloc(32, 7);

test('encrypted export round-trips ZIP bytes without plaintext disclosure', async () => {
  const encrypted = await encryptWorkspaceExport(zip, key);
  assert.equal(encrypted.includes(Buffer.from('PRIVATE_EXPORT_CANARY')), false);
  assert.deepEqual(await decryptWorkspaceExport(encrypted, key), zip);
});

test('export encryption is randomized and bound to its header and key', async () => {
  const first = await encryptWorkspaceExport(zip, key), second = await encryptWorkspaceExport(zip, key);
  assert.equal(first.equals(second), false);
  const tampered = Buffer.from(first); tampered[Math.floor(tampered.length / 2)] ^= 1;
  await assert.rejects(() => decryptWorkspaceExport(tampered, key), /authentication/);
  await assert.rejects(() => decryptWorkspaceExport(first, Buffer.alloc(32, 8)), /authentication/);
});

test('malformed, non-ZIP and oversized values are refused', async () => {
  await assert.rejects(() => encryptWorkspaceExport(Buffer.from('not zip'), key), /zip_invalid/);
  await assert.rejects(() => decryptWorkspaceExport(Buffer.from('UPTKEX01'), key), /workspace_export_invalid/);
  await assert.rejects(() => encryptWorkspaceExport(zip, Buffer.alloc(31)), /key_invalid/);
});
