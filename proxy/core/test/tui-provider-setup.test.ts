import assert from "node:assert/strict";
import { test } from "node:test";
import { assertProxyConfig, defaultConfig } from "../src/config.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { createProviderSetupService, PROVIDER_SETUP_PRESETS, type ProviderSetupDependencies } from "../src/tui/provider-setup.ts";
import type { ProxyConfig } from "../src/types.ts";
import { createServer } from "node:net";
import { defaultProfileId } from "../src/connection-profiles.ts";

const KEY = "synthetic_provider_key_canary_123456";
function fixture(fetcher: typeof fetch, overrides: Partial<ProviderSetupDependencies> = {}) {
  let config: ProxyConfig = structuredClone(defaultConfig); let writes = 0; let reloads = 0;
  const secrets = new MemorySecretStore();
  const service = createProviderSetupService({ secrets, fetch: fetcher,
    loadConfig: async () => structuredClone(config),
    updateConfig: async (mutator) => { const next = structuredClone(config); mutator(next); assertProxyConfig(next); config = next; writes++; return structuredClone(config); },
    reload: async () => { reloads++; }, ...overrides,
  });
  return { service, secrets, get config() { return config; }, get writes() { return writes; }, get reloads() { return reloads; } };
}
const fetchFn = (fn: (url: string, init: RequestInit) => Response | Promise<Response>): typeof fetch => (async (input, init) => fn(String(input), init ?? {})) as typeof fetch;

test("disconnect revokes only the requested legacy credential through the existing lifecycle", async () => {
  const f = fixture(fetchFn(() => Response.json({connections:[]})));
  await f.secrets.set("local:api-token", "utk_local_" + "a".repeat(32));
  await f.secrets.set("provider:groq", KEY); await f.secrets.set("provider:gemini", "other_saved_key");
  await f.secrets.set("uptokey-account-identity:fixture", "installation_identity");
  await f.service.disconnect("groq");
  assert.equal(await f.secrets.get("provider:groq"), undefined);
  assert.equal(await f.secrets.get("provider:gemini"), "other_saved_key");
  assert.equal(await f.secrets.get("uptokey-account-identity:fixture"), "installation_identity");
  assert.equal(f.config.providers.groq.configured, false); assert.equal(f.config.providers.groq.enabled, false); assert.equal(f.reloads, 1);
});

test("named connection disconnect uses its own fresh revision and native admin without a provider-wide fallback", async () => {
  const id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", admin = "utk_local_" + "a".repeat(32);
  const calls: Array<{url:string;body:unknown}> = [];
  const f = fixture(fetchFn((url, init) => {
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${admin}`); assert.equal(init.redirect, "error");
    calls.push({url,body:init.body ? JSON.parse(String(init.body)) : null});
    if (init.method === "GET") return Response.json({connections:[{id,providerId:"groq",revision:7},{id:other,providerId:"groq",revision:12}]});
    assert.equal(url, `http://127.0.0.1:21435/local/connections/${id}/revoke`); assert.deepEqual(calls.at(-1)?.body,{revision:7});
    return Response.json({revoked:true,providerId:"groq",remote:"skipped"});
  }));
  await f.secrets.set("local:api-token", admin); await f.secrets.set("provider:groq", KEY);
  await f.service.disconnect("groq", id, undefined, 7);
  assert.equal(calls.length,2); assert.equal(f.writes,0); assert.equal(f.reloads,0); assert.equal(await f.secrets.get("provider:groq"),KEY);
  assert.equal(JSON.stringify(calls).includes(admin), false);
});

