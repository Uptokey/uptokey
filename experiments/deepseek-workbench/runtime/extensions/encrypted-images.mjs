import {createHash, randomUUID} from 'node:crypto';
import {constants, lstatSync} from 'node:fs';
import {link, lstat, mkdir, open, opendir, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {AttachmentError} from '@deepseek-ai/dsh-attachment';
import {prepareImageFile, readImageFile} from '@deepseek-ai/dsh-attachment-local';
import {FsError} from '@deepseek-ai/dsh-fs';
import z from '@deepseek-ai/schemastery';
import {VaultCrypto} from './vendor/vault-crypto.ts';
import {verifyCacheMount} from './request-image-cache.mjs';
import {materializationParts} from '../execution/image-path.mjs';
import {installMaterializationPathHydration} from './materialization-paths.mjs';
import {materializationOwnership} from './materialization-ownership.mjs';
import {MaterializationEviction, materializationEviction} from './materialization-eviction.mjs';

export const name = 'uptokey-encrypted-images';
export const inject = ['attachments', 'llm', 'fs'];
export const IMAGE_ROOT = '/home/node/.dsh/images-encrypted/v1';
export const IMAGE_MATERIALIZATION = '/home/node/.dsh/uptokey-image-materialization';
export const IMAGE_KEY = '/run/secrets/uptokey-workbench-vault-key';
export const Config = z.object({
  root: z.const(IMAGE_ROOT).default(IMAGE_ROOT),
  materialization: z.const(IMAGE_MATERIALIZATION).default(IMAGE_MATERIALIZATION),
  keyPath: z.const(IMAGE_KEY).default(IMAGE_KEY),
});
const FORMAT = 'uptokey-encrypted-images-v1';
const MARKER = '.uptokey-encrypted-images-v1';
const ID = /^sha256:([a-f0-9]{64})$/;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const PENDING = /^\.pending-[a-f0-9-]{36}$/;
export const IMAGE_PAYLOAD_LIMIT = 64 * 1024 * 1024;
const ENVELOPE_LIMIT = Math.ceil(IMAGE_PAYLOAD_LIMIT * 4 / 3) + 16384;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
// Shared immutable-storage guards; generic files keep their own stream codec.
export const encryptedStorage = {noLinks, privateDirectory, durableDirectory, syncDirectory, aliases, readPrivate, publish, sameNode, sameFile};
const absent = error => error?.code === 'ENOENT';
const corrupt = () => new AttachmentError('Encrypted image authentication or structure failed.', 'ATTACHMENT_CORRUPT');
const abort = signal => signal?.throwIfAborted();
const poolFull = () => new AttachmentError('The volatile image materialization pool is full.', 'ATTACHMENT_WRITE_FAILED', {cause: Object.assign(Error('image_materialization_capacity'), {code: 'ENOSPC'})});
const objectId = (rootId, id) => hash(JSON.stringify([FORMAT, rootId, id]));
const rootIdBinding = id => hash(JSON.stringify([FORMAT, 'root', id]));

function imageHash(ref) {
  const match = ID.exec(String(ref?.attachmentId));
  if (!match) throw new AttachmentError('Attachment reference is invalid.', 'INVALID_ATTACHMENT_REF');
  return match[1];
}
function referenceFacts(ref) {
  imageHash(ref);
  if (!['image/png', 'image/jpeg', 'image/webp', 'image/gif'].includes(ref.mediaType)
    || ![ref.bytes, ref.width, ref.height].every(value => Number.isSafeInteger(value) && value > 0)) throw corrupt();
  return JSON.stringify([ref.attachmentId, ref.mediaType, ref.bytes, ref.width, ref.height]);
}
async function noLinks(path) {
  let current = parse(path).root;
  for (const part of relative(current, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    try { if ((await lstat(current)).isSymbolicLink()) throw corrupt(); }
    catch (error) { if (absent(error)) return; throw error; }
  }
}
async function privateDirectory(path, create = false) {
  await noLinks(path);
  if (create) await mkdir(path, {recursive: true, mode: 0o700});
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o700
    || process.getuid && stat.uid !== process.getuid()) throw corrupt();
  return stat;
}
async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}
// Same publication rule as attachment-local: persist every ancestor entry,
// including one observed while another writer is still creating it.
async function durableDirectory(path, boundary) {
  await privateDirectory(path, true);
  let level = resolve(path), stop = resolve(boundary);
  const tail = relative(stop, level);
  if (tail.startsWith('..') || isAbsolute(tail)) throw corrupt();
  while (level !== stop) {
    const parent = dirname(level); await syncDirectory(parent); level = parent;
  }
}
async function aliases(path, stat, pendingAllowed) {
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink < 1 || ![0o400, 0o600].includes(stat.mode & 0o777)) throw corrupt();
  if (process.getuid && stat.uid !== process.getuid()) throw corrupt();
  if (stat.nlink === 1) return;
  if (!pendingAllowed) throw corrupt();
  await privateDirectory(dirname(path));
  let count = 0;
  for await (const entry of await opendir(dirname(path))) {
    if (!PENDING.test(entry.name)) continue;
    const candidate = await lstat(join(dirname(path), entry.name));
    if (sameNode(candidate, stat)) {
      if (!candidate.isFile() || candidate.isSymbolicLink() || candidate.nlink !== stat.nlink || candidate.mode !== stat.mode) throw corrupt();
      count++;
    }
  }
  if (count !== stat.nlink - 1) throw corrupt();
}
async function readPrivate(path, limit, pendingAllowed = true, signal) {
  abort(signal);
  await noLinks(dirname(path));
  const before = await lstat(path); await aliases(path, before, pendingAllowed);
  if (!Number.isSafeInteger(before.size) || before.size < 1 || before.size > limit) throw corrupt();
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let bytes;
  try {
    const stat = await handle.stat(); await aliases(path, stat, pendingAllowed);
    if (!sameFile(stat, before)) throw corrupt();
    bytes = Buffer.alloc(stat.size + 1); let used = 0;
    while (used < bytes.length) {
      abort(signal);
      const {bytesRead} = await handle.read(bytes, used, Math.min(65536, bytes.length - used), used);
      if (!bytesRead) break; used += bytesRead;
    }
    abort(signal);
    if (used !== stat.size || !sameFile(stat, await handle.stat())) throw corrupt();
    return {bytes: bytes.subarray(0, used), stat};
  } catch (error) { bytes?.fill(0); throw error; }
  finally { await handle.close(); }
}
async function publish(path, bytes, mode, boundary) {
  await durableDirectory(dirname(path), boundary);
  const temporary = join(dirname(path), `.pending-${randomUUID()}`); let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    let used = 0;
    while (used < bytes.length) {
      const {bytesWritten} = await handle.write(bytes, used, bytes.length - used, used);
      if (!bytesWritten) throw Error('encrypted_image_write_failed'); used += bytesWritten;
    }
    await handle.chmod(mode); await handle.sync(); await handle.close(); handle = undefined;
    try { await link(temporary, path); } catch (error) { if (error.code !== 'EEXIST') throw error; }
    await unlink(temporary); await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    try { await unlink(temporary); } catch (error) { if (!absent(error)) throw error; }
  }
}
function waitFor(work, signal) {
  abort(signal);
  if (!signal) return work;
  return new Promise((resolveWork, reject) => {
    const cancelled = () => reject(signal.reason);
    signal.addEventListener('abort', cancelled, {once: true});
    work.then(resolveWork, reject).finally(() => signal.removeEventListener('abort', cancelled)).catch(() => {});
  });
}

