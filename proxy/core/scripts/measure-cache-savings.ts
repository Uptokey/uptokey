import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExactMatchCache } from "../src/exact-match-cache.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { Router } from "../src/router.ts";
import { QuotaLedger } from "../src/quota-ledger.ts";
import { defaultConfig } from "../src/config.ts";
import type { ChatCompletionRequest, ProviderAdapter } from "../src/types.ts";

// Synthetic requests only. The adapter never performs network I/O.
const directory = await mkdtemp(join(tmpdir(), "uptokey-cache-measure-"));
const secrets = new MemorySecretStore();
await secrets.set("provider:groq", "gsk_synthetic_measurement_only");
const config = structuredClone(defaultConfig);
config.providers.groq.enabled = true;
const request: ChatCompletionRequest = { model: "openai/gpt-oss-120b", messages: [{ role: "user", content: "Synthetic cache measurement" }], temperature: 0, max_tokens: 8 };
const samples = 10;
async function measure(cached: boolean) {
  const cache = cached ? new ExactMatchCache(secrets, join(directory, "cache.json")) : undefined;
  await cache?.initialize();
  const ledger = new QuotaLedger(join(directory, cached ? "cached-ledger.json" : "baseline-ledger.json"));
  await ledger.initialize();
  let upstreamCalls = 0;
  const adapter: ProviderAdapter = { name: "groq", async dispatch() {
    upstreamCalls++;
    return Response.json({ choices: [], usage: { prompt_tokens: 12, completion_tokens: 4, total_tokens: 16 } });
  } };
  const router = new Router(config, new Map([["groq", adapter]]), secrets, ledger, undefined, undefined, undefined, cache);
  for (let index = 0; index < samples; index++) {
    const response = await router.dispatch(request, { requestId: `measurement-${index}`, tenantId: "measurement" }, new AbortController().signal);
    assert.equal(response.status, 200);
    await response.json();
    if (cached && index === 0) {
      const deadline = Date.now() + 2_000;
      while (router.cacheMetrics().exactWrites !== 1 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
      assert.equal(router.cacheMetrics().exactWrites, 1, "cache write must finish before warm replay");
    }
  }
  return { upstreamCalls, cache: router.cacheMetrics(), reportedTokens: router.usageMetrics().providers[0]?.totalTokens };
}
const baseline = await measure(false);
const cached = await measure(true);
assert.equal(baseline.upstreamCalls, samples);
assert.equal(cached.upstreamCalls, 1);
assert.equal(cached.reportedTokens, 16);
console.log(JSON.stringify({ scenario: "ten_identical_sequential_requests_with_warm_cache", synthetic: true, paidCalls: 0, samples, baseline, cached, avoidedCalls: baseline.upstreamCalls - cached.upstreamCalls, limitations: "No real pricing, latency, concurrent traffic, or production hit rate measured." }, null, 2));
