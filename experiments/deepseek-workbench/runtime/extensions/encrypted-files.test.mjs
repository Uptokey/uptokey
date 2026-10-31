import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash, randomBytes} from 'node:crypto';
import {chmod, lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join, resolve, sep} from 'node:path';
import {Context} from '@deepseek-ai/cordis';
import LocalAttachmentStore from '@deepseek-ai/dsh-attachment-local';
import {CACHE_CAPACITY} from './request-image-cache.mjs';
import {EncryptedFileStore, installEncryptedFiles, installFilePathHydration, fileHydrationMiddleware, fileReferences, disposeEncryptedFiles} from './encrypted-files.mjs';
import {MaterializationOwnership} from './materialization-ownership.mjs';

const linux = {skip: process.platform !== 'linux'};
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-encrypted-files-'));
  const config = {root: join(root, 'encrypted'), materialization: join(root, 'materialized'), keyPath: join(root, 'key')};
  await mkdir(config.materialization, {mode: 0o700}); await chmod(config.materialization, 0o700);
  await writeFile(config.keyPath, randomBytes(32).toString('hex'), {mode: 0o400});
  const contexts = [], stores = [], adapters = [];
  t.after(async () => {
    for (const adapter of adapters) await adapter.dispose();
    for (const store of stores) await store.close();
    for (const context of contexts) await context.fiber.dispose();
    assert.ok(resolve(root).startsWith(resolve(tmpdir()) + sep + 'uptokey-encrypted-files-')); await rm(root, {recursive: true, force: true});
  });
  const store = (extra = {}) => {
    const {mountCapacity = CACHE_CAPACITY, ...overrides} = extra, options = {...config, ...overrides};
    const mountSnapshot = {stats: {type: 0x01021994n, bsize: 1n, blocks: BigInt(mountCapacity)},
      mountInfo: `1 0 0:99 / ${options.materialization} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,noswap\n`};
    const value = new EncryptedFileStore({...options, mountSnapshot}); stores.push(value); return value;
  };
  const boot = async () => {
    const context = new Context(); contexts.push(context);
    const fiber = context.plugin(LocalAttachmentStore, {dshHome: join(root, 'legacy-home')}); await fiber.await();
    return context.get('attachments');
  };
  const install = (service, value) => { const adapter = installEncryptedFiles(service, value); adapters.push(adapter); return adapter; };
  return {root, config, store, boot, install, adapters};
}
async function collect(iterable) { const chunks = []; for await (const bytes of iterable) chunks.push(Buffer.from(bytes)); return Buffer.concat(chunks); }
async function allFiles(path) {
  const files = [];
  for (const entry of await readdir(path, {withFileTypes: true})) { const next = join(path, entry.name); if (entry.isDirectory()) files.push(...await allFiles(next)); else files.push(next); }
  return files;
}
async function flipLast(path) { const bytes = await readFile(path); bytes[bytes.length - 1] ^= 1; await writeFile(path, bytes); }

function holdDecode(store) {
  const original=store.decode.bind(store);let release,entered,count=0;
  const started=new Promise(done=>{entered=done;}),gate=new Promise(done=>{release=done;});
  store.decode=async function*(path,facts,signal,summary){
    count++;entered();
    await new Promise((done,reject)=>{const cancel=()=>reject(signal.reason);signal.addEventListener('abort',cancel,{once:true});gate.then(()=>{signal.removeEventListener('abort',cancel);done();});if(signal.aborted)cancel();});
    yield* original(path,facts,signal,summary);
  };
  return {started,release:()=>release(),count:()=>count};
}

test('materialization and attachment readers retain global ownership for their complete real lifetime', linux, async t => {
  const f = await fixture(t), ownership = new MaterializationOwnership(), store = f.store({ownership}); await store.ready();
  const entered = Promise.withResolvers(), release = Promise.withResolvers();
  const saving = store.saveFileStream({name: 'owned.txt', data: (async function* () {
    yield Buffer.from('owned '); entered.resolve(); await release.promise; yield Buffer.from('bytes');
  })()});
  await entered.promise; assert.equal(ownership.snapshot().kinds.materialization, 1);
  let exclusiveEntered = false;
  const exclusive = ownership.runExclusive(async () => { exclusiveEntered = true; });
  await new Promise(done => setImmediate(done)); assert.equal(exclusiveEntered, false);
  release.resolve(); const ref = await saving; await exclusive;
  assert.equal(ownership.snapshot().active, 0);

  const reader = store.readFileStream(ref); assert.equal((await reader.next()).done, false);
  assert.equal(ownership.snapshot().kinds['attachment-reader'], 1);
  const second = ownership.runExclusive(async () => {});
  await new Promise(done => setImmediate(done)); assert.equal(ownership.snapshot().accepting, false);
  await reader.return(); await second; assert.equal(ownership.snapshot().active, 0);
});

