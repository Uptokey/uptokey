/** Turn undo/redo through the real core HTTP, W5 plans, signed approvals and the governed project
 * writer. The model is a scripted local upstream; files, branches and receipts are checked on disk/store. */
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { generateKeyPairSync, sign } from "node:crypto";
import { serve } from "@hono/node-server";
import { defaultConfig, ensureUserDefinedProviderEntry } from "../src/config.ts";
import { isProvider } from "../src/provider-registry.ts";
import { MemorySecretStore } from "../src/secret-store.ts";
import { QuotaLedger } from "../src/quota-ledger.ts";
import { Router } from "../src/router.ts";
import { WorkspaceStore } from "../src/workspace/store.ts";
import { TuiController } from "../src/tui/controller.ts";

const model = "fixture-native-writer";
const MATH = "export function add(a, b) {\n  return a - b;\n}\n\nexport function twice(x) {\n  return add(x, x);\n}\n";
type Call = { name: string; arguments: Record<string, unknown> };
type HttpFault = (request: Request, phase: "before" | "after", response?: Response) => Response | null | Promise<Response | null>;
const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;

async function waitFor(check: () => boolean, describe: () => unknown = () => "") {
  for (let i = 0; i < 3000; i++) { if (check()) return; await new Promise(resolve => setTimeout(resolve, 5)); }
  assert.fail(`expected state was not reached ${JSON.stringify(describe()).slice(0, 3000)}`);
}

