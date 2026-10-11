/** J07: a long, slow answer is not cut off by silence, and reading upward is not pulled back to the end. */
import assert from "node:assert/strict";

const ENTER = "\r";
const PAGE_UP = "\x1b[5~";
const PAGE_DOWN = "\x1b[6~";
const WHEEL_UP = "\x1b[<64;40;12M";

const lines = (screen) => [...screen.matchAll(/LINHA_?(\d{3})/g)].map((match) => Number(match[1]));
const highest = (screen) => Math.max(0, ...lines(screen));
const lowest = (screen) => Math.min(999, ...lines(screen));

export async function scrollJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("LONGA resposta");
  await term.send(ENTER);
  await term.until(() => highest(term.screen()) >= 30, "the long answer did not start streaming", 40000);
  checks.streamingStarted = true;
  // Read upward while it is still streaming.
  for (let index = 0; index < 4; index++) await term.send(PAGE_UP);
  await term.send(WHEEL_UP);
  const before = lowest(term.screen());
  const beforeHighest = highest(term.screen());
  assert.ok(before < beforeHighest, "the viewport moved up from the tail");
  capture("1. lendo acima durante o streaming");
  await new Promise((resolve) => setTimeout(resolve, 2500));
  await term.until(() => true, "settle");
  const after = lowest(term.screen());
  assert.equal(after, before, `the reading position jumped (${before} → ${after}) while the answer kept streaming`);
  checks.readingPositionKeptWhileStreaming = true;
  // The answer keeps going: scroll back to the end and the later lines exist.
  for (let index = 0; index < 12; index++) await term.send(PAGE_DOWN);
  await term.until(() => highest(term.screen()) >= 120, "the stream did not continue to the later lines", 60000);
  checks.streamContinuedWithoutSilenceCutoff = true;
  await term.until(() => highest(term.screen()) >= 160, "the whole answer did not arrive", 60000);
  checks.completeAnswerArrived = true;
  capture("2. resposta completa");
}
