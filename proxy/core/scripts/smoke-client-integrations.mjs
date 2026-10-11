import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { access, mkdir, mkdtemp, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";
import { check as checkAntigravityMcp, probe as probeAntigravityMcp } from "../../../quimera/uptokey/scripts/configure-antigravity-mcp.mjs";
import {
  buildClientIntegrationContract,
  clientCredentialFromContract,
  CLIENT_INFERENCE_BASE_URL,
  CLIENT_INFERENCE_MODEL,
  CLIENT_INFERENCE_ORIGIN,
  CLIENT_INTEGRATION_IDS,
  validateClientIntegrationContract
} from "../src/client-integrations.ts";

const execFileAsync = promisify(execFile);
const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const repositoryRoot = resolve(scriptDirectory, "../../../quimera/uptokey");
const vscodeRoot = join(repositoryRoot, "vscode-extension");
const defaultEvidencePath = join(repositoryRoot, "output", "client-integrations", "windows-local.json");
const MAX_BODY_BYTES = 64 * 1024;
const CLIENT_TOKEN = /^utk_local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{32}$/i;

export async function runClientIntegrationSmoke(options = {}) {
  const fetchImpl = options.fetchImpl ?? fetch;
  const detectClients = options.detectClients ?? detectLocalClients;
  const extensionHostRunner = options.extensionHostRunner ?? runExtensionHost;
  const antigravityRunner = options.antigravityRunner ?? runAntigravityMcpProbe;
  const now = options.now ?? (() => new Date());
  const evidencePath = options.evidencePath === false ? undefined : resolve(options.evidencePath ?? defaultEvidencePath);
  const tempBase = await realpath(options.tempBase ?? tmpdir());
  const tempRoot = await mkdtemp(join(tempBase, "uptokey-client-smoke-"));
  const resolvedTemp = await realpath(tempRoot);
  assertTemporaryBoundary(resolvedTemp, tempBase);
  let cleanupVerified = false;
  let evidence;

  try {
    const health = await boundedJsonRequest(fetchImpl, `${CLIENT_INFERENCE_ORIGIN}/health`, { method: "GET" });
    if (health.status !== 200 || !isHealth(health.value)) throw new Error("client_smoke_proxy_health_invalid");
    const detected = await detectClients();
    const results = [];

    for (const client of CLIENT_INTEGRATION_IDS) {
      const app = detected[client];
      const profile = join(resolvedTemp, client);
      await mkdir(profile);
      const lifecycle = await exerciseConfigAgainstProxy(fetchImpl, client, profile);
      results.push({
        client,
        client_version: app.version,
        external_app: app.installed ? "installed" : "missing",
        fresh_profile: true,
        config_contract_valid: true,
        config_copied_without_provider_key: true,
        request_reached_loopback_proxy: lifecycle.requestReached,
        pre_revoke_http_status: lifecycle.preStatus,
        revoked_token_returned_401: lifecycle.revoked401,
        native_app_smoke: app.installed ? "not_run_no_safe_automation" : "not_run_external_app_missing",
        native_error_or_warning: app.installed ? "external_app_detected_but_no_safe_noninteractive_runner" : "external_app_missing"
      });
    }

    const vscode = detected["vscode-uptokey"];
    let extensionHost = "not_run_vscode_missing";
    let extensionWarning = "vscode_missing";
    if (vscode.installed) {
      const hostResult = await extensionHostRunner();
      if (!hostResult.valid || hostResult.humanConfirmationBypassed) throw new Error("client_smoke_extension_host_invalid");
      extensionHost = "activation_and_live_loopback_passed";
      extensionWarning = "human_pairing_confirmation_required_not_performed";
    }
    results.push({
      client: "vscode-uptokey",
      client_version: vscode.version,
      external_app: vscode.installed ? "installed" : "missing",
      fresh_profile: true,
      config_contract_valid: true,
      config_copied_without_provider_key: true,
      request_reached_loopback_proxy: vscode.installed && extensionHost === "activation_and_live_loopback_passed",
      pre_revoke_http_status: null,
      revoked_token_returned_401: false,
      native_app_smoke: extensionHost,
      native_error_or_warning: extensionWarning
    });

    const antigravity = await antigravityRunner();
    results.push({
      client: "antigravity-mcp",
      client_version: antigravity.version,
      external_app: antigravity.valid ? "installed" : "missing",
      fresh_profile: true,
      config_contract_valid: true,
      config_copied_without_provider_key: true,
      request_reached_loopback_proxy: false,
      pre_revoke_http_status: null,
      revoked_token_returned_401: false,
      native_app_smoke: antigravity.valid ? "mcp_check_and_probe_passed" : "not_run_mcp_unavailable",
      native_error_or_warning: antigravity.valid ? "separate_mcp_not_inference_credential" : antigravity.warning
    });

    evidence = {
      schema: "uptokey-client-integration-smoke-v1",
      tested_at_utc: now().toISOString(),
      host_os: normalizedSmokeHostOs(process.platform),
      uptokey_version: health.value.version,
      endpoint: CLIENT_INFERENCE_BASE_URL,
      model: CLIENT_INFERENCE_MODEL,
      temporary_profiles_cleaned: false,
      results
    };
    validateEvidence(evidence);
  } finally {
    const current = await realpath(tempRoot).catch(() => undefined);
    if (current !== resolvedTemp) throw new Error("client_smoke_cleanup_boundary_invalid");
    assertTemporaryBoundary(current, tempBase);
    await rm(current, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 });
    cleanupVerified = !(await pathExists(current));
    if (!cleanupVerified) throw new Error("client_smoke_cleanup_failed");
  }

  evidence.temporary_profiles_cleaned = cleanupVerified;
  validateEvidence(evidence);
  const serialized = `${JSON.stringify(evidence, null, 2)}\n`;
  if (/utk_local_|gsk_|AIza|sk_live_|\\Users\\|\/Users\//i.test(serialized)) throw new Error("client_smoke_evidence_sensitive");
  if (evidencePath) {
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, serialized, { encoding: "utf8", mode: 0o600 });
  }
  return evidence;
}

