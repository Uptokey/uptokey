import {createHash, hkdfSync, randomUUID} from 'node:crypto';
import {constants, watch as watchNative} from 'node:fs';
import {chmod, cp, lstat, mkdir, open, opendir, readFile, readlink, rename, rm, symlink, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {VaultCrypto} from './vendor/vault-crypto.ts';
import {decryptGenericFileStream, encryptGenericFileStream} from './generic-secretstream.mjs';
import {encryptedStorage} from './encrypted-images.mjs';

export const WORKSPACE_ROOT = '/workspace';
export const WORKSPACE_STORE = '/home/node/.dsh/workspace-encrypted/v1';
export const WORKSPACE_KEY = '/run/secrets/uptokey-workbench-vault-key';
export const WORKSPACE_SEED = '/opt/harness/demo';
export const WORKSPACE_FORMAT = 'uptokey-encrypted-workspace-v1';
const MARKER = '.uptokey-encrypted-workspace-v1';
const MANIFEST = 'manifest.json';
const OBJECTS = 'objects';
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const MAX_ENTRIES = 20000;
const MAX_MANIFEST_BYTES = 32 * 1024 * 1024;
const {durableDirectory, privateDirectory, readPrivate, syncDirectory} = encryptedStorage;
const absent = error => error?.code === 'ENOENT';
const abort = signal => signal?.throwIfAborted();
const sameFile = (a, b) => a.dev === b.dev && a.ino === b.ino && a.size === b.size
  && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const fail = code => Object.assign(Error(code), {code});
const compareText = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const concurrentMutation = error => ['workspace_changed', 'ENOENT', 'EAGAIN', 'EBUSY', 'ENOTEMPTY'].includes(error?.code ?? error?.message);
const retryTurn = attempt => new Promise(resolve => setTimeout(resolve, Math.min(32, 2 ** Math.min(attempt, 5))));

function decodeMountPath(value) {
  return value.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(Number.parseInt(octal, 8)));
}

/** Require a shared volatile filesystem, while retaining executable workspace files. */
export function assertWorkspaceTmpfs(mountInfo, workspace = WORKSPACE_ROOT) {
  const target = resolve(workspace);
  for (const line of String(mountInfo).split(/\r?\n/)) {
    const halves = line.split(' - ');
    if (halves.length !== 2) continue;
    const left = halves[0].split(' '), right = halves[1].split(' ');
    if (left.length < 6 || decodeMountPath(left[4]) !== target) continue;
    const options = new Set(`${left[5]},${right.slice(2).join(',')}`.split(','));
    if (right[0] !== 'tmpfs' || !options.has('rw') || !options.has('nosuid') || !options.has('nodev') || !options.has('noswap')) {
      throw fail('workspace_mount_not_volatile');
    }
    return true;
  }
  throw fail('workspace_mount_missing');
}

function validRelativePath(value) {
  if (typeof value !== 'string' || !value || value.includes('\\') || value.includes('\0') || isAbsolute(value)) return false;
  const parts = value.split('/');
  return parts.length <= 64 && parts.every(part => part && part !== '.' && part !== '..' && Buffer.byteLength(part) <= 255);
}

function strictKeys(value, keys) {
  return value && typeof value === 'object' && !Array.isArray(value)
    && Object.keys(value).sort().join(',') === [...keys].sort().join(',');
}

