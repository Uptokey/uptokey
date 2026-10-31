// Original Models settings seats; destinations remain native-owned.
(function () {
  'use strict';
  const portals = Object.freeze({
    openai: 'openai', anthropic: 'anthropic', deepseek: 'deepseek',
    openrouter: 'openrouter', groq: 'groq', mistral: 'mistral',
    cerebras: 'cerebras', together: 'together', google: 'gemini',
  });
  function apply(ctx, require) {
    const desktop = window.UptokeyDesktop;
    if (typeof desktop?.openModelPage !== 'function' || typeof desktop?.openProviderPortal !== 'function') return;
    const { jsx } = require('react/jsx-runtime');
    const { useEffect, useRef, useState } = require('react');
    const { Toast } = require('@deepseek-ai/dsh-client-ui-primitives');
    const copy = () => document.documentElement.lang.startsWith('pt')
      ? { portal: 'Portal do provedor', local: 'Modelos locais', refresh: 'Atualizar modelos', failed: 'Não foi possível concluir' }
      : document.documentElement.lang.startsWith('zh')
        ? { portal: '提供商控制台', local: '本地模型', refresh: '刷新模型', failed: '无法完成' }
        : { portal: 'Provider portal', local: 'Local models', refresh: 'Refresh models', failed: 'Could not complete' };
    const buttonStyle = { background: 'none', border: 0, padding: 0, color: 'inherit', font: 'inherit', textDecoration: 'underline', cursor: 'pointer' };

    function PageButton({ label, open }) {
      const current = useRef({ live: true, pending: false });
      const [busy, setBusy] = useState(false), [failed, setFailed] = useState(false);
      useEffect(() => {
        const state = { live: true, pending: false };
        current.current = state;
        setBusy(false); setFailed(false);
        return () => { state.live = false; };
      }, [open]);
      const click = async () => {
        const state = current.current;
        if (!state.live || state.pending) return;
        state.pending = true; setBusy(true); setFailed(false);
        try { await open(); }
        catch { if (state.live) setFailed(true); }
        finally { if (state.live) { state.pending = false; setBusy(false); } }
      };
      return [jsx('button', { type: 'button', style: buttonStyle, disabled: busy, onClick: click, children: label }, 'button'),
        failed ? jsx(Toast, { text: copy().failed, onDone: () => setFailed(false) }, 'failure') : null];
    }

    // Callbacks stay stable across parent renders and never read keys/endpoints.
    const openers = new Map();
    const opener = (kind, value) => {
      const key = kind + ':' + value;
      if (!openers.has(key)) openers.set(key, () => kind === 'provider' ? desktop.openProviderPortal(value) : kind === 'refresh' ? desktop.refreshProviderModels(value) : desktop.openModelPage(value));
      return openers.get(key);
    };
    function Portal({ provider }) {
      if (!provider || provider.declared === true) return null;
      const id = provider.settingsNs === 'llm-deepseek' && provider.provider === 'deepseek-official'
        ? 'deepseek' : provider.settingsNs === 'llm-pi-ai' && Object.hasOwn(portals, provider.provider) ? portals[provider.provider] : null;
      if (!id) return null;
      const children = [jsx(PageButton, { label: copy().portal, open: opener('provider', id) }, 'portal')];
      if (typeof desktop.refreshProviderModels === 'function') children.push(jsx(PageButton, { label: copy().refresh, open: opener('refresh', id) }, 'refresh'));
      return jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px' }, children });
    }
    function LocalPages() {
      const lang = document.documentElement.lang.toLowerCase();
      const locale = ['en', 'pt-br', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-cn', 'ar'].includes(lang) ? lang : 'en';
      return jsx('div', { style: { display: 'flex', flexWrap: 'wrap', gap: '12px', fontSize: '12px' }, children: [
        [copy().local, 'https://docs.uptokey.com/' + locale + '/concepts/local-models/'],
        ['Ollama', 'https://ollama.com/download'], ['LM Studio', 'https://lmstudio.ai/download'], ['Jan', 'https://jan.ai/download'],
      ].map(([label, url]) => jsx(PageButton, { label, open: opener('model', url) }, url)) });
    }
    ctx.slots.inject('settings.models.provider-card', function* () {
      yield ctx.slots.register({ name: 'settings.models.provider-card', key: 'llm-pi-ai' }, Portal);
      yield ctx.slots.register({ name: 'settings.models.provider-card', key: 'llm-deepseek' }, Portal);
    });
    ctx.slots.inject('settings.models.footer', () => ctx.slots.register({ name: 'settings.models.footer', id: 'uptokey.model-pages' }, LocalPages));
  }
  window.UptokeyHarnessModelPages = Object.freeze({ apply });
})();
