import test from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, realpath, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import sharp from 'sharp';
import {Context, Service} from '@deepseek-ai/cordis';
import LocalAttachmentStore, {prepareImageFile} from '@deepseek-ai/dsh-attachment-local';
import {FsError} from '@deepseek-ai/dsh-fs';
import {CACHE_CAPACITY} from './request-image-cache.mjs';
import {EncryptedImageStore, installEncryptedImages, installImagePathHydration, imageHydrationMiddleware, imageReferences} from './encrypted-images.mjs';
import {MaterializationOwnership} from './materialization-ownership.mjs';

const linux = {skip: process.platform !== 'linux'};
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-encrypted-images-'));
  const config = {root: join(root, 'encrypted'), materialization: join(root, 'materialized'), keyPath: join(root, 'key')};
  await mkdir(config.materialization, {mode: 0o700}); await chmod(config.materialization, 0o700);
  await writeFile(config.keyPath, randomBytes(32).toString('hex'), {mode: 0o400});
  const contexts = [], stores = [], adapters = [];
  t.after(async () => {
    for (const adapter of adapters) await adapter.dispose();
    for (const store of stores) await store.close();
    for (const ctx of contexts) await ctx.fiber.dispose();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'uptokey-encrypted-images-')); await rm(root, {recursive: true, force: true});
  });
  const mountSnapshot = path => ({stats: {type: 0x01021994n, bsize: 4096n, blocks: BigInt(CACHE_CAPACITY / 4096)},
    mountInfo: `1 0 0:99 / ${path} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,noswap\n`});
  const store = (extra = {}) => {
    const {mountCapacity = CACHE_CAPACITY, ...overrides} = extra, options = {...config, ...overrides};
    const snapshot = mountSnapshot(options.materialization); snapshot.stats = {type: 0x01021994n, bsize: 1n, blocks: BigInt(mountCapacity)};
    const value = new EncryptedImageStore({...options, mountSnapshot: snapshot}); stores.push(value); return value;
  };
  const boot = async (extra = {}) => {
    const ctx = new Context(); contexts.push(ctx);
    const fiber = ctx.plugin(LocalAttachmentStore, {dshHome: join(root, 'legacy-home'), ...extra}); await fiber.await();
    return {ctx, service: ctx.get('attachments')};
  };
  const install = (service, value) => { const adapter = installEncryptedImages(service, value); adapters.push(adapter); return adapter; };
  const installPath = (filesystem, value) => { const adapter = installImagePathHydration(filesystem, value); adapters.push(adapter); return adapter; };
  return {root, config, store, boot, install, installPath};
}
const input = async (colour = '#13579b') => ({data: await sharp({create: {width: 8, height: 4, channels: 4, background: colour}}).png().toBuffer(), mediaType: 'image/png', name: 'private-synthetic-image.png'});
async function allFiles(path) {
  const files = [];
  try { for (const entry of await readdir(path, {withFileTypes: true})) { const child = join(path, entry.name); if (entry.isDirectory()) files.push(...await allFiles(child)); else files.push(child); } }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  return files;
}

test('image save retains global materialization ownership through encryption and publication', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), ownership = new MaterializationOwnership(), store = f.store({ownership}); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy);
  const original = store.crypto.encryptObject.bind(store.crypto), entered = Promise.withResolvers(), release = Promise.withResolvers();
  store.crypto.encryptObject = async (...args) => { entered.resolve(); await release.promise; return original(...args); };
  const saving = store.savePrepared(prepared); await entered.promise;
  assert.equal(ownership.snapshot().kinds.materialization, 1);
  let exclusiveEntered = false; const exclusive = ownership.runExclusive(async () => { exclusiveEntered = true; });
  await new Promise(done => setImmediate(done)); assert.equal(exclusiveEntered, false);
  release.resolve(); const ref = await saving; await exclusive;
  assert.equal(ref.attachmentId, prepared.ref.attachmentId); assert.equal(ownership.snapshot().active, 0);
});