/** Cipher objects are durable; normalized tool objects exist only on the verified noswap tmpfs. */
export class EncryptedImageStore {
  constructor({root, materialization, keyPath, mountSnapshot, ownership = materializationOwnership, eviction = new MaterializationEviction()} = {}) {
    if (process.platform !== 'linux' || ![root, materialization, keyPath].every(path => typeof path === 'string' && isAbsolute(path))) throw Error('encrypted_images_paths_invalid');
    this.root = resolve(root); this.materialization = resolve(materialization); this.keyPath = resolve(keyPath);
    const contained = (a, b) => { const tail = relative(a, b); return tail === '' || !tail.startsWith('..') && !isAbsolute(tail); };
    if (contained(this.root, this.materialization) || contained(this.materialization, this.root)) throw Error('encrypted_images_paths_overlap');
    this.mountSnapshot = mountSnapshot; this.accepting = true; this.pending = new Set(); this.hydrations = new Map(); this.writes = new Map(); this.ownership = ownership; this.eviction = eviction;
    const secrets = {
      get: async account => {
        if (account !== 'vault:key') throw Error('encrypted_images_key_unavailable');
        let record;
        try {
          record = await readPrivate(this.keyPath, 64, false);
          if (record.stat.size !== 64 || (record.stat.mode & 0o777) !== 0o400) throw Error();
          const value = record.bytes.toString('utf8');
          if (!/^[a-f0-9]{64}$/.test(value)) throw Error();
          const fingerprint = hash(record.bytes);
          if (this.keyFingerprint && this.keyFingerprint !== fingerprint) throw Error();
          this.keyFingerprint = fingerprint; return value;
        } catch { throw Error('encrypted_images_key_unavailable'); }
        finally { record?.bytes.fill(0); }
      },
      set: async () => { throw Error('encrypted_images_key_readonly'); },
      delete: async () => { throw Error('encrypted_images_key_readonly'); },
    };
    this.crypto = new VaultCrypto(secrets, {vaultId: 'deepseek-workbench', tenantScope: 'local'});
  }
  ready() {
    if (!this.accepting) return Promise.reject(Error('encrypted_images_closed'));
    return this.initialization ??= this.initialize();
  }
  async initialize() {
    const mount = await verifyCacheMount(this.materialization, this.mountSnapshot);
    this.poolBytes = mount.capacityBytes; this.materialIdentity = await privateDirectory(this.materialization);
    await this.crypto.ensureVaultKey();
    await durableDirectory(this.root, parse(this.root).root);
    this.rootIdentity = await privateDirectory(this.root);
    const marker = join(this.root, MARKER);
    try { await lstat(marker); }
    catch (error) {
      if (!absent(error)) throw error;
      for await (const entry of await opendir(this.root)) if (!PENDING.test(entry.name)) throw Error('encrypted_images_root_not_empty');
      const rootId = randomUUID(), plain = Buffer.from(JSON.stringify({format: FORMAT, rootId}));
      try {
        const canary = await this.crypto.encryptObject(rootIdBinding(rootId), plain, {resourceScope: 'image-root'});
        await publish(marker, Buffer.from(JSON.stringify({format: FORMAT, rootId, canary})), 0o600, this.root);
      } finally { plain.fill(0); }
    }
    let record, plain;
    try {
      record = await readPrivate(marker, 16384);
      const value = JSON.parse(record.bytes.toString('utf8'));
      if (!value || Object.keys(value).sort().join(',') !== 'canary,format,rootId' || value.format !== FORMAT
        || !UUID.test(value.rootId) || value.canary?.schemaVersion !== 2) throw corrupt();
      const decoded = await this.crypto.decryptObject(value.canary, {objectId: rootIdBinding(value.rootId), objectVersion: 1, resourceScope: 'image-root'});
      plain = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const canary = JSON.parse(plain.toString('utf8'));
      if (Object.keys(canary).sort().join(',') !== 'format,rootId' || canary.format !== FORMAT || canary.rootId !== value.rootId) throw corrupt();
      this.rootId = value.rootId; this.markerIdentity = record.stat;
    } catch { throw Error('encrypted_images_root_authentication_failed'); }
    finally { plain?.fill(0); record?.bytes.fill(0); }
    await this.checkRoots();
    this.releaseEviction = this.eviction.attach({root: this.materialization, capacityBytes: this.poolBytes, ownership: this.ownership});
  }
  cipherPath(ref) { const id = imageHash(ref); return join(this.root, 'objects', id.slice(0, 2), id + '.json'); }
  materialPath(ref) { const id = imageHash(ref); return join(this.materialization, 'objects', id.slice(0, 2), id); }
  async checkRoots() {
    if (!sameNode(await privateDirectory(this.root), this.rootIdentity)
      || !sameFile(await lstat(join(this.root, MARKER)), this.markerIdentity)
      || !sameNode(await privateDirectory(this.materialization), this.materialIdentity)) throw corrupt();
  }
  has(ref) {
    const path = this.cipherPath(ref);
    const root = lstatSync(this.root), marker = lstatSync(join(this.root, MARKER));
    if (!root.isDirectory() || root.isSymbolicLink() || !sameNode(root, this.rootIdentity) || !sameFile(marker, this.markerIdentity)) throw corrupt();
    let current = this.root;
    for (const part of relative(this.root, path).split(sep)) {
      current = join(current, part);
      let stat; try { stat = lstatSync(current); } catch (error) { if (absent(error)) return false; throw error; }
      if (stat.isSymbolicLink() || current !== path && !stat.isDirectory()) throw corrupt();
      if (current === path && (!stat.isFile() || (stat.mode & 0o777) !== 0o600)) throw corrupt();
    }
    return true;
  }
  run(action) {
    if (!this.accepting) return Promise.reject(Error('encrypted_images_closed'));
    let lease; try { lease = this.ownership.acquire('materialization'); } catch (error) { return Promise.reject(error); }
    const work = (async () => { await (this.initialization ?? this.ready()); await this.checkRoots(); return action(); })();
    this.pending.add(work); void work.finally(() => { this.pending.delete(work); lease.release(); }).catch(() => {}); return work;
  }
  async decrypt(ref) {
    return this.decryptDigest(imageHash(ref), ref.bytes);
  }
  async decryptDigest(digest, expectedBytes) {
    let record, plain;
    try {
      const ref = {attachmentId: 'sha256:' + digest}; imageHash(ref);
      record = await readPrivate(this.cipherPath(ref), ENVELOPE_LIMIT);
      const envelope = JSON.parse(record.bytes.toString('utf8'));
      if (envelope?.schemaVersion !== 2) throw corrupt();
      const decoded = await this.crypto.decryptObject(envelope, {objectId: objectId(this.rootId, ref.attachmentId), objectVersion: 1, resourceScope: 'image-normalized'});
      plain = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      if (plain.length < 1 || plain.length > IMAGE_PAYLOAD_LIMIT || hash(plain) !== digest
        || expectedBytes !== undefined && plain.length !== expectedBytes) throw corrupt();
      const result = plain; plain = undefined; return result;
    } catch (error) { if (error instanceof AttachmentError) throw error; throw corrupt(); }
    finally { plain?.fill(0); record?.bytes.fill(0); }
  }
  async hydrateOwned(ref, supplied) {
    await this.checkRoots();
    const path = this.materialPath(ref);
    let bytes = supplied;
    try {
      // Re-authenticate durable bytes even when this process already has a
      // volatile copy; hot reads cannot conceal a changed key/cipher object.
      bytes ??= await this.decrypt(ref);
      try {
        const stat = await lstat(path); await noLinks(dirname(path)); await aliases(path, stat, true);
        if ((stat.mode & 0o777) !== 0o400 || stat.size !== bytes.length) throw corrupt();
        this.eviction.touch(path); return;
      } catch (error) { if (!absent(error)) throw error; }
      if (bytes.length > this.poolBytes) throw poolFull();
      await publish(path, bytes, 0o400, this.materialization); this.eviction.touch(path);
    } catch (error) {
      if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') throw poolFull();
      throw error;
    } finally { if (supplied === undefined) bytes?.fill(0); }
  }
  hydrateShared(ref, supplied) {
    const id = imageHash(ref);
    let work = this.hydrations.get(id);
    if (!work) {
      work = this.hydrateOwned(ref, supplied); this.hydrations.set(id, work);
      void work.finally(() => { if (this.hydrations.get(id) === work) this.hydrations.delete(id); }).catch(() => {});
    }
    return work;
  }
  read(ref, signal) {
    abort(signal); referenceFacts(ref);
    return this.run(async () => {
      await waitFor(this.hydrateShared(ref), signal); abort(signal);
      // Public canonical verifier checks digest, byte count, media type and dimensions.
      const result = await readImageFile(this.materialization, ref, signal); this.eviction.touch(this.materialPath(ref)); return result;
    });
  }
  ensureMaterializedPath(path, signal) {
    // Only this exact owner namespace may trigger decryption. Generic paths,
    // legacy objects retain their filesystem behavior.
    if (typeof path !== 'string') return Promise.resolve(false);
    const normalized = isAbsolute(path) ? resolve(path) : undefined;
    const owns = value => value === this.materialization || value?.startsWith(this.materialization + '/');
    if (!owns(path) && !owns(normalized)) return Promise.resolve(false);
    // Generic files have a separate authenticated owner in the same RAM pool.
    // Only its exact namespace is delegated; malformed pool paths still fail.
    if (materializationParts(path, this.materialization)?.[0] === 'files') return Promise.resolve(false);
    if (normalized !== path || !path.startsWith(this.materialization + '/objects/')) return Promise.reject(corrupt());
    const tail = path.slice(this.materialization.length + '/objects/'.length), match = /^([a-f0-9]{2})\/([a-f0-9]{64})$/.exec(tail);
    if (!match || match[1] !== match[2].slice(0, 2)) return Promise.reject(corrupt());
    abort(signal);
    const ref = {attachmentId: 'sha256:' + match[2]};
    return this.run(async () => {
      abort(signal);
      if (!this.has(ref)) {
        await noLinks(dirname(path));
        try { await lstat(path); }
        catch (error) { if (absent(error)) return false; throw error; }
        // A surviving plaintext inode may not bypass a removed cipher object.
        throw corrupt();
      }
      await waitFor(this.hydrateShared(ref), signal); abort(signal);
      let record;
      try {
        record = await readPrivate(path, IMAGE_PAYLOAD_LIMIT, true, signal);
        if ((record.stat.mode & 0o777) !== 0o400 || hash(record.bytes) !== match[2]) throw corrupt();
      } finally { record?.bytes.fill(0); }
      this.eviction.touch(path); abort(signal); return true;
    });
  }
  savePrepared(prepared) {
    const ref = prepared.ref; referenceFacts(ref);
    return this.run(async () => {
      if (prepared.data.byteLength !== ref.bytes || hash(prepared.data) !== imageHash(ref)) throw corrupt();
      const id = imageHash(ref), prior = this.writes.get(id) ?? Promise.resolve();
      const work = prior.catch(() => {}).then(async () => {
        if (this.has(ref)) { const bytes = await this.decrypt(ref); bytes.fill(0); }
        else {
          if (prepared.data.byteLength > this.poolBytes) throw poolFull();
          const envelope = await this.crypto.encryptObject(objectId(this.rootId, ref.attachmentId), prepared.data, {resourceScope: 'image-normalized'});
          await publish(this.cipherPath(ref), Buffer.from(JSON.stringify(envelope)), 0o600, this.root);
          const check = await this.decrypt(ref); check.fill(0);
        }
        await this.hydrateShared(ref, prepared.data);
        const checked = await readImageFile(this.materialization, ref); checked.data.fill(0);
        return ref;
      });
      this.writes.set(id, work);
      void work.finally(() => { if (this.writes.get(id) === work) this.writes.delete(id); }).catch(() => {});
      return work;
    });
  }
  async hydrateReferences(refs, signal) {
    const unique = new Map();
    for (const ref of refs) {
      const facts = referenceFacts(ref), id = imageHash(ref);
      if (unique.has(id) && unique.get(id).facts !== facts) throw corrupt();
      unique.set(id, {ref, facts});
    }
    // Sequential hydration bounds transient buffers; the normalizer's original limiter stays separate.
    for (const {ref} of unique.values()) {
      abort(signal); if (!this.has(ref)) continue;
      const stored = await this.read(ref, signal); stored.data.fill(0);
    }
  }
  close() {
    if (!this.closing) {
      this.accepting = false;
      this.closing = (async () => {
        await Promise.allSettled([this.initialization]);
        while (this.pending.size || this.hydrations.size || this.writes.size) await Promise.allSettled([...this.pending, ...this.hydrations.values(), ...this.writes.values()]);
        const release = this.releaseEviction; this.releaseEviction = undefined; release?.();
      })();
    }
    return this.closing;
  }
}

