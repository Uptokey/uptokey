import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { EventEmitter, once } from "node:events";
import type { ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { TuiClient, type TuiAccountAvailable, type TuiAccountRequest } from "../src/tui/client.ts";
import { ACCOUNT_POLL_INTERVAL_MS, TuiAccount, openAccountLoginUrl } from "../src/tui/account.ts";
import { ACCOUNT_TEXT, accountText } from "../src/tui/account-ui.ts";
import { setLang, type Lang } from "../src/tui/i18n.ts";
import { resolveSlash } from "../src/tui/commands.ts";
import { runLinearAccount } from "../src/tui/frontend/uptokey/linear-account.ts";
import type { AccountPublicSession } from "../src/account-login-protocol.ts";

const signedOut: AccountPublicSession = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" };
const connected: AccountPublicSession = { configured: true, authenticated: true, loginAvailable: true, state: "connected", profile: { displayName: "Fixture", plan: "free" } };
const ref = "acc_" + "a".repeat(64);
const noAccounts = (): TuiAccountAvailable => ({ revision: 0, currentAccountRef: null, currentOwned: null, accounts: [] });

function fixture(options: { intervalMs?: number; now?: () => number } = {}) {
  const calls: string[] = [], writes: unknown[] = [];
  let session = signedOut, available = noAccounts(), approved = false, requests: TuiAccountRequest[] = [];
  const client = {
    getAccountSession: async (_signal?: AbortSignal) => { calls.push("status"); return session; },
    getAvailableAccounts: async () => { calls.push("available"); return available; },
    getAccountRequests: async () => { calls.push("requests"); return requests; },
    requestAccountAccess: async () => { calls.push("request"); return { id: randomUUID(), userCode: "1234ABCD", expiresAt: new Date((options.now?.() ?? Date.now()) + 60_000).toISOString() }; },
    consumeAccountAccess: async () => { calls.push("consume"); if (!approved) throw Error("account_share_pending"); available = { ...available, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: connected }] }; },
    approveAccountRequest: async (id: string, userCode: string, accountRef: string) => { calls.push("approve"); writes.push({ id, userCode, accountRef }); requests = []; },
    adoptAccount: async (accountRef: string, expectedRevision: number) => { calls.push("adopt"); writes.push({ accountRef, expectedRevision }); session = connected; available = { ...available, revision: available.revision + 1, currentAccountRef: accountRef, currentOwned: false }; return { revision: available.revision, session }; },
    unlinkAccount: async (expectedRevision: number) => { calls.push("unlink"); writes.push({ expectedRevision }); session = signedOut; available = { ...available, revision: available.revision + 1, currentAccountRef: null, currentOwned: null }; return { revision: available.revision, session }; },
    startAccountLogin: async () => { calls.push("login"); return { loginUrl: `http://localhost:3000/api/account/native/authorize?id=${randomUUID()}`, userCode: "A1B2C3D4", expiresAt: (options.now?.() ?? Date.now()) + 60_000 }; },
    signOutAccount: async () => { calls.push("logout"); session = signedOut; return session; },
    getAccountUsage: async () => { calls.push("usage"); return { state: "observed" as const, verifiedAt: new Date().toISOString(), currency: "USD" as const, unit: "micro_usd" as const, availableMicros: 2_000_000, reservedMicros: 0, spentMicros: 0 }; },
  };
  const account = new TuiAccount(client, { intervalMs: options.intervalMs ?? 5, now: options.now });
  return { client, account, calls, writes, approve: () => { approved = true; }, state: (next: AccountPublicSession, items = noAccounts(), pending: TuiAccountRequest[] = []) => { session = next; available = items; requests = pending; } };
}
async function waitUntil(condition: () => boolean) { for (let n = 0; n < 100; n++) { if (condition()) return; await delay(10); } assert.fail("account operation did not settle"); }

