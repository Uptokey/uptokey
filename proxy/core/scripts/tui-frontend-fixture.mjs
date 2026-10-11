/**
 * Isolated real core for the terminal-frontend journeys.
 * Boots the real app (auth, Router, conversations, workspace/W5) on an ephemeral loopback port with a scripted
 * model upstream. Never touches the user's daemon, vault or data: every store lives in a temporary directory.
 *
 *   node --experimental-strip-types scripts/tui-frontend-fixture.mjs <workdir>
 *
 * Prints one JSON line {baseUrl, token, privateKeyPem, cwd, model, provider} once ready, then keeps serving.
 */
import { createServer } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { generateKeyPairSync } from "node:crypto";
import { serve } from "@hono/node-server";
import { defaultConfig, ensureUserDefinedProviderEntry, loadConfig, saveConfig } from "../src/config.ts";
import { isProvider } from "../src/provider-registry.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { QuotaLedger } from "../src/quota-ledger.ts";
import { Router } from "../src/router.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";

const base = resolve(process.argv[2] ?? ".");
const empty = process.argv.includes("--empty");
await mkdir(base, { recursive: true });
process.env.UPTOKEY_QUIMERA_DATA_DIR ??= join(base, "data");
process.env.UPTOKEY_SETTINGS_DIR ??= join(base, "settings");
process.env.UPTOKEY_AUTOMATIONS_DIR ??= join(base, "automations");
const cwd = join(base, "project");
await mkdir(cwd, { recursive: true });
await writeFile(join(cwd, "math.js"), "export const sum = (a, b) => a - b;\n");
const cwdB = join(base, "project-b");
await mkdir(cwdB, { recursive: true });
await writeFile(join(cwdB, "NOTAS.md"), ["# Notas", "", "Marcador MARKER_B_4410 que nao esta no pedido.", ""].join("\n"));
await writeFile(join(cwd, "README.md"), "# Projeto de teste\n\nMarcador FIXTURE_MARKER_7731.\n");

