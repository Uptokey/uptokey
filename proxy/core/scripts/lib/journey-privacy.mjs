/**
 *   export    (J15) — /exportar with a file name holding accents, spaces and shell metacharacters writes exactly that
 *                     file in the project with the canonical export bytes; the name never becomes a command.
 *   temporary (J16) — a temporary conversation: the answer works, export is refused, and after closing the window no
 *                     file of the isolated profile (core data, settings, TUI state) contains the request text.
 */
import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";

async function* walk(dir) {
  let entries = [];
  try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full);
    else yield full;
  }
}

/** Runs a slash command the way a person does: type it, Enter picks the completion, Enter submits. */
async function slash(term, command) {
  await term.send(command);
  await term.until(() => term.screen().includes(command.slice(1)), `completion for ${command} did not show`, 10000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 250));
  await term.send(ENTER);
}

export async function exportJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("Conteúdo para exportar EXPORTA_2210");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Resposta do modelo de teste para: Conteúdo para exportar EXPORTA_2210"), "answer did not render", 30000);
  await new Promise((done) => setTimeout(done, 500));
  const name = "relatório final & (v2) $HOME; echo x.json";
  await term.send(`/exportar "${name}"`);
  await new Promise((done) => setTimeout(done, 400));
  await term.send("\x1b");
  await new Promise((done) => setTimeout(done, 200));
  await term.send(ENTER);
  const file = join(info.cwd, name);
  await term.until(async () => (await stat(file).then(() => true, () => false)), "export file with the exact name was not written", 20000);
  checks.exactNameWritten = true;
  const body = JSON.parse(await readFile(file, "utf8"));
  assert.ok(JSON.stringify(body).includes("EXPORTA_2210"), "export does not contain the conversation");
  checks.exportHasConversation = true;
  const siblings = await readdir(info.cwd);
  assert.ok(!siblings.some((entry) => entry === "x.json" || entry.startsWith("relatório final &") && entry !== name), `name was split or interpreted: ${siblings.join(", ")}`);
  checks.nameNotInterpreted = true;
  capture("1. exportado");
  // --abrir (authorized by the Author for this host): the system opener receives the exact path; nothing is
  // interpreted as a command and an opener failure would be a visible, recoverable warning.
  if (process.env.UPTOKEY_JOURNEY_OPEN === "1") {
    const opened = "abrir & teste (v3).md";
    await term.send(`/exportar "${opened}" --abrir`);
    await new Promise((done) => setTimeout(done, 400));
    await term.send("\x1b");
    await new Promise((done) => setTimeout(done, 200));
    await term.send(ENTER);
    await term.until(async () => (await stat(join(info.cwd, opened)).then(() => true, () => false)), "the file to open was not written", 20000);
    await new Promise((done) => setTimeout(done, 6000));
    assert.ok(!/não foi possível iniciar o aplicativo|falhou ao abrir o arquivo/i.test(term.screen()), "the system opener failed");
    const after = await readdir(info.cwd);
    assert.ok(!after.some((entry) => entry === "teste" || entry.startsWith("abrir ") && entry !== opened), `the path was interpreted: ${after.join(", ")}`);
    checks.openedWithSystemApp = true;
    capture("2. aberto no aplicativo do sistema");
  }
}

export async function temporaryJourney({ term, checks, capture, info, relaunch }) {
  const marker = "SEGREDO_TEMPORARIO_7781";
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await slash(term, "/temporaria");
  await term.until(() => /Conversa\s+temporária/.test(term.screen()), "home screen does not say the conversation is temporary", 10000);
  checks.temporaryIndicatorOnHome = true;
  capture("1. modo temporário");
  await term.send(`Pedido ${marker}`);
  await term.send(ENTER);
  await term.until(() => term.screen().includes(`Resposta do modelo de teste para: Pedido ${marker}`), "answer did not render in a temporary conversation", 30000);
  checks.temporaryAnswer = true;
  // The conversation the frontend sent to must be temporary in the core (not only hidden in the list).
  const trace = (await readFile(join(info.cwd, "..", "backend-trace.jsonl"), "utf8")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
  const conversationId = trace.filter((entry) => entry.event === "prompt.submit").at(-1)?.conversation;
  const conversation = await (await fetch(`${info.baseUrl}/v1/workspace/conversations/${encodeURIComponent(conversationId)}`, { headers: { authorization: `Bearer ${info.token}` } })).json();
  assert.equal(conversation.storagePolicy, "temporary", `conversation ${conversationId} is ${conversation.storagePolicy}`);
  checks.coreStoragePolicy = conversation.storagePolicy;
  capture("2. resposta temporária");
  await slash(term, "/exportar");
  await new Promise((done) => setTimeout(done, 2500));
  const exported = (await readdir(info.cwd)).filter((entry) => entry.startsWith("uptokey-conversa-"));
  assert.equal(exported.length, 0, `temporary conversation was exported: ${exported.join(", ")}`);
  checks.exportRefused = true;
  capture("3. exportação recusada");
  await term.send("\x03");
  await term.until(() => term.exited().exited, "window did not exit", 10000).catch(() => {});
  // Reopen: the temporary conversation must not be listed.
  const second = await relaunch();
  await second.until(() => second.screen().includes("fixture-coder"), "second window did not open", 30000);
  await slash(second, "/sessoes");
  await second.until(() => /Conversas|Sessions/.test(second.screen()), "session list did not open", 10000);
  await new Promise((done) => setTimeout(done, 1500));
  assert.ok(!second.screen().includes(marker), "temporary conversation is listed after reopening");
  checks.notListedAfterReopen = true;
  capture("4. reaberto");
  await second.send("\x03");
  await second.until(() => second.exited().exited, "second window did not exit", 10000).catch(() => {});
  await new Promise((done) => setTimeout(done, 500));
  // No stored byte of the isolated profile holds the request text (the debug trace records lengths only).
  const roots = [info.dirs.data, info.dirs.settings, info.dirs.automations, join(info.cwd, ".."), info.cwd];
  const hits = new Set();
  for (const root of roots) {
    for await (const file of walk(root)) {
      if (/backend-trace\.jsonl$/.test(file)) continue;
      const bytes = await readFile(file).catch(() => Buffer.alloc(0));
      if (bytes.includes(Buffer.from(marker)) || bytes.includes(Buffer.from(marker, "utf16le"))) hits.add(file);
    }
  }
  checks.filesWithRequestText = [...hits];
  assert.equal(hits.size, 0, `request text persisted in: ${[...hits].join(", ")}`);
  checks.nothingPersisted = true;
}
