/**
 * Commands whose panels the previous interface had and the new frontend gained: /copiar (answer and code, through
 * the same clipboard path as a mouse selection), /recursos, /buscar, /editar, /versoes (restoring through the
 * canonical writer), /hooks, /artefatos, /arquivos-chat, /aprovacoes, /revisar and /tema. Each must do what it
 * says or say plainly that there is nothing to do; none may be a silent no-op.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readSystemClipboard, writeSystemClipboard } from "./system-clipboard.mjs";

const ENTER = "\r";
const ESC = "\x1b";
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const CODE = 'const saudação = "olá 世界";\nconsole.log(saudação);';

async function run(term, command, expected, message) {
  await term.send(command);
  await term.until(() => term.screen().includes(command.split(" ")[0]), "the command is not typed", 5000);
  await term.send(ENTER);
  await pause(400);
  if (!expected.test(term.screen()) && term.screen().includes(command)) await term.send(ENTER);
  await term.until(() => expected.test(term.screen()), message, 20000);
}

async function close(term) {
  await term.send(ESC);
  await term.until(() => !/\besc\s*$/m.test(term.screen()), "the panel did not close", 10000);
}

export async function panelsMoreJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("CODIGO_EXEMPLO por favor");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Fim do exemplo."), "the answer with code did not render", 30000);

  await writeSystemClipboard("uptokey-panels-before-answer");
  await run(term, "/copiar", /Resposta copiada/, "/copiar did not copy the answer");
  const answer = (await readSystemClipboard()).toString("utf8");
  assert.ok(answer.includes(CODE) && answer.includes("Fim do exemplo."), "the copied answer is not the answer");
  checks.copyAnswer = true;
  await writeSystemClipboard("uptokey-panels-before-code");
  await run(term, "/copiar codigo", /Código copiado/, "/copiar codigo did not copy the code");
  assert.deepEqual(await readSystemClipboard(), Buffer.from(CODE, "utf8"), "the copied code bytes differ from the code block");
  checks.copyCode = true;
  capture("1. copiar resposta e código");

  await run(term, "/recursos", /Recursos/, "/recursos did not open");
  assert.ok(/\/imagem|\/video|\/transcrever/.test(term.screen()), "capabilities are not listed");
  checks.capabilities = true;
  capture("2. recursos");
  await close(term);

  await run(term, "/buscar", /Buscar nas conversas/, "/buscar did not open");
  await term.send("CODIGO_EXEMPLO");
  await term.until(() => {
    const rows=term.screen().split("\n");
    const title=rows.findIndex(row=>row.includes("Buscar nas conversas"));
    return title>=0 && rows.slice(title+2).some(row=>row.includes("CODIGO_EXEMPLO por favor"));
  }, "search did not find the message in its results", 20000);
  checks.search = true;
  capture("3. busca");
  await close(term);

  const file = join(info.cwd, "math.js");
  const original = await readFile(file, "utf8");
  await run(term, "/editar math.js", /Editor de arquivos/, "/editar did not open the manual editor");
  await term.until(() => /export const sum = \(a, b\) => a - b;/.test(term.screen()), "the file content was not shown", 15000);
  checks.editorView = true;
  const manual = original + '// edição manual: café 世界 👨‍👩‍👧\n';
  await term.send("\x01");
  await term.send(`\x1b[200~${manual}\x1b[201~`);
  await term.until(() => /edição manual: café 世界/.test(term.screen()), "typed text did not reach the manual editor", 10000);
  await term.send("\x13");
  await term.until(async () => (await readFile(file)).equals(Buffer.from(manual, "utf8")), "the manual editor did not save exact Unicode bytes", 40000);
  await term.until(() => /Salvo math\.js\s*·\s*recibo [a-f0-9-]{8,}/i.test(term.screen()), "the manual save did not show its canonical receipt", 15000);
  checks.editorTypedSave = true;
  checks.editorSavedReceipt = /recibo ([a-f0-9-]{8,})/i.exec(term.screen())?.[1];
  capture("4. editar (digitação e gravação com recibo)");
  await close(term);

  await run(term, "/hooks", /Nenhum hook neste projeto/, "/hooks did not say there are none");
  checks.hooks = true;
  await close(term);
  await run(term, "/artefatos", /Nenhum artefato neste projeto|Artefatos/, "/artefatos did not open");
  checks.artifacts = true;
  await close(term);
  await run(term, "/aprovacoes", /Nenhuma aprovação pendente/, "/aprovacoes did not say there are none");
  checks.approvals = true;
  await close(term);
  await run(term, "/revisar", /Nenhuma alteração para revisar|Nenhuma alteração ou aprovação pendente/, "/revisar did not say there is nothing to review");
  checks.review = true;
  await run(term, "/arquivos-chat", /Arquivos desta conversa|Nenhum arquivo ou artefato citado/, "/arquivos-chat did not open");
  checks.chatFiles = true;
  await close(term);
  await run(term, "/tema", /Temas/, "/tema did not open the theme list");
  checks.theme = true;
  capture("5. tema");
  await close(term);

  // An edit, then its earlier version restored through the canonical writer (approval, receipt).
  await term.send("CORRIJA_SOMA");
  await term.send(ENTER);
  await term.until(() => /Revisar alteração proposta/.test(term.screen()), "review prompt did not appear", 40000);
  await term.send(ENTER);
  await term.until(async () => /a \+ b/.test(await readFile(file, "utf8")), "the change was not written", 40000);
  await pause(800);
  await run(term, "/versoes math.js", /Versões de math\.js/, "/versoes did not open");
  await term.until(() => /\d{1,2}[/.:-]\d{1,2}/.test(term.screen().split("\n").slice(0, -4).join("\n")), "no earlier version listed", 15000);
  capture("6. versões");
  await term.send(ENTER);
  await term.until(() => /Restaurar math\.js\?/.test(term.screen()), "restore confirmation did not appear", 10000);
  await term.send(ENTER);
  await term.until(async () => /a - b/.test(await readFile(file, "utf8")), "the earlier version was not restored", 60000);
  checks.restoredEarlierVersion = true;
  capture("7. restaurado");
}
