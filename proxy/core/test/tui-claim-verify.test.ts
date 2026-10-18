/** A success claim after native edits is flagged and the project's verification is offered, through the real core
 * (W5 writes, signed approvals) with a scripted model. Nothing is run by the TUI itself. */
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
import { setLang } from "../src/tui/i18n.ts";
import { t as text } from "../src/tui/i18n.ts";

const model = "fixture-claim-writer";
const MATH = "export function add(a, b) {\n  return a - b;\n}\n";
type Call = { name: string; arguments: Record<string, unknown> };
type ScriptRound = Call[] | ((requests: Array<Record<string, any>>) => Call[]);
type RuntimeFixture = { exitCode?: number; blocked?: boolean; outputs?: Record<string, string> };
const frame = (delta: unknown) => `data: ${JSON.stringify({ choices: [{ delta }] })}\n\ndata: [DONE]\n\n`;
const fixEdit: Call = { name: "edit_file", arguments: { path: "math.js", edits: [{ old_string: "  return a - b;", new_string: "  return a + b;" }] } };

async function setup(t: TestContext, script: ScriptRound[], final: string, runtime?: RuntimeFixture) {
  assert.ok(process.env.UPTOKEY_QUIMERA_DATA_DIR, "use the isolated launcher");
  await mkdir(process.env.UPTOKEY_QUIMERA_DATA_DIR, { recursive: true });
  const base = await mkdtemp(join(process.env.UPTOKEY_QUIMERA_DATA_DIR, "claim-verify-"));
  const cwd = join(base, "project"); await mkdir(cwd);
  await writeFile(join(cwd, "math.js"), MATH);
  await writeFile(join(cwd, "package.json"), '{"name":"claim-fixture","type":"module","scripts":{"test":"node test.js"}}');
  let processes = 0;
  if (runtime) {
    t.mock.method(ProjectOciBackend.prototype, "initialize", async () => {});
    t.mock.method(ProjectOciBackend.prototype, "probe", async () => ({ available: true, fingerprint: "claim-fixture" }));
    t.mock.method(ProjectOciBackend.prototype, "create", async () => { if (runtime.blocked) throw new Error("runtime_fixture_blocked"); return "uptokey-project-00000000-0000-0000-0000-000000000001"; });
    t.mock.method(ProjectOciBackend.prototype, "run", async (...args: Parameters<ProjectOciBackend["run"]>) => {
      processes++;
      const outcome = { stdout: Buffer.from("claim verification fixture"), stderr: Buffer.from(runtime.exitCode ? "test failed" : ""), exitCode: runtime.exitCode ?? 0, limited: false };
      await args[4]?.(outcome); return outcome;
    });
    t.mock.method(ProjectOciBackend.prototype, "stop", async () => {});
    t.mock.method(ProjectOciBackend.prototype, "extractFiles", async () => new Map(Object.entries(runtime.outputs ?? {}).map(([path, content]) => [path, Buffer.from(content)])));
  }
  const requests: Array<Record<string, any>> = [];
  const upstream = createServer(async (request, response) => {
    const chunks: Buffer[] = []; for await (const chunk of request) chunks.push(Buffer.from(chunk));
    requests.push(JSON.parse(Buffer.concat(chunks).toString()));
    response.writeHead(200, { "content-type": "text/event-stream" });
    const round = script[requests.length - 1];
    const calls = typeof round === "function" ? round(requests) : round;
    response.end(calls ? frame({ tool_calls: calls.map((call, index) => ({ index, id: `call-${requests.length}-${index}`, type: "function", function: { name: call.name, arguments: JSON.stringify(call.arguments) } })) }) : frame({ content: final }));
  });
  await new Promise<void>(resolve => upstream.listen(0, "127.0.0.1", resolve));
  const endpoint = upstream.address(); assert.ok(endpoint && typeof endpoint !== "string");
  t.after(async () => { upstream.closeAllConnections(); await new Promise<void>(resolve => upstream.close(() => resolve())); });
  const config = structuredClone(defaultConfig);
  for (const provider of Object.values(config.providers)) provider.enabled = false;
  const provider = "custom-claim-verify"; assert.ok(isProvider(provider)); ensureUserDefinedProviderEntry(config, provider);
  Object.assign(config.providers[provider]!, { enabled: true, configured: true, models: [model], defaultModel: model, endpointUrl: `http://127.0.0.1:${endpoint.port}/v1/chat/completions`, budget: { rpm: 600, tpm: 1_000_000, source: "account_user_input" } });
  config.fallbackOrder = [provider];
  const secrets = new MemorySecretStore(), admin = `utk_local_${"C".repeat(32)}`;
  await secrets.set("local:api-token", admin);
  const ledger = new QuotaLedger(join(base, "ledger.json")); await ledger.initialize();
  const router = new Router(config, new Map(), secrets, ledger);
  const { createApp, ALLOWED_HOSTS } = await import("../src/app.ts");
  const options: Parameters<typeof createApp> = [config, router, secrets, async () => ({ allowed: true, grace: false })];
  options[8] = async () => config; options[13] = new WorkspaceStore(secrets, join(base, "workspace"));
  if (runtime) options[32] = { nodeImage: `docker.io/library/node@sha256:${"a".repeat(64)}` };
  const app = createApp(...options); await app.workspaceReady;
  const server = serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch });
  await new Promise<void>(resolve => { if (server.listening) resolve(); else server.once("listening", resolve); });
  const address = server.address(); assert.ok(address && typeof address !== "string");
  const baseUrl = `http://127.0.0.1:${address.port}`; ALLOWED_HOSTS.add(`127.0.0.1:${address.port}`);
  t.after(async () => { ALLOWED_HOSTS.delete(`127.0.0.1:${address.port}`); await app.closeWorkspace(); if ("closeAllConnections" in server) server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const post = async (path: string, body: unknown, token?: string) => {
    const response = await fetch(baseUrl + path, { method: "POST", headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.ok, true, JSON.stringify(result)); return result;
  };
  const keys = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const challenge = await post("/local/pair/challenge", { clientName: "claim-verify-fixture", audience: "tui" });
  await post("/local/pair/approve", { id: challenge.id, userCode: challenge.userCode, audience: "tui" }, admin);
  const paired = await post("/local/pair/consume", { id: challenge.id, publicJwk: keys.publicKey.export({ format: "jwk" }) });
  const controller = new TuiController({ cwd, baseUrl, token: paired.token, processingPolicy: "external_allowed", sign: nonce => sign("sha256", Buffer.from(nonce), { key: keys.privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url") });
  t.after(() => controller.dispose()); await controller.start(); await controller.selectProviderModel(model, provider);
  controller.setAutonomy(true);
  const notices = () => controller.items().filter((item): item is Extract<ReturnType<TuiController["items"]>[number], { kind: "notice" }> => item.kind === "notice");
  return { controller, cwd, requests, notices, processes: () => processes };
}

test("a success claim after an applied edit is flagged as unverified and the project's tests are offered", { timeout: 90000 }, async t => {
  setLang("en");
  const h = await setup(t, [[fixEdit]], "Fixed the bug. The tests pass now.");
  await h.controller.submit("Fix add.");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH.replace("a - b", "a + b"), "the edit was applied");
  const warning = h.notices().find(notice => notice.text === text("ctl_claim_unverified"));
  assert.ok(warning, `no unverified-claim notice: ${JSON.stringify(h.notices())}`);
  assert.equal(warning.level, "warning");
  // The core always declares node-app (available or not); package.json identifies a Node project.
  const offer = h.controller.view.verifyOffer;
  assert.deepEqual(offer && { profileId: offer.profileId, actionId: offer.actionId }, { profileId: "node-app", actionId: "test" });
  assert.equal(warning.hint, text("ctl_claim_unverified_hint", { profile: "node-app", action: "test" }));
});

test("an applied edit without a claim prepares the offer silently; a claim without an edit is left alone", { timeout: 90000 }, async t => {
  setLang("en");
  const quiet = await setup(t, [[fixEdit]], "I changed the operator in add.");
  await quiet.controller.submit("Fix add.");
  assert.equal(quiet.notices().some(notice => notice.text === text("ctl_claim_unverified")), false);
  assert.equal(quiet.controller.view.verifyOffer?.profileId, "node-app", "the offer is still prepared for /test");
  const talk = await setup(t, [], "Everything is fixed and the tests pass.");
  await talk.controller.submit("Is it fixed?");
  assert.equal(talk.notices().some(notice => notice.text === text("ctl_claim_unverified")), false, "no edit in this turn: nothing to verify");
  assert.equal(talk.controller.view.verifyOffer, null);
});

const runTests: Call = { name: "execute_command", arguments: { argv: ["node", "--test"], profile: "node-app" } };
const success = "Fixed the bug. The tests pass now.";
const hasClaimWarning = (h: Awaited<ReturnType<typeof setup>>) => h.notices().some(notice => notice.text === text("ctl_claim_unverified"));
const lastResult = (h: Awaited<ReturnType<typeof setup>>) => JSON.parse(h.requests.at(-1)!.messages.findLast((message: any) => message.role === "tool").content);

test("a failed test with a real receipt cannot substantiate a success claim", { timeout: 30000 }, async t => {
  setLang("en");
  const h = await setup(t, [[fixEdit], [runTests]], success, { exitCode: 1 });
  await h.controller.submit("Fix add and run the tests.");
  const result = lastResult(h);
  assert.equal(result.status, "failed"); assert.ok(result.receiptId);
  assert.deepEqual(result.checks, [{ id: "runtime-process", status: "fail", exitCode: 1 }]);
  assert.equal(hasClaimWarning(h), true);
});

test("a blocked attempt with a real receipt cannot substantiate a success claim", { timeout: 30000 }, async t => {
  setLang("en");
  const h = await setup(t, [[fixEdit], [runTests]], success, { blocked: true });
  await h.controller.submit("Fix add and run the tests.");
  const result = lastResult(h);
  assert.ok(result.receiptId); assert.notEqual(result.status, "succeeded");
  assert.equal(h.processes(), 0); assert.equal(hasClaimWarning(h), true);
});

test("a successful informational command is not passing tests", { timeout: 30000 }, async t => {
  setLang("en");
  const h = await setup(t, [[fixEdit], [{ name: "execute_command", arguments: { argv: ["node", "--version"], profile: "node-app" } }]], success, {});
  await h.controller.submit("Fix add and inspect Node.");
  assert.equal(lastResult(h).status, "succeeded"); assert.equal(hasClaimWarning(h), true);
});

test("passing tests after the last edit substantiate the claim on the same snapshot", { timeout: 30000 }, async t => {
  setLang("en");
  const h = await setup(t, [[fixEdit], [runTests]], success, {});
  await h.controller.submit("Fix add and run the tests.");
  assert.equal(lastResult(h).status, "succeeded"); assert.equal(h.processes(), 1);
  assert.equal(hasClaimWarning(h), false);
});

test("promoting generated outputs is a write and invalidates the earlier passing tests", { timeout: 30000 }, async t => {
  setLang("en");
  const writableTests: Call = { ...runTests, arguments: { ...runTests.arguments, execution: { writable: true, outputPaths: ["generated.js"] } } };
  const promote: ScriptRound = requests => [{ name: "promote_run_outputs", arguments: { outputManifestArtifactId: JSON.parse(requests.at(-1)!.messages.findLast((message: any) => message.role === "tool").content).outputManifestArtifactId, paths: ["generated.js"] } }];
  const h = await setup(t, [[fixEdit], [writableTests], promote], success, { outputs: { "generated.js": "export const generated = true;\n" } });
  await h.controller.submit("Fix add, test, then apply the generated output.");
  assert.equal(await readFile(join(h.cwd, "generated.js"), "utf8"), "export const generated = true;\n");
  assert.equal(lastResult(h).tool, "promote_run_outputs"); assert.equal(lastResult(h).status, "succeeded");
  assert.equal(hasClaimWarning(h), true);
});

test("a promotion alone counts as the applied edit and requires verification afterwards", { timeout: 30000 }, async t => {
  setLang("en");
  const writableTests: Call = { ...runTests, arguments: { ...runTests.arguments, execution: { writable: true, outputPaths: ["generated.js"] } } };
  const promote: ScriptRound = requests => [{ name: "promote_run_outputs", arguments: { outputManifestArtifactId: JSON.parse(requests.at(-1)!.messages.findLast((message: any) => message.role === "tool").content).outputManifestArtifactId, paths: ["generated.js"] } }];
  const h = await setup(t, [[writableTests], promote], success, { outputs: { "generated.js": "export const generated = true;\n" } });
  await h.controller.submit("Generate and test the artifact, then apply it.");
  assert.equal(await readFile(join(h.cwd, "math.js"), "utf8"), MATH, "no native edit preceded the promotion");
  assert.equal(await readFile(join(h.cwd, "generated.js"), "utf8"), "export const generated = true;\n");
  assert.equal(hasClaimWarning(h), true); assert.equal(h.controller.view.verifyOffer?.profileId, "node-app");
});