test("reopen reads verified account state without login, inference or usage requests", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  f.state(connected, { revision: 3, currentAccountRef: ref, currentOwned: false, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: connected }] });
  await f.account.refresh();
  assert.deepEqual(f.calls, ["status", "available"]); assert.equal(f.account.view.session?.profile?.plan, "free");
  await f.account.loadUsage(); assert.equal(f.account.view.usage?.availableMicros, 2_000_000);
  f.state(signedOut); await f.account.refresh(); assert.equal(f.account.view.session?.authenticated, false); assert.equal(f.account.view.session?.profile, undefined); assert.equal(f.account.view.usage, null);
});

test("account request waits for explicit source approval and adopts once without Auth0", async t => {
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh(); await f.account.requestAccess();
  await waitUntil(() => f.calls.includes("consume")); assert.equal(f.account.view.error, null); assert.ok(f.account.view.challenge);
  assert.ok(!f.calls.includes("adopt") && !f.calls.includes("login"));
  f.approve(); await waitUntil(() => f.account.view.session?.authenticated === true && !f.account.view.busy);
  assert.equal(f.calls.filter(value => value === "request").length, 1); assert.equal(f.calls.filter(value => value === "adopt").length, 1); assert.ok(!f.calls.includes("login"));
  assert.deepEqual(f.writes, [{ accountRef: ref, expectedRevision: 0 }]); assert.equal(f.account.view.challenge, null);
  const count = f.calls.length; await delay(20); assert.equal(f.calls.length, count, "connected accounts do not poll forever");
});

test("disconnect uses the client CAS and does not log the source account out", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  f.state(connected, { revision: 4, currentAccountRef: ref, currentOwned: false, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: connected }] });
  await f.account.refresh(); await f.account.disconnect(); assert.ok(f.calls.includes("unlink")); assert.ok(!f.calls.includes("logout")); assert.deepEqual(f.writes, [{ expectedRevision: 4 }]); assert.equal(f.account.view.session?.authenticated, false);
});

test("account source can approve the displayed request/code for its exact account", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  const request: TuiAccountRequest = { id: randomUUID(), userCode: "A1B2C3D4", expiresAt: new Date(Date.now() + 60_000).toISOString(), clientName: "Terminal", audience: "tui" };
  f.state(connected, { revision: 4, currentAccountRef: ref, currentOwned: true, accounts: [{ accountRef: ref, owned: true, expiresAt: Date.now() + 60_000, session: connected }] }, [request]);
  await f.account.refresh(); assert.equal(f.account.view.requests.length, 1);
  await f.account.approve(request, ref); assert.deepEqual(f.writes, [{ id: request.id, userCode: request.userCode, accountRef: ref }]); assert.equal(f.account.view.requests.length, 0);
});

test("cancel stops challenge polling and disposal ignores late account reads", async () => {
  const f = fixture(); await f.account.requestAccess(); f.account.cancelPending();
  const count = f.calls.length; await delay(25); assert.equal(f.calls.length, count); assert.equal(f.account.view.challenge, null);
  let resolveRead!: (value: AccountPublicSession) => void;
  f.client.getAccountSession = () => new Promise(resolve => { resolveRead = resolve; });
  const pending = f.account.refresh(); f.account.dispose(); resolveRead(connected); await pending;
  assert.equal(f.account.view.session, null); assert.ok(!f.calls.includes("available"));
});

test("expired challenges stop rather than issuing a replacement or fresh login", async t => {
  let now = Date.now(); const f = fixture({ now: () => now }); t.after(() => f.account.dispose());
  await f.account.requestAccess(); now += 61_000;
  await waitUntil(() => f.account.view.error === "account_challenge_expired");
  assert.equal(f.account.view.challenge, null); assert.equal(f.calls.filter(value => value === "request").length, 1); assert.ok(!f.calls.includes("login"));
});

test("late denial after cancel cannot erase the next account request", async t => {
  const f = fixture(); t.after(() => f.account.dispose()); let reject!: (error: Error) => void;
  f.client.consumeAccountAccess = () => new Promise<void>((_, fail) => { reject = fail; });
  await f.account.requestAccess(); await waitUntil(() => Boolean(reject)); f.account.cancelPending(); await f.account.requestAccess(); const challenge = f.account.view.challenge;
  reject(Error("account_share_denied")); await delay(2); assert.equal(f.account.view.challenge, challenge); assert.equal(f.account.view.error, null);
});

