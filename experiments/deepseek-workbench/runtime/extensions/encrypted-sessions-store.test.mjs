import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {chmod, link, lstat, mkdtemp, readFile, readdir, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {
  SessionAlreadyExistsError, SessionAlreadyOwnedError, SessionFormatUnsupportedError,
  SessionHandleClosedError, SessionPersistenceCorruptionError, SessionPersistenceNotFoundError,
  SessionReadOnlyError,
} from '@deepseek-ai/dsh-session-persistence';
import {SESSION_FORMAT_VERSION} from '@deepseek-ai/dsh-session';
import {EncryptedSessionStore, ENCRYPTED_SESSION_CHUNK_BYTES} from './encrypted-sessions-store.mjs';

const linux = {skip: process.platform !== 'linux'};
const MAGIC = Buffer.byteLength('UPTOKEY-ENCRYPTED-SESSIONS-1\n');
const header = (id, extra = {}) => ({version: SESSION_FORMAT_VERSION, id, createdAt: 1234567890, isSeeded: false, ...extra});
const event = (seq, text = `synthetic-${seq}`) => ({type: 'plugin:uptokey/encrypted-test', ignorable: true, seq, time: seq + 1, data: {text}});
const frames = bytes => {
  const result = [];
  for (let offset = MAGIC; offset < bytes.length;) {
    const length = bytes.readUInt32BE(offset + 1), end = offset + 5 + length;
    result.push({kind: bytes[offset], offset, end, bytes: bytes.subarray(offset, end)}); offset = end;
  }
  return result;
};

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'uptokey-encrypted-sessions-'));
  await chmod(directory, 0o700);
  const keyPath = join(directory, 'key');
  await writeFile(keyPath, randomBytes(32).toString('hex'), {mode: 0o400});
  const root = join(directory, 'encrypted');
  const stores = [];
  const store = (options = {}) => {
    const value = new EncryptedSessionStore({root, keyPath, ...options}); stores.push(value); return value;
  };
  t.after(async () => {
    for (const value of stores) try { await value.close(); } catch { /* tested close failures remain cleanup-safe */ }
    // Only the unique test-owned temp tree, never a configured/profile root.
    await rm(directory, {recursive: true, force: true});
  });
  return {directory, root, keyPath, store};
}

test('new backend encrypts header/body, preserves pending visibility, survives reopen and keeps caller-owned slices', linux, async t => {
  const f = await fixture(t), store = f.store();
  assert.equal(await store.stat('absent'), undefined);
  assert.deepEqual(await store.list(), []);
  const metadata = header('id-PRIVATE-SYNTHETIC', {cwd: '/workspace/PRIVATE-CWD', agentPreset: 'PRIVATE-PRESET'});
  const writer = await store.create(metadata);
  metadata.agentPreset = 'changed by caller';
  assert.equal((await store.stat(writer.id)).header.agentPreset, 'PRIVATE-PRESET');
  const reader = await store.open(writer.id, 'read');
  assert.deepEqual((await reader.read()).events, []);
  const batch = [event(0, 'PRIVATE-CONTENT'), event(1)];
  const accepted = writer.append(batch); batch[0].data.text = 'caller mutation'; await accepted;
  const first = await reader.read();
  assert.equal(first.eventState, 'shared-frozen');
  assert.equal(first.events[0].data.text, 'PRIVATE-CONTENT');
  assert.ok(Object.isFrozen(first.events[0].data));
  assert.throws(() => { first.events[0].data.text = 'mutation'; }, TypeError);
  first.events.pop();
  assert.equal((await reader.read()).events.length, 2);
  const bytes = await readFile(store.path(writer.id));
  for (const plain of ['PRIVATE-SYNTHETIC', 'PRIVATE-CWD', 'PRIVATE-PRESET', 'PRIVATE-CONTENT', 'plugin:uptokey']) assert.equal(bytes.includes(Buffer.from(plain)), false);
  assert.equal((await lstat(store.path(writer.id))).mode & 0o777, 0o600);
  const revision = (await store.stat(writer.id)).revision;
  await store.flush(); assert.equal((await store.stat(writer.id)).revision, revision);
  await writer.close(); await reader.close(); await store.close();
  const reopened = f.store(), result = await reopened.open('id-PRIVATE-SYNTHETIC', 'read');
  assert.equal((await result.read()).events.length, 2);
  assert.equal((await reopened.list()).length, 1);
});

