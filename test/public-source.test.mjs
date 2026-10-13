import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = resolve(root, "proxy/core/dist/cli.js");
const projectedPackage = JSON.parse(readFileSync(resolve(root, "package.json"), "utf8"));
const corePackage = JSON.parse(readFileSync(resolve(root, "proxy/core/package.json"), "utf8"));

function run(...args) {
  const result = spawnSync(process.execPath, [cli, ...args], { cwd: root, encoding: "utf8", timeout: 30_000, env: { ...process.env, NO_COLOR: "1" } });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

test("compiled public CLI reports the projected release version", () => {
  assert.equal(projectedPackage.version, corePackage.version);
  assert.equal(run("version").trim(), `v${projectedPackage.version}`);
});

test("compiled public CLI exposes the canonical AGPL license", () => {
  const expected = readFileSync(resolve(root, "LICENSE"), "utf8").replaceAll("\r\n", "\n").trim();
  assert.equal(run("license").replaceAll("\r\n", "\n").trim(), expected);
});

test("public entry documentation uses the current npm command", () => {
  const readme = readFileSync(resolve(root, "README.md"), "utf8");
  assert.match(readme, /npx --yes uptokey@latest/);
  assert.match(readme, /Windows, macOS and Linux/);
  assert.doesNotMatch(readme, /@uptokey\/cli|Apache-2\.0/);
});

test("portable TUI build is tied to the public source version and upstream revision", () => {
  const info = JSON.parse(readFileSync(resolve(root, "proxy/core/dist/tui/BUILD_INFO.json"), "utf8"));
  const upstream = JSON.parse(readFileSync(resolve(root, "proxy/core/src/tui/frontend/UPSTREAM.json"), "utf8"));
  assert.equal(projectedPackage.version, corePackage.version);
  assert.equal(info.version, projectedPackage.version);
  assert.equal(info.upstream, upstream.revision);
  assert.equal(info.platform, "portable");
});
