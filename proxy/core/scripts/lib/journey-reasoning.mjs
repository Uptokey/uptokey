/**
 * Live activity in the compiled artifact: while the turn runs, the model's reasoning appears (in the person's
 * language), then the tool it calls, then the answer. The reasoning is not written into the answer or the history.
 */
import assert from "node:assert/strict";
import { runSlash } from "./journey-undo.mjs";

const ENTER = "\r";
// The reasoning is rendered as markdown: "_x_" may be concealed as emphasis, so markers match with or without it.
const marker = (letter) => new RegExp(`RACIOCINIO_?${letter}_?7744`);

async function api(info, path) {
  const response = await fetch(info.baseUrl + path, { headers: { authorization: `Bearer ${info.token}` } });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(value).slice(0, 300)}`);
  return value;
}

export async function reasoningJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  // /thinking belongs to the conversation screen: open one first. Collapsed by default ("Raciocínio" only);
  // /thinking shows the reasoning text itself.
  await term.send("ola");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: ola"), "the first answer did not render", 30000);
  await runSlash(term, "/thinking");
  await new Promise((done) => setTimeout(done, 500));
  await term.send("PENSE_7744 explique o README");
  await term.send(ENTER);
  await term.until(() => marker("A").test(term.screen()), "the reasoning did not appear while the model was thinking", 20000);
  assert.ok(!term.screen().includes("PENSAMENTO_OK_7744"), "the answer arrived before the reasoning was seen");
  checks.reasoningShownLive = true;
  checks.reasoningLabelLocalized = /Raciocínio/.test(term.screen());
  capture("1. raciocinio visivel durante o turno");
  await term.until(() => marker("B").test(term.screen()), "the second reasoning field (Ollama style) did not appear", 20000);
  checks.bothReasoningFieldsShown = true;
  await term.until(() => term.screen().includes("README.md"), "the tool call was not shown", 20000);
  // The tool is visible while the turn still runs (persisted items would also show it, but only after the answer).
  assert.ok(!term.screen().includes("PENSAMENTO_OK_7744"), "the tool only appeared together with the final answer");
  checks.toolShownDuringTurn = true;
  checks.reasoningClosedLocalized = /Raciocinou/.test(term.screen());
  capture("2. ferramenta durante o turno");
  await term.until(() => term.screen().includes("PENSAMENTO_OK_7744"), "the final answer did not arrive", 20000);
  checks.answerShown = true;
  capture("3. resposta final");
  // The reasoning is live only: the stored answer is the answer text alone.
  const { conversations } = await api(info, "/v1/workspace/conversations");
  const conversation = [...conversations].sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)))[0];
  const page = await api(info, `/v1/workspace/conversations/${encodeURIComponent(conversation.id)}/messages?limit=200`);
  const stored = JSON.stringify(page.messages ?? page);
  assert.ok(stored.includes("PENSAMENTO_OK_7744"), "the answer was not stored");
  assert.ok(!stored.includes("RACIOCINIO_A_7744") && !stored.includes("RACIOCINIO_B_7744"), "the reasoning was written into the conversation");
  checks.reasoningNotStored = true;
}
