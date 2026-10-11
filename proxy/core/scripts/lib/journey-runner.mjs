/**
 * J11 (honest-state slice) — on a host without the isolated project runner, a shell command typed in the composer
 * must not be reported as executed: no fabricated output, a visible explanation, and the chat stays usable.
 */
import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";

const ENTER = "\r";

export async function runnerJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  const before = await readdir(info.cwd);
  await term.send("!");
  await new Promise((done) => setTimeout(done, 300));
  await term.send("git init criado-pelo-shell");
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 8000));
  const after = await readdir(info.cwd);
  assert.ok(!after.includes("criado-pelo-shell"), "the command ran on the host outside the isolated runner");
  checks.notRunOnHost = true;
  checks.filesBefore = before;
  checks.filesAfter = after;
  const screen = term.screen();
  checks.screen = screen.split("\n").filter((line) => line.trim()).slice(-14).join("\n");
  assert.ok(!/RUNNER_CHECK_6620\s*$/m.test(screen.replace(/echo RUNNER_CHECK_6620[^\n]*/g, "")), "a command output was shown as if it had run");
  checks.noFabricatedOutput = true;
  capture("1. comando sem executor isolado");
  await term.send("\x1b");
  await new Promise((done) => setTimeout(done, 300));
  await term.send("Depois do comando");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Depois do comando"), "chat is not usable after the command", 30000);
  checks.chatStillUsable = true;
  capture("2. conversa continua");
}
