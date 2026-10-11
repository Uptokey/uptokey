/** J01/J11 slice: clean exit restores the terminal; Esc interrupts a running answer and the chat stays usable. */
import assert from "node:assert/strict";

const ENTER = "\r";
const ESC = "\x1b";

export async function exitJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  assert.ok(term.raw().includes("\x1b[?1049h"), "the alternate screen is used while the interface runs");
  await term.send("exit");
  await term.send(ENTER);
  await term.until(() => term.exited().exited, "typing exit did not end the interface", 15000);
  assert.equal(term.exited().exitCode, 0, "clean exit code");
  checks.exitCodeZero = true;
  const raw = term.raw();
  assert.ok(raw.lastIndexOf("\x1b[?1049l") > raw.lastIndexOf("\x1b[?1049h"), "the alternate screen was left");
  assert.ok(raw.lastIndexOf("\x1b[?25h") > raw.lastIndexOf("\x1b[?25l"), "the cursor is visible again");
  assert.ok(raw.lastIndexOf("\x1b[?2004l") > raw.lastIndexOf("\x1b[?2004h"), "bracketed paste was turned off");
  // ConPTY owns mouse input modes on Windows and does not forward their reset; elsewhere the reset is verified.
  if (process.platform !== "win32") {
    for (const mode of ["1000", "1002", "1003", "1006"]) {
      assert.ok(raw.lastIndexOf(`\x1b[?${mode}l`) > raw.lastIndexOf(`\x1b[?${mode}h`), `mouse mode ${mode} was turned off`);
    }
  }
  checks.terminalRestored = true;
  capture("1. saida limpa");
}

export async function cancelJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("LONGA resposta");
  await term.send(ENTER);
  await term.until(() => /LINHA_?010/.test(term.screen()), "the answer did not start", 30000);
  capture("1. durante a resposta");
  await term.send(ESC);
  await term.send(ESC);
  await term.until(() => !/esc\s+interrupt/.test(term.screen()), "the run is still marked as active after Esc", 15000);
  checks.interrupted = true;
  await new Promise((resolve) => setTimeout(resolve, 800));
  const stopped = Math.max(...[...term.screen().matchAll(/LINHA_?(\d{3})/g)].map((match) => Number(match[1])), 0);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const later = Math.max(...[...term.screen().matchAll(/LINHA_?(\d{3})/g)].map((match) => Number(match[1])), 0);
  assert.ok(later - stopped <= 3, `the answer kept arriving after the interrupt (${stopped} → ${later})`);
  checks.noMoreOutputAfterInterrupt = true;
  await term.send("Explique a soma");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Explique a soma"), "the chat was not reusable after the interrupt", 30000);
  checks.chatReusableAfterInterrupt = true;
  capture("2. conversa reutilizavel");
}
