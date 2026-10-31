import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import sodium from 'libsodium-wrappers';
import {GENERIC_STREAM_CHUNK_BYTES, GENERIC_STREAM_FORMAT, encryptGenericFileStream, decryptGenericFileStream} from './generic-secretstream.mjs';

const key = Buffer.alloc(32, 0x63);
const context = {key, rootId: 'synthetic-root', objectId: 'synthetic-name-object', name: 'fixture-世界.bin'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function collect(source) {
  const chunks = [];
  for await (const chunk of source) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks);
}
function fragmented(bytes, sizes = [1, 3, 7, 4093, 11, 8192]) {
  return (function* () {
    let offset = 0, index = 0;
    yield new Uint8Array();
    while (offset < bytes.length) {
      const next = Math.min(bytes.length, offset + sizes[index++ % sizes.length]);
      yield bytes.subarray(offset, next);
      offset = next;
    }
    yield new Uint8Array();
  })();
}
async function encoded(bytes, options = {}) {
  let metadata;
  const ciphertext = await collect(encryptGenericFileStream(fragmented(bytes), {...context, ...options, onComplete: result => { metadata = result; }}));
  return {ciphertext, metadata};
}
function decoder(ciphertext, metadata, options = {}) {
  return decryptGenericFileStream(fragmented(ciphertext), {
    ...context,
    expectedSha256: metadata.sha256,
    expectedBytes: metadata.bytes,
    expectedName: metadata.name,
    ...options,
  });
}
const corruptError = error => error?.code === 'ATTACHMENT_CORRUPT';
function frames(ciphertext) {
  const prefix = ciphertext.subarray(0, 32); // magic8 + sodium header24
  const result = [];
  for (let offset = 32; offset < ciphertext.length;) {
    const length = ciphertext.readUInt32BE(offset);
    result.push(ciphertext.subarray(offset, offset + 4 + length));
    offset += 4 + length;
  }
  return {prefix, frames: result};
}

test('round-trips empty, exact-boundary and fragmented multi-frame files with authenticated metadata', async () => {
  assert.equal(GENERIC_STREAM_FORMAT, 'uptokey-generic-secretstream-v1');
  for (const length of [0, 1, GENERIC_STREAM_CHUNK_BYTES, GENERIC_STREAM_CHUNK_BYTES * 2 + 23]) {
    const input = randomBytes(length);
    const original = Buffer.from(input);
    const {ciphertext, metadata} = await encoded(input);
    assert.deepEqual(metadata, {sha256: digest(input), bytes: length, name: context.name});
    assert.ok(Object.isFrozen(metadata));
    let verified;
    assert.deepEqual(await collect(decoder(ciphertext, metadata, {onComplete: result => { verified = result; }})), input);
    assert.deepEqual(verified, metadata);
    assert.deepEqual(input, original);
    assert.deepEqual(key, Buffer.alloc(32, 0x63));
  }
});

test('verification without an external ref reports authenticated FINAL facts and rejects partial expectations', async () => {
  const {ciphertext, metadata} = await encoded(Buffer.from('new synthetic temporary'));
  let verified;
  const decoded = await collect(decryptGenericFileStream(fragmented(ciphertext), {...context, onComplete: result => { verified = result; }}));
  assert.equal(decoded.toString(), 'new synthetic temporary');
  assert.deepEqual(verified, metadata);
  await assert.rejects(collect(decryptGenericFileStream([ciphertext], {...context, expectedBytes: 22})), TypeError);
});

test('FINAL completion callback requires full consumption and ciphertext is randomized', async () => {
  let calls = 0;
  const stream = encryptGenericFileStream([], {...context, onComplete: () => { calls++; }});
  assert.equal((await stream.next()).done, false); // prefix
  assert.equal((await stream.next()).done, false); // FINAL
  assert.equal(calls, 0);
  assert.equal((await stream.next()).done, true);
  assert.equal(calls, 1);
  const first = await encoded(Buffer.from('same data'));
  const second = await encoded(Buffer.from('same data'));
  assert.notDeepEqual(first.ciphertext, second.ciphertext);
  assert.deepEqual(first.metadata, second.metadata);
});

test('wrong key, root, object, digest, length and name all fail closed', async () => {
  const {ciphertext, metadata} = await encoded(randomBytes(100));
  for (const options of [
    {key: Buffer.alloc(32, 0x7a)}, {rootId: 'different-root'}, {objectId: 'different-object'},
    {expectedSha256: '0'.repeat(64)}, {expectedBytes: 99}, {expectedBytes: 101}, {expectedName: 'other.bin'},
  ]) await assert.rejects(collect(decoder(ciphertext, metadata, options)), corruptError);
});

test('tampered header, ciphertext, framing and unsupported format fail closed', async () => {
  const {ciphertext, metadata} = await encoded(randomBytes(100));
  for (const position of [0, 8, 31, 38, ciphertext.length - 1]) {
    const changed = Buffer.from(ciphertext);
    changed[position] ^= 0x80;
    await assert.rejects(collect(decoder(changed, metadata)), corruptError);
  }
  for (const length of [0, 17, GENERIC_STREAM_CHUNK_BYTES + 18, 0xffffffff]) {
    const changed = Buffer.from(ciphertext);
    changed.writeUInt32BE(length, 32);
    await assert.rejects(collect(decoder(changed, metadata)), corruptError);
  }
});

