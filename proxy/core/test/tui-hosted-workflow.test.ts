import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { join, dirname, basename, resolve } from "node:path";
import { tmpdir } from "node:os";
import { setTimeout as delay } from "node:timers/promises";
import { createRequire, registerHooks } from "node:module";
import { TuiController } from "../src/tui/controller.ts";
import { HOSTED_PROVIDER } from "../src/tui/hosted.ts";
import { ConversationStore } from "../src/workspace/conversations.ts";
import { MemorySecretStore } from "../src/secret-store.ts";

// The actual SDK adapter uses Bun parameter properties. Transpile only for Node's test launcher.
const ts = createRequire(import.meta.url)("../src/tui/frontend/node_modules/typescript");
const loader = registerHooks({ load(url, context, nextLoad) {
  if (url.startsWith("file:") && url.endsWith(".ts")) return { format: "module", shortCircuit: true,
    source: ts.transpileModule(readFileSync(new URL(url), "utf8"), { compilerOptions: { target: ts.ScriptTarget.ESNext, module: ts.ModuleKind.ESNext } }).outputText };
  return nextLoad(url, context);
} });
const backendModule = "../src/tui/frontend/uptokey/backend/index.ts";
const { UptokeyBackend } = await import(backendModule);
loader.deregister();

const ACCOUNT_A = "acc_" + "a".repeat(64), ACCOUNT_B = "acc_" + "b".repeat(64);
const connected = { configured: true, authenticated: true, loginAvailable: true, state: "connected", profile: { displayName: "Fixture", plan: "free" } };
const signedOut = { configured: true, authenticated: false, loginAvailable: true, state: "signed_out" };
const ids = (prefix = "server-free", count = 7) => Array.from({ length: count }, (_, index) => `${prefix}-${index + 1}`);
function catalog(modelIds: string[]) {
  return { executionEnabled: true, transport: "json", admissionRequired: true,
    billing: { currency: "USD", unit: "micro_usd", rateBasisTokens: 1_000_000, settlement: "provider_reported_usage" },
    models: modelIds.map(id => ({ id, price: { model: id, version: "fixture-price-v1", currency: "USD", inputMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
      limits: { inputTokens: 8192, outputTokens: 4096, contextTokens: 16384 } })),
  };
}
const ownProviders = [
  { id: "deepseek", kind: "provider", configured: true, enabled: true, admission: { eligible: true }, models: ["byok-chat"], defaultModel: "byok-chat" },
  { id: "ollama", kind: "local", configured: true, enabled: true, admission: { eligible: true }, models: ["local-code"], defaultModel: "local-code" },
];
async function until(predicate: () => boolean) {
  for (let n = 0; n < 120; n++) { if (predicate()) return; await delay(5); }
  assert.fail("hosted workflow did not settle");
}

async function fixture(t: TestContext, options: { own?: boolean; model?: string; processingPolicy?: "local_only" | "external_allowed"; held?: boolean; signedOut?: boolean } = {}) {
  const root = await mkdtemp(join(tmpdir(), "uptokey-hosted-workflow-"));
  const previous = process.env.UPTOKEY_SETTINGS_DIR;
  process.env.UPTOKEY_SETTINGS_DIR = root;
  let accountRef: string | null = options.signedOut ? null : ACCOUNT_A, revision = 1;
  let supplied = catalog(ids()), catalogStatus = 200;
  const principal = "isolated-hosted-workflow";
  const conversations = new ConversationStore(new MemorySecretStore(), join(root, "conversations"));
  let chatMode: "complete" | "hold" | "disconnect" = "complete", heldChat: (() => void) | undefined;
  const dispatchProof: Array<{ requestId: string; persistedBeforeDispatch: boolean }> = [];
  const held = new Map<string, Array<() => void>>(), holding = new Set(options.held ? [ACCOUNT_A] : []);
  const calls: Array<{ path: string; method: string; body?: any; authorization?: string }> = [];
  const send = (response: ServerResponse, value: unknown, status = 200) => { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(value)); };
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : undefined;
    const path = request.url!, method = request.method!;
    calls.push({ path, method, body, authorization: request.headers.authorization });
    if (path === "/health") return send(response, { status: "ok", version: "fixture" });
    if (request.headers.authorization !== "Bearer fixture-local-token") return send(response, {}, 401);
    if (path.startsWith("/v1/workspace/conversations")) {
      const parsed = new URL(path, "http://127.0.0.1");
      const suffix = parsed.pathname.slice("/v1/workspace/conversations".length);
      try {
        if (suffix === "/create") return send(response, await conversations.createConversation(principal, body));
        const [, id, action] = suffix.split("/");
        if (action === "messages") return send(response, method === "POST"
          ? await conversations.appendMessage(principal, id!, body)
          : await conversations.listMessages(principal, id!, { limit: Number(parsed.searchParams.get("limit") ?? 200), after: parsed.searchParams.get("after") }));
        if (action === "update") return send(response, await conversations.updateConversation(principal, id!, body));
        return send(response, await conversations.getConversation(principal, id!));
      } catch (error) { return send(response, { error: String(error) }, 500); }
    }
    if (path === "/v1/models") return send(response, { data: options.own ? ownProviders.flatMap(p => p.models.map(id => ({ id, owned_by: p.id }))) : [] });
    if (path === "/v1/connections") return send(response, { providers: options.own ? ownProviders : [], catalog: { entries: [] }, connections: [], routingCombos: [] });
    if (path === "/local/connections") return send(response, { connections: [] });
    if (path === "/local/account/status") return send(response, accountRef ? connected : signedOut);
    if (path === "/local/account/available") return send(response, { revision, currentAccountRef: accountRef, currentOwned: accountRef ? false : null,
      accounts: accountRef ? [{ accountRef, owned: false, session: connected, expiresAt: Date.now() + 60000 }] : [] });
    if (path === "/local/account/logout") { accountRef = null; revision++; return send(response, signedOut); }
    if (path === "/local/account/adopt") {
      assert.equal(body.expectedRevision, revision); accountRef = body.accountRef; revision++;
      return send(response, { revision, session: connected });
    }
    if (path === "/local/account/hosted" && body.operation === "models") {
      if (catalogStatus !== 200) return send(response, { error: "hosted_model_unavailable" }, catalogStatus);
      const reply = { ...structuredClone(supplied), accountRef: body.accountRef, revision: body.revision, privateKey: "never-project-this" };
      const respond = () => send(response, reply);
      if (holding.has(body.accountRef)) { held.set(body.accountRef, [...(held.get(body.accountRef) ?? []), respond]); return; }
      return respond();
    }
    if (path === "/local/account/hosted" && body.operation === "chat") {
      const all = await conversations.listConversations(principal, {});
      let persistedBeforeDispatch = false;
      for (const conversation of all.conversations) {
        const rows = await conversations.listMessages(principal, conversation.id, {});
        persistedBeforeDispatch ||= rows.messages.some(message => message.parts.some(part =>
          part.type === "status" && typeof part.text === "string" && part.text.startsWith("hosted:v1 ") && JSON.parse(part.text.slice(10)).requestId === body.payload.requestId));
      }
      dispatchProof.push({ requestId: body.payload.requestId, persistedBeforeDispatch });
      const respond = () => send(response, { accountRef: body.accountRef, revision: body.revision, requestId: body.payload.requestId,
        status: "completed", content: "A synthetic hosted answer", currency: "USD", chargedMicros: 0,
        priceVersion: body.payload.expectedPriceVersion, usage: { inputTokens: 3, outputTokens: 4 } });
      if (chatMode === "disconnect") return response.destroy();
      if (chatMode === "hold") { heldChat = respond; return; }
      return respond();
    }
    if (path === "/local/account/hosted" && body.operation === "receipt") {
      const now = new Date().toISOString();
      return send(response, { accountRef: body.accountRef, revision: body.revision, requestId: body.payload.requestId,
        state: "settled", currency: "USD", unit: "micro_usd", reservedMicros: 0, chargedMicros: 0,
        createdAt: now, dispatchStartedAt: now, settledAt: now, priceVersion: "fixture-price-v1" });
    }
    send(response, { error: { type: "unexpected_fixture_request" } }, 404);
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const controller = new TuiController({ cwd: root, baseUrl, token: "fixture-local-token", temporary: true,
    ...(options.model ? { model: options.model } : {}), ...(options.processingPolicy ? { processingPolicy: options.processingPolicy } : {}) });
  // This suite owns no user project. Model/account/SDK/HTTP behavior is real; folder binding is outside its scope.
  t.mock.method(controller, "bindProject", async () => undefined);
  t.mock.method(controller, "refreshConversationList", async () => undefined);
  const backend = new UptokeyBackend({ controller, cwd: root, home: root, state: root, config: root });
  t.after(async () => {
    backend.dispose(); controller.dispose(); server.closeAllConnections();
    await new Promise<void>(done => server.close(() => done()));
    conversations.close();
    if (previous === undefined) delete process.env.UPTOKEY_SETTINGS_DIR; else process.env.UPTOKEY_SETTINGS_DIR = previous;
    assert.equal(dirname(resolve(root)), resolve(tmpdir())); assert.ok(basename(root).startsWith("uptokey-hosted-workflow-"));
    await rm(root, { recursive: true, force: true });
  });
  await backend.whenReady(); await controller.account.refresh();
  return { controller, backend, calls, dispatchProof,
    chat(mode: typeof chatMode) { chatMode = mode; },
    releaseChat() { heldChat?.(); heldChat = undefined; },
    async create(policy: "local_only" | "external_allowed" = "external_allowed") {
      return conversations.createConversation(principal, { title: "Fixture conversation", storagePolicy: "local", processingPolicy: policy });
    },
    async stored(id: string) { return conversations.listMessages(principal, id, {}); },
    reopenStore() { conversations.close(); conversations.open(); },
    async settled() { await controller.refreshHostedModels(); },
    catalog(value: typeof supplied) { supplied = value; },
    catalogStatus(status: number) { catalogStatus = status; },
    hold(ref: string) { holding.add(ref); },
    held(ref: string) { return held.get(ref)?.length ?? 0; },
    release(ref: string) { holding.delete(ref); for (const respond of held.get(ref) ?? []) respond(); held.delete(ref); },
  };
}