export function imageReferences(messages) {
  const refs = [];
  for (const message of messages ?? []) for (const block of message.content ?? []) if (block.type === 'image') refs.push(block.attachment);
  return refs;
}
/** This public waterfall runs before adapterStream projects text-only/offloaded images. */
export function imageHydrationMiddleware(store) {
  return (options, next) => (async function* () {
    await store.hydrateReferences(imageReferences(options.messages), options.signal);
    yield* next();
  })();
}

export function installEncryptedImages(service, store) {
  if (typeof service?.compression?.run !== 'function' || typeof service.validateImageBatch !== 'function'
    || !service.imageLimits || !service.normalizationPolicy) throw Error('encrypted_images_provider_contract');
  const names = ['saveImage', 'saveImages', 'readImage', 'imageHostPath'];
  const descriptors = new Map(names.map(key => [key, Object.getOwnPropertyDescriptor(service, key)]));
  const original = Object.fromEntries(names.map(key => [key, service[key]]));
  const pending = new Set(); let stopping = false, closing;
  const track = action => {
    if (stopping) return Promise.reject(Error('encrypted_images_closed'));
    const work = Promise.resolve().then(action); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work)); return work;
  };
  const prepare = input => service.compression.run(() => prepareImageFile(input, service.imageLimits, service.normalizationPolicy));
  const wrapped = {
    saveImage(input) { return track(async () => store.savePrepared(await prepare(input))); },
    saveImages(inputs) { return track(async () => {
      service.validateImageBatch(inputs);
      const prepared = await Promise.all(inputs.map(prepare));
      const refs = []; for (const item of prepared) refs.push(await store.savePrepared(item)); return refs;
    }); },
    readImage(ref, signal) { const receiver = this; return track(() => store.has(ref) ? store.read(ref, signal) : original.readImage.apply(receiver, [ref, signal])); },
    imageHostPath(ref) { if (!store.has(ref)) return original.imageHostPath.apply(this, [ref]); const path = store.materialPath(ref); store.eviction.touch(path); return path; },
  };
  for (const key of names) Object.defineProperty(service, key, {value: wrapped[key], configurable: true, writable: true});
  return {dispose() {
    if (!closing) {
      stopping = true;
      closing = (async () => {
        await Promise.allSettled([...pending]);
        for (const key of names) if (Object.getOwnPropertyDescriptor(service, key)?.value === wrapped[key]) {
          const previous = descriptors.get(key); if (previous) Object.defineProperty(service, key, previous); else delete service[key];
        }
        await store.close();
      })();
    }
    return closing;
  }};
}

/** Async filesystem seam; the synchronous topology/pricing mapper stays pure. */
export function installImagePathHydration(filesystem, store) {
  return installMaterializationPathHydration(filesystem, store);
}

export async function apply(ctx, config = {}) {
  const root = config.root ?? IMAGE_ROOT, materialization = config.materialization ?? IMAGE_MATERIALIZATION, keyPath = config.keyPath ?? IMAGE_KEY;
  if (root !== IMAGE_ROOT || materialization !== IMAGE_MATERIALIZATION || keyPath !== IMAGE_KEY) throw Error('encrypted_images_paths_invalid');
  const store = new EncryptedImageStore({root, materialization, keyPath, eviction: materializationEviction}); let stopped = false, adapter, pathAdapter, off;
  ctx.effect(() => async () => {
    stopped = true; off?.();
    try { await pathAdapter?.dispose(); }
    finally { if (adapter) await adapter.dispose(); else await store.close(); }
  });
  await store.ready();
  if (stopped) return;
  adapter = installEncryptedImages(ctx.attachments, store);
  pathAdapter = installImagePathHydration(ctx.fs, store);
  off = ctx.on('llm/stream', imageHydrationMiddleware(store), {prepend: true});
}