test('new normalized images are cipher-only on durable storage and are materialized before references return', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready(); f.install(service, store);
  const ref = await service.saveImage(await input()), path = service.imageHostPath(ref), stored = await service.readImage(ref);
  assert.ok(path.startsWith(f.config.materialization + '/objects/')); assert.equal((await lstat(path)).mode & 0o777, 0o400);
  assert.equal(stored.ref.attachmentId, ref.attachmentId); assert.equal(stored.data.byteLength, ref.bytes);
  await assert.rejects(lstat(join(service.root, 'objects')), {code: 'ENOENT'});
  const envelope = JSON.parse(await readFile(store.cipherPath(ref), 'utf8'));
  assert.equal(envelope.schemaVersion, 2); assert.equal(envelope.resourceScope, 'image-normalized');
  for (const file of await allFiles(f.config.root)) {
    const bytes = await readFile(file); assert.equal(bytes.includes(Buffer.from('private-synthetic-image')), false);
    assert.equal(bytes.includes(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])), false);
  }
  const request = await service.readImageRequest(ref, {width: 4, height: 2, maxBytes: 1024});
  assert.equal(request.attachment.attachmentId, ref.attachmentId); assert.equal(request.width, 4);
});

test('legacy read/path bytes and all generic file methods remain unchanged', linux, async t => {
  const f = await fixture(t), {service} = await f.boot();
  const legacy = await service.saveImage(await input('#abcdef')), oldPath = service.imageHostPath(legacy), oldBytes = await readFile(oldPath);
  const file = await service.saveFile({data: Buffer.from('synthetic file'), name: 'sample.txt'}), filePath = service.fileHostPath(file);
  const descriptor = Object.getOwnPropertyDescriptor(service, 'readImageRequest');
  const store = f.store(); await store.ready(); const adapter = f.install(service, store);
  assert.equal(service.imageHostPath(legacy), oldPath); assert.deepEqual((await service.readImage(legacy)).data, new Uint8Array(oldBytes));
  const newRef = await service.saveImage(await input()); assert.equal(store.has(newRef), true); assert.equal(store.has(legacy), false);
  assert.equal(service.fileHostPath(file), filePath); let text = ''; for await (const bytes of service.readFileStream(file)) text += Buffer.from(bytes).toString(); assert.equal(text, 'synthetic file');
  assert.deepEqual(Object.getOwnPropertyDescriptor(service, 'readImageRequest'), descriptor);
  await adapter.dispose(); assert.equal(Object.hasOwn(service, 'readImage'), false); assert.equal(Object.hasOwn(service, 'saveImages'), false);
  assert.deepEqual(await readFile(oldPath), oldBytes);
});

test('batch validation finishes before any member is encrypted', linux, async t => {
  const f = await fixture(t), {service} = await f.boot({maxImageBytes: 1024}), store = f.store(); await store.ready(); f.install(service, store);
  const good = await input(), bad = {...good, data: Buffer.alloc(2048)};
  await assert.rejects(service.saveImages([good, bad]), error => error.code === 'IMAGE_TOO_LARGE');
  assert.deepEqual(await readdir(f.config.root), ['.uptokey-encrypted-images-v1']);
  const refs = await service.saveImages([good, await input('#fedcba')]); assert.equal(refs.length, 2);
  for (const ref of refs) assert.equal((await lstat(service.imageHostPath(ref))).isFile(), true);
});

test('cold normalized image reads recreate only volatile objects with the same reference and bytes', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), first = f.store(); await first.ready(); const adapter = f.install(service, first);
  const ref = await service.saveImage(await input()), original = await readFile(service.imageHostPath(ref)); await adapter.dispose();
  const cold = join(f.root, 'cold-materialization'); await mkdir(cold, {mode: 0o700});
  const second = f.store({materialization: cold}); await second.ready();
  assert.equal(second.has(ref), true); await assert.rejects(lstat(second.materialPath(ref)), {code: 'ENOENT'});
  const value = await second.read(ref); assert.deepEqual(value.data, new Uint8Array(original));
  const changed = {...ref, width: ref.width + 1}; await assert.rejects(second.read(changed), error => error.code === 'ATTACHMENT_CORRUPT');
});