async function setup(t: TestContext, script: Call[][]) {
  assert.ok(process.env.UPTOKEY_QUIMERA_DATA_DIR, "use the isolated launcher");
  await mkdir(process.env.UPTOKEY_QUIMERA_DATA_DIR, { recursive: true });
  const base = await mkdtemp(join(process.env.UPTOKEY_QUIMERA_DATA_DIR, "turn-undo-"));
  const cwd = join(base, "project"); await mkdir(cwd);
  await writeFile(join(cwd, "math.js"), MATH);
  await writeFile(join(cwd, "package.json"), '{"name":"write-fixture","type":"module"}');
  const requests: Array<Record<string, any>> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const calls = script[requests.length - 1];
    response.end(calls ? frame({ tool_calls: calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }) : frame({ content: "Done." }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = upstream.address(); assert.ok(endpoint && typeof endpoint !== "string");
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const config = structuredClone(defaultConfig);
  for (const provider of Object.values(config.providers)) provider.enabled = false;
  const provider = "custom-turn-undo"; assert.ok(isProvider(provider)); ensureUserDefinedProviderEntry(config, provider);
  Object.assign(config.providers[provider]!, { enabled: true, configured: true, models: [model], defaultModel: model, endpointUrl: `http://127.0.0.1:${endpoint.port}/v1/chat/completions`, budget: { rpm: 600, tpm: 1_000_000, source: "account_user_input" } });
  config.fallbackOrder = [provider];
  const secrets = new MemorySecretStore(), admin = `utk_local_${"W".repeat(32)}`;
  await secrets.set("local:api-token", admin);
  const ledger = new QuotaLedger(join(base, "ledger.json")); await ledger.initialize();
  const router = new Router(config, new Map(), secrets, ledger);
  const { createApp, ALLOWED_HOSTS } = await import("../src/app.ts");
  const options: Parameters<typeof createApp> = [config, router, secrets, async () => ({ allowed: true, grace: false })];
  options[8] = async () => config; options[13] = new WorkspaceStore(secrets, join(base, "workspace"));
  const app = createApp(...options); await app.workspaceReady;
  const paths: string[] = [];
  let fault: HttpFault | null = null;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: async (request, env) => {
    paths.push(`${request.method} ${new URL(request.url).pathname}`);
    const before = await fault?.(request, "before");
    if (before) return before;
    const inspect = request.clone();
    const response = await app.fetch(request, env);
    return await fault?.(inspect, "after", response) ?? response;
  } });
  await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once("listening", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`; ALLOWED_HOSTS.add(`127.0.0.1:${address.port}`);
  t.after(async () => { ALLOWED_HOSTS.delete(`127.0.0.1:${address.port}`); await app.closeWorkspace(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const challenge = await post("/local/pair/challenge", { clientName: "turn-undo-fixture", audience: "tui" });
  await post("/local/pair/approve", { id: challenge.id, userCode: challenge.userCode, audience: "tui" }, admin);
  const paired = await post("/local/pair/consume", { id: challenge.id, publicJwk: keys.publicKey.export({ format: "jwk" }) });
  let signatures = 0;
  const createController = () => new TuiController({ cwd, baseUrl, token: paired.token, processingPolicy: "external_allowed", sign: nonce => { signatures++; return sign("sha256", Buffer.from(nonce), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url"); } });
  let controller = createController();
  t.after(() => controller.dispose()); await controller.start(); await controller.selectProviderModel(model, provider);
  // The last request carries the whole tool history of the turn.
  const toolResults = () => ((requests.at(-1)?.messages ?? []) as any[]).filter(message => message.role === "tool").map(message => JSON.parse(message.content));
  return { get controller() { return controller; }, requests, paths, cwd, signatures: () => signatures, toolResults,
    fault: (next: HttpFault | null) => { fault = next; },
    async reopen(conversationId: string) {
      controller.dispose();
      controller = createController();
      await controller.start();
      await controller.openConversation(conversationId);
      await controller.selectProviderModel(model, provider);
    },
  };
}

const fixEdit: Call = { name: "edit_file", arguments: { path: "math.js", edits: [{ old_string: "  return a - b;", new_string: "  return a + b;" }] } };
const newFile: Call = { name: "write_file", arguments: { path: "lib/deep/util.js", content: "export const square = (x) => x * x;\n" } };
const moveFile: Call = { name: "move_file", arguments: { from: "lib/deep/util.js", to: "lib/square.js" } };

/** Answers every review the controller raises until `work` settles; returns the review titles. */
async function answering<T>(h: { controller: TuiController }, work: Promise<T>, accept = true): Promise<{ value: T; titles: string[] }> {
  const titles: string[] = []; let done = false; void work.finally(() => { done = true; });
  while (!done) {
    const review = h.controller.features.review;
    if (review) { titles.push(review.title); h.controller.features.respond(review.id, accept); }
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  return { value: await work, titles };
}

const lastPrompt = (controller: TuiController) => [...controller.state.messages].reverse().find(m => m.role === "user" && !m.clientMessageId?.startsWith("tui_"))!;

test("undo reverses every write of the turn, rewinds the conversation and redo reapplies both", { timeout: 90000 }, async t => {
  const h = await setup(t, [[fixEdit, newFile], [moveFile]]);
  h.controller.setAutonomy(true);
  await h.controller.submit("Fix add, add a square helper and move it.");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.ok(existsSync(join(h.cwd, "lib", "square.js")));
  const conversationId = h.controller.state.activeConversation!.id;
  const before = await h.controller.conversations.thread(conversationId);
  const prompt = lastPrompt(h.controller);
  const writes = h.signatures();

  const undo = await answering(h, h.controller.undoTurn(prompt.id));
  assert.deepEqual(undo.value, { prompt: "Fix add, add a square helper and move it." });
  assert.equal(undo.titles.length, 1, "the undo is reviewed even under autonomy");
  assert.equal(h.signatures(), writes + 1, "one signed W5 approval reverses the whole turn");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  assert.equal(existsSync(join(h.cwd, "lib", "square.js")), false);
  assert.equal(existsSync(join(h.cwd, "lib", "deep", "util.js")), false);
  const rewound = await h.controller.conversations.thread(conversationId);
  assert.notEqual(rewound.conversation.activeBranchId, before.conversation.activeBranchId);
  assert.equal(rewound.thread.some(m => m.id === prompt.id), false, "the undone turn is not in the active branch");
  assert.equal(h.controller.state.messages.some(m => m.id === prompt.id), false);
  const branches = await h.controller.conversations.branches(conversationId);
  assert.ok(branches.some(b => b.branchId === before.conversation.activeBranchId), "the original branch is kept");

  const redo = await answering(h, h.controller.redoTurn());
  assert.equal(redo.value, true);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal(await readFile(join(h.cwd, "lib", "square.js"), "utf8"), "export const square = (x) => x * x;\n");
  const restored = await h.controller.conversations.thread(conversationId);
  assert.equal(restored.conversation.activeBranchId, before.conversation.activeBranchId);
  assert.ok(restored.thread.some(m => m.id === prompt.id));
  assert.equal(await h.controller.redoTurn(), false, "nothing left to redo on the original branch");

  // A later edit outside the turn is a conflict: nothing is overwritten and the branch stays.
  const userEdit = "// edited by the person\n";
  await writeFile(join(h.cwd, "lib", "square.js"), userEdit);
  const refused = await answering(h, h.controller.undoTurn(prompt.id));
  assert.equal(refused.value, null);
  assert.equal(refused.titles.length, 0, "a conflict is reported before any review");
  assert.equal(await readFile(join(h.cwd, "lib", "square.js"), "utf8"), userEdit);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal((await h.controller.conversations.thread(conversationId)).conversation.activeBranchId, before.conversation.activeBranchId);
  assert.ok(h.controller.items().some((item: any) => item.kind === "notice" && item.level === "error" && /lib\/square\.js/.test(item.text)), "the conflict names the changed path");
});

test("declining the undo review changes neither files nor the conversation", { timeout: 60000 }, async t => {
  const h = await setup(t, [[fixEdit]]);
  h.controller.setAutonomy(true);
  await h.controller.submit("Fix add.");
  const conversationId = h.controller.state.activeConversation!.id;
  const branch = (await h.controller.conversations.thread(conversationId)).conversation.activeBranchId;
  const declined = await answering(h, h.controller.undoTurn(lastPrompt(h.controller).id), false);
  assert.equal(declined.value, null);
  assert.equal(declined.titles.length, 1);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal((await h.controller.conversations.thread(conversationId)).conversation.activeBranchId, branch);
});

test("a turn without writes rewinds only the conversation and says so", { timeout: 60000 }, async t => {
  const h = await setup(t, []);
  await h.controller.submit("Just answer.");
  const conversationId = h.controller.state.activeConversation!.id;
  const prompt = lastPrompt(h.controller);
  const undone = await answering(h, h.controller.undoTurn(prompt.id));
  assert.deepEqual(undone.value, { prompt: "Just answer." });
  assert.equal(undone.titles.length, 0, "no file review when nothing is written");
  assert.equal(h.signatures(), 0);
  const { thread } = await h.controller.conversations.thread(conversationId);
  assert.equal(thread.length, 0);
  assert.equal(await h.controller.redoTurn(), true);
  assert.ok((await h.controller.conversations.thread(conversationId)).thread.some(m => m.id === prompt.id));
});

const unavailable = () => Response.json({ error: { type: "fixture_response_unavailable" } }, { status: 503 });
const pathOf = (request: Request) => new URL(request.url).pathname;
const bodyOf = (request: Request) => request.clone().json() as Promise<Record<string, any>>;
const branchOf = async (h: Awaited<ReturnType<typeof setup>>, id: string) => (await h.controller.conversations.getConversation(id)).activeBranchId;
async function edited(t: TestContext) {
  const h = await setup(t, [[fixEdit]]);
  h.controller.setAutonomy(true);
  await h.controller.submit("Fix add.");
  return { h, id: h.controller.state.activeConversation!.id, prompt: lastPrompt(h.controller) };
}
async function undone(t: TestContext) {
  const f = await edited(t);
  assert.ok((await answering(f.h, f.h.controller.undoTurn(f.prompt.id))).value);
  assert.equal(await readFile(join(f.h.cwd, "math.js"), "utf8"), MATH);
  return { ...f, rewind: await branchOf(f.h, f.id) };
}

for (const phase of ["before", "after"] as const) test(`redo recovers a ${phase}-commit intention response failure after reopening`, { timeout: 90000 }, async t => {
  const { h, id, rewind } = await undone(t);
  let hits = 0;
  const signatures = h.signatures();
  h.fault(async (request, at) => {
    if (at !== phase || request.method !== "POST" || !pathOf(request).endsWith("/messages")) return null;
    const body = await bodyOf(request);
    if (!body.parts?.some((part: any) => part.type === "status" && String(part.text).startsWith('turn-restore:v1 {"kind":"redo"'))) return null;
    hits++;
    return unavailable();
  });
  assert.equal((await answering(h, h.controller.redoTurn())).value, false);
  assert.equal(hits, 1);
  assert.equal(await branchOf(h, id), rewind, "a failed intention never abandons the rewind branch");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  assert.equal(h.signatures(), signatures, "no consent complete was sent");
  h.fault(null);
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.redoTurn())).value, true);
  assert.equal(await branchOf(h, id), "main");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal(h.signatures(), signatures + 1, "exactly one successful redo execution");
  assert.equal(await h.controller.redoTurn(), false);
});

for (const where of ["challenge", "complete", "cancel-before-complete"] as const) test(`redo preserves its exact command after ${where} fails before admission`, { timeout: 90000 }, async t => {
  const { h, id, rewind } = await undone(t);
  let hits = 0;
  const signatures = h.signatures();
  h.fault((request, phase) => {
    const suffix = where === "challenge" ? "/consent/challenge" : "/consent/complete";
    if (phase !== "before" || !pathOf(request).endsWith(suffix)) return null;
    hits++;
    if (where === "cancel-before-complete") h.controller.cancel();
    return unavailable();
  });
  assert.equal((await answering(h, h.controller.redoTurn())).value, false);
  assert.equal(hits, 1);
  assert.equal(await branchOf(h, id), rewind);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  const record = (await h.controller.conversations.turnRestoreRecords(id)).operations.find(record => record.kind === "redo")!;
  assert.ok(record, "the exact command was persisted before admission");
  assert.equal((await h.controller.workspace.refreshPlan(record.projectId, record.planId)).run, null);
  h.fault(null);
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.redoTurn())).value, true);
  const recovered = await h.controller.workspace.refreshPlan(record.projectId, record.planId);
  assert.equal(recovered.run?.requestId, record.runRequestId, "recovery reused the sealed plan/request, not a second effect");
  assert.equal(await branchOf(h, id), "main");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal(h.signatures(), signatures + (where === "challenge" ? 1 : 2), "only the pre-admission consent challenge can be repeated");
});

test("redo reconciles cancellation and a lost admission ACK after the actual write succeeded", { timeout: 90000 }, async t => {
  const { h, id } = await undone(t);
  let hits = 0;
  const signatures = h.signatures();
  h.fault(async (request, phase, response) => {
    if (phase !== "after" || !pathOf(request).endsWith("/consent/complete") || !response?.ok) return null;
    const admitted = await response.clone().json() as any;
    await h.controller.workspace.waitForSettledRun(admitted.projectId, { planId: admitted.plan.id, runId: admitted.run.id });
    hits++;
    h.controller.cancel();
    return unavailable();
  });
  assert.equal((await answering(h, h.controller.redoTurn())).value, true, "a cancelled wait does not hide an already succeeded write");
  assert.equal(hits, 1);
  h.fault(null);
  assert.equal(await branchOf(h, id), "main");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal(h.signatures(), signatures + 1);
  await h.reopen(id);
  assert.equal(await h.controller.redoTurn(), false, "the settled operation cannot be applied twice");
});

test("redo with an unavailable post-admission journal stays recoverable until reopening reconciles the same run", { timeout: 90000 }, async t => {
  const { h, id, rewind } = await undone(t);
  let admitted = false, readsBlocked = 0;
  const signatures = h.signatures();
  h.fault((request, phase, response) => {
    if (phase === "after" && pathOf(request).endsWith("/consent/complete") && response?.ok) admitted = true;
    if (phase === "before" && admitted && request.method === "GET" && /\/plans\/[^/]+$/.test(pathOf(request))) { readsBlocked++; return unavailable(); }
    return null;
  });
  assert.equal((await answering(h, h.controller.redoTurn())).value, false);
  assert.ok(readsBlocked > 0);
  assert.equal(await branchOf(h, id), rewind, "an unknown outcome is never a blind branch rollback");
  h.fault(null);
  const record = (await h.controller.conversations.turnRestoreRecords(id)).operations.find(record => record.kind === "redo")!;
  const settled = await h.controller.workspace.waitForSettledRun(record.projectId, { planId: record.planId, requestId: record.runRequestId });
  assert.equal(settled.run?.status, "succeeded");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.redoTurn())).value, true);
  assert.equal(await branchOf(h, id), "main");
  assert.equal(h.signatures(), signatures + 1, "recovery observes the admitted run; it never starts a second one");
});

for (const phase of ["before", "after"] as const) test(`undo recovers a ${phase}-commit lost run-link request before redo`, { timeout: 90000 }, async t => {
  const { h, id, prompt } = await edited(t);
  let hits = 0;
  const signatures = h.signatures();
  h.fault(async (request, at) => {
    if (at !== phase || request.method !== "POST" || !pathOf(request).endsWith("/runs")) return null;
    const body = await bodyOf(request);
    if (body.op !== "link" || body.link?.modelId !== "turn-undo") return null;
    hits++;
    return unavailable();
  });
  const result = (await answering(h, h.controller.undoTurn(prompt.id))).value;
  assert.equal(hits, 1);
  assert.equal(Boolean(result), phase === "after", "only a confirmed committed association can complete undo");
  h.fault(null);
  const record = (await h.controller.conversations.turnRestoreRecords(id)).operations.find(record => record.kind === "undo")!;
  const settled = await h.controller.workspace.waitForSettledRun(record.projectId, { planId: record.planId, requestId: record.runRequestId });
  assert.equal(settled.run?.status, "succeeded");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.redoTurn())).value, true);
  assert.equal(await branchOf(h, id), "main");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  const links = await h.controller.conversations.runs(id);
  assert.equal(links.filter(link => link.messageId === record.messageId).length, 1);
  assert.equal(h.signatures(), signatures + 2, "one undo and one redo, even across link failure and reopening");
});

for (const phase of ["before", "after"] as const) test(`redo recovers a ${phase}-commit final branch response failure`, { timeout: 90000 }, async t => {
  const { h, id, rewind } = await undone(t);
  let hits = 0;
  const signatures = h.signatures();
  h.fault(async (request, at) => {
    if (at !== phase || request.method !== "POST" || !pathOf(request).endsWith("/update")) return null;
    if ((await bodyOf(request)).activeBranchId !== "main") return null;
    hits++;
    return unavailable();
  });
  assert.equal((await answering(h, h.controller.redoTurn())).value, phase === "after");
  assert.equal(hits, 1);
  assert.equal(await branchOf(h, id), phase === "after" ? "main" : rewind);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  h.fault(null);
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.redoTurn())).value, phase === "before");
  assert.equal(await branchOf(h, id), "main");
  assert.equal(h.signatures(), signatures + 1, "a failed branch response never re-executes the file plan");
});

test("multiple undo/redo cycles never fold the earlier inverse runs into the original turn", { timeout: 90000 }, async t => {
  const { h, id, prompt } = await edited(t);
  const signatures = h.signatures();
  for (let cycle = 0; cycle < 3; cycle++) {
    assert.ok((await answering(h, h.controller.undoTurn(prompt.id))).value);
    assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
    assert.equal((await answering(h, h.controller.redoTurn())).value, true);
    assert.equal(await branchOf(h, id), "main");
    assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  }
  assert.equal(h.signatures(), signatures + 6);
});

for (const kind of ["undo", "redo"] as const) test(`${kind} can retire a failed preflight only after current bytes pass a fresh canonical preparation`, { timeout: 90000 }, async t => {
  const f = kind === "undo" ? await edited(t) : await undone(t);
  const { h, id, prompt } = f;
  const expected = kind === "undo" ? MATH.replace("a - b", "a + b") : MATH;
  const target = kind === "undo" ? MATH : MATH.replace("a - b", "a + b");
  let hits = 0;
  h.fault(async (request, phase) => {
    if (phase !== "before" || !pathOf(request).endsWith("/consent/complete") || hits) return null;
    hits++;
    await writeFile(join(h.cwd, "math.js"), "// fixture person edited after the inverse was reviewed\n");
    return null;
  });
  const first = await answering<{ prompt: string } | null | boolean>(h, kind === "undo" ? h.controller.undoTurn(prompt.id) : h.controller.redoTurn());
  assert.equal(Boolean(first.value), false);
  assert.equal(hits, 1);
  h.fault(null);
  const before = await h.controller.conversations.turnRestoreRecords(id);
  const failed = before.operations.filter(record => record.kind === kind).at(-1)!;
  const run = await h.controller.workspace.refreshPlan(failed.projectId, failed.planId);
  assert.notEqual(run.run?.status, "succeeded");
  assert.ok(run.run && ["failed", "cancelled", "needs_attention"].includes(run.run.status));
  assert.equal(before.completed.has(failed.clientMessageId), false);
  // Wrong bytes stay a conflict; a terminal status alone never authorizes another attempt.
  const refused = await answering<{ prompt: string } | null | boolean>(h, kind === "undo" ? h.controller.undoTurn(prompt.id) : h.controller.redoTurn());
  assert.equal(Boolean(refused.value), false);
  assert.equal(refused.titles.length, 0);
  assert.equal((await h.controller.conversations.turnRestoreRecords(id)).completed.has(failed.clientMessageId), false);
  await writeFile(join(h.cwd, "math.js"), expected);
  await h.reopen(id);
  const retried = await answering<{ prompt: string } | null | boolean>(h, kind === "undo" ? h.controller.undoTurn(prompt.id) : h.controller.redoTurn());
  assert.equal(Boolean(retried.value), true, JSON.stringify(h.controller.items().filter(item => item.kind === "notice")));
  assert.equal(retried.titles.length, 1, "fresh verified preparation needs a new W5 review");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), target);
  const after = await h.controller.conversations.turnRestoreRecords(id);
  assert.equal(after.completed.has(failed.clientMessageId), true, "retired, never reported as a successful file operation");
  const recovered = after.operations.filter(record => record.kind === kind).at(-1)!;
  assert.notEqual(recovered.planId, failed.planId);
  assert.notEqual(recovered.runRequestId, failed.runRequestId);
  assert.notEqual(recovered.clientMessageId, failed.clientMessageId);
});

for (const stage of ["before-final-read", "after-final-read"] as const) test(`undo preserves a concurrent canonical message appended ${stage}`, { timeout: 90000 }, async t => {
  const { h, id, prompt } = await edited(t);
  let inserted: string | null = null;
  h.fault(async (request, phase) => {
    if (inserted || request.method !== "POST") return null;
    if (stage === "after-final-read" && (phase !== "before" || !pathOf(request).endsWith("/update"))) return null;
    if (stage === "before-final-read") {
      if (phase !== "after" || !pathOf(request).endsWith("/runs") || (await bodyOf(request)).link?.modelId !== "turn-undo") return null;
    }
    // This is another canonical writer, not a controller field mutation. Its revision must win the CAS.
    const result = await h.controller.conversations.appendAtTip(id, "user", [{ type: "text", text: `concurrent user message ${stage}` }], `concurrent-${stage}`);
    inserted = result.message.id;
    return null;
  });
  assert.equal((await answering(h, h.controller.undoTurn(prompt.id))).value, null);
  assert.ok(inserted);
  h.fault(null);
  const current = await h.controller.conversations.thread(id);
  assert.equal(current.conversation.activeBranchId, "main");
  assert.ok(current.thread.some(message => message.id === inserted), "the competing user's context is not silently hidden");
  const recovery = await h.controller.conversations.turnRestoreRecords(id);
  const inverse = recovery.operations.find(record => record.kind === "undo")!;
  assert.equal(recovery.completed.has(inverse.clientMessageId), false);
  const settled = await h.controller.workspace.waitForSettledRun(inverse.projectId, { planId: inverse.planId, requestId: inverse.runRequestId });
  assert.equal(settled.run?.status, "succeeded");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  await h.reopen(id);
  assert.equal((await answering(h, h.controller.undoTurn(prompt.id))).value, null, "recovery does not override the concurrent branch context either");
});

test("an unlinked forward write is never mistaken for a conversation-only turn, and recovers canonically after reopening", { timeout: 90000 }, async t => {
  const h = await setup(t, [[fixEdit]]);
  let linkDropped = false;
  h.fault(async (request, phase) => {
    if (phase !== "before") return null;
    if (request.method === "POST" && pathOf(request).endsWith("/runs") && (await bodyOf(request)).op === "link") {
      linkDropped = true;
      return unavailable();
    }
    if (linkDropped && request.method === "GET" && /\/plans\/[^/]+$/.test(pathOf(request))) return unavailable();
    return null;
  });
  h.controller.setAutonomy(true);
  await h.controller.submit("Fix add.");
  assert.equal(linkDropped, true);
  const id = h.controller.state.activeConversation!.id, prompt = lastPrompt(h.controller);
  for (let attempt = 0; await readFile(join(h.cwd, "math.js"), "utf8") !== MATH.replace("a - b", "a + b"); attempt++) {
    assert.ok(attempt < 200, "the real forward W5 write did not finish");
    await new Promise(resolve => setTimeout(resolve, 5));
  }
  assert.equal((await h.controller.conversations.runs(id)).length, 0);
  assert.equal((await answering(h, h.controller.undoTurn(prompt.id))).value, null);
  assert.equal(await branchOf(h, id), "main");
  assert.equal((await h.controller.conversations.turnRestoreRecords(id)).operations.length, 0);
  assert.equal((await h.controller.conversations.thread(id)).thread.some(message => message.parts.some(part => part.type === "status" && part.text === "turn-undo:v1")), false, "noWrites was never inferred from a lost link");
  h.fault(null);
  await h.reopen(id);
  const undone = await answering(h, h.controller.undoTurn(prompt.id));
  assert.deepEqual(undone.value, { prompt: "Fix add." });
  assert.equal(undone.titles.length, 1);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH);
  assert.equal(h.signatures(), 2, "recovering the original link never starts the forward effect again");
  assert.equal((await answering(h, h.controller.redoTurn())).value, true);
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"));
  assert.equal(await branchOf(h, id), "main");
});

test("a genuine no-write undo also preserves a concurrent prompt at the branch CAS", { timeout: 90000 }, async t => {
  const h = await setup(t, []);
  await h.controller.submit("Just answer.");
  const id = h.controller.state.activeConversation!.id, prompt = lastPrompt(h.controller);
  let inserted: string | null = null;
  h.fault(async (request, phase) => {
    if (inserted || phase !== "before" || request.method !== "POST" || !pathOf(request).endsWith("/update")) return null;
    const result = await h.controller.conversations.appendAtTip(id, "user", [{ type: "text", text: "do not discard this concurrent prompt" }], "concurrent-no-write");
    inserted = result.message.id;
    return null;
  });
  assert.equal((await answering(h, h.controller.undoTurn(prompt.id))).value, null);
  assert.ok(inserted);
  h.fault(null);
  const current = await h.controller.conversations.thread(id);
  assert.equal(current.conversation.activeBranchId, "main");
  assert.ok(current.thread.some(message => message.id === inserted));
  assert.equal(h.signatures(), 0);
});
