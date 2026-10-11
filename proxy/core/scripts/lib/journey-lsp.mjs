/**
 * J17 (LSP slice) — a real language server in the real terminal. typescript-language-server is not installed on this
 * host, so the project's own TypeScript 7 (`tsc --lsp --stdio`, Apache-2.0) serves it: /diagnosticos asks consent for
 * that exact command, then shows the compiler's real error; /renomear turns the server's workspace edit into a
 * reviewed proposal; the bytes change only after approval.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, symlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ENTER = "\r";
const APPROVAL = /Aprovação necessária|Approval required/;
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
const core = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

export async function lspJourney({ term, checks, capture, info }) {
  const file = join(info.cwd, "main.ts");
  await writeFile(file, ['const answer: number = "x";', "export function soma(a: number, b: number) { return a + b }", "export const total = soma(1, 2);", ""].join("\n"));
  await writeFile(join(info.cwd, "tsconfig.json"), JSON.stringify({ compilerOptions: { strict: true, module: "nodenext", target: "es2022", noEmit: true } }));
  // The project depends on TypeScript 7 (a link to the copy this repository installs, as workspaces and pnpm do).
  await mkdir(join(info.cwd, "node_modules"), { recursive: true });
  await symlink(join(core, "node_modules", "typescript"), join(info.cwd, "node_modules", "typescript"), "junction");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);

  await term.send("/diagnosticos main.ts");
  await pause(400);
  await term.send(ENTER);
  await term.until(() => APPROVAL.test(term.screen()) && /Iniciar servidor de linguagem/.test(term.screen()) && /--lsp --stdio/.test(term.screen()), "the language server was not offered for consent", 30000);
  checks.consentAskedForExactCommand = true;
  capture("1. consentimento do servidor de linguagem");
  // The approval dialog is painted before its asynchronous Jev advisory settles.
  // Enter sent during that short transition is deliberately ignored by the UI.
  await term.until(() => /Jev não avaliou|Jev avaliou/.test(term.screen()), "the approval advisory did not settle", 10000);
  await pause(250);
  for (let attempt = 0; attempt < 3 && APPROVAL.test(term.screen()); attempt += 1) {
    await term.send(ENTER);
    await pause(300);
  }
  await term.until(() => /Diagnósticos typescript(-native)?: 1 erro/.test(term.screen()) && /not assignable to type/.test(term.screen()), "the compiler's error was not reported", 60000);
  checks.realDiagnosticReported = true;
  capture("2. diagnóstico real do TypeScript 7");

  // References and definition of `soma` (declared on line 2, used on line 3).
  await term.send("/referencias main.ts:2:17");
  await pause(400);
  await term.send(ENTER);
  await pause(300);
  if (/\/referencias main/.test(term.screen())) await term.send(ENTER);
  await term.until(() => /Referências de main\.ts:2:17 \(2\)/.test(term.screen()) && /main\.ts:2:17/.test(term.screen()) && /main\.ts:3:22/.test(term.screen()), "the references were not listed", 30000);
  assert.match(term.screen(), /export const total = soma\(1, 2\);/, "the reference line text is not shown");
  checks.realReferences = true;
  capture("2b. referências");
  await term.send("\x1b");
  await pause(400);
  await term.send("/definicao main.ts:3:22");
  await pause(400);
  await term.send(ENTER);
  await pause(300);
  if (/\/definicao main/.test(term.screen())) await term.send(ENTER);
  await term.until(() => /Definição de main\.ts:3:22/.test(term.screen()) && /main\.ts:2:17/.test(term.screen()), "the definition was not shown", 30000);
  checks.realDefinition = true;
  capture("2c. definição");
  await term.send("\x1b");
  await pause(400);

  await term.send("/renomear main.ts:2:17 adicionar");
  await pause(400);
  await term.send(ENTER);
  await term.until(() => /Revisar alteração proposta|Review proposed change/.test(term.screen()) && term.screen().includes("main.ts"), "the rename was not offered for review", 60000);
  checks.renameReviewedBeforeWriting = true;
  assert.doesNotMatch(await readFile(file, "utf8"), /adicionar/, "nothing may be written before approval");
  checks.nothingWrittenBeforeApproval = true;
  capture("3. revisão da renomeação");
  await term.send(ENTER);
  await term.until(async () => ((await readFile(file, "utf8")).match(/adicionar/g) ?? []).length === 2, "the approved rename was not written in both places", 40000);
  const after = await readFile(file, "utf8");
  assert.doesNotMatch(after, /\bsoma\b/, "an occurrence of the old name remains");
  checks.renameAppliedEverywhere = true;
  capture("4. renomeação aplicada");
}
