// Observe an imported public API through the authenticated Host and original
// Session selection. This adapter never creates, opens or modifies a Session.
(function () {
  'use strict';
  const MAX_PENDING = 32, MAX_SEEN = 64, RESPONSE_BYTES = 4096, DEADLINE_MS = 25000;
  const validId = value => typeof value === 'string' && /^[a-z][a-z0-9-]{0,31}$/.test(value);
  const validSession = value => typeof value === 'string' && value.length > 0 && value.length <= 256 && !/[\u0000-\u001f\u007f]/.test(value);
  const validInput = value => value && validId(value.apiId)
    && typeof value.schemaSha256 === 'string' && /^[a-f0-9]{64}$/.test(value.schemaSha256)
    && Number.isSafeInteger(value.operations) && value.operations > 0
    && typeof value.requestId === 'string' && /^[A-Za-z0-9_-]{1,96}$/.test(value.requestId);
  const same = (left, right) => left?.id === right?.id && left?.scope === right?.scope;
  const pending = code => ({ status: 'pending', toolCount: 0, code });
  const unavailable = () => ({ status: 'unavailable', toolCount: 0, code: 'api_start_unavailable' });

  function connect(services, report, { timeoutMs = DEADLINE_MS } = {}) {
    let disposed = false, generation = 0, waiting = 0, tail = Promise.resolve();
    let selection = services.selection();
    const tasks = new Map(), seen = new Map(), latest = new Map();
    const changed = force => {
      const next = services.selection();
      if (!force && same(selection, next)) return;
      selection = next; generation++;
      for (const task of tasks.values()) task.controller.abort();
    };
    const stop = services.subscribe(changed);
    const publish = (input, value) => {
      const result = Object.freeze({ ...value, apiId: input.apiId, requestId: input.requestId });
      if (!disposed && typeof report === 'function') report(result);
      return result;
    };
    const remember = (input, promise) => {
      seen.set(input.requestId, { key: input.apiId + ':' + input.schemaSha256, promise });
      while (seen.size > MAX_SEEN) seen.delete(seen.keys().next().value);
      return promise;
    };
    async function run(task) {
      if (disposed || generation !== task.generation || !same(selection, task.selection)
        || latest.get(task.input.apiId) !== task.input.schemaSha256) return pending('api_selection_changed');
      const signal = task.controller.signal;
      let timedOut = false;
      const timer = window.setTimeout(() => { timedOut = true; task.controller.abort(); }, timeoutMs);
      let onAbort;
      try {
        signal.throwIfAborted();
        // A lost transport must not hold the queue or publish a late success.
        const aborted = new Promise((_, reject) => {
          onAbort = () => reject(Error('api_request_aborted'));
          signal.addEventListener('abort', onAbort, { once: true });
        });
        const value = await Promise.race([
          Promise.resolve().then(() => {
            signal.throwIfAborted();
            return services.request({ apiId: task.input.apiId,
              schemaSha256: task.input.schemaSha256, sessionId: task.selection.id }, signal);
          }),
          aborted,
        ]);
        signal.throwIfAborted();
        if (!value || !['ready', 'pending', 'unavailable'].includes(value.status)
          || !Number.isSafeInteger(value.toolCount) || value.toolCount < 0
          || value.status === 'ready' && value.toolCount === 0) return unavailable();
        return value.status === 'ready' ? { status: 'ready', toolCount: value.toolCount }
          : value.status === 'pending' ? pending('api_saved_pending') : unavailable();
      } catch {
        return timedOut ? pending('api_saved_pending') : unavailable();
      } finally {
        window.clearTimeout(timer);
        if (onAbort) signal.removeEventListener('abort', onAbort);
      }
    }
    function enqueue(input) {
      if (disposed || !validInput(input)) return Promise.resolve(pending('api_request_invalid'));
      input = Object.freeze({ apiId: input.apiId, schemaSha256: input.schemaSha256,
        operations: input.operations, requestId: input.requestId });
      const key = input.apiId + ':' + input.schemaSha256;
      const prior = seen.get(input.requestId);
      if (prior) return prior.key === key ? prior.promise : Promise.resolve(pending('api_request_invalid'));
      changed(false);
      if (!selection || !validSession(selection.id) || !selection.scope) {
        return remember(input, Promise.resolve().then(() => publish(input, pending('api_saved_no_session'))));
      }
      if (waiting >= MAX_PENDING) return remember(input, Promise.resolve().then(() => publish(input, pending('api_saved_pending'))));
      latest.delete(input.apiId);
      latest.set(input.apiId, input.schemaSha256);
      while (latest.size > MAX_SEEN) {
        const old = [...latest.keys()].find(id => ![...tasks.values()].some(task => task.input.apiId === id));
        if (old === undefined) break;
        latest.delete(old);
      }
      for (const task of tasks.values()) {
        if (task.input.apiId === input.apiId && task.input.schemaSha256 !== input.schemaSha256) task.controller.abort();
      }
      const taskKey = key + ':' + generation;
      let task = tasks.get(taskKey);
      if (task?.controller.signal.aborted) task = undefined;
      if (!task) {
        task = { input, selection, generation, controller: new AbortController() };
        task.promise = tail.then(() => run(task));
        tail = task.promise.then(() => {}, () => {});
        tasks.set(taskKey, task);
        task.promise.finally(() => { if (tasks.get(taskKey) === task) tasks.delete(taskKey); });
      }
      waiting++;
      const promise = task.promise.then(value => {
        if (disposed || generation !== task.generation || !same(services.selection(), task.selection)
          || latest.get(input.apiId) !== input.schemaSha256) return pending('api_selection_changed');
        return publish(input, value);
      }).finally(() => { waiting--; });
      return remember(input, promise);
    }
    return Object.freeze({ enqueue, dispose() {
      if (disposed) return;
      disposed = true; generation++;
      stop();
      for (const task of tasks.values()) task.controller.abort();
      tasks.clear(); seen.clear(); latest.clear();
    } });
  }

  async function request(body, signal) {
    signal.throwIfAborted();
    const response = await window.fetch('/api/uptokey/public-api-ready', {
      method: 'POST', credentials: 'same-origin', redirect: 'error', cache: 'no-store',
      headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal,
    });
    if (!response.ok || response.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() !== 'application/json'
      || !response.body) throw Error('api_response_invalid');
    const reader = response.body.getReader(), chunks = []; let total = 0;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    signal.addEventListener('abort', cancel, { once: true });
    if (signal.aborted) cancel();
    try {
      while (true) {
        signal.throwIfAborted();
        const { done, value } = await reader.read();
        signal.throwIfAborted();
        if (done) break;
        if (!(value instanceof Uint8Array) || value.byteLength > RESPONSE_BYTES - total) {
          cancel(); throw Error('api_response_limit');
        }
        if (value.byteLength === 0) continue;
        total += value.byteLength; chunks.push(value);
      }
      const bytes = new Uint8Array(total); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    } finally {
      signal.removeEventListener('abort', cancel);
      reader.releaseLock();
    }
  }

  function apply(ctx, require) {
    const { jsx } = require('react/jsx-runtime');
    const { Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const notice = createSnapshotStore(null); let sequence = 0;
    function Notice({ useApiNotice, dismiss, t }) {
      const current = useApiNotice(value => value);
      return current ? jsx(Toast, { text: t(current.status === 'ready' ? 'ready'
        : current.status === 'pending' ? 'saved' : 'failed'),
      tone: current.status === 'ready' ? 'success' : undefined, onDone: dismiss }, current.sequence) : null;
    }
    ctx.inject(['sessions', 'layout', 'locale'], scope => {
      scope.effect(() => scope.locale.register('uptokey.public-api', {
        en: { saved: 'API saved', ready: 'API ready', failed: 'API could not start' },
        zh: { saved: 'API 已保存', ready: 'API 已就绪', failed: 'API 无法启动' },
      }));
      scope.slots.inject('shell.overlay', () => scope.slots.register({
        name: 'shell.overlay', id: 'uptokey.public-api', locale: 'uptokey.public-api',
        inject: () => ({ hooks: { apiNotice: notice }, dismiss: () => notice.set(null) }),
      }, Notice));
      scope.effect(() => {
        const target = document.body;
        const selection = () => {
          if (scope.layout.panelInfo.getSnapshot().activePanelId !== null) return null;
          const list = scope.sessions.list.getSnapshot();
          // Local main-view retention is authoritative even while the Host
          // catalogue refreshes; catalog arrival owns no Client generation.
          const rows = Object.values(list.byId).filter(row => (row.retainedBy.mainView ?? 0) > 0);
          if (rows.length !== 1 || !validSession(rows[0].id)) return null;
          const retained = scope.sessions.scope(rows[0].id);
          return retained ? { id: rows[0].id, scope: retained } : null;
        };
        const bridge = connect({ selection, request, subscribe: changed => {
          const off = [scope.sessions.list.subscribe(() => changed(false)),
            scope.layout.panelInfo.subscribe(() => changed(false)),
            scope.on('connection/reset', () => changed(true))];
          return () => { for (const stop of off) stop(); };
        } }, result => {
          notice.set({ status: result.status, sequence: ++sequence });
          window.dispatchEvent(new CustomEvent('uptokey:public-api-result', { detail: result }));
        });
        const drain = () => {
          const queue = window.UptokeyHarnessPublicApis;
          if (typeof queue?.take !== 'function') return;
          const entries = queue.take();
          if (!Array.isArray(entries)) return;
          for (const entry of entries.slice(0, MAX_PENDING)) void bridge.enqueue(entry);
        };
        window.addEventListener('uptokey:public-api-queued', drain);
        target.dataset.uptokeyPublicApiReady = 'true';
        drain();
        return () => {
          window.removeEventListener('uptokey:public-api-queued', drain);
          bridge.dispose(); notice.set(null);
          delete target.dataset.uptokeyPublicApiReady;
        };
      }, 'uptokey: public API readiness');
    });
  }
  window.UptokeyHarnessPublicApiUI = Object.freeze({ apply, connect, request });
})();
