import './isolated-gateway-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { serve } from '@hono/node-server';
import { setTimeout as delay } from 'node:timers/promises';
import { TuiClient, type TuiAccountAvailable } from '../src/tui/client.ts';
import { TuiAccount } from '../src/tui/account.ts';
import { accountPlanPresentation, accountViewSummary, loadAccountPlanForView, readAccountPlan, type AccountPlan } from '../src/tui/account-plan.ts';
import { accountText } from '../src/tui/account-ui.ts';
import { setLang, type Lang } from '../src/tui/i18n.ts';
import { accountSummary, runLinearAccount } from '../src/tui/frontend/uptokey/linear-account.ts';
import type { AccountPublicSession } from '../src/account-login-protocol.ts';
import { createApp, ensureLocalToken, EXPECTED_HOST } from '../src/app.ts';
import { MemorySecretStore } from '../src/secret-store.ts';
import { defaultConfig } from '../src/config.ts';
import { memoryConnectionStorage } from '../src/connection-profiles.ts';
import { BrowserSessionService } from '../src/workspace/browser-session.ts';

const now = Date.parse('2026-10-18T12:00:00.000Z');
const nativeRef = 'acc_' + 'a'.repeat(64);
const connected: AccountPublicSession = { configured: true, authenticated: true, loginAvailable: true, state: 'connected', profile: { displayName: 'Fixture', plan: 'free' } };
const signedOut: AccountPublicSession = { configured: true, authenticated: false, loginAvailable: true, state: 'signed_out' };
function payload(status: AccountPlan['subscription']['status'] = 'active'): AccountPlan {
  return { accountRef: 'account_' + 'b'.repeat(64), subscription: { status, cancelAtPeriodEnd: false, currentPeriodEnd: '2026-11-01T00:00:00.000Z' }, allowance: { limitMicros: 3_000_000, usedMicros: 500_000, reservedMicros: 250_000, periodStart: '2026-10-01T00:00:00.000Z', periodEnd: '2026-11-01T00:00:00.000Z' } };
}
function fixture() {
  const calls: string[] = [];
  let session = connected;
  let available: TuiAccountAvailable = { revision: 1, currentAccountRef: nativeRef, currentOwned: false, accounts: [] };
  let answer: () => Promise<AccountPlan> = async () => payload();
  const client: ConstructorParameters<typeof TuiAccount>[0] = {
    getAccountSession: async () => { calls.push('status'); return session; },
    getAvailableAccounts: async () => { calls.push('available'); return { ...available }; },
    getAccountRequests: async () => [],
    getAccountPlan: async () => { calls.push('subscription.status'); return answer(); },
    getAccountUsage: async () => { calls.push('usage'); return { state: 'unavailable', verifiedAt: new Date(now).toISOString() }; },
    signOutAccount: async () => { session = signedOut; available = { ...available, revision: available.revision + 1, currentAccountRef: null, currentOwned: null }; return session; },
    adoptAccount: async () => { throw Error('unused'); }, unlinkAccount: async () => { throw Error('unused'); }, startAccountLogin: async () => { throw Error('unused'); },
    requestAccountAccess: async () => { throw Error('unused'); }, consumeAccountAccess: async () => { throw Error('unused'); }, approveAccountRequest: async () => { throw Error('unused'); },
  };
  const account = new TuiAccount(client);
  return { account, client, calls, answer: (value: () => Promise<AccountPlan>) => { answer = value; }, switchIdentity: (ref = nativeRef, revision = available.revision + 1) => { available = { ...available, currentAccountRef: ref, revision }; } };
}

test('public plan parser bounds status, dates and allowance, stripping unrelated billing/private fields', () => {
  const row = payload();
  assert.deepEqual(readAccountPlan({ ...row, offer: { amountMinor: 500 }, privateToken: 'not-projected' }), row);
  for (const bad of [null, {}, { ...row, accountRef: nativeRef }, { ...row, subscription: { ...row.subscription, status: 'trialing' } }, { ...row, subscription: { ...row.subscription, currentPeriodEnd: '2026-11-01' } }, { ...row, subscription: { ...row.subscription, cancelAtPeriodEnd: 'false' } }, { ...row, allowance: undefined }, { ...row, allowance: { ...row.allowance, usedMicros: -1 } }, { ...row, allowance: { ...row.allowance, limitMicros: 1e13 } }, { ...row, allowance: { ...row.allowance, reservedMicros: 0.1 } }, { ...row, allowance: { ...row.allowance, periodStart: '2026-12-01T00:00:00.000Z' } }]) assert.throws(() => readAccountPlan(bad), /account_response_invalid/);
});

