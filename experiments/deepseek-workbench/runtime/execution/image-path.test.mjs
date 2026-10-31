import test from 'node:test';
import assert from 'node:assert/strict';
import {chmod, link, mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {dirname, join, resolve, sep} from 'node:path';
import {IMAGE_PATH, createImagePathResolver, resolverFutureImagePath, materializationParts} from './image-path.mjs';
import WorkbenchFileSystem from './filesystem.mjs';

const linux = {skip: process.platform !== 'linux'};
const digest = 'ab' + '1'.repeat(62);
async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), 'uptokey-image-path-')), root = join(directory, 'pool');
  await mkdir(root, {mode: 0o700}); await chmod(root, 0o700);
  t.after(async () => {
    assert.ok(resolve(directory).startsWith(resolve(tmpdir()) + sep + 'uptokey-image-path-'));
    await rm(directory, {recursive: true, force: true});
  });
  const snapshot = {uid: process.getuid(), stats: {type: 0x01021994n, bsize: 4096n, blocks: 65536n},
    mountInfo: `7 1 0:77 / ${root} rw,nosuid,nodev,noexec - tmpfs tmpfs rw,noswap\n`};
  const path = join(root, 'objects', 'ab', digest), resolver = createImagePathResolver({root, snapshot});
  const materialize = async () => { await mkdir(dirname(path), {recursive: true, mode: 0o700}); await writeFile(path, 'synthetic bytes', {mode: 0o400}); await chmod(path, 0o400); };
  return {directory, root, snapshot, path, resolver, materialize};
}

test('cold and warm mappings have the exact same path without reading or creating image bytes', linux, async t => {
  const f = await fixture(t);
  assert.equal(f.resolver(f.path), f.path);
  await assert.rejects(readFile(f.path), {code: 'ENOENT'});
  await f.materialize(); assert.equal(f.resolver(f.path), f.path);
  assert.equal(await readFile(f.path, 'utf8'), 'synthetic bytes');
});

test('generic file namespace maps cold and warm without materializing bytes', linux, async t => {
  const f = await fixture(t), path = join(f.root, 'files', 'ab', digest, 'relatório.csv');
  assert.deepEqual(materializationParts(path, f.root), ['files', 'ab', digest, 'relatório.csv']);
  assert.equal(f.resolver(path), path);
  await assert.rejects(readFile(path), {code: 'ENOENT'});
  await mkdir(dirname(path), {recursive: true, mode: 0o700});
  await writeFile(path, 'synthetic csv', {mode: 0o400});
  assert.equal(f.resolver(path), path);
  await chmod(path, 0o600); assert.equal(f.resolver(path), undefined);
  await chmod(path, 0o400); const alias = join(f.directory, 'alias');
  await link(path, alias); assert.equal(f.resolver(path), undefined);
});

test('generic namespace refuses unsanitized names and malformed paths', linux, async t => {
  const f = await fixture(t), base = f.root + '/files/ab/' + digest + '/';
  for (const path of [base, base + 'a/b', base + '..', base + 'CON', base + 'a\\b', base + 'a:b',
    base + 'trailing.', base + 'a\u0000b', base + 'a'.repeat(256), base + ' ../name',
    f.root + '/files/cd/' + digest + '/a.csv', base + 'a.csv/']) {
    assert.equal(materializationParts(path, f.root), undefined, path);
    assert.equal(f.resolver(path), undefined, path);
  }
});

test('only the exact normalized object namespace and matching digest prefix can map', linux, async t => {
  const f = await fixture(t);
  for (const path of [f.root, f.root + '/', join(f.root, digest), join(f.root, 'objects', 'cd', digest),
    join(f.root, 'objects', 'ab', digest.toUpperCase()), f.path + '.json', f.path + '/',
    f.root + '/objects/ab/../ab/' + digest, f.root + '//objects/ab/' + digest,
    'relative/objects/ab/' + digest, f.root + '-other/objects/ab/' + digest, '/workspace/objects/ab/' + digest]) assert.equal(f.resolver(path), undefined, path);
  assert.equal(f.resolver(undefined), undefined);
});

test('guard refuses wrong filesystem, absent flags, excessive capacity and duplicate mount entries', linux, async t => {
  const f = await fixture(t);
  const cases = [
    {...f.snapshot, stats: {...f.snapshot.stats, type: 0xef53n}},
    {...f.snapshot, stats: {...f.snapshot.stats, blocks: 65537n}},
    {...f.snapshot, stats: {...f.snapshot.stats, blocks: 0n}},
    {...f.snapshot, mountInfo: f.snapshot.mountInfo.replace(',noexec', '')},
    {...f.snapshot, mountInfo: f.snapshot.mountInfo.replace(',noswap', '')},
    {...f.snapshot, mountInfo: f.snapshot.mountInfo.replace('- tmpfs tmpfs', '- ext4 ext4')},
    {...f.snapshot, mountInfo: f.snapshot.mountInfo + f.snapshot.mountInfo},
    {...f.snapshot, mountInfo: 'x'.repeat(1024 * 1024 + 1)},
    {...f.snapshot, uid: process.getuid() + 1},
  ];
  for (const snapshot of cases) assert.equal(createImagePathResolver({root: f.root, snapshot})(f.path), undefined);
  const valid = {...f.snapshot}; assert.equal(createImagePathResolver({root: f.root, snapshot: valid})(f.path), f.path);
  await chmod(f.root, 0o755); assert.equal(f.resolver(f.path), undefined);
});