// Path of every chat request the scripted upstream received (J04 checks which provider endpoint a turn reached).
const chatRequests = [];
const typesafeRequests = [];
const transcriptionRequests = [];
const LONG = Array.from({ length: 160 }, (_, index) => `LINHA_${String(index + 1).padStart(3, "0")} conteúdo da resposta longa.`).join("\n");
const upstream = createServer(async (request, response) => {
  const chunks = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (request.url === "/v1/audio/transcriptions") {
    // Scripted speech-to-text (OpenAI-compatible, verbose_json) behind the core's transcription service.
    transcriptionRequests.push({ bytes: Buffer.concat(chunks).length, auth: request.headers.authorization ?? null, contentType: request.headers["content-type"] ?? null });
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ task: "transcribe", language: "portuguese", duration: 1, text: "Transcrição fixture VOZ_7788 do arquivo", segments: [{ id: 0, start: 0, end: 1, text: "Transcrição fixture VOZ_7788 do arquivo" }] }));
    return;
  }
  if (request.url === "/__transcriptions") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(transcriptionRequests));
    return;
  }
  const body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
  const last = [...(body.messages ?? [])].reverse().find((message) => message.role === "user");
  const prompt = typeof last?.content === "string" ? last.content : JSON.stringify(last?.content ?? "");
  if (request.url === "/__requests") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(chatRequests));
    return;
  }
  if (request.url === "/web/guia") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end("<html><head><title>Guia fixture</title></head><body><h1>Guia</h1><p>Conteudo publico WEB_MARKER_5511 da pagina.</p></body></html>");
    return;
  }
  if (request.url === "/__typesafe") {
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(typesafeRequests));
    return;
  }
  if (request.url === "/typesafe/v1/systemone") {
    // Scripted Jev (System One): typed answers by question id; a request mentioning APAGUE_TUDO is destructive.
    typesafeRequests.push({ auth: request.headers.authorization ?? null, questions: Object.keys(body.questions ?? {}), model: body.model ?? null });
    const text = JSON.stringify(body.state ?? {});
    const destructive = /APAGUE_TUDO|rm -rf/.test(text);
    const answers = {};
    for (const [id, question] of Object.entries(body.questions ?? {})) {
      if (question.type === "choice") {
        const choice = destructive ? "destructive_action" : Object.keys(question.criteria ?? {})[0] ?? "conversation";
        answers[id] = { type: "choice", choice, probabilities: { [choice]: 0.9 }, confidence: 0.9 };
      } else if (question.type === "score") answers[id] = { type: "score", score: 0.5, confidence: 0.8 };
      else answers[id] = { type: "noul", noul: id === "is_aligned" ? 0.93 : destructive ? 0.95 : 0.06 };
    }
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ model: "jev-latest", answers, usage: { input_tokens: 64, output_tokens: 4 } }));
    return;
  }
  if (!request.url?.endsWith("/models")) chatRequests.push({ path: request.url, model: body.model ?? null, toolResult: [...(body.messages ?? [])].reverse().find((message) => message.role === "tool")?.content?.toString().slice(0, 600) ?? null });
  if (request.url?.endsWith("/models")) {
    response.writeHead(request.headers.authorization === "Bearer fixture_key_canary_91" ? 200 : 401, { "content-type": "application/json" });
    response.end(JSON.stringify({ data: [{ id: "fixture-coder" }, { id: "fixture-small" }] }));
    return;
  }
  if (body.stream === false) {
    // Non-streaming completion (delegation members, summaries): one JSON body like an OpenAI-compatible provider.
    const content = `Resposta do modelo ${body.model ?? "?"} para: ${prompt.slice(0, 120)}`;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify({ id: `cmpl-${Date.now()}`, object: "chat.completion", created: Math.floor(Date.now() / 1000), model: body.model, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }], usage: { prompt_tokens: 20, completion_tokens: 12, total_tokens: 32 } }));
    return;
  }
  response.writeHead(200, { "content-type": "text/event-stream" });
  const send = (content) => response.write(`data: ${JSON.stringify({ choices: [{ delta: { content }, finish_reason: null }] })}\n\n`);
  // Only a tool result of the current turn (after the last user message) counts; earlier turns stay history.
  const lastUserIndex = (body.messages ?? []).map((message) => message.role).lastIndexOf("user");
  const toolMessage = (body.messages ?? []).slice(lastUserIndex + 1).reverse().find((message) => message.role === "tool");
  if (prompt.includes("PASTA_B") && !toolMessage && Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === "read_file")) {
    const call = { index: 0, id: "read-b-1", type: "function", function: { name: "read_file", arguments: JSON.stringify({ path: "NOTAS.md" }) } };
    response.end(["data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] }), "", "data: [DONE]", "", ""].join("\n"));
    return;
  }
  for (const [marker, toolName, args] of [["LER_MCP", "mcp_read_text_file", { relativePath: "nota-mcp.txt", lineLimit: 20 }], ["LER_WEB", "web_fetch", { url: "https://docs.example.com/guia" }], ["BUSCAR_WEB", "web_search", { query: "Uptokey", maxResults: 3 }]]) {
    if (prompt.includes(marker) && !toolMessage && Array.isArray(body.tools) && body.tools.some((tool) => tool.function?.name === toolName)) {
      const call = { index: 0, id: `${toolName}-1`, type: "function", function: { name: toolName, arguments: JSON.stringify(args) } };
      response.end(["data: " + JSON.stringify({ choices: [{ delta: { tool_calls: [call] }, finish_reason: "tool_calls" }] }), "", "data: [DONE]", "", ""].join(String.fromCharCode(10)));
      return;
    }
  }
  if (prompt.includes("BUSCAR_WEB") && toolMessage) {
    // J18: the result of a real metasearch (local SearXNG): report how many rows came back and the engine.
    const content = String(toolMessage.content);
    const rows = (content.match(/https?:\/\//g) ?? []).length;
    send(`Busca devolveu ${rows} fontes (${/searxng/i.test(content) ? "searxng" : /brave/i.test(content) ? "brave" : "motor desconhecido"})` + String.fromCharCode(10));
  } else if ((prompt.includes("LER_MCP") || prompt.includes("LER_WEB")) && toolMessage) {
    const content = String(toolMessage.content);
    const seen = ["MCP_MARKER_9123", "WEB_MARKER_5511"].filter((marker) => content.includes(marker));
    send(`Ferramenta devolveu: ${seen.length ? seen.join(", ") : "nenhum marcador"}` + String.fromCharCode(10));
  } else if (prompt.includes("PASTA_B") && toolMessage) {
    const seen = String(toolMessage.content).includes("MARKER_B_4410") ? "MARKER_B_4410" : "nenhum marcador";
    send(`Marcador lido pela ferramenta: ${seen}` + "\n");
  } else if (/ENORME\d+/.test(prompt)) {
    const total = Number(prompt.match(/ENORME(\d+)/)[1]);
    for (let start = 0; start < total; start += 200) {
      const chunk = Array.from({ length: Math.min(200, total - start) }, (_, offset) => `Linha ${String(start + offset + 1).padStart(6, "0")} da resposta enorme com algum conteúdo útil.`);
      send(chunk.join("\n") + "\n");
      await new Promise((done) => setTimeout(done, 5));
    }
  } else if (prompt.includes("UNICODE")) {
    send("Texto: Olá, 世界! café 👨‍👩‍👧 fim\n");
  } else if (prompt.includes("CRIE_APP")) {
    const block = (path, lang, body) => [path, "```" + lang, "<<<<<<< SEARCH", "=======", ...body, ">>>>>>> REPLACE", "```", ""].join("\n");
    send([
      "Vou criar o app em três arquivos.",
      "",
      block("package.json", "json", ["{", "  \"name\": \"app-soma\",", "  \"version\": \"1.0.0\",", "  \"private\": true,", "  \"scripts\": { \"test\": \"node test/soma.test.js\", \"build\": \"node build.js\" }", "}"]),
      block("src/soma.js", "js", ["export function soma(a, b) {", "  return a + b;", "}"]),
      block("test/soma.test.js", "js", ["import { soma } from '../src/soma.js';", "if (soma(2, 3) !== 5) { console.error('APP_TEST_FAIL'); process.exit(1); }", "console.log('APP_TEST_OK');"]),
      block("build.js", "js", ["import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';", "import { join } from 'node:path';", "import { tmpdir } from 'node:os';", "const out = join(tmpdir(), 'dist');", "mkdirSync(out, { recursive: true });", "writeFileSync(join(out, 'index.html'), '<h1>soma</h1>');", "if (!readFileSync(join(out, 'index.html'), 'utf8').includes('soma')) process.exit(1);", "console.log('APP_BUILD_OK');"]),
    ].join("\n"));
  } else if (prompt.includes("CODIGO_EXEMPLO")) {
    send(["Exemplo:", "", "```js", "const saudação = \"olá 世界\";", "console.log(saudação);", "```", "", "Fim do exemplo."].join("\n"));
  } else if (prompt.includes("CORRIJA_SOMA")) {
    const edit = ["math.js", "```js", "<<<<<<< SEARCH", "export const sum = (a, b) => a - b;", "=======", "export const sum = (a, b) => a + b;", ">>>>>>> REPLACE", "```", ""].join("\n");
    for (const piece of edit.match(/.{1,16}/gs)) { send(piece); await new Promise((done) => setTimeout(done, 10)); }
  } else if (prompt.includes("LONGA")) {
    for (const line of LONG.split("\n")) { send(`${line}\n`); await new Promise((done) => setTimeout(done, 25)); }
  } else if (prompt.includes("QUEBRA_REDE")) {
    // Connection drops mid-answer (no finish_reason, no [DONE]): the partial text must survive and be marked incomplete.
    send("Parte inicial PARCIAL_8812 antes da queda\n");
    await new Promise((done) => setTimeout(done, 300));
    request.socket.destroy();
    return;
  } else if (prompt.includes("SILENCIO")) {
    send("inicio\n"); await new Promise((done) => setTimeout(done, 4000)); send("fim\n");
  } else {
    const text = `Resposta do modelo de teste para: ${prompt.slice(0, 80)}\n\n\`\`\`js\nconsole.log("ok")\n\`\`\`\n`;
    for (const piece of text.match(/.{1,12}/gs) ?? [text]) { send(piece); await new Promise((done) => setTimeout(done, 10)); }
  }
  response.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 12, completion_tokens: 34, total_tokens: 46 } })}\n\ndata: [DONE]\n\n`);
});
await new Promise((resolveListening, reject) => { upstream.once("error", reject); upstream.listen(0, "127.0.0.1", resolveListening); });
const upstreamPort = upstream.address().port;

const config = structuredClone(defaultConfig);
for (const provider of Object.values(config.providers)) provider.enabled = false;
const providerId = ["custom", "fixture"].join("-");
if (!isProvider(providerId)) throw new Error("fixture provider id not accepted");
if (!empty) {
  ensureUserDefinedProviderEntry(config, providerId);
  Object.assign(config.providers[providerId], {
    enabled: true, configured: true, models: ["fixture-coder", "fixture-small"], defaultModel: "fixture-coder",
    endpointUrl: `http://127.0.0.1:${upstreamPort}/${providerId}/v1/chat/completions`,
    budget: { rpm: 600, tpm: 10_000_000, source: "account_user_input" },
  });
  config.fallbackOrder = [providerId];
  if (process.argv.includes("--homonym")) {
    // A second account whose catalogue has a model with the same name: only the chosen destination may be reached.
    const second = ["custom", "fixture", "dois"].join("-");
    if (!isProvider(second)) throw new Error("second fixture provider id not accepted");
    ensureUserDefinedProviderEntry(config, second);
    Object.assign(config.providers[second], {
      enabled: true, configured: true, models: ["fixture-coder"], defaultModel: "fixture-coder",
      endpointUrl: `http://127.0.0.1:${upstreamPort}/${second}/v1/chat/completions`,
      budget: { rpm: 600, tpm: 10_000_000, source: "account_user_input" },
    });
    config.fallbackOrder = [providerId, second];
  }
} else {
  // First-run profile: the real config file (isolated settings dir) is what provider onboarding writes and the core reloads.
  await saveConfig(config);
}