test('wrong key, substituted ciphertext and unsafe object aliases refuse without legacy fallback', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready(); f.install(service, store);
  const ref = await service.saveImage(await input()), before = await readFile(store.cipherPath(ref));
  const keyPath = join(f.root, 'wrong-key'); await writeFile(keyPath, randomBytes(32).toString('hex'), {mode: 0o400});
  await assert.rejects(f.store({keyPath}).ready(), /root_authentication_failed/); assert.deepEqual(await readFile(store.cipherPath(ref)), before);
  const envelope = JSON.parse(before); envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  await writeFile(store.cipherPath(ref), JSON.stringify(envelope), {mode: 0o600});
  // An existing volatile copy must not conceal authenticated-object tampering.
  await assert.rejects(store.read(ref), error => error.code === 'ATTACHMENT_CORRUPT');
  const cold = join(f.root, 'tamper-materialization'); await mkdir(cold, {mode: 0o700});
  const reader = f.store({materialization: cold}); await reader.ready(); await assert.rejects(reader.read(ref), error => error.code === 'ATTACHMENT_CORRUPT');
  await writeFile(store.cipherPath(ref), before);
  const outside = join(f.root, 'unrelated'); await writeFile(outside, 'synthetic sentinel'); await rm(store.cipherPath(ref)); await symlink(outside, store.cipherPath(ref));
  assert.throws(() => store.has(ref), error => error.code === 'ATTACHMENT_CORRUPT'); assert.equal(await readFile(outside, 'utf8'), 'synthetic sentinel');
});

test('cross-root objects cannot be transplanted even with the same vault key', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), a = f.store(); await a.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await a.savePrepared(prepared);
  const root = join(f.root, 'second-encrypted'), b = f.store({root}); await b.ready();
  const path = b.cipherPath(prepared.ref); await mkdir(join(root, 'objects', prepared.ref.attachmentId.slice(7, 9)), {recursive: true, mode: 0o700});
  await writeFile(path, await readFile(a.cipherPath(prepared.ref)), {mode: 0o600});
  const cold = join(f.root, 'second-cold'); await mkdir(cold, {mode: 0o700});
  const reader = f.store({root, materialization: cold}); await reader.ready(); await assert.rejects(reader.read(prepared.ref), error => error.code === 'ATTACHMENT_CORRUPT');
});

test('abort before a cold image read preserves the original reason without materializing', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await store.savePrepared(prepared);
  const cold = join(f.root, 'cancelled-pool'); await mkdir(cold, {mode: 0o700}); const reader = f.store({materialization: cold}); await reader.ready();
  const signal = new AbortController(), reason = Error('synthetic cancelled'); signal.abort(reason);
  assert.throws(() => reader.read(prepared.ref, signal.signal), error => error === reason);
  await assert.rejects(lstat(reader.materialPath(prepared.ref)), {code: 'ENOENT'});
});

test('middleware hydrates all image roles including offloaded blocks before any adapter projection', async () => {
  const a = {attachmentId: 'a'}, b = {attachmentId: 'b'}, calls = [];
  const messages = [{role: 'user', content: [{type: 'image', attachment: a, offloaded: true}]}, {role: 'tool', content: [{type: 'image', attachment: b}, {type: 'text', text: 'opaque attachmentId content'}]}];
  assert.deepEqual(imageReferences(messages), [a, b]);
  const middleware = imageHydrationMiddleware({async hydrateReferences(refs, signal) { calls.push('hydrate'); assert.deepEqual(refs, [a, b]); assert.equal(signal, undefined); }});
  const stream = middleware({messages}, () => (async function* () { calls.push('adapter'); yield 'complete'; })());
  assert.deepEqual(calls, []); const values = []; for await (const value of stream) values.push(value);
  assert.deepEqual(values, ['complete']); assert.deepEqual(calls, ['hydrate', 'adapter']);
});

test('same-hash inconsistent metadata is rejected before deduplication can hide it', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await store.savePrepared(prepared);
  await assert.rejects(store.hydrateReferences([prepared.ref, {...prepared.ref, bytes: prepared.ref.bytes + 1}]), error => error.code === 'ATTACHMENT_CORRUPT');
});

