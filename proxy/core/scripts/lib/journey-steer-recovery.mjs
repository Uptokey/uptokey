/**
 * A redirection typed while a turn runs survives the loss of the process: the window is killed with the redirection
 * still queued; after reopening the conversation the text is back in the composer and nothing was sent by itself.
 * Sending it afterwards is the person's own decision and becomes a normal message.
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const STEER = "REDIRECIONE_7731 use o arquivo B";

async function api(info, path) {
  const response = await fetch(info.baseUrl + path, { headers: { authorization: `Bearer ${info.token}` } });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(value).slice(0, 300)}`);
  return value;
}

async function conversationTexts(info) {
  const { conversations } = await api(info, "/v1/workspace/conversations");
  const target = conversations.find((conversation) => String(conversation.title ?? "").includes("SILENCIO")) ?? [...conversations].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  assert.ok(target, "the conversation was not created");
  const page = await api(info, `/v1/workspace/conversations/${encodeURIComponent(target.id)}/messages?limit=200`);
  return (page.messages ?? page).map((message) => JSON.stringify(message.parts ?? message.content ?? ""));
}

export async function steerRecoveryJourney({ term, checks, capture, info, relaunch }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  // The fixture answers "inicio", waits four seconds and then "fim": the turn is busy meanwhile.
  await term.send("SILENCIO redirecionamento");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("inicio"), "the turn did not start", 20000);
  await term.send(STEER);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 1200));
  assert.ok(!term.screen().includes("fim"), "the turn ended before the window was killed");
  capture("1. redirecionamento na fila durante o turno");
  const requestsBefore = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).length;
  // Process loss: the window is killed while the redirection is still queued.
  term = await relaunch();
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible after the restart", 30000);
  checks.windowKilledWithQueue = true;
  await term.send("\x15");
  await term.send("/sessoes");
  await term.until(() => term.screen().includes("/sessoes"), "command list did not show /sessoes", 15000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 500));
  if (term.screen().split("\n").some((line) => line.includes("┃") && line.includes("/sessoes"))) await term.send(ENTER);
  await term.until(() => term.screen().includes("SILENCIO"), "the sessions list did not show the conversation", 20000);
  await term.send("SILENCIO");
  await new Promise((done) => setTimeout(done, 400));
  await term.send(ENTER);
  await term.until(() => term.screen().includes("REDIRECIONE_7731"), "the queued redirection did not return to the composer", 20000);
  checks.redirectionBackInComposer = true;
  capture("2. redirecionamento devolvido ao compositor");
  await new Promise((done) => setTimeout(done, 1500));
  const requestsAfter = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).length;
  assert.equal(requestsAfter, requestsBefore, "a model request was made by itself after the restart");
  assert.ok(!(await conversationTexts(info)).some((text) => text.includes("REDIRECIONE_7731")), "the redirection was written to the conversation without being sent");
  checks.nothingSentByItself = true;
  // Sending it is the person's decision: it becomes a normal message of the conversation.
  await term.send(ENTER);
  await term.until(async () => (await conversationTexts(info)).some((text) => text.includes("REDIRECIONE_7731")), "sending the restored redirection did not reach the conversation", 30000);
  checks.sentWhenThePersonDecides = true;
  capture("3. enviado por decisao da pessoa");
}
