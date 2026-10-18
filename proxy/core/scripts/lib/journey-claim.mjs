/**
 * Unverified success claim in the compiled artifact: the model edits math.js through W5 and then says the tests pass
 * without running anything. The TUI flags the claim (in the person's language) and offers the project's verification;
 * /verificar goes through the canonical runner path, which on a host without the isolated runner reports itself as
 * unavailable instead of fabricating a pass.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runSlash } from "./journey-undo.mjs";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;
const EDITED = "export const sum = (a, b) => a + b;\n";

/** Check the canonical runner row, not the model's claim or the warning that explicitly refutes it. */
export function unavailableVerificationDisplayed(screen) {
  const rows = screen.split(/\r?\n/).filter(line => /^\s*▶\s+Verificação node-app(?:\s|$)/.test(line));
  return rows.length > 0 && rows.every(line => /Verificação node-app indisponível\s*·\s*bloqueada/.test(line));
}

export async function claimJourney({ term, checks, capture, info }) {
  // A Node project: package.json lets the core's node-app profile be chosen for verification.
  await writeFile(join(info.cwd, "package.json"), JSON.stringify({ name: "claim-journey", type: "module", scripts: { test: "node --test" } }, null, 2));
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("AFIRME_7755 corrija a soma");
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), "the edit approval was not requested", 40000);
  await term.send(ENTER);
  // Diagnostics after a write may ask to start a language server; the journey declines it (no external process).
  await term.until(() => term.screen().includes("CLAIM_7755") || (/Iniciar|Start/.test(term.screen()) && APPROVAL.test(term.screen())), "the turn did not finish", 40000);
  if (!term.screen().includes("CLAIM_7755")) { await term.send("\x1b[C"); await term.send(ENTER); }
  await term.until(() => term.screen().includes("CLAIM_7755"), "the claiming answer did not arrive", 40000);
  assert.equal(await readFile(join(info.cwd, "math.js"), "utf8"), EDITED, "the edit was not applied");
  checks.editApplied = true;
  await term.until(() => term.screen().replace(/\s+/g, " ").includes("O modelo diz que deu certo, mas os arquivos atuais ainda não foram verificados por testes aprovados."), "the unverified claim was not flagged", 20000);
  checks.claimFlagged = true;
  // The hint may wrap across lines: compare with whitespace collapsed.
  checks.verificationOffered = /\/verificar roda node-app · test/.test(term.screen().replace(/\s+/g, " "));
  assert.ok(checks.verificationOffered, "the project's verification was not offered");
  capture("1. alegacao sinalizada e verificacao oferecida");
  await runSlash(term, "/verificar");
  // No isolated runner on this host: the canonical path says so; nothing is reported as passed.
  await term.until(() => unavailableVerificationDisplayed(term.screen()), "the runner did not report its actual unavailable/blocked outcome", 30000);
  checks.verificationRanThroughRunnerPath = true;
  checks.noFabricatedPass = unavailableVerificationDisplayed(term.screen());
  assert.ok(checks.noFabricatedPass, "a pass was shown without a runner");
  capture("2. verificacao pelo executor isolado");
}
