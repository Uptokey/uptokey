/**
 * J22 (update and restore over an existing profile) — the same profile and core are opened with a previous
 * distributable, then an updated one, then the previous one again (rollback). Conversations made in each version
 * stay visible in the others and nothing is duplicated; the frontend never owns data that an update could lose.
 *   UPTOKEY_BUNDLE_PREVIOUS=<dir> UPTOKEY_BUNDLE_NEXT=<dir> node … tui-frontend-pty.mjs update
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function userTexts(info) {
  const headers = { authorization: `Bearer ${info.token}` };
  const list = await (await fetch(`${info.baseUrl}/v1/workspace/conversations?limit=50`, { headers })).json();
  const out = [];
  for (const conversation of list.conversations ?? []) {
    const body = await (await fetch(`${info.baseUrl}/v1/workspace/conversations/${encodeURIComponent(conversation.id)}/messages?limit=200`, { headers })).json();
    for (const message of body.messages ?? []) if (message.role === "user") out.push((message.parts ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join(""));
  }
  return out;
}

async function openPrevious(term, title) {
  await term.send("/sessoes");
  await pause(400);
  await term.send(ENTER);
  await pause(300);
  if (/\/sessoes/.test(term.screen())) await term.send(ENTER);
  await term.until(() => term.screen().includes(title), `the conversation “${title}” is not listed`, 20000);
  // Filter to it and open.
  await term.send(title.slice(0, 18));
  await pause(400);
  await term.send(ENTER);
}

export async function updateJourney({ term, checks, capture, info, relaunch }) {
  const previous = process.env.UPTOKEY_BUNDLE_PREVIOUS;
  const next = process.env.UPTOKEY_BUNDLE_NEXT;
  assert.ok(previous && next, "UPTOKEY_BUNDLE_PREVIOUS and UPTOKEY_BUNDLE_NEXT must name two distributables");
  term = await relaunch(previous);
  await term.until(() => term.screen().includes("fixture-coder"), "the previous version did not open", 30000);
  await term.send("Mensagem na versão anterior");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Mensagem na versão anterior"), "the previous version did not answer", 30000);
  checks.previousVersionAnswered = true;
  capture("1. versão anterior");

  term = await relaunch(next);
  await term.until(() => term.screen().includes("fixture-coder"), "the updated version did not open", 30000);
  await openPrevious(term, "Mensagem na versão anterior");
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Mensagem na versão anterior"), "the updated version does not show the earlier conversation", 20000);
  checks.updatedSeesEarlierConversation = true;
  await term.send("Mensagem na versão nova");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Mensagem na versão nova"), "the updated version did not answer", 30000);
  capture("2. versão atualizada");

  term = await relaunch(previous);
  await term.until(() => term.screen().includes("fixture-coder"), "the previous version did not reopen (rollback)", 30000);
  await openPrevious(term, "Mensagem na versão anterior");
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Mensagem na versão nova"), "after the rollback the conversation lost what the updated version added", 20000);
  checks.rollbackKeepsEverything = true;
  capture("3. de volta à versão anterior");

  const stored = await userTexts(info);
  checks.stored = stored;
  assert.equal(stored.filter((text) => text.includes("Mensagem na versão anterior")).length, 1, "a message was duplicated");
  assert.equal(stored.filter((text) => text.includes("Mensagem na versão nova")).length, 1, "a message was duplicated");
  checks.noDuplicates = true;
}
