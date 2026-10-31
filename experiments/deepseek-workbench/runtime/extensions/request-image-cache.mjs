import {constants} from 'node:fs';
import {lstat, open, opendir, statfs, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, parse, relative, resolve, sep} from 'node:path';
import z from '@deepseek-ai/schemastery';

export const name = 'uptokey-request-image-cache';
export const inject = ['attachments'];
export const CACHE_PATH = '/home/node/.dsh/cache/attachments';
export const CACHE_CAPACITY = 256 * 1024 * 1024;
export const CACHE_BYTE_BUDGET = 128 * 1024 * 1024;
export const CACHE_ENTRY_LIMIT = 256;
const TMPFS_MAGIC = 0x01021994n;
const INFO_LIMIT = 1024 * 1024;
const PREFIX = /^[a-f0-9]{2}$/;
const HASH = /^[a-f0-9]{64}$/;
const WARNING = 'Uptokey request image cache cleanup unavailable.';
const unsafe = () => Error('request_image_cache_unsafe_path');
const invalidMount = () => Error('request_image_cache_mount_invalid');
const sameNode = (a, b) => a.dev === b.dev && a.ino === b.ino;
const sameFile = (a, b) => sameNode(a, b) && a.size === b.size && a.mtimeMs === b.mtimeMs && a.ctimeMs === b.ctimeMs;
const missing = error => error?.code === 'ENOENT';

export const Config = z.object({
  path: z.const(CACHE_PATH).default(CACHE_PATH),
  byteBudget: z.number().step(1).min(1).max(CACHE_BYTE_BUDGET).default(CACHE_BYTE_BUDGET),
  maxEntries: z.number().step(1).min(1).max(CACHE_ENTRY_LIMIT).default(CACHE_ENTRY_LIMIT),
});

async function directory(path, mode) {
  const root = parse(path).root;
  let current = root;
  for (const part of relative(root, path).split(sep).filter(Boolean)) {
    current = join(current, part);
    const stat = await lstat(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw unsafe();
  }
  const stat = await lstat(path);
  if (mode !== undefined && (stat.mode & 0o777) !== mode) throw unsafe();
  if (mode !== undefined && process.getuid && stat.uid !== process.getuid()) throw unsafe();
  return stat;
}

async function mountInfo() {
  const handle = await open('/proc/self/mountinfo', constants.O_RDONLY | constants.O_NOFOLLOW);
  const chunks = [];
  let count = 0;
  try {
    for (;;) {
      const bytes = Buffer.alloc(Math.min(16384, INFO_LIMIT + 1 - count));
      const {bytesRead} = await handle.read(bytes, 0, bytes.length, null);
      if (!bytesRead) break;
      count += bytesRead;
      if (count > INFO_LIMIT) throw invalidMount();
      chunks.push(bytes.subarray(0, bytesRead));
    }
    return Buffer.concat(chunks, count).toString('utf8');
  } finally { await handle.close(); }
}

const unescapeMount = value => value.replace(/\\(040|011|012|134)/g,
  (_, code) => ({'040': ' ', '011': '\t', '012': '\n', '134': '\\'})[code]);

/** The optional snapshot supplies only OS metadata for guard tests, never filesystem operations. */
export async function verifyCacheMount(path = CACHE_PATH, snapshot) {
  if (process.platform !== 'linux' || !isAbsolute(path)) throw invalidMount();
  path = resolve(path);
  const before = await directory(path, 0o700);
  const stats = snapshot?.stats ?? await statfs(path, {bigint: true});
  const info = snapshot?.mountInfo ?? await mountInfo();
  if (typeof info !== 'string' || Buffer.byteLength(info) > INFO_LIMIT) throw invalidMount();
  const matches = [];
  for (const line of info.split('\n')) {
    const split = line.indexOf(' - ');
    if (split < 0) continue;
    const left = line.slice(0, split).split(' '), right = line.slice(split + 3).split(' ');
    if (left.length < 6 || right.length < 3 || unescapeMount(left[4]) !== path) continue;
    matches.push({type: right[0], options: new Set([...left[5].split(','), ...right[2].split(',')])});
  }
  const capacity = BigInt(stats.bsize) * BigInt(stats.blocks);
  if (BigInt(stats.type) !== TMPFS_MAGIC || capacity < 1n || capacity > BigInt(CACHE_CAPACITY)
    || matches.length !== 1 || matches[0].type !== 'tmpfs'
    || !matches[0].options.has('rw') || !matches[0].options.has('noswap') || !matches[0].options.has('noexec')) throw invalidMount();
  if (!sameNode(before, await directory(path, 0o700))) throw invalidMount();
  return {capacityBytes: Number(capacity), tmpfs: true, noswap: true, noexec: true};
}

/** Bounded metadata-only sweep; no image bytes or unrecognized files are read. */
export class CacheJanitor {
  constructor({path = CACHE_PATH, byteBudget = CACHE_BYTE_BUDGET, maxEntries = CACHE_ENTRY_LIMIT} = {}) {
    if (typeof path !== 'string' || !isAbsolute(path)) throw Error('request_image_cache_path_invalid');
    if (!Number.isSafeInteger(byteBudget) || byteBudget < 1 || byteBudget > CACHE_BYTE_BUDGET
      || !Number.isSafeInteger(maxEntries) || maxEntries < 1 || maxEntries > CACHE_ENTRY_LIMIT) throw Error('request_image_cache_budget_invalid');
    this.path = resolve(path); this.byteBudget = byteBudget; this.maxEntries = maxEntries;
    this.tail = Promise.resolve();
  }

  sweep({force = false} = {}) {
    const work = this.tail.then(() => this.trim(force));
    this.tail = work.catch(() => {});
    return work;
  }

  drain() { return this.tail; }

  async remove(entry) {
    await directory(this.path, 0o700);
    await directory(dirname(entry.path));
    let stat;
    try { stat = await lstat(entry.path); } catch (error) { if (missing(error)) return false; throw error; }
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw unsafe();
    if (!sameFile(stat, entry.stat)) return false; // a concurrent original cache write won this name
    try { await unlink(entry.path); return true; } catch (error) { if (missing(error)) return false; throw error; }
  }

  async trim(force) {
    const identity = await directory(this.path, 0o700);
    if (this.identity && !sameNode(identity, this.identity)) throw unsafe();
    this.identity = identity;
    const root = join(this.path, 'request-images'), kept = [];
    let bytes = 0, removed = 0, scanned = 0, peakEntries = 0;
    const older = (a, b) => a.stat.mtimeMs - b.stat.mtimeMs || a.path.localeCompare(b.path);
    const evict = async entry => { if (await this.remove(entry)) removed++; };
    let prefixes;
    try { await directory(root); prefixes = await opendir(root); }
    catch (error) { if (missing(error)) return {scanned, removed, keptEntries: 0, keptBytes: 0, peakEntries}; throw error; }
    for await (const prefix of prefixes) {
      if (!PREFIX.test(prefix.name)) continue;
      const parent = join(root, prefix.name), parentStat = await lstat(parent);
      if (parentStat.isSymbolicLink()) throw unsafe();
      if (!parentStat.isDirectory()) continue;
      await directory(parent);
      const entries = await opendir(parent);
      for await (const item of entries) {
        // In particular, <hash>.<uuid>.tmp remains owned by the original writer.
        if (!HASH.test(item.name) || !item.name.startsWith(prefix.name)) continue;
        const path = join(parent, item.name);
        let stat;
        try { stat = await lstat(path); } catch (error) { if (missing(error)) continue; throw error; }
        if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1 || (stat.mode & 0o777) !== 0o600) throw unsafe();
        if (!Number.isSafeInteger(stat.size) || stat.size < 0) throw unsafe();
        scanned++;
        const entry = {path, stat};
        if (force || stat.size > this.byteBudget) { await evict(entry); continue; }
        if (kept.length === this.maxEntries) {
          if (older(entry, kept[0]) <= 0) { await evict(entry); continue; }
          const oldest = kept.shift(); bytes -= oldest.stat.size; await evict(oldest);
        }
        let low = 0, high = kept.length;
        while (low < high) { const middle = (low + high) >>> 1; if (older(kept[middle], entry) <= 0) low = middle + 1; else high = middle; }
        kept.splice(low, 0, entry); bytes += stat.size;
        peakEntries = Math.max(peakEntries, kept.length);
        while (bytes > this.byteBudget) { const oldest = kept.shift(); bytes -= oldest.stat.size; await evict(oldest); }
      }
    }
    return {scanned, removed, keptEntries: kept.length, keptBytes: bytes, peakEntries};
  }
}

