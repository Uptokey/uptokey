import { createHash } from 'node:crypto';
import { createReadStream, lstatSync, readdirSync, realpathSync, openSync, readSync, closeSync, fstatSync } from 'node:fs';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import { Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip, createZstdDecompress } from 'node:zlib';
import { sha256File } from './verify-sidecar.mjs';

// Deliberately narrower than generic OCI: one complete local Linux/amd64 image.
// OCI v1.1.1 image-layout.md, descriptor.md, manifest.md and config.md define
// the graph and the distinction between encoded layer digest and rootfs DiffID.
// No archive extraction, tar interpretation, image import or process execution.
const HEX = /^[a-f0-9]{64}$/;
const DIGEST = /^sha256:[a-f0-9]{64}$/;
const INDEX = 'application/vnd.oci.image.index.v1+json';
const MANIFEST = 'application/vnd.oci.image.manifest.v1+json';
const CONFIG = 'application/vnd.oci.image.config.v1+json';
const TAR = 'application/vnd.oci.image.layer.v1.tar';
const LAYERS = new Set([TAR, `${TAR}+gzip`, `${TAR}+zstd`]);
export const HARNESS_OCI_LIMITS = Object.freeze({
  jsonBytes: 8 * 1024 * 1024, layoutBytes: 4096, layers: 256,
  blobBytes: 8 * 1024 ** 3, totalBytes: 16 * 1024 ** 3,
  uncompressedLayerBytes: 8 * 1024 ** 3, uncompressedTotalBytes: 16 * 1024 ** 3,
  inflateTimeoutMs: 300_000,
});
const fail = code => { throw Error(`harness_oci_${code}`); };
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => createHash('sha256').update(value).digest('hex');
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
function fields(value, allowed) { if (!record(value) || Object.keys(value).some(key => !allowed.includes(key))) fail('schema_invalid'); }

function safePath(path, directory = false) {
  for (let at = path; ; at = dirname(at)) {
    const stat = lstatSync(at);
    if (stat.isSymbolicLink() || toNamespacedPath(realpathSync.native(at)) !== toNamespacedPath(at)) fail('link_denied');
    if (at !== path && !stat.isDirectory()) fail('path_invalid');
    if (dirname(at) === at) break;
  }
  const stat = lstatSync(path);
  if (directory ? !stat.isDirectory() : !stat.isFile() || stat.nlink !== 1) fail('file_invalid');
  return stat;
}

function inventory(root) {
  safePath(root, true);
  if (JSON.stringify(readdirSync(root).sort()) !== JSON.stringify(['blobs', 'index.json', 'oci-layout'])) fail('unlisted_entry');
  safePath(join(root, 'blobs'), true);
  if (JSON.stringify(readdirSync(join(root, 'blobs')).sort()) !== JSON.stringify(['sha256'])) fail('unlisted_entry');
  safePath(join(root, 'blobs', 'sha256'), true);
  const blobs = readdirSync(join(root, 'blobs', 'sha256')).sort();
  if (blobs.length < 2 || blobs.length > HARNESS_OCI_LIMITS.layers + 2 || blobs.some(name => !HEX.test(name))) fail('blob_inventory_invalid');
  const entries = new Map(); let totalBytes = 0;
  for (const name of ['oci-layout', 'index.json', ...blobs.map(name => `blobs/sha256/${name}`)]) {
    const stat = safePath(join(root, ...name.split('/')));
    if (!Number.isSafeInteger(stat.size) || stat.size <= 0 || stat.size > HARNESS_OCI_LIMITS.blobBytes) fail('size_invalid');
    totalBytes += stat.size;
    if (totalBytes > HARNESS_OCI_LIMITS.totalBytes) fail('total_limit');
    entries.set(name, { size: stat.size, signature: signature(stat) });
  }
  return { entries, totalBytes };
}

function unchanged(path, entry) {
  if (signature(safePath(path)) !== entry.signature) fail('file_changed');
}

