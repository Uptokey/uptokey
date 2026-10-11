/**
 * J09 — create a multi-file app with tests: the answer proposes four files, the person reviews and approves, the
 * canonical writer records them with a receipt, then the tests and the build run inside the real isolated runner.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const APPROVAL = /Aprovação necessária|Approval required/;

export class HostCapabilityUnavailableError extends Error {
  constructor(capability, cause) {
    super(`host_capability_unavailable: ${cause}`, { cause });
    this.name = "HostCapabilityUnavailableError";
    this.code = "host_capability_unavailable";
    this.missingCapability = { capability, cause };
  }
}

/** Read the same authenticated core capability endpoint as the canonical workspace client. */
export async function appRunnerCapability(info, fetchFn = fetch) {
  const response = await fetchFn(`${info.baseUrl}/v1/workspace/project-agent/capabilities`, {
    headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(10000),
  });
  assert.ok(response.ok, `runner capability request failed (${response.status})`);
  const data = await response.json();
  assert.ok(Array.isArray(data.profiles), "runner capability response is invalid");
  const profile = data.profiles.find((entry) => entry.id === "node-app");
  assert.ok(profile && typeof profile.available === "boolean" && profile.isolation === "oci_container", "node-app capability response is invalid");
  return { id: profile.id, available: profile.available, isolation: profile.isolation,
    diagnostic: typeof profile.diagnostic === "string" && /^runtime_[a-z0-9_]+$/.test(profile.diagnostic) ? profile.diagnostic : null };
}

async function shell(term, command) {
  await term.send("!");
  await pause(400);
  await term.send(command);
  await term.send(ENTER);
  for (let i = 0; i < 120; i++) {
    if (APPROVAL.test(term.screen())) { await term.send(ENTER); return; }
    await pause(500);
  }
}

export async function appJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("CRIE_APP de soma com testes");
  await term.send(ENTER);
  await term.until(() => /Revisar alteração proposta/.test(term.screen()) && /soma\.js/.test(term.screen()), "the multi-file proposal was not offered", 60000);
  checks.proposalReviewed = true;
  capture("1. revisão das quatro alterações");
  await term.send(ENTER);
  await term.until(async () => (await Promise.all(["package.json", "src/soma.js", "test/soma.test.js", "build.js"].map((f) => readFile(join(info.cwd, f), "utf8").then(() => true, () => false)))).every(Boolean), "the files were not written", 60000);
  for (const file of ["package.json", "src/soma.js", "test/soma.test.js", "build.js"]) assert.ok((await readFile(join(info.cwd, file), "utf8")).length > 0, `${file} missing`);
  checks.filesWritten = true;
  await term.until(() => /recibo/.test(term.screen()), "no receipt shown", 30000);
  checks.receipt = true;
  const capability = await appRunnerCapability(info);
  checks.runnerCapability = capability;
  if (!capability.available) throw new HostCapabilityUnavailableError("oci_container/node-app", capability.diagnostic ?? "runtime_unavailable");
  await shell(term, "npm test");
  await term.until(() => /APP_TEST_OK/.test(term.screen()), "the tests did not run in the isolated runner", 300000);
  checks.testsPassedInRunner = true;
  capture("2. testes no executor");
  await shell(term, "npm run build");
  await term.until(() => /APP_BUILD_OK/.test(term.screen()), "the build did not run in the isolated runner", 300000);
  checks.buildRanInRunner = true;
  capture("3. build no executor");
}
