import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";

const consumer = new URL("../src/tui/frontend/vendor/opencode-tui/util/revert-diff.ts", import.meta.url).href;

// Keep a vulnerable parser regression outside the test runner: a synchronous loop cannot be caught or aborted there.
function summarize(patch: string) {
  const result = spawnSync(process.execPath, [
    "--experimental-strip-types", "--max-old-space-size=64", "--input-type=module", "-e",
    `import { readFileSync } from "node:fs";
     const { getRevertDiffFiles } = await import(${JSON.stringify(consumer)});
     process.stdout.write(JSON.stringify(getRevertDiffFiles(JSON.parse(readFileSync(0, "utf8")))));`,
  ], {
    input: JSON.stringify(patch), encoding: "utf8", timeout: 3_000,
    killSignal: "SIGKILL", maxBuffer: 64 * 1024, windowsHide: true,
  });
  assert.equal(result.error, undefined, `parser did not terminate within its process bound: ${String(result.error ?? "")}`);
  assert.equal(result.status, 0, `parser process failed: ${result.signal ?? result.status}`);
  return JSON.parse(result.stdout);
}

test("revert summary preserves filenames and insertion/deletion counts for ordinary patches", () => {
  const patch = "--- a/src/hello.ts\n+++ b/src/hello.ts\n@@ -1,2 +1,3 @@\n old\n-before\n+after\n+extra\n";
  assert.deepEqual(summarize(patch), [{ filename: "src/hello.ts", additions: 2, deletions: 1 }]);
});

test("empty and invalid patches remain harmless empty summaries", () => {
  assert.deepEqual(summarize(""), []);
  assert.deepEqual(summarize("@@ -1 +1 @@\n?invalid\n"), []);
});

for (const [name, separator] of [["CR", "\r"], ["U+2028", "\u2028"], ["U+2029", "\u2029"]]) {
  test(`revert parser terminates and preserves a filename containing ${name}`, () => {
    const filename = `file${separator}name.txt`;
    const patch = `--- a/${filename}\n+++ b/${filename}\n@@ -1 +1 @@\n-before\n+after\n`;
    assert.deepEqual(summarize(patch), [{ filename, additions: 1, deletions: 1 }]);
  });
}
