/**
 * File framing for libsodium's standard XChaCha20-Poly1305 secretstream (0.8.4).
 * https://doc.libsodium.org/secret-key_cryptography/secretstream
 * https://github.com/jedisct1/libsodium.js/blob/0.8.4/wrapper/symbols/crypto_secretstream_xchacha20poly1305_init_push.json
 * https://github.com/jedisct1/libsodium.js/blob/0.8.4/wrapper/wrap-template.js
 *
 * This codec does not publish files. Publication requires complete iteration,
 * fsync and the provider's atomic commit. Decryption authenticates each yielded
 * chunk, but complete-file acceptance also requires FINAL, the digest/length/name
 * checks and EOF. A materializer must keep its temporary private until then.
 * A caller cannot recall an authenticated prefix already given to a consumer.
 */
import {createHash} from 'node:crypto';
import sodium from 'libsodium-wrappers';

export const GENERIC_STREAM_FORMAT = 'uptokey-generic-secretstream-v1';
export const GENERIC_STREAM_CHUNK_BYTES = 64 * 1024;
const MAGIC = Buffer.from('UPTKGSS1', 'ascii');
const SUMMARY_FIXED_BYTES = 42; // uint64 bytes, SHA-256, uint16 UTF-8 name length
const MAX_NAME_BYTES = 255;
const corrupt = () => Object.assign(new Error('Generic file authentication or structure failed.'), {code: 'ATTACHMENT_CORRUPT'});
const abort = signal => signal?.throwIfAborted();

function boundedText(value, maximum, label) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > maximum
    || Buffer.from(value).toString('utf8') !== value) throw new TypeError(`A bounded ${label} is required.`);
  return value;
}
function scope(rootId, objectId) {
  boundedText(rootId, 256, 'root identity');
  boundedText(objectId, 256, 'object identity');
  return Buffer.from(JSON.stringify([GENERIC_STREAM_FORMAT, rootId, objectId]));
}
function ownedKey(key) {
  if (!(key instanceof Uint8Array) || key.byteLength !== 32) throw new TypeError('A 32-byte stream key is required.');
  return Buffer.from(key);
}
function frame(ciphertext) {
  const out = Buffer.allocUnsafe(4 + ciphertext.byteLength);
  out.writeUInt32BE(ciphertext.byteLength);
  out.set(ciphertext, 4);
  return out;
}

// The pinned wrapper returns a caller-owned WASM state address. Its public
// libsodium module exposes the allocator used by the wrapper; it has no free()
// convenience export. Release exactly our state, wiping it before _free().
function releaseState(state) {
  if (state === undefined) return;
  const core = sodium.libsodium;
  core.HEAPU8.fill(0, state, state + core._crypto_secretstream_xchacha20poly1305_statebytes());
  core._free(state);
}
async function waitWithSignal(promise, signal) {
  // Observe a promise even when the signal was aborted before this call.
  // It may be a producer/callback promise whose later rejection still matters.
  if (signal?.aborted) { Promise.resolve(promise).catch(() => {}); abort(signal); }
  if (!signal) return await promise;
  let listener;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      listener = () => reject(signal.reason ?? new DOMException('The operation was aborted.', 'AbortError'));
      signal.addEventListener('abort', listener, {once: true});
      if (signal.aborted) listener();
    })]);
  } finally { signal.removeEventListener('abort', listener); }
}
async function ready(signal) {
  await waitWithSignal(sodium.ready, signal);
  abort(signal);
  const core = sodium.libsodium;
  if (typeof core?._free !== 'function' || !(core.HEAPU8 instanceof Uint8Array)
    || typeof core._crypto_secretstream_xchacha20poly1305_statebytes !== 'function'
    || sodium.crypto_secretstream_xchacha20poly1305_KEYBYTES !== 32
    || sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES !== 24
    || sodium.crypto_secretstream_xchacha20poly1305_ABYTES !== 17) {
    throw new Error('Unsupported libsodium state lifecycle.');
  }
}

