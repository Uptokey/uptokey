import {createHash, hkdfSync, randomUUID} from 'node:crypto';
import {constants, lstatSync} from 'node:fs';
import {link, lstat, open, opendir, rename, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {AttachmentError} from '@deepseek-ai/dsh-attachment';
import z from '@deepseek-ai/schemastery';
import {VaultCrypto} from './vendor/vault-crypto.ts';
import {verifyCacheMount} from './request-image-cache.mjs';
import {encryptedStorage} from './encrypted-images.mjs';
import {encryptGenericFileStream, decryptGenericFileStream} from './generic-secretstream.mjs';
import {installMaterializationPathHydration} from './materialization-paths.mjs';
import {fileLeafName} from '../contracts/file-leaf-name.mjs';
import {sharedPreparation} from './shared-preparation.mjs';
import {installAttachmentPreview} from './attachment-preview.mjs';
import {materializationOwnership} from './materialization-ownership.mjs';
import {MaterializationEviction, materializationEviction} from './materialization-eviction.mjs';
export {fileLeafName} from '../contracts/file-leaf-name.mjs';

export const name = 'uptokey-encrypted-files';
export const inject = ['attachments', 'llm', 'fs'];
export const FILE_ROOT = '/home/node/.dsh/files-encrypted/v1';
export const FILE_MATERIALIZATION = '/home/node/.dsh/uptokey-image-materialization';
export const FILE_KEY = '/run/secrets/uptokey-workbench-vault-key';
export const Config = z.object({root: z.const(FILE_ROOT).default(FILE_ROOT), materialization: z.const(FILE_MATERIALIZATION).default(FILE_MATERIALIZATION), keyPath: z.const(FILE_KEY).default(FILE_KEY)});
const {noLinks, privateDirectory, durableDirectory, syncDirectory, aliases, readPrivate, publish, sameNode, sameFile} = encryptedStorage;
const FORMAT = 'uptokey-encrypted-files-v1', MARKER = '.uptokey-encrypted-files-v1';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const ID = /^sha256:([a-f0-9]{64})$/, PENDING = /^\.pending-[a-f0-9-]{36}$/;
const hash = value => createHash('sha256').update(value).digest('hex');
const absent = error => error?.code === 'ENOENT';
const abort = signal => signal?.throwIfAborted();
const corrupt = () => new AttachmentError('Encrypted file authentication or structure failed.', 'ATTACHMENT_CORRUPT');
const invalid = () => new AttachmentError('File attachment reference is invalid.', 'INVALID_ATTACHMENT_REF');
const closed = () => Error('encrypted_files_closed');
const poolFull = () => new AttachmentError('The volatile attachment pool is full.', 'ATTACHMENT_WRITE_FAILED', {cause: Object.assign(Error('file_materialization_capacity'), {code: 'ENOSPC'})});
const rootBinding = rootId => hash(JSON.stringify([FORMAT, 'root', rootId]));
const objectBinding = fileName => hash(JSON.stringify([FORMAT, 'file-name', fileName]));

function facts(ref, requireBytes = true) {
  const match = ID.exec(String(ref?.attachmentId));
  if (!match || typeof ref?.name !== 'string' || ref.name !== fileLeafName(ref.name)
    || requireBytes && (!Number.isSafeInteger(ref.bytes) || ref.bytes < 0)) throw invalid();
  return {digest: match[1], name: ref.name, ...(requireBytes ? {bytes: ref.bytes} : {})};
}
async function writeAll(handle, chunk, signal) {
  let offset = 0;
  while (offset < chunk.byteLength) {
    abort(signal); const {bytesWritten} = await handle.write(chunk, offset, chunk.byteLength - offset);
    if (!bytesWritten) throw Error('encrypted_file_write_failed'); offset += bytesWritten;
  }
}
async function removePending(path) {
  try { await unlink(path); } catch (error) { if (!absent(error)) throw error; }
}

/** Durable ciphertext streams; POSIX copies remain on shared RAM until both containers stop. */
export class EncryptedFileStore {
  constructor({root, materialization, keyPath, mountSnapshot, ownership = materializationOwnership, eviction = new MaterializationEviction()} = {}) {
    if (process.platform !== 'linux' || ![root, materialization, keyPath].every(value => typeof value === 'string' && isAbsolute(value))) throw Error('encrypted_files_paths_invalid');
    this.root = resolve(root); this.materialization = resolve(materialization); this.keyPath = resolve(keyPath); this.mountSnapshot = mountSnapshot;
    const contains = (a, b) => { const tail = relative(a, b); return tail === '' || !tail.startsWith('..') && !isAbsolute(tail); };
    if (contains(this.root, this.materialization) || contains(this.materialization, this.root)) throw Error('encrypted_files_paths_overlap');
    this.accepting = true; this.operations = new Map(); this.readers = new Set(); this.publications = new Map(); this.preparations = new Map(); this.ownership = ownership; this.eviction = eviction;
    this.crypto = new VaultCrypto({get: async account => {
      if (account !== 'vault:key') throw Error('encrypted_files_key_unavailable');
      const key = await this.readMaster(); try { return key.toString('hex'); } finally { key.fill(0); }
    }, set: async () => { throw Error('encrypted_files_key_readonly'); }, delete: async () => { throw Error('encrypted_files_key_readonly'); }}, {vaultId: 'deepseek-workbench', tenantScope: 'local'});
  }
  async readMaster() {
    let record;
    try {
      record = await readPrivate(this.keyPath, 64, false);
      if (record.stat.size !== 64 || (record.stat.mode & 0o777) !== 0o400) throw corrupt();
      const text = record.bytes.toString('utf8'); if (!/^[a-f0-9]{64}$/.test(text)) throw corrupt();
      const fingerprint = hash(record.bytes);
      if (this.keyFingerprint && this.keyFingerprint !== fingerprint) throw corrupt();
      this.keyFingerprint = fingerprint; return Buffer.from(text, 'hex');
    } catch { throw Error('encrypted_files_key_unavailable'); }
    finally { record?.bytes.fill(0); }
  }
  async streamKey() {
    const master = await this.readMaster();
    try { return Buffer.from(hkdfSync('sha256', master, Buffer.from(this.rootId), Buffer.from(FORMAT), 32)); }
    finally { master.fill(0); }
  }
  ready() {
    if (!this.accepting) return Promise.reject(closed());
    return this.initialization ??= this.initialize();
  }
  async initialize() {
    const mount = await verifyCacheMount(this.materialization, this.mountSnapshot);
    this.poolBytes = mount.capacityBytes; this.materialIdentity = await privateDirectory(this.materialization);
    await this.crypto.ensureVaultKey(); await durableDirectory(this.root, parse(this.root).root);
    this.rootIdentity = await privateDirectory(this.root); const marker = join(this.root, MARKER);
    try { await lstat(marker); } catch (error) {
      if (!absent(error)) throw error;
      for await (const entry of await opendir(this.root)) if (!PENDING.test(entry.name)) throw Error('encrypted_files_root_not_empty');
      const rootId = randomUUID(), plain = Buffer.from(JSON.stringify({format: FORMAT, rootId}));
      try {
        const canary = await this.crypto.encryptObject(rootBinding(rootId), plain, {resourceScope: 'file-root'});
        await publish(marker, Buffer.from(JSON.stringify({format: FORMAT, rootId, canary})), 0o600, this.root);
      } finally { plain.fill(0); }
    }
    let record, plain;
    try {
      record = await readPrivate(marker, 16384);
      const value = JSON.parse(record.bytes.toString('utf8'));
      if (!value || Object.keys(value).sort().join(',') !== 'canary,format,rootId' || value.format !== FORMAT || !UUID.test(value.rootId)) throw corrupt();
      const decoded = await this.crypto.decryptObject(value.canary, {objectId: rootBinding(value.rootId), objectVersion: 1, resourceScope: 'file-root'});
      plain = Buffer.from(decoded.buffer, decoded.byteOffset, decoded.byteLength);
      const canary = JSON.parse(plain.toString('utf8'));
      if (Object.keys(canary).sort().join(',') !== 'format,rootId' || canary.format !== FORMAT || canary.rootId !== value.rootId) throw corrupt();
      this.rootId = value.rootId; this.markerIdentity = record.stat;
    } catch { throw Error('encrypted_files_root_authentication_failed'); }
    finally { plain?.fill(0); record?.bytes.fill(0); }
    await this.checkRoots();
    this.releaseEviction = this.eviction.attach({root: this.materialization, capacityBytes: this.poolBytes, ownership: this.ownership});
  }
  async checkRoots() {
    if (!sameNode(await privateDirectory(this.root), this.rootIdentity)
      || !sameFile(await lstat(join(this.root, MARKER)), this.markerIdentity)
      || !sameNode(await privateDirectory(this.materialization), this.materialIdentity)) throw corrupt();
  }
  cipherPath(ref) { const f = facts(ref, false); return join(this.root, 'objects', f.digest.slice(0, 2), f.digest, hash(f.name) + '.ssf'); }
  materialPath(ref) { const f = facts(ref, false); return join(this.materialization, 'files', f.digest.slice(0, 2), f.digest, f.name); }
  has(ref) {
    const path = this.cipherPath(ref), root = lstatSync(this.root), marker = lstatSync(join(this.root, MARKER));
    if (!root.isDirectory() || root.isSymbolicLink() || !sameNode(root, this.rootIdentity) || !sameFile(marker, this.markerIdentity)) throw corrupt();
    let current = this.root;
    for (const part of relative(this.root, path).split(sep)) {
      current = join(current, part); let info;
      try { info = lstatSync(current); } catch (error) { if (absent(error)) return false; throw error; }
      if (info.isSymbolicLink() || current !== path && !info.isDirectory()) throw corrupt();
      if (current === path && (!info.isFile() || (info.mode & 0o777) !== 0o600)) throw corrupt();
    }
    return true;
  }
  run(signal, action) {
    if (!this.accepting) return Promise.reject(closed());
    let lease; try { lease = this.ownership.acquire('materialization'); } catch (error) { return Promise.reject(error); }
    const controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    const work = (async () => { await (this.initialization ?? this.ready()); abort(combined); await this.checkRoots(); return action(combined); })();
    this.operations.set(work, controller); void work.finally(() => { this.operations.delete(work); lease.release(); }).catch(() => {}); return work;
  }
  async *fileChunks(path, mode, signal) {
    abort(signal); await noLinks(dirname(path));
    const before = await lstat(path); await aliases(path, before, true);
    if ((before.mode & 0o777) !== mode || !Number.isSafeInteger(before.size) || before.size < 0) throw corrupt();
    const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    try {
      const opened = await handle.stat(); if (!sameFile(before, opened)) throw corrupt();
      let used = 0;
      while (used < opened.size) {
        abort(signal); const bytes = Buffer.alloc(Math.min(65536, opened.size - used));
        const {bytesRead} = await handle.read(bytes, 0, bytes.length, used); if (!bytesRead) throw corrupt();
        used += bytesRead; yield bytes.subarray(0, bytesRead);
      }
      abort(signal); if (!sameFile(opened, await handle.stat())) throw corrupt();
    } finally { await handle.close(); }
  }
  async *decode(path, f, signal, onComplete) {
    const key = await this.streamKey();
    try {
      const expected = f.bytes === undefined ? {} : {expectedSha256: f.digest, expectedBytes: f.bytes, expectedName: f.name};
      yield* decryptGenericFileStream(this.fileChunks(path, 0o600, signal), {key, rootId: this.rootId, objectId: objectBinding(f.name), signal, ...expected,
        onComplete: summary => {
          if (summary.sha256 !== f.digest || summary.name !== f.name || f.bytes !== undefined && summary.bytes !== f.bytes) throw corrupt();
          onComplete?.(summary);
        }});
    } catch (error) { abort(signal); if (error instanceof AttachmentError) throw error; throw corrupt(); }
    finally { key.fill(0); }
  }
  saveFile(input) {
    if (!(input?.data instanceof Uint8Array)) return Promise.reject(invalid());
    return this.saveFileStream({...input, data: (async function* () { yield input.data; })()});
  }
  saveFileStream(input) {
    let fileName;
    try {
      if (input?.name !== undefined && typeof input.name !== 'string') throw invalid();
      fileName = fileLeafName(input?.name); if (!input?.data || !(Symbol.asyncIterator in Object(input.data) || Symbol.iterator in Object(input.data))) throw invalid();
    }
    catch (error) { return Promise.reject(error); }
    return this.run(input.signal, async signal => {
      let temporary = join(this.root, `.pending-${randomUUID()}`), handle, key, summary;
      const digest = createHash('sha256'); let count = 0;
      const source = (async function* () {
        for await (const chunk of input.data) {
          abort(signal); if (!(chunk instanceof Uint8Array)) throw invalid();
          count += chunk.byteLength; if (!Number.isSafeInteger(count)) throw invalid();
          digest.update(chunk); yield chunk;
        }
      })();
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        key = await this.streamKey();
        for await (const chunk of encryptGenericFileStream(source, {key, rootId: this.rootId, objectId: objectBinding(fileName), name: fileName, signal, onComplete: value => { summary = value; }})) await writeAll(handle, chunk, signal);
        const sha256 = digest.digest('hex');
        if (!summary || summary.sha256 !== sha256 || summary.bytes !== count || summary.name !== fileName) throw corrupt();
        await handle.sync(); await handle.close(); handle = undefined; abort(signal);
        const ref = {attachmentId: 'sha256:' + sha256, name: fileName, bytes: count}, f = facts(ref);
        // Validate the exact ciphertext before publishing a durable reference.
        for await (const bytes of this.decode(temporary, f, signal)) bytes.fill(0);
        await this.checkRoots(); const destination = this.cipherPath(ref), previous = this.publications.get(destination) ?? Promise.resolve();
        const commit = previous.catch(() => {}).then(async () => {
          abort(signal); await durableDirectory(dirname(destination), this.root);
          const pending = join(dirname(destination), `.pending-${randomUUID()}`);
          await rename(temporary, pending); temporary = pending; await syncDirectory(this.root); abort(signal);
          try { await link(temporary, destination); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            for await (const bytes of this.decode(destination, f, signal)) bytes.fill(0);
          }
          await removePending(temporary); await syncDirectory(dirname(destination)); abort(signal);
        });
        this.publications.set(destination, commit);
        try { await commit; } finally { if (this.publications.get(destination) === commit) this.publications.delete(destination); }
        return ref;
      } finally { key?.fill(0); await handle?.close(); await removePending(temporary); }
    });
  }
  readFileStream(ref, signal) {
    const f = facts(ref), controller = new AbortController(), combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    if (!this.accepting) throw closed();
    const lease = this.ownership.acquire('attachment-reader');
    const store = this;
    const iterator = (async function* () {
      await (store.initialization ?? store.ready()); abort(combined); await store.checkRoots();
      if (!store.has(ref)) throw new AttachmentError('File attachment object is missing.', 'ATTACHMENT_NOT_FOUND');
      yield* store.decode(store.cipherPath(ref), f, combined);
    })();
    let done = false;
    const finish = () => { done = true; store.readers.delete(reader); lease.release(); };
    const reader = {
      [Symbol.asyncIterator]() { return this; },
      async next() { if (done) return {done: true, value: undefined}; try { const value = await iterator.next(); if (value.done) finish(); return value; } catch (error) { finish(); throw error; } },
      async return() { controller.abort(); try { return await iterator.return(); } finally { finish(); } },
      async throw(error) { controller.abort(); try { return await iterator.throw(error); } finally { finish(); } },
    };
    this.readers.add(reader); return reader;
  }
  hydrate(ref, signal) { facts(ref); return this.hydrateFacts(ref, signal); }
  hydrateFacts(ref, signal) {
    if (!this.accepting) return Promise.reject(closed());
    const f = facts(ref, ref.bytes !== undefined);
    const selected = {attachmentId: 'sha256:' + f.digest, name: f.name, ...(f.bytes !== undefined ? {bytes: f.bytes} : {})};
    // Different declared lengths must never share a validation result. Only
    // identical immutable facts share temporary storage and decryption work.
    const key = JSON.stringify([selected.attachmentId, selected.name, selected.bytes ?? null]);
    return sharedPreparation(this.preparations, key, signal, active => this.materializeFacts(selected, active));
  }
  materializeFacts(ref, signal) {
    const f = facts(ref, ref.bytes !== undefined), identity = this.cipherPath(ref);
    // Each operation validates its own expected facts; independent readers do
    // not inherit another caller's cancellation or unvalidated byte count.
    return this.run(signal, async active => {
      if (!this.has(ref)) throw new AttachmentError('File attachment object is missing.', 'ATTACHMENT_NOT_FOUND');
      if (f.bytes !== undefined && f.bytes > this.poolBytes) throw poolFull();
      const path = this.materialPath(ref); let exists = false, existingBytes = 0;
      try {
        const info = await lstat(path); exists = true;
        const digest = createHash('sha256');
        for await (const chunk of this.fileChunks(path, 0o400, active)) { digest.update(chunk); existingBytes += chunk.length; }
        if (digest.digest('hex') !== f.digest || info.size !== existingBytes || f.bytes !== undefined && existingBytes !== f.bytes) throw corrupt();
      } catch (error) { if (!absent(error)) throw error; }
      let temporary, handle, summary, count = 0;
      try {
        if (!exists) {
          await durableDirectory(dirname(path), this.materialization); temporary = join(dirname(path), `.pending-${randomUUID()}`);
          handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
        }
        for await (const chunk of this.decode(identity, f, active, value => { summary = value; })) {
          try {
            count += chunk.length;
            if (count > this.poolBytes) throw poolFull();
            if (handle) await writeAll(handle, chunk, active);
          } finally { chunk.fill(0); }
        }
        if (!summary || exists && existingBytes !== summary.bytes) throw corrupt();
        if (handle) {
          await handle.chmod(0o400); await handle.sync(); await handle.close(); handle = undefined; abort(active);
          try { await link(temporary, path); }
          catch (error) {
            if (error.code !== 'EEXIST') throw error;
            const digest = createHash('sha256'); let bytes = 0;
            for await (const chunk of this.fileChunks(path, 0o400, active)) { bytes += chunk.length; digest.update(chunk); }
            if (bytes !== summary.bytes || digest.digest('hex') !== f.digest) throw corrupt();
          }
          await removePending(temporary); await syncDirectory(dirname(path));
        }
        this.eviction.touch(path); abort(active); return path;
      } catch (error) { if (error?.code === 'ENOSPC' || error?.code === 'EDQUOT') throw poolFull(); throw error; }
      finally { await handle?.close(); if (temporary) await removePending(temporary); }
    });
  }
  ensureMaterializedPath(path, signal) {
    const prefix = this.materialization + '/files/';
    if (typeof path !== 'string') return Promise.resolve(false);
    const normalized = isAbsolute(path) ? resolve(path) : undefined;
    if (!path.startsWith(prefix) && !normalized?.startsWith(prefix)) return Promise.resolve(false);
    if (path !== normalized) return Promise.reject(corrupt());
    const match = /^([a-f0-9]{2})\/([a-f0-9]{64})\/([^/]+)$/.exec(path.slice(prefix.length));
    if (!match || match[1] !== match[2].slice(0, 2) || match[3] !== fileLeafName(match[3])) return Promise.reject(corrupt());
    const ref = {attachmentId: 'sha256:' + match[2], name: match[3]};
    return (async () => {
      await (this.initialization ?? this.ready()); abort(signal);
      if (!this.has(ref)) {
        await noLinks(dirname(path));
        try { await lstat(path); } catch (error) { if (absent(error)) return false; throw error; }
        throw corrupt();
      }
      await this.hydrateFacts(ref, signal); this.eviction.touch(path); return true;
    })();
  }
  close() {
    if (!this.closing) {
      this.accepting = false;
      this.closing = (async () => {
        for (const controller of this.operations.values()) controller.abort(closed());
        await Promise.allSettled([...this.readers].map(reader => reader.return()));
        await Promise.allSettled([this.initialization]);
        while (this.operations.size) await Promise.allSettled([...this.operations.keys()]);
        const release = this.releaseEviction; this.releaseEviction = undefined; release?.();
      })();
    }
    return this.closing;
  }
}

