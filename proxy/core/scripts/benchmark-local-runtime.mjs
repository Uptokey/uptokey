#!/usr/bin/env node
/** Bounded, opt-in local runtime benchmark. No prompts are sent unless --chat is supplied. */
import { performance } from "node:perf_hooks";

const args = new Map();
for (let i = 2; i < process.argv.length; i += 1) {
  const key = process.argv[i];
  if (key?.startsWith("--")) args.set(key, process.argv[i + 1]?.startsWith("--") ? true : process.argv[++i] ?? true);
}
if (args.has("--chat")) throw new Error("benchmark_chat_probe_requires_explicit_model_and_is_disabled");
const requestedRuntime = String(args.get("--runtime") ?? "ollama");
const runtimes = requestedRuntime === "all" ? ["ollama", "vllm"] : [requestedRuntime];
const results = [];
let exitCode = 0;
for (const runtime of runtimes) {
const root = String(args.get("--endpoint") ?? (runtime === "ollama" ? "http://127.0.0.1:11434" : "http://127.0.0.1:8000"));
let endpoint;
try { endpoint = new URL(root); } catch { console.log(JSON.stringify({ runtime, endpoint: root, healthy: false, error: "benchmark_local_endpoint_invalid" })); exitCode = 2; continue; }
if (endpoint.protocol !== "http:" || !["127.0.0.1", "localhost", "::1"].includes(endpoint.hostname)) { console.log(JSON.stringify({ runtime, endpoint: root, healthy: false, error: "benchmark_local_endpoint_must_be_loopback_http" })); exitCode = 2; continue; }
const path = runtime === "ollama" ? "/api/tags" : "/v1/models";
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 5000);
const started = performance.now();
try {
  const response = await fetch(new URL(path, endpoint), { redirect: "error", signal: controller.signal, headers: { accept: "application/json" } });
  const body = await response.text();
  if (body.length > 512 * 1024) throw new Error("benchmark_response_too_large");
  let parsed = null; try { parsed = JSON.parse(body); } catch { /* status still useful */ }
  const models = runtime === "ollama" ? (Array.isArray(parsed?.models) ? parsed.models : []) : (Array.isArray(parsed?.data) ? parsed.data : []);
  console.log(JSON.stringify({ runtime, endpoint: endpoint.origin, status: response.status, healthy: response.ok, latencyMs: Math.round(performance.now() - started), modelCount: models.length, models: models.slice(0, 32).map((m) => m?.name ?? m?.id).filter(Boolean), promptProbe: "disabled" }));
  if (!response.ok) exitCode = 2;
} catch (error) {
  console.log(JSON.stringify({ runtime, endpoint: endpoint.origin, healthy: false, latencyMs: Math.round(performance.now() - started), error: error?.name === "AbortError" ? "timeout" : "unreachable" }));
  exitCode = 2;
} finally { clearTimeout(timer); }
}
process.exitCode = exitCode;
