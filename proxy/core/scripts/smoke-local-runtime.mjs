import { connect } from "node:net";
import { pathToFileURL } from "node:url";
import { readFile, readdir, stat } from "node:fs/promises";

const TIMEOUT_MS = 5_000;

export async function verifyLocalRuntime(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const portListening = options.portListening ?? isPortListening;
  const latestProxySourceMtimeMs = options.latestProxySourceMtimeMs ?? await latestTreeMtime(new URL("../src/", import.meta.url));
  const latestControlPlaneSourceMtimeMs = options.latestControlPlaneSourceMtimeMs ?? await latestTreeMtime(new URL("../../../quimera/uptokey/control-plane/src/", import.meta.url));
  const expectedPublishedThrough = options.expectedPublishedThrough ?? await currentPublishedThrough();
  const requestTimeoutMs = options.requestTimeoutMs ?? TIMEOUT_MS;
  const checks = [
    ["dashboard_landing", check(fetchImpl, "http://127.0.0.1:3000/", { status: 200, type: "text/html", containsAll: ['data-locale="en"', "Your free keys, one API.", "This does not protect a device already compromised", '<link rel="canonical" href="https://uptokey.com/en"', 'hrefLang="x-default" href="https://uptokey.com/en"'] }, requestTimeoutMs)],
    ["dashboard_control_plane", check(fetchImpl, "http://127.0.0.1:3000/app", { status: 200, type: "text/html", containsAll: ['id="overview"', "Seu roteador, neste Mac.", "Suas chaves ficam no seu dispositivo."] }, requestTimeoutMs)],
    ["dashboard_revision", check(fetchImpl, "http://127.0.0.1:3000/project", { status: 200, type: "text/html", containsAll: ["Evolução do projeto", `data-published-through="${expectedPublishedThrough}"`] }, requestTimeoutMs)],
    ["dashboard_enrollment", check(fetchImpl, "http://127.0.0.1:3000/enroll", { status: 200, type: "text/html", containsAll: ["Confirme este Mac.", "Chaves de providers, prompts e respostas não entram neste fluxo."] }, requestTimeoutMs)],
    ["proxy_health", check(fetchImpl, "http://127.0.0.1:21435/health", { status: 200, type: "application/json", cache: "no-store", validateJson: (value) => validProxyHealth(value, latestProxySourceMtimeMs) }, requestTimeoutMs)],
    ["proxy_inference_boundary", check(fetchImpl, "http://127.0.0.1:21435/v1/chat/completions", { status: 401, type: "application/json", cache: "no-store", json: { error: { type: "unauthorized" } }, init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"messages":[]}' } }, requestTimeoutMs)],
    ["control_health", check(fetchImpl, "http://127.0.0.1:18787/health", { status: 200, type: "application/json", cache: "no-store", validateJson: (value) => validControlPlaneHealth(value, latestControlPlaneSourceMtimeMs) }, requestTimeoutMs)],
    ["control_readiness", check(fetchImpl, "http://127.0.0.1:18787/ready", { status: 200, type: "application/json", cache: "no-store", json: { status: "ready" } }, requestTimeoutMs)],
    ["control_inference_boundary", check(fetchImpl, "http://127.0.0.1:18787/v1/chat/completions", { status: 404, cache: "no-store", init: { method: "POST", headers: { "content-type": "application/json" }, body: '{"messages":[]}' } }, requestTimeoutMs)],
    ["dashboard_auth_boundary", check(fetchImpl, "http://127.0.0.1:3000/api/devices", { status: 401, type: "application/json", cache: "no-store", json: { error: "unauthorized" } }, requestTimeoutMs)],
  ];
  const results = await Promise.all(checks.map(([, operation]) => operation));
  const failed = results.findIndex((valid) => !valid);
  if (failed >= 0) throw new Error(`runtime_boundary_invalid:${checks[failed][0]}`);
  if (await portListening(21436)) throw new Error("runtime_boundary_invalid:tailnet_closed");
  return "runtime_boundaries_valid";
}

async function check(fetchImpl, url, expected, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("deadline_exceeded")), timeoutMs);
  try {
    const response = await fetchImpl(url, { ...expected.init, redirect: "error", signal: controller.signal });
    if (response.status !== expected.status || expected.cache && response.headers.get("cache-control") !== expected.cache) return false;
    const type = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
    if (expected.type && type !== expected.type) return false;
    const bytes = await readBoundedBody(response, 256 * 1024);
    if (!bytes) return false;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (expected.containsAll && !expected.containsAll.every((value) => text.includes(value))) return false;
    const parsed = expected.json || expected.validateJson ? JSON.parse(text) : undefined;
    if (expected.json && JSON.stringify(parsed) !== JSON.stringify(expected.json)) return false;
    if (expected.validateJson && !expected.validateJson(parsed)) return false;
    return true;
  } catch { return false; }
  finally { clearTimeout(timer); }
}

function validProxyHealth(value, latestProxySourceMtimeMs) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "data_plane,started_at,status,version") return false;
  if (value.status !== "ok" || value.data_plane !== "local" || typeof value.version !== "string" || !/^v0\.1\.0(?:-[0-9A-Za-z.-]+)?$/.test(value.version) || typeof value.started_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.started_at)) return false;
  const startedAt = Date.parse(value.started_at);
  return Number.isFinite(startedAt) && startedAt >= latestProxySourceMtimeMs;
}

function validControlPlaneHealth(value, latestControlPlaneSourceMtimeMs) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).sort().join(",") !== "plane,started_at,status") return false;
  if (value.status !== "ok" || value.plane !== "control" || typeof value.started_at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(value.started_at)) return false;
  const startedAt = Date.parse(value.started_at);
  return Number.isFinite(startedAt) && startedAt >= latestControlPlaneSourceMtimeMs;
}

async function latestTreeMtime(directory) {
  let latest = 0;
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const target = new URL(entry.name + (entry.isDirectory() ? "/" : ""), directory);
    if (entry.isDirectory()) latest = Math.max(latest, await latestTreeMtime(target));
    else if (entry.isFile()) latest = Math.max(latest, (await stat(target)).mtimeMs);
  }
  return latest;
}

async function currentPublishedThrough() {
  const source = await readFile(new URL("../../../quimera/uptokey/dashboard/src/lib/project-progress.ts", import.meta.url), "utf8");
  const match = /publishedThrough:\s*(\d{1,9})\s*,/.exec(source);
  if (!match) throw new Error("project_progress_revision_invalid");
  return Number(match[1]);
}

async function readBoundedBody(response, limit) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) {
      void reader.cancel().catch(() => {});
      return undefined;
    }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function isPortListening(port) {
  return new Promise((resolve) => {
    const socket = connect({ host: "127.0.0.1", port });
    const finish = (listening) => { socket.destroy(); resolve(listening); };
    socket.setTimeout(1_000, () => finish(false));
    socket.once("connect", () => finish(true));
    socket.once("error", () => finish(false));
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  verifyLocalRuntime().then((result) => process.stdout.write(`${result}\n`), (error) => { const message = error instanceof Error && /^runtime_boundary_invalid:[a-z_]+$/.test(error.message) ? error.message : "runtime_boundary_invalid"; process.stderr.write(`${message}\n`); process.exitCode = 1; });
}
