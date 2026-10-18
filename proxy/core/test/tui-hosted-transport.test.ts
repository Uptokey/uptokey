import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { TuiClient } from "../src/tui/client.ts";
import { loadHostedModels, sendHosted, hostedInput, getHostedReceipt, HOSTED_PROVIDER, type HostedTransport } from "../src/tui/hosted.ts";
import { HOSTED_TEXT, hostedText } from "../src/tui/hosted-ui.ts";

const accountRef = `acc_${"a".repeat(64)}`, revision = 3;
const target = { accountRef, revision, modelId: "gemini-real", priceVersion: "p1", maxOutputTokens: 4096 };
const messages = [{ role: "user", content: "synthetic test" }];
const catalog = () => ({ accountRef, revision, executionEnabled: true, transport: "json", admissionRequired: true,
  billing: { currency: "USD", unit: "micro_usd", rateBasisTokens: 1_000_000, settlement: "provider_reported_usage" },
  models: [0, 1, 2].map((index) => ({ id: `model-${index}`, price: { model: `model-${index}`, version: "p1", currency: "USD", inputMicrosPerMillion: index === 2 ? 10 : 0, outputMicrosPerMillion: 0 }, limits: { inputTokens: 8192, outputTokens: 8192, contextTokens: 16384 } })) });
const json = (value: unknown, status = 200) => Response.json(value, { status });
const completed = (requestId: string) => ({ accountRef, revision, requestId, status: "completed", content: "synthetic answer", currency: "USD", chargedMicros: 0, priceVersion: "p1", usage: { inputTokens: 3, outputTokens: 2 } });

test("reconciliation only queries the original bound receipt, without sending a new inference", async () => {
  const result = await getHostedReceipt(async (_path, init) => {
    assert.deepEqual(JSON.parse(String(init.body)), { operation: "receipt", accountRef, revision, payload: { requestId: "one" } });
    return json({ accountRef, revision, requestId: "one", state: "settled", currency: "USD", unit: "micro_usd", reservedMicros: 0, chargedMicros: 0,
      createdAt: "2026-10-15T00:00:00.000Z", dispatchStartedAt: "2026-10-15T00:00:00.000Z", settledAt: "2026-10-15T00:00:01.000Z", priceVersion: "p1" });
  }, { accountRef, revision }, "one");
  assert.equal(result.requestId, "one"); assert.equal(result.state, "settled"); assert.equal(result.chargedMicros, 0);
});

test("hosted recovery actions are localized in all ten supported languages without English fallback", () => {
  const languages = ["en", "pt-BR", "es", "fr", "de", "it", "ja", "ko", "zh-CN", "ar"] as const;
  for (const key of Object.keys(HOSTED_TEXT) as Array<keyof typeof HOSTED_TEXT>) {
    assert.equal(HOSTED_TEXT[key].length, 10);
    for (const language of languages) {
      const message = hostedText(key, { amount: "$0.00" }, language);
      assert.ok(message.trim()); assert.ok(!message.includes("{amount}"));
      if (language !== "en") assert.notEqual(message, hostedText(key, { amount: "$0.00" }, "en"));
    }
  }
});

test("hosted inventory derives only zero-price enabled models from the bound live-shape catalog", async () => {
  let value: unknown = catalog(), calls = 0;
  const transport: HostedTransport = async (path, init) => {
    calls++; assert.equal(path, "/local/account/hosted"); assert.equal(init.method, "POST");
    assert.deepEqual(JSON.parse(String(init.body)), { accountRef, revision, operation: "models", payload: {} });
    return json(value);
  };
  const models = await loadHostedModels(transport, accountRef, revision);
  assert.deepEqual(models.map(model => model.modelId), ["model-0", "model-1"]);
  assert.equal(models[0]?.maxOutputTokens, 4096); assert.equal(models[0]?.contextTokens, 16384);
  value = { ...catalog(), executionEnabled: false }; assert.deepEqual(await loadHostedModels(transport, accountRef, revision), []);
  value = { ...catalog(), accountRef: `acc_${"b".repeat(64)}` }; await assert.rejects(() => loadHostedModels(transport, accountRef, revision), /account_share_conflict/);
  value = { ...catalog(), revision: 4 }; await assert.rejects(() => loadHostedModels(transport, accountRef, revision), /account_share_conflict/);
  assert.equal(calls, 4);
});

