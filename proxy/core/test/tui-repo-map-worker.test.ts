import assert from "node:assert/strict";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildRepoMap } from "../src/tui/repo-map.ts";

test("repository worker preserves ranked symbols for non-Git projects", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-worker-repo-"));
  await writeFile(join(root, "shared.ts"), "export function shared() { return 1; }\n");
  await writeFile(join(root, "consumer.ts"), "export function consumer() { return shared(); }\n");
  const entries = await buildRepoMap(root, { maxFiles: 500 });
  assert.deepEqual(new Set(entries.map(entry => entry.path)), new Set(["shared.ts", "consumer.ts"]));
  assert.ok(entries.find(entry => entry.path === "shared.ts")?.symbols.some(symbol => symbol.name === "shared" && symbol.type === "function"));
  assert.ok(entries.find(entry => entry.path === "consumer.ts")?.symbols.some(symbol => symbol.name === "consumer"));
});

test("an aborted root never starts repository analysis", async () => {
  const abort = new AbortController();
  abort.abort();
  await assert.rejects(buildRepoMap("/unreadable-root-must-not-be-opened", { signal: abort.signal }), { name: "AbortError" });
});

test("a retired root cancels its worker while the terminal event loop keeps responding", async () => {
  const root = await mkdtemp(join(tmpdir(), "uptokey-worker-retire-"));
  for (let file = 0; file < 40; file++) {
    await writeFile(join(root, `file-${file}.ts`), Array.from({ length: 150 }, (_, id) => `export function symbol${file}_${id}() { return ${id}; }`).join("\n"));
  }
  const abort = new AbortController();
  const pending = buildRepoMap(root, { maxFiles: 500, signal: abort.signal });
  // Timer runs while parsing is pending: cancellation cannot wait for an index rebuild on the UI thread.
  setTimeout(() => abort.abort(), 20);
  await assert.rejects(pending, { name: "AbortError" });
});