/** No prefetch. A producer's current buffer remains producer-owned. */
class SourceCursor {
  constructor(source, signal, invalid = () => new TypeError('File chunks must be Uint8Array values.')) {
    this.iterator = source?.[Symbol.asyncIterator]?.() ?? source?.[Symbol.iterator]?.();
    if (!this.iterator || typeof this.iterator.next !== 'function') throw new TypeError('An iterable of byte chunks is required.');
    this.signal = signal;
    this.invalid = invalid;
    this.current = new Uint8Array();
    this.offset = 0;
    this.done = false;
  }
  async next() {
    abort(this.signal);
    const next = await waitWithSignal(Promise.resolve().then(() => this.iterator.next()), this.signal);
    abort(this.signal);
    if (!next || typeof next !== 'object') throw this.invalid();
    this.done = Boolean(next.done);
    if (this.done) {
      this.current = new Uint8Array();
      this.offset = 0; // EOF must not retain an offset into the previous buffer.
      return undefined;
    }
    if (!(next.value instanceof Uint8Array)) throw this.invalid();
    this.current = next.value;
    this.offset = 0;
    return this.current;
  }
  async read(size, eofAllowed = false) {
    const out = Buffer.allocUnsafe(size);
    let used = 0;
    while (used < size) {
      abort(this.signal);
      if (this.offset === this.current.byteLength) {
        if (this.done) {
          if (eofAllowed && used === 0) return undefined;
          throw corrupt();
        }
        await this.next();
        if (!this.current.byteLength) continue;
      }
      const take = Math.min(size - used, this.current.byteLength - this.offset);
      out.set(this.current.subarray(this.offset, this.offset + take), used);
      this.offset += take;
      used += take;
    }
    return out;
  }
  async close(failed = false) {
    this.current = new Uint8Array();
    this.offset = 0;
    if (this.done || typeof this.iterator.return !== 'function') return;
    const cleanup = Promise.resolve().then(() => this.iterator.return());
    // Preserve the primary failure, including arbitrary thrown values. Cleanup
    // cannot replace it or hold its rejection hostage to an uncooperative source.
    // For a normal early return, await cooperative cleanup as for for-await-of.
    if (failed || this.signal?.aborted) { cleanup.catch(() => {}); return; }
    await cleanup;
  }
}

function expectations(expectedSha256, expectedBytes, expectedName) {
  if (expectedSha256 === undefined && expectedBytes === undefined && expectedName === undefined) return undefined;
  if (!/^[a-f0-9]{64}$/.test(expectedSha256 ?? '') || !Number.isSafeInteger(expectedBytes) || expectedBytes < 0) {
    throw new TypeError('An exact file reference is required.');
  }
  boundedText(expectedName, MAX_NAME_BYTES, 'file name');
  return {sha256: expectedSha256, bytes: expectedBytes, name: expectedName};
}
function summaryFor(digest, bytes, name) {
  const encodedName = Buffer.from(name);
  const summary = Buffer.allocUnsafe(SUMMARY_FIXED_BYTES + encodedName.length);
  summary.writeBigUInt64BE(BigInt(bytes));
  summary.set(digest, 8);
  summary.writeUInt16BE(encodedName.length, 40);
  summary.set(encodedName, SUMMARY_FIXED_BYTES);
  return summary;
}
function readSummary(message, digest, bytes, expected) {
  if (message.length < SUMMARY_FIXED_BYTES || message.length > SUMMARY_FIXED_BYTES + MAX_NAME_BYTES) throw corrupt();
  const summary = Buffer.from(message.buffer, message.byteOffset, message.byteLength);
  const nameLength = summary.readUInt16BE(40);
  if (!nameLength || summary.length !== SUMMARY_FIXED_BYTES + nameLength) throw corrupt();
  const encodedName = summary.subarray(SUMMARY_FIXED_BYTES);
  const name = encodedName.toString('utf8');
  if (!Buffer.from(name).equals(encodedName) || summary.readBigUInt64BE() !== BigInt(bytes)
    || !summary.subarray(8, 40).equals(digest)) throw corrupt();
  const result = Object.freeze({sha256: digest.toString('hex'), bytes, name});
  if (expected && (result.sha256 !== expected.sha256 || bytes !== expected.bytes || name !== expected.name)) throw corrupt();
  return result;
}

/**
 * Codec-owned memory is O(64 KiB), excluding caller input/output buffers and
 * libsodium's bounded allocations. No total-file cap beyond safe integer bytes.
 * name is the provider's already-sanitized leaf name; this codec does not rename.
 * onComplete runs only when the consumer resumes past FINAL, before done=true.
 * key and source buffers stay caller-owned; only our key copy/state are wiped.
 */