test("hosted never sends forbidden local-only work, media or forged identities", async () => {
  let calls = 0;
  const transport: HostedTransport = async () => { calls++; return json({}); };
  await assert.rejects(() => sendHosted(transport, target, "one", messages, "local_only"), /local_processing_denied/);
  assert.throws(() => hostedInput(target, "one", [{ role: "user", content: [{ type: "image_url", image_url: { url: "data:secret" } }] }]), /hosted_request_invalid/);
  assert.throws(() => hostedInput({ ...target, accountRef: "forged" }, "one", messages), /hosted_model_unavailable/);
  const aborted = new AbortController(); aborted.abort();
  await assert.rejects(() => sendHosted(transport, target, "one", messages, "external_allowed", aborted.signal));
  assert.equal(calls, 0);
});

test("one inference per request; unknown, pending, duplicate, wrong account and price are never auto-replayed", async () => {
  for (const answer of [
    () => { throw Error("connection_lost_after_dispatch"); },
    () => json({ accountRef, revision, requestId: "one", status: "outcome_unknown" }, 202),
    () => json({ accountRef, revision, requestId: "one", status: "already_submitted", settlement: "reserved" }, 409),
    () => json({ ...completed("one"), accountRef: `acc_${"b".repeat(64)}` }),
    () => json({ ...completed("one"), priceVersion: "p2" }),
    () => json({ ...completed("one"), requestId: "other" }),
  ]) {
    let calls = 0;
    const result = await sendHosted(async () => { calls++; return answer(); }, target, "one", messages, "external_allowed");
    assert.notEqual(result.status, "completed"); assert.equal(result.requestId, "one"); assert.equal(calls, 1);
  }
});

test("actual loopback client uses the account broker once, leaves selection free of inference, preserves BYOK and validates declared tools", async () => {
  const requests: Array<{ path: string; authorization: string | undefined; body: any }> = [];
  const server = createServer(async (req, res) => {
    let body = ""; for await (const chunk of req) body += chunk;
    const input = JSON.parse(body); requests.push({ path: req.url!, authorization: req.headers.authorization, body: input });
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(completed(input.payload.requestId)));
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const address = server.address() as { port: number };
  const client = new TuiClient({ baseUrl: `http://127.0.0.1:${address.port}`, token: "synthetic-local-token" });
  try {
    client.setHostedDestination(target); assert.equal(requests.length, 0);
    assert.equal(client.getSelectedDestination().providerId, HOSTED_PROVIDER);
    const destination = { ...client.getSelectedDestination(), hostedRequestId: "one" };
    // Declared tools are a contract-validated part of the hosted request (the broker refuses them for models
    // without the capability); a malformed declaration never reaches the network.
    assert.throws(() => client.serializeChatInput(target.modelId, messages, destination, [{ type: "function", function: { name: "bad name", parameters: {} } }]), /hosted_request_invalid/);
    assert.deepEqual(JSON.parse(client.serializeChatInput(target.modelId, messages, destination, [{ type: "function", function: { name: "fake", parameters: {} } }])).tools, [{ type: "function", function: { name: "fake", parameters: {} } }]);
    const events = []; for await (const event of client.chatStream(target.modelId, messages, "conversation", "external_allowed", undefined, destination)) events.push(event);
    assert.deepEqual(events.map(event => event.type), ["hosted_receipt", "text", "done"]);
    assert.equal(events[1]?.data, "synthetic answer"); assert.equal(requests.length, 1);
    assert.equal(requests[0]?.path, "/local/account/hosted"); assert.equal(requests[0]?.authorization, "Bearer synthetic-local-token");
    assert.equal(requests[0]?.body.payload.requestId, "one"); assert.equal(requests[0]?.body.payload.expectedPriceVersion, "p1");
    assert.equal(requests[0]?.body.accountRef, accountRef); assert.equal(requests[0]?.body.revision, revision);
    assert.ok(!JSON.stringify(requests[0]?.body).includes("synthetic-local-token"));
    client.setSelectedProvider("deepseek"); assert.equal(client.getSelectedDestination().hosted, undefined);
    assert.equal(JSON.parse(client.serializeChatInput("deepseek-chat", messages)).uptokey_provider, "deepseek");
  } finally { client.destroy(); server.close(); server.closeAllConnections(); await once(server, "close"); }
});