function validateManifest(value, rootId) {
  if (!strictKeys(value, ['format', 'rootId', 'sequence', 'entries']) || value.format !== WORKSPACE_FORMAT
    || value.rootId !== rootId || !Number.isSafeInteger(value.sequence) || value.sequence < 1
    || !Array.isArray(value.entries) || value.entries.length > MAX_ENTRIES) throw fail('workspace_manifest_invalid');
  let previous = '';
  const objects = new Set();
  for (const entry of value.entries) {
    if (!strictKeys(entry, entry.type === 'file'
      ? ['path', 'type', 'mode', 'objectId', 'bytes', 'sha256']
      : entry.type === 'symlink' ? ['path', 'type', 'mode', 'target'] : ['path', 'type', 'mode'])
      || !validRelativePath(entry.path) || entry.path <= previous
      || !Number.isSafeInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777) throw fail('workspace_manifest_invalid');
    previous = entry.path;
    if (entry.type === 'file') {
      if (!UUID.test(entry.objectId) || !Number.isSafeInteger(entry.bytes) || entry.bytes < 0
        || !/^[a-f0-9]{64}$/.test(entry.sha256) || objects.has(entry.objectId)) throw fail('workspace_manifest_invalid');
      objects.add(entry.objectId);
    } else if (entry.type === 'symlink') {
      if (typeof entry.target !== 'string' || !entry.target || entry.target.includes('\0') || Buffer.byteLength(entry.target) > 4096) {
        throw fail('workspace_manifest_invalid');
      }
    } else if (entry.type !== 'directory') throw fail('workspace_manifest_invalid');
  }
  return value;
}

async function readMaster(path) {
  const stat = await lstat(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || stat.size !== 64
    || process.platform !== 'win32' && ((stat.mode & 0o777) !== 0o400 || process.getuid && stat.uid !== process.getuid())) {
    throw fail('workspace_key_unavailable');
  }
  const bytes = await readFile(path);
  try {
    const text = bytes.toString('utf8');
    if (!/^[a-f0-9]{64}$/.test(text)) throw fail('workspace_key_unavailable');
    return Buffer.from(text, 'hex');
  } finally { bytes.fill(0); }
}

async function writeAll(handle, bytes) {
  let offset = 0;
  while (offset < bytes.length) {
    const {bytesWritten} = await handle.write(bytes, offset, bytes.length - offset, null);
    if (!bytesWritten) throw fail('workspace_write_failed');
    offset += bytesWritten;
  }
}

async function atomicReplace(path, bytes, mode = 0o600) {
  const temporary = join(dirname(path), `.pending-${randomUUID()}`);
  let handle;
  try {
    handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), mode);
    await writeAll(handle, bytes); await handle.sync(); await handle.close(); handle = undefined;
    await rename(temporary, path); await syncDirectory(dirname(path));
  } finally {
    await handle?.close();
    try { await unlink(temporary); } catch (error) { if (!absent(error)) throw error; }
  }
}

async function* fileChunks(path, expected, signal) {
  const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW || 0) | (constants.O_NONBLOCK || 0));
  const chunk = Buffer.allocUnsafe(64 * 1024);
  try {
    const before = await handle.stat();
    if (!sameFile(before, expected) || !before.isFile() || before.nlink !== 1) throw fail('workspace_changed');
    for (;;) {
      abort(signal);
      const {bytesRead} = await handle.read(chunk, 0, chunk.length, null);
      if (!bytesRead) break;
      yield Buffer.from(chunk.subarray(0, bytesRead));
    }
    if (!sameFile(before, await handle.stat())) throw fail('workspace_changed');
  } finally { chunk.fill(0); await handle.close(); }
}

async function hashFile(path, expected, signal) {
  const digest = createHash('sha256'); let bytes = 0;
  for await (const chunk of fileChunks(path, expected, signal)) { digest.update(chunk); bytes += chunk.length; chunk.fill(0); }
  return {sha256: digest.digest('hex'), bytes};
}

async function safeEntries(path) {
  const entries = [];
  for await (const entry of await opendir(path)) entries.push(entry);
  entries.sort((a, b) => compareText(a.name, b.name));
  return entries;
}

