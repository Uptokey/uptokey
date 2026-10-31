// Account input changes invalidate the original shared model catalog only.
// The core still decides which hosted models the paired client can use.
(function () {
  'use strict';
  function apply(ctx) {
    const account = window.UptokeyCanonicalAccount;
    if (!account?.subscribeAccountBinding || !account?.subscribeAccountCatalogRefresh) return;
    ctx.inject(['modelDirectories'], scoped => {
      let active = true, pending, hard = false, afterLoading = false, prefetch = false, revision = account.accountBindingRevision();
      let authenticated = account.publicAccountSnapshot()?.authenticated === true;
      // Coalesce binding + confirmed-operation + focus signals in one turn.
      // No polling, page reload, selection write or conversation mutation.
      const refresh = (reset = false, after = false, preload = false) => {
        hard ||= reset; afterLoading ||= after; prefetch ||= preload;
        if (!active || pending !== undefined) return;
        pending = window.setTimeout(() => {
          pending = undefined;
          const clear = hard, retry = afterLoading, load = prefetch; hard = false; afterLoading = false; prefetch = false;
          if (active) {
            if (clear) scoped.modelDirectories.resetCatalog();
            else if (load) void scoped.modelDirectories.prefetchCatalog().catch(() => {});
            else scoped.modelDirectories.refreshCatalog(retry);
          }
        }, 0);
      };
      const binding = () => {
        const next = account.accountBindingRevision();
        if (next === revision) return;
        revision = next;
        refresh(true);
      };
      // A confirmed authentication transition may precede a binding signal.
      // Invalidate that generation, so an older signed-out/account
      // response cannot become the resident catalog after login or logout.
      const accountState = () => {
        const snapshot = account.publicAccountSnapshot();
        if (!['connected', 'signed_out'].includes(snapshot?.state)) return;
        const next = snapshot.authenticated === true;
        if (next === authenticated) return;
        authenticated = next;
        refresh(true);
      };
      const stopBinding = account.subscribeAccountBinding(binding);
      const stopRefresh = account.subscribeAccountCatalogRefresh(() => {
        if (account.publicAccountSnapshot()?.authenticated === true) refresh();
      });
      window.addEventListener('uptokey:account-state', accountState);
      // Metadata only, with no model selection or inference. A constructor or
      // dropdown load already in flight is reused rather than refreshed again.
      if (authenticated) refresh(false, false, true);
      scoped.effect(() => () => {
        active = false;
        if (pending !== undefined) window.clearTimeout(pending);
        pending = undefined;
        stopBinding();
        stopRefresh();
        window.removeEventListener('uptokey:account-state', accountState);
      });
    });
  }
  window.UptokeyHarnessModelCatalog = Object.freeze({ apply });
})();