// J21 restarts the core process on the same profile: with --persist-secrets the fixture's synthetic vault and its
// pairing survive the restart in a JSON file of the fixture directory (test data only; the product uses the
// native vault).
const secretsFile = join(base, "fixture-secrets.json");
const persistSecrets = process.argv.includes("--persist-secrets");
class FixtureFileSecretStore extends MemorySecretStore {
  async set(account, value) { await super.set(account, value); await writeFile(secretsFile, JSON.stringify(Object.fromEntries(this.values))); }
  async delete(account) { await super.delete(account); await writeFile(secretsFile, JSON.stringify(Object.fromEntries(this.values))); }
}
const secrets = persistSecrets ? new FixtureFileSecretStore() : new MemorySecretStore();
if (persistSecrets) {
  try { for (const [account, value] of Object.entries(JSON.parse(await readFile(secretsFile, "utf8")))) secrets.values.set(account, value); }
  catch { /* first start */ }
}
const admin = `utk_local_${"F".repeat(32)}`;
await secrets.set("local:api-token", admin);
// A connected provider holds a credential in the vault; delegation resolves connections only when it is present.
if (!empty) await secrets.set(`provider:${providerId}`, "fixture_provider_credential_000000000000");
if (!empty && process.argv.includes("--homonym")) await secrets.set(`provider:${["custom", "fixture", "dois"].join("-")}`, "fixture_provider_credential_111111111111");
const ledger = new QuotaLedger(join(base, "ledger.json")); await ledger.initialize();
const router = new Router(config, new Map(), secrets, ledger);
const { createApp, ALLOWED_HOSTS } = await import("../src/app.ts");
const options = [config, router, secrets, async () => ({ allowed: false, code: "offline_grace_expired" })];
options[8] = empty ? loadConfig : async () => config;
options[13] = new WorkspaceStore(secrets, join(base, "workspace"));
if (process.argv.includes("--tools")) {
  // J18: the official MCP filesystem server on a separate root, and the core's own web service with DNS and transport
  // pointed at the scripted upstream (the page is served locally; no request leaves the machine).
  const mcpRoot = join(base, "mcp-root");
  await mkdir(mcpRoot, { recursive: true });
  await writeFile(join(mcpRoot, "nota-mcp.txt"), "Nota do servidor MCP: MCP_MARKER_9123" + String.fromCharCode(10));
  const { createFilesystemProfile } = await import("../src/filesystem-launch.ts");
  options[19] = await createFilesystemProfile(mcpRoot, base, resolve("../integracoes/mcp-filesystem/node_modules/@modelcontextprotocol/server-filesystem"));
  options[31] = {
    dnsLookup: async () => [{ address: "93.184.216.34", family: 4 }],
    fetchFn: (url, init) => (String(url).startsWith("https://docs.example.com/") ? fetch(`http://127.0.0.1:${upstreamPort}/web/${String(url).slice("https://docs.example.com/".length)}`, init) : Promise.reject(new Error("fixture_web_denied"))),
  };
}
// Jev through the core: the official endpoint is redirected to the scripted System One (no paid call).
options[29] = { secrets, fetchFn: (url, init) => (String(url) === "https://api.typesafe.ai/v1/systemone" ? fetch(`http://127.0.0.1:${upstreamPort}/typesafe/v1/systemone`, init) : fetch(url, init)) };
if (process.argv.includes("--voice")) {
  // J19: audio transcription through the core's own service (9router worker, provider "custom", W5 plan, receipt);
  // only the speech-to-text endpoint is scripted. Microphone capture and playback need audio devices (not in CI).
  const { userDefinedProviderDefaults } = await import("../src/config.ts");
  config.providers.custom ??= userDefinedProviderDefaults("custom");
  Object.assign(config.providers.custom, { enabled: true, configured: true, endpointUrl: `http://127.0.0.1:${upstreamPort}/v1/chat/completions`, models: ["openai/fixture-whisper"], defaultModel: "openai/fixture-whisper", budget: { rpm: 600, tpm: 10_000_000, source: "account_user_input" } });
  // The core validates the configuration as a whole: two providers are needed for a valid fallback order.
  if (!config.fallbackOrder.includes("custom")) config.fallbackOrder = [...config.fallbackOrder, "custom"];
  await secrets.set("provider:custom", "fixture_custom_credential_00000000");
  const { startConfiguredTranscription } = await import("../src/transcription-profile.ts");
  options[27] = (await startConfiguredTranscription({ endpoint: `http://127.0.0.1:${upstreamPort}/v1/audio/transcriptions`, model: "openai/fixture-whisper" }, { config, secrets, store: options[13] })).transcription;
}
const app = createApp(...options); await app.workspaceReady;
const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request, env) => app.fetch(request, env) });
await new Promise((resolveListening, reject) => { if (server.listening) resolveListening(); else { server.once("listening", resolveListening); server.once("error", reject); } });
const port = server.address().port;
ALLOWED_HOSTS.add(`127.0.0.1:${port}`);
// J21: a relay in front of the core (scripts/lib/core-proxy.mjs) is reached under its own loopback host.
for (let index = process.argv.indexOf("--allow-host"); index >= 0; index = process.argv.indexOf("--allow-host", index + 1)) {
  const host = process.argv[index + 1];
  if (host && /^127\.0\.0\.1:\d+$/.test(host)) ALLOWED_HOSTS.add(host);
}
const baseUrl = `http://127.0.0.1:${port}`;

