import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import assert from 'node:assert/strict';

const script = readFileSync(new URL('./local_connections.js', import.meta.url), 'utf8');
function fixture(handler = async () => ({ core: 'unknown', ollama: 'unknown', checked: false }), origin = 'http://127.0.0.1:43180', lang = '', documentStart = false) {
  class Node {
    constructor() { this.events = {}; this.attrs = {}; this.dataset = {}; this.textContent = ''; }
    addEventListener(name, callback) { this.events[name] = callback; }
    setAttribute(name, value) { this.attrs[name] = value; }
    getAttribute(name) { return this.attrs[name] ?? null; }
    prepend(child) { child.parentNode = this; this.child = child; this.prependCount = (this.prependCount || 0) + 1; }
    showModal() { this.open = true; }
    close() { this.open = false; }
    attachShadow() { return shadow; }
  }
  const selectors = ['dialog', '[data-reconnect]', '[data-close]', '.control', '[data-core]', '[data-ollama]', '.dot', '[data-observed]', '.message', '.name', '#local-title', '#local-scope', '[data-core-label]', '[data-ollama-label]'];
  const nodes = Object.fromEntries(selectors.map(selector => [selector, new Node()]));
  const shadow = { querySelector: selector => nodes[selector] };
  const footer = new Node(); footer.setAttribute('data-wide', 'true');
  const calls = [], events = {}, documentEvents = {};
  let host, mutation;
  const window = { __TAURI_INTERNALS__: { invoke: async (command, args) => { calls.push([command, args]); return handler(args); } }, addEventListener: (name, callback) => { events[name] = callback; } };
  const document = { documentElement: documentStart ? null : { lang }, readyState: documentStart ? 'loading' : 'complete', body: documentStart ? null : new Node(), addEventListener: (name, callback) => { documentEvents[name] = callback; }, createElement: () => (host = new Node()), querySelector: selector => selector === '.uptokey-harness-account-footer' ? footer : null };
  runInNewContext(script, { window, document, location: { origin, pathname: '/' }, MutationObserver: class { constructor(callback) { mutation = callback; } observe() {} disconnect() {} } });
  return { nodes, calls, events, footer, host, mutate: () => mutation(), domReady: lang => { document.documentElement = { lang }; document.body = new Node(); document.readyState = 'interactive'; documentEvents.DOMContentLoaded(); }, locale: lang => { document.documentElement.lang = lang; events['uptokey:locale'](); }, flush: () => new Promise(resolve => setImmediate(resolve)) };
}

test('initial mount reads only native memory; opening and closing never reconnects', async () => {
  const f = fixture(); await f.flush();
  assert.equal(f.footer.child, f.host);
  assert.deepEqual(f.calls.map(([command, args]) => [command, args.reconnect]), [['harness_local_connections', false]]);
  assert.equal(f.nodes['[data-core]'].textContent, 'Not checked');
  f.nodes['.control'].events.click(); assert.equal(f.nodes.dialog.open, true);
  f.nodes['[data-close]'].events.click(); assert.equal(f.nodes.dialog.open, false);
  assert.equal(f.calls.length, 1);
  f.mutate(); f.mutate(); assert.equal(f.calls.length, 1);
});

test('document-start without documentElement waits for DOM ready and mounts once in its selected language', async () => {
  const f = fixture(undefined, undefined, '', true);
  assert.equal(f.calls.length, 0);
  assert.equal(f.footer.child, undefined);
  f.domReady('es'); await f.flush();
  assert.equal(f.host.getAttribute('lang'), 'es');
  assert.equal(f.nodes['.name'].textContent, 'Conexiones locales');
  assert.equal(f.footer.child, f.host);
  assert.equal(f.footer.prependCount, 1);
  assert.deepEqual(f.calls.map(([command, args]) => [command, args.reconnect]), [['harness_local_connections', false]]);
  f.mutate(); f.mutate();
  assert.equal(f.footer.prependCount, 1);
  assert.equal(f.calls.length, 1);
});

