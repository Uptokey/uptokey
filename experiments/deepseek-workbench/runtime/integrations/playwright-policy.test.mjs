import test from 'node:test';
import assert from 'node:assert/strict';
import { browserCallDenial, browserNetworkDenial, scopedBrowserTransport } from './playwright-policy.mjs';

test('isolated browser refuses filesystem, credentials, private networks and arbitrary server code', () => {
  for (const name of ['browser_run_code_unsafe', 'browser_file_upload', 'browser_install', 'browser_set_storage_state'])
    assert.match(browserCallDenial(name, {}), /outside/);
  for (const url of ['file:///etc/passwd', 'http://secret:key@example.org/', 'http://127.1/', 'http://[::1]/', 'http://10.0.0.1/', 'http://host.local/'])
    assert.ok(browserCallDenial('browser_navigate', { url }), url);
  assert.equal(browserCallDenial('browser_navigate', { url: 'https://example.org/' }), undefined);
  assert.ok(browserCallDenial('browser_take_screenshot', { filename: 'safe.png', _meta: { cwd: '/workspace' } }));
  assert.equal(browserCallDenial('browser_navigate', { url: 'http://127.0.0.1:4001/' }, { allowedOrigin: 'http://127.0.0.1:4001' }), undefined);
  for (const filename of ['../secret', '/etc/passwd', 'C:\\data', 'safe/../x', '..'])
    assert.ok(browserCallDenial('browser_take_screenshot', { filename }));
});

test('private addresses hidden behind DNS fail closed and DNS failures do not browse', async () => {
  for (const address of ['127.0.0.1', '192.168.1.1', '::ffff:127.0.0.1', 'fe80::1'])
    assert.ok(await browserNetworkDenial('https://public.example/', undefined, async () => [{ address }]));
  assert.ok(await browserNetworkDenial('https://public.example/', undefined, async () => { throw Error(); }));
  assert.equal(await browserNetworkDenial('https://public.example/', undefined, async () => [{ address: '93.184.216.34' }]), undefined);
});

test('transport filters list and direct calls, pins roots and passes cancellation untouched', async () => {
  const outbound = [], inbound = [];
  const inner = { start: async () => {}, close: async () => {}, send: async value => outbound.push(value) };
  const scoped = scopedBrowserTransport(inner, 'file:///temporary-browser');
  scoped.onmessage = value => inbound.push(value);
  await scoped.start();
  inner.onmessage({ jsonrpc: '2.0', id: 1, method: 'tools/list' });
  await scoped.send({ jsonrpc: '2.0', id: 1, result: { tools: [{ name: 'browser_snapshot' }, { name: 'browser_run_code_unsafe' }] } });
  assert.deepEqual(outbound[0].result.tools.map(t => t.name), ['browser_snapshot']);
  inner.onmessage({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'browser_run_code_unsafe', arguments: {} } });
  assert.equal(outbound[1].result.isError, true);
  assert.equal(inbound.length, 1);
  await scoped.send({ jsonrpc: '2.0', id: 'roots', method: 'roots/list' });
  inner.onmessage({ jsonrpc: '2.0', id: 'roots', result: { roots: [{ uri: 'file:///home/user' }] } });
  assert.equal(inbound[1].result.roots[0].uri, 'file:///temporary-browser');
  inner.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
  assert.equal(inbound[2].method, 'notifications/cancelled');
});

test('browser operations are serialized and cancellation withdraws queued work or closes the active session', async () => {
  const received = [], cancelled = [];
  const inner = { start: async () => {}, close: async () => {}, send: async () => {} };
  const scoped = scopedBrowserTransport(inner, 'file:///temporary-browser', { onCancel: () => cancelled.push(true) });
  scoped.onmessage = message => received.push(message);
  await scoped.start();
  const request = id => ({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: 'browser_snapshot', arguments: {} } });
  inner.onmessage(request(1)); inner.onmessage(request(2)); inner.onmessage(request(3));
  assert.deepEqual(received.map(message => message.id), [1]);
  inner.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 2 } });
  assert.equal(cancelled.length, 0);
  await scoped.send({ jsonrpc: '2.0', id: 1, result: { content: [] } });
  assert.deepEqual(received.filter(message => message.method === 'tools/call').map(message => message.id), [1, 3]);
  inner.onmessage({ jsonrpc: '2.0', method: 'notifications/cancelled', params: { requestId: 3 } });
  assert.equal(cancelled.length, 1);
});