test('truncated prefixes, missing/partial FINAL and trailing data cannot complete', async () => {
  const {ciphertext, metadata} = await encoded(randomBytes(GENERIC_STREAM_CHUNK_BYTES + 5));
  const parsed = frames(ciphertext);
  const withoutFinal = Buffer.concat([parsed.prefix, ...parsed.frames.slice(0, -1)]);
  for (const bytes of [Buffer.alloc(0), ciphertext.subarray(0, 31), ciphertext.subarray(0, 35), withoutFinal, ciphertext.subarray(0, -1), Buffer.concat([ciphertext, Buffer.from([0])])]) {
    let complete = false;
    await assert.rejects(collect(decoder(bytes, metadata, {onComplete: () => { complete = true; }})), corruptError);
    assert.equal(complete, false);
  }
});

test('reordering, duplicating and removing complete frames are detected by secretstream', async () => {
  const {ciphertext, metadata} = await encoded(randomBytes(GENERIC_STREAM_CHUNK_BYTES * 2 + 9));
  const {prefix, frames: blocks} = frames(ciphertext);
  for (const order of [[1, 0, 2, 3], [0, 0, 1, 2, 3], [0, 2, 3], [3, 0, 1, 2]]) {
    await assert.rejects(collect(decoder(Buffer.concat([prefix, ...order.map(index => blocks[index])]), metadata)), corruptError);
  }
});

test('a valid prefix is yielded but never accepted as a complete truncated file', async () => {
  const input = randomBytes(GENERIC_STREAM_CHUNK_BYTES + 4);
  const {ciphertext, metadata} = await encoded(input);
  const {prefix, frames: blocks} = frames(ciphertext);
  const stream = decoder(Buffer.concat([prefix, blocks[0]]), metadata);
  const first = await stream.next();
  assert.deepEqual(Buffer.from(first.value), input.subarray(0, GENERIC_STREAM_CHUNK_BYTES));
  await assert.rejects(stream.next(), corruptError);
});

test('encryption pulls no input before demand and never prefetches the next producer buffer', async () => {
  let pulls = 0, returned = 0, completed = false;
  const input = Buffer.alloc(GENERIC_STREAM_CHUNK_BYTES * 3, 0x5a);
  const source = {
    [Symbol.asyncIterator]() { return this; },
    async next() { pulls++; return pulls === 1 ? {value: input, done: false} : {done: true}; },
    async return() { returned++; return {done: true}; },
  };
  const stream = encryptGenericFileStream(source, {...context, onComplete: () => { completed = true; }});
  assert.equal(pulls, 0);
  await stream.next();
  assert.equal(pulls, 0);
  for (let index = 0; index < 3; index++) {
    const next = await stream.next();
    assert.ok(next.value.length <= GENERIC_STREAM_CHUNK_BYTES + 21);
    assert.equal(pulls, 1);
  }
  await stream.return();
  assert.equal(returned, 1);
  assert.equal(completed, false);
  assert.deepEqual(input, Buffer.alloc(input.length, 0x5a));
});

test('early decryption return closes its producer and leaves output caller-owned', async () => {
  const input = randomBytes(GENERIC_STREAM_CHUNK_BYTES * 2);
  const {ciphertext, metadata} = await encoded(input);
  let returned = 0, pulls = 0;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    async next() { pulls++; return pulls === 1 ? {value: ciphertext, done: false} : {done: true}; },
    async return() { returned++; return {done: true}; },
  };
  const stream = decryptGenericFileStream(source, {...context, expectedSha256: metadata.sha256, expectedBytes: metadata.bytes, expectedName: metadata.name});
  const {value} = await stream.next();
  await stream.return();
  assert.equal(returned, 1);
  assert.equal(pulls, 1);
  assert.deepEqual(Buffer.from(value), input.subarray(0, GENERIC_STREAM_CHUNK_BYTES));
});

test('abort before start performs no producer read and preserves the signal reason', async () => {
  const controller = new AbortController();
  const reason = new Error('synthetic cancellation');
  controller.abort(reason);
  let reads = 0;
  const source = {[Symbol.asyncIterator]() { return this; }, next() { reads++; return {done: true}; }};
  await assert.rejects(collect(encryptGenericFileStream(source, {...context, signal: controller.signal})), error => error === reason);
  await assert.rejects(collect(decryptGenericFileStream(source, {...context, signal: controller.signal})), error => error === reason);
  assert.equal(reads, 0);
});