test('shared preparation decrypts once while one reader cancels, and revalidates later reads',linux,async t=>{
  const f=await fixture(t),store=f.store();await store.ready();
  const bytes=Buffer.from('shared materialization, exact authenticated bytes'),ref=await store.saveFile({name:'shared.txt',data:bytes});
  const gate=holdDecode(store),cancel=new AbortController();
  const first=store.hydrate(ref,cancel.signal),rejected=assert.rejects(first,{name:'AbortError'}),second=store.hydrate(ref);
  await gate.started;assert.equal(gate.count(),1);cancel.abort();await rejected;gate.release();
  assert.equal(await second,store.materialPath(ref));assert.deepEqual(await readFile(store.materialPath(ref)),bytes);assert.equal(gate.count(),1);
  await store.hydrate(ref);assert.equal(gate.count(),2);assert.equal(store.preparations.size,0);
});

test('shared preparation cancels with its last reader, cleans temporary files and permits retry',linux,async t=>{
  const f=await fixture(t),store=f.store();await store.ready();const ref=await store.saveFile({name:'cancel.txt',data:Buffer.from('cancel together')});
  const gate=holdDecode(store),a=new AbortController(),b=new AbortController();
  const first=assert.rejects(store.hydrate(ref,a.signal),{name:'AbortError'}),second=assert.rejects(store.hydrate(ref,b.signal),{name:'AbortError'});
  await gate.started;a.abort();b.abort();await Promise.all([first,second]);await Promise.allSettled([...store.preparations.values()].map(e=>e.work));
  assert.equal(store.preparations.size,0);assert.deepEqual(await allFiles(f.config.materialization),[]);
  gate.release();await store.hydrate(ref);assert.equal(gate.count(),2);assert.equal((await readFile(store.materialPath(ref))).toString(),'cancel together');
});

test('shared preparation isolates incompatible reference lengths and freezes caller facts',linux,async t=>{
  const f=await fixture(t),store=f.store();await store.ready();const ref=await store.saveFile({name:'facts.txt',data:Buffer.from('exact reference')});
  const gate=holdDecode(store),mutable={...ref};
  const valid=store.hydrate(mutable),invalid=assert.rejects(store.hydrate({...ref,bytes:ref.bytes+1}),{code:'ATTACHMENT_CORRUPT'});
  mutable.name='mutated.txt';mutable.bytes++;
  await gate.started;gate.release();await valid;await invalid;
  assert.equal(gate.count(),2);assert.equal((await readFile(store.materialPath(ref))).toString(),'exact reference');
  await assert.rejects(lstat(store.materialPath(mutable)),{code:'ENOENT'});
});

test('shared preparation owner close cancels every waiter and drains its temporary work',linux,async t=>{
  const f=await fixture(t),store=f.store();await store.ready();const ref=await store.saveFile({name:'close.txt',data:Buffer.from('owner lifecycle')});
  const gate=holdDecode(store);const first=assert.rejects(store.hydrate(ref)),second=assert.rejects(store.hydrate(ref));
  await gate.started;await store.close();await Promise.all([first,second]);
  assert.equal(gate.count(),1);assert.equal(store.preparations.size,0);assert.equal(store.operations.size,0);assert.deepEqual(await allFiles(f.config.materialization),[]);
});

