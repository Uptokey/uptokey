/**
 * J21 (core restart / lost acknowledgement) — a relay between the window and the core cuts every connection and
 * refuses new ones (as a restarting or unreachable daemon does), then lets them through again; later it delivers a
 * message to the core but cuts the reply (the acknowledgement is lost). The window must stay usable, say what
 * happened, recover without being reopened, never send a message twice, and the core must hold exactly what it
 * received.
 */
import assert from "node:assert/strict";

const ENTER = "\r";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

async function userTexts(info) {
  const headers = { authorization: `Bearer ${info.token}` };
  const base = info.directBaseUrl ?? info.baseUrl;
  const list = await (await fetch(`${base}/v1/workspace/conversations?limit=50`, { headers })).json();
  const out = [];
  for (const conversation of list.conversations ?? []) {
    const body = await (await fetch(`${base}/v1/workspace/conversations/${encodeURIComponent(conversation.id)}/messages?limit=200`, { headers })).json();
    for (const message of body.messages ?? []) {
      if (message.role !== "user") continue;
      out.push((message.parts ?? []).map((part) => String(typeof part.text === "string" ? part.text : "")).join(""));
    }
  }
  return out;
}

export async function restartJourney({ term, checks, capture, info, proxy, restartCore }) {
  assert.ok(proxy, "the journey needs the relay");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("Olá antes da queda");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Olá antes da queda"), "the first answer did not render", 30000);
  checks.answeredBeforeOutage = true;
  capture("1. antes da queda");

  // The core goes away.
  proxy.down();
  await term.send("Olá durante a queda");
  await term.send(ENTER);
  await term.until(() => /não foi enviada e voltou para o campo de texto/.test(term.screen()), "the person was not told the message was not sent", 30000);
  checks.toldNotSent = true;
  await term.until(() => (term.screen().match(/Olá durante a queda/g) ?? []).length >= 1, "the unsent text did not come back to the composer", 5000);
  checks.unsentTextRestored = true;
  assert.ok(!/tui_transport_unavailable/.test(term.screen()), "a raw error code is shown");
  checks.noRawCode = true;
  capture("2. durante a queda");
  checks.screenDuringOutage = term.screen().split("\n").filter((line) => line.trim()).slice(-10).join("\n");
  const during = await userTexts(info);
  assert.equal(during.filter((text) => text.includes("Olá durante a queda")).length, 0, "a message reached the core while it was unreachable");
  checks.nothingStoredWhileDown = true;

  // The core is back: the same window works again without being reopened.
  proxy.up();
  await pause(2000);
  // The restored text is still in the composer: clear it before typing the next message.
  await term.send("\x15");
  await pause(200);
  await term.send("Olá depois da queda");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Olá depois da queda"), "the window did not recover after the core came back", 45000);
  checks.recoveredWithoutReopening = true;
  capture("3. depois da volta do core");

  // The reply to a message is lost after the core stored it.
  proxy.dropAckOnce(/^POST \/v1\/workspace\/conversations\/[^ ]+\/messages /);
  await term.send("Olá ACK perdido");
  await term.send(ENTER);
  await term.until(() => /Sua mensagem foi registrada pelo serviço/.test(term.screen()), "the person was not told the message was recorded", 30000);
  checks.toldStoredWithoutAnswer = true;
  capture("4. confirmação perdida");
  checks.dropped = proxy.events.map((event) => event.dropped);
  checks.screenAfterLostAck = term.screen().split("\n").filter((line) => line.trim()).slice(-12).join("\n");
  const stored = await userTexts(info);
  checks.storedUserMessages = stored;
  assert.equal(stored.filter((text) => text.includes("Olá ACK perdido")).length, 1, "the message whose acknowledgement was lost is not stored exactly once");
  checks.lostAckStoredOnce = true;
  assert.equal(stored.filter((text) => text.includes("Olá antes da queda")).length, 1, "an earlier message was duplicated");
  assert.equal(stored.filter((text) => text.includes("Olá depois da queda")).length, 1, "a message after the outage was duplicated");
  checks.noDuplicates = true;

  // The core process itself exits and starts again on the same data, vault and pairing (a daemon restart). The
  // open window keeps working with the same identity and conversation, without being reopened or re-paired.
  const restarted = await restartCore();
  await pause(1500);
  await term.send("Olá depois do reinício");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Olá depois do reinício"), "the window did not keep working after the core process restarted", 60000);
  checks.workedAfterCoreRestart = true;
  capture("5. depois do reinício do core");
  const afterRestart = await userTexts(restarted);
  checks.storedAfterRestart = afterRestart;
  for (const text of ["Olá antes da queda", "Olá depois da queda", "Olá ACK perdido", "Olá depois do reinício"]) {
    assert.equal(afterRestart.filter((value) => value.includes(text)).length, 1, `“${text}” is not stored exactly once after the restart`);
  }
  checks.historyKeptAcrossRestart = true;
}