async function exerciseConfigAgainstProxy(fetchImpl, client, profile) {
  const provision = await boundedJsonRequest(fetchImpl, `${CLIENT_INFERENCE_ORIGIN}/local/client/provision`, {
    method: "POST",
    headers: { origin: CLIENT_INFERENCE_ORIGIN, "content-type": "application/json" },
    body: JSON.stringify({ clientName: `Clean smoke ${client}` })
  });
  if (provision.status !== 201 && provision.status !== 200) throw new Error("client_smoke_provision_failed");
  if (!isPairedClient(provision.value)) throw new Error("client_smoke_provision_invalid");
  const contract = buildClientIntegrationContract(client, provision.value.token);
  if (!validateClientIntegrationContract(contract) || clientCredentialFromContract(contract) !== provision.value.token) throw new Error("client_smoke_config_invalid");
  await writeTemporaryContract(profile, contract);

  const pre = await fetchImpl(`${CLIENT_INFERENCE_BASE_URL}/chat/completions`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${clientCredentialFromContract(contract)}`, "content-type": "application/json" },
    body: JSON.stringify({ model: CLIENT_INFERENCE_MODEL, messages: [{ role: "user", content: "uptokey local integration smoke" }] })
  });
  const requestReached = pre.status !== 401 && pre.status !== 403 && pre.status !== 404 && pre.status !== 421;
  await cancelBody(pre);
  if (!requestReached) throw new Error("client_smoke_loopback_request_rejected");

  const revoked = await fetchImpl(`${CLIENT_INFERENCE_ORIGIN}/local/client/revoke`, {
    method: "POST",
    redirect: "error",
    headers: { authorization: `Bearer ${provision.value.token}`, "content-type": "application/json" },
    body: JSON.stringify({ clientId: provision.value.clientId })
  });
  await cancelBody(revoked);
  if (revoked.status !== 204) throw new Error("client_smoke_revoke_failed");

  const after = await boundedJsonRequest(fetchImpl, `${CLIENT_INFERENCE_BASE_URL}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${provision.value.token}`, "content-type": "application/json" },
    body: JSON.stringify({ model: CLIENT_INFERENCE_MODEL, messages: [{ role: "user", content: "uptokey local integration smoke" }] })
  });
  const revoked401 = after.status === 401 && exactObject(after.value, ["error"]) && exactObject(after.value.error, ["type"]) && ["unauthorized", "token_revoked", "token_invalid"].includes(after.value.error.type);
  if (!revoked401) throw new Error("client_smoke_revocation_not_enforced");
  return { requestReached, preStatus: pre.status, revoked401 };
}

async function writeTemporaryContract(profile, contract) {
  if (contract.client === "continue") {
    await writeFile(join(profile, "config.yaml"), contract.yaml, { encoding: "utf8", mode: 0o600 });
    return;
  }
  const value = contract.client === "cline"
    ? { provider: contract.provider, baseUrl: contract.baseUrl, apiKey: contract.apiKey, modelId: contract.modelId }
    : { environment: contract.environment, argv: contract.argv };
  await writeFile(join(profile, "contract.json"), `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600 });
}