test('Free and Plus are subscription observations, with no entitlement inferred from legacy profile.plan', () => {
  setLang('en'); const f = fixture();
  f.account.view.session = { ...connected, profile: { plan: 'unknown-new-legacy-value' } };
  assert.equal(accountViewSummary(f.account.view), 'Connected · Plan unavailable');
  f.account.view.plan = { state: 'observed', value: payload() };
  assert.equal(accountSummary(f.account), 'Connected · Plus');
  f.account.view.plan = { state: 'observed', value: payload('none') };
  assert.equal(accountSummary(f.account), 'Connected · Free');
  f.account.dispose();
});

test('monthly allowance is server observed, period bounded and clamped, separate from aggregate credits', () => {
  const plan = payload();
  assert.deepEqual(accountPlanPresentation({ state: 'observed', value: plan }, 'en', now), { label: 'Plus', details: ['Monthly AI allowance: $2.25 remaining of $3.00', 'Period through 11/1/2026'] });
  plan.allowance!.usedMicros = 4_000_000;
  assert.match(accountPlanPresentation({ state: 'observed', value: plan }, 'en', now).details[0]!, /\$0\.00 remaining of \$3\.00/);
  for (const status of ['none', 'canceled', 'past_due', 'paused'] as const) assert.ok(!accountPlanPresentation({ state: 'observed', value: payload(status) }, 'en', now).details.some(line => line.includes('Monthly AI')));
  for (const time of [Date.parse('2026-09-01T00:00:00.000Z'), Date.parse('2026-11-02T00:00:00.000Z')]) assert.ok(!accountPlanPresentation({ state: 'observed', value: payload() }, 'en', time).details.some(line => line.includes('Monthly AI')));
  const missing = payload(); missing.allowance = null;
  assert.ok(!accountPlanPresentation({ state: 'observed', value: missing }, 'en', now).details.some(line => line.includes('Monthly AI')));
  assert.equal(accountText('usage', {}, 'en'), 'Uptokey credits');
});

test('all ten locales distinguish plan state, status, monthly limits and local/BYOK costs; English is explicit', () => {
  const langs: Lang[] = ['pt-BR', 'en', 'es', 'fr', 'de', 'it', 'ja', 'ko', 'zh-CN', 'ar'];
  for (const lang of langs) {
    const active = accountPlanPresentation({ state: 'observed', value: payload() }, lang, now);
    assert.equal(active.label, 'Plus'); assert.equal(active.details.length, 2);
    assert.ok(active.details.every(line => !/[{}]/.test(line)));
    assert.equal(accountPlanPresentation({ state: 'observed', value: payload('none') }, lang, now).label, 'Free');
    assert.deepEqual(accountPlanPresentation({ state: 'observed', value: payload('none') }, lang, now).details, [accountText('free_hosted', {}, lang)]);
    for (const status of ['paused', 'past_due', 'canceled'] as const) assert.ok(accountPlanPresentation({ state: 'observed', value: payload(status) }, lang, now).label.includes(accountText(status, {}, lang)));
    assert.ok(accountText('local_byok_free', {}, lang).includes('BYOK'));
    assert.ok(accountPlanPresentation({ state: 'unavailable' }, lang).label.length > 0);
    assert.ok(accountPlanPresentation({ state: 'loading' }, lang).label.length > 0);
  }
  assert.equal(accountPlanPresentation({ state: 'observed', value: payload('paused') }, 'en', now).label, 'Plus · Paused');
  const ending = payload(); ending.subscription.cancelAtPeriodEnd = true;
  assert.equal(accountPlanPresentation({ state: 'observed', value: ending }, 'en', now).details[1], 'Subscription ends 11/1/2026');
});

test('startup refresh never reads a plan; explicit read coalesces and does not block account state', async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  await f.account.refresh(); assert.deepEqual(f.calls, ['status', 'available']);
  let resolve!: (value: AccountPlan) => void; f.answer(() => new Promise(done => { resolve = done; }));
  const first = f.account.loadPlan(), second = f.account.loadPlan(); assert.equal(first, second);
  await delay(0); assert.equal(f.account.view.busy, false); assert.equal(f.account.view.plan.state, 'loading');
  resolve(payload()); await first;
  assert.equal(f.account.view.plan.state, 'observed'); assert.equal(f.calls.filter(call => call === 'subscription.status').length, 1);
});