test("verified catalog supplies seven Free models dynamically, after own connected models, without inference on selection", async t => {
  const f = await fixture(t, { own: true }); await f.settled();
  assert.deepEqual(f.controller.hostedModels.map(item => item.modelId), ids());
  assert.equal(f.controller.state.selectedModel, "byok-chat");
  const listed = (await f.backend.client.config.providers()).data.providers;
  assert.deepEqual(listed.map((item: any) => item.id), ["deepseek", "ollama", HOSTED_PROVIDER]);
  const hosted = listed.at(-1);
  assert.deepEqual(Object.keys(hosted.models), ids());
  assert.ok(Object.values(hosted.models).every((model: any) => model.options.uptokeyFunding === "hosted-free" && !model.capabilities.toolcall && !model.capabilities.attachment));
  assert.equal(JSON.stringify(listed).includes(ACCOUNT_A), false);
  assert.equal(JSON.stringify(listed).includes("never-project-this"), false);
  await f.controller.selectProviderModel(ids()[5]!, HOSTED_PROVIDER);
  assert.equal(f.controller.state.selectedModel, ids()[5]);
  assert.equal(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_A);
  assert.equal(f.controller.state.processingPolicy, "external_allowed");
  assert.equal(f.calls.filter(call => call.body?.operation === "chat" || call.path.includes("completions")).length, 0);
  f.catalog(catalog(ids("changed-by-server", 2))); await f.controller.refreshHostedModels(true);
  assert.deepEqual(Object.keys((await f.backend.client.config.providers()).data.providers.at(-1).models), ids("changed-by-server", 2));
});