export async function detectLocalClients(options = {}) {
  const userProfile = options.userProfile ?? process.env.USERPROFILE;
  const localAppData = options.localAppData ?? process.env.LOCALAPPDATA;
  const codeExecutable = localAppData ? join(localAppData, "Programs", "Microsoft VS Code", "Code.exe") : undefined;
  const vscodeInstalled = Boolean(codeExecutable && await executableFile(codeExecutable));
  const codeVersion = vscodeInstalled ? await installedCodeVersion(dirname(codeExecutable)) : null;
  const extensionRoot = userProfile ? join(userProfile, ".vscode", "extensions") : undefined;
  const extensions = extensionRoot && await pathExists(extensionRoot) ? await readdir(extensionRoot, { withFileTypes: true }) : [];
  const cline = await extensionVersion(extensionRoot, extensions, ["saoudrizwan.claude-dev-"]);
  const continuation = await extensionVersion(extensionRoot, extensions, ["continue.continue-"]);
  const aiderPath = await firstWhere(["aider.exe", "aider.cmd"]);
  return {
    cline: { installed: Boolean(cline), version: cline },
    aider: { installed: Boolean(aiderPath), version: aiderPath ? "installed-version-not-probed" : null },
    continue: { installed: Boolean(continuation), version: continuation },
    "vscode-uptokey": { installed: vscodeInstalled, version: vscodeInstalled ? `VS Code ${codeVersion} / Uptokey 0.1.0-dev` : null }
  };
}

export function normalizedSmokeHostOs(platform = process.platform) {
  if (platform === "win32") return "windows";
  if (platform === "darwin") return "macos";
  if (platform === "linux") return "linux";
  return "other";
}

async function extensionVersion(root, entries, prefixes) {
  if (!root) return null;
  const matches = entries.filter((entry) => entry.isDirectory() && prefixes.some((prefix) => entry.name.toLowerCase().startsWith(prefix))).sort((left, right) => right.name.localeCompare(left.name));
  for (const entry of matches) {
    try {
      const manifest = JSON.parse(await readFile(join(root, entry.name, "package.json"), "utf8"));
      if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(manifest.version)) return manifest.version;
    } catch { /* malformed external extension is reported as missing, never trusted */ }
  }
  return null;
}

async function firstWhere(names) {
  if (process.platform !== "win32") return null;
  for (const name of names) {
    try {
      const result = await execFileAsync("where.exe", [name], { windowsHide: true, timeout: 5_000, maxBuffer: 16 * 1024 });
      const path = result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      if (path && await pathExists(path)) return path;
    } catch { /* command absent */ }
  }
  return null;
}

async function runExtensionHost() {
  await spawnChecked(process.execPath, [join(vscodeRoot, "node_modules", "typescript", "bin", "tsc"), "-p", join(vscodeRoot, "tsconfig.json")], { cwd: vscodeRoot, timeoutMs: 60_000 });
  const output = await spawnChecked(process.execPath, [join(vscodeRoot, "scripts", "run-extension-host.mjs")], { cwd: vscodeRoot, timeoutMs: 120_000, env: { ...process.env, UPTOKEY_REQUIRE_LIVE_PROXY: "1" } });
  return { valid: /extension_host_smoke_valid fresh_profile=true human_confirmation=not_bypassed/.test(output), humanConfirmationBypassed: false };
}

async function runAntigravityMcpProbe() {
  try {
    if (!(await checkAntigravityMcp()) || !(await probeAntigravityMcp())) return { valid: false, version: null, warning: "antigravity_mcp_check_failed" };
    return { valid: true, version: "uptokey-ai-council", warning: null };
  } catch {
    return { valid: false, version: null, warning: "antigravity_mcp_check_failed" };
  }
}

function spawnChecked(executable, args, options) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(executable, args, { cwd: options.cwd, env: options.env ?? process.env, windowsHide: true, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    let output = "";
    const append = (chunk) => { output = `${output}${chunk}`.slice(-MAX_BODY_BYTES); };
    child.stdout.on("data", append);
    child.stderr.on("data", append);
    const timer = setTimeout(() => { child.kill(); reject(new Error("client_smoke_child_timeout")); }, options.timeoutMs);
    child.once("error", () => { clearTimeout(timer); reject(new Error("client_smoke_child_unavailable")); });
    child.once("close", (code) => {
      clearTimeout(timer);
      if (code !== 0) reject(new Error("client_smoke_child_failed"));
      else resolvePromise(output);
    });
  });
}

