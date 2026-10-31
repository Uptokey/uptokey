import test from 'node:test';
import assert from 'node:assert/strict';
import {MaterializationOwnership, ownProcessRange, ownTerminalRange, trackAsyncIterable, trackPromise} from './materialization-ownership.mjs';

test('only canonical non-escapable range owners admit automatic eviction', () => {
  assert.equal(new MaterializationOwnership().canEvictMaterializations(), false);
  assert.equal(new MaterializationOwnership({processRangeOwner: 'fallback'}).canEvictMaterializations(), false);
  assert.equal(new MaterializationOwnership({processRangeOwner: 'windows-job'}).canEvictMaterializations(), true);
  assert.equal(new MaterializationOwnership({processRangeOwner: 'linux-systemd-scope'}).canEvictMaterializations(), true);
  assert.throws(() => new MaterializationOwnership({processRangeOwner: 'process-tree'}), /process_range_owner/);
});

test('exclusive action waits all readers and blocks new owners', async () => {
  const ownership = new MaterializationOwnership();
  const reader = ownership.acquire('filesystem-reader');
  const materializer = ownership.acquire('materialization');
  let entered = false;
  const exclusive = ownership.runExclusive(async () => { entered = true; return 17; });
  assert.throws(() => ownership.acquire('process-range'), /exclusive/);
  reader.release(); await Promise.resolve(); assert.equal(entered, false);
  materializer.release(); assert.equal(await exclusive, 17);
  assert.equal(ownership.snapshot().active, 0);
  ownership.acquire('reader').release();
});

test('exclusive reservation is visible before a zero-reader action and reopens after failure', async () => {
  const ownership = new MaterializationOwnership();
  let nested;
  await assert.rejects(ownership.runExclusive(async () => {
    nested = ownership.runExclusive(async () => 'forbidden');
    await assert.rejects(nested, /exclusive/);
    throw Error('synthetic exclusive failure');
  }), /synthetic exclusive failure/);
  assert.deepEqual(ownership.snapshot(), {accepting: true, active: 0, kinds: {}});
  assert.equal(await ownership.runExclusive(async () => 23), 23);
});

test('promise and iterable owners cover their complete consumer lifetime', async () => {
  const ownership = new MaterializationOwnership();
  let resolve; const pending = new Promise(done => { resolve = done; });
  const work = trackPromise(ownership, 'operation', () => pending);
  assert.equal(ownership.snapshot().kinds.operation, 1); resolve('ok'); assert.equal(await work, 'ok');
  const iterable = trackAsyncIterable(ownership, 'reader', (async function* () { yield 1; yield 2; })());
  assert.equal((await iterable.next()).value, 1); assert.equal(ownership.snapshot().kinds.reader, 1);
  await iterable.return(); assert.equal(ownership.snapshot().active, 0);
});

test('an iterator that survives return or throw remains owned until done', async () => {
  const ownership = new MaterializationOwnership();
  let step = 0;
  const source = {
    [Symbol.asyncIterator]() { return this; },
    async next() { return step++ < 2 ? {done: false, value: step} : {done: true}; },
    async return() { return {done: false, value: 'still-open'}; },
    async throw() { return {done: false, value: 'recovered'}; },
  };
  const iterable = trackAsyncIterable(ownership, 'reader', source);
  assert.equal((await iterable.return()).done, false);
  assert.equal(ownership.snapshot().kinds.reader, 1);
  assert.equal((await iterable.throw(Error('recoverable'))).done, false);
  assert.equal(ownership.snapshot().kinds.reader, 1);
  await iterable.next(); await iterable.next(); await iterable.next();
  assert.equal(ownership.snapshot().active, 0);
});

test('direct process completion cannot release a surviving managed range', async () => {
  const ownership = new MaterializationOwnership();
  let rangeEmpty; const range = new Promise(done => { rangeEmpty = done; });
  ownProcessRange(ownership, {waitForExit: () => range});
  let entered = false; const exclusive = ownership.runExclusive(async () => { entered = true; });
  await Promise.resolve(); assert.equal(entered, false);
  rangeEmpty(true); await exclusive; assert.equal(ownership.snapshot().active, 0);
});

test('lost process observability remains owned and fails closed', async () => {
  const ownership = new MaterializationOwnership();
  ownProcessRange(ownership, {waitForExit: () => Promise.reject(Error('lost'))});
  await new Promise(done => setImmediate(done));
  assert.deepEqual(ownership.snapshot().kinds, {'process-range': 1});
});

test('terminal ownership ends only after whole-session termination', async () => {
  const ownership = new MaterializationOwnership();
  let direct, quiescent; const done = new Promise(resolve => { direct = resolve; });
  const terminate = new Promise(resolve => { quiescent = resolve; });
  ownTerminalRange(ownership, {done, terminate: () => terminate});
  direct(); await Promise.resolve(); assert.equal(ownership.snapshot().kinds['terminal-range'], 1);
  quiescent(); await new Promise(resolve => setImmediate(resolve)); assert.equal(ownership.snapshot().active, 0);
});