export async function* encryptGenericFileStream(source, {key, rootId, objectId, name, signal, onComplete} = {}) {
  const aad = scope(rootId, objectId);
  boundedText(name, MAX_NAME_BYTES, 'file name');
  if (onComplete !== undefined && typeof onComplete !== 'function') throw new TypeError('onComplete must be a function.');
  const secret = ownedKey(key);
  let state, cursor, summary, digest, failed = false;
  const chunk = Buffer.allocUnsafe(GENERIC_STREAM_CHUNK_BYTES);
  let used = 0, bytes = 0;
  const hash = createHash('sha256');
  try {
    await ready(signal);
    cursor = new SourceCursor(source, signal);
    const initialized = sodium.crypto_secretstream_xchacha20poly1305_init_push(secret);
    state = initialized.state;
    secret.fill(0);
    yield Buffer.concat([MAGIC, initialized.header]);
    for (;;) {
      const input = await cursor.next();
      if (input === undefined) break;
      for (let offset = 0; offset < input.byteLength;) {
        abort(signal);
        const take = Math.min(chunk.length - used, input.byteLength - offset);
        chunk.set(input.subarray(offset, offset + take), used);
        used += take;
        offset += take;
        if (used === chunk.length) {
          bytes += used;
          if (!Number.isSafeInteger(bytes)) throw new RangeError('File length exceeds the reference integer range.');
          hash.update(chunk);
          const output = frame(sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk, aad, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE));
          chunk.fill(0);
          used = 0;
          yield output;
        }
      }
    }
    abort(signal);
    if (used) {
      bytes += used;
      if (!Number.isSafeInteger(bytes)) throw new RangeError('File length exceeds the reference integer range.');
      hash.update(chunk.subarray(0, used));
      const output = frame(sodium.crypto_secretstream_xchacha20poly1305_push(state, chunk.subarray(0, used), aad, sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE));
      chunk.fill(0);
      yield output;
    }
    digest = hash.digest();
    summary = summaryFor(digest, bytes, name);
    const output = frame(sodium.crypto_secretstream_xchacha20poly1305_push(state, summary, aad, sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL));
    summary.fill(0);
    yield output;
    abort(signal);
    const metadata = Object.freeze({sha256: digest.toString('hex'), bytes, name});
    if (onComplete) await waitWithSignal(Promise.resolve().then(() => { abort(signal); return onComplete(metadata); }), signal);
    abort(signal);
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    secret.fill(0);
    chunk.fill(0);
    summary?.fill(0);
    digest?.fill(0);
    releaseState(state);
    await cursor?.close(failed);
  }
}

/**
 * expectedSha256/expectedBytes/expectedName must be supplied together for reads
 * by an external ref. Omitting all three only verifies a newly written temporary
 * against its authenticated FINAL; it does not bind an external file reference.
 * ATTACHMENT_CORRUPT must not trigger a legacy fallback. Source I/O and abort
 * errors retain their identity so the provider can distinguish those failures.
 */
export async function* decryptGenericFileStream(source, {key, rootId, objectId, expectedSha256, expectedBytes, expectedName, signal, onComplete} = {}) {
  const aad = scope(rootId, objectId);
  const expected = expectations(expectedSha256, expectedBytes, expectedName);
  if (onComplete !== undefined && typeof onComplete !== 'function') throw new TypeError('onComplete must be a function.');
  const secret = ownedKey(key);
  let state, cursor, digest, failed = false;
  let bytes = 0;
  const hash = createHash('sha256');
  try {
    await ready(signal);
    cursor = new SourceCursor(source, signal, corrupt);
    const prefix = await cursor.read(MAGIC.length + sodium.crypto_secretstream_xchacha20poly1305_HEADERBYTES);
    if (!prefix.subarray(0, MAGIC.length).equals(MAGIC)) throw corrupt();
    state = sodium.crypto_secretstream_xchacha20poly1305_init_pull(prefix.subarray(MAGIC.length), secret);
    if (!Number.isInteger(state) || state <= 0) { state = undefined; throw corrupt(); }
    secret.fill(0);
    for (;;) {
      const length = (await cursor.read(4)).readUInt32BE();
      const overhead = sodium.crypto_secretstream_xchacha20poly1305_ABYTES;
      if (length <= overhead || length > GENERIC_STREAM_CHUNK_BYTES + overhead) throw corrupt();
      const ciphertext = await cursor.read(length);
      abort(signal);
      const result = sodium.crypto_secretstream_xchacha20poly1305_pull(state, ciphertext, aad);
      if (!result) throw corrupt();
      const {message, tag} = result;
      if (tag === sodium.crypto_secretstream_xchacha20poly1305_TAG_FINAL) {
        try {
          digest = hash.digest();
          const metadata = readSummary(message, digest, bytes, expected);
          if (await cursor.read(1, true) !== undefined) throw corrupt();
          abort(signal);
          if (onComplete) await waitWithSignal(Promise.resolve().then(() => { abort(signal); return onComplete(metadata); }), signal);
          abort(signal);
          return;
        } finally { message.fill(0); }
      }
      if (tag !== sodium.crypto_secretstream_xchacha20poly1305_TAG_MESSAGE || !message.length) {
        message.fill(0);
        throw corrupt();
      }
      bytes += message.length;
      if (!Number.isSafeInteger(bytes) || (expected && bytes > expected.bytes)) {
        message.fill(0);
        throw corrupt();
      }
      hash.update(message);
      // Authenticated output ownership passes to the consumer, who may retain it.
      yield message;
    }
  } catch (error) {
    failed = true;
    throw error;
  } finally {
    secret.fill(0);
    digest?.fill(0);
    releaseState(state);
    await cursor?.close(failed);
  }
}
