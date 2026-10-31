// Adapt the canonical Uptokey account to the Harness-owned extension seats.
// The native shell installs the transport before this bridge can register UI.
(function () {
  'use strict';
  function apply(ctx, require) {
    const account = window.UptokeyCanonicalAccount;
    if (window.UptokeyHarnessAccountReady !== true || !account) return;
    const { useEffect, useRef, useState } = require('react');
    const { jsx } = require('react/jsx-runtime');
    const { Modal, Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
    const { defineStore } = require('@deepseek-ai/dsh-client-store');
    const language = () => account.accountLocales.includes(document.documentElement.lang)
      ? document.documentElement.lang : 'en';
    const label = (lang, key) => account.accountLabel(lang, key);
    const createAccountStore = () => defineStore({
      init: () => ({ panel: null }),
      actions: {
        open: (draft, panel) => { draft.panel = panel; },
        close: draft => { draft.panel = null; },
      },
    });
    const store = createAccountStore();

    function Footer({ wide, actions, openSettings }) {
      const upgrade = useRef(null);
      const [lang, setLang] = useState(language);
      useEffect(() => {
        const change = () => setLang(language());
        window.addEventListener('uptokey:locale', change);
        return () => window.removeEventListener('uptokey:locale', change);
      }, []);
      useEffect(() => account.mountUpgrade(upgrade.current, lang), [lang]);
      useEffect(() => {
        const unmount = account.mountAccountRail();
        const action = event => {
          const value = event.detail?.action;
          if (value === 'account' || value === 'usage') actions.open(value);
          else if (value === 'settings') {
            // The original settings launcher supplies its shell-owned action.
            openSettings();
          }
        };
        window.addEventListener('uptokey:user-action', action);
        void account.bootAccountState();
        return () => {
          window.removeEventListener('uptokey:user-action', action);
          unmount();
          actions.close();
        };
      }, [actions, openSettings]);
      return jsx('div', {
        className: 'rail-footer uptokey-harness-account-footer',
        'data-wide': wide ? 'true' : 'false',
        children: [jsx('div', { ref: upgrade, className: 'uptokey-plus-seat' }, 'plus'), jsx('button', {
          type: 'button', className: 'avatar',
          'aria-label': label(language(), 'avatarSignIn'),
        }, 'account')],
      });
    }

    function AccountPanel({ view, target }) {
      const seat = useRef(null);
      useEffect(() => {
        seat.current.appendChild(target);
        return () => { target.remove(); };
      }, [target]);
      useEffect(() => {
        if (view !== 'usage') return;
        const host = target;
        let frame;
        const reveal = () => {
          const balance = host.querySelector('[data-account-balance]');
          const usage = balance || host.querySelector('[data-account-usage]');
          if (!usage) return false;
          frame = window.requestAnimationFrame(() => usage.scrollIntoView({ block: 'nearest' }));
          return true;
        };
        const observer = new MutationObserver(() => { if (reveal()) observer.disconnect(); });
        if (!reveal()) observer.observe(host, { childList: true, subtree: true });
        return () => { observer.disconnect(); if (frame !== undefined) window.cancelAnimationFrame(frame); };
      }, [view, target]);
      return jsx('div', { ref: seat });
    }

    function Overlay({ useStore, actions }) {
      const panel = useStore(state => state.panel);
      const [lang, setLang] = useState(language);
      const [feedback, setFeedback] = useState(null);
      const feedbackSequence = useRef(0);
      const onFeedback = useRef(key => setFeedback({ key, sequence: ++feedbackSequence.current }));
      const [target] = useState(() => {
        const node = document.createElement('div');
        node.className = 'uptokey-harness-account-panel';
        return node;
      });
      const mounted = useRef(null);
      // One canonical state machine owns polling, queued rail requests and
      // cancellation. The closed presentation renders null into a detached root.
      // Showing Account moves that same root; it never replaces the instance.
      useEffect(() => {
        const dispose = account.mountPanel(target, {
          lang: language(), compact: true, headless: panel === null,
          view: panel || 'account', onFeedback: onFeedback.current,
        });
        mounted.current = dispose;
        return () => { mounted.current = null; dispose(); target.remove(); };
      }, [target]);
      useEffect(() => {
        mounted.current?.update({ headless: panel === null, view: panel || 'account', lang });
      }, [panel, lang]);
      const closePanel = () => {
        // Invalidate visible-only work before React commits the closed Modal.
        // Waiting for the effect would leave a native-open race after Escape.
        mounted.current?.update({ headless: true });
        actions.close();
      };
      useEffect(() => {
        const change = () => setLang(language());
        window.addEventListener('uptokey:locale', change);
        return () => window.removeEventListener('uptokey:locale', change);
      }, []);
      return [jsx(Modal, {
        open: panel !== null, onClose: closePanel,
        title: label(lang, 'title'), closeLabel: label(lang, 'cancel'),
        className: 'uptokey-harness-account-dialog',
        contentClassName: 'uptokey-harness-account-content',
        children: panel === null ? null : jsx(AccountPanel, { view: panel, target }),
      }, 'account'), feedback ? jsx(Toast, {
        text: label(lang, feedback.key),
        onDone: () => setFeedback(current => current?.sequence === feedback.sequence ? null : current),
      }, feedback.sequence) : null];
    }

    ctx.slots.inject('settings.launcher', () => ctx.slots.register({
      name: 'settings.launcher', store,
    }, Footer));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({
      name: 'shell.overlay', id: 'uptokey.account', store,
    }, Overlay));
  }
  window.UptokeyHarnessAccountUI = Object.freeze({ apply });
})();
