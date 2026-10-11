import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * J18 — real web search through the person's running core: the selected model asks for web_search, the person
 * approves, the core searches with the engine available (the person's Brave key when saved, else the local SearXNG)
 * and the answer cites a returned source. Runs `uptokey tui --next` from the sources in a ConPTY.
 *   node scripts/tui-real-search-journey.mjs <project-dir>
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const project = resolve(process.argv[2]);
await mkdir(project, { recursive: true });
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const APPROVAL = /Aprovação necessária|Approval required/;
const term = await openPty({ file: process.execPath, args: [join(core, "src", "cli.ts"), "tui", "--next", "--external"], cwd: project, env: { ...process.env } });
const checks = {};
let failure = null;
try {
  await term.until(() => /ctrl\+p/i.test(term.screen()), "the frontend did not open", 90000);
  if (process.env.SEARCH_MODEL) {
    await term.send(`/models ${process.env.SEARCH_MODEL}`);
    await pause(500);
    await term.send("\r");
    await term.until(() => term.screen().includes(`Build · ${process.env.SEARCH_MODEL}`), "the model was not selected", 20000);
  }
  checks.model = (/Build · ([^\n]+)/.exec(term.screen())?.[1] ?? "").trim();
  await term.send("Use the web_search tool to search for: Brave Search API pricing. Then answer with one line that starts with FONTE: followed by the first URL you received.");
  await term.send("\r");
  await term.until(() => APPROVAL.test(term.screen()), "the search was not offered for approval", 120000);
  checks.approvalShown = /Pesquisar na web|Search the web/i.test(term.screen());
  checks.engine = /\((Brave Search|SearXNG)\)/.exec(term.screen())?.[1] ?? null;
  if (process.env.EXPECT_ENGINE && checks.engine !== process.env.EXPECT_ENGINE) throw new Error(`the search used ${checks.engine}, not ${process.env.EXPECT_ENGINE}`);
  await term.send("\r");
  await term.until(() => /FONTE:\s*https?:\/\//.test(term.full()), "the answer did not cite a returned source", 180000);
  checks.citedSource = /FONTE:\s*(https?:\/\/\S+)/.exec(term.full())?.[1] ?? null;
} catch (error) { failure = error; }
const screen = term.full();
await term.close();
const out = tuiEvidenceDirectory(core);
await writeFile(join(out, "real-search.json"), JSON.stringify({ journey: "real-search", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message?.split("\n")[0] ?? null, checks }, null, 2));
await writeFile(join(out, "real-search.txt"), screen);
console.log(failure ? `failed ${failure.message.split("\n")[0]}` : "passed", JSON.stringify(checks));
process.exit(failure ? 1 : 0);
