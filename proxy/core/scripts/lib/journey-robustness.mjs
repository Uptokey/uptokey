/**
 * Robustness journeys against the isolated real core:
 *   reopen   (J03) — a second window reuses the saved destination and lists the earlier conversation, no re-setup.
 *   paste    (J06) — bracketed multi-line paste stays text in the composer and is not sent by itself.
 *   conflict (J10) — the file changes on disk after the proposal and before approval: nothing overwrites the human edit.
 *   network  (J21) — the upstream drops mid-answer: the partial text stays visible, the turn ends, the next turn works.
 */
import assert from "node:assert/strict";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const REVIEW = /Revisar alteração proposta|Review proposed change/;

export async function reopenJourney({ term, checks, capture, relaunch }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("Primeira janela REABRIR_5521");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Primeira janela REABRIR_5521"), "first answer did not render", 30000);
  capture("1. primeira janela");
  await term.send("\x03");
  await term.until(() => term.exited().exited, "first window did not exit", 10000).catch(() => {});
  const second = await relaunch();
  await second.until(() => second.screen().includes("fixture-coder"), "second window lost the selected destination", 30000);
  checks.destinationKept = true;
  assert.doesNotMatch(second.screen(), /Conectar um provedor|Connect a provider/, "second window asked for setup again");
  checks.noSetupAgain = true;
  await second.send("/sessoes");
  await second.until(() => /sessoes/.test(second.screen()), "command list did not show /sessoes", 15000);
  await second.send(ENTER);
  await second.send(ENTER);
  await second.until(() => /Primeira janela REABRIR_5521/.test(second.screen()), "earlier conversation is not listed in the second window", 20000);
  checks.conversationListed = true;
  capture("2. segunda janela");
}

export async function pasteJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  const pasted = "linha um com m c p\nlinha dois COLADA_3390\nlinha três";
  await term.send(`\x1b[200~${pasted}\x1b[201~`);
  // Three lines are summarised in the composer as "[Colado ~3 linhas]" (localized); the full text is sent.
  await term.until(() => /Colado ~3 linhas/.test(term.screen()), "pasted text did not reach the composer as a summary", 10000);
  checks.pasteSummarizedLocalized = true;
  await new Promise((done) => setTimeout(done, 800));
  assert.doesNotMatch(term.screen(), /Resposta do modelo de teste/, "paste sent the message by itself");
  checks.pasteNotSent = true;
  capture("1. texto colado no compositor");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: linha um com m c p"), "sending the pasted text failed", 30000);
  const screen = term.screen();
  assert.ok(/linha um com m c p/.test(screen) && /COLADA_3390/.test(screen) && /linha três/.test(screen), "multi-line paste lost lines or letters");
  checks.pasteIntactAfterSend = true;
  checks.sentOnEnter = true;
  capture("2. enviado com Enter");
}

export async function conflictJourney({ term, checks, capture, info }) {
  const file = join(info.cwd, "math.js");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("CORRIJA_SOMA");
  await term.send(ENTER);
  await term.until(() => REVIEW.test(term.screen()), "review prompt did not appear", 40000);
  // The person edits the same file by hand before approving.
  const human = "// edição humana HUMANO_6604\nexport const sum = (a, b) => a - b;\n";
  await writeFile(file, human);
  capture("1. revisão aberta, arquivo alterado por fora");
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 4000));
  const after = await readFile(file, "utf8");
  assert.ok(after.includes("HUMANO_6604"), "the human edit was lost");
  checks.humanEditPreserved = true;
  assert.equal(after, human, "the proposal was applied over a file it did not read");
  checks.staleProposalNotApplied = true;
  capture("2. após aprovar");
  checks.screenAfterApproval = term.screen().split("\n").filter((line) => line.trim()).slice(-12).join("\n");
}

/** Messages the core stored for every conversation of the fixture identity (role, parts summary). */
async function persistedMessages(info) {
  const headers = { authorization: `Bearer ${info.token}` };
  const list = await (await fetch(`${info.baseUrl}/v1/workspace/conversations?limit=50`, { headers })).json();
  const out = [];
  for (const conversation of list.conversations ?? []) {
    const body = await (await fetch(`${info.baseUrl}/v1/workspace/conversations/${encodeURIComponent(conversation.id)}/messages?limit=200`, { headers })).json();
    for (const message of body.messages ?? []) out.push({ conversation: conversation.id.slice(-6), role: message.role, parts: (message.parts ?? []).map((part) => `${part.type}:${String(part.text ?? "").slice(0, 40)}`) });
  }
  return out;
}

/**
 * J12 — the person starts a new conversation while the previous answer is still arriving (a 4 s silence in the
 * middle). The late output must not appear in the new conversation, and nothing of it may be stored there.
 */