/** Four canonical generic-file APIs; legacy fallback is allowed only for absent ciphertext. */
export function installEncryptedFiles(service, store) {
  const names = ['saveFile', 'saveFileStream', 'readFileStream', 'fileHostPath'];
  if (names.some(key => typeof service?.[key] !== 'function')) throw Error('encrypted_files_provider_contract');
  const descriptors = new Map(names.map(key => [key, Object.getOwnPropertyDescriptor(service, key)]));
  const original = Object.fromEntries(names.map(key => [key, service[key]])); let stopping = false, closing;
  const check = () => { if (stopping) throw closed(); };
  const wrapped = {
    saveFile(input) { check(); return store.saveFile(input); },
    saveFileStream(input) { check(); return store.saveFileStream(input); },
    readFileStream(ref, signal) { check(); facts(ref); return store.has(ref) ? store.readFileStream(ref, signal) : original.readFileStream.call(this, ref, signal); },
    fileHostPath(ref) { check(); facts(ref); if (!store.has(ref)) return original.fileHostPath.call(this, ref); const path = store.materialPath(ref); store.eviction.touch(path); return path; },
  };
  for (const key of names) Object.defineProperty(service, key, {value: wrapped[key], configurable: true, writable: true});
  return {dispose() {
    if (!closing) { stopping = true; closing = (async () => {
      await store.close();
      for (const key of names) if (Object.getOwnPropertyDescriptor(service, key)?.value === wrapped[key]) {
        const previous = descriptors.get(key); if (previous) Object.defineProperty(service, key, previous); else delete service[key];
      }
    })(); }
    return closing;
  }};
}