test("browser login is explicit and unsafe opener inputs are rejected", async t => {
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh(); assert.ok(!f.calls.includes("login"));
  const opened: string[] = []; await f.account.login(url => { opened.push(url); return true; }); assert.equal(opened.length, 1); assert.ok(f.account.view.login);
  for (const url of ["file:///C:/Windows/notepad.exe", "javascript:alert(1)", "https://example.invalid/path", "http://remote.invalid/api/account/native/authorize?id=" + randomUUID(), "https://u:p@example.invalid/api/account/native/authorize?id=" + randomUUID()]) assert.equal(await openAccountLoginUrl(url), false);
});

test("account is an explicit command, available without a folder, with all ten interface languages", () => {
  for (const alias of ["account", "conta", "cuenta", "compte", "konto", "アカウント", "계정", "账户", "حساب"]) assert.equal(resolveSlash("/" + alias)?.command.id, "account.show");
  assert.equal(resolveSlash("a"), null); assert.equal(resolveSlash("account"), null);
  const langs: Lang[] = ["pt-BR", "en", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"];
  for (const [key, row] of Object.entries(ACCOUNT_TEXT)) { assert.equal(row.length, 10, key); for (const value of row) assert.ok(value.length > 0, key); }
  for (const lang of langs) { setLang(lang); assert.equal(resolveSlash("/account")?.command.title, accountText("title")); }
  setLang("en"); assert.equal(accountText("title"), "Uptokey account");
});

test("linear presentation keeps explicit local sharing and its interactive cancel path", async t => {
  setLang("en"); const f = fixture(); t.after(() => f.account.dispose()); const output: string[] = [];
  await runLinearAccount(f.account, { say: text => { output.push(text); }, choose: async <T>(rows: readonly T[], label: (value: T) => string) => rows.find(row => label(row) === accountText("share")) });
  assert.ok(f.calls.includes("request")); assert.ok(output.some(text => text.includes("1234ABCD"))); assert.ok(!f.calls.includes("login"));
  await runLinearAccount(f.account, { say: text => { output.push(text); }, choose: async <T>(rows: readonly T[], label: (value: T) => string) => rows.find(row => label(row) === accountText("cancel")) });
  assert.equal(f.account.view.challenge, null);
});

test("authenticated account HTTP transport strips private payload fields and never retries mutation", async t => {
  const calls: Array<{ path: string; authorization: string; body: string }> = [];
  const server = createServer((request, response) => {
    let body = ""; request.on("data", chunk => { body += chunk; }); request.on("end", () => {
      const path = request.url!; calls.push({ path, authorization: String(request.headers.authorization), body });
      response.setHeader("content-type", "application/json");
      if (path.endsWith("/status")) response.end(JSON.stringify({ ...connected, privateKey: "never-projected" }));
      else if (path.endsWith("/available")) response.end(JSON.stringify({ revision: 2, currentAccountRef: ref, currentOwned: false, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: { ...connected, cookie: "never-projected" }, secret: "never-projected" }] }));
      else { response.statusCode = 409; response.end(JSON.stringify({ error: { type: "account_share_conflict" } })); }
    });
  }); server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic-bearer" }); t.after(() => client.destroy());
  assert.deepEqual(await client.getAccountSession(), connected); const available = await client.getAvailableAccounts(); assert.equal(JSON.stringify(available).includes("never-projected"), false);
  await assert.rejects(client.adoptAccount(ref, 2), /account_share_conflict/);
  assert.deepEqual(calls.map(value => value.path), ["/local/account/status", "/local/account/available", "/local/account/adopt"]); assert.ok(calls.every(value => value.authorization === "Bearer synthetic-bearer")); assert.deepEqual(JSON.parse(calls[2]!.body), { accountRef: ref, expectedRevision: 2 });
});

