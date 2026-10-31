import assert from 'node:assert/strict';
import { test } from 'node:test';
import { parseFilesystemReadRequest, parseFilesystemCatalog, canonicalFilesystemReadPayload, FILESYSTEM_TEXT_MAX_LINES } from '../filesystem.js';

const base = { schemaVersion: 1, relativePath: 'notes/a.txt', profileDigest: 'a'.repeat(64), schemaDigest: 'b'.repeat(64) };

test('read_text_file requires a bounded line window; metadata tools refuse it', () => {
  const text = parseFilesystemReadRequest({ ...base, tool: 'read_text_file', lineLimit: 20 });
  assert.equal(text.lineLimit, 20);
  assert.ok(Object.isFrozen(text));
  for (const lineLimit of [0, -1, 1.5, FILESYSTEM_TEXT_MAX_LINES + 1, '20', null]) {
    assert.throws(() => parseFilesystemReadRequest({ ...base, tool: 'read_text_file', lineLimit }), /filesystem_read_invalid/);
  }
  assert.throws(() => parseFilesystemReadRequest({ ...base, tool: 'read_text_file' }), /filesystem_read_invalid/);
  assert.throws(() => parseFilesystemReadRequest({ ...base, tool: 'list_directory', lineLimit: 5 }), /filesystem_read_invalid/);
  // Upstream arguments the profile does not admit never pass through the contract.
  assert.throws(() => parseFilesystemReadRequest({ ...base, tool: 'read_text_file', lineLimit: 5, tail: 5 }), /filesystem_read_invalid/);
  for (const tool of ['write_file', 'read_media_file', 'read_multiple_files', 'search_files', 'edit_file']) {
    assert.throws(() => parseFilesystemReadRequest({ ...base, tool }), /filesystem_read_invalid/);
  }
  assert.deepEqual(parseFilesystemReadRequest({ ...base, tool: 'get_file_info' }), { ...base, tool: 'get_file_info' });
  assert.notEqual(canonicalFilesystemReadPayload({ ...base, tool: 'read_text_file', lineLimit: 1 }),
    canonicalFilesystemReadPayload({ ...base, tool: 'read_text_file', lineLimit: 2 }));
});

test('catalog v2 carries status, diagnostic code and limits without paths; v1 stays readable', () => {
  const tools = [{ name: 'list_directory', schemaDigest: 'b'.repeat(64) }, { name: 'read_text_file', schemaDigest: 'c'.repeat(64) }];
  const limits = { maxOutputBytes: 65536, timeoutMs: 120000, maxLines: 1000 };
  const available = { schemaVersion: 2, available: true, status: 'available', diagnostic: null, profileDigest: 'a'.repeat(64), tools, limits };
  assert.deepEqual(parseFilesystemCatalog(available), available);
  const failed = { schemaVersion: 2, available: false, status: 'discovery_failed', diagnostic: 'mcp_package_invalid', profileDigest: null, tools: [], limits: null };
  assert.deepEqual(parseFilesystemCatalog(failed), failed);
  const off = { ...failed, status: 'not_configured', diagnostic: null };
  assert.deepEqual(parseFilesystemCatalog(off), off);
  for (const value of [
    { ...available, status: 'discovery_failed' }, { ...available, diagnostic: 'mcp_package_invalid' },
    { ...available, limits: null }, { ...available, limits: { ...limits, root: 'C:/private' } },
    { ...available, limits: { ...limits, maxLines: FILESYSTEM_TEXT_MAX_LINES + 1 } }, { ...available, allowedRoot: 'C:/private' },
    { ...failed, diagnostic: 'ENOENT C:/private/path' }, { ...failed, diagnostic: null }, { ...failed, limits },
    { ...off, diagnostic: 'mcp_package_invalid' }, { ...available, tools: [...tools, tools[0]] },
  ]) assert.throws(() => parseFilesystemCatalog(value), /filesystem_catalog_invalid/);
  const v1 = { schemaVersion: 1, available: true, profileDigest: 'a'.repeat(64), tools: [tools[0]] };
  assert.deepEqual(parseFilesystemCatalog(v1), v1);
  assert.throws(() => parseFilesystemCatalog({ ...v1, tools }), /filesystem_catalog_invalid/);
});