/** Only references in this dispatched model request are materialized. */
export function fileReferences(messages) {
  const refs = [];
  for (const message of messages ?? []) for (const block of message.content ?? []) if (block.type === 'file') refs.push(block.attachment);
  return refs;
}
export function fileHydrationMiddleware(store) {
  return (options, next) => (async function* () {
    const selected = new Map();
    for (const ref of fileReferences(options.messages)) {
      const f = facts(ref), key = store.cipherPath(ref), previous = selected.get(key);
      if (previous && previous.bytes !== f.bytes) throw corrupt();
      selected.set(key, ref);
    }
    for (const ref of selected.values()) { abort(options.signal); if (store.has(ref)) await store.hydrate(ref, options.signal); }
    yield* next();
  })();
}

/** Rehydrate a cold path at the asynchronous filesystem boundary, including aliases. */
export function installFilePathHydration(filesystem, store) {
  return installMaterializationPathHydration(filesystem, store);
}

// Cancel owned work synchronously before waiting for wrappers whose pending
// filesystem calls may themselves be blocked inside that work.
export async function disposeEncryptedFiles(store, adapter, pathAdapter) {
  const closing = store.close();
  try { await pathAdapter?.dispose(); }
  finally { try { await adapter?.dispose(); } finally { await closing; } }
}

export async function apply(ctx, config = {}) {
  const root = config.root ?? FILE_ROOT, materialization = config.materialization ?? FILE_MATERIALIZATION, keyPath = config.keyPath ?? FILE_KEY;
  if (root !== FILE_ROOT || materialization !== FILE_MATERIALIZATION || keyPath !== FILE_KEY) throw Error('encrypted_files_paths_invalid');
  const store = new EncryptedFileStore({root, materialization, keyPath, eviction: materializationEviction}); let stopped = false, adapter, pathAdapter, previewAdapter, off;
  ctx.effect(() => async () => {
    stopped = true; off?.(); previewAdapter?.dispose();
    await disposeEncryptedFiles(store, adapter, pathAdapter);
  });
  await store.ready(); if (stopped) return;
  adapter = installEncryptedFiles(ctx.attachments, store);
  pathAdapter = installFilePathHydration(ctx.fs, store);
  previewAdapter = installAttachmentPreview(ctx.fs, ctx.attachments);
  off = ctx.on('llm/stream', fileHydrationMiddleware(store), {prepend: true});
}
