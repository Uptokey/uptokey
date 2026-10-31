const unavailable = () => Error('materialization_ownership_exclusive');
const RANGE_OWNERS = new Set(['unverified', 'fallback', 'windows-job', 'linux-systemd-scope']);
const STRONG_RANGE_OWNERS = new Set(['windows-job', 'linux-systemd-scope']);

/** Global, conservative ownership barrier for the shared volatile pool. */
export class MaterializationOwnership {
  constructor({processRangeOwner = 'unverified'} = {}) {
    if (!RANGE_OWNERS.has(processRangeOwner)) throw TypeError('materialization_process_range_owner');
    Object.defineProperty(this, 'processRangeOwner', {value: processRangeOwner, enumerable: true});
    this.leases = new Set();
    this.accepting = true;
    this.exclusive = undefined;
  }
  /** Automatic deletion requires the same non-escapable owners selected by the canonical subprocess provider. */
  canEvictMaterializations() { return STRONG_RANGE_OWNERS.has(this.processRangeOwner); }
  acquire(kind) {
    if (!this.accepting) throw unavailable();
    if (typeof kind !== 'string' || !kind) throw TypeError('materialization_owner_kind');
    const settled = Promise.withResolvers();
    const lease = {kind, released: false, release: () => {
      if (lease.released) return;
      lease.released = true;
      this.leases.delete(lease);
      settled.resolve();
    }, settled: settled.promise};
    this.leases.add(lease);
    return lease;
  }
  snapshot() {
    const kinds = {};
    for (const lease of this.leases) kinds[lease.kind] = (kinds[lease.kind] ?? 0) + 1;
    return Object.freeze({accepting: this.accepting, active: this.leases.size, kinds: Object.freeze(kinds)});
  }
  /** Blocks new owners, waits every existing owner, and runs one exclusive action. */
  runExclusive(action) {
    if (typeof action !== 'function') return Promise.reject(TypeError('materialization_exclusive_action'));
    if (this.exclusive) return Promise.reject(unavailable());
    this.accepting = false;
    // Publish the reservation before invoking action(). With zero readers the
    // action may begin synchronously, so assigning this.exclusive afterwards
    // would permit a recursive exclusive operation through the same barrier.
    const reservation = Promise.withResolvers();
    const work = reservation.promise;
    this.exclusive = work;
    void (async () => {
      try {
        while (this.leases.size) await Promise.all([...this.leases].map(lease => lease.settled));
        reservation.resolve(await action());
      } catch (error) {
        reservation.reject(error);
      } finally {
        if (this.exclusive === work) {
          this.exclusive = undefined;
          this.accepting = true;
        }
      }
    })();
    return work;
  }
}

// The isolated executor has neither user-systemd nor another non-escapable
// Linux range owner. Keep reclamation fail-closed until deployment can attest
// the canonical provider's linux-systemd-scope capability.
export const materializationOwnership = new MaterializationOwnership({processRangeOwner: 'fallback'});

export function trackPromise(ownership, kind, operation) {
  const lease = ownership.acquire(kind);
  let work;
  try { work = Promise.resolve().then(operation); }
  catch (error) { lease.release(); throw error; }
  return work.finally(() => lease.release());
}

export function trackAsyncIterable(ownership, kind, iterable) {
  const lease = ownership.acquire(kind);
  return trackLeaseAsyncIterable(lease, iterable);
}

export function trackLeaseAsyncIterable(lease, iterable) {
  let iterator;
  try { iterator = iterable[Symbol.asyncIterator](); }
  catch (error) { lease.release(); throw error; }
  let finished = false;
  const finish = () => { if (!finished) { finished = true; lease.release(); } };
  return {
    [Symbol.asyncIterator]() { return this; },
    async next(...args) {
      if (finished) return {done: true, value: undefined};
      try { const result = await iterator.next(...args); if (result.done) finish(); return result; }
      catch (error) { finish(); throw error; }
    },
    async return(value) {
      if (typeof iterator.return !== 'function') { finish(); return {done: true, value}; }
      try { const result = await iterator.return(value); if (result.done) finish(); return result; }
      catch (error) { finish(); throw error; }
    },
    async throw(error) {
      if (typeof iterator.throw !== 'function') { finish(); throw error; }
      try {
        const result = await iterator.throw(error); if (result.done) finish(); return result;
      } catch (thrown) { finish(); throw thrown; }
    },
  };
}

export function observeProcessRange(lease, handle) {
  // A failed observation is deliberately fail-closed: only positive range
  // emptiness releases ownership.
  void handle.waitForExit().then(empty => { if (empty) lease.release(); }).catch(() => {});
  return lease;
}

export function ownProcessRange(ownership, handle) {
  return observeProcessRange(ownership.acquire('process-range'), handle);
}

export function observeTerminalRange(lease, handle) {
  // terminate() is the terminal seam's whole-session quiescence operation.
  void handle.done.catch(() => {}).then(() => handle.terminate()).then(() => lease.release()).catch(() => {});
  return lease;
}

export function ownTerminalRange(ownership, handle) {
  return observeTerminalRange(ownership.acquire('terminal-range'), handle);
}
