/** Real native model tool loop/core HTTP/W5; the OCI boundary is a test fixture.
 * No model service, paid API or generated host command is used by these tests.
 */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { serve } from "@hono/node-server";
import { defaultConfig, ensureUserDefinedProviderEntry } from "../src/config.ts";
import { isProvider } from "../src/provider-registry.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { QuotaLedger } from "../src/quota-ledger.ts";
import { Router } from "../src/router.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { ProjectOciBackend } from "../src/workspace/project-oci.ts";
import { TuiController } from "../src/tui/controller.ts";
import { composeHistory } from "../src/tui/conversations.ts";

const model = "fixture-command-coder";
const output = "fixture process output 836172";
const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
async function waitFor(check: () => boolean, describe?: () => unknown) {
  for (let i = 0; i < 800; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`Expected state was not reached${describe ? `: ${JSON.stringify(describe())}` : ""}`);
}

async function setup(t: TestContext, available = true, twoCalls = true, development = false, finalGate?: { opened: () => void; wait: Promise<void> }, runGate?: { opened: () => void; wait: Promise<void>; stopped: () => void }, commandExitCode = 0) {
  assert.ok(process.env.UPTOKEY_QUIMERA_DATA_DIR, "use the isolated launcher");
  await mkdir(process.env.UPTOKEY_QUIMERA_DATA_DIR, { recursive: true });
  const base = await mkdtemp(join(process.env.UPTOKEY_QUIMERA_DATA_DIR, "native-command-"));
  const cwd = join(base, "project"); await mkdir(cwd);
  await writeFile(join(cwd, "package.json"), '{"name":"command-fixture"}');
  const effects: Array<Parameters<ProjectOciBackend["create"]>[0]> = [];
  t.mock.method(ProjectOciBackend.prototype, "initialize", async () => {});
  t.mock.method(ProjectOciBackend.prototype, "probe", async (image: string | undefined) => ({ available: available && !!image, fingerprint: `fixture:${image}`, ...(!available ? { diagnostic: "runtime_unavailable" } : {}) }));
  t.mock.method(ProjectOciBackend.prototype, "create", async (input: Parameters<ProjectOciBackend["create"]>[0]) => { effects.push(input); return `uptokey-project-00000000-0000-0000-0000-${effects.length.toString().padStart(12, '0')}`; });
  t.mock.method(ProjectOciBackend.prototype, "run", async function(this: ProjectOciBackend, ...args:Parameters<ProjectOciBackend['run']>) {
    try {
      if (runGate) {
        runGate.opened();
        await new Promise<void>((resolve, reject) => {
          const signal = args[3];
          const aborted = () => { signal?.removeEventListener("abort", aborted); reject(new DOMException("aborted", "AbortError")); };
          if (signal?.aborted) { aborted(); return; }
          signal?.addEventListener("abort", aborted, { once: true });
          void runGate.wait.then(() => { signal?.removeEventListener("abort", aborted); resolve(); });
        });
      }
      const result={ stdout: Buffer.from(output), stderr: Buffer.alloc(0), exitCode: commandExitCode, limited: false };await args[4]?.(result);return result;
    } finally { if (runGate) await this.stop(args[0]); }
  });
  t.mock.method(ProjectOciBackend.prototype, "stop", async () => {runGate?.stopped();});
  t.mock.method(ProjectOciBackend.prototype, "extractFiles", async () => development?new Map([['app.js',Buffer.from('console.log("reviewed generated app")\n')]]):new Map());
  const requests: Array<Record<string, any>> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const round = requests.length;
    const args = development&&round===2?{outputManifestArtifactId:JSON.parse(requests.at(-1)!.messages.findLast((m:any)=>m.role==='tool').content).outputManifestArtifactId,paths:['app.js']}:{ argv: round === 1 ? ["node", "--version"] : ["node", "--test"], profile: "node-app", workdir: ".",...(development?{execution:{writable:true,outputPaths:['app.js']}}:{}) };
    if (round <= (twoCalls ? 2 : 1)) response.end(frame({ tool_calls: [{ index: 0, id: `command-${round}`, type: "function", function: { name: development&&round===2?'promote_run_outputs':"execute_command", arguments: JSON.stringify(args) } }] }));
    else if (finalGate) {
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "Final answer is visible before its canonical commit." } }] })}\n\n`);
      finalGate.opened();
      await finalGate.wait;
      response.end("data: [DONE]\n\n");
    } else response.end(frame({ content: "Comandos concluídos conforme os resultados recebidos." }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = upstream.address(); assert.ok(endpoint && typeof endpoint !== "string");
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const config = structuredClone(defaultConfig);
  for (const provider of Object.values(config.providers)) provider.enabled = false;
  const provider = "custom-native-command"; assert.ok(isProvider(provider)); ensureUserDefinedProviderEntry(config, provider);
  Object.assign(config.providers[provider]!, { enabled: true, configured: true, models: [model], defaultModel: model, endpointUrl: `http://127.0.0.1:${endpoint.port}/v1/chat/completions`, budget: { rpm: 60, tpm: 1_000_000, source: "account_user_input" } });
  config.fallbackOrder = [provider];
  const secrets = new MemorySecretStore(), admin = `utk_local_${"C".repeat(32)}`;
  await secrets.set("local:api-token", admin);
  const ledger = new QuotaLedger(join(base, "ledger.json")); await ledger.initialize();
  const router = new Router(config, new Map(), secrets, ledger);
  const { createApp, ALLOWED_HOSTS } = await import("../src/app.ts");
  const options: Parameters<typeof createApp> = [config, router, secrets, async () => ({ allowed: true, grace: false })];
  options[8] = async () => config; options[13] = new WorkspaceStore(secrets, join(base, "workspace"));
  options[32] = { nodeImage: `docker.io/library/node@sha256:${"a".repeat(64)}` };
  const app = createApp(...options); await app.workspaceReady;
  const paths: string[] = [];
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: (request, env) => { paths.push(`${request.method} ${new URL(request.url).pathname}`); return app.fetch(request, env); } });
  await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once("listening", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`; ALLOWED_HOSTS.add(`127.0.0.1:${address.port}`);
  t.after(async () => { ALLOWED_HOSTS.delete(`127.0.0.1:${address.port}`); await app.closeWorkspace(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const challenge = await post("/local/pair/challenge", { clientName: "native-command-fixture", audience: "tui" });
  await post("/local/pair/approve", { id: challenge.id, userCode: challenge.userCode, audience: "tui" }, admin);
  const paired = await post("/local/pair/consume", { id: challenge.id, publicJwk: keys.publicKey.export({ format: "jwk" }) });
  let signatures = 0;
  const controller = new TuiController({ cwd, baseUrl, token: paired.token, processingPolicy: "external_allowed", sign: nonce => { signatures++; return sign("sha256", Buffer.from(nonce), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"); } });
  t.after(() => controller.dispose()); await controller.start(); await controller.selectProviderModel(model, provider);
  return { controller, requests, effects, paths, cwd, signatures: () => signatures };
}

test('native model writable execution then promotion uses two real W5 approvals and applies only reviewed artifact bytes', {timeout:30000},async t=>{
  const h=await setup(t,true,true,true);
  const turn=h.controller.submit('Crie app.js em execução isolada e aplique após revisão.');
  await waitFor(()=>!!h.controller.features.review);assert.equal(h.effects.length,0);h.controller.features.respond(h.controller.features.review!.id,true);
  await waitFor(()=>!!h.controller.features.review);assert.equal(h.effects.length,1);assert.equal(h.effects[0]!.writable,true);
  await assert.rejects(readFile(join(h.cwd,'app.js')),{code:'ENOENT'});assert.ok(h.controller.features.review!.body.includes('Apply reviewed outputs'));
  h.controller.features.respond(h.controller.features.review!.id,true);await turn;
  assert.equal(await readFile(join(h.cwd,'app.js'),'utf8'),'console.log("reviewed generated app")\n');assert.equal(h.signatures(),2);
  assert.equal(h.requests.length,3);assert.ok(h.paths.some(p=>p.endsWith('/run-promotions')));
  const final=JSON.parse(h.requests[2]!.messages.findLast((m:any)=>m.role==='tool').content);assert.equal(final.status,'succeeded');assert.equal(final.tool,'promote_run_outputs');
});

test("model commands execute through two exact UI approvals and W5 receipts, then resume the same model with actual artifacts", { timeout: 30000 }, async t => {
  const h = await setup(t);
  const turn = h.controller.submit("Confira a versão e execute os testes do projeto.");
  await waitFor(() => !!h.controller.features.review);
  assert.equal(h.effects.length, 0); assert.equal(h.signatures(), 0);
  assert.ok(h.controller.features.review!.body.includes("--version"));
  assert.ok(h.controller.features.review!.body.includes("no network"));
  h.controller.features.respond(h.controller.features.review!.id, true);
  await waitFor(() => !!h.controller.features.review);
  assert.equal(h.effects.length, 1); assert.equal(h.signatures(), 1);
  assert.ok(h.controller.features.review!.body.includes("--test"));
  h.controller.features.respond(h.controller.features.review!.id, true);
  await turn;
  assert.equal(h.effects.length, 2, JSON.stringify(h.controller.items())); assert.equal(h.signatures(), 2);
  assert.deepEqual(h.effects.map(item => [item.executable, ...item.args]), [["node", "--version"], ["node", "--test"]]);
  assert.equal(h.requests.length, 3); assert.ok(h.requests.every(request => request.model === model));
  assert.ok(JSON.stringify(h.requests[2]!.messages).includes(output));
  assert.equal(h.paths.filter(path => path.endsWith("/consent/complete")).length, 2);
  const id = h.controller.state.activeConversation!.id;
  const { thread } = await h.controller.conversations.thread(id); assert.doesNotThrow(() => composeHistory(thread));
  const results = thread.flatMap(row => row.parts.filter(part => part.type === "tool_result").map(part => part.text as Record<string, any>));
  assert.equal(results.length, 2); assert.ok(results.every(result => result.receiptId && result.output.artifactId && result.output.status === "succeeded"));
  assert.equal(JSON.stringify(results).includes(output), false, "stdout stays in its governed artifact rather than conversation metadata");
  const runs = await h.controller.conversations.runs(id);
  assert.equal(runs.length, 2); assert.equal(new Set(runs.map(run => run.requestId)).size, 2);
});

for (const cancel of [false, true]) test(`shell submitted during the final model stream ${cancel ? "cancels without admission and allows recovery" : "waits for canonical commit before admission"}`, { timeout: 30000 }, async t => {
  let release!: () => void;
  let finalOpened = false;
  const gate = { opened: () => { finalOpened = true; }, wait: new Promise<void>(resolve => { release = resolve; }) };
  t.after(() => release());
  const h = await setup(t, true, false, false, gate);
  const turn = h.controller.submit("Run a check and explain the result.");
  await waitFor(() => !!h.controller.features.review);
  h.controller.features.respond(h.controller.features.review!.id, true);
  await waitFor(() => finalOpened);
  const id = h.controller.state.activeConversation!.id;
  const before = await h.controller.conversations.thread(id);
  const command = h.controller.runShell("node --version");
  await new Promise(resolve => setTimeout(resolve, 100));
  const pending = await h.controller.conversations.thread(id);
  assert.equal(pending.conversation.revision, before.conversation.revision, "queued shell writes no new intention while the final answer is streaming");
  assert.equal(h.effects.length, 1, "only the model's approved effect has run");
  assert.ok(h.controller.items().some(item => item.kind === "run" && item.title === "$ node --version" && item.state === "preparing"), "the full submitted command stays visible while queued");
  if (cancel) {
    assert.equal(h.controller.cancel(), true);
    assert.equal(await command, null);
  }
  release();
  await turn;
  if (cancel) {
    assert.equal(h.effects.length, 1, "cancelled queued commands are never admitted");
    const cancelled = await h.controller.conversations.thread(id);
    assert.ok(cancelled.thread.at(-1)?.parts.some(part => part.type === "status" && part.text === "cancelled_by_user"));
    assert.equal(await h.controller.runShell("node --version"), 0, "a later explicit command can recover normally");
  } else assert.equal(await command, 0);
  assert.equal(h.effects.length, 2);
  const stored = await h.controller.conversations.thread(id);
  assert.doesNotThrow(() => composeHistory(stored.thread));
  const finalIndex = stored.thread.findIndex(message => message.parts.some(part => part.type === "text" && String(part.text).includes("Final answer is visible")));
  const commandIndex = stored.thread.findIndex(message => message.role === "user" && message.clientMessageId.startsWith("tui_exec_"));
  assert.ok(finalIndex >= 0 && commandIndex > finalIndex, "the subsequent command intention follows the committed model answer");
  assert.equal(h.controller.items().some(item => item.kind === "notice" && item.text.includes("conversation_conflict")), false);
});

test("cancelling an admitted shell run reaches the canonical OCI cancellation route", { timeout: 30000 }, async t => {
  let release!: () => void;
  let opened = false;
  let stops = 0;
  const gate = { opened: () => { opened = true; }, wait: new Promise<void>(resolve => { release = resolve; }), stopped: () => { stops++; release(); } };
  t.after(() => release());
  const h = await setup(t, true, false, false, undefined, gate);
  let cancelOutcome = "pending";
  const cancelRun = h.controller.workspace.cancelRun.bind(h.controller.workspace);
  t.mock.method(h.controller.workspace, "cancelRun", async (...args: Parameters<typeof cancelRun>) => {
    try { await cancelRun(...args); cancelOutcome = "accepted"; }
    catch (error) { cancelOutcome = error instanceof Error ? error.message : String(error); throw error; }
  });
  const command = h.controller.runShell("node --version");
  await waitFor(() => opened);
  assert.equal(h.controller.cancel(), true);
  assert.equal(await command, null);
  await waitFor(() => h.paths.some(path => path.endsWith("/cancel")));
  await waitFor(() => stops > 0, () => ({ cancelOutcome, items: h.controller.items().slice(-6) }));
  assert.ok(h.controller.items().some(item => item.kind === "run" && item.title === "$ node --version" && item.state === "cancelled"));
  assert.equal(h.requests.length, 0, "direct shell cancellation dispatches no model request");
});

test("absent OCI reports its actual diagnostic to the model without planning, approval or host execution", { timeout: 30000 }, async t => {
  const h = await setup(t, false, false);
  const live: string[] = [];
  h.controller.on('change', () => live.push(...h.controller.state.streamingToolCalls.map(call => call.status)));
  await h.controller.submit("Execute os testes do projeto.");
  assert.equal(h.effects.length, 0); assert.equal(h.signatures(), 0); assert.equal(h.requests.length, 2);
  const result = JSON.parse(h.requests[1]!.messages.find((item: any) => item.role === "tool").content);
  assert.equal(result.reason, "runtime_unavailable"); assert.equal(result.isolation.hostExecution, false);
  assert.equal(h.paths.some(path => path.endsWith("/run-plans")), false);
  assert.ok(live.includes('rejected'), 'unavailable executor is neutral live');
  const id = h.controller.state.activeConversation!.id;
  await h.controller.openConversation(id);
  assert.equal(h.controller.items().filter(item => item.kind === 'tool').at(-1)?.status, 'rejected', 'unavailable executor stays neutral after reopening');
});

test('a command exiting one is a failed tool live and after canonical reopen', { timeout: 30000 }, async t => {
  const h = await setup(t, true, false, false, undefined, undefined, 1);
  const live: string[] = [];
  h.controller.on('change', () => live.push(...h.controller.state.streamingToolCalls.map(call => call.status)));
  const turn = h.controller.submit('Run the project tests.');
  await waitFor(() => !!h.controller.features.review);
  h.controller.features.respond(h.controller.features.review!.id, true);
  await turn;
  const result = JSON.parse(h.requests[1]!.messages.find((item: any) => item.role === 'tool').content);
  assert.equal(result.status, 'failed');
  assert.ok(result.checks.some((check: { exitCode?: number }) => check.exitCode === 1));
  assert.ok(live.includes('error'), 'failed process is an error while the turn runs');
  const id = h.controller.state.activeConversation!.id;
  await h.controller.openConversation(id);
  assert.equal(h.controller.items().filter(item => item.kind === 'tool').at(-1)?.status, 'error', 'failed process does not become successful on reopen');
});

for (const mode of ["decline", "local_policy", "cancel"] as const) test(`model command ${mode} during review runs nothing and preserves a coherent conversation`, { timeout: 30000 }, async t => {
  const h = await setup(t, true, false);
  const live: string[] = [];
  h.controller.on('change', () => live.push(...h.controller.state.streamingToolCalls.map(call => call.status)));
  const turn = h.controller.submit("Execute os testes do projeto.");
  await waitFor(() => !!h.controller.features.review);
  const id = h.controller.state.activeConversation!.id;
  if (mode === "local_policy") {
    const conversation = await h.controller.conversations.getConversation(id);
    await h.controller.client.fetchAuth(`/v1/workspace/conversations/${id}/update`, { method: "POST", body: JSON.stringify({ expectedRevision: conversation.revision, policy: { processingPolicy: "local_only" } }) });
  }
  if (mode === "cancel") h.controller.cancel();
  else h.controller.features.respond(h.controller.features.review!.id, mode !== "decline");
  await turn;
  assert.equal(h.effects.length, 0); assert.equal(h.signatures(), 0);
  assert.equal(h.requests.length, mode === "decline" ? 2 : 1);
  const { thread } = await h.controller.conversations.thread(id); assert.doesNotThrow(() => composeHistory(thread));
  assert.equal(thread.some(row => row.parts.some(part => part.type === "tool_result" && !!(part.text as unknown as Record<string, unknown>).receiptId)), false);
  if (mode === 'decline') {
    assert.ok(live.includes('rejected'), 'declined review is neutral live');
    await h.controller.openConversation(id);
    assert.equal(h.controller.items().filter(item => item.kind === 'tool').at(-1)?.status, 'rejected', 'deliberate refusal stays neutral after reopening');
  }
});