test('rechecking a confirmed plan keeps it visible while pending but never hides a failed recheck', async t => {
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh(); await f.account.loadPlan();
  const confirmed = f.account.view.plan; let reject!: (error: Error) => void;
  f.answer(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = f.account.loadPlan(); await delay(0);
  assert.equal(f.account.view.plan, confirmed); assert.equal(f.account.view.planLoading, true);
  assert.equal(accountPlanPresentation(f.account.view.plan, 'en', now).label, 'Plus');
  reject(Error('account_service_unavailable')); await pending;
  assert.equal(f.account.view.plan.state, 'unavailable'); assert.equal(f.account.view.planLoading, false);
  assert.equal(accountPlanPresentation(f.account.view.plan, 'en', now).label, 'Plan unavailable');
});

test('terminal plan denial invalidates account authority and discards queued credits', async t => {
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh();
  let reject!: (error: Error) => void; f.answer(() => new Promise((_resolve, fail) => { reject = fail; }));
  const pending = f.account.loadPlan(); await delay(0); const credits = f.account.loadUsage();
  reject(Object.assign(Error('account_service_unavailable'), { status: 403 })); await Promise.all([pending, credits]);
  assert.equal(f.account.view.session, null); assert.equal(f.account.view.available, null);
  assert.equal(f.account.view.plan.state, 'unknown'); assert.equal(f.account.view.planLoading, false);
  assert.equal(f.account.view.usage, null); assert.equal(f.account.view.usageLoading, false);
  assert.equal(f.calls.includes('usage'), false);
});

test('closing the account view during refresh prevents a late plan query', async () => {
  let resolve!: () => void, reads = 0;
  const lifetime = new AbortController();
  const account = { refresh: () => new Promise<void>(done => { resolve = done; }), loadPlan: async () => { reads++; } };
  const pending = loadAccountPlanForView(account, lifetime.signal);
  lifetime.abort(); resolve(); await pending; assert.equal(reads, 0);
  const open = loadAccountPlanForView(account, new AbortController().signal);
  resolve(); await open; assert.equal(reads, 1);
});

test('late plan answers are rejected when identity OR revision changes remotely', async t => {
  for (const change of ['identity', 'revision'] as const) {
    const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh();
    let resolve!: (value: AccountPlan) => void; f.answer(() => new Promise(done => { resolve = done; }));
    const pending = f.account.loadPlan(); await delay(0);
    f.switchIdentity(change === 'identity' ? 'acc_' + 'c'.repeat(64) : nativeRef, change === 'identity' ? 1 : 2);
    resolve(payload()); await pending;
    assert.notEqual(f.account.view.plan.state, 'observed', change); assert.equal(f.account.view.error, null);
  }
});

test('logout/disposal/cancel discard pending plan; plan errors stay nonblocking and never fall back to Free', async t => {
  for (const action of ['logout', 'dispose', 'cancel'] as const) {
    const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh();
    let resolve!: (value: AccountPlan) => void; f.answer(() => new Promise(done => { resolve = done; }));
    const pending = f.account.loadPlan(); await delay(0);
    if (action === 'logout') await f.account.logout(); else if (action === 'dispose') f.account.dispose(); else f.account.cancelPlanRead();
    resolve(payload()); await pending; assert.notEqual(f.account.view.plan.state, 'observed', action);
  }
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh();
  f.answer(async () => { throw Error('secret-upstream-error'); }); await f.account.loadPlan();
  assert.equal(f.account.view.plan.state, 'unavailable'); assert.equal(f.account.view.error, null); assert.equal(f.account.view.busy, false);
  assert.match(accountSummary(f.account), /Plan unavailable/); assert.ok(!accountSummary(f.account).includes('Free'));
});

test('linear account uses the shared observed plan and monthly allowance, with no catalog/inference/checkout', async t => {
  setLang('en'); const f = fixture(); t.after(() => f.account.dispose());
  const output: string[] = [];
  await runLinearAccount(f.account, { say: text => { output.push(text); }, choose: async () => undefined });
  assert.ok(output.some(line => line.includes('Fixture · Plus')));
  assert.ok(output.includes(accountText('local_byok_free')));
  assert.deepEqual(f.calls, ['status', 'available', 'available', 'subscription.status', 'available']);
});

test('loopback client requests only readonly subscription.status and rejects malformed/unavailable responses', async t => {
  const requests: Array<{ path: string; method: string; body: unknown; auth: string }> = [];
  let response: unknown = { ...payload(), offer: null, privateField: 'strip' }, status = 200;
  const server = createServer((request, reply) => {
    let body = ''; request.on('data', chunk => { body += chunk; }); request.on('end', () => {
      requests.push({ path: request.url!, method: request.method!, body: JSON.parse(body), auth: String(request.headers.authorization) });
      reply.statusCode = status; reply.setHeader('content-type', 'application/json'); reply.end(JSON.stringify(response));
    });
  }); server.listen(0, '127.0.0.1'); await once(server, 'listening'); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: 'synthetic' }); t.after(() => client.destroy());
  assert.deepEqual(await client.getAccountPlan(), payload());
  status = 503; response = { error: { type: 'account_service_unavailable' } }; await assert.rejects(client.getAccountPlan(), /account_service_unavailable/);
  status = 200; response = { subscription: { status: 'active' } }; await assert.rejects(client.getAccountPlan(), /account_response_invalid/);
  assert.equal(requests.length, 3);
  for (const row of requests) assert.deepEqual(row, { path: '/local/account/control', method: 'POST', auth: 'Bearer synthetic', body: { operation: 'subscription.status', payload: {} } });
});

