/** J09/J10 slice: model proposes an edit → review prompt with diff → approve → W5 signature → bytes on disk + receipt. */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";

export async function editJourney({ term, checks, capture, info }) {
  const file = join(info.cwd, "math.js");
  assert.match(await readFile(file, "utf8"), /a - b/, "fixture starts with the bug");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("CORRIJA_SOMA");
  await term.send(ENTER);
  await term.until(() => /Revisar alteração proposta|Review proposed change/.test(term.screen()), "review prompt did not appear", 40000);
  checks.reviewPromptShown = true;
  await term.until(() => term.screen().includes("math.js"), "proposed file is not listed");
  capture("1. revisão da alteração");
  assert.match(await readFile(file, "utf8"), /a - b/, "nothing may be written before approval");
  checks.nothingWrittenBeforeApproval = true;
  await term.send(ENTER);
  await term.until(async () => /a \+ b/.test(await readFile(file, "utf8")), "approved change was not written", 40000);
  checks.bytesWritten = true;
  await term.until(() => !/Revisar alteração proposta|Review proposed change/.test(term.screen()), "review prompt stayed after approval");
  capture("2. aplicado");
  checks.promptClosed = true;
}