test('empty sessions materialize on flush; unmaterialized close disappears; seeded cuts persist exactly', linux, async t => {
  const f = await fixture(t), store = f.store();
  const abandoned = await store.create(header('abandoned'));
  await abandoned.close();
  assert.equal(await store.stat('abandoned'), undefined);
  const empty = await store.create(header('empty'));
  await empty.flush(); await empty.close();
  assert.equal((await (await store.open('empty', 'read')).read()).events.length, 0);
  await assert.rejects(store.create(header('fork-missing', {isSeeded: true})), /inherited event count/);
  await assert.rejects(store.create(header('bad-cut'), {inheritedEventCount: 2}), /inherited event count/);
  const fork = await store.create(header('fork', {isSeeded: true, parentSession: 'parent'}), {inheritedEventCount: 3});
  assert.equal(fork.inheritedEventCount, 3);
  await fork.append([event(0), event(1), event(2), event(3)]); await fork.close();
  const reopened = await store.open('fork', 'write');
  assert.equal(reopened.inheritedEventCount, 3);
  await reopened.append([event(4)]);
  assert.equal((await reopened.read()).events.length, 5);
});

test('native single-writer ownership, duplicate no-overwrite create, readers and live queues remain intact', linux, async t => {
  const f = await fixture(t), store = f.store(), other = f.store();
  await Promise.all([store.ready(), other.ready()]);
  const writer = await store.create(header('owned'));
  await assert.rejects(store.create(header('owned')), SessionAlreadyExistsError);
  await assert.rejects(store.open('owned', 'write'), SessionAlreadyOwnedError);
  writer.enqueueLive(event(0), error => { throw error; });
  await store.flush();
  await assert.rejects(other.open('owned', 'write'), SessionAlreadyOwnedError);
  const reader = await other.open('owned', 'read');
  assert.equal((await reader.read()).events.length, 1);
  await assert.rejects(reader.append([event(1)]), SessionReadOnlyError);
  await assert.rejects(reader.flush(), SessionReadOnlyError);
  writer.enqueueLive(event(1), error => { throw error; });
  await writer.close();
  assert.equal((await reader.read()).events.length, 2);
  const next = await other.open('owned', 'write');
  await next.append([event(2)]); await next.close();
  assert.equal((await reader.read()).events.length, 3);
  await assert.rejects(store.create(header('owned')), SessionAlreadyExistsError);
});

test('cross-process canonical flock excludes a writer and releases on close', linux, async t => {
  const f = await fixture(t), store = f.store();
  const writer = await store.create(header('cross-process'));
  await writer.append([event(0)]);
  const script = `
    import {EncryptedSessionStore} from ${JSON.stringify(new URL('./encrypted-sessions-store.mjs', import.meta.url).href)};
    const store = new EncryptedSessionStore({root:process.argv[1],keyPath:process.argv[2]});
    try { const h=await store.open('cross-process','write'); await h.close(); process.stdout.write('opened'); }
    catch(error) { if(error.name!=='SessionAlreadyOwnedError') throw error; process.stdout.write('owned'); }
    finally { await store.close(); }
  `;
  const child = () => new Promise((resolve, reject) => {
    const processArgs = process.execArgv.filter(value => !value.startsWith('--test'));
    const child = spawn(process.execPath, [...processArgs, '--input-type=module', '-e', script, f.root, f.keyPath], {stdio: ['ignore', 'pipe', 'pipe']});
    let output = '', errors = '';
    child.stdout.on('data', chunk => { output += chunk; }); child.stderr.on('data', chunk => { errors += chunk; });
    child.once('error', reject); child.once('exit', code => code === 0 ? resolve(output) : reject(Error(`synthetic child failed (${code}): ${errors}`)));
  });
  assert.equal(await child(), 'owned');
  await writer.close();
  assert.equal(await child(), 'opened');
});