test('generic files keep exact bytes, empty input, canonical names and cipher-only durable storage', linux, async t => {
  const f = await fixture(t), service = await f.boot(), store = f.store(); await store.ready(); f.install(service, store);
  const empty = await service.saveFileStream({name: 'empty.txt', data: (async function* () {})()});
  assert.equal(empty.bytes, 0); assert.equal(empty.attachmentId, 'sha256:' + digest(Buffer.alloc(0)));
  assert.deepEqual(await collect(service.readFileStream(empty)), Buffer.alloc(0));
  const bytes = Buffer.concat([Buffer.from('private-generic-canary\0'), randomBytes(210000)]);
  const first = await service.saveFile({name: 'C:\\private\\sample?.bin', data: bytes});
  const second = await service.saveFileStream({name: '/private/renamed.bin', data: (async function* () { yield bytes.subarray(0, 17); yield Buffer.alloc(0); yield bytes.subarray(17); })()});
  assert.equal(first.name, 'sample_.bin'); assert.equal(second.name, 'renamed.bin');
  assert.equal(first.attachmentId, second.attachmentId); assert.equal(first.bytes, bytes.length);
  assert.deepEqual(await collect(service.readFileStream(first)), bytes);
  assert.deepEqual(await collect(service.readFileStream(second)), bytes);
  assert.notEqual(store.cipherPath(first), store.cipherPath(second));
  assert.equal(service.fileHostPath(first), join(f.config.materialization, 'files', digest(bytes).slice(0, 2), digest(bytes), first.name));
  assert.deepEqual(await readdir(f.config.materialization), []);
  await assert.rejects(lstat(join(service.root, 'files')), {code: 'ENOENT'});
  for (const path of await allFiles(f.config.root)) {
    const data = await readFile(path); assert.equal(data.includes(Buffer.from('private-generic-canary')), false); assert.equal(data.includes(Buffer.from('sample_.bin')), false);
    assert.equal((await lstat(path)).mode & 0o777, 0o600);
  }
  await store.hydrate(empty); assert.deepEqual(await readFile(store.materialPath(empty)), Buffer.alloc(0));
});

test('stream above 64 MiB saves and reads with a tiny materialization budget; only POSIX hydration fails', linux, async t => {
  const f = await fixture(t), store = f.store({mountCapacity: 1024}); await store.ready();
  const block = Buffer.alloc(65536, 0xa7), blocks = 1041;
  const expected = createHash('sha256'); for (let i = 0; i < blocks; i++) expected.update(block);
  const ref = await store.saveFileStream({name: 'large.dat', data: (async function* () { for (let i = 0; i < blocks; i++) yield block; })()});
  assert.equal(ref.bytes, blocks * block.length); assert.ok(ref.bytes > 64 * 1024 * 1024); assert.equal(ref.attachmentId, 'sha256:' + expected.digest('hex'));
  const actual = createHash('sha256'); let bytes = 0, largest = 0;
  for await (const chunk of store.readFileStream(ref)) { bytes += chunk.length; largest = Math.max(largest, chunk.length); actual.update(chunk); }
  assert.equal(bytes, ref.bytes); assert.equal('sha256:' + actual.digest('hex'), ref.attachmentId); assert.ok(largest <= 65536);
  assert.deepEqual(await readdir(f.config.materialization), []);
  await assert.rejects(store.hydrate(ref), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
  assert.equal(store.has(ref), true); assert.deepEqual(await readdir(f.config.materialization), []);
});

test('legacy fallback is absent-only, and cold POSIX copies preserve filename and authenticated bytes', linux, async t => {
  const f = await fixture(t), service = await f.boot(), data = Buffer.from('legacy content');
  const legacy = await service.saveFile({name: 'old.txt', data}), legacyPath = service.fileHostPath(legacy);
  let fallbackReads = 0; const originalRead = service.readFileStream;
  service.readFileStream = function (...args) { fallbackReads++; return originalRead.apply(this, args); };
  const store = f.store(); await store.ready(); const adapter = f.install(service, store);
  assert.equal(service.fileHostPath(legacy), legacyPath); assert.deepEqual(await collect(service.readFileStream(legacy)), data); assert.equal(fallbackReads, 1);
  const ref = await service.saveFile({name: 'new.bin', data: Buffer.from('new durable cipher')});
  await store.hydrate(ref); const material = await readFile(store.materialPath(ref));
  assert.equal((await lstat(store.materialPath(ref))).mode & 0o777, 0o400);
  await adapter.dispose();
  const cold = join(f.root, 'cold'); await mkdir(cold, {mode: 0o700});
  const reader = f.store({materialization: cold}); await reader.ready(); f.install(service, reader);
  await assert.rejects(lstat(reader.materialPath(ref)), {code: 'ENOENT'});
  assert.equal(await reader.ensureMaterializedPath(reader.materialPath(ref)), true); assert.deepEqual(await readFile(reader.materialPath(ref)), material);
  await flipLast(reader.cipherPath(ref));
  await assert.rejects(collect(service.readFileStream(ref)), error => error.code === 'ATTACHMENT_CORRUPT');
  await assert.rejects(reader.hydrate(ref), error => error.code === 'ATTACHMENT_CORRUPT');
  assert.equal(fallbackReads, 1); assert.deepEqual(await readFile(legacyPath), data);
});

test('root, name, byte count and FINAL binding reject substituted or truncated cipher objects', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const data = Buffer.from('binding synthetic data'), a = await store.saveFile({name: 'a.txt', data}), b = await store.saveFile({name: 'b.txt', data});
  await assert.rejects(collect(store.readFileStream({...a, bytes: a.bytes + 1})), error => error.code === 'ATTACHMENT_CORRUPT');
  const cipher = await readFile(store.cipherPath(a));
  await writeFile(store.cipherPath(b), cipher);
  await assert.rejects(collect(store.readFileStream(b)), error => error.code === 'ATTACHMENT_CORRUPT');
  const other = f.store({root: join(f.root, 'another-root')}); await other.ready(); const c = await other.saveFile({name: a.name, data});
  await writeFile(other.cipherPath(c), cipher);
  await assert.rejects(collect(other.readFileStream(c)), error => error.code === 'ATTACHMENT_CORRUPT');
  await writeFile(store.cipherPath(a), cipher.subarray(0, cipher.length - 20));
  await assert.rejects(collect(store.readFileStream(a)), error => error.code === 'ATTACHMENT_CORRUPT');
  await assert.rejects(store.hydrate(a), error => error.code === 'ATTACHMENT_CORRUPT');
  await assert.rejects(lstat(store.materialPath(a)), {code: 'ENOENT'});
});

