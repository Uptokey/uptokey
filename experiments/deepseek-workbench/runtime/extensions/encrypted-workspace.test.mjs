import assert from 'node:assert/strict';
import {fork} from 'node:child_process';
import {once} from 'node:events';
import {mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import test from 'node:test';
import {EncryptedWorkspaceStore, assertWorkspaceTmpfs} from './encrypted-workspace.mjs';

test('mount admission requires shared tmpfs hardening without noexec', () => {
  const good = '32 21 0:31 / /workspace rw,nosuid,nodev - tmpfs tmpfs rw,size=65536k,noswap';
  assert.equal(assertWorkspaceTmpfs(good, '/workspace'), true);
  assert.throws(() => assertWorkspaceTmpfs(good.replace('nodev', 'exec'), '/workspace'), /workspace_mount_not_volatile/);
  assert.throws(() => assertWorkspaceTmpfs(good.replace(',noswap', ''), '/workspace'), /workspace_mount_not_volatile/);
  assert.throws(() => assertWorkspaceTmpfs(good.replace('tmpfs tmpfs', 'ext4 /dev/sda'), '/workspace'), /workspace_mount_not_volatile/);
});

test('a persistence failure closes admission and notifies the owner exactly once', async () => {
  let failures = 0;
  const store = new EncryptedWorkspaceStore({workspace: '/tmp/workspace', store: '/tmp/store', keyPath: '/tmp/key', requireTmpfs: false,
    logger: {error() {}}, onFailure() { failures++; }});
  store.fail(Error('first')); store.fail(Error('second'));
  assert.equal(store.accepting, false); assert.equal(failures, 1);
  await assert.rejects(() => store.checkpoint(), /workspace_store_closed/);
});

test('an immediate flush retries a concurrent mutation and reaches the requested revision', async () => {
  const store = new EncryptedWorkspaceStore({workspace: '/tmp/workspace', store: '/tmp/store', keyPath: '/tmp/key', requireTmpfs: false,
    logger: {error() {}}});
  let calls = 0;
  store.checkpoint = async () => {
    if (++calls === 1) throw Object.assign(Error('workspace_changed'), {code: 'workspace_changed'});
  };
  store.schedule();
  while (store.flushPromise) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(calls, 2);
  assert.equal(store.persistedRevision, 1);
  assert.equal(store.accepting, true);
});

test('an immediate flush still fails closed on a durable persistence error', async () => {
  let failures = 0;
  const store = new EncryptedWorkspaceStore({workspace: '/tmp/workspace', store: '/tmp/store', keyPath: '/tmp/key', requireTmpfs: false,
    logger: {error() {}}, onFailure() { failures++; }});
  store.checkpoint = async () => { throw Object.assign(Error('durable_io_failure'), {code: 'EIO'}); };
  store.schedule();
  while (store.flushPromise) await new Promise(resolve => setTimeout(resolve, 2));
  assert.equal(store.accepting, false);
  assert.equal(store.failure.code, 'EIO');
  assert.equal(failures, 1);
});

test('workspace files persist only through authenticated ciphertext and restore exactly', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-workspace-store-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workspace = join(root, 'workspace'), store = join(root, 'store'), keyPath = join(root, 'key');
  await mkdir(join(workspace, 'demo', 'src'), {recursive: true, mode: 0o700});
  await writeFile(keyPath, 'a'.repeat(64), {mode: 0o400});
  await writeFile(join(workspace, 'demo', 'src', 'index.js'), 'PRIVATE_WORKSPACE_CANARY\n', {mode: 0o600});
  await writeFile(join(workspace, 'demo', 'empty.txt'), '', {mode: 0o600});
  const first = await new EncryptedWorkspaceStore({workspace, store, keyPath, seed: undefined, requireTmpfs: false, debounceMs: 20}).initialize();
  await writeFile(join(workspace, 'demo', 'src', 'index.js'), 'PRIVATE_WORKSPACE_CANARY\nchanged\n', {mode: 0o600});
  await first.checkpoint(); await first.close();
  const durable = [];
  const visit = async path => { for (const name of await readdir(path)) { const item = join(path, name), facts = await stat(item); if (facts.isDirectory()) await visit(item); else durable.push(await readFile(item)); } };
  await visit(store);
  assert.equal(durable.some(bytes => bytes.includes(Buffer.from('PRIVATE_WORKSPACE_CANARY'))), false);
  await rm(workspace, {recursive: true}); await mkdir(workspace, {mode: 0o700});
  const second = await new EncryptedWorkspaceStore({workspace, store, keyPath, seed: undefined, requireTmpfs: false, debounceMs: 20}).initialize();
  assert.equal(await readFile(join(workspace, 'demo', 'src', 'index.js'), 'utf8'), 'PRIVATE_WORKSPACE_CANARY\nchanged\n');
  assert.equal((await stat(join(workspace, 'demo', 'empty.txt'))).size, 0);
  await second.close();
});