export async function switchJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("SILENCIO depois troca");
  await term.send(ENTER);
  await term.until(() => /\binicio\b/.test(term.screen()), "first part of the slow answer did not render", 30000);
  capture("1. resposta lenta em andamento");
  await term.send("/novo");
  await term.until(() => /novo/.test(term.screen()), "command list did not show /novo", 10000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 200));
  await term.send(ENTER);
  await term.until(() => !term.screen().includes("SILENCIO depois troca"), "the new conversation did not open", 10000);
  // The upstream sends the rest ("fim") about 4 s after the start; wait past it.
  await new Promise((done) => setTimeout(done, 5000));
  assert.ok(!/\bfim\b/.test(term.screen()) && !/\binicio\b/.test(term.screen()), "late output of the previous conversation appeared after switching");
  checks.noLateOutputOnScreen = true;
  capture("2. nova conversa após o atraso");
  await term.send("Pergunta na nova conversa");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Pergunta na nova conversa"), "the new conversation did not answer", 30000);
  const stored = await persistedMessages(info);
  checks.persisted = stored;
  const byConversation = new Map();
  for (const message of stored) byConversation.set(message.conversation, [...(byConversation.get(message.conversation) ?? []), message]);
  const newer = [...byConversation.values()].find((messages) => messages.some((message) => message.parts.some((part) => part.includes("Pergunta na nova conversa"))));
  assert.ok(newer, "the new conversation was not stored");
  assert.ok(!newer.some((message) => message.parts.some((part) => /\bfim\b|SILENCIO|\binicio\b/.test(part))), "the previous answer leaked into the new conversation");
  checks.noLeakInStore = true;
  const older = [...byConversation.values()].find((messages) => messages.some((message) => message.parts.some((part) => part.includes("SILENCIO depois troca"))));
  checks.previousConversationKept = Boolean(older);
  assert.ok(older, "the previous conversation was lost");
  capture("3. nova conversa respondeu");
}

export async function networkJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("QUEBRA_REDE agora");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("PARCIAL_8812"), "partial text did not render", 30000);
  checks.partialRendered = true;
  // The turn must end (no endless spinner) and the partial text must stay on screen.
  await term.until(() => !/esc (?:interromper|interrupt)/.test(term.screen()), "turn did not end after the connection dropped", 30000);
  // Sample the screen for 3 s after the turn ends: the partial must be visible and stay visible (no flicker).
  const samples = [];
  for (let index = 0; index < 60; index++) {
    samples.push(term.screen().includes("PARCIAL_8812") ? 1 : 0);
    if (!samples.at(-1) && !checks.firstMissingScreen) checks.firstMissingScreen = term.screen().split("\n").filter((line) => line.trim()).slice(-14).join("\n");
    await new Promise((done) => setTimeout(done, 50));
  }
  checks.partialVisibleSamples = samples.join("");
  checks.persisted = await persistedMessages(info);
  assert.ok(samples.every(Boolean), `partial text not visible in every sample after the failure: ${samples.join("")}`);
  checks.partialPreserved = true;
  capture("1. queda no meio da resposta");
  await term.send("Depois da queda");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Depois da queda"), "next turn did not work after the failure", 30000);
  checks.nextTurnWorks = true;
  capture("2. próxima mensagem");
}

/**
 * J12 (project switch) — while an answer is still arriving in project A, the person moves the window to another
 * folder (project B). The late output must not show up after the switch nor be stored in B's conversation; A's
 * conversation is kept; B answers normally.
 */
export async function switchProjectJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("SILENCIO antes de mudar de projeto");
  await term.send(ENTER);
  await term.until(() => /\binicio\b/.test(term.screen()), "first part of the slow answer did not render", 30000);
  capture("1. resposta lenta no projeto A");
  await term.send(`/projetos ${info.cwdB}`);
  await term.until(() => term.screen().replace(/\s+/g, "").includes("/projetos"), "the command did not reach the composer", 10000);
  capture("1b. comando digitado");
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 400));
  if (term.screen().includes(`/projetos ${info.cwdB}`)) await term.send(ENTER);
  const folderB = info.cwdB.split(/[\\/]/).filter(Boolean).at(-1);
  // The footer (last line) names the linked folder; the composer must not keep the command that was already run.
  const footer = () => term.screen().split("\n").filter((line) => line.trim()).at(-1) ?? "";
  await term.until(() => footer().includes(folderB) && !term.screen().includes("SILENCIO antes de mudar de projeto"), "the window did not move to project B", 20000);
  checks.movedToProjectB = true;
  await term.until(() => !term.screen().includes("/projetos"), "the executed command stayed in the composer", 5000);
  checks.composerCleared = true;
  await new Promise((done) => setTimeout(done, 5000));
  assert.ok(!/\bfim\b/.test(term.screen()) && !/\binicio\b/.test(term.screen()), "late output of project A appeared after switching to project B");
  checks.noLateOutputOnScreen = true;
  capture("2. projeto B após o atraso");
  await term.send("Pergunta no projeto B");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Pergunta no projeto B"), "project B did not answer", 30000);
  const headers = { authorization: `Bearer ${info.token}` };
  const conversations = (await (await fetch(`${info.baseUrl}/v1/workspace/conversations?limit=50`, { headers })).json()).conversations ?? [];
  const stored = await persistedMessages(info);
  const byConversation = new Map();
  for (const message of stored) byConversation.set(message.conversation, [...(byConversation.get(message.conversation) ?? []), message]);
  const inB = [...byConversation.entries()].find(([, messages]) => messages.some((message) => message.parts.some((part) => part.includes("Pergunta no projeto B"))));
  const inA = [...byConversation.entries()].find(([, messages]) => messages.some((message) => message.parts.some((part) => part.includes("SILENCIO antes de mudar de projeto"))));
  assert.ok(inB, "project B's conversation was not stored");
  assert.ok(!inB[1].some((message) => message.parts.some((part) => /\bfim\b|SILENCIO|\binicio\b/.test(part))), "project A's answer leaked into project B's conversation");
  checks.noLeakInStore = true;
  assert.ok(inA, "project A's conversation was lost");
  assert.notEqual(inA[0], inB[0], "both projects share one conversation");
  const projectOf = (suffix) => conversations.find((conversation) => conversation.id.endsWith(suffix))?.projectId ?? null;
  checks.projects = { a: projectOf(inA[0]), b: projectOf(inB[0]) };
  if (checks.projects.a && checks.projects.b) assert.notEqual(checks.projects.a, checks.projects.b, "the conversations are linked to the same project");
  checks.separateConversations = true;
  capture("3. projeto B respondeu");
}
