/**
 * Model-callable delegation in the compiled artifact: with external processing allowed and a governed lane present,
 * the model calls delegate_task; one review covers the whole task, read-only children run on the lane, their answers
 * come back to the model and the turn ends with its integrated answer. The task and its children are visible.
 */
import assert from "node:assert/strict";
import { runSlash } from "./journey-undo.mjs";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;

export async function delegateTaskJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  // delegate_task is offered only where /delegate could run: external processing allowed on a persistent session.
  await term.send("ola");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: ola"), "the first answer did not render", 30000);
  await term.send("\x15");
  await term.send("/processamento externo");
  await new Promise((done) => setTimeout(done, 500));
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 500));
  if (term.screen().split("\n").some((line) => line.includes("┃") && line.includes("/processamento externo"))) await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 800));
  const before = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__lane`)).json()).length;
  await term.send("DELEGUE_7766 revise a soma");
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()), "the delegation was not reviewed", 40000);
  checks.oneReviewForTheTask = true;
  capture("1. revisao da tarefa delegada");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("DELEGATED_7766"), "the integrated answer did not arrive", 60000);
  const lane = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__lane`)).json()).slice(before);
  assert.equal(lane.length, 2, `expected two children on the governed lane, got ${lane.length}`);
  checks.childrenRanOnLane = lane.length;
  checks.childrenHadNoTools = lane.every((chat) => !chat.tools?.length);
  assert.ok(checks.childrenHadNoTools, "a child received tools");
  checks.integratedAnswer = true;
  capture("2. resposta integrada");
}
