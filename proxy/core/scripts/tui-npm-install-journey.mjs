import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J22 — the npm package installed outside the source tree (`npm pack` + `npm install -g --prefix <tmp>`) opens the
 * promoted OpenTUI frontend through the installed `uptokey` command in a real terminal (ConPTY), against the
 * person's running core, from a fresh project folder; then exits cleanly. Usage:
 *   node scripts/tui-npm-install-journey.mjs <prefix-dir> <project-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openPty } from "./lib/pty-session.mjs";

const [prefix, project] = process.argv.slice(2).map((p) => resolve(p));
await mkdir(project, { recursive: true });
const shim = join(prefix, process.platform === "win32" ? "uptokey.cmd" : "bin/uptokey");
const term = await openPty({ file: process.platform === "win32" ? "cmd.exe" : shim, args: process.platform === "win32" ? ["/d", "/s", "/c", shim] : [], cwd: project, env: { ...process.env, UPTOKEY_TUI_NEXT: "", UPTOKEY_TUI_FRONTEND_DIR: "" } });
const checks = {};
let failure = null;
try {
  // The OpenTUI prompt shows the project folder and an input; the legacy Ink interface does not draw this footer.
  await term.until(() => /ctrl\+p|tab |Ask anything|Pergunte|Mensagem/i.test(term.screen()), "the installed frontend did not draw its prompt", 60000);
  checks.frontendOpened = true;
  // One real answer from the person's configured provider; the expected word is not in the prompt (no false pass).
  await term.send("Junte as partes INSTAL e ADO_OK numa palavra só e responda somente com ela.");
  await term.send("\r");
  await term.until(() => /INSTALADO_OK/.test(term.screen()), "no answer from the provider through the installed package", 120000);
  checks.realAnswer = true;
  checks.screen = term.screen();
  await term.send("\x03");
  await new Promise((r) => setTimeout(r, 800));
  await term.send("\x03");
  for (let i = 0; i < 100 && !term.exited().exited; i++) await new Promise((r) => setTimeout(r, 200));
  checks.exit = term.exited();
  if (!checks.exit.exited) throw new Error("the installed frontend did not exit");
} catch (error) { failure = error; checks.screen = term.screen(); }
finally { await term.close?.(); }
const result = { journey: "npm-install", date: new Date().toISOString(), prefix, project, result: failure ? "failed" : "passed", error: failure?.message ?? null, checks };
const out = tuiEvidenceDirectory(resolve(new URL("../", import.meta.url).pathname.replace(/^\/([A-Z]:)/, "$1")));
await mkdir(out, { recursive: true });
await writeFile(join(out, "npm-install.json"), JSON.stringify(result, null, 2));
console.log(result.result, failure?.message ?? "");
process.exit(failure ? 1 : 0);