test('workspace removes the debounce loss window and restores after an abrupt process stop', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-workspace-abrupt-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workspace = join(root, 'workspace'), store = join(root, 'store'), keyPath = join(root, 'key');
  await mkdir(workspace, {mode: 0o700});
  await writeFile(keyPath, 'd'.repeat(64), {mode: 0o400});
  const child = fork(new URL('./encrypted-workspace-abrupt-child.mjs', import.meta.url), [workspace, store, keyPath], {
    stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); });
  const failure = new Promise((_, reject) => {
    child.once('error', reject);
    child.stderr.on('data', chunk => reject(Error(chunk.toString('utf8'))));
    child.once('exit', (code, signal) => {
      if (code && signal !== 'SIGKILL') reject(Error(`workspace_child_failed_${code}`));
    });
  });
  const [message] = await Promise.race([once(child, 'message'), failure]);
  assert.equal(Number.isSafeInteger(message.sequence), true);
  assert.equal(message.elapsedMs < 4_000, true);
  child.kill('SIGKILL');
  await once(child, 'exit');
  await rm(workspace, {recursive: true}); await mkdir(workspace, {mode: 0o700});
  const restored = await new EncryptedWorkspaceStore({workspace, store, keyPath, seed: undefined, requireTmpfs: false}).initialize();
  assert.equal(await readFile(join(workspace, 'latest.txt'), 'utf8'), 'durable-before-abrupt-stop:23\n');
  await restored.close();
});

test('tampered ciphertext refuses restoration before publishing plaintext', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-workspace-tamper-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const workspace = join(root, 'workspace'), store = join(root, 'store'), keyPath = join(root, 'key');
  await mkdir(workspace, {recursive: true, mode: 0o700}); await writeFile(keyPath, 'b'.repeat(64), {mode: 0o400});
  await writeFile(join(workspace, 'proof.txt'), 'authenticated-only', {mode: 0o600});
  const first = await new EncryptedWorkspaceStore({workspace, store, keyPath, seed: undefined, requireTmpfs: false}).initialize(); await first.close();
  const objects = join(store, 'objects'), [name] = (await readdir(objects)).filter(value => value.endsWith('.bin'));
  const bytes = await readFile(join(objects, name)); bytes[Math.floor(bytes.length / 2)] ^= 1; await writeFile(join(objects, name), bytes, {mode: 0o600});
  await rm(workspace, {recursive: true}); await mkdir(workspace, {mode: 0o700});
  await assert.rejects(() => new EncryptedWorkspaceStore({workspace, store, keyPath, seed: undefined, requireTmpfs: false}).initialize(), /authentication|structure|ATTACHMENT_CORRUPT/i);
  assert.deepEqual(await readdir(workspace), []);
});

test('a quiescent legacy workspace imports once and is verified against encrypted state', async t => {
  const root = await mkdtemp(join(tmpdir(), 'uptokey-workspace-import-'));
  t.after(() => rm(root, {recursive: true, force: true}));
  const source = join(root, 'legacy'), workspace = join(root, 'workspace'), store = join(root, 'store'), keyPath = join(root, 'key');
  await mkdir(join(source, 'project', 'src'), {recursive: true, mode: 0o700}); await mkdir(workspace, {mode: 0o700});
  await writeFile(keyPath, 'c'.repeat(64), {mode: 0o400});
  await writeFile(join(source, 'project', 'src', 'run.sh'), '#!/bin/sh\nprintf migrated-ok\\n\n', {mode: 0o700});
  await writeFile(join(source, 'project', 'empty.bin'), '', {mode: 0o600});
  const encrypted = await new EncryptedWorkspaceStore({workspace, store, keyPath, seed: null, requireTmpfs: false}).initialize();
  const result = await encrypted.importFrom(source);
  assert.deepEqual({sequence: result.sequence, entries: result.entries, files: result.files, bytes: result.bytes}, {sequence: 2, entries: 4, files: 2, bytes: 31});
  assert.equal(await readFile(join(workspace, 'project', 'src', 'run.sh'), 'utf8'), '#!/bin/sh\nprintf migrated-ok\\n\n');
  await assert.rejects(() => encrypted.importFrom(source), /workspace_import_invalid/);
  const durable = [];
  const visit = async path => { for (const name of await readdir(path)) { const item = join(path, name), value = await stat(item); if (value.isDirectory()) await visit(item); else durable.push(await readFile(item)); } };
  await visit(store);
  assert.equal(durable.some(bytes => bytes.includes(Buffer.from('migrated-ok'))), false);
  await encrypted.close();
});