const post = async (path, body, token) => {
  const result = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
  const value = await result.json();
  if (!result.ok) throw new Error(`${path}: ${JSON.stringify(value)}`);
  return value;
};
// A restarted fixture keeps the pairing it made before (same identity, same token), like a daemon restart.
const pairingFile = join(base, "fixture-pairing.json");
let pairing = null;
if (persistSecrets) {
  try { pairing = JSON.parse(await readFile(pairingFile, "utf8")); } catch { pairing = null; }
}
if (!pairing) {
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const challenge = await post("/local/pair/challenge", { clientName: "tui-frontend-fixture", audience: "tui" });
  await post("/local/pair/approve", { id: challenge.id, userCode: challenge.userCode, audience: "tui" }, admin);
  const paired = await post("/local/pair/consume", { id: challenge.id, publicJwk: keys.publicKey.export({ format: "jwk" }) });
  pairing = { token: paired.token, privateKeyPem: keys.privateKey.export({ type: "pkcs8", format: "pem" }) };
  if (persistSecrets) await writeFile(pairingFile, JSON.stringify(pairing));
}

process.stdout.write(`${JSON.stringify({
  baseUrl, token: pairing.token, privateKeyPem: pairing.privateKeyPem,
  cwd, cwdB, provider: providerId, model: "fixture-coder", upstreamPort, admin, empty,
  dirs: { data: process.env.UPTOKEY_QUIMERA_DATA_DIR, settings: process.env.UPTOKEY_SETTINGS_DIR, automations: process.env.UPTOKEY_AUTOMATIONS_DIR },
})}\n`);
process.stdin.resume();
process.stdin.on("end", async () => { await app.closeWorkspace(); process.exit(0); });
