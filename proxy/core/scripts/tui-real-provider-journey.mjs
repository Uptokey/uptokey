import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J02 with the real stack (authorized by the Author on 01/10/2026): the artifact frontend in a real terminal, the
 * person's running daemon (127.0.0.1:21435), their vault and the real DeepSeek connection. A synthetic project
 * only; one short request. No key is printed; the evidence keeps the screen and the outcome.
 *   node scripts/tui-real-provider-journey.mjs
 */
import { mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash, randomBytes } from "node:crypto";
import { join, resolve } from "node:path";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(import.meta.dirname, "..");
const out = tuiEvidenceDirectory(core);
const artifact = join(core, "dist", "tui");
const project = join(out, "real-provider-project");
await mkdir(project, { recursive: true });
await writeFile(join(project, "README.md"), "# Synthetic terminal test\n\nMarker REAL_PROVIDER_5521.\n");

const shots = [];
const checks = {};
const started = Date.now();
const term = await openPty({
  file: join(artifact, "runtime", "bun.exe"),
  args: [join(artifact, "main.js")],
  cwd: project,
  env: { ...process.env, OTUI_TREE_SITTER_WORKER_PATH: join(artifact, "opentui-tree-sitter-worker.js"), UPTOKEY_TUI_CALLER_CWD: project, UPTOKEY_LANG: "en" },
});
const capture = (title) => shots.push(`--- ${title} ---\n${term.screen()}`);
let failure = null;
try {
  await term.until(() => /deepseek|ctrl\+p/i.test(term.screen()), "the interface did not open against the real daemon", 60000);
  capture("1. aberta no daemon real");
  if (!/deepseek/i.test(term.screen())) {
    await term.send("/models");
    await new Promise((done) => setTimeout(done, 500));
    await term.send("\r");
    await new Promise((done) => setTimeout(done, 800));
    await term.send("deepseek");
    await new Promise((done) => setTimeout(done, 800));
    await term.send("\r");
    await term.until(() => /deepseek/i.test(term.screen()), "deepseek could not be selected", 30000);
  }
  checks.destinationVisible = /deepseek/i.test(term.screen());
  capture("2. destino visível");
  const left = randomBytes(4).toString("hex");
  const right = randomBytes(4).toString("hex");
  const expected = left + right;
  const request = `Join these two strings without spaces and reply with the result only: ${left} and ${right}.`;
  await term.send(request);
  await new Promise((done) => setTimeout(done, 1500));
  await term.send("\r");
  // The request leaves the composer and the answer arrives on its own line (not the line of the request).
  const answered = () => term.screen().split("\n").some((line) => line.includes(expected) && !line.includes("Join these"));
  await term.until(answered, "no real answer arrived", 180000);
  checks.realAnswer = true;
  capture("3. resposta real");
} catch (error) {
  failure = error;
  capture(`FALHA: ${error.message}`);
} finally {
  await term.close();
}
const text = shots.join("\n\n");
if (/sk-[A-Za-z0-9]{10,}/.test(text)) throw new Error("a key-like value appeared on screen; evidence not written");
await writeFile(join(out, "real-provider.txt"), text);
await writeFile(join(out, "real-provider.json"), JSON.stringify({ journey: "real-provider", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message ?? null, checks, provider: "deepseek (real, person's vault)", daemon: "real 127.0.0.1:21435", frontend: "dist/tui (promoted)", artifactManifestSha256: createHash("sha256").update(readFileSync(join(artifact,"BUILD_INFO.json"))).digest("hex"), command:[process.execPath,...process.argv.slice(1)], exitCode:failure?1:0, requests: checks.destinationVisible ? 1 : 0, keysPrinted: false, durationMs: Date.now() - started }, null, 2));
console.log(failure ? `FAILED ${failure.message}` : "passed");
if(failure) process.exitCode=1;