test('current volatile bytes cannot bypass canonical integrity validation before an adapter starts', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready(); f.install(service, store);
  const ref = await service.saveImage(await input()), path = service.imageHostPath(ref), before = await readFile(path);
  const bytes = Buffer.from(before); bytes[bytes.length - 1] ^= 1;
  await chmod(path, 0o600); await writeFile(path, bytes); await chmod(path, 0o400);
  let adapterCalled = false;
  const middleware = imageHydrationMiddleware(store), stream = middleware({messages: [{role: 'user', content: [{type: 'image', attachment: ref, offloaded: true}]}]}, () => (async function* () { adapterCalled = true; })());
  await assert.rejects(async () => { for await (const _ of stream) {} }, error => error.code === 'ATTACHMENT_CORRUPT');
  assert.equal(adapterCalled, false); assert.deepEqual(await readFile(path), bytes);
});

test('the finite pool refuses oversized materialization without durable plaintext or eviction', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store({mountCapacity: 1}); await store.ready(); f.install(service, store);
  const sentinel = join(f.config.materialization, 'existing-tool-file'); await writeFile(sentinel, 'keep', {mode: 0o400});
  await assert.rejects(service.saveImage(await input()), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
  assert.equal(await readFile(sentinel, 'utf8'), 'keep');
  assert.deepEqual(await readdir(f.config.root), ['.uptokey-encrypted-images-v1']);
  assert.deepEqual(await readdir(f.config.materialization), ['existing-tool-file']);
});

test('dispose drains an already accepted save and restores only descriptors it owns', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const limiter = service.compression, run = limiter.run.bind(limiter);
  let release, started; const gate = new Promise(resolve => { release = resolve; }), entered = new Promise(resolve => { started = resolve; });
  limiter.run = action => { started(); return gate.then(() => run(action)); };
  const adapter = f.install(service, store), descriptor = Object.getOwnPropertyDescriptor(service, 'saveImage');
  const replacement = () => 'another-owner';
  Object.defineProperty(service, 'imageHostPath', {value: replacement, configurable: true, writable: true});
  const saving = service.saveImage(await input()); await entered;
  let done = false; const disposing = adapter.dispose().then(() => { done = true; });
  await Promise.resolve(); await Promise.resolve(); assert.equal(done, false);
  assert.equal(Object.getOwnPropertyDescriptor(service, 'saveImage').value, descriptor.value);
  await assert.rejects(service.saveImage(await input()), /encrypted_images_closed/);
  release(); const ref = await saving; await disposing;
  assert.equal((await lstat(store.materialPath(ref))).isFile(), true);
  assert.equal(Object.hasOwn(service, 'saveImage'), false); assert.equal(Object.hasOwn(service, 'readImage'), false);
  assert.equal(Object.getOwnPropertyDescriptor(service, 'imageHostPath').value, replacement);
});

test('cold direct filesystem resolution materializes an authenticated historical path without image blocks or a model stream', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), first = f.store(); await first.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await first.savePrepared(prepared);
  const cold = join(f.root, 'direct-pool'); await mkdir(cold, {mode: 0o700});
  const store = f.store({materialization: cold}); await store.ready(); const path = store.materialPath(prepared.ref);
  await assert.rejects(lstat(path), {code: 'ENOENT'});
  const options = {signal: new AbortController().signal}, target = {}, calls = [];
  const filesystem = {processPath() { return path; }, async resolve(...args) { calls.push({receiver: this, args}); assert.deepEqual(await readFile(path), prepared.data); return target; }};
  const descriptor = Object.getOwnPropertyDescriptor(filesystem, 'resolve'), adapter = f.installPath(filesystem, store);
  assert.equal(await filesystem.resolve(path, options), target); assert.equal(calls.length, 1);
  assert.equal(calls[0].receiver, filesystem); assert.equal(calls[0].args[0], path); assert.ok(calls[0].args[1].signal instanceof AbortSignal); assert.equal(calls[0].args[1].signal.aborted, options.signal.aborted);
  assert.equal((await lstat(path)).mode & 0o777, 0o400);
  await adapter.dispose(); assert.deepEqual(Object.getOwnPropertyDescriptor(filesystem, 'resolve'), descriptor);
});

