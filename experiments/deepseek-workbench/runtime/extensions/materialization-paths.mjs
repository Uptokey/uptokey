import {FsError} from '@deepseek-ai/dsh-fs';
import {symbols} from '@deepseek-ai/cordis';

// One wrapper per filesystem. Owners can unload in either order; a detached
// router remains a harmless pass-through if another extension captured it.
const routers = new WeakMap();
const aborted = signal => new FsError('Attachment materialization was cancelled.', 'FS_ABORTED', {cause: signal.reason});

export function installMaterializationPathHydration(filesystem, store) {
  if (typeof filesystem?.resolve !== 'function' || typeof filesystem.processPath !== 'function'
    || typeof store?.ensureMaterializedPath !== 'function') throw Error('materialization_filesystem_contract');
  // Cordis returns a fresh context-aware proxy on each get(). The public
  // original symbol keys ownership; calls still keep their contextual receiver.
  const identity = filesystem[symbols.original] ?? filesystem;
  let router = routers.get(identity);
  if (!router) {
    const descriptor = Object.getOwnPropertyDescriptor(identity, 'resolve');
    const statDescriptor = Object.getOwnPropertyDescriptor(identity, 'lstat');
    const original = identity.resolve, processPath = identity.processPath;
    const originalStat = identity.lstat;
    router = {descriptor, original, statDescriptor, originalStat, processPath, owners: new Set(), draining: 0};
    const state = router;
    const perform = function(receiver, path, options, requestedSignal, inspect) {
      const entries = [...state.owners];
      const base = signal => inspect ? state.originalStat.call(receiver, path, options, signal)
        : state.original.call(receiver, path, {...options, signal});
      if (!entries.length) return state.draining ? Promise.reject(new FsError('Attachment materialization is unavailable.', 'FS_IO_ERROR')) : base(requestedSignal);
      const controller = new AbortController();
      const signal = requestedSignal ? AbortSignal.any([requestedSignal, controller.signal]) : controller.signal;
      const admit = () => { if (signal.aborted) throw aborted(signal); };
      const ensure = async (entry, value) => {
        admit();
        try { const result = await entry.store.ensureMaterializedPath(value, signal); admit(); return result; }
        catch (error) {
          if (signal.aborted) throw aborted(signal);
          throw new FsError('Attachment materialization is unavailable.', 'FS_IO_ERROR', {cause: error});
        }
      };
      const work = Promise.resolve().then(async () => {
        const hydrated = new Map();
        for (const entry of entries) hydrated.set(entry, await ensure(entry, path));
        // lstat is deliberately path-shaped: never resolve or follow a symlink
        // to prepare its target before the caller's original no-follow gate.
        admit(); const target = await base(signal); admit();
        if (inspect) return target;
        const canonical = state.processPath.call(receiver, target);
        for (const entry of entries) if (!(hydrated.get(entry) && canonical === path)) await ensure(entry, canonical);
        admit(); return target;
      });
      for (const entry of entries) { entry.pending.add(work); entry.controllers.add(controller); }
      void work.finally(() => { for (const entry of entries) { entry.pending.delete(work); entry.controllers.delete(controller); } }).catch(() => {});
      return work;
    };
    state.wrapped = function(path, options) { return perform(this, path, options, options?.signal, false); };
    state.wrappedStat = function(path, options, signal) { return perform(this, path, options, signal, true); };
    Object.defineProperty(identity, 'resolve', {value: state.wrapped, configurable: true, writable: true});
    if (typeof originalStat === 'function') Object.defineProperty(identity, 'lstat', {value: state.wrappedStat, configurable: true, writable: true});
    routers.set(identity, state);
  }
  const entry = {store, pending: new Set(), controllers: new Set()}; router.owners.add(entry);
  let closing;
  return {dispose() {
    if (!closing) {
      router.owners.delete(entry);
      for (const controller of entry.controllers) controller.abort(new DOMException('Materialization owner unloaded.', 'AbortError'));
      router.draining++;
      closing = Promise.allSettled([...entry.pending]).then(() => {
        router.draining--;
        if (!router.owners.size && !router.draining) {
          if (Object.getOwnPropertyDescriptor(identity, 'resolve')?.value === router.wrapped) {
            if (router.descriptor) Object.defineProperty(identity, 'resolve', router.descriptor); else delete identity.resolve;
          }
          if (Object.getOwnPropertyDescriptor(identity, 'lstat')?.value === router.wrappedStat) {
            if (router.statDescriptor) Object.defineProperty(identity, 'lstat', router.statDescriptor); else delete identity.lstat;
          }
          routers.delete(identity);
        }
      });
    }
    return closing;
  }};
}