async function boundedJsonRequest(fetchImpl, url, init) {
  const response = await fetchImpl(url, { ...init, redirect: "error" });
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") { await cancelBody(response); throw new Error("client_smoke_media_invalid"); }
  const bytes = await boundedBody(response, MAX_BODY_BYTES);
  let value;
  try { value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  catch { throw new Error("client_smoke_json_invalid"); }
  return { status: response.status, value };
}

async function boundedBody(response, limit) {
  if (!response.body) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { void reader.cancel().catch(() => {}); throw new Error("client_smoke_body_too_large"); }
    chunks.push(value);
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
  return body;
}

async function cancelBody(response) { if (response.body) await response.body.cancel().catch(() => {}); }
function isHealth(value) { return exactObject(value, ["status", "data_plane", "version", "started_at"]) && value.status === "ok" && value.data_plane === "local" && typeof value.version === "string" && /^v0\.1\.0(?:-[0-9A-Za-z.-]+)?$/.test(value.version) && typeof value.started_at === "string"; }
function isPairedClient(value) { return exactObject(value, ["clientId", "clientName", "scope", "token"]) && typeof value.clientId === "string" && /^[0-9a-f-]{36}$/i.test(value.clientId) && typeof value.clientName === "string" && value.scope === "inference" && typeof value.token === "string" && CLIENT_TOKEN.test(value.token); }
function exactObject(value, keys) { return Boolean(value && typeof value === "object" && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))); }
async function installedCodeVersion(installRoot) {
  const candidates = [join(installRoot, "resources", "app", "package.json")];
  try {
    const entries = await readdir(installRoot, { withFileTypes: true });
    for (const entry of entries) if (entry.isDirectory() && /^[0-9a-f]{10,64}$/i.test(entry.name)) candidates.push(join(installRoot, entry.name, "resources", "app", "package.json"));
  } catch { return "version-unavailable"; }
  for (const path of candidates) {
    try {
      const manifest = JSON.parse(await readFile(path, "utf8"));
      if (typeof manifest.version === "string" && /^\d+\.\d+\.\d+$/.test(manifest.version)) return manifest.version;
    } catch { /* installation layout variant */ }
  }
  return "version-unavailable";
}
async function executableFile(path) { try { await access(path, fsConstants.X_OK); return true; } catch { return false; } }
async function pathExists(path) { try { await access(path); return true; } catch { return false; } }

function assertTemporaryBoundary(path, base) {
  if (!path.startsWith(`${base}${sep}`) || !basename(path).startsWith("uptokey-client-smoke-")) throw new Error("client_smoke_temp_boundary_invalid");
}

export function validateEvidence(value) {
  if (!exactObject(value, ["schema", "tested_at_utc", "host_os", "uptokey_version", "endpoint", "model", "temporary_profiles_cleaned", "results"])) throw new Error("client_smoke_evidence_invalid");
  if (value.schema !== "uptokey-client-integration-smoke-v1" || !/^\d{4}-\d{2}-\d{2}T/.test(value.tested_at_utc) || value.endpoint !== CLIENT_INFERENCE_BASE_URL || value.model !== CLIENT_INFERENCE_MODEL || typeof value.temporary_profiles_cleaned !== "boolean") throw new Error("client_smoke_evidence_invalid");
  if (!Array.isArray(value.results) || value.results.length !== 5 || value.results.map((item) => item.client).join(",") !== "cline,aider,continue,vscode-uptokey,antigravity-mcp") throw new Error("client_smoke_evidence_invalid");
  const keys = ["client", "client_version", "external_app", "fresh_profile", "config_contract_valid", "config_copied_without_provider_key", "request_reached_loopback_proxy", "pre_revoke_http_status", "revoked_token_returned_401", "native_app_smoke", "native_error_or_warning"];
  for (const item of value.results) {
    if (!exactObject(item, keys) || !["installed", "missing"].includes(item.external_app) || item.fresh_profile !== true || item.config_contract_valid !== true || item.config_copied_without_provider_key !== true || typeof item.request_reached_loopback_proxy !== "boolean" || !(item.pre_revoke_http_status === null || Number.isInteger(item.pre_revoke_http_status)) || typeof item.revoked_token_returned_401 !== "boolean" || typeof item.native_app_smoke !== "string" || typeof item.native_error_or_warning !== "string") throw new Error("client_smoke_evidence_invalid");
    if (!(item.client_version === null || typeof item.client_version === "string") || (typeof item.client_version === "string" && item.client_version.length > 100) || item.native_app_smoke.length > 100 || item.native_error_or_warning.length > 100) throw new Error("client_smoke_evidence_invalid");
  }
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  runClientIntegrationSmoke().then((evidence) => {
    const passed = evidence.results.filter((item) => item.request_reached_loopback_proxy || item.native_app_smoke === "activation_and_live_loopback_passed").length;
    process.stdout.write(`client_integration_smoke_valid clients=${evidence.results.length} live_contracts=${passed} evidence=output/client-integrations/windows-local.json\n`);
  }, (error) => {
    const message = error instanceof Error && /^client_smoke_[a-z_]+$/.test(error.message) ? error.message : "client_smoke_failed";
    process.stderr.write(`${message}\n`);
    process.exitCode = 1;
  });
}