test('cancelled writes remove pending ciphertext; disposal closes paused readers and refuses new work', linux, async t => {
  const f = await fixture(t), service = await f.boot(), store = f.store(); await store.ready(); const adapter = f.install(service, store);
  const controller = new AbortController();
  await assert.rejects(service.saveFileStream({name: 'cancel.dat', signal: controller.signal, data: (async function* () {
    yield Buffer.alloc(65536, 1); controller.abort(new DOMException('synthetic cancellation', 'AbortError')); yield Buffer.alloc(1);
  })()}), error => error.name === 'AbortError');
  assert.deepEqual(await readdir(f.config.root), ['.uptokey-encrypted-files-v1']);
  const ref = await service.saveFile({name: 'reader.dat', data: Buffer.alloc(150000, 2)});
  const stream = service.readFileStream(ref); assert.equal((await stream.next()).done, false);
  await adapter.dispose(); assert.equal((await stream.next()).done, true);
  assert.equal(Object.hasOwn(service, 'saveFile'), false); assert.equal(Object.hasOwn(service, 'fileHostPath'), false);
  await assert.rejects(store.saveFile({data: Buffer.alloc(1)}), /encrypted_files_closed/);
  assert.equal((await allFiles(f.config.root)).some(path => path.includes('.pending-')), false);
});

test('concurrent identical publication is immutable and hydration never evicts an existing path', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const data = Buffer.alloc(70000, 7), input = {data, name: 'same.dat'};
  const [a, b] = await Promise.all([store.saveFile(input), store.saveFile(input)]); assert.deepEqual(a, b);
  await store.hydrate(a); const before = await lstat(store.materialPath(a));
  const second = await store.saveFile({name: 'second.dat', data: Buffer.from('another object')}); await store.hydrate(second);
  await store.hydrate(a); const after = await lstat(store.materialPath(a));
  assert.equal(after.ino, before.ino); assert.deepEqual(await readFile(store.materialPath(a)), data);
  assert.equal((await allFiles(f.config.root)).filter(path => path.endsWith('.ssf')).length, 2);
  assert.equal((await allFiles(f.config.root)).some(path => path.includes('.pending-')), false);
});

test('request middleware and filesystem reads hydrate only actual generic references and reject malformed owned paths', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const chosen = await store.saveFile({name: 'chosen.txt', data: Buffer.from('chosen')}), other = await store.saveFile({name: 'other.txt', data: Buffer.from('other')});
  const messages = [{role: 'user', content: [{type: 'text', text: 'synthetic'}, {type: 'file', attachment: chosen}, {type: 'image', attachment: other}]}];
  assert.deepEqual(fileReferences(messages), [chosen]); let dispatched = false;
  for await (const ignored of fileHydrationMiddleware(store)({messages}, async function* () { dispatched = true; yield 'ok'; })) void ignored;
  assert.equal(dispatched, true); assert.equal((await readFile(store.materialPath(chosen))).toString(), 'chosen');
  await assert.rejects(lstat(store.materialPath(other)), {code: 'ENOENT'});
  const original = async path => ({path}), filesystem = {resolve: original, processPath: target => target.path};
  const adapter = installFilePathHydration(filesystem, store); f.adapters.push(adapter);
  const target = await filesystem.resolve(store.materialPath(other)); assert.equal((await readFile(target.path)).toString(), 'other');
  assert.equal(await store.ensureMaterializedPath('/workspace/unrelated.txt'), false);
  await assert.rejects(store.ensureMaterializedPath(join(f.config.materialization, 'files', 'aa', 'b'.repeat(64), 'x.txt')), error => error.code === 'ATTACHMENT_CORRUPT');
  await adapter.dispose(); assert.equal(filesystem.resolve, original);
});

