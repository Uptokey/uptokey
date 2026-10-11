/** Diagnostic: which agent the prompt shows when the TUI opens with --autonomy, and after /autonomy toggles. */
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const term = await openPty({ file: process.execPath, args: [join(core, "src", "cli.ts"), "tui", "--next", "--autonomy", "--lang", "en"], cwd: process.argv[2] ?? process.cwd(), env: { ...process.env, NODE_NO_WARNINGS: "1" }, cols: 140, rows: 40 });
const footer = () => term.screen().split("\n").filter((line) => /Build|Autonomous|Plan/.test(line)).map((line) => line.trim()).join(" | ");
await term.until(() => /ctrl\+p/i.test(term.screen()), "no frontend", 90000);
await pause(3000);
console.log("open:", footer());
for (const step of ["/autonomy", "/autonomy"]) {
  await term.send(step); await pause(500); await term.send("\r"); await pause(800);
  // Enter on the completion list only fills the command: a second Enter runs it.
  if (/^\s*┃\s+\//m.test(term.screen())) await term.send("\r");
  await pause(2500);
  console.log(`${step}:`, footer());
}
await term.close();