test('invalid pool names refuse without image IO while legacy paths retain original resolution', linux, async t => {
  const f = await fixture(t), store = f.store(), calls = [];
  const filesystem = {processPath(target) { return target; }, async resolve(path, options) { calls.push([path, options]); return path; }}; f.installPath(filesystem, store);
  const digest = 'ab' + '1'.repeat(62), base = f.config.materialization;
  for (const path of [base + '/objects/ab/../ab/' + digest, base + '//objects/ab/' + digest,
    base + '/objects/cd/' + digest, base + '/objects/ab/' + digest + '.json']) await assert.rejects(filesystem.resolve(path), error => error.code === 'FS_IO_ERROR');
  const legacy = '/legacy/objects/ab/' + digest; assert.equal(await filesystem.resolve(legacy), legacy);
  assert.equal(calls.length, 1); assert.equal(store.initialization, undefined);
  await assert.rejects(lstat(f.config.root), {code: 'ENOENT'});
});

test('only absent ciphertext and absent materialization retain the original filesystem not-found outcome', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const ref = {attachmentId: 'sha256:' + 'ab'.repeat(32)}, path = store.materialPath(ref), original = new FsError('synthetic missing', 'FS_NOT_FOUND');
  let calls = 0; const filesystem = {processPath() { return path; }, async resolve() { calls++; throw original; }}; f.installPath(filesystem, store);
  await assert.rejects(filesystem.resolve(path), error => error === original); assert.equal(calls, 1);
  await assert.rejects(lstat(path), {code: 'ENOENT'});
});

test('corrupt cipher, tampered warm bytes and missing cipher with surviving bytes never reach SSH', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await store.savePrepared(prepared);
  const path = store.materialPath(prepared.ref), cipher = store.cipherPath(prepared.ref), before = await readFile(cipher);
  let calls = 0; const filesystem = {processPath() { return path; }, async resolve() { calls++; return {}; }}; f.installPath(filesystem, store);
  const envelope = JSON.parse(before); envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  await writeFile(cipher, JSON.stringify(envelope));
  const refused = error => error instanceof FsError && error.code === 'FS_IO_ERROR' && !error.message.includes(f.root);
  await assert.rejects(filesystem.resolve(path), refused); assert.equal(calls, 0); await writeFile(cipher, before);
  const changed = Buffer.from(prepared.data); changed[changed.length - 1] ^= 1;
  await chmod(path, 0o600); await writeFile(path, changed); await chmod(path, 0o400);
  await assert.rejects(filesystem.resolve(path), refused); assert.equal(calls, 0);
  await chmod(path, 0o600); await writeFile(path, prepared.data); await chmod(path, 0o400); await rm(cipher);
  await assert.rejects(filesystem.resolve(path), refused); assert.equal(calls, 0); assert.deepEqual(await readFile(path), prepared.data);
});

test('an object disappearing after authenticated-owner discovery is an error rather than a filesystem downgrade', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await store.savePrepared(prepared);
  const cipher = store.cipherPath(prepared.ref), path = store.materialPath(prepared.ref);
  let calls = 0;
  const hydrate = store.hydrateShared.bind(store); store.hydrateShared = async (...args) => { await rm(cipher); return hydrate(...args); };
  const filesystem = {processPath() { return path; }, async resolve() { calls++; return {}; }}; f.installPath(filesystem, store);
  await assert.rejects(filesystem.resolve(store.materialPath(prepared.ref)), error => error.code === 'FS_IO_ERROR'); assert.equal(calls, 0);
});