function jsonFile(root, name, entries, limit = HARNESS_OCI_LIMITS.jsonBytes) {
  const entry = entries.get(name);
  if (!entry || entry.size > limit) fail('json_limit');
  const path = join(root, ...name.split('/')); unchanged(path, entry);
  const fd = openSync(path, 'r'), buffer = Buffer.alloc(entry.size + 1); let length = 0;
  try {
    if (signature(fstatSync(fd)) !== entry.signature) fail('file_changed');
    while (length < buffer.length) {
      const count = readSync(fd, buffer, length, buffer.length - length, null);
      if (!count) break;
      length += count;
    }
    if (length !== entry.size || signature(fstatSync(fd)) !== entry.signature) fail('file_changed');
  } finally { closeSync(fd); }
  unchanged(path, entry);
  const bytes = buffer.subarray(0, length); let value;
  try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)); } catch { fail('json_invalid'); }
  if (!record(value)) fail('json_invalid');
  return { value, sha256: hash(bytes) };
}

function platform(value) {
  if (!record(value) || value.os !== 'linux' || value.architecture !== 'amd64'
    || (value.variant !== undefined && value.variant !== '' && value.variant !== 'v1')) fail('platform_mismatch');
}

function descriptor(value, mediaTypes, limit = HARNESS_OCI_LIMITS.blobBytes) {
  fields(value, ['mediaType', 'digest', 'size', 'annotations', 'platform']);
  if (!mediaTypes.has(value.mediaType) || !DIGEST.test(value.digest)
    || !Number.isSafeInteger(value.size) || value.size <= 0 || value.size > limit) fail('descriptor_invalid');
  if (value.platform !== undefined) platform(value.platform);
  return value;
}

async function decodedLayer(path, mediaType, remainingBytes) {
  const stream = mediaType.endsWith('+gzip') ? createGunzip() : createZstdDecompress();
  const digest = createHash('sha256'); let bytes = 0;
  const sink = new Writable({ write(chunk, _encoding, done) {
    bytes += chunk.length;
    if (bytes > Math.min(HARNESS_OCI_LIMITS.uncompressedLayerBytes, remainingBytes)) return done(Error('harness_oci_uncompressed_limit'));
    digest.update(chunk); done();
  } });
  try { await pipeline(createReadStream(path, { highWaterMark: 64 * 1024 }), stream, sink, { signal: AbortSignal.timeout(HARNESS_OCI_LIMITS.inflateTimeoutMs) }); }
  catch (error) { if (error.message === 'harness_oci_uncompressed_limit') throw error; fail('layer_compression_invalid'); }
  return { bytes, digest: `sha256:${digest.digest('hex')}` };
}

