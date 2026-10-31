// Share only an in-flight preparation, never cache its result or own a POSIX
// reader's lifetime. Reclamation still requires the separate global contract.
export function sharedPreparation(pending, key, signal, prepare) {
  if (signal?.aborted) return Promise.reject(signal.reason);
  let entry = pending.get(key);
  if (!entry || entry.controller.signal.aborted) {
    const controller = new AbortController();
    entry = {controller, waiters: new Set()};
    const current = entry;
    entry.work = Promise.resolve().then(() => {
      controller.signal.throwIfAborted();
      return prepare(controller.signal);
    });
    pending.set(key, entry);
    void entry.work.finally(() => {
      if (pending.get(key) === current) pending.delete(key);
    }).catch(() => {});
  }
  const current = entry;
  return new Promise((resolve, reject) => {
    const waiter = {}; current.waiters.add(waiter);
    const finish = () => {
      if (!current.waiters.delete(waiter)) return false;
      signal?.removeEventListener('abort', cancel);
      return true;
    };
    const cancel = () => {
      if (!finish()) return;
      reject(signal.reason);
      if (!current.waiters.size) current.controller.abort(signal.reason);
    };
    signal?.addEventListener('abort', cancel, {once: true});
    if (signal?.aborted) cancel();
    current.work.then(value => { if (finish()) resolve(value); }, error => { if (finish()) reject(error); });
  });
}