test('core remains visibly connected when optional Ollama fails', async () => {
  const f = fixture(async ({ reconnect }) => reconnect
    ? { core: 'connected', ollama: 'unavailable', checked: true, token: 'private-never-render' }
    : { core: 'unknown', ollama: 'unknown', checked: false });
  await f.flush(); await f.nodes['[data-reconnect]'].events.click();
  assert.equal(f.nodes['[data-core]'].textContent, 'Connected');
  assert.equal(f.nodes['[data-ollama]'].textContent, 'Unavailable');
  assert.equal(f.nodes['.dot'].dataset.state, 'connected');
  assert.match(f.nodes['[data-observed]'].textContent, /Last attempt/);
  assert.ok(Object.values(f.nodes).every(node => !node.textContent.includes('private-never-render')));
});

test('one explicit attempt at a time; busy error preserves last observation', async () => {
  let finish;
  const f = fixture(({ reconnect }) => reconnect ? new Promise((_resolve, reject) => { finish = reject; }) : { core: 'connected', ollama: 'unknown', checked: true });
  await f.flush();
  const first = f.nodes['[data-reconnect]'].events.click();
  await f.nodes['[data-reconnect]'].events.click();
  assert.equal(f.calls.length, 2);
  assert.equal(f.nodes['[data-reconnect]'].disabled, true);
  finish('local_connections_busy'); await first;
  assert.equal(f.nodes['[data-reconnect]'].disabled, false);
  assert.equal(f.nodes['[data-core]'].textContent, 'Connected');
  assert.match(f.nodes['.message'].textContent, /Another local action/);
});

test('failed reconnect and malformed response cannot leave a ready badge', async () => {
  const f = fixture(async ({ reconnect }) => { if (reconnect) throw Error('secret details'); return { core: 'connected', ollama: 'connected', checked: true }; });
  await f.flush(); await f.nodes['[data-reconnect]'].events.click();
  assert.equal(f.nodes['[data-core]'].textContent, 'Not checked');
  assert.ok(!f.nodes['.message'].textContent.includes('secret'));
  const malformed = fixture(async () => ({ core: 'ready', ollama: 'connected', checked: true }));
  await malformed.flush(); assert.equal(malformed.nodes['[data-core]'].textContent, 'Not checked');
});

test('menu event reads shared native projection without reconnect or polling', async () => {
  const f = fixture(); await f.flush();
  f.events['uptokey:local-connections'](); await f.flush();
  assert.equal(f.calls.length, 2);
  assert.ok(f.calls.every(([, args]) => args.reconnect === false));
  f.footer.setAttribute('data-wide', 'false'); f.mutate();
  assert.equal(f.host.getAttribute('data-wide'), 'false');
  assert.equal(f.calls.length, 2);
});

test('remote pages do not receive the native control', async () => {
  const f = fixture(undefined, 'https://app.uptokey.com');
  await f.flush(); assert.equal(f.host, undefined); assert.equal(f.calls.length, 0);
});

test('delayed initial memory read cannot replace a newer explicit result', async () => {
  let release;
  const f = fixture(({ reconnect }) => reconnect ? { core: 'connected', ollama: 'unavailable', checked: true }
    : new Promise(resolve => { release = resolve; }));
  await f.nodes['[data-reconnect]'].events.click();
  release({ core: 'unknown', ollama: 'unknown', checked: false });
  await f.flush(); assert.equal(f.nodes['[data-core]'].textContent, 'Connected');
});

test('known lifecycle event clears the badge and dominates late reconnect response', async () => {
  let finish;
  const f = fixture(({ reconnect }) => reconnect ? new Promise(resolve => { finish = resolve; })
    : { core: 'unknown', ollama: 'unknown', checked: false });
  await f.flush();
  const attempt = f.nodes['[data-reconnect]'].events.click();
  f.events['uptokey:local-connections'](); await f.flush();
  finish({ core: 'connected', ollama: 'connected', checked: true }); await attempt;
  assert.equal(f.nodes['[data-core]'].textContent, 'Not checked');
});

test('English is the default for every label, accessible name and explanatory text', async () => {
  const f = fixture(); await f.flush();
  assert.equal(f.host.getAttribute('lang'), 'en');
  assert.equal(f.host.getAttribute('dir'), 'ltr');
  assert.equal(f.nodes['.name'].textContent, 'Local connections');
  assert.equal(f.nodes['#local-title'].textContent, 'Local connections');
  assert.equal(f.nodes['.control'].getAttribute('title'), 'Local connections');
  assert.equal(f.nodes['.control'].getAttribute('aria-label'), 'Local connections: Core / local proxy — Not checked');
  assert.equal(f.nodes['[data-close]'].textContent, 'Close');
  assert.equal(f.nodes['[data-reconnect]'].textContent, 'Reconnect');
  assert.equal(f.nodes['[data-ollama-label]'].textContent, 'Ollama (optional)');
  assert.match(f.nodes['#local-scope'].textContent, /Computer pairing/);
  assert.match(f.nodes['[data-observed]'].textContent, /No connection check/);
});