test('cancelled direct resolution preserves cancellation cause and does not start SSH or materialization', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const ref = {attachmentId: 'sha256:' + 'ab'.repeat(32)}, path = store.materialPath(ref), controller = new AbortController(), reason = Error('synthetic cancellation');
  controller.abort(reason); let calls = 0; const filesystem = {processPath() { return path; }, async resolve() { calls++; return {}; }}; f.installPath(filesystem, store);
  await assert.rejects(filesystem.resolve(path, {signal: controller.signal}), error => error instanceof FsError && error.code === 'FS_ABORTED' && error.cause === reason);
  assert.equal(calls, 0); await assert.rejects(lstat(path), {code: 'ENOENT'});
});

test('filesystem wrapper cancels and drains accepted work, preserves Cordis caller tracing and restores only owned descriptors', async t => {
  const ctx = new Context(), gate = Promise.withResolvers(), entered = Promise.withResolvers(); let seen, gated = false;
  class Filesystem extends Service {
    constructor(scope) { super(scope, 'fs'); }
    async resolve(path, options) { seen = {fiber: this.ctx.fiber, path, options}; return 'original'; }
    processPath() { return '/workspace/sample'; }
  }
  const provider = ctx.plugin(Filesystem); await provider.await(); const filesystem = ctx.get('fs');
  const adapter = installImagePathHydration(filesystem, {async ensureMaterializedPath() { if (gated) { entered.resolve(); await gate.promise; } }});
  t.after(async () => { gate.resolve(); await adapter.dispose(); await ctx.fiber.dispose(); });
  const options = {cwd: '/workspace'}; assert.equal(await filesystem.resolve('/workspace/sample', options), 'original');
  assert.equal(seen.fiber, ctx.fiber); assert.equal(seen.path, '/workspace/sample'); assert.equal(seen.options.cwd, options.cwd);
  assert.ok(seen.options.signal instanceof AbortSignal); assert.equal(options.signal, undefined);
  gated = true; const work = filesystem.resolve('/workspace/pending', options), refused = assert.rejects(work, error => error.code === 'FS_ABORTED'); await entered.promise;
  let disposed = false; const closing = adapter.dispose().then(() => { disposed = true; });
  await Promise.resolve(); assert.equal(disposed, false);
  await assert.rejects(filesystem.resolve('/workspace/late'), error => error.code === 'FS_IO_ERROR');
  gate.resolve(); await refused; await closing;
  assert.equal(seen.path, '/workspace/sample');
  assert.equal(Object.hasOwn(filesystem, 'resolve'), false);
  const second = installImagePathHydration(filesystem, {async ensureMaterializedPath() {}}), replacement = () => 'another owner';
  Object.defineProperty(filesystem, 'resolve', {value: replacement, configurable: true, writable: true});
  await second.dispose(); assert.equal(Object.getOwnPropertyDescriptor(filesystem, 'resolve').value, replacement);
});

test('a relative or symlink alias resolving into a warm pool authenticates before returning its target', linux, async t => {
  const f = await fixture(t), {service} = await f.boot(), store = f.store(); await store.ready();
  const prepared = await prepareImageFile(await input(), service.imageLimits, service.normalizationPolicy); await store.savePrepared(prepared);
  const path = store.materialPath(prepared.ref), alias = join(f.root, 'old-image-alias'); await symlink(path, alias);
  let resolutions = 0;
  const filesystem = {
    processPath(target) { return String(target.targetKey); },
    async resolve(path, options) { resolutions++; const canonical = await realpath(resolve(options?.cwd ?? f.root, path)); return {targetKey: canonical, displayPath: canonical}; },
  }; f.installPath(filesystem, store);
  assert.equal((await filesystem.resolve('old-image-alias', {cwd: f.root})).targetKey, path);
  const tampered = Buffer.from(prepared.data); tampered[tampered.length - 1] ^= 1;
  await chmod(path, 0o600); await writeFile(path, tampered); await chmod(path, 0o400);
  await assert.rejects(filesystem.resolve(alias), error => error.code === 'FS_IO_ERROR');
  await chmod(path, 0o600); await writeFile(path, prepared.data); await chmod(path, 0o400); await rm(store.cipherPath(prepared.ref));
  await assert.rejects(filesystem.resolve(alias), error => error.code === 'FS_IO_ERROR');
  assert.equal(resolutions, 3); assert.deepEqual(await readFile(path), prepared.data);
});
