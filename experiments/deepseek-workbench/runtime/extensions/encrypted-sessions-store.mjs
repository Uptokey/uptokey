import {createHash, randomUUID} from 'node:crypto';
import {constants} from 'node:fs';
import {link, lstat, mkdir, open, opendir, unlink} from 'node:fs/promises';
import {basename, dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {TextDecoder} from 'node:util';
import {
  assertContiguous, assertStoredId, assertVersion, materializeCreateHeader,
  SessionAlreadyExistsError, SessionFormatUnsupportedError,
  SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionPersistenceRevision, validateStoredEvents,
} from '@deepseek-ai/dsh-session-persistence';
import {SessionLogOffset} from '@deepseek-ai/dsh-session';
import {deepFreeze} from '@deepseek-ai/dsh-util-values';
import {JsonlBackendTracker, JsonlSessionHandle} from './vendor/session-runtime.mjs';
import {SessionWriteLease} from './vendor/session-write-lease.mjs';
import {VaultCrypto} from './vendor/vault-crypto.ts';

// This is a NEW physical backend, not a JSONL generation or migration. The
// unchanged upstream handle/tracker own queues, live routing, leases and close.
// Cipher frames are <=1 MiB plaintext; an authenticated commit makes a whole
// arbitrarily segmented append visible. No event/header plaintext is written.
// This protects stored bytes within the runtime's existing local trust boundary;
// it is not protection from a compromised process/host or deletion/rollback.
export const ENCRYPTED_SESSION_FORMAT = 'uptokey-encrypted-sessions-v1';
export const ENCRYPTED_SESSION_CHUNK_BYTES = 1024 * 1024;
const CHUNK = ENCRYPTED_SESSION_CHUNK_BYTES;
const FRAME_LIMIT = CHUNK * 2;
const MAGIC = Buffer.from('UPTOKEY-ENCRYPTED-SESSIONS-1\n');
const MARKER = '.uptokey-encrypted-sessions-v1';
const MARKER_LIMIT = 16 * 1024;
const LOG = 'session.utkes1';
const HEADER = 1, DATA = 2, COMMIT = 3;
const DIRECTORY = /^[a-f0-9]{64}$/;
const PENDING = /^\.pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const MARKER_PENDING = /^\.marker-pending-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEADER_KEYS = new Set(['id', 'version', 'createdAt', 'cwd', 'parentSession', 'isSeeded', 'origin', 'delegationDepth', 'agentPreset']);
const rootInitializations = new Map();
const hash = value => createHash('sha256').update(value).digest('hex');
const digestId = id => {
  if (typeof id !== 'string' || id.length === 0) throw new TypeError('session id must be a nonempty string');
  return hash(JSON.stringify(id));
};
const privateMode = stat => !(stat.mode & 0o077);
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const corrupt = () => new SessionPersistenceCorruptionError('encrypted session authentication or structure failed', {cause: new Error('encrypted_session_invalid')});
const abort = signal => signal?.throwIfAborted();
const decodeJSON = bytes => JSON.parse(new TextDecoder('utf-8', {fatal: true}).decode(bytes));
const scopedId = (rootId, directory, logId, position, kind) => hash(JSON.stringify([ENCRYPTED_SESSION_FORMAT, rootId, directory, logId, position, kind]));
const markerId = rootId => hash(JSON.stringify([ENCRYPTED_SESSION_FORMAT, 'root', rootId]));
const scope = kind => kind === HEADER ? 'session-header' : kind === DATA ? 'session-data' : 'session-commit';

async function noLinkedParents(path) {
  const root = parse(path).root;
  let current = root;
  for (const component of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, component);
    try { if ((await lstat(current)).isSymbolicLink()) throw corrupt(); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
  }
}

async function privateDirectory(path) {
  await noLinkedParents(path);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || !privateMode(stat)) throw corrupt();
  return stat;
}

async function privateFile(path, flags = constants.O_RDONLY) {
  await noLinkedParents(dirname(path));
  const before = await lstat(path);
  await publishedAliases(path, before);
  const handle = await open(path, flags | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    const stat = await handle.stat();
    const aliases = await publishedAliases(path, stat);
    if (!sameFile(before, stat)) throw corrupt();
    return {handle, stat, aliases};
  } catch (error) { await handle.close(); throw error; }
}

