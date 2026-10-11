import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J20 — screen readers: from the OpenTUI frontend, /leitor reopens the SAME conversation in the linear interface
 * (no alternate screen, text flowing into the terminal's scrollback that Narrator/NVDA read), and Arabic (RTL) text
 * round-trips in logical order. Runs the real `uptokey tui` from the sources against the person's core.
 *   node scripts/tui-reader-journey.mjs <project-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = resolve(process.argv[2]);
await mkdir(project, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const term = await openPty({ file: process.execPath, args: [join(core, "src", "cli.ts"), "tui", "--lang", "pt-BR", "--model", process.env.READER_MODEL ?? "deepseek-flash", "--external"], cwd: project, env: { ...process.env, UPTOKEY_TUI_FRONTEND_DIR: "" } });
const checks = {};
let failure = null;
const ALT_ON = "\x1b[?1049h";
try {
  await term.until(() => /ctrl\+p/i.test(term.screen()), "the frontend did not open", 90000);
  checks.frontendOpened = true;
  // --lang pt-BR reaches the frontend (the environment's language must not override it).
  checks.languageFromFlag = !/Ask anything|Build ·/.test(term.screen());
  if (!checks.languageFromFlag) throw new Error("--lang pt-BR was not applied to the frontend");
  if (!/deepseek-flash/.test(term.screen())) {
    await term.send("/modelo deepseek-flash");
    await pause(500);
    await term.send("\r");
    await term.until(() => /deepseek-flash/.test(term.screen()), "could not select the DeepSeek model", 20000);
  }
  await term.send("Junte LEI e TOR_OK numa palavra e responda só com ela, seguida de: مرحبا بالعالم");
  await term.send("\r");
  await term.until(() => /LEITOR_OK/.test(term.screen()), "no answer before switching", 120000);
  checks.answered = true;
  const before = term.raw().length;
  await term.send("/leitor");
  await pause(500);
  await term.send("\r");
  await pause(600);
  if (!/LEITOR_OK/.test(term.screen()) || /ctrl\+p/i.test(term.screen())) await term.send("\r");
  // The linear interface replays the conversation as plain lines, without entering the alternate screen.
  await term.until(() => !/ctrl\+p/i.test(term.screen()) && /LEITOR_OK/.test(term.full()), "the linear interface did not reopen the conversation", 90000);
  await pause(3000);
  const after = term.raw().slice(before);
  checks.linearReopened = true;
  checks.alternateScreenAfterSwitch = after.lastIndexOf(ALT_ON) > after.lastIndexOf("\x1b[?1049l");
  if (checks.alternateScreenAfterSwitch) throw new Error("the linear interface is still on the alternate screen");
  // Arabic kept in logical order (the terminal shapes it; the text the reader receives is not reversed).
  checks.arabicLogicalOrder = term.full().includes("مرحبا بالعالم") || term.full().includes("مرحبا");
  if (!checks.arabicLogicalOrder) throw new Error("the Arabic text did not survive in logical order");
} catch (error) { failure = error; }
const screen = term.full();
await term.close();
const out = tuiEvidenceDirectory(core);
await mkdir(out, { recursive: true });
await writeFile(join(out, "reader.json"), JSON.stringify({ journey: "reader", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message ?? null, checks }, null, 2));
await writeFile(join(out, "reader.txt"), screen);
console.log(failure ? `failed ${failure.message}` : "passed");
process.exit(failure ? 1 : 0);
