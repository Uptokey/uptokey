/**
 * J04 — two accounts expose a model with the same name. The person picks the second account's model in /modelos;
 * the next turn must reach exactly that account's endpoint (checked on the scripted upstream's request log), and the
 * composer must say which account is selected.
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const DOWN = "\x1b[B";
const SECOND = "custom-fixture-dois";

async function upstreamRequests(info) {
  return (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json();
}

export async function homonymJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  // Open the model list and walk down until the composer shows the second account (each step: open, move, choose).
  let chosen = false;
  for (let steps = 1; steps <= 8 && !chosen; steps++) {
    await term.send("/modelos");
    await term.until(() => /modelos/.test(term.screen()), "command list did not show /modelos", 10000);
    await term.send(ENTER);
    await new Promise((done) => setTimeout(done, 200));
    await term.send(ENTER);
    await term.until(() => term.screen().includes(SECOND), "the model list does not show the second account", 15000);
    if (steps === 1) capture("1. lista com modelos homônimos");
    for (let index = 0; index < steps; index++) await term.send(DOWN);
    await new Promise((done) => setTimeout(done, 150));
    await term.send(ENTER);
    await new Promise((done) => setTimeout(done, 700));
    chosen = new RegExp(`fixture-coder\\s+${SECOND}`).test(term.screen());
  }
  assert.ok(chosen, "could not select the second account's model");
  checks.secondAccountShownInComposer = true;
  capture("2. destino escolhido");
  const before = (await upstreamRequests(info)).length;
  await term.send("Pedido para a segunda conta HOMONIMO_5150");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Pedido para a segunda conta HOMONIMO_5150"), "answer did not render", 30000);
  const requests = (await upstreamRequests(info)).slice(before);
  checks.requests = requests;
  assert.ok(requests.length >= 1, "no request reached the upstream");
  assert.ok(requests.every((request) => request.path.startsWith(`/${SECOND}/`)), `a request reached another account: ${JSON.stringify(requests)}`);
  checks.reachedOnlyChosenEndpoint = true;
  capture("3. resposta pela segunda conta");
}