async function publishedAliases(path, stat) {
  if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat) || stat.nlink < 1) throw corrupt();
  if (stat.nlink === 1) return [];
  // Atomic no-replace publication uses link(temp, final). A crash before the
  // temp unlink may leave ONLY known pending aliases within this private dir.
  // Arbitrary hardlinks (including aliases elsewhere) remain refused.
  const pendingPattern = basename(path) === LOG ? PENDING : basename(path) === MARKER ? MARKER_PENDING : undefined;
  if (!pendingPattern) throw corrupt();
  await privateDirectory(dirname(path));
  const aliases = [], directory = await opendir(dirname(path));
  for await (const entry of directory) {
    if (!pendingPattern.test(entry.name)) continue;
    const candidate = join(dirname(path), entry.name), check = await lstat(candidate);
    if (sameNode(stat, check)) {
      if (!check.isFile() || check.isSymbolicLink() || !privateMode(check) || check.nlink !== stat.nlink) throw corrupt();
      aliases.push(candidate);
    }
  }
  if (aliases.length !== stat.nlink - 1) throw corrupt();
  return aliases;
}

async function readExact(handle, count, position, signal) {
  const buffer = Buffer.alloc(count);
  let used = 0;
  try {
    while (used < count) {
      abort(signal);
      const {bytesRead} = await handle.read(buffer, used, count - used, position + used);
      if (!bytesRead) throw corrupt();
      used += bytesRead;
    }
    return buffer;
  } catch (error) { buffer.fill(0); throw error; }
}

async function writeAll(handle, buffer, position) {
  let used = 0;
  while (used < buffer.length) {
    const {bytesWritten} = await handle.write(buffer, used, buffer.length - used, position + used);
    if (!bytesWritten) throw Error('encrypted_session_write_failed');
    used += bytesWritten;
  }
  return position + buffer.length;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await handle.sync(); } finally { await handle.close(); }
}

function metadata(header, cut, expectedId) {
  if (!header || typeof header !== 'object' || Array.isArray(header)) throw corrupt();
  // Version refusal precedes version-dependent structural admission, as upstream.
  assertVersion(header);
  if (expectedId !== undefined) assertStoredId(expectedId, header);
  if (Object.keys(header).some(key => !HEADER_KEYS.has(key))
    || typeof header.id !== 'string' || !header.id
    || !Number.isSafeInteger(header.createdAt) || header.createdAt < 0 || Object.is(header.createdAt, -0)
    || typeof header.isSeeded !== 'boolean'
    || header.cwd !== undefined && (typeof header.cwd !== 'string' || !isAbsolute(header.cwd))
    || header.parentSession !== undefined && typeof header.parentSession !== 'string'
    || header.origin !== undefined && header.origin !== 'subagent'
    || header.agentPreset !== undefined && typeof header.agentPreset !== 'string'
    || header.delegationDepth !== undefined && (!Number.isSafeInteger(header.delegationDepth) || header.delegationDepth < 0 || Object.is(header.delegationDepth, -0))) throw corrupt();
  if (header.isSeeded && cut === undefined) throw Error('seeded session header requires an inherited event count');
  const inheritedEventCount = SessionLogOffset(cut ?? 0);
  if (!header.isSeeded && inheritedEventCount !== 0) throw Error('unseeded session header inherited event count must be 0');
  return {header: Object.freeze({...header}), inheritedEventCount};
}

/** New-session encrypted provider; root MUST be separate from every legacy root. */
export class EncryptedSessionStore {
  constructor({root, keyPath}) {
    if (process.platform !== 'linux') throw Error('encrypted_sessions_linux_required');
    if (typeof root !== 'string' || !isAbsolute(root) || typeof keyPath !== 'string' || !isAbsolute(keyPath)) throw TypeError('encrypted_sessions_absolute_paths_required');
    this.root = resolve(root);
    this.keyPath = resolve(keyPath);
    this.identity = Symbol('uptokeyEncryptedSessions');
    this.tracker = new JsonlBackendTracker('uptokey-encrypted-sessions');
    this.cache = new Map(); // at most two cold/resume histories, never all sessions
    this.heads = new Map(); // active writers: counters/physical identity only
    this.readChains = new Map();
    this.accepting = true;
    const secrets = {
      get: async account => {
        if (account !== 'vault:key') throw Error('encrypted_sessions_key_account');
        let bytes, opened;
        try {
          opened = await privateFile(this.keyPath);
          if (opened.stat.size !== 64 || opened.stat.nlink !== 1 || (opened.stat.mode & 0o777) !== 0o400) throw Error();
          // Bounded read, including one growth byte; no unbounded secret readFile.
          bytes = Buffer.alloc(65);
          let used = 0;
          while (used < bytes.length) {
            const {bytesRead} = await opened.handle.read(bytes, used, bytes.length - used, used);
            if (!bytesRead) break;
            used += bytesRead;
          }
          if (used !== 64 || !sameFile(opened.stat, await opened.handle.stat())) throw Error();
          const value = bytes.subarray(0, 64).toString('utf8');
          if (!/^[a-f0-9]{64}$/.test(value)) throw Error();
          const fingerprint = hash(bytes.subarray(0, 64));
          if (this.keyFingerprint !== undefined && this.keyFingerprint !== fingerprint) throw Error();
          this.keyFingerprint = fingerprint;
          return value;
        } catch { throw Error('encrypted_sessions_key_unavailable'); }
        finally { bytes?.fill(0); await opened?.handle.close(); }
      },
      set: async () => { throw Error('encrypted_sessions_key_readonly'); },
      delete: async () => { throw Error('encrypted_sessions_key_readonly'); },
    };
    this.crypto = new VaultCrypto(secrets, {vaultId: 'deepseek-workbench', tenantScope: 'local', maxPayloadBytes: CHUNK});
  }