test("browser launcher waits for async failures and uses native URL commands on all platforms", async () => {
  const url = `https://app.uptokey.com/api/account/native/authorize?id=${randomUUID()}`;
  for (const [platform, command] of [["darwin", "open"], ["win32", "rundll32"], ["linux", "xdg-open"]] as const) {
    for (const outcome of ["ok", "exit-failed", "missing"] as const) {
      const launched: Array<{ command: string; args: string[] }> = [];
      const opened = await openAccountLoginUrl(url, (name, args) => {
        launched.push({ command: name, args });
        const child = Object.assign(new EventEmitter(), { unref() {} }) as ChildProcess;
        queueMicrotask(() => outcome === "missing" ? child.emit("error", Error("ENOENT")) : child.emit("exit", outcome === "ok" ? 0 : 1));
        return child;
      }, platform);
      assert.equal(opened, outcome === "ok");
      assert.equal(launched[0]!.command, command); assert.equal(launched[0]!.args.at(-1), url);
    }
  }
});

test("browser failure preserves a reusable complete link without another login mutation", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  await f.account.login(async () => false);
  const login = f.account.view.login;
  assert.ok(login); assert.ok(login.loginUrl.includes("/api/account/native/authorize?id="));
  assert.equal(f.account.view.error, "account_browser_unavailable");
  const opened: string[] = [];
  await f.account.reopenLogin(async url => { opened.push(url); return true; });
  assert.equal(f.account.view.login, login); assert.deepEqual(opened, [login.loginUrl]);
  assert.equal(f.calls.filter(call => call === "login").length, 1); assert.equal(f.account.view.error, null);
  await f.account.reopenLogin(async () => { throw Error("browser failed"); });
  assert.equal(f.account.view.error, "account_browser_unavailable"); assert.equal(f.account.view.login, login);
});

test("reopening an expired link cancels a pending read and requires a fresh sign-in", async t => {
  let now = 1_000;
  const f = fixture({ now: () => now }); t.after(() => f.account.dispose());
  await f.account.login(async () => true);
  const originalRead = f.client.getAccountSession;
  let finish!: (session: AccountPublicSession) => void;
  let pendingSignal: AbortSignal | undefined;
  f.client.getAccountSession = signal => { pendingSignal = signal; return new Promise(resolve => { finish = resolve; }); };
  const stale = f.account.refresh();
  now = f.account.view.login!.expiresAt;
  let opened = false;
  await f.account.reopenLogin(async () => { opened = true; return true; });
  assert.equal(opened, false); assert.equal(pendingSignal?.aborted, true);
  assert.equal(f.account.view.login, null); assert.equal(f.account.view.busy, false);
  assert.equal(f.account.view.error, "account_challenge_expired");
  finish(connected); await stale;
  assert.equal(f.account.view.session, null);
  f.client.getAccountSession = originalRead;
  await f.account.login(async () => true);
  assert.equal(f.calls.filter(call => call === "login").length, 2);
  assert.ok(f.account.view.login!.expiresAt > now);
});

test("explicit sign-in preempts a pending status read and ignores its late answer", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  let finish!: (session: AccountPublicSession) => void;
  let pendingSignal: AbortSignal | undefined;
  f.client.getAccountSession = signal => { pendingSignal = signal; return new Promise(resolve => { finish = resolve; }); };
  const read = f.account.refresh();
  await f.account.login(async () => true);
  assert.equal(pendingSignal?.aborted, true); assert.equal(f.calls.filter(call => call === "login").length, 1);
  const login = f.account.view.login; assert.ok(login);
  finish(connected); await read;
  assert.equal(f.account.view.login, login); assert.equal(f.account.view.session, null);
});

test("cancel does not keep the stale refresh promise attached to a new account view", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  let finish!: (session: AccountPublicSession) => void;
  f.client.getAccountSession = () => new Promise(resolve => { finish = resolve; });
  const old = f.account.refresh(); f.account.cancelPending();
  f.client.getAccountSession = async () => connected;
  await f.account.refresh(); assert.equal(f.account.view.session?.authenticated, true);
  finish(signedOut); await old;
  assert.equal(f.account.view.session?.authenticated, true);
});