async function inventory(root, signal) {
  const entries = [];
  let count = 0;
  const walk = async (directory, prefix, depth) => {
    if (depth > 64) throw fail('workspace_depth_limit');
    for (const item of await safeEntries(directory)) {
      abort(signal);
      if (!item.name || item.name.includes('/') || item.name.includes('\\') || item.name.includes('\0') || Buffer.byteLength(item.name) > 255) {
        throw fail('workspace_path_invalid');
      }
      const relativePath = prefix ? `${prefix}/${item.name}` : item.name;
      if (++count > MAX_ENTRIES) throw fail('workspace_entry_limit');
      const path = join(directory, item.name), stat = await lstat(path), mode = stat.mode & 0o777;
      if (stat.isDirectory() && !stat.isSymbolicLink()) {
        entries.push({path: relativePath, type: 'directory', mode}); await walk(path, relativePath, depth + 1);
      } else if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) {
        entries.push({path: relativePath, type: 'file', mode, stat});
      } else if (stat.isSymbolicLink()) {
        entries.push({path: relativePath, type: 'symlink', mode, target: await readlink(path)});
      } else throw fail('workspace_type_unsupported');
    }
  };
  await walk(root, '', 0);
  return entries;
}

async function inventoryFacts(root, signal) {
  const entries = await inventory(root, signal), facts = [];
  for (const entry of entries) {
    if (entry.type === 'file') {
      const value = await hashFile(join(root, ...entry.path.split('/')), entry.stat, signal);
      facts.push({path: entry.path, type: entry.type, mode: entry.mode, ...value});
    } else if (entry.type === 'symlink') facts.push({path: entry.path, type: entry.type, mode: entry.mode, target: entry.target});
    else facts.push({path: entry.path, type: entry.type, mode: entry.mode});
  }
  return facts;
}

function overlaps(left, right) {
  const a = resolve(left), b = resolve(right), ab = relative(a, b), ba = relative(b, a);
  return a === b || ab && !ab.startsWith(`..${sep}`) && ab !== '..' || ba && !ba.startsWith(`..${sep}`) && ba !== '..';
}

async function emptyDirectory(path) {
  for await (const _ of await opendir(path)) return false;
  return true;
}

export class EncryptedWorkspaceStore {
  constructor({workspace = WORKSPACE_ROOT, store = WORKSPACE_STORE, keyPath = WORKSPACE_KEY, seed = WORKSPACE_SEED,
    requireTmpfs = true, mountInfoPath = '/proc/self/mountinfo', logger = console, onFailure} = {}) {
    this.workspace = resolve(workspace); this.store = resolve(store); this.keyPath = resolve(keyPath); this.seed = seed && resolve(seed);
    this.requireTmpfs = requireTmpfs; this.mountInfoPath = mountInfoPath; this.logger = logger;
    this.onFailure = onFailure;
    this.objects = join(this.store, OBJECTS); this.markerPath = join(this.store, MARKER); this.manifestPath = join(this.store, MANIFEST);
    this.accepting = true; this.tail = Promise.resolve(); this.flushPromise = undefined;
    this.dirtyRevision = 0; this.persistedRevision = 0; this.sequence = 0; this.entries = [];
  }

