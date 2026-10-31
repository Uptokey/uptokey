import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, linkSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync, zstdCompressSync } from 'node:zlib';
import { verifyHarnessRuntimeOci, HARNESS_OCI_LIMITS } from './harness-runtime-oci.mjs';

const digest = bytes => `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
const TAR = 'application/vnd.oci.image.layer.v1.tar';
function fixture(t, { compression = '', architecture = 'amd64', platform = undefined, badDiffId = false } = {}) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uptokey oci finite ')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'blobs', 'sha256'), { recursive: true });
  const raw = Buffer.from('synthetic opaque layer; never extracted\n');
  const payload = compression === '+gzip' ? gzipSync(raw) : compression === '+zstd' ? zstdCompressSync(raw) : raw;
  function put(bytes, mediaType) {
    const hash = digest(bytes); writeFileSync(join(root, 'blobs', 'sha256', hash.slice(7)), bytes);
    return { mediaType, digest: hash, size: bytes.length };
  }
  const layer = put(payload, TAR + compression);
  const config = put(Buffer.from(JSON.stringify({ architecture, os: 'linux', config: { Env: ['SYNTHETIC_SECRET=must-never-appear'] },
    rootfs: { type: 'layers', diff_ids: [badDiffId ? `sha256:${'f'.repeat(64)}` : digest(raw)] } })), 'application/vnd.oci.image.config.v1+json');
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config, layers: [layer] };
  let descriptor;
  function publish() {
    if (descriptor) rmSync(join(root, 'blobs', 'sha256', descriptor.digest.slice(7)));
    descriptor = put(Buffer.from(JSON.stringify(manifest)), manifest.mediaType);
    writeFileSync(join(root, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ ...descriptor, ...(platform ? { platform } : {}) }] }));
  }
  writeFileSync(join(root, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' })); publish();
  return { root, raw, layer, config, manifest, publish, expectedImageId: config.digest,
    layerPath: join(root, 'blobs', 'sha256', layer.digest.slice(7)) };
}

test('verifies opaque tar and bounded gzip/zstd streams without returning config/ENV', async t => {
  for (const compression of ['', '+gzip', '+zstd']) {
    const value = fixture(t, { compression });
    const result = await verifyHarnessRuntimeOci(value.root, { expectedImageId: value.expectedImageId.slice(7), os: 'linux', architecture: 'amd64' });
    assert.equal(result.imageId, value.expectedImageId); assert.equal(result.layerCount, 1);
    assert.equal(result.blobCount, 3); assert.equal(result.fileCount, 5);
    assert.equal(result.uncompressedBytes, value.raw.length); assert.match(result.metadataSha256, /^[a-f0-9]{64}$/);
    assert.ok(!JSON.stringify(result).includes('SYNTHETIC_SECRET')); assert.ok(!Object.hasOwn(result, 'config'));
  }
});

test('rejects corrupted and truncated blobs, wrong image identity, and config/layer mismatch', async t => {
  const corrupted = fixture(t); writeFileSync(corrupted.layerPath, Buffer.alloc(corrupted.layer.size, 120));
  await assert.rejects(verifyHarnessRuntimeOci(corrupted.root, corrupted), /blob_digest_mismatch/);
  const truncated = fixture(t); writeFileSync(truncated.layerPath, Buffer.from('short'));
  await assert.rejects(verifyHarnessRuntimeOci(truncated.root, truncated), /blob_size_mismatch/);
  const identity = fixture(t);
  await assert.rejects(verifyHarnessRuntimeOci(identity.root, { expectedImageId: '0'.repeat(64) }), /image_identity_mismatch/);
  for (const compression of ['', '+gzip', '+zstd']) {
    const mismatch = fixture(t, { compression, badDiffId: true });
    await assert.rejects(verifyHarnessRuntimeOci(mismatch.root, mismatch), /diff_id_mismatch/);
  }
  const invalidCompression = fixture(t); invalidCompression.manifest.layers[0].mediaType = `${TAR}+gzip`; invalidCompression.publish();
  await assert.rejects(verifyHarnessRuntimeOci(invalidCompression.root, invalidCompression), /layer_compression_invalid/);
});

test('rejects extra blobs/files, traversal descriptors and remote or embedded content', async t => {
  const extraBlob = fixture(t); writeFileSync(join(extraBlob.root, 'blobs', 'sha256', 'a'.repeat(64)), 'extra');
  await assert.rejects(verifyHarnessRuntimeOci(extraBlob.root, extraBlob), /unreferenced_blob/);
  const extraFile = fixture(t); writeFileSync(join(extraFile.root, 'manifest.json'), '{}');
  await assert.rejects(verifyHarnessRuntimeOci(extraFile.root, extraFile), /unlisted_entry/);
  for (const update of [{ digest: 'sha256:../../escape' }, { urls: ['https://example.invalid/layer'] }, { data: 'eA==' }]) {
    const value = fixture(t); Object.assign(value.manifest.layers[0], update); value.publish();
    await assert.rejects(verifyHarnessRuntimeOci(value.root, value), /descriptor_invalid|schema_invalid/);
  }
});

test('rejects foreign architecture at descriptor or config, invalid JSON and oversize declarations', async t => {
  for (const options of [{ architecture: 'arm64' }, { platform: { os: 'linux', architecture: 'arm64' } }]) {
    const value = fixture(t, options);
    await assert.rejects(verifyHarnessRuntimeOci(value.root, value), /platform_mismatch/);
  }
  const json = fixture(t); writeFileSync(join(json.root, 'index.json'), '{');
  await assert.rejects(verifyHarnessRuntimeOci(json.root, json), /json_invalid/);
  const size = fixture(t); size.manifest.layers[0].size = HARNESS_OCI_LIMITS.blobBytes + 1; size.publish();
  await assert.rejects(verifyHarnessRuntimeOci(size.root, size), /descriptor_invalid/);
  const bounded = fixture(t); writeFileSync(join(bounded.root, 'oci-layout'), Buffer.alloc(HARNESS_OCI_LIMITS.layoutBytes + 1, 32));
  await assert.rejects(verifyHarnessRuntimeOci(bounded.root, bounded), /json_limit/);
});

test('filesystem links and redirected ancestors fail closed', async t => {
  const linked = fixture(t), external = realpathSync(mkdtempSync(join(tmpdir(), 'uptokey oci hardlink '))), copy = join(external, 'outside-layer');
  t.after(() => rmSync(external, { recursive: true, force: true }));
  writeFileSync(copy, readFileSync(linked.layerPath)); rmSync(linked.layerPath); linkSync(copy, linked.layerPath);
  await assert.rejects(verifyHarnessRuntimeOci(linked.root, linked), /file_invalid/);
  const redirected = fixture(t), parent = realpathSync(mkdtempSync(join(tmpdir(), 'uptokey oci link ')));
  t.after(() => rmSync(parent, { recursive: true, force: true }));
  const alias = join(parent, 'alias'); symlinkSync(redirected.root, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verifyHarnessRuntimeOci(alias, redirected), /link_denied/);
});