test("refresh requested during browser launch waits for it and actually checks the account", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  let opened!: (value: boolean) => void;
  const login = f.account.login(() => new Promise(resolve => { opened = resolve; }));
  await delay(0);
  const refresh = f.account.refresh(); f.state(connected);
  opened(true); await Promise.all([login, refresh]);
  assert.ok(f.calls.includes("status")); assert.equal(f.account.view.session?.authenticated, true);
  assert.equal(f.account.view.login, null);
});

test("cancel invalidates a deferred refresh behind browser launch", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  let opened!: (value: boolean) => void;
  const login = f.account.login(() => new Promise(resolve => { opened = resolve; }));
  await delay(0);
  const refresh = f.account.refresh(); f.account.cancelPending(); opened(true);
  await Promise.all([login, refresh]);
  assert.equal(f.calls.includes("status"), false); assert.equal(f.account.view.login, null);
  assert.equal(f.account.view.busy, false); assert.equal(f.account.view.error, null);
});

test("pending browser status remains neutral across HTTP 409 and connects after approval", async t => {
  let approved = false, statuses = 0, loginRequests = 0;
  const server = createServer((request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/local/account/login") {
      loginRequests++; response.end(JSON.stringify({ loginUrl: `https://app.uptokey.com/api/account/native/authorize?id=${randomUUID()}`, userCode: "A1B2C3D4", expiresAt: Date.now() + 60_000 }));
    } else if (request.url === "/local/account/status") {
      statuses++; response.statusCode = approved ? 200 : 409;
      response.end(JSON.stringify(approved ? connected : { error: { type: "account_challenge_pending" } }));
    } else if (request.url === "/local/account/available") response.end(JSON.stringify({ revision: 1, currentAccountRef: ref, currentOwned: false, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: connected }] }));
    else { response.statusCode = 500; response.end("{}"); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic" }); t.after(() => client.destroy());
  const account = new TuiAccount(client, { intervalMs: 10 }); t.after(() => account.dispose());
  await account.login(() => true); await waitUntil(() => statuses >= 2 && !account.view.busy);
  assert.equal(account.view.error, null); assert.ok(account.view.login); assert.equal(loginRequests, 1);
  approved = true; await waitUntil(() => account.view.session?.authenticated === true && !account.view.busy);
  assert.equal(account.view.login, null); assert.equal(loginRequests, 1);
});

