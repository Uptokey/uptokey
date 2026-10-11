#!/usr/bin/env node
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { canonicalHttpsOrigin, canonicalMagicDnsName } from "../src/tailnet-address.mjs";
import { TAILNET_EVIDENCE_CHECK_NAMES, TAILNET_EVIDENCE_SCHEMA_VERSION } from "../src/tailnet-evidence-contract.mjs";

const run = promisify(execFile);
const dashboardOrigin = process.env.UPTOKEY_DASHBOARD_ORIGIN;
if (process.platform !== "darwin") fail("tailnet_e2e_requires_macos");
if (!canonicalHttpsOrigin(dashboardOrigin)) fail("UPTOKEY_DASHBOARD_ORIGIN_https_required");
const [harnessBytes, addressAuthorityBytes] = await Promise.all([
  readFile(new URL(import.meta.url)),
  readFile(new URL("../src/tailnet-address.mjs", import.meta.url))
]);

const { stdout } = await run("tailscale", ["status", "--json"], { timeout: 10_000 });
const status = JSON.parse(stdout);
const dnsName = status?.Self?.DNSName?.replace(/\.$/, "");
if (!canonicalMagicDnsName(dnsName)) fail("tailscale_magicdns_unavailable");
const controlOrigin = `https://${dnsName}:21436`;

const checks = [];
await check("localhost_health", async () => expectStatus(await request("http://127.0.0.1:21435/health"), 200));
await check("localhost_rejects_browser_origin", async () => expectStatus(await request("http://127.0.0.1:21435/health", { headers: { origin: dashboardOrigin } }), 403));
await check("tailnet_preflight_pna", async () => {
  const response = await request(`${controlOrigin}/control/status`, { method: "OPTIONS", headers: { origin: dashboardOrigin, "access-control-request-method": "GET", "access-control-request-headers": "authorization", "access-control-request-private-network": "true" } });
  expectStatus(response, 204); expectHeader(response, "access-control-allow-origin", dashboardOrigin); expectHeader(response, "access-control-allow-methods", "GET"); expectHeader(response, "access-control-allow-headers", "authorization"); expectHeader(response, "access-control-allow-private-network", "true"); expectHeader(response, "cache-control", "no-store");
  expectVary(response, "Origin", "Access-Control-Request-Method", "Access-Control-Request-Headers", "Access-Control-Request-Private-Network");
});
await check("tailnet_preflight_rejects_unpublished_surface", async () => {
  for (const [path, method, headers] of [["/v1/chat/completions", "POST", "content-type"], ["/control/status", "POST", "authorization"], ["/control/pair/consume", "POST", "authorization, content-type"]]) {
    const response = await request(`${controlOrigin}${path}`, { method: "OPTIONS", headers: { origin: dashboardOrigin, "access-control-request-method": method, "access-control-request-headers": headers, "access-control-request-private-network": "true" } });
    expectStatus(response, 403); expectNoHeader(response, "access-control-allow-origin"); expectNoHeader(response, "access-control-allow-private-network");
  }
});
await check("tailnet_real_requests_enforce_method_and_media", async () => {
  const wrongMethod = await request(`${controlOrigin}/control/status`, { method: "POST", headers: { origin: dashboardOrigin, "content-type": "application/json" }, body: "{}" });
  expectStatus(wrongMethod, 405); expectHeader(wrongMethod, "allow", "GET"); expectHeader(wrongMethod, "access-control-allow-origin", dashboardOrigin);
  const statusWithMedia = await request(`${controlOrigin}/control/status`, { headers: { origin: dashboardOrigin, "content-type": "application/json" } });
  expectStatus(statusWithMedia, 400); expectHeader(statusWithMedia, "access-control-allow-origin", dashboardOrigin);
  const pairingWithWrongMedia = await request(`${controlOrigin}/control/pair/challenge`, { method: "POST", headers: { origin: dashboardOrigin, "content-type": "text/plain" }, body: "{}" });
  expectStatus(pairingWithWrongMedia, 415); expectHeader(pairingWithWrongMedia, "access-control-allow-origin", dashboardOrigin);
  const missingRoute = await request(`${controlOrigin}/control/not-published`, { headers: { origin: dashboardOrigin } });
  expectStatus(missingRoute, 404); expectHeader(missingRoute, "access-control-allow-origin", dashboardOrigin);
});
await check("tailnet_has_no_inference", async () => expectStatus(await request(`${controlOrigin}/v1/chat/completions`, { method: "POST", headers: { origin: dashboardOrigin, "content-type": "application/json" }, body: "{}" }), 404));
await check("tailnet_rejects_evil_origin_without_acao", async () => {
  const response = await request(`${controlOrigin}/control/status`, { headers: { origin: "https://evil.example" } }); expectStatus(response, 403);
  if (response.headers.has("access-control-allow-origin")) throw new Error("evil_origin_received_acao");
});
await check("tailnet_rejects_null_origin", async () => expectStatus(await request(`${controlOrigin}/control/status`, { headers: { origin: "null" } }), 403));
await check("tailnet_rejects_query_scope", async () => expectStatus(await request(`${controlOrigin}/control/status?scope=inference`, { headers: { origin: dashboardOrigin } }), 400));
await check("tailnet_rejects_local_inference_token", async () => expectStatus(await request(`${controlOrigin}/control/status`, { headers: { origin: dashboardOrigin, authorization: "Bearer utk_local_canary_never_valid" } }), 401));
await check("tailnet_rejects_plaintext_bootstrap", async () => {
  const response = await request(`${controlOrigin}/control/pair/challenge`, { method: "POST", headers: { origin: dashboardOrigin, "content-type": "application/json" }, body: JSON.stringify({ clientName: "e2e-canary", tenantId: "tenant-canary", deviceId: "device-canary", bootstrapToken: `utk_bootstrap_${"A".repeat(43)}` }) });
  expectStatus(response, 400); expectHeader(response, "cache-control", "no-store");
  const body = await response.json(); if (body?.error?.type !== "control_plaintext_bootstrap_rejected") throw new Error("plaintext_bootstrap_not_explicitly_rejected");
});