  async initialize() {
    if (this.requireTmpfs) assertWorkspaceTmpfs(await readFile(this.mountInfoPath, 'utf8'), this.workspace);
    const workspaceStat = await lstat(this.workspace);
    if (!workspaceStat.isDirectory() || workspaceStat.isSymbolicLink()
      || process.platform !== 'win32' && process.getuid && workspaceStat.uid !== process.getuid()) throw fail('workspace_root_invalid');
    await durableDirectory(this.store, parse(this.store).root); await durableDirectory(this.objects, this.store);
    this.storeIdentity = await privateDirectory(this.store); this.objectIdentity = await privateDirectory(this.objects);
    this.master = await readMaster(this.keyPath);
    this.crypto = new VaultCrypto({get: async account => {
      if (account !== 'vault:key') throw fail('workspace_key_unavailable'); return this.master.toString('hex');
    }, set: async () => { throw fail('workspace_key_readonly'); }, delete: async () => { throw fail('workspace_key_readonly'); }},
    {vaultId: 'deepseek-workbench', tenantScope: 'local', maxPayloadBytes: MAX_MANIFEST_BYTES});
    let marker;
    try { marker = JSON.parse((await readPrivate(this.markerPath, 4096, false)).bytes.toString('utf8')); }
    catch (error) { if (!absent(error)) throw fail('workspace_store_invalid'); }
    if (marker === undefined) {
      if (!(await emptyDirectory(this.objects))) throw fail('workspace_store_invalid');
      this.rootId = randomUUID();
      await atomicReplace(this.markerPath, Buffer.from(JSON.stringify({format: WORKSPACE_FORMAT, rootId: this.rootId})), 0o600);
      if (await emptyDirectory(this.workspace) && this.seed) {
        try { await lstat(this.seed); await cp(this.seed, join(this.workspace, 'demo'), {recursive: true, errorOnExist: true, force: false, preserveTimestamps: true}); }
        catch (error) { if (!absent(error)) throw error; }
      }
    } else {
      if (!strictKeys(marker, ['format', 'rootId']) || marker.format !== WORKSPACE_FORMAT || !UUID.test(marker.rootId)) throw fail('workspace_store_invalid');
      this.rootId = marker.rootId;
      const opened = await readPrivate(this.manifestPath, MAX_MANIFEST_BYTES * 2, false);
      let envelope, plain;
      try {
        envelope = JSON.parse(opened.bytes.toString('utf8'));
        const decrypted = await this.crypto.decryptObject(envelope, {objectId: this.rootId, resourceScope: 'workspace-manifest'});
        plain = Buffer.from(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
        const manifest = validateManifest(JSON.parse(plain.toString('utf8')), this.rootId);
        this.sequence = manifest.sequence; this.entries = manifest.entries;
      } catch { throw fail('workspace_store_authentication_failed'); }
      finally { opened.bytes.fill(0); plain?.fill(0); }
      if (!(await emptyDirectory(this.workspace))) throw fail('workspace_restore_not_empty');
      this.streamKey = Buffer.from(hkdfSync('sha256', this.master, Buffer.from(this.rootId), Buffer.from(WORKSPACE_FORMAT), 32));
      await this.restore();
    }
    this.streamKey ??= Buffer.from(hkdfSync('sha256', this.master, Buffer.from(this.rootId), Buffer.from(WORKSPACE_FORMAT), 32));
    this.watcher = watchNative(this.workspace, {recursive: true, persistent: false}, () => this.schedule());
    this.watcher.on('error', error => this.fail(error));
    await this.checkpoint();
    return this;
  }

  schedule() {
    if (!this.accepting || this.importing) return;
    this.dirtyRevision++;
    this.flushDirty();
  }

  flushDirty() {
    if (!this.accepting || this.importing || this.flushPromise) return;
    this.flushPromise = (async () => {
      let transientAttempts = 0;
      while (this.accepting && !this.importing && this.persistedRevision < this.dirtyRevision) {
        const target = this.dirtyRevision;
        try { await this.checkpoint(); }
        catch (error) {
          if (!concurrentMutation(error)) throw error;
          await retryTurn(transientAttempts++);
          continue;
        }
        this.persistedRevision = target;
        transientAttempts = 0;
      }
    })().catch(error => this.fail(error)).finally(() => {
      this.flushPromise = undefined;
      if (this.accepting && !this.importing && this.persistedRevision < this.dirtyRevision) this.flushDirty();
    });
  }

  fail(error) {
    if (this.failure) return;
    this.failure = error; this.accepting = false;
    this.logger.error?.('Uptokey workspace persistence failed; stopping the runtime.');
    try { this.onFailure?.(error); } catch {}
  }

  checkpoint() {
    if (!this.accepting) return Promise.reject(fail('workspace_store_closed'));
    const operation = this.tail.then(() => this.commit());
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  importFrom(source) {
    if (!this.accepting) return Promise.reject(fail('workspace_store_closed'));
    if (this.importing) return Promise.reject(fail('workspace_import_active'));
    this.importing = true;
    const operation = this.tail.then(() => this.importSource(source)).finally(() => { this.importing = false; });
    this.tail = operation.catch(() => undefined);
    return operation;
  }

  async importSource(source) {
    const input = resolve(source), sourceStat = await lstat(input);
    if (!sourceStat.isDirectory() || sourceStat.isSymbolicLink() || overlaps(input, this.workspace) || overlaps(input, this.store)
      || this.sequence !== 1 || this.entries.length !== 0 || !(await emptyDirectory(this.workspace))) throw fail('workspace_import_invalid');
    const controller = new AbortController(), before = await inventoryFacts(input, controller.signal);
    try {
      for (const item of await safeEntries(input)) {
        await cp(join(input, item.name), join(this.workspace, item.name), {
          recursive: true, errorOnExist: true, force: false, preserveTimestamps: true, verbatimSymlinks: true,
        });
      }
      const after = await inventoryFacts(input, controller.signal);
      if (JSON.stringify(before) !== JSON.stringify(after)) throw fail('workspace_import_changed');
      await this.commit();
      const committed = this.entries.map(entry => entry.type === 'file'
        ? {path: entry.path, type: entry.type, mode: entry.mode, sha256: entry.sha256, bytes: entry.bytes}
        : entry.type === 'symlink' ? {path: entry.path, type: entry.type, mode: entry.mode, target: entry.target}
          : {path: entry.path, type: entry.type, mode: entry.mode});
      if (JSON.stringify(before) !== JSON.stringify(committed)) throw fail('workspace_import_verification_failed');
      const digest = createHash('sha256').update(JSON.stringify(committed)).digest('hex');
      return {sequence: this.sequence, entries: committed.length,
        files: committed.filter(entry => entry.type === 'file').length,
        bytes: committed.reduce((sum, entry) => sum + (entry.bytes ?? 0), 0), digest};
    } catch (error) {
      for (const item of await safeEntries(this.workspace)) await rm(join(this.workspace, item.name), {recursive: true, force: true});
      throw error;
    }
  }

  async commit() {
    const controller = new AbortController();
    const scanned = await inventory(this.workspace, controller.signal), previous = new Map(this.entries.map(entry => [entry.path, entry]));
    const entries = [], referenced = new Set();
    for (const item of scanned) {
      if (item.type !== 'file') { entries.push(item); continue; }
      const facts = await hashFile(join(this.workspace, ...item.path.split('/')), item.stat, controller.signal);
      const old = previous.get(item.path);
      if (old?.type === 'file' && old.sha256 === facts.sha256 && old.bytes === facts.bytes && old.mode === item.mode) {
        entries.push(old); referenced.add(old.objectId); continue;
      }
      const objectId = randomUUID(), destination = join(this.objects, `${objectId}.bin`), temporary = join(this.objects, `.pending-${randomUUID()}`);
      let handle, metadata;
      try {
        handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
        const source = fileChunks(join(this.workspace, ...item.path.split('/')), item.stat, controller.signal);
        for await (const chunk of encryptGenericFileStream(source, {key: this.streamKey, rootId: this.rootId, objectId,
          name: basename(item.path), signal: controller.signal, onComplete: value => { metadata = value; }})) await writeAll(handle, chunk);
        if (!metadata || metadata.sha256 !== facts.sha256 || metadata.bytes !== facts.bytes) throw fail('workspace_changed');
        await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, destination); await syncDirectory(this.objects);
      } finally {
        await handle?.close(); try { await unlink(temporary); } catch (error) { if (!absent(error)) throw error; }
      }
      entries.push({path: item.path, type: 'file', mode: item.mode, objectId, bytes: facts.bytes, sha256: facts.sha256}); referenced.add(objectId);
    }
    entries.sort((a, b) => compareText(a.path, b.path));
    const manifest = {format: WORKSPACE_FORMAT, rootId: this.rootId, sequence: this.sequence + 1, entries};
    validateManifest(manifest, this.rootId);
    const plain = Buffer.from(JSON.stringify(manifest));
    try {
      const envelope = await this.crypto.encryptObject(this.rootId, plain, {objectVersion: manifest.sequence, resourceScope: 'workspace-manifest'});
      await atomicReplace(this.manifestPath, Buffer.from(JSON.stringify(envelope)), 0o600);
    } finally { plain.fill(0); }
    this.sequence = manifest.sequence; this.entries = entries;
    for await (const item of await opendir(this.objects)) {
      if (item.name.startsWith('.pending-')) { await rm(join(this.objects, item.name), {force: true}); continue; }
      const match = /^([a-f0-9-]{36})\.bin$/.exec(item.name);
      if (!match || !UUID.test(match[1])) throw fail('workspace_store_invalid');
      if (!referenced.has(match[1])) await unlink(join(this.objects, item.name));
    }
    await syncDirectory(this.objects);
  }

  async restore() {
    const staging = join(this.workspace, `.uptokey-restore-${randomUUID()}`);
    await mkdir(staging, {mode: 0o700});
    try {
      for (const entry of this.entries.filter(entry => entry.type === 'directory')) {
        await mkdir(join(staging, ...entry.path.split('/')), {recursive: true, mode: 0o700});
      }
      for (const entry of this.entries.filter(entry => entry.type === 'file')) {
        const target = join(staging, ...entry.path.split('/')), temporary = join(dirname(target), `.uptokey-file-${randomUUID()}`);
        await mkdir(dirname(target), {recursive: true, mode: 0o700});
        const objectPath = join(this.objects, `${entry.objectId}.bin`), objectStat = await lstat(objectPath);
        if (!objectStat.isFile() || objectStat.isSymbolicLink() || objectStat.nlink !== 1 || (objectStat.mode & 0o777) !== 0o600
          || process.platform !== 'win32' && process.getuid && objectStat.uid !== process.getuid()) throw fail('workspace_store_authentication_failed');
        let handle;
        try {
          handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW || 0), 0o600);
          async function* source() {
            for await (const chunk of fileChunks(objectPath, objectStat)) { try { yield chunk; } finally { chunk.fill(0); } }
          }
          for await (const chunk of decryptGenericFileStream(source(), {key: this.streamKey, rootId: this.rootId, objectId: entry.objectId,
            expectedSha256: entry.sha256, expectedBytes: entry.bytes, expectedName: basename(entry.path)})) await writeAll(handle, chunk);
          await handle.chmod(entry.mode); await handle.sync(); await handle.close(); handle = undefined; await rename(temporary, target);
        } finally {
          await handle?.close(); try { await unlink(temporary); } catch (error) { if (!absent(error)) throw error; }
        }
      }
      for (const entry of this.entries.filter(entry => entry.type === 'symlink')) {
        const target = join(staging, ...entry.path.split('/')); await mkdir(dirname(target), {recursive: true, mode: 0o700}); await symlink(entry.target, target);
      }
      for (const entry of this.entries.filter(entry => entry.type === 'directory').sort((a, b) => b.path.length - a.path.length)) {
        await chmod(join(staging, ...entry.path.split('/')), entry.mode);
      }
      for (const item of await safeEntries(staging)) await rename(join(staging, item.name), join(this.workspace, item.name));
    } finally { await rm(staging, {recursive: true, force: true}); }
  }

  async close() {
    if (!this.closing) this.closing = (async () => {
      await this.watcher?.close();
      if (this.accepting) await this.checkpoint();
      this.accepting = false; await this.flushPromise; await this.tail;
      this.master?.fill(0); this.streamKey?.fill(0);
    })();
    return this.closing;
  }
}

export async function openEncryptedWorkspace(options) {
  return await new EncryptedWorkspaceStore(options).initialize();
}