test('TuiClient consumes the actual App control route that unwraps broker status/body, including HTTP failure', async t => {
  const previous = process.env.UPTOKEY_ACCOUNT_SERVICE_ORIGIN;
  process.env.UPTOKEY_ACCOUNT_SERVICE_ORIGIN = 'http://localhost:3000';
  t.after(() => { if (previous === undefined) delete process.env.UPTOKEY_ACCOUNT_SERVICE_ORIGIN; else process.env.UPTOKEY_ACCOUNT_SERVICE_ORIGIN = previous; });
  let status = 200, value = payload('none');
  const controlRequests: unknown[] = [], id = randomUUID(), secrets = new MemorySecretStore();
  await ensureLocalToken(secrets);
  const params: Parameters<typeof createApp> = [structuredClone(defaultConfig), { connectionMetrics: () => ({ providers: [] }), invalidateProviderCache: async () => {}, dispatch: async () => { throw Error('inference_forbidden'); } } as never, secrets, async () => ({ allowed: true })];
  params[26] = { profiles: memoryConnectionStorage(), fetchImpl: async (input, init) => {
    const action = String(input).split('/').at(-1), proof = JSON.parse(String(init?.body));
    if (action === 'challenge') return Response.json({ id, expiresAt: Date.now() + 60_000 });
    if (action === 'poll' || action === 'status') return Response.json({ ...connected, expiresAt: Date.now() + 600_000 });
    assert.equal(action, 'control'); controlRequests.push(proof.request);
    return Response.json({ status, body: status === 200 ? value : { error: { type: 'account_service_unavailable' } } });
  } };
  const app = createApp(...params); t.after(() => app.closeWorkspace()); await app.workspaceReady;
  const service = new BrowserSessionService(secrets), pair = generateKeyPairSync('ec', { namedCurve: 'prime256v1' }), challenge = service.challenge(pair.publicKey.export({ format: 'jwk' }));
  const session = await service.complete(challenge.challengeId, sign('sha256', Buffer.from(challenge.nonce), { key: pair.privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url'));
  // Only the test listener remaps Host; the real App route, authentication, account service and HTTP body are intact.
  const server = serve({ port: 0, hostname: '127.0.0.1', fetch: request => { const headers = new Headers(request.headers); headers.set('host', EXPECTED_HOST); return app.fetch(new Request(request, { headers })); } });
  await once(server, 'listening'); t.after(() => { if ('closeAllConnections' in server) server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: session.token }); t.after(() => client.destroy());
  await client.startAccountLogin(); assert.equal((await client.getAccountSession()).authenticated, true);
  assert.deepEqual(await client.getAccountPlan(), value);
  value = payload('active'); assert.deepEqual(await client.getAccountPlan(), value);
  status = 503; await assert.rejects(client.getAccountPlan(), /account_service_unavailable/);
  assert.deepEqual(controlRequests, Array.from({ length: 3 }, () => ({ operation: 'subscription.status', payload: {} })));
});