/** Keep the provider's exact shared-request, cancellation and compression implementation. */
export function wrapReadImageRequests(service, janitor, {warn = () => {}} = {}) {
  const original = service?.readImageRequest;
  if (typeof original !== 'function') throw Error('request_image_cache_provider_invalid');
  const previous = Object.getOwnPropertyDescriptor(service, 'readImageRequest');
  if (previous && !('value' in previous)) throw Error('request_image_cache_provider_invalid');
  const pending = new Set();
  let stopping = false, closing, warned = false;
  const warning = () => { if (!warned) { warned = true; try { warn(WARNING); } catch {} } };
  const safeSweep = async force => { try { await janitor.sweep({force}); } catch { warning(); } };
  const run = async (receiver, args) => {
    args[2]?.throwIfAborted();
    await janitor.sweep();
    try {
      try { return await original.apply(receiver, args); }
      catch (error) {
        if (error?.code !== 'ENOSPC' && error?.code !== 'EDQUOT') throw error;
        // A failed forced sweep can indicate an unsafe filesystem boundary.
        // Do not let another provider write cross that failed admission check.
        await janitor.sweep({force: true});
        return await original.apply(receiver, args); // once, same references/target/signal
      }
    } finally { await safeSweep(false); }
  };
  function wrapped(...args) {
    if (stopping) return Promise.reject(Error('request_image_cache_closed'));
    const work = run(this, args); pending.add(work);
    void work.then(() => pending.delete(work), () => pending.delete(work));
    return work;
  }
  Object.defineProperty(service, 'readImageRequest', previous
    ? {...previous, value: wrapped}
    : {value: wrapped, writable: true, enumerable: true, configurable: true});
  return {
    dispose() {
      if (!closing) {
        stopping = true;
        closing = (async () => {
          await Promise.allSettled([...pending]); await janitor.drain();
          // Cordis returns fresh traced method proxies. The raw descriptor owns restoration.
          if (Object.getOwnPropertyDescriptor(service, 'readImageRequest')?.value === wrapped) {
            if (previous) Object.defineProperty(service, 'readImageRequest', previous);
            else delete service.readImageRequest;
          }
        })();
      }
      return closing;
    },
  };
}

export async function apply(ctx, config = {}) {
  const path = config.path ?? CACHE_PATH;
  if (path !== CACHE_PATH) throw Error('request_image_cache_path_invalid');
  const janitor = new CacheJanitor({...config, path});
  let stopping = false, adapter;
  ctx.effect(() => async () => { stopping = true; await adapter?.dispose(); });
  await verifyCacheMount(path);
  await janitor.sweep();
  if (!stopping) adapter = wrapReadImageRequests(ctx.attachments, janitor, {warn: message => ctx.logger.warn(message)});
}