test("connection conflict, mismatch and missing native authority never remove a different credential", async () => {
  const id = "11111111-1111-4111-8111-111111111111";
  for (const conflict of [false,true]) {
    let posts=0;
    const f=fixture(fetchFn((_url,init)=>{
      if(init.method==='GET')return Response.json({connections:[{id,providerId:conflict?'groq':'gemini',revision:9}]});
      posts++;return Response.json({error:{type:'revision_conflict'}},{status:409});
    }));
    await f.secrets.set('local:api-token','utk_local_'+'a'.repeat(32));await f.secrets.set('provider:groq',KEY);
    await assert.rejects(f.service.disconnect('groq',id,undefined,9),new RegExp(conflict?'provider_connection_conflict':'provider_connection_not_found'));
    assert.equal(posts,conflict?1:0);assert.equal(await f.secrets.get('provider:groq'),KEY);assert.equal(f.writes,0);
  }
  const missing=fixture(fetchFn(()=>{throw Error('must_not_dispatch')}));
  await assert.rejects(missing.service.disconnect('groq',id),/provider_disconnect_unavailable/);
});

test("a failed reload reports an unconfirmed disconnect rather than claiming success or deleting another key", async () => {
  const f=fixture(fetchFn(()=>Response.json({connections:[]})),{reload:async()=>{throw Error('offline')}});
  await f.secrets.set('local:api-token','utk_local_'+'a'.repeat(32));
  await f.secrets.set('provider:groq',KEY);await f.secrets.set('provider:gemini','untouched');
  await assert.rejects(f.service.disconnect('groq'),/provider_disconnect_failed/);
  assert.equal(await f.secrets.get('provider:groq'),undefined);assert.equal(await f.secrets.get('provider:gemini'),'untouched');
});

test("legacy default selection resolves its migrated profile without disabling named accounts", async () => {
  const id = defaultProfileId('groq'), named = '11111111-1111-4111-8111-111111111111'; let posts = 0;
  const f = fixture(fetchFn((url, init) => {
    if (init.method === 'GET') return Response.json({connections:[{id,providerId:'groq',revision:4},{id:named,providerId:'groq',revision:2}]});
    posts++; assert.equal(url,`http://127.0.0.1:21435/local/connections/${id}/revoke`); assert.deepEqual(JSON.parse(String(init.body)),{revision:4});
    return Response.json({revoked:true,providerId:'groq'});
  }));
  await f.secrets.set('local:api-token','utk_local_'+'a'.repeat(32)); await f.secrets.set('provider:groq',KEY);
  await f.service.disconnect('groq','groq',undefined,4);
  assert.equal(posts,1); assert.equal(f.writes,0); assert.equal(f.reloads,0); assert.equal(await f.secrets.get('provider:groq'),KEY,'the canonical profile route owns cleanup');
});

test("a rotated displayed credential or missing default never broadens confirmation to a new key or another account", async () => {
  const id = '11111111-1111-4111-8111-111111111111';
  for (const target of [id,'groq']) {
    let posts=0; const f=fixture(fetchFn((_url,init)=>{if(init.method==='GET')return Response.json({connections:[{id,providerId:'groq',revision:8}]});posts++;return Response.json({revoked:true,providerId:'groq'});}));
    await f.secrets.set('local:api-token','utk_local_'+'a'.repeat(32)); await f.secrets.set('provider:groq',KEY);
    await assert.rejects(f.service.disconnect('groq',target,undefined,7),/provider_connection_conflict/);
    assert.equal(posts,0);assert.equal(f.writes,0);assert.equal(await f.secrets.get('provider:groq'),KEY);
  }
});

test("disconnect refuses another daemon before any vault, profile or config effect", async () => {
  const f=fixture(fetchFn(()=>{throw Error('must_not_dispatch')}));await f.secrets.set('provider:groq',KEY);
  for(const url of ['http://127.0.0.1:21436','https://example.invalid','http://localhost:21435']) {
    await assert.rejects(f.service.disconnect('groq','groq',url),/provider_disconnect_unavailable/);
    await assert.rejects(f.service.disconnect('groq','11111111-1111-4111-8111-111111111111',url),/provider_disconnect_unavailable/);
  }
  assert.equal(await f.secrets.get('provider:groq'),KEY);assert.equal(f.writes,0);assert.equal(f.reloads,0);
});