if (checks.length !== TAILNET_EVIDENCE_CHECK_NAMES.length || checks.some((entry, index) => entry.name !== TAILNET_EVIDENCE_CHECK_NAMES[index] || entry.passed !== true) || new Set(checks.map((entry) => entry.name)).size !== checks.length) fail("tailnet_e2e_check_inventory_invalid");
const evidence = {
  schemaVersion: TAILNET_EVIDENCE_SCHEMA_VERSION,
  testedAt: new Date().toISOString(),
  platform: process.platform,
  nodeVersion: process.version,
  dnsName,
  controlOrigin,
  dashboardOrigin,
  requestTimeoutMs: 8_000,
  harnessSha256: createHash("sha256").update(harnessBytes).digest("hex"),
  addressAuthoritySha256: createHash("sha256").update(addressAuthorityBytes).digest("hex"),
  checks
};
process.stdout.write(`${JSON.stringify(evidence, null, 2)}\n`);

async function check(name, operation) {
  const started = performance.now();
  try { await operation(); checks.push({ name, passed: true, durationMs: Math.round(performance.now() - started) }); }
  catch (error) { checks.push({ name, passed: false, error: error instanceof Error ? error.message : "unknown" }); process.stdout.write(`${JSON.stringify({ checks }, null, 2)}\n`); process.exit(1); }
}
function expectStatus(response, expected) { if (response.status !== expected) throw new Error(`expected_${expected}_received_${response.status}`); }
function expectHeader(response, name, expected) { if (response.headers.get(name) !== expected) throw new Error(`${name}_mismatch`); }
function expectNoHeader(response, name) { if (response.headers.has(name)) throw new Error(`${name}_unexpected`); }
function expectVary(response, ...expected) { const values = new Set((response.headers.get("vary") ?? "").split(",").map((value) => value.trim()).filter(Boolean)); for (const value of expected) if (!values.has(value)) throw new Error(`vary_missing_${value}`); }
async function request(url, init = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline_exceeded")), 8_000);
  try { return await fetch(url, { ...init, redirect: "error", signal: controller.signal }); }
  finally { clearTimeout(timer); }
}
function fail(reason) { process.stderr.write(`${reason}\n`); process.exit(2); }