test('wrong key and unsafe cipher links fail closed without touching originals', linux, async t => {
  const f = await fixture(t), store = f.store(); await store.ready();
  const ref = await store.saveFile({name: 'link.txt', data: Buffer.from('linked data')}), cipher = await readFile(store.cipherPath(ref));
  const wrongKey = join(f.root, 'wrong-key'); await writeFile(wrongKey, randomBytes(32).toString('hex'), {mode: 0o400});
  await assert.rejects(f.store({keyPath: wrongKey}).ready(), /root_authentication_failed/);
  const elsewhere = join(f.root, 'copy'); await writeFile(elsewhere, cipher, {mode: 0o600});
  await rm(store.cipherPath(ref)); await symlink(elsewhere, store.cipherPath(ref));
  assert.throws(() => store.has(ref), error => error.code === 'ATTACHMENT_CORRUPT');
  await assert.rejects(collect(store.readFileStream(ref)), error => error.code === 'ATTACHMENT_CORRUPT');
  assert.deepEqual(await readFile(elsewhere), cipher);
});

test('plugin unload aborts owned hydration before draining a pending filesystem resolve', {...linux, timeout: 5000}, async t => {
  const f = await fixture(t), service = await f.boot(), store = f.store(); await store.ready();
  const adapter = f.install(service, store), ref = await service.saveFile({name: 'pending.txt', data: Buffer.from('pending synthetic reader')});
  const original = async path => ({path}), filesystem = {resolve: original, processPath: target => target.path};
  const pathAdapter = installFilePathHydration(filesystem, store); f.adapters.push(pathAdapter);
  let entered, cancelled = false; const reading = new Promise(resolve => { entered = resolve; });
  const chunks = store.fileChunks;
  store.fileChunks = async function* (path, mode, signal) {
    if (path === store.cipherPath(ref)) {
      entered();
      await new Promise((resolve, reject) => {
        const stop = () => { cancelled = true; reject(signal.reason); };
        if (signal.aborted) stop(); else signal.addEventListener('abort', stop, {once: true});
      });
    }
    yield* chunks.call(this, path, mode, signal);
  };
  const pending = filesystem.resolve(store.materialPath(ref));
  const refused = assert.rejects(pending, error => error.code === 'FS_ABORTED');
  await reading;
  await Promise.all([disposeEncryptedFiles(store, adapter, pathAdapter), refused]);
  assert.equal(cancelled, true); assert.equal(filesystem.resolve, original);
  assert.equal(store.operations.size, 0); assert.equal(store.readers.size, 0);
  assert.equal(Object.hasOwn(service, 'saveFile'), false);
  await assert.rejects(lstat(store.materialPath(ref)), {code: 'ENOENT'});
  assert.equal((await allFiles(f.config.materialization)).some(path => path.includes('.pending-')), false);
});

test('unknown-size POSIX capacity failure wipes decrypted chunks and leaves caller bytes and cipher intact', linux, async t => {
  const f = await fixture(t), store = f.store({mountCapacity: 1024}); await store.ready();
  const input = Buffer.alloc(65536, 0x6e), ref = await store.saveFile({name: 'capacity.dat', data: input});
  const decoded = [], original = store.decode;
  store.decode = async function* (...args) { for await (const chunk of original.apply(this, args)) { decoded.push(chunk); yield chunk; } };
  // A cold filesystem path carries name/digest, but not a trusted byte count.
  await assert.rejects(store.ensureMaterializedPath(store.materialPath(ref)), error => error.code === 'ATTACHMENT_WRITE_FAILED' && error.cause?.code === 'ENOSPC');
  assert.ok(decoded.length > 0); assert.ok(decoded.every(chunk => chunk.every(value => value === 0)));
  assert.ok(input.every(value => value === 0x6e));
  assert.equal((await allFiles(f.config.materialization)).length, 0);
  store.decode = original; assert.deepEqual(await collect(store.readFileStream(ref)), input);
});