test("local unreachable classification uses transport evidence and never masks HTTP, protocol or cloud errors", async () => {
  const refused = new TypeError("fetch failed", {cause: Object.assign(new Error("synthetic private diagnostic"), {code: "ECONNREFUSED"})});
  const f = fixture(fetchFn(() => {throw refused;}));
  await assert.rejects(f.service.prepare("ollama"), /^ProviderSetupError: provider_runtime_unreachable$/);
  await assert.rejects(f.service.prepare("custom-lm-studio", undefined, "http://127.0.0.1:1234/v1/chat/completions"), /provider_runtime_unreachable/);
  await assert.rejects(f.service.prepare("deepseek", KEY), /provider_network_unreachable/);
  const unknown = fixture(fetchFn(() => {throw new TypeError("ECONNREFUSED private message without typed cause");}));
  await assert.rejects(unknown.service.prepare("ollama"), /provider_discovery_failed/);
  for (const [status, code] of [[500,"provider_service_unavailable"], [401,"provider_key_rejected"], [404,"provider_discovery_unsupported"]] as const) {
    const response = fixture(fetchFn(() => new Response(null, {status})));
    await assert.rejects(response.service.prepare("ollama"), new RegExp(code));
  }
  const malformed = fixture(fetchFn(() => Response.json({data: "not-an-array"})));
  await assert.rejects(malformed.service.prepare("ollama"), /provider_models_invalid/);
  const empty = fixture(fetchFn(() => Response.json({data: []})));
  await assert.rejects(empty.service.prepare("ollama"), /provider_models_empty/);
  assert.equal(f.writes, 0); assert.equal(f.secrets.values.size, 0);
});

test("actual refused loopback discovery returns a bounded unreachable code without writes or inference", async () => {
  const server = createServer(); await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address(); assert.ok(address && typeof address === "object");
  const port = address.port; await new Promise<void>((resolve,reject) => server.close(error => error ? reject(error) : resolve()));
  const f = fixture(fetch);
  await assert.rejects(f.service.prepare("custom-loopback-fixture", undefined, `http://127.0.0.1:${port}/v1/chat/completions`), /^ProviderSetupError: provider_runtime_unreachable$/);
  assert.equal(f.writes, 0); assert.equal(f.secrets.values.size, 0);
});