  path(id) { return join(this.root, digestId(id), LOG); }
  directory(id) { return dirname(this.path(id)); }
  assertAccepting() { if (!this.accepting) throw Error('encrypted_sessions_closed'); }
  ready() {
    this.assertAccepting();
    return this.initialization ??= this.initialize();
  }

  async initialize() {
    await this.crypto.ensureVaultKey(); // missing/changed key never creates or resets
    const previous = rootInitializations.get(this.root) ?? Promise.resolve();
    const work = previous.catch(() => {}).then(() => this.initializeRoot());
    rootInitializations.set(this.root, work);
    try { await work; }
    finally { if (rootInitializations.get(this.root) === work) rootInitializations.delete(this.root); }
  }

  async initializeRoot() {
    await noLinkedParents(this.root);
    await mkdir(this.root, {recursive: true, mode: 0o700});
    this.rootIdentity = await privateDirectory(this.root);
    const marker = join(this.root, MARKER);
    try { await lstat(marker); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const directory = await opendir(this.root);
      for await (const entry of directory) {
        if (entry.name === MARKER) continue;
        // Concurrent/crashed initialization can leave ciphertext-only temp
        // markers. No session directory is admissible without a bound marker.
        if (!MARKER_PENDING.test(entry.name)) throw Error('encrypted_sessions_root_not_empty');
        const stat = await lstat(join(this.root, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat) || stat.nlink > 2) throw corrupt();
      }
      await this.publishRootMarker(marker);
    }
    const opened = await privateFile(marker);
    let bytes, plain;
    try {
      if (opened.stat.size < 1 || opened.stat.size > MARKER_LIMIT || ![0o400, 0o600].includes(opened.stat.mode & 0o777)) throw corrupt();
      bytes = await readExact(opened.handle, opened.stat.size, 0);
      if (!sameFile(opened.stat, await opened.handle.stat())) throw corrupt();
      if (bytes.equals(MAGIC)) throw new SessionFormatUnsupportedError('unbound encrypted sessions root marker is unsupported');
      const record = decodeJSON(bytes);
      if (!record || Object.keys(record).sort().join(',') !== 'canary,format,rootId'
        || record.format !== ENCRYPTED_SESSION_FORMAT || typeof record.rootId !== 'string'
        || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(record.rootId)
        || record.canary?.schemaVersion !== 2) throw corrupt();
      const decrypted = await this.crypto.decryptObject(record.canary, {objectId: markerId(record.rootId), objectVersion: 1, resourceScope: 'session-root'});
      plain = Buffer.from(decrypted.buffer, decrypted.byteOffset, decrypted.byteLength);
      const canary = decodeJSON(plain);
      if (!canary || Object.keys(canary).sort().join(',') !== 'formatVersion,purpose,rootId'
        || canary.formatVersion !== 1 || canary.purpose !== 'session-root' || canary.rootId !== record.rootId) throw corrupt();
      this.rootId = record.rootId; this.rootMarkerStat = opened.stat;
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError) throw error;
      throw Error('encrypted_sessions_root_authentication_failed');
    } finally { plain?.fill(0); bytes?.fill(0); await opened.handle.close(); }
    await this.checkRoot();
  }

  async publishRootMarker(marker) {
    const rootId = randomUUID(), temporary = join(this.root, `.marker-pending-${randomUUID()}`);
    const plain = Buffer.from(JSON.stringify({formatVersion: 1, purpose: 'session-root', rootId}));
    let handle;
    try {
      const canary = await this.crypto.encryptObject(markerId(rootId), plain, {objectVersion: 1, resourceScope: 'session-root'});
      const bytes = Buffer.from(JSON.stringify({format: ENCRYPTED_SESSION_FORMAT, rootId, canary}));
      if (bytes.length > MARKER_LIMIT) throw corrupt();
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      await writeAll(handle, bytes, 0); await handle.sync(); await handle.close(); handle = undefined;
      try { await link(temporary, marker); }
      catch (error) { if (error.code !== 'EEXIST') throw error; }
      await unlink(temporary); await syncDirectory(this.root);
    } finally {
      plain.fill(0); await handle?.close();
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    }
  }

  async checkRoot() {
    const stat = await privateDirectory(this.root);
    if (this.rootIdentity && !sameNode(stat, this.rootIdentity)) throw corrupt();
    if (this.rootMarkerStat && !sameFile(await lstat(join(this.root, MARKER)), this.rootMarkerStat)) throw corrupt();
  }

  async resolveCurrentLog(id, signal) {
    abort(signal); await this.readyInternal(); await this.checkRoot(); abort(signal);
    try {
      await privateDirectory(this.directory(id));
      const stat = await lstat(this.path(id));
      await publishedAliases(this.path(id), stat);
      return this.path(id);
    } catch (error) { if (error.code === 'ENOENT') return undefined; throw error; }
  }

  // Handle-close drains must still work after store.close begins rejecting opens.
  readyInternal() { return this.initialization ?? this.ready(); }
  hasPendingSession(id) { return this.tracker.hasPending(id); }
  install(ctx) { this.assertAccepting(); return this.tracker.install(ctx); }

  async create(header, options) {
    this.assertAccepting(); abort(options?.signal);
    const snapshot = materializeCreateHeader(header);
    const admitted = metadata(snapshot, options?.inheritedEventCount);
    await this.ready(); abort(options?.signal); this.assertAccepting();
    if (this.tracker.hasPending(snapshot.id) || await this.resolveCurrentLog(snapshot.id, options?.signal) !== undefined) throw new SessionAlreadyExistsError(snapshot.id);
    abort(options?.signal); this.assertAccepting();
    this.tracker.registerCreated(admitted.header, admitted.inheritedEventCount);
    return this.tracker.adopt(new JsonlSessionHandle(this, snapshot.id, admitted.header, 'write', {cursor: 0, materialized: false, inheritedEventCount: admitted.inheritedEventCount}));
  }

  async open(id, access, options) {
    this.assertAccepting(); abort(options?.signal); digestId(id);
    if (access !== 'read' && access !== 'write') throw TypeError('session access must be read or write');
    await this.ready(); abort(options?.signal); this.assertAccepting();
    const pending = this.tracker.pendingOf(id);
    if (access === 'read' && pending) return this.tracker.adopt(new JsonlSessionHandle(this, id, pending.header, 'read', {cursor: 0, materialized: false, inheritedEventCount: pending.inheritedEventCount}));
    let lease;
    if (access === 'write') this.tracker.claimWrite(id);
    try {
      const path = await this.resolveCurrentLog(id, options?.signal);
      if (!path) throw new SessionPersistenceNotFoundError(id);
      if (access === 'write') lease = await this.acquireWriteLease({id});
      const stored = await this.scan(path, id, options?.signal);
      abort(options?.signal); this.assertAccepting();
      if (access === 'write') this.heads.set(id, this.headOf(stored));
      const state = {cursor: stored.events.length, materialized: true, inheritedEventCount: stored.inheritedEventCount,
        ...(access === 'write' ? {tornTruncateTo: stored.tornTruncateTo, primed: {eventState: 'shared-frozen', events: stored.events}} : {})};
      return this.tracker.adopt(new JsonlSessionHandle(this, id, stored.header, access, state, lease));
    } catch (error) {
      if (access === 'write') { this.tracker.releaseClaim(id); this.heads.delete(id); }
      try { await lease?.release(); } catch (releaseError) { throw new AggregateError([error, releaseError], 'encrypted session open failed'); }
      throw error;
    }
  }

  async acquireWriteLease(header) {
    await this.readyInternal(); await this.checkRoot();
    const directory = this.directory(header.id);
    await noLinkedParents(directory);
    await mkdir(directory, {recursive: true, mode: 0o700});
    // SessionWriteLease's mkdir is idempotent; refuse unsafe existing directory
    // or lock aliases BEFORE its original open('w') touches the lock path.
    await privateDirectory(directory);
    try {
      const stat = await lstat(join(directory, 'session.lock'));
      // The upstream lock is empty and inherits the process umask. Its private
      // containing directory is the boundary; do not change upstream lock mode.
      if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) throw corrupt();
    } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const lease = await SessionWriteLease.acquire(directory, header.id);
    try {
      // Only the writer holding the canonical lease may finish this publication
      // cleanup. Readers authenticate final bytes without deleting any alias.
      try {
        const published = await privateFile(this.path(header.id));
        try {
          for (const alias of published.aliases) {
            const stat = await lstat(alias);
            if (!sameNode(stat, published.stat) || !stat.isFile() || stat.isSymbolicLink()) throw corrupt();
            await unlink(alias);
          }
          if (published.aliases.length) await syncDirectory(directory);
        } finally { await published.handle.close(); }
      } catch (error) { if (error.code !== 'ENOENT') throw error; }
      await syncDirectory(this.root); return lease;
    }
    catch (error) { await lease.release(); throw error; }
  }

  releaseHandle(handle, materialized) {
    this.tracker.release(handle, materialized);
    if (handle.access === 'write') this.heads.delete(handle.id);
  }

  flush() { this.assertAccepting(); return this.tracker.flushAll(); }
  close() {
    if (this.closing) return this.closing;
    this.accepting = false;
    return this.closing = (async () => {
      const failures = [];
      for (const handle of [...this.tracker.openHandles]) try { await handle.close(); } catch (error) { failures.push(error); }
      this.cache.clear(); this.heads.clear();
      if (failures.length) throw new AggregateError(failures, 'encrypted sessions close failed');
    })();
  }

  async stat(id, options) {
    this.assertAccepting(); abort(options?.signal); await this.ready();
    const pending = this.tracker.pendingOf(id);
    if (pending) return {header: {...pending.header}, revision: pending.revision, eventCount: 0, formatStatus: 'current'};
    const path = await this.resolveCurrentLog(id, options?.signal);
    if (!path) return undefined;
    return this.snapshot(path, id, options?.signal);
  }

  async list(options) {
    this.assertAccepting(); abort(options?.signal); await this.ready(); await this.checkRoot();
    const snapshots = new Map();
    const directory = await opendir(this.root);
    for await (const entry of directory) {
      abort(options?.signal);
      if (entry.name === MARKER) continue;
      if (MARKER_PENDING.test(entry.name)) {
        const stat = await lstat(join(this.root, entry.name));
        if (!stat.isFile() || stat.isSymbolicLink() || !privateMode(stat) || stat.nlink > 2) throw corrupt();
        continue;
      }
      if (!DIRECTORY.test(entry.name) || !entry.isDirectory() || entry.isSymbolicLink()) throw corrupt();
      const path = join(this.root, entry.name, LOG);
      try {
        await privateDirectory(join(this.root, entry.name));
        const snapshot = await this.snapshot(path, undefined, options?.signal);
        snapshots.set(snapshot.header.id, snapshot);
      } catch (error) { if (error.code !== 'ENOENT') throw error; } // unmaterialized lease directory
    }
    for (const [id, pending] of this.tracker.pendingEntries()) if (!snapshots.has(id)) snapshots.set(id, {header: {...pending.header}, revision: pending.revision, eventCount: 0, formatStatus: 'current'});
    abort(options?.signal);
    return [...snapshots.values()];
  }

  async snapshot(path, expectedId, signal) {
    const opened = await privateFile(path);
    try {
      const stored = await this.readHeader(opened.handle, opened.stat.size, path, expectedId, signal);
      abort(signal);
      return {header: {...stored.header}, formatStatus: 'current', sizeBytes: opened.stat.size,
        revision: SessionPersistenceRevision(hash(JSON.stringify([opened.stat.dev, opened.stat.ino, opened.stat.size, opened.stat.mtimeMs, opened.stat.ctimeMs])))};
    } finally { await opened.handle.close(); }
  }

  async encode(kind, plaintext, directory, logId, position) {
    if (plaintext.length > CHUNK) throw Error('encrypted_session_frame_payload_limit');
    const envelope = await this.crypto.encryptObject(scopedId(this.rootId, directory, logId, position, kind), plaintext, {objectVersion: 1, resourceScope: scope(kind)});
    const encoded = Buffer.from(JSON.stringify(envelope));
    if (encoded.length > FRAME_LIMIT) throw Error('encrypted_session_frame_limit');
    const prefix = Buffer.alloc(5); prefix[0] = kind; prefix.writeUInt32BE(encoded.length, 1);
    return Buffer.concat([prefix, encoded]);
  }

  async frame(handle, size, position, signal) {
    if (position === size) return undefined;
    if (size - position < 5) return {torn: true};
    const prefix = await readExact(handle, 5, position, signal);
    const kind = prefix[0], length = prefix.readUInt32BE(1);
    if (![HEADER, DATA, COMMIT].includes(kind) || length < 1 || length > FRAME_LIMIT) throw corrupt();
    if (size - position - 5 < length) return {torn: true};
    const bytes = await readExact(handle, length, position + 5, signal);
    return {kind, bytes, end: position + 5 + length, position};
  }

  async decrypt(frame, directory, logId) {
    let decoded;
    try {
      const envelope = decodeJSON(frame.bytes);
      // New format only: never silently admit v1 or an unauthenticated object.
      if (envelope?.schemaVersion !== 2) throw corrupt();
      const plain = await this.crypto.decryptObject(envelope, {objectId: scopedId(this.rootId, directory, logId, frame.position, frame.kind), objectVersion: 1, resourceScope: scope(frame.kind)});
      decoded = Buffer.from(plain.buffer, plain.byteOffset, plain.byteLength);
      return decoded;
    } catch { decoded?.fill(0); throw corrupt(); }
  }

  async readHeader(handle, size, path, expectedId, signal) {
    const directory = path.slice(this.root.length + 1).split(sep)[0];
    if (!DIRECTORY.test(directory) || path !== join(this.root, directory, LOG)) throw corrupt();
    if (size < MAGIC.length) throw corrupt();
    const magic = await readExact(handle, MAGIC.length, 0, signal);
    if (!magic.equals(MAGIC)) throw new SessionFormatUnsupportedError('unsupported encrypted session physical format', {kind: ENCRYPTED_SESSION_FORMAT, path});
    const frame = await this.frame(handle, size, MAGIC.length, signal);
    if (!frame || frame.torn || frame.kind !== HEADER) throw corrupt();
    let plain;
    try {
      plain = await this.decrypt(frame, directory, 'header');
      const decoded = decodeJSON(plain);
      if (!decoded || Object.keys(decoded).sort().join(',') !== 'formatVersion,inheritedEventCount,logId,meta') throw corrupt();
      if (decoded.formatVersion !== 1) throw new SessionFormatUnsupportedError('unsupported encrypted session schema', {kind: ENCRYPTED_SESSION_FORMAT, path});
      if (typeof decoded.logId !== 'string' || !/^[0-9a-f-]{36}$/.test(decoded.logId)) throw corrupt();
      const admitted = metadata(decoded.meta, decoded.inheritedEventCount, expectedId);
      if (digestId(admitted.header.id) !== directory) throw corrupt();
      return {...admitted, directory, logId: decoded.logId, end: frame.end, chain: hash(frame.bytes)};
    } catch (error) {
      if (error instanceof SessionFormatUnsupportedError) throw error;
      throw corrupt();
    } finally { plain?.fill(0); }
  }

  scan(path, id, signal) {
    const previous = this.readChains.get(id) ?? Promise.resolve();
    const operation = previous.catch(() => {}).then(() => this.scanNow(path, id, signal));
    this.readChains.set(id, operation);
    operation.finally(() => { if (this.readChains.get(id) === operation) this.readChains.delete(id); }).catch(() => {});
    return operation;
  }

  async scanNow(path, id, signal) {
    abort(signal); await this.checkRoot();
    const opened = await privateFile(path);
    try {
      const base = await this.readHeader(opened.handle, opened.stat.size, path, id, signal);
      let cached = this.cache.get(id);
      if (cached && sameNode(cached.stat, opened.stat) && opened.stat.size < cached.end) throw corrupt();
      const writer = this.heads.get(id);
      const knownAppend = writer && sameFile(writer.stat, opened.stat) && cached && cached.end <= writer.end;
      if (cached && (!sameNode(cached.stat, opened.stat) || cached.logId !== base.logId
        || cached.headerChain !== base.chain || !sameFile(cached.stat, opened.stat) && !knownAppend)) cached = undefined;
      // Only our checked writer proves a delta extended this prefix. A changed
      // external file must authenticate the entire prefix, including growth:
      // size growth alone cannot distinguish append from prefix tampering.
      const stored = cached ?? {...base, headerChain: base.chain, events: [], stat: opened.stat};
      let position = stored.end, count = stored.events.length, chain = stored.chain;
      let pending = [], transactionStart = position, transactionBytes = 0, byteDigest = createHash('sha256');
      const decoder = new TextDecoder('utf-8', {fatal: true});
      let text = '';
      while (position < opened.stat.size) {
        abort(signal);
        const frame = await this.frame(opened.handle, opened.stat.size, position, signal);
        if (frame?.torn) break;
        if (!frame || frame.kind === HEADER) throw corrupt();
        let plain;
        try {
          plain = await this.decrypt(frame, base.directory, base.logId);
          if (frame.kind === DATA) {
            byteDigest.update(plain); transactionBytes += plain.length;
            if (!Number.isSafeInteger(transactionBytes)) throw corrupt();
            text += decoder.decode(plain, {stream: true});
            let newline;
            while ((newline = text.indexOf('\n')) !== -1) {
              const row = text.slice(0, newline); text = text.slice(newline + 1);
              if (!row) throw corrupt();
              try { pending.push(JSON.parse(row)); } catch { throw corrupt(); }
            }
          } else {
            const commit = decodeJSON(plain);
            if (!commit || Object.keys(commit).sort().join(',') !== 'byteCount,eventCount,formatVersion,previousCommit,previousCount,sha256,startOffset'
              || commit.formatVersion !== 1 || commit.startOffset !== transactionStart || commit.previousCount !== count
              || commit.eventCount !== pending.length || !pending.length || commit.byteCount !== transactionBytes
              || commit.previousCommit !== chain || commit.sha256 !== byteDigest.digest('hex')
              || decoder.decode() !== '' || text !== '') throw corrupt();
            validateStoredEvents(base.header, pending, {kind: ENCRYPTED_SESSION_FORMAT, path});
            // Canonical adoption freezes message subgraphs, not arbitrary
            // ignorable/plugin payloads. Our shared cache must freeze ALL JSON.
            for (const event of pending) deepFreeze(event);
            assertContiguous(id, pending, count);
            if (!Number.isSafeInteger(count + pending.length)) throw corrupt();
            for (const event of pending) stored.events.push(event);
            count += pending.length;
            stored.end = frame.end; stored.chain = chain = hash(frame.bytes);
            pending = []; transactionBytes = 0; byteDigest = createHash('sha256'); transactionStart = frame.end;
          }
        } catch (error) {
          if (error instanceof SessionFormatUnsupportedError || error instanceof SessionPersistenceCorruptionError) throw error;
          throw corrupt();
        } finally { plain?.fill(0); }
        position = frame.end;
      }
      // Complete DATA without COMMIT is an uncommitted tail, just like a partial
      // frame. Readers never truncate it or expose any of its events.
      stored.tornTruncateTo = stored.end < opened.stat.size ? stored.end : undefined;
      stored.stat = opened.stat;
      abort(signal);
      this.cache.delete(id); this.cache.set(id, stored);
      while (this.cache.size > 2) this.cache.delete(this.cache.keys().next().value);
      return stored;
    } finally { await opened.handle.close(); }
  }

  async readStoredLog(path, expectedId, signal) {
    if (path !== this.path(expectedId)) throw corrupt();
    const stored = await this.scan(path, expectedId, signal);
    return {eventState: 'shared-frozen', events: stored.events};
  }

  headOf(stored) {
    return {directory: stored.directory, logId: stored.logId, end: stored.end, chain: stored.chain,
      count: stored.events.length, stat: stored.stat};
  }

  async truncateTornTail(header, truncateTo) {
    const head = this.heads.get(header.id);
    if (!head || truncateTo !== head.end) throw corrupt();
    const opened = await privateFile(this.path(header.id), constants.O_RDWR);
    try {
      if (!sameFile(head.stat, opened.stat)) throw corrupt();
      await opened.handle.truncate(truncateTo); await opened.handle.sync();
      head.stat = await opened.handle.stat(); this.cache.delete(header.id);
    } finally { await opened.handle.close(); }
  }

  async writeBatch(handle, header, events, head) {
    validateStoredEvents(header, events);
    for (const event of events) deepFreeze(event);
    assertContiguous(header.id, events, head.count);
    const startOffset = head.end;
    let position = startOffset, byteCount = 0;
    const digest = createHash('sha256');
    let chunk = Buffer.alloc(CHUNK), used = 0;
    const emit = async () => {
      if (!used) return;
      const bytes = chunk.subarray(0, used); digest.update(bytes); byteCount += used;
      const encoded = await this.encode(DATA, bytes, head.directory, head.logId, position);
      position = await writeAll(handle, encoded, position); chunk.fill(0); used = 0;
    };
    try {
      for (const event of events) {
        let bytes;
        try {
          bytes = Buffer.from(JSON.stringify(event) + '\n');
          for (let offset = 0; offset < bytes.length;) {
            const take = Math.min(CHUNK - used, bytes.length - offset);
            bytes.copy(chunk, used, offset, offset + take); used += take; offset += take;
            if (used === CHUNK) await emit();
          }
        } finally { bytes?.fill(0); }
      }
      await emit();
      if (!Number.isSafeInteger(byteCount) || !Number.isSafeInteger(head.count + events.length)) throw Error('encrypted_session_integer_limit');
      const record = Buffer.from(JSON.stringify({formatVersion: 1, startOffset, previousCount: head.count,
        eventCount: events.length, byteCount, sha256: digest.digest('hex'), previousCommit: head.chain}));
      let encoded;
      try { encoded = await this.encode(COMMIT, record, head.directory, head.logId, position); }
      finally { record.fill(0); }
      position = await writeAll(handle, encoded, position);
      return {...head, end: position, count: head.count + events.length, chain: hash(encoded.subarray(5))};
    } finally { chunk.fill(0); }
  }

  async materialize(header, inheritedEventCount, events) {
    await this.readyInternal(); await this.checkRoot(); await privateDirectory(this.directory(header.id));
    const finalPath = this.path(header.id), temporary = join(this.directory(header.id), `.pending-${randomUUID()}`);
    let handle, published = false;
    try {
      handle = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
      let position = await writeAll(handle, MAGIC, 0);
      const plain = Buffer.from(JSON.stringify({formatVersion: 1, meta: header, inheritedEventCount, logId: randomUUID()}));
      let first, logId;
      try { logId = decodeJSON(plain).logId; first = await this.encode(HEADER, plain, digestId(header.id), 'header', position); }
      finally { plain.fill(0); }
      position = await writeAll(handle, first, position);
      let head = {directory: digestId(header.id), logId, end: position, count: 0, chain: hash(first.subarray(5))};
      if (events.length) head = await this.writeBatch(handle, header, events, head);
      await handle.sync(); await handle.close(); handle = undefined;
      // link is a no-replace atomic publication on the supported Linux volume.
      try { await link(temporary, finalPath); published = true; }
      catch (error) { if (error.code === 'EEXIST') throw new SessionAlreadyExistsError(header.id); throw error; }
      await unlink(temporary); await syncDirectory(this.directory(header.id));
      const opened = await privateFile(finalPath);
      try { head.stat = opened.stat; } finally { await opened.handle.close(); }
      this.heads.set(header.id, head); this.cache.delete(header.id); this.tracker.materialized(header.id);
    } finally {
      await handle?.close();
      try { await unlink(temporary); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      // On publication/fsync failure never unlink a possibly durable committed
      // log; the caller must see the error and reopen rather than overwrite it.
      void published;
    }
  }

  async persistHeader(header, inheritedEventCount) { return this.materialize(header, inheritedEventCount, []); }

  async persistBatch(header, events, isMaterialized, inheritedEventCount) {
    if (!isMaterialized) return this.materialize(header, inheritedEventCount, events);
    const head = this.heads.get(header.id);
    if (!head) throw corrupt();
    const opened = await privateFile(this.path(header.id), constants.O_RDWR);
    try {
      if (!sameFile(head.stat, opened.stat) || opened.stat.size !== head.end) throw corrupt();
      let next;
      try { next = await this.writeBatch(opened.handle, header, events, head); await opened.handle.sync(); }
      catch (error) {
        try { await opened.handle.truncate(head.end); await opened.handle.sync(); head.stat = await opened.handle.stat(); }
        catch (rollbackError) { throw new AggregateError([error, rollbackError], 'encrypted session append and rollback failed'); }
        throw error;
      }
      next.stat = await opened.handle.stat(); this.heads.set(header.id, next);
      // Reader memo consumes only the appended ciphertext on its next read.
      // Do not keep another complete history on the writer path.
    } finally { await opened.handle.close(); }
  }
}