/** Verify a finite OCI directory. Output intentionally contains no config/ENV. */
export async function verifyHarnessRuntimeOci(directory, { expectedImageId, architecture = 'amd64', os = 'linux' } = {}) {
  try {
    if (typeof expectedImageId !== 'string' || !/^(?:sha256:)?[a-f0-9]{64}$/.test(expectedImageId)) fail('expected_image_invalid');
    if (architecture !== 'amd64' || os !== 'linux') fail('platform_unsupported');
    const imageId = expectedImageId.startsWith('sha256:') ? expectedImageId : `sha256:${expectedImageId}`;
    const root = resolve(directory), { entries, totalBytes } = inventory(root);
    const layout = jsonFile(root, 'oci-layout', entries, HARNESS_OCI_LIMITS.layoutBytes);
    fields(layout.value, ['imageLayoutVersion']);
    if (layout.value.imageLayoutVersion !== '1.0.0') fail('layout_invalid');
    const index = jsonFile(root, 'index.json', entries);
    fields(index.value, ['schemaVersion', 'mediaType', 'manifests', 'annotations']);
    if (index.value.schemaVersion !== 2 || (index.value.mediaType !== undefined && index.value.mediaType !== INDEX)
      || !Array.isArray(index.value.manifests) || index.value.manifests.length !== 1) fail('index_invalid');
    const referenced = new Map();
    function blob(desc) {
      const name = `blobs/sha256/${desc.digest.slice(7)}`, entry = entries.get(name), path = join(root, ...name.split('/'));
      if (!entry || entry.size !== desc.size) fail('blob_size_mismatch');
      const prior = referenced.get(name);
      if (prior) { if (prior.mediaType !== desc.mediaType || prior.size !== desc.size) fail('descriptor_conflict'); return { name, path, entry }; }
      unchanged(path, entry);
      if (sha256File(path) !== desc.digest.slice(7)) fail('blob_digest_mismatch');
      unchanged(path, entry); referenced.set(name, { ...desc });
      return { name, path, entry };
    }
    const manifestDescriptor = descriptor(index.value.manifests[0], new Set([MANIFEST]), HARNESS_OCI_LIMITS.jsonBytes);
    const manifestBlob = blob(manifestDescriptor), manifest = jsonFile(root, manifestBlob.name, entries);
    if (`sha256:${manifest.sha256}` !== manifestDescriptor.digest) fail('file_changed');
    fields(manifest.value, ['schemaVersion', 'mediaType', 'config', 'layers', 'annotations']);
    if (manifest.value.schemaVersion !== 2 || (manifest.value.mediaType !== undefined && manifest.value.mediaType !== MANIFEST)
      || !Array.isArray(manifest.value.layers) || !manifest.value.layers.length || manifest.value.layers.length > HARNESS_OCI_LIMITS.layers) fail('manifest_invalid');
    const configDescriptor = descriptor(manifest.value.config, new Set([CONFIG]), HARNESS_OCI_LIMITS.jsonBytes);
    if (configDescriptor.digest !== imageId) fail('image_identity_mismatch');
    const configBlob = blob(configDescriptor), config = jsonFile(root, configBlob.name, entries);
    if (`sha256:${config.sha256}` !== imageId) fail('file_changed');
    platform(config.value);
    const diffIds = config.value.rootfs?.diff_ids;
    if (config.value.rootfs?.type !== 'layers' || !Array.isArray(diffIds) || diffIds.length !== manifest.value.layers.length
      || diffIds.some(value => typeof value !== 'string' || !DIGEST.test(value))) fail('rootfs_invalid');
    const layers = manifest.value.layers.map(value => descriptor(value, LAYERS));
    let uncompressedBytes = 0, layerBytes = 0;
    for (let i = 0; i < layers.length; i++) {
      const layer = layers[i], verified = blob(layer);
      const decoded = layer.mediaType === TAR ? { bytes: layer.size, digest: layer.digest }
        : await decodedLayer(verified.path, layer.mediaType, HARNESS_OCI_LIMITS.uncompressedTotalBytes - uncompressedBytes);
      unchanged(verified.path, verified.entry);
      if (decoded.digest !== diffIds[i]) fail('diff_id_mismatch');
      uncompressedBytes += decoded.bytes; layerBytes += layer.size;
      if (uncompressedBytes > HARNESS_OCI_LIMITS.uncompressedTotalBytes) fail('uncompressed_limit');
    }
    if (entries.size !== referenced.size + 2 || [...entries.keys()].some(name => name.startsWith('blobs/') && !referenced.has(name))) fail('unreferenced_blob');
    const finalInventory = inventory(root);
    if (finalInventory.entries.size !== entries.size || [...entries].some(([name, item]) => finalInventory.entries.get(name)?.signature !== item.signature)) fail('file_changed');
    const metadataSha256 = hash(JSON.stringify({ schema: 'uptokey.harness.oci.metadata.v1', layoutSha256: layout.sha256, indexSha256: index.sha256,
      blobs: [...referenced].sort(([a], [b]) => a.localeCompare(b)).map(([name, item]) => ({ name, size: item.size, digest: item.digest })) }));
    return { schema: 'uptokey.harness.oci.verified.v1', imageId, manifestDigest: manifestDescriptor.digest,
      indexSha256: index.sha256, layoutSha256: layout.sha256, metadataSha256, os, architecture,
      layerCount: layers.length, blobCount: referenced.size, fileCount: entries.size, totalBytes, layerBytes, uncompressedBytes };
  } catch (error) { if (/^harness_oci_[a-z_]+$/.test(error.message)) throw error; fail('unavailable'); }
}
