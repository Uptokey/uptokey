import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {chmod, link, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, utimes, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {Context, Service} from '@deepseek-ai/cordis';
import {CACHE_PATH, CACHE_CAPACITY, CACHE_BYTE_BUDGET, CACHE_ENTRY_LIMIT, CacheJanitor, Config, verifyCacheMount, wrapReadImageRequests} from './request-image-cache.mjs';

const linux = {skip: process.platform !== 'linux'};
const digest = value => createHash('sha256').update(String(value)).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-request-cache-')), path = join(root, 'cache');
  await mkdir(path, {mode: 0o700}); await chmod(path, 0o700);
  t.after(async () => { assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'uptokey-request-cache-')); await rm(root, {recursive: true, force: true}); });
  const variant = async (id, size = 16, age = Number(id) + 1000) => {
    const hash = digest(id), file = join(path, 'request-images', hash.slice(0, 2), hash);
    await mkdir(dirname(file), {recursive: true, mode: 0o700});
    await writeFile(file, Buffer.alloc(size, 7), {mode: 0o600}); await utimes(file, age, age);
    return file;
  };
  return {root, path, variant};
}
const fakeJanitor = () => ({async sweep() {}, async drain() {}});

test('configuration bounds only the original cache path and private retention budget', () => {
  const defaults = Config['~standard'].validate({});
  assert.deepEqual(defaults.value, {path: CACHE_PATH, byteBudget: CACHE_BYTE_BUDGET, maxEntries: CACHE_ENTRY_LIMIT});
  for (const input of [{path: '/other'}, {byteBudget: CACHE_BYTE_BUDGET + 1}, {maxEntries: 257}]) assert.ok(Config['~standard'].validate(input).issues);
  for (const input of [{path: 'relative'}, {byteBudget: 0}, {maxEntries: 257}]) assert.throws(() => new CacheJanitor(input));
});

test('metadata-only sweep retains newest bounded entries and bytes with bounded candidate storage', linux, async t => {
  const f = await fixture(t), paths = [];
  for (let id = 0; id < 300; id++) paths.push(await f.variant(id));
  const janitor = new CacheJanitor({path: f.path, byteBudget: 48, maxEntries: 4});
  const result = await janitor.sweep();
  assert.equal(result.scanned, 300); assert.equal(result.keptEntries, 3); assert.equal(result.keptBytes, 48);
  assert.ok(result.peakEntries <= 4);
  for (let id = 0; id < 297; id++) await assert.rejects(lstat(paths[id]), {code: 'ENOENT'});
  for (let id = 297; id < 300; id++) assert.equal((await lstat(paths[id])).size, 16);
  assert.equal((await janitor.sweep()).removed, 0);
});

test('force eviction touches only finalized canonical names, preserving active temporaries and unknown files', linux, async t => {
  const f = await fixture(t), file = await f.variant(1);
  const temporary = file + '.00000000-0000-4000-8000-000000000001.tmp';
  const manifest = join(f.path, 'manifest.json'), normal = join(f.path, 'normal-image');
  await writeFile(temporary, 'active'); await writeFile(manifest, 'manifest'); await writeFile(normal, 'original');
  const unknown = join(dirname(file), 'unknown'); await writeFile(unknown, 'unknown');
  const result = await new CacheJanitor({path: f.path}).sweep({force: true});
  assert.equal(result.removed, 1); await assert.rejects(lstat(file), {code: 'ENOENT'});
  for (const [path, value] of [[temporary, 'active'], [manifest, 'manifest'], [normal, 'original'], [unknown, 'unknown']]) assert.equal(await readFile(path, 'utf8'), value);
});

test('oversized single variant is evicted without deleting its containing directories', linux, async t => {
  const f = await fixture(t), file = await f.variant(1, 65);
  const result = await new CacheJanitor({path: f.path, byteBudget: 64}).sweep();
  assert.equal(result.keptBytes, 0); await assert.rejects(lstat(file), {code: 'ENOENT'});
  assert.equal((await lstat(dirname(file))).isDirectory(), true);
});

