/**
 * Compares vendor/opencode-tui with packages/tui/src of the pinned upstream clone and writes the exact list of
 * modified, added and removed files to UPSTREAM-DIFF.json (sha256 of both sides, changed line counts).
 *   node scripts/upstream-diff.mjs <path-to-opencode-clone>
 * The clone must be at the revision recorded in UPSTREAM.json; otherwise the script refuses to compare.
 */
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const root = path.resolve(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "..");
const clone = path.resolve(process.argv[2] ?? "");
const upstream = JSON.parse(readFileSync(path.join(root, "UPSTREAM.json"), "utf8"));
const head = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (head !== upstream.revision) throw new Error(`clone is at ${head}, UPSTREAM.json pins ${upstream.revision}`);

function list(dir, base = dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name);
    return entry.isDirectory() ? list(full, base) : [path.relative(base, full).replaceAll("\\", "/")];
  });
}
// Line endings are normalized (the clone may be checked out with CRLF): only content changes count.
const text = (file) => readFileSync(file, "utf8").replace(/\r\n/g, "\n");
const sha = (file) => createHash("sha256").update(text(file)).digest("hex");
const lines = (file) => text(file).split("\n");

const ours = path.join(root, "vendor/opencode-tui");
const theirs = path.join(clone, "packages/tui/src");
const mine = new Set(list(ours));
const original = new Set(list(theirs));
const modified = [];
for (const file of [...mine].filter((name) => original.has(name)).sort()) {
  const a = sha(path.join(theirs, file));
  const b = sha(path.join(ours, file));
  if (a === b) continue;
  const before = new Set(lines(path.join(theirs, file)));
  const after = lines(path.join(ours, file));
  const changed = after.filter((line) => !before.has(line)).length;
  modified.push({ file, upstreamSha256: a, localSha256: b, linesNotInUpstream: changed });
}
const report = {
  revision: upstream.revision,
  comparedAt: new Date().toISOString(),
  totals: { vendoredFiles: mine.size, upstreamFiles: original.size, modified: modified.length, added: [...mine].filter((name) => !original.has(name)).length, removed: [...original].filter((name) => !mine.has(name)).length },
  modified,
  added: [...mine].filter((name) => !original.has(name)).sort(),
  removed: [...original].filter((name) => !mine.has(name)).sort(),
};
writeFileSync(path.join(root, "UPSTREAM-DIFF.json"), `${JSON.stringify(report, null, 1)}\n`);
console.log(JSON.stringify(report.totals));
