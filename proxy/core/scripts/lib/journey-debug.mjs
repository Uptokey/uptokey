/**
 * J17 (DAP slice) — /depurar runs a Node program under js-debug after the person confirms the prepared session; the
 * debugger panel shows the real adapter state; a breakpoint stops on the chosen line with the loop variable visible;
 * continuing finishes the program with its real output.
 */
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function choose(term, filter) {
  await term.send(filter);
  await pause(300);
  await term.send(ENTER);
  await pause(300);
}

export async function debugJourney({ term, checks, capture, info }) {
  await writeFile(join(info.cwd, "prog.js"), ["let total = 0", "for (let i = 1; i <= 3; i++) {", "  total += i", "}", "console.log('DEBUG_TOTAL_' + total)", ""].join("\n"));
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("/depurar prog.js");
  await pause(400);
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()) && /Iniciar depuração local/.test(term.screen()) && /Programa: prog.js/.test(term.screen()), "the debug session was not shown for confirmation", 20000);
  checks.sessionConfirmedFirst = true;
  capture("1. confirmação da sessão de depuração");
  await term.send(ENTER);
  await term.until(() => /Depurador/.test(term.screen()) && /pausado/.test(term.screen()), "the debugger panel did not show the paused program", 30000);
  checks.pausedOnEntry = true;
  capture("2. pausado na entrada");
  // F9 (the key every debugger uses) asks for the breakpoint; F5 continues.
  await term.send("\x1b[20~");
  await term.until(() => /arquivo:linha/.test(term.screen()), "the breakpoint prompt did not open", 10000);
  await term.send("prog.js:3");
  await term.send(ENTER);
  // The panel lists more rows than fit: the person filters it like any list.
  await pause(500);
  await term.send("prog.js:3");
  await term.until(() => /Pontos de parada/.test(term.screen()) && /prog\.js:3/.test(term.screen()), "the breakpoint is not listed", 15000);
  checks.breakpointListed = true;
  capture("2b. ponto de parada listado");
  await term.send("\x7f".repeat(9));
  await pause(300);
  await term.until(() => /F5/.test(term.screen()) && /F10/.test(term.screen()), "the debugger keys are not shown", 5000);
  checks.debuggerKeysShown = true;
  await term.send("\x1b[15~");
  await term.until(() => /pausado/.test(term.screen()) && /prog\.js:3/.test(term.screen()) && /\bi = 1\b/.test(term.screen()), "the program did not stop on the breakpoint with i = 1", 20000);
  checks.stoppedOnBreakpointWithVariable = true;
  capture("3. parado no ponto de parada");
  // F5 acts only while paused: wait for each stop of the loop (i = 2, i = 3) before continuing again.
  for (const value of [2, 3]) {
    await term.send("\x1b[15~");
    await term.until(() => /pausado/.test(term.screen()) && term.screen().includes(`i = ${value} `), `the loop did not stop again with i = ${value}`, 20000);
  }
  checks.steppedThroughLoop = true;
  await term.send("\x1b[15~");
  await term.until(() => /DEBUG_TOTAL_6/.test(term.screen()), "the program output did not appear", 20000);
  checks.programOutput = true;
  capture("4. saída do programa");
}