test('recognized hardlinks, symlink parents and nonprivate final files are refused without deletion', linux, async t => {
  const f = await fixture(t), file = await f.variant(1), alias = join(f.root, 'alias');
  await link(file, alias);
  const janitor = new CacheJanitor({path: f.path});
  await assert.rejects(janitor.sweep({force: true}), /unsafe_path/);
  assert.equal((await lstat(file)).nlink, 2); assert.equal((await lstat(alias)).nlink, 2);
  await rm(alias); await chmod(file, 0o400);
  await assert.rejects(janitor.sweep({force: true}), /unsafe_path/); assert.equal((await lstat(file)).mode & 0o777, 0o400);
  await chmod(file, 0o600); await rm(file);
  const target = join(f.root, 'private-target'); await mkdir(target, {mode: 0o700});
  await symlink(target, join(f.path, 'request-images', 'ff'));
  await assert.rejects(janitor.sweep({force: true}), /unsafe_path/); assert.equal((await lstat(target)).isDirectory(), true);
});

test('simultaneous sweeps share one mutex and settle within the retention limits', linux, async t => {
  const f = await fixture(t);
  for (let id = 0; id < 12; id++) await f.variant(id);
  const janitor = new CacheJanitor({path: f.path, maxEntries: 2});
  const results = await Promise.all([janitor.sweep(), janitor.sweep(), janitor.sweep()]);
  assert.equal(results[0].removed, 10); assert.equal(results[1].removed, 0); assert.equal(results[2].keptEntries, 2);
});

for (const code of ['ENOSPC', 'EDQUOT']) test(`original ${code} evicts and retries once with identical receiver and arguments`, async () => {
  const calls = [], sweeps = [], ref = {}, target = {}, signal = new AbortController().signal, result = {};
  const janitor = {async sweep(options = {}) { sweeps.push(options.force === true); }, async drain() {}};
  const originalError = Object.assign(Error('synthetic private content'), {code});
  const service = {async readImageRequest(...args) { calls.push({receiver: this, args}); if (calls.length === 1) throw originalError; return result; }};
  const adapter = wrapReadImageRequests(service, janitor);
  assert.equal(await service.readImageRequest(ref, target, signal), result);
  assert.equal(calls.length, 2); for (const call of calls) { assert.equal(call.receiver, service); assert.deepEqual(call.args, [ref, target, signal]); }
  assert.deepEqual(sweeps, [false, true, false]); await adapter.dispose();
});

test('a second capacity failure and unrelated provider failures preserve the exact original rejection', async () => {
  const full = Object.assign(Error('synthetic'), {code: 'ENOSPC'}), unrelated = Object.assign(Error('synthetic'), {code: 'EIO'});
  for (const [error, expectedCalls] of [[full, 2], [unrelated, 1]]) {
    let calls = 0;
    const service = {async readImageRequest() { calls++; throw error; }}, adapter = wrapReadImageRequests(service, fakeJanitor());
    await assert.rejects(service.readImageRequest({}), value => value === error); assert.equal(calls, expectedCalls); await adapter.dispose();
  }
});

test('unsafe forced eviction propagates without retrying the provider and disposal still restores it', async () => {
  const full = Object.assign(Error('synthetic full cache'), {code: 'ENOSPC'}), unsafe = Error('request_image_cache_unsafe_path');
  const sweeps = []; let calls = 0;
  const janitor = {async sweep(options = {}) { sweeps.push(options.force === true); if (options.force) throw unsafe; }, async drain() {}};
  const service = {async readImageRequest() { calls++; throw full; }}, original = service.readImageRequest;
  const adapter = wrapReadImageRequests(service, janitor);
  await assert.rejects(service.readImageRequest(), error => error === unsafe);
  assert.equal(calls, 1); assert.deepEqual(sweeps, [false, true, false]);
  await adapter.dispose(); assert.equal(service.readImageRequest, original);
});

test('post-request cleanup failure cannot reject a valid result or leak error contents to warnings', async () => {
  let sweeps = 0; const warnings = [], result = {};
  const janitor = {async sweep() { if (++sweeps > 1) throw Error('/private/path secret'); }, async drain() {}};
  const service = {async readImageRequest() { return result; }}, adapter = wrapReadImageRequests(service, janitor, {warn: value => warnings.push(value)});
  assert.equal(await service.readImageRequest(), result);
  assert.deepEqual(warnings, ['Uptokey request image cache cleanup unavailable.']); await adapter.dispose();
});

test('pre-request unsafe sweep refuses before invoking the original provider', async () => {
  const error = Error('request_image_cache_unsafe_path'); let calls = 0;
  const service = {async readImageRequest() { calls++; }}, adapter = wrapReadImageRequests(service, {async sweep() { throw error; }, async drain() {}});
  await assert.rejects(service.readImageRequest(), value => value === error); assert.equal(calls, 0); await adapter.dispose();
});