test("first use selects eligible Free only when no model or processing policy was chosen", async t => {
  const f = await fixture(t); await f.settled();
  assert.equal(f.controller.state.selectedModel, ids()[0]);
  assert.equal(f.controller.client.getSelectedDestination().providerId, HOSTED_PROVIDER);
  assert.equal(f.controller.state.processingPolicy, "external_allowed");
  assert.equal(f.calls.filter(call => call.body?.operation === "chat").length, 0);
});

test("an explicit local model and local-only policy survive catalog availability and account logout", async t => {
  const f = await fixture(t, { own: true, model: "local-code", processingPolicy: "local_only" }); await f.settled();
  assert.equal(f.controller.state.selectedModel, "local-code");
  assert.equal(f.controller.client.getSelectedDestination().providerId, "ollama");
  assert.equal(f.controller.state.processingPolicy, "local_only");
  await f.controller.account.logout(); await f.settled();
  assert.equal(f.controller.hostedModels.length, 0);
  assert.equal(f.controller.state.selectedModel, "local-code");
  assert.equal(f.controller.client.getSelectedDestination().providerId, "ollama");
  assert.equal(f.controller.state.processingPolicy, "local_only");
  assert.deepEqual((await f.backend.client.config.providers()).data.providers.map((p: any) => p.id), ["deepseek", "ollama"]);
});