test('abort interrupts a pending producer and requests return without retaining cipher state', async () => {
  for (const encrypt of [true, false]) {
    const controller = new AbortController();
    const reason = new Error('synthetic pending cancellation');
    let returned = 0, started;
    const waiting = new Promise(resolve => { started = resolve; });
    const source = {
      [Symbol.asyncIterator]() { return this; },
      next() { started(); return new Promise(() => {}); },
      return() { returned++; return new Promise(() => {}); },
    };
    const stream = encrypt
      ? encryptGenericFileStream(source, {...context, signal: controller.signal})
      : decryptGenericFileStream(source, {...context, signal: controller.signal});
    if (encrypt) await stream.next(); // header; input has not yet been pulled
    const pending = stream.next();
    await waiting;
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    await Promise.resolve();
    assert.equal(returned, 1);
  }
});

test('source I/O failure is preserved and malformed producer chunks are refused', async () => {
  const io = new Error('synthetic I/O failure');
  const source = () => (async function* () { throw io; })();
  await assert.rejects(collect(encryptGenericFileStream(source(), context)), error => error === io);
  await assert.rejects(collect(decryptGenericFileStream(source(), context)), error => error === io);
  await assert.rejects(collect(encryptGenericFileStream(['not bytes'], context)), TypeError);
  await assert.rejects(collect(decryptGenericFileStream(['not bytes'], context)), corruptError);
});

test('a primary source failure survives throwing or permanently pending cleanup', {timeout: 2000}, async () => {
  for (const encrypt of [true, false]) {
    for (const cleanupThrows of [true, false]) {
      const primary = new Error('synthetic primary I/O failure');
      let returns = 0;
      const source = {
        [Symbol.asyncIterator]() { return this; },
        next() { return Promise.reject(primary); },
        return() {
          returns++;
          if (cleanupThrows) throw new Error('synthetic secondary cleanup failure');
          return new Promise(() => {});
        },
      };
      const stream = encrypt ? encryptGenericFileStream(source, context) : decryptGenericFileStream(source, context);
      await assert.rejects(collect(stream), error => error === primary);
      assert.equal(returns, 1);
    }
  }
});

test('abort interrupts a pending completion callback after FINAL on both directions', {timeout: 2000}, async () => {
  const {ciphertext, metadata} = await encoded(Buffer.from('synthetic completion fixture'));
  for (const encrypt of [true, false]) {
    const controller = new AbortController();
    const reason = new Error('synthetic completion cancellation');
    let entered;
    const waiting = new Promise(resolve => { entered = resolve; });
    const onComplete = () => { entered(); return new Promise(() => {}); };
    const stream = encrypt
      ? encryptGenericFileStream([], {...context, signal: controller.signal, onComplete})
      : decoder(ciphertext, metadata, {signal: controller.signal, onComplete});
    const pending = collect(stream);
    await waiting;
    controller.abort(reason);
    await assert.rejects(pending, error => error === reason);
    assert.deepEqual(key, Buffer.alloc(32, 0x63));
  }
});

test('invalid key, identities, name and callbacks fail before input consumption', async () => {
  let reads = 0;
  const source = {[Symbol.iterator]() { return this; }, next() { reads++; return {done: true}; }};
  for (const options of [{key: Buffer.alloc(31)}, {rootId: ''}, {objectId: ''}, {objectId: 'x'.repeat(257)}, {name: ''}, {name: 'x'.repeat(256)}, {name: '\ud800'}, {onComplete: 1}]) {
    await assert.rejects(collect(encryptGenericFileStream(source, {...context, ...options})), TypeError);
  }
  assert.equal(reads, 0);
});

test('owned WASM states are wiped and freed on success, failure and early return', async () => {
  await sodium.ready;
  const core = sodium.libsodium;
  const originalFree = core._free;
  const originalPush = sodium.crypto_secretstream_xchacha20poly1305_init_push;
  const originalPull = sodium.crypto_secretstream_xchacha20poly1305_init_pull;
  const live = new Set();
  let released = 0;
  sodium.crypto_secretstream_xchacha20poly1305_init_push = (...args) => {
    const initialized = originalPush(...args);
    live.add(initialized.state);
    return initialized;
  };
  sodium.crypto_secretstream_xchacha20poly1305_init_pull = (...args) => {
    const state = originalPull(...args);
    if (state) live.add(state);
    return state;
  };
  core._free = address => {
    if (live.delete(address)) {
      const length = core._crypto_secretstream_xchacha20poly1305_statebytes();
      assert.ok(core.HEAPU8.subarray(address, address + length).every(byte => byte === 0));
      released++;
    }
    return originalFree(address);
  };
  try {
    const {ciphertext, metadata} = await encoded(randomBytes(GENERIC_STREAM_CHUNK_BYTES + 1));
    await collect(decoder(ciphertext, metadata));
    await assert.rejects(collect(decoder(ciphertext, metadata, {key: Buffer.alloc(32)})), corruptError);
    const encryption = encryptGenericFileStream([], context);
    await encryption.next();
    await encryption.return();
    const decryption = decoder(ciphertext, metadata);
    await decryption.next();
    await decryption.return();
    assert.equal(live.size, 0);
    assert.equal(released, 5);
  } finally {
    core._free = originalFree;
    sodium.crypto_secretstream_xchacha20poly1305_init_push = originalPush;
    sodium.crypto_secretstream_xchacha20poly1305_init_pull = originalPull;
  }
});
