import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J18 with the real stack: the promoted TUI, the person's daemon, the real DeepSeek model and the public internet.
 * The model asks for web_fetch on a public page; the person approves; the core fetches it through its governed
 * egress; the result returns to the same model, which answers with the page title.
 *   node scripts/tui-real-web-journey.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(import.meta.dirname, "..");
const out = tuiEvidenceDirectory(core);
const artifact = join(core, "dist", "tui");
const project = join(out, "real-web-project");
await mkdir(project, { recursive: true });
await writeFile(join(project, "README.md"), "# Projeto sintético\n");
const shots = [];
const checks = {};
const started = Date.now();
const term = await openPty({ file: join(artifact, "runtime", "bun.exe"), args: [join(artifact, "main.js")], cwd: project, env: { ...process.env, OTUI_TREE_SITTER_WORKER_PATH: join(artifact, "opentui-tree-sitter-worker.js"), UPTOKEY_TUI_CALLER_CWD: project, UPTOKEY_LANG: "pt-BR" } });
const capture = (title) => shots.push(`--- ${title} ---\n${term.screen()}`);
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
let failure = null;
try {
  await term.until(() => /deepseek/i.test(term.screen()), "the interface did not open on the real daemon", 60000);
  await pause(1500);
  await term.send("Use a ferramenta web_fetch para ler https://example.com e responda somente com o título da página.");
  await pause(500);
  await term.send("\r");
  const deadline = Date.now() + 240000;
  while (Date.now() < deadline) {
    const screen = term.screen();
    if (/Aprovação necessária|Aprovar/.test(screen)) { checks.approvalAsked = true; capture("aprovação da busca web"); await term.send("\r"); await pause(1500); continue; }
    if (screen.split("\n").some((line) => /Example Domain/i.test(line) && !/web_fetch para ler/.test(line))) { checks.realWebAnswer = true; break; }
    await pause(1000);
  }
  capture("resultado");
  if (!checks.realWebAnswer) throw new Error("the page title did not come back");
} catch (error) {
  failure = error;
  capture(`FALHA: ${error.message}`);
} finally {
  await term.close();
}
const text = shots.join("\n\n");
if (/sk-[A-Za-z0-9]{10,}/.test(text)) throw new Error("key-like value on screen");
await writeFile(join(out, "real-web.txt"), text);
await writeFile(join(out, "real-web.json"), JSON.stringify({ journey: "J18-real-web", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message ?? null, checks, durationMs: Date.now() - started }, null, 2));
console.log(failure ? `FAILED ${failure.message}` : "passed");