test('racing creators never overwrite and an invalid batch leaves the pending creator usable', linux, async t => {
  const f = await fixture(t), a = f.store(), b = f.store();
  const [wa, wb] = await Promise.all([a.create(header('race')), b.create(header('race'))]);
  const outcomes = await Promise.allSettled([wa.append([event(0, 'a')]), wb.append([event(0, 'b')])]);
  assert.equal(outcomes.filter(x => x.status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(x => x.status === 'rejected').length, 1);
  await wa.close(); await wb.close();
  const disk = await (await a.open('race', 'read')).read();
  assert.equal(disk.events.length, 1); assert.ok(['a', 'b'].includes(disk.events[0].data.text));
  const validAfterFailure = await a.create(header('validate-first'));
  await assert.rejects(validAfterFailure.append([{type: 'future/required', seq: 0, time: 1, data: {}}]), SessionFormatUnsupportedError);
  assert.equal(await b.stat('validate-first'), undefined);
  await validAfterFailure.append([event(0)]);
  assert.equal((await validAfterFailure.read()).events.length, 1);
  assert.equal((await readdir(a.directory('validate-first'))).some(name => name.startsWith('.pending-')), false);
});

test('segmented batches and single large events have no 1 MiB event/batch cap', linux, async t => {
  const f = await fixture(t), store = f.store();
  const writer = await store.create(header('segmented'));
  const text = 'synthetic-🙂'.repeat(Math.ceil(ENCRYPTED_SESSION_CHUNK_BYTES * 2.2 / 14));
  await writer.append([event(0, text), event(1, 'tail')]);
  const bytes = await readFile(store.path(writer.id));
  assert.ok(frames(bytes).filter(frame => frame.kind === 2).length >= 3);
  await writer.close();
  const reader = await store.open('segmented', 'read');
  assert.equal((await reader.read()).events[0].data.text, text);
  assert.equal((await reader.read(1, 1)).events[0].data.text, 'tail');
});

test('complete uncommitted DATA and partial frames are hidden; only writer append repairs tail', linux, async t => {
  const f = await fixture(t), store = f.store();
  let writer = await store.create(header('tail'));
  await writer.append([event(0)]);
  const first = await readFile(store.path('tail'));
  await writer.append([event(1, 'uncommitted')]); await writer.close();
  const complete = await readFile(store.path('tail'));
  const commit = frames(complete).at(-1);
  const torn = complete.subarray(0, commit.offset);
  await writeFile(store.path('tail'), torn);
  const reader = await store.open('tail', 'read');
  assert.equal((await reader.read()).events.length, 1);
  assert.deepEqual(await readFile(store.path('tail')), torn);
  writer = await store.open('tail', 'write');
  await writer.append([event(1, 'repaired')]); await writer.close();
  assert.equal((await reader.read()).events[1].data.text, 'repaired');
  await reader.close();
  // A partial length prefix is an uncommitted physical tail as well.
  await store.close();
  await writeFile(store.path('tail'), Buffer.concat([first, Buffer.from([2, 0, 0])]));
  const fresh = f.store();
  const secondReader = await fresh.open('tail', 'read');
  assert.equal((await secondReader.read()).events.length, 1);
  const repair = await fresh.open('tail', 'write'); await repair.append([event(1)]); await repair.close();
  assert.equal((await secondReader.read()).events.length, 2);
});

test('completed corrupt frame refuses; warm cache cannot hide prefix corruption followed by growth', linux, async t => {
  const f = await fixture(t), store = f.store();
  const writer = await store.create(header('tamper'));
  await writer.append([event(0, 'first')]);
  const first = await readFile(store.path('tamper'));
  const observer = f.store(), reader = await observer.open('tamper', 'read');
  assert.equal((await reader.read()).events.length, 1); // warm external memo
  await writer.append([event(1, 'second')]); await writer.close();
  const bytes = await readFile(store.path('tamper'));
  assert.ok(bytes.length > first.length);
  const data = frames(bytes).find(frame => frame.kind === 2);
  const envelope = JSON.parse(bytes.subarray(data.offset + 5, data.end).toString('utf8'));
  envelope.ciphertext = (envelope.ciphertext[0] === 'A' ? 'B' : 'A') + envelope.ciphertext.slice(1);
  const encoded = Buffer.from(JSON.stringify(envelope));
  assert.equal(encoded.length, data.end - data.offset - 5); encoded.copy(bytes, data.offset + 5);
  await writeFile(store.path('tamper'), bytes);
  await assert.rejects(reader.read(), SessionPersistenceCorruptionError);
  await assert.rejects(observer.open('tamper', 'write'), SessionPersistenceCorruptionError);
  // Failed open releases the write claim and lease; restoring the exact valid
  // first generation permits a subsequent writer, without deleting lock files.
  await writeFile(store.path('tamper'), first);
  const restored = await observer.open('tamper', 'write'); await restored.append([event(1)]); await restored.close();
});

test('wrong key, cross-session AAD, unsafe paths and unsupported vocabulary refuse closed', linux, async t => {
  const f = await fixture(t), store = f.store();
  await assert.rejects(store.create(header('future', {version: SESSION_FORMAT_VERSION + 1})), SessionFormatUnsupportedError);
  for (const id of ['bind-a', 'bind-b']) {
    const writer = await store.create(header(id)); await writer.append([event(0)]); await writer.close();
  }
  const a = await readFile(store.path('bind-a')), b = await readFile(store.path('bind-b'));
  const aFrames = frames(a), bFrames = frames(b);
  const transplanted = Buffer.concat([b.subarray(0, bFrames[0].end), ...aFrames.slice(1).map(frame => frame.bytes)]);
  await writeFile(store.path('bind-b'), transplanted);
  await assert.rejects(store.open('bind-b', 'read'), SessionPersistenceCorruptionError);
  const wrongKey = join(f.directory, 'wrong-key');
  await writeFile(wrongKey, randomBytes(32).toString('hex'), {mode: 0o400});
  const wrong = f.store({keyPath: wrongKey});
  await assert.rejects(wrong.open('bind-a', 'read'), /root_authentication_failed/);
  const alias = join(f.directory, 'key-alias'); await symlink(f.keyPath, alias);
  await assert.rejects(f.store({keyPath: alias}).ready(), /key_unavailable/);
  const missing = f.store({keyPath: join(f.directory, 'missing-key')});
  await assert.rejects(missing.ready(), /key_unavailable/);
  const badRoot = join(f.directory, 'plaintext-root');
  const {mkdir} = await import('node:fs/promises');
  await mkdir(badRoot, {mode: 0o700}); await writeFile(join(badRoot, 'legacy.jsonl'), 'synthetic legacy sentinel', {mode: 0o600});
  await assert.rejects(f.store({root: badRoot}).ready(), /root_not_empty/);
  assert.equal(await readFile(join(badRoot, 'legacy.jsonl'), 'utf8'), 'synthetic legacy sentinel');
});

test('cancellation precedes mutation; close drains live events and all handles become closed', linux, async t => {
  const f = await fixture(t), store = f.store();
  const cancelled = new AbortController(); cancelled.abort();
  await assert.rejects(store.create(header('cancelled'), {signal: cancelled.signal}), {name: 'AbortError'});
  await assert.rejects(store.open('absent', 'read', {signal: cancelled.signal}), {name: 'AbortError'});
  assert.equal(await store.stat('cancelled'), undefined);
  const writer = await store.create(header('close'));
  await assert.rejects(writer.append([event(0)], {signal: cancelled.signal}), {name: 'AbortError'});
  assert.deepEqual((await writer.read()).events, []);
  writer.enqueueLive(event(0), () => {});
  const closing = store.close(); assert.equal(store.close(), closing); await closing;
  await assert.rejects(writer.read(), SessionHandleClosedError);
  await assert.rejects(writer.append([event(1)]), SessionHandleClosedError);
  await assert.rejects(store.create(header('after-close')), /closed/);
  const reopened = f.store(); assert.equal((await (await reopened.open('close', 'read')).read()).events.length, 1);
  await assert.rejects(reopened.open('absent', 'read'), SessionPersistenceNotFoundError);
});

test('metadata listing does not retain every history; append verifies the active writer physical head', linux, async t => {
  const f = await fixture(t), store = f.store();
  for (let i = 0; i < 4; i++) {
    const writer = await store.create(header(`memo-${i}`)); await writer.append([event(0)]); await writer.close();
  }
  for (const snapshot of await store.list()) {
    const reader = await store.open(snapshot.header.id, 'read'); await reader.read(); await reader.close();
  }
  assert.ok(store.cache.size <= 2);
  const writer = await store.open('memo-0', 'write');
  const bytes = await readFile(store.path('memo-0'));
  await writeFile(store.path('memo-0'), Buffer.concat([bytes, Buffer.from([2])]));
  await assert.rejects(writer.append([event(1)]), SessionPersistenceCorruptionError);
});

test('publication crash aliases remain readable and only the leased writer removes known pending aliases', linux, async t => {
  const f = await fixture(t), store = f.store();
  const writer = await store.create(header('publication-crash'));
  await writer.append([event(0)]); await writer.close();
  const alias = join(store.directory('publication-crash'), '.pending-00000000-0000-4000-8000-000000000001');
  await link(store.path('publication-crash'), alias);
  const reader = await store.open('publication-crash', 'read');
  assert.equal((await reader.read()).events.length, 1);
  assert.equal((await lstat(alias)).nlink, 2); // reader has not mutated
  const recovered = await store.open('publication-crash', 'write');
  await assert.rejects(lstat(alias), {code: 'ENOENT'});
  assert.equal((await lstat(store.path('publication-crash'))).nlink, 1);
  await recovered.append([event(1)]); await recovered.close();
  assert.equal((await reader.read()).events.length, 2);
  const outside = join(f.directory, 'unrecognized-alias');
  await link(store.path('publication-crash'), outside);
  await assert.rejects(store.open('publication-crash', 'read'), SessionPersistenceCorruptionError);
});

test('authenticated root binds the key before creating another id and never replaces incompatible markers', linux, async t => {
  const f = await fixture(t), store = f.store();
  await store.ready();
  const markerPath = join(f.root, '.uptokey-encrypted-sessions-v1');
  const marker = await readFile(markerPath), inventory = await readdir(f.root);
  const wrongPath = join(f.directory, 'new-valid-key');
  await writeFile(wrongPath, randomBytes(32).toString('hex'), {mode: 0o400});
  const wrong = f.store({keyPath: wrongPath});
  await assert.rejects(wrong.ready(), /root_authentication_failed/);
  await assert.rejects(wrong.create(header('must-not-exist')), /root_authentication_failed/);
  assert.deepEqual(await readdir(f.root), inventory);
  assert.deepEqual(await readFile(markerPath), marker);
  await assert.rejects(lstat(wrong.directory('must-not-exist')), {code: 'ENOENT'});
  for (const [name, content] of [['short-key', 'abc'], ['corrupt-key', 'z'.repeat(64)]]) {
    const keyPath = join(f.directory, name); await writeFile(keyPath, content, {mode: 0o400});
    await assert.rejects(f.store({keyPath}).create(header(name)), /key_unavailable/);
  }
  await assert.rejects(f.store({keyPath: join(f.directory, 'missing-key')}).ready(), /key_unavailable/);
  assert.deepEqual(await readdir(f.root), inventory);
  const same = f.store(); await same.ready();
  const writer = await same.create(header('same-key')); await writer.append([event(0)]); await writer.close();
  const {mkdir} = await import('node:fs/promises');
  const unboundRoot = join(f.directory, 'unbound-root'); await mkdir(unboundRoot, {mode: 0o700});
  const oldMarker = join(unboundRoot, '.uptokey-encrypted-sessions-v1');
  await writeFile(oldMarker, 'UPTOKEY-ENCRYPTED-SESSIONS-1\n', {mode: 0o600});
  const unbound = f.store({root: unboundRoot});
  await assert.rejects(unbound.ready(), SessionFormatUnsupportedError);
  assert.equal(await readFile(oldMarker, 'utf8'), 'UPTOKEY-ENCRYPTED-SESSIONS-1\n');
  assert.deepEqual(await readdir(unboundRoot), ['.uptokey-encrypted-sessions-v1']);
});