test("signed-out first use keeps BYOK usable and does not request a hosted catalog or login automatically", async t => {
  const f = await fixture(t, { own: true, signedOut: true }); await f.settled();
  assert.equal(f.controller.state.selectedModel, "byok-chat");
  assert.equal(f.controller.hostedModels.length, 0);
  assert.equal(f.calls.filter(call => call.path.includes("/hosted") || call.path.includes("/login")).length, 0);
});

test("account switch invalidates the previous destination immediately, before the next catalog responds", async t => {
  const f = await fixture(t); await f.settled();
  assert.equal(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_A);
  f.hold(ACCOUNT_B); f.catalog(catalog(ids("account-b", 3)));
  await f.controller.account.adopt(ACCOUNT_B); await until(() => f.held(ACCOUNT_B) === 1);
  assert.equal(f.controller.hostedModels.length, 0);
  assert.notEqual(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_A);
  assert.equal((await f.backend.client.config.providers()).data.providers.length, 0);
  f.release(ACCOUNT_B); await f.settled();
  assert.deepEqual(f.controller.hostedModels.map(item => item.modelId), ids("account-b", 3));
  assert.equal(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_B);
});

test("a late catalog from the old account cannot repopulate models after account switch", async t => {
  const f = await fixture(t); await f.settled();
  f.hold(ACCOUNT_A); const stale = f.controller.refreshHostedModels(true);
  await until(() => f.held(ACCOUNT_A) === 1);
  f.catalog(catalog(ids("new-account", 2))); await f.controller.account.adopt(ACCOUNT_B); await f.settled();
  assert.deepEqual(f.controller.hostedModels.map(item => item.modelId), ids("new-account", 2));
  f.release(ACCOUNT_A); await stale;
  assert.deepEqual(f.controller.hostedModels.map(item => item.modelId), ids("new-account", 2));
  assert.equal(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_B);
  assert.equal(f.calls.filter(call => call.body?.operation === "chat").length, 0);
});

test("execution-disabled and paid catalog rows are not presented as usable Free models", async t => {
  const f = await fixture(t, { own: true }); await f.settled();
  const paid = catalog(["paid-model"]); paid.models[0]!.price.inputMicrosPerMillion = 10;
  f.catalog(paid); await f.controller.refreshHostedModels(true);
  assert.equal(f.controller.hostedModels.length, 0);
  const disabled = catalog(ids()); disabled.executionEnabled = false;
  f.catalog(disabled); await f.controller.refreshHostedModels(true);
  assert.equal(f.controller.hostedModels.length, 0);
  assert.equal(f.controller.state.selectedModel, "byok-chat");
  assert.deepEqual((await f.backend.client.config.providers()).data.providers.map((p: any) => p.id), ["deepseek", "ollama"]);
});

test("a held Free catalog does not delay backend readiness or a connected BYOK model", async t => {
  const f = await fixture(t, { own: true, held: true });
  await until(() => f.held(ACCOUNT_A) === 1);
  await delay(100);
  assert.equal(f.controller.state.selectedModel, "byok-chat");
  assert.deepEqual((await f.backend.client.config.providers()).data.providers.map((p: any) => p.id), ["deepseek", "ollama"]);
  assert.equal(f.calls.filter(call => call.body?.operation === "models").length, 1);
  f.release(ACCOUNT_A); await f.settled();
  assert.equal(f.controller.hostedModels.length, 7);
  assert.equal(f.controller.state.selectedModel, "byok-chat");
});

