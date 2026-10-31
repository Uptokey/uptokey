import assert from 'node:assert/strict';
import {mkdtemp, mkdir, readFile, rm, stat, utimes, writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import test from 'node:test';
import {MaterializationEviction} from './materialization-eviction.mjs';
import {MaterializationOwnership} from './materialization-ownership.mjs';

const digest = value => value.repeat(64).slice(0, 64);
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-eviction-'));
  const image = join(root, 'objects', 'aa', digest('a'));
  const file = join(root, 'files', 'bb', digest('b'), 'data.csv');
  await mkdir(join(root, 'objects', 'aa'), {recursive: true});
  await mkdir(join(root, 'files', 'bb', digest('b')), {recursive: true});
  await writeFile(image, 'image', {mode: 0o400}); await writeFile(file, 'file-data', {mode: 0o400});
  await utimes(image, new Date(0), new Date(0)); await utimes(file, new Date(0), new Date(0));
  return {root, image, file, close: () => rm(root, {recursive: true, force: true})};
}

test('automatic sweep waits every global owner before removing idle materializations', async () => {
  const f = await fixture(), ownership = new MaterializationOwnership({processRangeOwner: 'linux-systemd-scope'});
  const eviction = new MaterializationEviction({idleMs: 100, graceMs: 10, intervalMs: 1000, now: () => 10_000});
  const detach = eviction.attach({root: f.root, capacityBytes: 1024, ownership});
  const lease = ownership.acquire('process-range'), sweep = eviction.sweep();
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await stat(f.image)).size, 5); assert.throws(() => ownership.acquire('filesystem-reader'), /exclusive/);
  lease.release(); const result = await sweep;
  assert.deepEqual(result, {examined: 2, removed: 2, bytesFreed: 14, bytesRemaining: 0, pressure: false});
  await assert.rejects(stat(f.image), {code: 'ENOENT'}); await assert.rejects(stat(f.file), {code: 'ENOENT'});
  detach(); await f.close();
});

test('touch grace protects freshly granted paths even under pressure', async () => {
  const f = await fixture(), ownership = new MaterializationOwnership({processRangeOwner: 'linux-systemd-scope'}); let now = 10_000;
  const eviction = new MaterializationEviction({idleMs: 1000, graceMs: 100, intervalMs: 1000, highWatermark: .5, targetWatermark: .25, now: () => now});
  const detach = eviction.attach({root: f.root, capacityBytes: 8, ownership});
  eviction.touch(f.image); const first = await eviction.sweep();
  assert.equal(first.pressure, true); assert.equal(first.removed, 1); assert.equal(await readFile(f.image, 'utf8'), 'image');
  now += 101; const second = await eviction.sweep();
  assert.equal(second.removed, 1); await assert.rejects(stat(f.image), {code: 'ENOENT'});
  detach(); await f.close();
});

test('attach is shared only for the exact root, capacity and ownership', async () => {
  const f = await fixture(), ownership = new MaterializationOwnership({processRangeOwner: 'linux-systemd-scope'});
  const eviction = new MaterializationEviction({intervalMs: 1000});
  const one = eviction.attach({root: f.root, capacityBytes: 1024, ownership});
  const two = eviction.attach({root: f.root, capacityBytes: 1024, ownership});
  assert.throws(() => eviction.attach({root: f.root, capacityBytes: 2048, ownership}), /contract/);
  one(); two(); assert.equal(eviction.refs, 0); await f.close();
});

test('last detach keeps the pool contract until an in-flight sweep settles', async () => {
  const f = await fixture(), ownership = new MaterializationOwnership({processRangeOwner: 'linux-systemd-scope'});
  const eviction = new MaterializationEviction({idleMs: 100, graceMs: 10, intervalMs: 1000, now: () => 10_000});
  const detach = eviction.attach({root: f.root, capacityBytes: 1024, ownership});
  const lease = ownership.acquire('filesystem-reader'), sweep = eviction.sweep();
  detach(); assert.equal(eviction.root, f.root); assert.equal(eviction.refs, 0);
  assert.throws(() => eviction.attach({root: join(f.root, 'other'), capacityBytes: 1024, ownership}), /contract/);
  lease.release(); await sweep; assert.equal(eviction.root, undefined); assert.equal(eviction.ownership, undefined);
  await f.close();
});

test('fallback ownership keeps automatic and manual materialization deletion disabled', async () => {
  const f = await fixture(), ownership = new MaterializationOwnership({processRangeOwner: 'fallback'});
  let scheduled = 0;
  const eviction = new MaterializationEviction({intervalMs: 1, setTimer: () => { scheduled++; }});
  const detach = eviction.attach({root: f.root, capacityBytes: 1, ownership});
  eviction.touch(f.image);
  assert.equal(scheduled, 0);
  await assert.rejects(eviction.sweep(), /owner_unavailable/);
  assert.equal(await readFile(f.image, 'utf8'), 'image');
  assert.equal(await readFile(f.file, 'utf8'), 'file-data');
  detach(); await f.close();
});