test('root and existing ancestor symlinks refuse even when they target a private directory', linux, async t => {
  const f = await fixture(t), outside = join(f.directory, 'other'); await mkdir(outside, {mode: 0o700});
  await symlink(outside, join(f.root, 'objects'));
  assert.equal(f.resolver(f.path), undefined); await rm(join(f.root, 'objects'));
  await mkdir(join(f.root, 'objects'), {mode: 0o700}); await symlink(outside, join(f.root, 'objects', 'ab'));
  assert.equal(f.resolver(f.path), undefined);
  await rm(join(f.root, 'objects'), {recursive: true});
  const original = f.root + '-original'; await rename(f.root, original); await symlink(original, f.root);
  assert.equal(f.resolver(f.path), undefined);
});

test('existing final objects require private readonly regular files with one link', linux, async t => {
  const f = await fixture(t); await f.materialize();
  await chmod(f.path, 0o600); assert.equal(f.resolver(f.path), undefined); await chmod(f.path, 0o400);
  const alias = join(f.directory, 'alias'); await link(f.path, alias); assert.equal(f.resolver(f.path), undefined); await rm(alias);
  assert.equal(f.resolver(f.path), f.path); await rm(f.path);
  const outside = join(f.directory, 'outside'); await writeFile(outside, 'sentinel', {mode: 0o400}); await symlink(outside, f.path);
  assert.equal(f.resolver(f.path), undefined); assert.equal(await readFile(outside, 'utf8'), 'sentinel'); await rm(f.path);
  await mkdir(f.path, {mode: 0o700}); assert.equal(f.resolver(f.path), undefined);
});

test('interrupted publication accepts only fully accounted private pending UUID aliases', linux, async t => {
  const f = await fixture(t); assert.equal(f.resolver(f.path), f.path); await f.materialize();
  const pending = join(dirname(f.path), '.pending-00000000-0000-4000-8000-000000000001');
  await link(f.path, pending); assert.equal(f.resolver(f.path), f.path);
  const unknown = join(dirname(f.path), 'arbitrary-alias'); await link(f.path, unknown);
  assert.equal(f.resolver(f.path), undefined); await rm(unknown);
  assert.equal(f.resolver(f.path), f.path);
  const otherDirectory = join(f.directory, '.pending-00000000-0000-4000-8000-000000000002');
  await link(f.path, otherDirectory); assert.equal(f.resolver(f.path), undefined); await rm(otherDirectory);
  assert.equal(f.resolver(f.path), f.path); await rm(pending);
  assert.equal(f.resolver(f.path), f.path); assert.equal(await readFile(f.path, 'utf8'), 'synthetic bytes');
});

test('ENOTDIR and inaccessible ancestors never count as a missing future object', linux, async t => {
  const f = await fixture(t); await writeFile(join(f.root, 'objects'), 'not a directory', {mode: 0o600});
  assert.equal(f.resolver(f.path), undefined); await rm(join(f.root, 'objects'));
  await mkdir(join(f.root, 'objects'), {mode: 0o700}); await mkdir(join(f.root, 'objects', 'ab'), {mode: 0o700});
  await chmod(join(f.root, 'objects', 'ab'), 0o000);
  assert.equal(f.resolver(f.path), undefined);
  await chmod(join(f.root, 'objects', 'ab'), 0o700);
});

test('cache revalidates metadata on root changes and rejects a changed mount proof', linux, async t => {
  const f = await fixture(t); assert.equal(f.resolver(f.path), f.path);
  f.snapshot.mountInfo = f.snapshot.mountInfo.replace(',noexec', ''); assert.equal(f.resolver(f.path), undefined);
  f.snapshot.mountInfo = f.snapshot.mountInfo.replace('nodev -', 'nodev,noexec -'); assert.equal(f.resolver(f.path), f.path);
  await rename(f.root, f.root + '-old'); await mkdir(f.root, {mode: 0o755}); assert.equal(f.resolver(f.path), undefined);
  await chmod(f.root, 0o700); assert.equal(f.resolver(f.path), f.path);
});

test('filesystem mapper refuses invalid pool paths without invoking its generic realpath fallback', () => {
  const paths = [], subject = {futureImagePath(path) { paths.push(path); return undefined; }};
  assert.equal(WorkbenchFileSystem.prototype.processPathFromHostPath.call(subject, IMAGE_PATH + '/invalid'), undefined);
  assert.equal(WorkbenchFileSystem.prototype.processPathFromHostPath.call(subject, IMAGE_PATH + '/objects/../invalid'), undefined);
  assert.deepEqual(paths, [IMAGE_PATH + '/invalid', IMAGE_PATH + '/objects/../invalid']);
  assert.equal(resolverFutureImagePath('/not-an-image-namespace'), undefined);
});
