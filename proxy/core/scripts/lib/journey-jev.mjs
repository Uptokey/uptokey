/**
 * Jev in the terminal: the person stores a TypeSafe key with /jev (masked; the core keeps it in the vault for this
 * terminal's identity), Jev becomes active, a destructive request is held for confirmation before anything is sent,
 * and a decision waiting for approval shows Jev's reading. The scripted System One stands in for TypeSafe.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const KEY = "ts_fixture_key_4242";
const REVIEW = /Revisar alteração proposta|Review proposed change/;

const upstream = async (info, path) => (await fetch(`http://127.0.0.1:${info.upstreamPort}${path}`)).json();

async function slash(term, command) {
  await term.send(command);
  await term.until(() => term.screen().includes(command.slice(1)), `completion for ${command} did not show`, 10000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 250));
  await term.send(ENTER);
}

export async function jevJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await slash(term, "/jev");
  await term.until(() => /Jev inativo/.test(term.screen()), "the /jev panel did not report Jev as inactive before a key", 15000);
  checks.inactiveBeforeKey = true;
  capture("1. Jev sem perfil");
  // Second row: add the TypeSafe key.
  await term.send("\x1b[B");
  await term.send(ENTER);
  await term.until(() => /TypeSafe/.test(term.screen()) && /chave|key/i.test(term.screen()), "the masked key prompt did not open", 10000);
  await term.send(KEY);
  assert.ok(!term.screen().includes(KEY), "the key was echoed on screen");
  await term.send(ENTER);
  await term.until(() => /Jev ativo/.test(term.screen()), "Jev did not become active after saving the key", 15000);
  assert.ok(!term.screen().includes(KEY), "the key appeared on screen");
  checks.activeAfterKey = true;
  capture("2. Jev ativo");
  await term.send("\x1b");
  await new Promise((done) => setTimeout(done, 300));

  const chatBefore = (await upstream(info, "/__requests")).length;
  await term.send("APAGUE_TUDO do banco de dados agora");
  await term.send(ENTER);
  await term.until(() => /parece destruir algo/.test(term.screen()), "Jev did not hold the destructive request for confirmation", 15000);
  checks.destructiveHeld = true;
  capture("3. pedido destrutivo retido");
  await term.send("\x1b");
  await new Promise((done) => setTimeout(done, 1500));
  assert.equal((await upstream(info, "/__requests")).length, chatBefore, "the held request reached the model");
  checks.nothingSentWhenDeclined = true;

  await term.send("\x15");
  await term.send("CORRIJA_SOMA");
  await term.send(ENTER);
  await term.until(() => REVIEW.test(term.screen()), "review prompt did not appear", 40000);
  await term.until(() => /Jev · alinhado ao pedido \d+%/.test(term.screen()), "the review prompt does not show Jev's reading", 15000);
  checks.reviewShowsJev = true;
  capture("4. revisão com leitura do Jev");
  assert.match(await readFile(join(info.cwd, "math.js"), "utf8"), /a - b/, "nothing may be written before approval");

  const judged = await upstream(info, "/__typesafe");
  checks.typesafeRequests = judged.map((entry) => ({ questions: entry.questions, model: entry.model, bearerMatchesStoredKey: entry.auth === `Bearer ${KEY}` }));
  assert.ok(judged.length >= 2, "Jev was not called for the request and the decision");
  assert.ok(judged.every((entry) => entry.auth === `Bearer ${KEY}`), "the core did not use the stored TypeSafe key");
  checks.coreUsedStoredKey = true;
}
