// Reuse the Harness toast primitive and its declared snapshot-hook channel.
(function () {
  'use strict';
  function apply(ctx, require) {
    if (window.UptokeyHarnessAccountReady !== true) return;
    const { jsx } = require('react/jsx-runtime');
    const { Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { createSnapshotStore } = require('@deepseek-ai/dsh-client-store');
    const notice = createSnapshotStore(null); let sequence = 0;
    function Notice({ useImportNotice, dismiss, t }) {
      const current = useImportNotice(value => value);
      return current ? jsx(Toast, { text: t(current.ok ? 'done' : 'failed'), tone: current.ok ? 'success' : undefined, onDone: dismiss }, current.sequence) : null;
    }
    ctx.inject(['locale'], scope => {
      scope.effect(() => scope.locale.register('uptokey.workspace-import', {
        en: { done: 'Project imported', failed: 'Could not open the imported project' },
        zh: { done: '项目已导入', failed: '无法打开导入的项目' },
      }));
      scope.slots.inject('shell.overlay', () => scope.slots.register({
        name: 'shell.overlay', id: 'uptokey.workspace-import', locale: 'uptokey.workspace-import',
        inject: () => ({ hooks: { importNotice: notice }, dismiss: () => notice.set(null) }),
      }, Notice));
      scope.effect(() => {
        const report = event => {
          if (typeof event.detail?.ok !== 'boolean' || !/^\/workspace\/import-[a-f0-9]{32}$/.test(event.detail.project ?? '')) return;
          notice.set({ ok: event.detail.ok, sequence: ++sequence });
        };
        window.addEventListener('uptokey:workspace-import-result', report);
        return () => { window.removeEventListener('uptokey:workspace-import-result', report); notice.set(null); };
      });
    });
  }
  window.UptokeyHarnessWorkspaceFeedback = Object.freeze({ apply });
})();