test("OVH discovery occurs without persistence and exact model commits through vault/config/reload", async () => {
  const f = fixture(fetchFn((url, init) => {
    assert.equal(url, "https://oai.endpoints.kepler.ai.cloud.ovh.net/v1/models");
    assert.equal(init.method, "GET"); assert.equal(init.redirect, "error");
    assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${KEY}`);
    return Response.json({ data: [{ id: "gpt-oss-120b" }, { id: "coding/model" }] });
  }));
  const prepared = await f.service.prepare("custom-ovhcloud", KEY);
  assert.equal(f.writes, 0); assert.equal(f.secrets.values.size, 0);
  assert.equal(JSON.stringify(prepared).includes(KEY), false);
  await assert.rejects(prepared.commit("invented", { acceptNotice: true }), /provider_model_not_discovered/);
  await assert.rejects(prepared.commit("gpt-oss-120b", { acceptNotice: false }), /provider_notice_required/);
  const saved = await prepared.commit("gpt-oss-120b", { acceptNotice: true });
  assert.equal(saved.routingComboId, "tui-custom-ovhcloud");
  assert.equal(f.config.providers["custom-ovhcloud" as "custom"]?.defaultModel, "gpt-oss-120b");
  assert.deepEqual(f.config.routingCombos?.[saved.routingComboId]?.providerOrderByModel, { "gpt-oss-120b": ["custom-ovhcloud"] });
  assert.equal(f.config.routingCombos?.[saved.routingComboId]?.allowProviderFallback, false);
  assert.equal(f.config.activeRoutingComboId, undefined);
  assert.ok(f.config.fallbackOrder.includes("custom-ovhcloud" as "custom"));
  assert.equal(await f.secrets.get("provider:custom-ovhcloud"), KEY);
  assert.equal(f.reloads, 1); assert.equal(f.writes, 1);
  await assert.rejects(prepared.commit("gpt-oss-120b", { acceptNotice: true }), /provider_setup_expired/);
});

test("aliases and manual models work across providers", async () => {
  const f = fixture(fetchFn(() => Response.json({ data: [] })));
  await f.secrets.set("provider:custom-openai", KEY);
  
  // Explicit model IDs retain their identity; never substitute an older preview.
  const preparedAlias = await f.service.prepareManual("custom-openai", undefined, undefined, "o1");
  assert.equal(preparedAlias.models[0]?.id, "o1");
  
  // arbitrary valid id
  const preparedArbitrary = await f.service.prepareManual("anthropic", KEY, undefined, "claude-4-future");
  assert.equal(preparedArbitrary.models[0]?.id, "claude-4-future");
});

test("saved key is reused without being exposed; absent keys never request discovery", async () => {
  let calls = 0;
  const f = fixture(fetchFn((_url, init) => { calls++; assert.equal(new Headers(init.headers).get("authorization"), `Bearer ${KEY}`); return Response.json({ data: [{ id: "deepseek-chat" }] }); }));
  await assert.rejects(f.service.prepare("deepseek"), /provider_key_required/); assert.equal(calls, 0);
  await f.secrets.set("provider:deepseek", KEY);
  const prepared = await f.service.prepare("deepseek", "");
  assert.equal(prepared.usesSavedKey, true); assert.equal(JSON.stringify(prepared).includes(KEY), false);
  await prepared.commit("deepseek-chat", { acceptNotice: true });
  assert.equal(f.config.providers.deepseek?.enabled, true);
  assert.ok(f.config.providers.deepseek?.riskAcceptedAt);
});

test("OVH excludes endpoints explicitly unable to complete text, without guessing model purpose by name", async () => {
  const f = fixture(fetchFn(() => Response.json({ data: [
    { id: "opaque-nonchat", context_length: 8192, max_completion_tokens: 0 },
    { id: "opaque-chat", context_length: 8192, max_completion_tokens: 4096 },
    { id: "whisper-like-custom-name", max_completion_tokens: 4096 },
    { id: "metadata-not-provided" },
  ] })));
  const prepared = await f.service.prepare("custom-ovhcloud", KEY);
  assert.deepEqual(prepared.models.map((model) => model.id), ["opaque-chat", "whisper-like-custom-name", "metadata-not-provided"]);
  assert.equal(f.writes, 0); prepared.dispose();
});

test("Gemini uses native header, paginates and filters unsupported generation methods", async () => {
  let calls = 0; const key = "AIzaSyntheticCanaryOnly123456789";
  const f = fixture(fetchFn((url, init) => {
    assert.equal(new Headers(init.headers).get("x-goog-api-key"), key);
    assert.equal(new Headers(init.headers).has("authorization"), false);
    assert.equal(new URL(url).searchParams.has("key"), false);
    if (++calls === 1) return Response.json({ models: [{ name: "models/code-alpha", displayName: "Alpha", supportedGenerationMethods: ["generateContent"] }, { name: "models/embedding", supportedGenerationMethods: ["embedContent"] }], nextPageToken: "next" });
    assert.equal(new URL(url).searchParams.get("pageToken"), "next");
    return Response.json({ models: [{ name: "models/code-beta", supportedGenerationMethods: ["generateContent"] }] });
  }));
  const prepared = await f.service.prepare("gemini", key);
  assert.deepEqual(prepared.models.map((m) => m.id), ["code-alpha", "code-beta"]);
  await prepared.commit("code-beta", { acceptNotice: true });
  assert.ok(f.config.providers.gemini.privacyAcceptedAt);
  assert.equal(f.config.providers.gemini.defaultModel, "code-beta");
});

test("Gemini accepts current authorization keys without a legacy prefix and keeps them out of metadata", async () => {
  const key = 'AQ.' + 'synthetic_authorization_key_20261006';
  const f = fixture(fetchFn((url, init) => {
    assert.equal(new URL(url).origin, 'https://generativelanguage.googleapis.com');
    assert.equal(new URL(url).pathname, '/v1beta/models');
    assert.equal(init.method, 'GET');
    assert.equal(new Headers(init.headers).get('x-goog-api-key'), key);
    assert.equal(new URL(url).searchParams.has('key'), false);
    return Response.json({models: [{name: 'models/gemini-fixture', supportedGenerationMethods: ['generateContent']}, {name: 'models/' + key, supportedGenerationMethods: ['generateContent']}]});
  }));
  const prepared = await f.service.prepare('gemini', key);
  assert.deepEqual(prepared.models.map(model => model.id), ['gemini-fixture']);
  assert.ok(!JSON.stringify(prepared).includes(key));
  await prepared.commit('gemini-fixture', {acceptNotice: true});
  assert.equal(await f.secrets.get('provider:gemini'), key);
  assert.ok(!JSON.stringify(f.config).includes(key));
});

test("Gemini errors classify machine evidence without exposing the provider body or blaming every failure on a key", async () => {
  const key = 'AQ.' + 'synthetic_authorization_key_20261006';
  const cases = [
    [400, 'INVALID_ARGUMENT', 'API_KEY_INVALID', 'provider_key_rejected'],
    [401, 'UNAUTHENTICATED', undefined, 'provider_key_rejected'],
    [403, 'PERMISSION_DENIED', undefined, 'provider_access_denied'],
    [403, 'PERMISSION_DENIED', 'SERVICE_DISABLED', 'provider_service_disabled'],
    [403, 'PERMISSION_DENIED', 'API_KEY_SERVICE_BLOCKED', 'provider_key_restricted'],
    [403, 'PERMISSION_DENIED', 'API_KEY_HTTP_REFERRER_BLOCKED', 'provider_key_restricted'],
    [403, 'PERMISSION_DENIED', 'BILLING_DISABLED', 'provider_billing_required'],
    [400, 'FAILED_PRECONDITION', undefined, 'provider_setup_required'],
    [429, 'RESOURCE_EXHAUSTED', undefined, 'provider_discovery_rate_limited'],
    [503, 'UNAVAILABLE', undefined, 'provider_service_unavailable'],
  ] as const;
  for (const [status, machineStatus, reason, code] of cases) {
    const f = fixture(fetchFn(() => Response.json({error: {status: machineStatus, message: 'sensitive ' + key, details: reason ? [{'@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason, metadata: {project: 'private-project'}}] : []}}, {status})));
    await assert.rejects(f.service.prepare('gemini', key), (error: Error) => error.message === code);
    assert.equal(f.writes, 0);
    assert.equal(f.secrets.values.size, 0);
  }
  for (const body of ['not-json ' + key, JSON.stringify({error:{message:key, details: 'x'.repeat(17_000)}})]) {
    const f = fixture(fetchFn(() => new Response(body, {status:403})));
    await assert.rejects(f.service.prepare('gemini', key), /^ProviderSetupError: provider_access_denied$/);
  }
});

test("Anthropic discovery uses /v1/models with native authentication and cursor", async () => {
  let calls = 0;
  const f = fixture(fetchFn((url, init) => {
    assert.equal(new URL(url).pathname, "/v1/models");
    assert.equal(new Headers(init.headers).get("x-api-key"), KEY);
    assert.equal(new Headers(init.headers).get("anthropic-version"), "2023-06-01");
    assert.equal(new Headers(init.headers).has("authorization"), false);
    if (++calls === 1) return Response.json({ data: [{ id: "claude-alpha" }], has_more: true, last_id: "claude-alpha" });
    assert.equal(new URL(url).searchParams.get("after_id"), "claude-alpha");
    return Response.json({ data: [{ id: "claude-beta" }], has_more: false });
  }));
  const prepared = await f.service.prepare("anthropic", KEY);
  assert.equal(prepared.models.length, 2); prepared.dispose();
  await assert.rejects(prepared.commit("claude-beta", { acceptNotice: true }), /provider_setup_expired/);
  assert.equal(f.writes, 0);
});

test("large OpenRouter discovery preserves all choices while respecting config's enabled-model bound", async () => {
  const f = fixture(fetchFn((url) => Response.json({ data: url.endsWith("/key") ? { label: "synthetic" } : Array.from({ length: 150 }, (_, n) => ({ id: `vendor/model-${n}` })) })));
  const prepared = await f.service.prepare("openrouter", KEY);
  assert.equal(prepared.models.length, 150);
  await prepared.commit("vendor/model-149", { acceptNotice: true });
  assert.deepEqual(f.config.providers.openrouter?.models, ["vendor/model-149"]);
});

test("discovery failure/redirect never saves a key, fabricates models or exposes provider body", async () => {
  for (const status of [401, 403, 429, 302, 500]) {
    const f = fixture(fetchFn((_url, init) => { assert.equal(init.redirect, "error"); return new Response(KEY, { status }); }));
    await assert.rejects(f.service.prepare("openrouter", KEY), (error: Error) => !error.message.includes(KEY) && error.message.startsWith("provider_"));
    assert.equal(f.writes, 0); assert.equal(f.secrets.values.size, 0);
  }
});

test("local runtime discovery accepts no key; custom endpoints reject embedded credentials", async () => {
  const f = fixture(fetchFn((url, init) => { assert.equal(url, "http://127.0.0.1:11434/v1/models"); assert.equal(new Headers(init.headers).has("authorization"), false); return Response.json({ data: [{ id: "local-code:latest" }] }); }));
  const prepared = await f.service.prepare("ollama");
  await prepared.commit("local-code:latest", { acceptNotice: true });
  assert.equal(f.config.providers.ollama?.enabled, true);
  assert.equal(await f.secrets.get("provider:ollama"), undefined);
  await assert.rejects(f.service.prepare("custom", KEY, "https://api.example.test/v1?api_key=secret"), /endpoint_credentials_forbidden/);
  await assert.rejects(f.service.prepare("custom", KEY, "http://api.example.test/v1"), /endpoint_https_required/);
});

test("daemon reload rejection never reports success and a retry does not repeat credential/config writes", async () => {
  let reloads = 0;
  const f = fixture(fetchFn(() => Response.json({ data: [{ id: "code", supported_endpoints: ["/v1/chat/completions"] }] })), { reload: async () => { if (++reloads === 1) throw new Error("daemon-not-current"); } });
  const prepared = await f.service.prepare("custom-openai", KEY);
  await assert.rejects(prepared.commit("code", { acceptNotice: true }), /provider_save_failed/);
  assert.equal(f.writes, 1);
  assert.equal((await prepared.commit("code", { acceptNotice: true })).reloaded, true);
  assert.equal(f.writes, 1);
});

test("after failed reload a different selected model updates config only, preserves prior models, and remains exclusive", async () => {
  const vault = new MemorySecretStore(); let secretWrites = 0; let reloads = 0;
  let unblockReload!: () => void;
  const reloading = new Promise<void>((resolve) => { unblockReload = resolve; });
  const f = fixture(fetchFn(() => Response.json({ data: [{ id: "model-a", supported_endpoints: ["/v1/chat/completions"] }, { id: "model-b", supported_endpoints: ["/v1/chat/completions"] }] })), {
    secrets: { get: (name) => vault.get(name), delete: (name) => vault.delete(name), set: async (name, value) => { secretWrites++; await vault.set(name, value); } },
    reload: async () => { if (++reloads === 1) throw new Error("temporary-unavailable"); await reloading; },
  });
  const prepared = await f.service.prepare("custom-openai", KEY);
  await assert.rejects(prepared.commit("model-a", { acceptNotice: true }), /provider_save_failed/);
  const before = structuredClone(f.config);
  const completion = prepared.commit("model-b", { acceptNotice: true });
  await assert.rejects(prepared.commit("model-a", { acceptNotice: true }), /provider_setup_busy/);
  unblockReload();
  assert.equal((await completion).modelId, "model-b");
  const entry = f.config.providers["custom-openai" as "custom"]!;
  assert.equal(entry.defaultModel, "model-b"); assert.deepEqual(entry.models, ["model-b", "model-a"]);
  assert.deepEqual(f.config.providers.groq, before.providers.groq);
  assert.deepEqual(f.config.providers.gemini, before.providers.gemini);
  assert.deepEqual(f.config.fallbackOrder, before.fallbackOrder);
  assert.equal(entry.endpointUrl, before.providers["custom-openai" as "custom"]!.endpointUrl);
  assert.equal(f.config.routingCombos?.["tui-custom-openai"]?.revision, 2);
  assert.deepEqual(f.config.routingCombos?.["tui-custom-openai"]?.modelOrder, ["model-b"]);
  assert.equal(secretWrites, 1); assert.equal(f.writes, 2); assert.equal(reloads, 2);
  assert.equal(await vault.get("provider:custom-openai"), KEY);
  await assert.rejects(prepared.commit("model-a", { acceptNotice: true }), /provider_setup_expired/);
});

test("config failure rolls the credential back, cancellation and duplicate commit cannot grant success", async () => {
  const f = fixture(fetchFn(() => Response.json({ data: [{ id: "code", supported_endpoints: ["/v1/chat/completions"] }] })), { updateConfig: async () => { throw new Error(KEY); } });
  await f.secrets.set("provider:custom-openai", "old_synthetic_key_123456789");
  const prepared = await f.service.prepare("custom-openai", KEY);
  await assert.rejects(prepared.commit("code", { acceptNotice: true }), /provider_save_failed/);
  assert.equal(await f.secrets.get("provider:custom-openai"), "old_synthetic_key_123456789");
  const controller = new AbortController(); controller.abort();
  await assert.rejects(f.service.prepare("custom-openai", KEY, undefined, controller.signal), /provider_discovery_cancelled/);
});

test("discovery deadline and response limits are enforced without metadata/key leaks", async () => {
  const timed = fixture(fetchFn((_url, init) => new Promise((_resolve, reject) => init.signal!.addEventListener("abort", () => reject(new Error(KEY)), { once: true }))), { timeoutMs: 5 });
  await assert.rejects(timed.service.prepare("openrouter", KEY), /provider_discovery_timeout/);
  const reflected = fixture(fetchFn((url) => Response.json({ data: url.endsWith("/key") ? { label: "synthetic" } : [{ id: KEY }, { id: "real", name: `Name ${KEY}` }, { id: "\u001b[31mattack" }] })));
  const prepared = await reflected.service.prepare("openrouter", KEY);
  assert.deepEqual(prepared.models, [{ id: "real" }]); prepared.dispose();
  assert.ok(PROVIDER_SETUP_PRESETS.some((p) => p.id === "custom-ovhcloud"));
  assert.ok(PROVIDER_SETUP_PRESETS.some((p) => p.id === "custom" && !p.endpointUrl));
});

test("custom manual fallback persists a declared model without pretending discovery or making inference", async () => {
  let requests = 0;
  const f = fixture(fetchFn(() => { requests++; return new Response(null, { status: 404 }); }));
  await assert.rejects(f.service.prepare("custom", KEY, "https://private-api.example.test/v1"), /provider_discovery_unsupported/);
  const prepared = await f.service.prepareManual("custom", KEY, "https://private-api.example.test/v1", "my-model");
  assert.equal(prepared.source, "declared"); assert.equal(requests, 1);
  await prepared.commit("my-model", { acceptNotice: true });
  assert.equal(f.config.providers.custom?.endpointUrl, "https://private-api.example.test/v1/chat/completions");
  assert.equal(f.config.providers.custom?.defaultModel, "my-model");
  await assert.rejects(f.service.prepareManual("custom", KEY, "https://private-api.example.test/v1", KEY), /provider_credential_in_metadata/);
});

test("OpenRouter validates credential separately from its public model catalog", async () => {
  const paths: string[] = [];
  const f = fixture(fetchFn((url) => { paths.push(url); return new Response(null, { status: 401 }); }));
  await assert.rejects(f.service.prepare("openrouter", KEY), /provider_key_rejected/);
  assert.deepEqual(paths, ["https://openrouter.ai/api/v1/key"]);
  assert.equal(f.writes, 0); assert.equal(f.secrets.values.size, 0);
});
