import { tuiEvidenceDirectory } from "./lib/tui-evidence.mjs";
/**
 * Autonomous coding through the person's running core and a real model: a fresh project whose test suite fails is
 * opened with `uptokey tui --next --autonomy`; one request asks the coder to make the suite pass. Success is decided
 * here, outside the TUI: `node --test` must pass on the project and the test files must be byte-identical.
 *   node scripts/tui-real-autonomy-journey.mjs <scratch-dir> [timeoutMinutes]
 */
import { execFileSync } from "node:child_process";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { openPty } from "./lib/pty-session.mjs";

const core = resolve(fileURLToPath(new URL("..", import.meta.url)));
const [scratchArg, minutesArg] = process.argv.slice(2);
const project = resolve(scratchArg, `autonomy-${Date.now()}`);
const timeoutMs = Number(minutesArg ?? 12) * 60_000;
const pause = (ms) => new Promise((r) => setTimeout(r, ms));
const sha = (text) => createHash("sha256").update(text).digest("hex");

const FILES = {
  "package.json": JSON.stringify({ name: "cart-fixture", type: "module", scripts: { test: "node --test" } }, null, 2) + "\n",
  "src/cart.js": [
    "import { roundMoney } from './money.js';",
    "",
    "/** Sum of price × quantity of every line, then the percentage discount, rounded to cents. */",
    "export function total(lines, discountPercent = 0) {",
    "  let sum = 0;",
    "  for (const line of lines) sum += line.price;",
    "  const discounted = sum - discountPercent;",
    "  return roundMoney(discounted);",
    "}",
    "",
    "/** Lines grouped by sku with quantities added. Order of first appearance is kept. */",
    "export function merge(lines) {",
    "  const out = [];",
    "  for (const line of lines) {",
    "    const found = out.find((item) => item.sku === line.sku);",
    "    if (found) found.quantity = line.quantity;",
    "    else out.push(line);",
    "  }",
    "  return out;",
    "}",
    "",
  ].join("\n"),
  "src/money.js": "export function roundMoney(value) {\n  return Math.floor(value * 100) / 100;\n}\n",
  "test/cart.test.js": [
    "import test from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { total, merge } from '../src/cart.js';",
    "",
    "test('total multiplies by quantity', () => {",
    "  assert.equal(total([{ sku: 'a', price: 2.5, quantity: 4 }, { sku: 'b', price: 1, quantity: 1 }]), 11);",
    "});",
    "test('total applies a percentage discount and rounds half up to cents', () => {",
    "  assert.equal(total([{ sku: 'a', price: 10, quantity: 1 }], 15), 8.5);",
    "  assert.equal(total([{ sku: 'a', price: 0.335, quantity: 1 }]), 0.34);",
    "});",
    "test('merge adds quantities without mutating the input', () => {",
    "  const input = [{ sku: 'a', price: 1, quantity: 1 }, { sku: 'b', price: 2, quantity: 1 }, { sku: 'a', price: 1, quantity: 2 }];",
    "  const before = JSON.stringify(input);",
    "  assert.deepEqual(merge(input), [{ sku: 'a', price: 1, quantity: 3 }, { sku: 'b', price: 2, quantity: 1 }]);",
    "  assert.equal(JSON.stringify(input), before);",
    "});",
    "",
  ].join("\n"),
};

const testsPass = () => { try { execFileSync(process.execPath, ["--test"], { cwd: project, stdio: "pipe", timeout: 60_000 }); return true; } catch { return false; } };

await rm(project, { recursive: true, force: true });
for (const [path, text] of Object.entries(FILES)) { await mkdir(join(project, path, ".."), { recursive: true }); await writeFile(join(project, path), text); }
if (testsPass()) throw new Error("fixture must start failing");
const testHash = sha(FILES["test/cart.test.js"]);
const started = Date.now();
const term = await openPty({ file: process.execPath, args: [join(core, "src", "cli.ts"), "tui", "--next", "--external", "--autonomy", "--lang", "en"], cwd: project, env: { ...process.env, NODE_NO_WARNINGS: "1" }, cols: 140, rows: 44 });
const checks = { project };
let failure = null;
try {
  await term.until(() => /ctrl\+p/i.test(term.screen()), "the frontend did not open", 90000);
  await term.until(() => /autonomous/i.test(term.screen()), "the prompt did not show the autonomous agent", 30000);
  checks.agentShown = true;
  const request = "The test suite of this project fails. Fix the code in src/ so that `node --test` passes, without changing the tests. Run the tests to confirm.";
  await term.send(request);
  await pause(600);
  await term.send("\r");
  let passedAt = 0;
  for (;;) {
    await pause(5000);
    if (Date.now() - started > timeoutMs) throw new Error("timeout before the suite passed and the turn ended");
    if (/Approve\s+Decline/.test(term.screen())) throw new Error("an approval was requested under autonomy");
    if (!passedAt && testsPass()) passedAt = Date.now();
    const busy = /esc\s+(interrupt|to interrupt)|interrupt/i.test(term.screen());
    if (passedAt && !busy) break;
    if (/✗|Send failed|failed:/i.test(term.screen()) && !busy && !passedAt) throw new Error("the turn ended with an error");
  }
  checks.secondsToGreen = Math.round((passedAt - started) / 1000);
  checks.secondsTotal = Math.round((Date.now() - started) / 1000);
  checks.testsPass = testsPass();
  checks.testsUntouched = sha(await readFile(join(project, "test/cart.test.js"), "utf8")) === testHash;
  checks.cart = await readFile(join(project, "src/cart.js"), "utf8");
  checks.money = await readFile(join(project, "src/money.js"), "utf8");
  if (!checks.testsPass || !checks.testsUntouched) throw new Error("suite not green or tests changed");
} catch (error) { failure = error; }
checks.screenAfter = term.screen().split("\n").filter((line) => line.trim()).slice(-14).join("\n");
await term.send("\x1b");
await pause(800);
const transcript = term.full();
await term.close();
const out = tuiEvidenceDirectory(core);
await writeFile(join(out, "real-autonomy.json"), JSON.stringify({ journey: "real-autonomy", date: new Date().toISOString(), result: failure ? "failed" : "passed", error: failure?.message?.split("\n")[0] ?? null, checks }, null, 2));
await writeFile(join(out, "real-autonomy.txt"), transcript);
console.log(failure ? `failed ${failure.message.split("\n")[0]}` : "passed", JSON.stringify({ ...checks, cart: undefined, money: undefined, screenAfter: undefined }));
process.exit(failure ? 1 : 0);