test('already-cancelled requests retain their abort reason without cleanup or provider work', async () => {
  const reason = Error('synthetic cancelled'), controller = new AbortController(); controller.abort(reason);
  let sweeps = 0, calls = 0;
  const janitor = {async sweep() { sweeps++; }, async drain() {}};
  const service = {async readImageRequest() { calls++; }}, adapter = wrapReadImageRequests(service, janitor);
  await assert.rejects(service.readImageRequest({}, {}, controller.signal), error => error === reason);
  assert.equal(sweeps, 0); assert.equal(calls, 0); await adapter.dispose();
});

test('wrapper retains original in-flight sharing and concurrent distinct transformations', {timeout: 5000}, async () => {
  const started = Promise.withResolvers(), release = Promise.withResolvers(), inflight = new Map(); let transforms = 0;
  const service = {readImageRequest(ref) {
    if (!inflight.has(ref)) { transforms++; if (transforms === 2) started.resolve(); inflight.set(ref, release.promise.then(() => ({ref}))); }
    return inflight.get(ref);
  }};
  const adapter = wrapReadImageRequests(service, fakeJanitor()), a = {}, b = {};
  const one = service.readImageRequest(a), two = service.readImageRequest(a), three = service.readImageRequest(b);
  await started.promise; assert.equal(transforms, 2); release.resolve();
  const values = await Promise.all([one, two, three]); assert.equal(values[0], values[1]); assert.notEqual(values[0], values[2]); await adapter.dispose();
});

test('dispose joins accepted requests, refuses new work and restores the inherited method', async () => {
  const release = Promise.withResolvers(), started = Promise.withResolvers();
  class Provider { async readImageRequest() { started.resolve(); return release.promise; } }
  const service = new Provider(), original = service.readImageRequest, adapter = wrapReadImageRequests(service, fakeJanitor());
  const work = service.readImageRequest(); await started.promise;
  let disposed = false; const close = adapter.dispose().then(() => { disposed = true; });
  await assert.rejects(service.readImageRequest(), /closed/); await Promise.resolve(); assert.equal(disposed, false);
  release.resolve('complete'); assert.equal(await work, 'complete'); await close;
  assert.equal(service.readImageRequest, original); assert.equal(Object.hasOwn(service, 'readImageRequest'), false);
});

test('raw descriptor restoration also works through real Cordis service tracing', async () => {
  const ctx = new Context(); let seen;
  class Attachments extends Service {
    constructor(scope) { super(scope, 'attachments'); }
    async readImageRequest() { seen = this.ctx.fiber; return 'original'; }
  }
  const provider = ctx.plugin(Attachments); await provider.await();
  const service = ctx.get('attachments'), adapter = wrapReadImageRequests(service, fakeJanitor());
  assert.equal(await service.readImageRequest(), 'original'); assert.equal(seen, ctx.fiber);
  await adapter.dispose(); assert.equal(Object.hasOwn(service, 'readImageRequest'), false);
  assert.equal(await service.readImageRequest(), 'original'); await ctx.fiber.dispose();
});

test('guard snapshot tests require exact private tmpfs mount, noswap/noexec and capacity; not a live mount acceptance', linux, async t => {
  const f = await fixture(t);
  const stats = {type: 0x01021994n, bsize: 4096n, blocks: BigInt(CACHE_CAPACITY / 4096)};
  const mountInfo = `1 0 0:99 / ${f.path} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,noswap,size=262144k\n`;
  const good = await verifyCacheMount(f.path, {stats, mountInfo}); assert.equal(good.capacityBytes, CACHE_CAPACITY);
  for (const snapshot of [
    {stats, mountInfo: mountInfo.replace(',noexec', '')},
    {stats, mountInfo: mountInfo.replace(',noswap', '')},
    {stats, mountInfo: mountInfo.replace(f.path, dirname(f.path))},
    {stats: {...stats, type: 0xef53n}, mountInfo},
    {stats: {...stats, blocks: stats.blocks + 1n}, mountInfo},
  ]) await assert.rejects(verifyCacheMount(f.path, snapshot), /mount_invalid/);
  await chmod(f.path, 0o755); await assert.rejects(verifyCacheMount(f.path, {stats, mountInfo}), /unsafe_path/);
});
