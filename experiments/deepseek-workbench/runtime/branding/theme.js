// Project the original Harness ThemeRuntime into the native window.
// ThemeRuntime remains the only persisted owner; font-only events do no work.
(function () {
  'use strict';
  function connect(native, target, report) {
    let disposed = false, running = false, pending = null, accepted = null, inFlight = null;
    async function flush() {
      if (disposed || running || !pending) return;
      const next = pending; pending = null; running = true; inFlight = next.key;
      try {
        const answer = await native.sync(next.preference);
        if (!answer || answer.preference !== next.preference || !['light', 'dark'].includes(answer.resolved)) throw Error('theme_response_invalid');
        if (!disposed) {
          accepted = next.key;
          target.dataset.uptokeyNativeThemePreference = answer.preference;
          target.dataset.uptokeyNativeThemeResolved = answer.resolved;
        }
      } catch { if (!disposed) report(); }
      finally { running = false; inFlight = null; if (!disposed && pending) void flush(); }
    }
    function update(snapshot) {
      if (disposed || !snapshot || !['system', 'light', 'dark'].includes(snapshot.preference) || !['light', 'dark'].includes(snapshot.active?.colorScheme)) return;
      const next = { preference: snapshot.preference, key: snapshot.preference + ':' + snapshot.active.colorScheme };
      if (running) { pending = next.key === inFlight ? null : next; return; }
      if (next.key === accepted && !running) return;
      pending = next; void flush();
    }
    return { update, dispose() { disposed = true; pending = null; delete target.dataset.uptokeyNativeThemePreference; delete target.dataset.uptokeyNativeThemeResolved; } };
  }
  function apply(ctx) {
    if (!window.UptokeyHarnessTheme) return;
    ctx.inject(['theme'], scope => scope.effect(() => {
      const sync = connect(window.UptokeyHarnessTheme, document.body,
        () => window.dispatchEvent(new Event('uptokey:native-theme-error')));
      const off = scope.on('theme/change', sync.update);
      sync.update(scope.theme.getTheme());
      return () => { off(); sync.dispose(); };
    }, 'uptokey: native theme projection'));
  }
  window.UptokeyHarnessThemeUI = Object.freeze({ apply, connect });
})();
