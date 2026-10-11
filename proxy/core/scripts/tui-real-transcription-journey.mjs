import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J19 — real speech-to-text through the person's running core: /transcription selects the saved connection whose
 * endpoint matches (OVH AI Endpoints, whisper-large-v3), /transcribe sends a spoken WAV of the project after the
 * approval, and the transcript lands in the composer. Runs `uptokey tui --next` from the sources in a ConPTY.
 *   node scripts/tui-real-transcription-journey.mjs <project-dir-with-fala.wav> <model> <endpoint>
 */
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [projectArg, model, endpoint] = process.argv.slice(2);
const project = resolve(projectArg);
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
  if (term.screen().includes(text.split(" ")[0]) && /^\s*┃\s+\//m.test(term.screen())) await term.send("\r");
};
try {
  await term.until(() => /ctrl\+p/i.test(term.screen()), "the frontend did not open", 90000);
  await command(`/transcription ${model} ${endpoint}`);
  await term.until(() => /Transcription set up|Transcription is not set up|transcription_connection|Transcription:/.test(term.screen()), "the transcription setup did not answer", 60000);
  checks.setup = (/Transcription set up[^\n]*/.exec(term.screen()) ?? /transcription_[a-z_]+/.exec(term.screen()))?.[0] ?? null;
  if (!/Transcription set up/.test(term.screen())) throw new Error(`setup failed: ${checks.setup}`);
  await command("/transcribe fala.wav");
  await term.until(() => APPROVAL.test(term.screen()), "the transcription was not offered for approval", 60000);
  checks.approvalShown = true;
  await term.send("\r");
  await term.until(() => /pineapple/i.test(term.screen()), "the transcript did not reach the composer", 120000);
  checks.transcript = (/[^\n┃]*pineapple[^\n┃]*/i.exec(term.screen())?.[0] ?? "").trim();
} catch (error) { failure = error; }
const screen = term.full();
await term.close();
const out = tuiEvidenceDirectory(core);
await writeFile(join(out, "real-transcription.json"), JSON.stringify({ journey: "real-transcription", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message?.split("\n")[0] ?? null, checks: { ...checks, model, endpointOrigin: new URL(endpoint).origin } }, null, 2));
await writeFile(join(out, "real-transcription.txt"), screen);
console.log(failure ? `failed ${failure.message.split("\n")[0]}` : "passed", JSON.stringify(checks));
process.exit(failure ? 1 : 0);
