// Real Chromium + served CSP script + signed enrollment + core/vault fixture.
// No real vault, provider request or browser profile. Never print credentials.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { randomUUID } from 'node:crypto';

const require = createRequire(new URL('../../../quimera/uptokey/uptokey-pwa/package.json', import.meta.url));
const { chromium } = require('playwright');

test('local setup authenticates controls, reuses identity and cannot bypass tightened retention', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'uptokey-setup-browser-'));
  const envKeys = ['UPTOKEY_QUIMERA_DATA_DIR', 'UPTOKEY_CONVERSATIONS_DIR', 'UPTOKEY_AUTOMATIONS_DIR'];
  const previous = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  for (const key of envKeys) process.env[key] = join(directory, key);
  let app, server, browser;
  try {
    const [{ createApp, EXPECTED_HOST }, { defaultConfig }, { MemorySecretStore }, { Router }, { QuotaLedger }, { updateClientKey, loadClientPolicy }] = await Promise.all([
      import('../src/app.ts'), import('../src/config.ts'), import('../src/secret-store.ts'),
      import('../src/router.ts'), import('../src/quota-ledger.ts'), import('../src/client-keys.ts'),
    ]);
    const config = structuredClone(defaultConfig), secrets = new MemorySecretStore();
    const ledger = new QuotaLedger(); await ledger.initialize();
    app = createApp(config, new Router(config, new Map(), secrets, ledger), secrets, async () => ({ allowed: true }));
    await app.workspaceReady;
    const sessions = [], operations = [];
    server = createServer(async (req, res) => {
      try {
        const headers = new Headers();
        for (const [key, value] of Object.entries(req.headers)) if (value) headers.set(key, Array.isArray(value) ? value.join(',') : value);
        // Test transport only: random port maps onto canonical loopback gate.
        headers.set('host', EXPECTED_HOST); headers.set('origin', 'http://127.0.0.1:21435'); headers.delete('content-length');
        const body = []; for await (const part of req) body.push(part);
        const response = await app.fetch(new Request('http://' + EXPECTED_HOST + req.url, { method: req.method, headers, ...(body.length ? { body: Buffer.concat(body) } : {}) }));
        operations.push({ path: req.url, status: response.status, authenticated: headers.has('authorization') });
        if (req.url === '/local/workspace/session/complete' && response.ok) sessions.push((await response.clone().json()).clientId);
        res.writeHead(response.status, Object.fromEntries(response.headers));
        if (response.body) for await (const part of response.body) res.write(part);
        res.end();
      } catch { res.writeHead(500); res.end('fixture_failed'); }
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port;
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext();
    await context.route('**/*', route => route.request().url().startsWith(origin + '/') ? route.continue() : route.abort());
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/ui');
    assert.equal(sessions.length, 0, 'opening setup does not enroll silently');
    await page.locator('.connection-presets > summary').click();
    const canary = 'gsk_' + 'SETUP_SYNTHETIC_NOT_REAL_0123456789';
    await page.locator('[data-key="groq"]').fill(canary);
    const saved = page.waitForResponse(r => r.url().endsWith('/local/provider/save'), { timeout: 18000 });
    await page.locator('form[data-provider="groq"] button[type="submit"]').click();
    let savedResponse;
    try { savedResponse = await saved; }
    catch { throw new Error(JSON.stringify({ operations, errors, message: await page.locator('[data-msg="groq"]').textContent() })); }
    assert.equal(savedResponse.status(), 200);
    assert.equal((await secrets.get('provider:groq')) === canary, true);
    assert.equal(sessions.length, 1);
    const clientId = sessions[0];
    await page.locator('#integration-client-name').fill('Synthetic IDE');
    const issued = page.waitForResponse(r => r.url().endsWith('/local/client-keys') && r.request().method() === 'POST');
    await page.locator('#provision-client-btn').click();
    assert.equal((await issued).status(), 201);
    await page.waitForFunction(() => document.getElementById('integration-client-token').value.startsWith('utk_local_'));
    assert.equal(operations.some(r => r.path === '/local/client/provision'), false);
    assert.equal(operations.filter(r => ['/local/provider/save', '/local/client-keys'].includes(r.path)).every(r => r.authenticated), true);
    assert.deepEqual(await page.evaluate(() => [localStorage.length, sessionStorage.length]), [0, 0]);
    const keyProperties = await page.evaluate(async () => {
      const key = await browserIdentity();
      return { extractable: key.privateKey.extractable, curve: key.privateKey.algorithm.namedCurve, privateJwk: Object.hasOwn(key.publicJwk, 'd') };
    });
    assert.deepEqual(keyProperties, { extractable: false, curve: 'P-256', privateJwk: false });
    await page.reload();
    const listed = page.waitForResponse(r => r.url().includes('/local/client-keys?'));
    await page.locator('#refresh-client-keys-btn').click();
    assert.equal((await listed).status(), 200);
    assert.deepEqual(sessions, [clientId, clientId], 'reload signs with the same identity');
    const policy = await loadClientPolicy(secrets, clientId);
    await updateClientKey(secrets, clientId, { expectedRevision: policy.policy.revision, operationId: randomUUID(), retentionMode: 'ephemeral' });
    await page.reload();
    const denied = page.waitForResponse(r => r.url().includes('/local/client-keys?'));
    await page.locator('#refresh-client-keys-btn').click();
    assert.equal((await denied).status(), 401);
    assert.deepEqual(sessions, [clientId, clientId, clientId]);
    assert.equal((await loadClientPolicy(secrets, clientId)).policy.retentionMode, 'ephemeral');
    assert.equal((await secrets.get('provider:groq')) === canary, true);
    assert.deepEqual(errors, []);
    await context.close();
  } finally {
    await browser?.close();
    if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
    await app?.closeWorkspace();
    for (const [key, value] of Object.entries(previous)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
  }
});