test('Portuguese and Spanish locale changes translate the entire control without IPC', async () => {
  const f = fixture(async () => ({ core: 'connected', ollama: 'unavailable', checked: true }));
  await f.flush(); const calls = f.calls.length;
  f.locale('pt-BR');
  assert.equal(f.nodes['#local-title'].textContent, 'Conexões locais');
  assert.equal(f.nodes['.control'].getAttribute('title'), 'Conexões locais');
  assert.match(f.nodes['.control'].getAttribute('aria-label'), /Conectado/);
  assert.equal(f.nodes['[data-ollama]'].textContent, 'Indisponível');
  assert.equal(f.nodes['[data-close]'].textContent, 'Fechar');
  assert.match(f.nodes['#local-scope'].textContent, /pareamento/);
  assert.match(f.nodes['[data-observed]'].textContent, /última tentativa/);
  f.locale('es');
  assert.equal(f.nodes['.name'].textContent, 'Conexiones locales');
  assert.equal(f.nodes['#local-title'].textContent, 'Conexiones locales');
  assert.equal(f.nodes['[data-close]'].textContent, 'Cerrar');
  assert.equal(f.nodes['[data-ollama]'].textContent, 'No disponible');
  assert.match(f.nodes['#local-scope'].textContent, /permisos de contexto/);
  assert.match(f.nodes['[data-observed]'].textContent, /último intento/);
  assert.equal(f.calls.length, calls);
});

test('changing language translates pending and failure states without another attempt', async () => {
  let finish;
  const f = fixture(({ reconnect }) => reconnect ? new Promise((_resolve, reject) => { finish = reject; }) : { core: 'unknown', ollama: 'unknown', checked: false });
  await f.flush(); const attempt = f.nodes['[data-reconnect]'].events.click();
  f.locale('pt-BR'); assert.equal(f.nodes['[data-reconnect]'].textContent, 'Reconectando…');
  finish('local_connections_busy'); await attempt;
  assert.match(f.nodes['.message'].textContent, /Outra ação local/);
  const calls = f.calls.length;
  f.locale('es'); assert.match(f.nodes['.message'].textContent, /otra acción local/);
  assert.equal(f.calls.length, calls);
  const failed = fixture(async ({ reconnect }) => { if (reconnect) throw Error('private'); return { core: 'unknown', ollama: 'unknown', checked: false }; });
  await failed.flush(); await failed.nodes['[data-reconnect]'].events.click();
  failed.locale('pt-BR'); assert.match(failed.nodes['.message'].textContent, /Não foi possível/);
  failed.locale('es'); assert.match(failed.nodes['.message'].textContent, /No se pudieron/);
  assert.equal(failed.calls.length, 2);
});

test('all ten account locales have full text; Arabic switches direction and fallback restores English', async () => {
  const f = fixture(); await f.flush(); const calls = f.calls.length;
  for (const lang of ['en', 'pt-BR', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar']) {
    f.locale(lang);
    assert.equal(f.host.getAttribute('lang'), lang);
    for (const selector of ['.name', '#local-title', '#local-scope', '[data-core-label]', '[data-ollama-label]', '[data-core]', '[data-ollama]', '[data-reconnect]', '[data-close]', '[data-observed]']) {
      assert.ok(f.nodes[selector].textContent.length > 0, `${lang}: ${selector}`);
      assert.notEqual(f.nodes[selector].textContent, undefined);
    }
    assert.ok(f.nodes['.control'].getAttribute('aria-label').includes(f.nodes['[data-core]'].textContent));
  }
  assert.equal(f.host.getAttribute('dir'), 'rtl');
  assert.equal(f.nodes['#local-title'].textContent, 'الاتصالات المحلية');
  f.locale('unknown');
  assert.equal(f.host.getAttribute('dir'), 'ltr');
  assert.equal(f.host.getAttribute('lang'), 'en');
  assert.equal(f.nodes['#local-title'].textContent, 'Local connections');
  assert.equal(f.calls.length, calls);
});