const drain = async (events: AsyncIterable<unknown>) => { const result = []; for await (const event of events) result.push(event); return result; };
const hostedParts = (messages: Array<{ parts: Array<{ type: string; text?: unknown }> }>) => messages.flatMap(message => message.parts
  .filter(part => part.type === "status" && typeof part.text === "string" && part.text.startsWith("hosted:v1 "))
  .map(part => JSON.parse(String(part.text).slice(10))));

test("canonical sendTurn persists the hosted request before one POST and restores the exact destination after store reopen", async t => {
  const f = await fixture(t, { own: true }); await f.settled();
  const model = ids()[3]!;
  await f.controller.selectProviderModel(model, HOSTED_PROVIDER);
  const destination = f.controller.client.getSelectedDestination();
  const conversation = await f.create();
  const events = await drain(f.controller.conversations.sendTurn({ conversationId: conversation.id, model,
    destination, system: [], userText: "Synthetic request", expectedProcessingPolicy: "external_allowed" }));
  assert.deepEqual(events, [{ type: "text", data: "A synthetic hosted answer" }, { type: "done", data: "" }]);
  assert.equal(f.dispatchProof.length, 1); assert.equal(f.dispatchProof[0]!.persistedBeforeDispatch, true);
  const rows = (await f.stored(conversation.id)).messages;
  assert.deepEqual(rows.map(message => message.role), ["user", "assistant"]);
  const metadata = hostedParts(rows);
  assert.equal(metadata.length, 2); assert.equal(metadata[0].state, "pending"); assert.equal(metadata[1].state, "completed");
  assert.equal(metadata[0].requestId, f.dispatchProof[0]!.requestId); assert.equal(metadata[1].requestId, metadata[0].requestId);
  assert.equal(metadata[1].chargedMicros, 0); assert.deepEqual(metadata[1].usage, { inputTokens: 3, outputTokens: 4 });
  assert.deepEqual(metadata[1].destination, destination.hosted);
  f.reopenStore();
  await f.controller.selectProviderModel("byok-chat", "deepseek");
  await f.controller.openConversation(conversation.id);
  assert.equal(f.controller.state.selectedModel, model);
  assert.deepEqual(f.controller.client.getSelectedDestination().hosted, destination.hosted);
  assert.equal(f.controller.state.messages.at(-1)?.content, "A synthetic hosted answer");
  assert.equal(f.calls.filter(call => call.body?.operation === "chat").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/v1/chat/completions").length, 0);
});

test("canonical SDK prompt can intentionally change local-only to Free and send through its persisted conversation", async t => {
  const f = await fixture(t, { own: true, model: "local-code", processingPolicy: "local_only" }); await f.settled();
  const conversation = await f.create("local_only"); await f.controller.openConversation(conversation.id);
  await f.backend.client.session.prompt({ sessionID: conversation.id, model: { providerID: HOSTED_PROVIDER, modelID: ids()[1] },
    agent: "plan", parts: [{ type: "text", text: "Synthetic request" }] });
  assert.equal(f.controller.state.processingPolicy, "external_allowed");
  assert.equal(f.controller.state.selectedModel, ids()[1]);
  assert.equal(f.controller.state.messages.at(-1)?.content, "A synthetic hosted answer");
  assert.equal(f.dispatchProof.length, 1); assert.equal(f.dispatchProof[0]!.persistedBeforeDispatch, true);
});

test("lost hosted reply keeps the request and interrupted history without retry or BYOK fallback", async t => {
  const f = await fixture(t, { own: true }); await f.settled();
  await f.controller.selectProviderModel(ids()[0]!, HOSTED_PROVIDER); f.chat("disconnect");
  const conversation = await f.create();
  await assert.rejects(drain(f.controller.conversations.sendTurn({ conversationId: conversation.id, model: ids()[0]!,
    system: [], userText: "Synthetic lost reply", expectedProcessingPolicy: "external_allowed" })), /hosted_outcome_unknown/);
  const rows = (await f.stored(conversation.id)).messages;
  const metadata = hostedParts(rows);
  assert.equal(f.dispatchProof.length, 1); assert.equal(f.dispatchProof[0]!.persistedBeforeDispatch, true);
  assert.equal(metadata[0].requestId, metadata[1].requestId); assert.equal(metadata[1].state, "outcome_unknown");
  assert.ok(rows.at(-1)?.parts.some(part => part.text === "interrupted"));
  f.reopenStore(); await f.controller.openConversation(conversation.id);
  assert.equal(f.controller.client.getSelectedDestination().providerId, HOSTED_PROVIDER);
  assert.equal(f.controller.state.messages.at(-1)?.interrupted, "failed");
  assert.equal(f.calls.filter(call => call.body?.operation === "chat").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/v1/chat/completions").length, 0);
});

test("account logout aborts an in-flight hosted turn and cannot publish its late answer", async t => {
  const f = await fixture(t); await f.settled();
  const conversation = await f.create(); await f.controller.openConversation(conversation.id); f.chat("hold");
  const sending = f.backend.client.session.prompt({ sessionID: conversation.id, model: { providerID: HOSTED_PROVIDER, modelID: ids()[0] },
    agent: "plan", parts: [{ type: "text", text: "Synthetic delayed answer" }] });
  await until(() => f.dispatchProof.length === 1);
  await f.controller.account.logout(); await f.settled();
  await sending; f.releaseChat();
  const rows = (await f.stored(conversation.id)).messages;
  assert.ok(rows.at(-1)?.parts.some(part => part.text === "cancelled_by_user"));
  assert.equal(JSON.stringify(rows).includes("A synthetic hosted answer"), false);
  assert.equal(f.controller.hostedModels.length, 0);
  assert.equal(f.controller.client.getSelectedDestination().hosted, undefined);
  assert.equal(f.calls.filter(call => call.body?.operation === "chat").length, 1);
  assert.equal(f.calls.filter(call => call.path === "/v1/chat/completions").length, 0);
});

test("refresh rotates price version and output ceiling for the same model/account without silently keeping the old contract", async t => {
  const f = await fixture(t); await f.settled();
  const before = f.controller.client.getSelectedDestination().hosted!;
  const changed = catalog(ids());
  changed.models[0]!.price.version = "fixture-price-v2";
  changed.models[0]!.limits.outputTokens = 1024;
  f.catalog(changed); await f.controller.refreshHostedModels(true);
  const after = f.controller.client.getSelectedDestination().hosted!;
  assert.equal(after.accountRef, before.accountRef); assert.equal(after.revision, before.revision);
  assert.equal(after.modelId, before.modelId); assert.equal(after.priceVersion, "fixture-price-v2");
  assert.equal(after.maxOutputTokens, 1024); assert.notEqual(after, before);
  const conversation = await f.create();
  await drain(f.controller.conversations.sendTurn({ conversationId: conversation.id, model: after.modelId, system: [], userText: "Synthetic new price version" }));
  const post = f.calls.find(call => call.body?.operation === "chat")!.body.payload;
  assert.equal(post.expectedPriceVersion, "fixture-price-v2"); assert.equal(post.maxOutputTokens, 1024);
});

test("removed models and failed catalogs stop advertising Free; explicit refresh recovers without substituting BYOK", async t => {
  const f = await fixture(t, { own: true }); await f.settled();
  const model = ids()[0]!;
  await f.controller.selectProviderModel(model, HOSTED_PROVIDER);
  const conversation = await f.create(); await f.controller.openConversation(conversation.id);
  f.catalog(catalog(["other-model"])); await f.controller.refreshHostedModels(true);
  assert.equal(f.controller.state.selectedModel, ""); assert.equal(f.controller.client.getSelectedDestination().hosted, undefined);
  assert.deepEqual(f.controller.hostedModels.map(row => row.modelId), ["other-model"]);
  assert.ok(!Object.hasOwn((await f.backend.client.config.providers()).data.providers.at(-1).models, model));
  await f.controller.selectProviderModel("other-model", HOSTED_PROVIDER);
  f.catalogStatus(503); await f.controller.refreshHostedModels(true);
  assert.equal(f.controller.hostedModels.length, 0); assert.equal(f.controller.state.selectedModel, "");
  assert.equal(f.controller.client.getSelectedDestination().hosted, undefined);
  assert.deepEqual((await f.backend.client.config.providers()).data.providers.map((p: any) => p.id), ["deepseek", "ollama"]);
  f.catalogStatus(200); f.catalog(catalog(ids()));
  await f.controller.refreshConnections(); await f.settled();
  assert.deepEqual(f.controller.hostedModels.map(row => row.modelId), ids());
  assert.equal(f.controller.state.selectedModel, "");
  await f.controller.selectProviderModel(model, HOSTED_PROVIDER);
  assert.equal(f.controller.client.getSelectedDestination().hosted?.modelId, model);
  assert.equal(f.dispatchProof.length, 0);
});

test("receipt command uses the request ID restored from history and never creates another inference", async t => {
  const f = await fixture(t); await f.settled();
  const conversation = await f.create();
  await drain(f.controller.conversations.sendTurn({ conversationId: conversation.id, model: ids()[0]!, system: [], userText: "Synthetic receipt request" }));
  f.reopenStore(); await f.controller.openConversation(conversation.id);
  const requestId = f.dispatchProof[0]!.requestId;
  assert.equal(f.controller.state.messages.at(-1)?.hostedRequestId, requestId);
  await f.backend.client.session.command({ command: "receipt" });
  const receipts = f.calls.filter(call => call.body?.operation === "receipt");
  assert.equal(receipts.length, 1); assert.deepEqual(receipts[0]!.body, {
    operation: "receipt", accountRef: ACCOUNT_A, revision: 1, payload: { requestId },
  });
  assert.equal(f.dispatchProof.length, 1);
});

test("hosted compaction journals its own request before dispatch and preserves its settled result and summary", async t => {
  const f = await fixture(t); await f.settled();
  const conversation = await f.create();
  for (let index = 0; index < 2; index++) await drain(f.controller.conversations.sendTurn({ conversationId: conversation.id,
    model: ids()[0]!, system: [], userText: `Synthetic history ${index}` }));
  await f.controller.openConversation(conversation.id);
  await f.controller.compact(2);
  assert.equal(f.dispatchProof.length, 3); assert.ok(f.dispatchProof.every(row => row.persistedBeforeDispatch));
  assert.equal(new Set(f.dispatchProof.map(row => row.requestId)).size, 3);
  const rows = (await f.stored(conversation.id)).messages, compactionId = f.dispatchProof[2]!.requestId;
  const compactReceipt = hostedParts(rows).filter(row => row.requestId === compactionId);
  assert.deepEqual(compactReceipt.map(row => row.state), ["pending", "completed"]);
  assert.equal(compactReceipt[1].chargedMicros, 0);
  assert.ok(rows.some(row => row.parts.some(part => part.type === "status" && String(part.text).startsWith("compaction:v1 "))));
  f.reopenStore(); await f.controller.openConversation(conversation.id);
  assert.equal(f.controller.state.messages.filter(row => row.compaction).length, 1);
  assert.equal(f.controller.state.messages.at(-2)?.hostedRequestId, compactionId);
  assert.equal(f.controller.client.getSelectedDestination().hosted?.accountRef, ACCOUNT_A);
});

test("SDK prompt rejects a destination changed while its media preparation is pending", async t => {
  const f = await fixture(t); await f.settled();
  const conversation = await f.create(); await f.controller.openConversation(conversation.id);
  let preparing = false, release!: () => void;
  const media = new Promise<never>(resolve => { release = () => resolve(undefined as never); });
  t.mock.method(f.controller, "prepareMediaInput", async () => { preparing = true; return media; });
  const pending = f.backend.client.session.prompt({ sessionID: conversation.id, model: { providerID: HOSTED_PROVIDER, modelID: ids()[0] },
    parts: [{ type: "text", text: "Synthetic attachment" }, { type: "file", mime: "image/png", url: "data:image/png;base64,AQID" }] });
  const rejected = assert.rejects(pending, /changed while preparing/);
  await until(() => preparing);
  await f.controller.selectProviderModel(ids()[1]!, HOSTED_PROVIDER); release(); await rejected;
  assert.equal(f.controller.state.selectedModel, ids()[1]);
  assert.equal(f.dispatchProof.length, 0); assert.equal((await f.stored(conversation.id)).messages.length, 0);
});
