import {constants, closeSync, lstatSync, openSync, opendirSync, readSync, realpathSync, statfsSync} from 'node:fs';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import {fileLeafName} from '../contracts/file-leaf-name.mjs';

export const IMAGE_PATH = '/home/node/.dsh/uptokey-image-materialization';
const CAPACITY = 256n * 1024n * 1024n;
const MOUNT_INFO_LIMIT = 1024 * 1024;
const TMPFS = 0x01021994n;
const PENDING = /^\.pending-[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/;
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const owner = stat => stat.uid;
const version = stat => `${stat.dev}:${stat.ino}:${stat.ctimeMs}:${stat.mtimeMs}`;

/** Pure namespace parsing shared by topology and the two hydration owners. */
export function materializationParts(path, root = IMAGE_PATH) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) return undefined;
  if (!path.startsWith(root + '/')) return undefined;
  const parts = path.slice(root.length + 1).split('/');
  const [kind, prefix, digest, leaf] = parts;
  if (!/^[a-f0-9]{64}$/.test(digest ?? '') || prefix !== digest.slice(0, 2)) return undefined;
  if (kind === 'objects' && parts.length === 3) return parts;
  if (kind === 'files' && parts.length === 4 && leaf && leaf === fileLeafName(leaf)) return parts;
  return undefined;
}
const unescapeMount = value => value.replace(/\\(040|011|012|134)/g,
  (_, code) => ({'040': ' ', '011': '\t', '012': '\n', '134': '\\'})[code]);

function mountInfo() {
  const descriptor = openSync('/proc/self/mountinfo', constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks = []; let count = 0;
  try {
    for (;;) {
      const chunk = Buffer.alloc(Math.min(16384, MOUNT_INFO_LIMIT + 1 - count));
      const size = readSync(descriptor, chunk, 0, chunk.length, null);
      if (!size) break;
      count += size;
      if (count > MOUNT_INFO_LIMIT) throw Error('image_path_mount_invalid');
      chunks.push(chunk.subarray(0, size));
    }
    return Buffer.concat(chunks, count).toString('utf8');
  } finally { closeSync(descriptor); }
}

function privateDirectory(stat, uid) {
  return stat.isDirectory() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o700 && owner(stat) === uid;
}

function privateObject(stat, uid) {
  return stat.isFile() && !stat.isSymbolicLink() && (stat.mode & 0o777) === 0o400 && owner(stat) === uid;
}

// The original publisher links a private pending inode before unlinking its
// temporary name. A crash can retain those exact aliases while the pool lives.
function publishedLinks(path, stat, uid) {
  if (stat.nlink === 1) return true;
  if (stat.nlink < 1) return false;
  const parent = dirname(path), entries = opendirSync(parent); let count = 0;
  try {
    for (;;) {
      const entry = entries.readSync(); if (!entry) break;
      if (!PENDING.test(entry.name)) continue;
      const candidate = lstatSync(join(parent, entry.name));
      if (!sameNode(candidate, stat)) continue;
      if (!privateObject(candidate, uid) || candidate.nlink !== stat.nlink) return false;
      count++;
    }
  } finally { entries.closeSync(); }
  const after = lstatSync(path);
  return count === stat.nlink - 1 && privateObject(after, uid) && sameNode(stat, after)
    && version(stat) === version(after) && stat.size === after.size && stat.nlink === after.nlink;
}

function rootState(root, uid) {
  let current = parse(root).root, stat;
  for (const part of relative(current, root).split(sep).filter(Boolean)) {
    current = join(current, part); stat = lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('image_path_root_invalid');
  }
  if (!stat || !privateDirectory(stat, uid)) throw Error('image_path_root_invalid');
  return stat;
}

function verifyMount(root, stats, info) {
  if (typeof info !== 'string' || Buffer.byteLength(info) > MOUNT_INFO_LIMIT) throw Error('image_path_mount_invalid');
  const capacity = BigInt(stats.bsize) * BigInt(stats.blocks);
  if (BigInt(stats.type) !== TMPFS || capacity < 1n || capacity > CAPACITY) throw Error('image_path_mount_invalid');
  let match;
  for (const line of info.split('\n')) {
    const split = line.indexOf(' - '); if (split < 0) continue;
    const left = line.slice(0, split).split(' '), right = line.slice(split + 3).split(' ');
    if (left.length < 6 || right.length < 3 || unescapeMount(left[4]) !== root) continue;
    if (match) throw Error('image_path_mount_invalid');
    match = new Set([...left[5].split(','), ...right[2].split(',')]);
    if (right[0] !== 'tmpfs') throw Error('image_path_mount_invalid');
  }
  if (!match || !match.has('rw') || !match.has('noswap') || !match.has('noexec')) throw Error('image_path_mount_invalid');
}

/**
 * Topology only: like fs-local's host-path mapper, this does not claim that
 * bytes exist. The attachment owner's async barrier must precede tool access.
 * Each filesystem instance owns its cache; snapshot substitutes OS metadata
 * only in tests, while all path operations still use the actual filesystem.
 */
export function createImagePathResolver({root = IMAGE_PATH, snapshot} = {}) {
  if (typeof root !== 'string' || !isAbsolute(root) || resolve(root) !== root) throw Error('image_path_root_invalid');
  const uid = snapshot?.uid ?? 1000;
  if (!Number.isSafeInteger(uid) || uid < 0) throw Error('image_path_owner_invalid');
  let verified;
  return function resolverFutureImagePath(path) {
    if (process.platform !== 'linux' || typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) return undefined;
    const parts = materializationParts(path, root);
    if (!parts) return undefined;
    try {
      const before = rootState(root, uid);
      const stats = snapshot?.stats ?? statfsSync(root, {bigint: true});
      const mountVersion = `${stats.type}:${stats.bsize}:${stats.blocks}`;
      const rootVersion = version(before);
      if (!verified || verified.rootVersion !== rootVersion || verified.mountVersion !== mountVersion
        || snapshot && verified.snapshotInfo !== snapshot.mountInfo) {
        if (realpathSync(root) !== root) return undefined;
        const info = snapshot?.mountInfo ?? mountInfo();
        verifyMount(root, stats, info);
        if (!sameNode(before, rootState(root, uid))) return undefined;
        verified = {rootVersion, mountVersion, snapshotInfo: snapshot?.mountInfo};
      }
      let current = root, missing = false;
      for (const part of parts) {
        current = join(current, part);
        let stat;
        try { stat = lstatSync(current); }
        catch (error) {
          if (error?.code !== 'ENOENT') return undefined;
          missing = true; break;
        }
        if (current !== path) { if (!privateDirectory(stat, uid)) return undefined; }
        else if (!privateObject(stat, uid) || !publishedLinks(path, stat, uid)) return undefined;
      }
      // A replacement during the walk cannot inherit the cached mount proof.
      const after = rootState(root, uid);
      if (!sameNode(before, after) || version(before) !== version(after)) return undefined;
      return missing || current === path ? path : undefined;
    } catch { return undefined; }
  };
}

/** Safe one-shot form; long-lived providers use the factory's owned cache. */
export function resolverFutureImagePath(path) { return createImagePathResolver()(path); }
