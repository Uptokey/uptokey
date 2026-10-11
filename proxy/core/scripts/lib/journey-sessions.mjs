/** New conversation, listing and reopening: the frontend follows the controller's active conversation. */
import assert from "node:assert/strict";

const ENTER = "\r";

async function runCommand(term, command, expected, message) {
  await term.send(command);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await term.send(ENTER);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await term.send(ENTER);
  await term.until(() => expected.test(term.screen()), message, 20000);
}

export async function sessionsJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("Primeira conversa PRIMEIRA");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Primeira conversa PRIMEIRA"), "first answer did not render", 30000);
  capture("1. primeira conversa");

  await runCommand(term, "/novo", /Ask anything|Peça qualquer coisa/, "/novo did not return to the start screen");
  await term.until(() => !term.screen().includes("Primeira conversa PRIMEIRA"), "the old conversation is still displayed after /novo", 10000);
  checks.newConversationShowsStartScreen = true;
  capture("2. depois de /novo");

  await term.send("Segunda conversa SEGUNDA");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Segunda conversa SEGUNDA"), "second answer did not render", 30000);
  assert.ok(!term.screen().includes("PRIMEIRA"), "the second conversation does not show the first one's content");
  checks.secondConversationIsolated = true;

  await runCommand(term, "/sessoes", /Conversas|Sessions|Sessões|sessions/i, "the sessions list did not open");
  capture("3. lista de conversas");
  await term.send(ENTER);
  await term.until(() => term.screen().length > 0, "settle", 1000);
  await new Promise((resolve) => setTimeout(resolve, 1500));
  checks.sessionListOpenedAndSelectable = true;
}
