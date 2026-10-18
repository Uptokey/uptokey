/** Real compiled ToolPart, core/W5 and canonical reopen. OCI execution is an opt-in synthetic fixture, never a host command. */
import assert from "node:assert/strict";
import { runSlash } from "./journey-undo.mjs";

const APPROVAL = /Aprovação necessária|Approval required/;
const NEUTRAL = /⊘\s+bash\s*·\s*(?:Não executada|Not run)/;
const pause = ms => new Promise(done => setTimeout(done, ms));

// The command row's real foreground color, so error rendering is checked rather than inferred from JSON alone.
function commandColor(term, needle) {
  const buffer = term.term.buffer.active;
  for (let row = 0; row < term.term.rows; row++) {
    const line = buffer.getLine(buffer.viewportY + row), text = line?.translateToString(true) ?? "";
    const column = text.indexOf(needle);
    if (column >= 0) return line.getCell(column)?.getFgColor();
  }
  return undefined;
}

export async function toolStatusJourney({ term, checks, capture, info, relaunch }) {
  const cases = [["SUCCESS", "succeeded"], ["DECLINE", "not_executed"], ["BLOCKED", "not_executed"], ["FAILED", "failed"]];
  checks.cases = [];
  let successColor;
  for (const [mode, expected] of cases) {
    await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
    if (checks.cases.length) await runSlash(term, "/novo");
    await term.send(`STATUS_TOOL_9011 ${mode}`); await term.send("\r");
    if (mode !== "BLOCKED") {
      await term.until(() => APPROVAL.test(term.screen()), `${mode}: approval missing`, 30000);
      if (mode === "DECLINE") await term.send("\x1b[C");
      await term.send("\r");
    }
    const neutral = expected === "not_executed";
    const needle = `node --tool-status-${mode.toLowerCase()}`;
    await term.until(() => neutral ? NEUTRAL.test(term.screen()) : term.screen().includes(needle), `${mode}: live tool row missing`, 30000);
    await term.until(async () => {
      const requests = await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json();
      return JSON.parse(requests.findLast(request => request.toolResult)?.toolResult ?? "{}").status === expected;
    }, `${mode}: canonical outcome missing`, 15000);
    const liveScreen = term.screen(), liveColor = neutral ? null : commandColor(term, needle);
    assert.ok(!liveScreen.includes(`STATUS_DONE_${mode}`), `${mode}: tool was only seen after the final answer`);
    if (mode === "SUCCESS") successColor = liveColor;
    if (expected === "failed") {
      // The running row may have appeared first: wait until its failure color replaces it.
      await term.until(() => commandColor(term, needle) !== undefined && commandColor(term, needle) !== successColor, `${mode}: failure color missing`, 15000);
    }
    const finalLiveColor = neutral ? null : commandColor(term, needle);
    capture(`${mode}: estado ao vivo`);
    await term.until(() => term.screen().includes(`STATUS_DONE_${mode}`), `${mode}: answer missing`, 30000);
    const requests = await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json();
    const output = JSON.parse(requests.findLast(request => request.toolResult)?.toolResult ?? "{}");
    assert.equal(output.status, expected, `${mode}: canonical result differs`);
    if (expected === "failed") assert.ok(output.checks?.some(check => check.exitCode === 1));
    term = await relaunch();
    await term.until(() => term.screen().includes("fixture-coder"), "reopened destination missing", 30000);
    await runSlash(term, "/sessoes");
    await term.until(() => term.screen().includes(`STATUS_TOOL_9011 ${mode}`), `${mode}: conversation missing`, 20000);
    await term.send(`STATUS_TOOL_9011 ${mode}`); await pause(300); await term.send("\r");
    await term.until(() => term.screen().includes(`STATUS_DONE_${mode}`), `${mode}: canonical answer did not reopen`, 30000);
    await term.until(() => neutral ? NEUTRAL.test(term.screen()) : commandColor(term, needle) === finalLiveColor, `${mode}: reopened tool status differs`, 15000);
    capture(`${mode}: estado depois de reabrir`);
    checks.cases.push({ mode, reportedStatus: output.status, live: true, reopened: true, ...(neutral ? { neutralLabel: true, noErrorPopup: !term.screen().includes('QuestionRejectedError') } : { foreground: finalLiveColor, ...(mode !== "SUCCESS" ? { differsFromSuccess: finalLiveColor !== successColor } : {}) }) });
  }
  checks.boundary = "Real core/W5/receipts and native ToolPart; synthetic OCI backend only, no host command or real container";
}
