/**
 * J11/J09 with the real isolated runner (WSL + Podman + prepared OCI images): a command typed in the composer is
 * planned, approved (W5), run inside the container — never on the host — and its real output comes back; a failing
 * test is reported as failed with its own output.
 */
import assert from "node:assert/strict";
import { writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required|Aprovar/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function runShell(term, command) {
  await term.send("!");
  await pause(400);
  await term.send(command);
  await term.send(ENTER);
}

async function approveIfAsked(term, timeout = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    if (APPROVAL.test(term.screen())) {
      await term.send(ENTER);
      await pause(800);
      if (!APPROVAL.test(term.screen())) return true;
    }
    await pause(500);
  }
  return false;
}

export async function runnerRealJourney({ term, checks, capture, info }) {
  await writeFile(join(info.cwd, "package.json"), JSON.stringify({ name: "fixture-runner", version: "1.0.0", private: true, scripts: { test: "node test.js" } }, null, 2));
  await writeFile(join(info.cwd, "test.js"), "const sum = (a, b) => a + b;\nif (sum(2, 3) !== 5) { console.error('RUNNER_FAIL_SUM'); process.exit(1); }\nconsole.log('RUNNER_OK_' + sum(40, 2));\n");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  const before = await readdir(info.cwd);
  await runShell(term, "npm test");
  checks.approvalAsked = await approveIfAsked(term);
  await term.until(() => /RUNNER_OK_42/.test(term.screen()), "the real output of the isolated run did not come back", 300000);
  checks.realOutput = true;
  capture("1. npm test no contêiner");
  const after = await readdir(info.cwd);
  assert.deepEqual(after.filter((name) => !before.includes(name)).filter((name) => name !== "node_modules"), [], "the run created files on the host");
  checks.noHostSideEffects = true;

  // A failing test: the failure and its own output are reported, nothing is presented as success.
  await writeFile(join(info.cwd, "test.js"), "console.error('RUNNER_FAIL_SUM');\nprocess.exit(1);\n");
  await runShell(term, "npm test");
  await approveIfAsked(term);
  await term.until(() => /RUNNER_FAIL_SUM/.test(term.screen()), "the failing run's output did not come back", 300000);
  checks.failureReported = true;
  capture("2. falha real reportada");
}
