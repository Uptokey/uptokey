/**
 * Long history in the compiled artifact: a conversation with more than 100 messages opens on its tail, shows the
 * "earlier messages" line at the top, loads older pages with PageUp, reaches the first message with Ctrl+G and copies
 * the complete conversation (not only the mounted window). Messages are added through the real conversation API.
 */
import assert from "node:assert/strict";
import { readSystemClipboard, writeSystemClipboard } from "./system-clipboard.mjs";
import { runSlash } from "./journey-undo.mjs";

const ENTER = "\r";
const PAGE_UP = "\x1b[5~";
const CTRL_G = "\x07";
const SEEDED = 250;
const marker = (index) => `HIST_${String(index).padStart(3, "0")}`;
const EARLIER = /Mensagens anteriores|Earlier messages|Carregando mensagens anteriores|Loading earlier messages/;

async function api(info, path, body) {
  const response = await fetch(info.baseUrl + path, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const value = await response.json();
  assert.ok(response.ok, `${path}: ${JSON.stringify(value).slice(0, 300)}`);
  return value;
}

export async function historyJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  // The long conversation is created and filled through the real API and never opened before, so the frontend hydrates
  // it from the core exactly like an old conversation: only the tail page first.
  const created = await api(info, "/v1/workspace/conversations/create", { title: "HISTORIA_INICIO_8301", storagePolicy: "local", processingPolicy: "local_only" });
  const conversationId = encodeURIComponent(created.id ?? created.conversation?.id);
  let revision = (await api(info, `/v1/workspace/conversations/${conversationId}`)).revision;
  let parentId = null;
  for (let index = 0; index <= SEEDED; index++) {
    const text = index === 0 ? "HISTORIA_INICIO_8301 primeira mensagem" : `${marker(index)} mensagem semeada`;
    const appended = await api(info, `/v1/workspace/conversations/${conversationId}/messages`, {
      role: index % 2 ? "assistant" : "user", parts: [{ type: "text", text }],
      ...(parentId ? { parentId } : {}), expectedRevision: revision, clientMessageId: `journey-history-${index}`,
    });
    parentId = appended.message.id;
    revision = appended.conversationRevision;
  }
  checks.seededMessages = SEEDED + 1;
  await runSlash(term, "/sessoes");
  await term.until(() => term.screen().includes("HISTORIA_INICIO_8301"), "the sessions list did not show the long conversation", 20000);
  await term.send("HISTORIA_INICIO");
  await new Promise((done) => setTimeout(done, 400));
  await term.send(ENTER);
  await term.until(() => term.screen().includes(marker(SEEDED)), "the long conversation did not reopen on its tail", 30000);
  checks.reopenedOnTail = true;
  capture("1. conversa longa reaberta pela cauda");
  // 251 messages: the tail window mounts the last 100 (HIST_151..HIST_250). PageUp at the top of that window loads one
  // older page (HIST_051..HIST_150) and keeps the reading position; Ctrl+G must then load the remaining page itself.
  const TAIL_START = SEEDED + 1 - 100;
  const visible = () => [...term.screen().matchAll(/HIST_(\d{3})/g)].map((match) => Number(match[1]));
  const lowest = () => Math.min(...visible(), Infinity);
  checks.olderAbsentBeforePaging = lowest() >= TAIL_START;
  let previous = lowest(), largestJump = 0, earlierSeen = false;
  for (let index = 0; index < 120 && lowest() >= TAIL_START; index++) {
    await term.send(PAGE_UP);
    await new Promise((done) => setTimeout(done, 250));
    earlierSeen ||= EARLIER.test(term.screen());
    const now = lowest();
    if (Number.isFinite(now) && Number.isFinite(previous)) largestJump = Math.max(largestJump, previous - now);
    if (Number.isFinite(now)) previous = now;
  }
  assert.ok(lowest() < TAIL_START, "PageUp at the top did not load the older page");
  checks.olderPageLoaded = true;
  // After the prepend the view stays near the old top instead of jumping to the start of the loaded page.
  checks.readingPositionKept = lowest() >= TAIL_START - 30 && largestJump <= 30;
  assert.ok(checks.readingPositionKept, `reading position jumped (lowest ${lowest()}, largest step ${largestJump})`);
  checks.earlierLineObserved = earlierSeen;
  assert.ok(!term.screen().includes("HISTORIA_INICIO_8301"), "the first page was loaded before it was requested");
  capture("2. página anterior carregada mantendo a posição");
  await term.send(CTRL_G);
  await term.until(() => term.screen().includes("HISTORIA_INICIO_8301") || term.screen().includes(marker(1)), "the first message was not reached", 20000);
  checks.firstMessageReached = true;
  capture("3. primeira mensagem");
  // Copying the conversation uses the complete history, not the mounted window.
  await writeSystemClipboard("uptokey-history-before");
  // "/copy" alone copies the last answer; "/copy conversation" copies the whole conversation.
  await term.send("\x15");
  await term.send("/copy conversation");
  await new Promise((done) => setTimeout(done, 500));
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 500));
  if (term.screen().split("\n").some((line) => line.includes("\u2503") && line.includes("/copy conversation"))) await term.send(ENTER);
  await term.until(async () => { const text = (await readSystemClipboard()).toString("utf8"); return text.includes(marker(1)) && text.includes(marker(SEEDED)); }, "the copied conversation is not complete", 15000);
  const copied = (await readSystemClipboard()).toString("utf8");
  checks.copyIncludesFirstAndLast = copied.includes(marker(1)) && copied.includes(marker(SEEDED)) && copied.includes("HISTORIA_INICIO_8301");
  assert.ok(checks.copyIncludesFirstAndLast, "copy omitted part of the conversation");
}
