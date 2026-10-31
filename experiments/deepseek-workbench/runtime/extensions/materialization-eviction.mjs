import {lstat, opendir, rmdir, unlink} from 'node:fs/promises';
import {dirname, isAbsolute, join, relative, resolve} from 'node:path';
import {materializationOwnership} from './materialization-ownership.mjs';

const BUCKET = /^[a-f0-9]{2}$/;
const DIGEST = /^[a-f0-9]{64}$/;
const absent = error => error?.code === 'ENOENT';
const notEmpty = error => error?.code === 'ENOTEMPTY' || error?.code === 'EEXIST';
const invalid = () => Error('materialization_eviction_contract');

async function directory(path) {
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw invalid();
  return info;
}

async function candidate(path, usedAt) {
  const info = await lstat(path);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || (info.mode & 0o777) !== 0o400
    || !Number.isSafeInteger(info.size) || info.size < 0) throw invalid();
  return {path, bytes: info.size, usedAt: Math.max(info.mtimeMs, usedAt ?? 0)};
}

async function imageCandidates(root, touches) {
  const base = join(root, 'objects');
  try { await directory(base); } catch (error) { if (absent(error)) return []; throw error; }
  const found = [];
  for await (const bucket of await opendir(base)) {
    if (!BUCKET.test(bucket.name)) continue;
    const bucketPath = join(base, bucket.name); await directory(bucketPath);
    for await (const entry of await opendir(bucketPath)) {
      if (!DIGEST.test(entry.name) || !entry.name.startsWith(bucket.name)) continue;
      const path = join(bucketPath, entry.name); found.push(await candidate(path, touches.get(path)));
    }
  }
  return found;
}

async function fileCandidates(root, touches) {
  const base = join(root, 'files');
  try { await directory(base); } catch (error) { if (absent(error)) return []; throw error; }
  const found = [];
  for await (const bucket of await opendir(base)) {
    if (!BUCKET.test(bucket.name)) continue;
    const bucketPath = join(base, bucket.name); await directory(bucketPath);
    for await (const digest of await opendir(bucketPath)) {
      if (!DIGEST.test(digest.name) || !digest.name.startsWith(bucket.name)) continue;
      const digestPath = join(bucketPath, digest.name); await directory(digestPath);
      for await (const entry of await opendir(digestPath)) {
        if (!entry.name || entry.name === '.' || entry.name === '..') continue;
        const path = join(digestPath, entry.name); found.push(await candidate(path, touches.get(path)));
      }
    }
  }
  return found;
}

async function prune(path, stop) {
  let current = dirname(path);
  while (current !== stop && current.startsWith(stop + '/')) {
    try { await rmdir(current); }
    catch (error) { if (absent(error) || notEmpty(error)) return; throw error; }
    current = dirname(current);
  }
}

/** Bounded LRU/idle cleanup for authenticated plaintext materializations. */
export class MaterializationEviction {
  constructor({idleMs = 5 * 60_000, graceMs = 30_000, intervalMs = 60_000,
    highWatermark = 0.75, targetWatermark = 0.5, now = () => Date.now(),
    setTimer = setTimeout, clearTimer = clearTimeout} = {}) {
    if (![idleMs, graceMs, intervalMs].every(Number.isSafeInteger) || idleMs < graceMs || graceMs < 0 || intervalMs < 1
      || !(highWatermark > targetWatermark && highWatermark <= 1 && targetWatermark >= 0)) throw invalid();
    Object.assign(this, {idleMs, graceMs, intervalMs, highWatermark, targetWatermark, now, setTimer, clearTimer});
    this.touches = new Map(); this.refs = 0;
  }
  attach({root, capacityBytes, ownership}) {
    if (typeof root !== 'string' || !isAbsolute(root) || !Number.isSafeInteger(capacityBytes) || capacityBytes < 1
      || !ownership || typeof ownership.runExclusive !== 'function'
      || typeof ownership.canEvictMaterializations !== 'function') throw invalid();
    const normalized = resolve(root);
    if ((this.refs || this.running) && (this.root !== normalized || this.capacityBytes !== capacityBytes || this.ownership !== ownership)) throw invalid();
    if (!this.refs && !this.running) Object.assign(this, {
      root: normalized, capacityBytes, ownership,
      enabled: ownership.canEvictMaterializations(),
    });
    this.refs++; this.requestSweep(); let released = false;
    return () => {
      if (released) return; released = true; this.refs--;
      if (!this.refs) {
        if (this.timer) this.clearTimer(this.timer);
        this.timer = undefined;
        if (!this.running) this.reset();
      }
    };
  }
  reset() {
    this.touches.clear(); this.root = undefined; this.capacityBytes = undefined; this.ownership = undefined; this.enabled = undefined;
  }
  touch(path) {
    if (!this.refs || typeof path !== 'string' || !isAbsolute(path)) throw invalid();
    const normalized = resolve(path), tail = relative(this.root, normalized);
    if (!tail || tail.startsWith('..') || isAbsolute(tail)) throw invalid();
    if (!this.enabled) return;
    this.touches.set(normalized, this.now()); this.requestSweep();
  }
  requestSweep(delay = this.intervalMs) {
    if (!this.refs || !this.enabled || this.timer) return;
    this.timer = this.setTimer(() => {
      this.timer = undefined;
      void this.sweep().catch(error => { this.lastError = error; }).finally(() => { if (this.refs) this.requestSweep(); });
    }, delay);
    this.timer?.unref?.();
  }
  sweep() {
    if (!this.refs) return Promise.resolve({examined: 0, removed: 0, bytesFreed: 0, bytesRemaining: 0});
    if (!this.enabled) return Promise.reject(Error('materialization_eviction_owner_unavailable'));
    if (this.running) return this.running;
    const work = this.ownership.runExclusive(() => this.sweepOwned()); this.running = work;
    return work.finally(() => {
      if (this.running === work) this.running = undefined;
      if (!this.refs && !this.running) this.reset();
    });
  }
  async sweepOwned() {
    await directory(this.root);
    const candidates = [...await imageCandidates(this.root, this.touches), ...await fileCandidates(this.root, this.touches)]
      .sort((a, b) => a.usedAt - b.usedAt || a.path.localeCompare(b.path));
    let bytesRemaining = candidates.reduce((total, item) => total + item.bytes, 0), removed = 0, bytesFreed = 0;
    const pressure = bytesRemaining > this.capacityBytes * this.highWatermark;
    const target = this.capacityBytes * this.targetWatermark, at = this.now();
    for (const item of candidates) {
      const age = Math.max(0, at - item.usedAt);
      if (age < this.graceMs || age < this.idleMs && (!pressure || bytesRemaining <= target)) continue;
      try { await unlink(item.path); }
      catch (error) { if (absent(error)) continue; throw error; }
      this.touches.delete(item.path); removed++; bytesFreed += item.bytes; bytesRemaining -= item.bytes;
      await prune(item.path, this.root);
    }
    return {examined: candidates.length, removed, bytesFreed, bytesRemaining, pressure};
  }
}

export const materializationEviction = new MaterializationEviction();

