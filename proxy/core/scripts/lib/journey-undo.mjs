/**
 * Turn undo/redo in the compiled artifact: a native edit approved through W5 changes math.js on disk; /desfazer asks
 * for one review, restores the file, rewinds the conversation and returns the prompt to the composer; /refazer
 * reapplies the change and the original branch. Disk bytes are checked after each step.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;
const ORIGINAL = "export const sum = (a, b) => a - b;\n";
const EDITED = "export const sum = (a, b) => a + b;\n";

/** Types a slash command, waits for the suggestion list, accepts it and submits (a second Enter when the first only completed it). */
export async function runSlash(term, command) {
  await term.send("\x15");
  await term.send(command);
  await term.until(() => term.screen().includes(command), `command list did not show ${command}`, 15000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 500));
  const composer = term.screen().split("\n").filter((line) => line.includes("┃")).join("\n");
  if (composer.includes(command)) await term.send(ENTER);
}

async function approve(term, label) {
  await term.until(() => APPROVAL.test(term.screen()), `${label}: approval was not requested`, 40000);
  const screen = term.screen();
  await term.send(ENTER);
  return screen;
}

export async function undoJourney({ term, checks, capture, info, proxy, relaunch, recoverRedo = false }) {
  const file = join(info.cwd, "math.js");
  const disk = () => readFile(file, "utf8");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  assert.equal(await disk(), ORIGINAL);
  await term.send("EDITE_NATIVO a soma");
  await term.send(ENTER);
  const editApproval = await approve(term, "edit");
  checks.editApprovalShowsFile = editApproval.includes("math.js");
  // Diagnostics after a write may ask to start a language server; this journey declines it (no external process).
  await term.until(() => term.screen().includes("EDIT_DONE_6620") || (/Iniciar|Start/.test(term.screen()) && APPROVAL.test(term.screen())), "the edit did not complete", 40000);
  if (!term.screen().includes("EDIT_DONE_6620")) { await term.send("\x1b[C"); await term.send(ENTER); checks.languageServerDeclined = true; }
  await term.until(() => term.screen().includes("EDIT_DONE_6620"), "the edit did not complete", 40000);
  await term.until(async () => (await disk()) === EDITED, "the edit did not reach the disk", 10000);
  checks.editWritten = true;
  capture("1. edição aprovada e gravada");

  await runSlash(term, "/desfazer");
  const undoApproval = await approve(term, "undo");
  checks.undoReviewShowsFile = undoApproval.includes("math.js");
  await term.until(async () => (await disk()) === ORIGINAL, "undo did not restore the file", 30000);
  checks.undoRestoredDisk = true;
  await term.until(() => !term.screen().includes("EDIT_DONE_6620"), "the undone turn is still in the transcript", 20000);
  checks.conversationRewound = true;
  await term.until(() => term.screen().includes("EDITE_NATIVO a soma"), "the prompt did not return to the composer", 10000);
  checks.promptRestored = true;
  capture("2. turno desfeito");

  let conversationId, rewindBranch;
  const canonical = async (suffix) => {
    const response = await fetch(`${info.directBaseUrl ?? info.baseUrl}/v1/workspace/conversations${suffix}`, { headers: { authorization: `Bearer ${info.token}` } });
    assert.equal(response.status, 200, `canonical read ${suffix}`);
    return response.json();
  };
  if (recoverRedo) {
    assert.ok(proxy, "recovery journey requires the transparent relay");
    const list = await canonical("?limit=50");
    assert.equal(list.conversations.length, 1);
    conversationId = list.conversations[0].id;
    rewindBranch = (await canonical(`/${conversationId}`)).activeBranchId;
    // The core stores the exact redo command, but the first frontend never receives its acknowledgement.
    proxy.dropAckOnce(/^POST \/v1\/workspace\/conversations\/[^ ]+\/messages /);
    await runSlash(term, "/refazer");
    await approve(term, "redo before lost intention acknowledgement");
    await term.until(() => proxy.events.some(event => /\/messages /.test(event.dropped)), "the intention ACK was not lost", 20000);
    assert.equal(await disk(), ORIGINAL, "an unacknowledged intention must not execute a file change");
    assert.equal((await canonical(`/${conversationId}`)).activeBranchId, rewindBranch, "redo failure must preserve the rewind branch");
    checks.lostIntentionAckPreservedBranchAndBytes = true;
    capture("3. intenção registrada com confirmação perdida");
    term = await relaunch();
    await term.until(() => term.screen().includes("fixture-coder"), "reopened destination missing", 30000);
    await runSlash(term, "/sessoes");
    await term.until(() => term.screen().includes("EDITE_NATIVO a soma"), "recoverable conversation missing", 20000);
    await term.send("EDITE_NATIVO"); await new Promise(done => setTimeout(done, 300)); await term.send(ENTER);
    await term.until(() => term.screen().includes("math.js"), "durable redo intention did not reopen", 20000);
    checks.reopenedAfterLostAck = true;
    capture("4. recuperação após reabrir");
  }

  await runSlash(term, "/refazer");
  await approve(term, "redo");
  await term.until(async () => (await disk()) === EDITED, "redo did not reapply the change", 30000);
  checks.redoReappliedDisk = true;
  await term.until(() => term.screen().includes("EDIT_DONE_6620"), "the original branch did not return", 20000);
  checks.originalBranchBack = true;
  capture("3. turno refeito");
  if (recoverRedo) {
    const current = await canonical(`/${conversationId}`), messages = await canonical(`/${conversationId}/messages?limit=200`);
    assert.notEqual(current.activeBranchId, rewindBranch);
    const intentions = messages.messages.filter(message => message.parts?.some(part => part.type === "status" && typeof part.text === "string" && part.text.startsWith('turn-restore:v1 {"kind":"redo"')));
    assert.equal(intentions.length, 1, "reopening must reuse the same durable redo command");
    const links = await canonical(`/${conversationId}/runs`);
    assert.equal(links.runs.filter(run => run.messageId === intentions[0].id).length, 1, "exactly one redo effect is linked");
    checks.redoReusedOneDurableCommandAndRun = true;
    checks.relayDrops = proxy.events.map(event => event.dropped);
  }
}