test("account polling stays below the local twenty-per-minute limit and preserves HTTP retry advice", async t => {
  assert.ok(Math.ceil(60_000 / ACCOUNT_POLL_INTERVAL_MS) + 2 <= 20, "automatic polls must leave room for the initial/manual status reads");
  const server = createServer((_request, response) => { response.writeHead(429, { "content-type": "application/json", "retry-after": "27" }); response.end(JSON.stringify({ error: { type: "local_auth_rate_limited" } })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic" }); t.after(() => client.destroy());
  await assert.rejects(client.getAccountSession(), error => error instanceof Error && error.message === "account_rate_limited" && (error as Error & { retryAfterMs: number }).retryAfterMs === 27_000);
});

test("approved login retries incomplete account projections without another login or manual Refresh", async t => {
  for (const stage of ["available", "requests"] as const) {
    const f = fixture(); t.after(() => f.account.dispose());
    await f.account.refresh(); await f.account.login(() => true);
    const pending = f.account.view.login; assert.ok(pending);
    f.state(connected, { revision: 7, currentAccountRef: ref, currentOwned: true, accounts: [{ accountRef: ref, owned: true, expiresAt: Date.now() + 60_000, session: connected }] });
    let rejected = false;
    const rejectFirst = <T>(original: () => Promise<T>) => async (): Promise<T> => {
      if (!rejected) { rejected = true; throw Object.assign(Error(stage === "available" ? "account_rate_limited" : "account_service_unavailable"), { retryAfterMs: 5 }); }
      return original();
    };
    if (stage === "available") f.client.getAvailableAccounts = rejectFirst(f.client.getAvailableAccounts);
    else f.client.getAccountRequests = rejectFirst(f.client.getAccountRequests);
    await waitUntil(() => rejected && !f.account.view.busy && f.account.view.error !== null);
    assert.equal(f.account.view.login, pending, "partial success must retain its bounded recovery challenge");
    assert.equal(f.account.view.session?.authenticated, false, "status cannot publish an unbound connected account");
    await waitUntil(() => !f.account.view.busy && f.account.view.available?.revision === 7);
    assert.equal(f.account.view.session?.authenticated, true); assert.equal(f.account.view.login, null); assert.equal(f.account.view.error, null);
    assert.equal(f.calls.filter(call => call === "login").length, 1);
    const count = f.calls.length; await delay(20); assert.equal(f.calls.length, count, "recovered accounts stop polling");
    f.account.dispose();
  }
});

test("cancellation during an approved projection never publishes its late account", async t => {
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.refresh(); await f.account.login(() => true);
  f.state(connected);
  let finish!: (value: TuiAccountAvailable) => void;
  f.client.getAvailableAccounts = () => new Promise(resolve => { finish = resolve; });
  await waitUntil(() => Boolean(finish)); f.account.cancelPending(); finish(noAccounts());
  await delay(20); assert.notEqual(f.account.view.session?.authenticated, true); assert.equal(f.account.view.login, null);
  const count = f.calls.length; await delay(20); assert.equal(f.calls.length, count);
});

test("authorization denial, revocation and an exhausted native challenge stop automatic recovery", async t => {
  for (const failure of [Object.assign(Error("account_service_unavailable"), { status: 401 }), Object.assign(Error("account_service_unavailable"), { status: 403 }), Error("account_session_revoked"), Error("account_challenge_expired")]) {
    const f = fixture(); t.after(() => f.account.dispose()); await f.account.login(() => true);
    f.client.getAccountSession = async () => { f.calls.push("denied"); throw failure; };
    await waitUntil(() => f.account.view.error !== null && !f.account.view.busy);
    assert.equal(f.account.view.login, null); assert.equal(f.account.view.available, null); assert.equal(f.account.view.session, null);
    const count = f.calls.length; await delay(20); assert.equal(f.calls.length, count, "terminal denial cannot poll forever");
    f.account.dispose();
  }
  const f = fixture(); t.after(() => f.account.dispose()); await f.account.login(() => true);
  await waitUntil(() => f.account.view.error === "account_reauthentication_required");
  assert.equal(f.account.view.login, null);
});

test("account transport preserves terminal HTTP status without exposing response details", async t => {
  let status = 401;
  const server = createServer((_request, response) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify({ error: { type: "local_auth_invalid", detail: "not-public" } })); });
  server.listen(0, "127.0.0.1"); await once(server, "listening"); t.after(() => { server.closeAllConnections(); server.close(); });
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`, token: "synthetic" }); t.after(() => client.destroy());
  for (status of [401, 403]) await assert.rejects(client.getAvailableAccounts(), error => error instanceof Error && error.message === "account_service_unavailable" && (error as Error & { status: number }).status === status && !error.message.includes("not-public"));
});

test("verified sign-out clears previous account authority even when its projection is rate limited", async t => {
  const f = fixture(); t.after(() => f.account.dispose());
  f.state(connected, { revision: 3, currentAccountRef: ref, currentOwned: false, accounts: [{ accountRef: ref, owned: false, expiresAt: Date.now() + 60_000, session: connected }] });
  await f.account.refresh(); await f.account.loadUsage(); assert.equal(f.account.view.session?.authenticated, true);
  f.state(signedOut); f.client.getAvailableAccounts = async () => { throw Error("account_rate_limited"); };
  await f.account.refresh();
  assert.equal(f.account.view.session?.authenticated, false); assert.equal(f.account.view.available, null);
  assert.deepEqual(f.account.view.requests, []); assert.equal(f.account.view.usage, null); assert.equal(f.account.view.plan.state, "unknown");
  assert.equal(f.account.view.login, null); assert.equal(f.account.view.error, "account_rate_limited");
});
