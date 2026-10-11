import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J19 — live voice through the person's running core: /voice-setup selects the saved OpenAI connection and a
 * realtime model, then /voice opens a live session (OpenAI Realtime) and is stopped. Runs `uptokey tui --next`.
 *   node scripts/tui-real-voice-journey.mjs <project-dir> <model>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [projectArg, model] = process.argv.slice(2);
const project = resolve(projectArg);
await mkdir(project, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVAL = /Aprovação necessária|Approval required/;
const term = await openPty({ file: process.execPath, args: [join(core, "src", "cli.ts"), "tui", "--next", "--external", "--lang", "en"], cwd: project, env: { ...process.env, NODE_NO_WARNINGS: "1" } });
const checks = {};
let failure = null;
const command = async (text) => {
  await term.send(text);
  await pause(500);
  await term.send("\r");
  await pause(800);
  if (/^\s*┃\s+\//m.test(term.screen())) await term.send("\r");
};
try {
  await term.until(() => /ctrl\+p/i.test(term.screen()), "the frontend did not open", 90000);
  await command(`/voice-setup ${model}`);
  await term.until(() => /Live voice set up|Live voice is not set up|voice_[a-z_]+/.test(term.screen()), "the voice setup did not answer", 60000);
  checks.setup = (/Live voice set up[^\n]*/.exec(term.screen()) ?? /voice_[a-z_]+/.exec(term.screen()))?.[0]?.trim() ?? null;
  if (!/Live voice set up/.test(term.screen())) throw new Error(`setup failed: ${checks.setup}`);
  await command("/voice");
  await term.until(() => APPROVAL.test(term.screen()) && /Approve|Aprovar/.test(term.screen()), "the live session was not offered for approval", 60000);
  checks.approvalShown = true;
  await pause(500);
  await term.send("\r");
  await term.until(() => /✗[^\n]*(voz|voice)/i.test(term.screen()) || /(conversa por voz|live voice)[^\n]*(recibo|receipt) [0-9a-f]{8}/i.test(term.screen()), "the live session did not start", 90000);
  const failedLine = /✗[^\n]*(voz|voice)[^\n]*/i.exec(term.screen())?.[0];
  if (failedLine) throw new Error(`the live session failed: ${failedLine.trim()}`);
  checks.session = (/[^\n]*(recibo|receipt) [0-9a-f]{8}[^\n]*/i.exec(term.screen())?.[0] ?? "").trim();
  await pause(3000);
  checks.screenAfter = term.screen().split("\n").filter((line) => line.trim()).slice(-8).join("\n");
} catch (error) { failure = error; checks.screenAfter = term.screen().split("\n").filter((line) => line.trim()).slice(-8).join("\n"); }
await term.send("\x1b");
await pause(1000);
const screen = term.full();
await term.close();
const out = tuiEvidenceDirectory(core);
await writeFile(join(out, "real-voice.json"), JSON.stringify({ journey: "real-voice", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message?.split("\n")[0] ?? null, checks: { ...checks, model } }, null, 2));
await writeFile(join(out, "real-voice.txt"), screen);
console.log(failure ? `failed ${failure.message.split("\n")[0]}` : "passed", JSON.stringify(checks, null, 1));
process.exit(failure ? 1 : 0);
