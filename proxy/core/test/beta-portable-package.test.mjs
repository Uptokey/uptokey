import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { betaPackageFixture, stagedEntries } from "./helpers/beta-package-fixture.mjs";
import { stagePackage } from "../scripts/npm-pack-beta.mjs";
import { verifyPackageEntries } from "../scripts/verify-beta-artifact.mjs";
import { frontendPackageFiles } from "../scripts/beta-runtime-contract.mjs";
import { BUN_PACKAGE_TARGETS, nativeTarget, NATIVE_TARGETS, portableDependencies, resolvePortableRuntime } from "../src/tui/portable-runtime.mjs";

function portableFixture(t) {
  const f = betaPackageFixture(t);
  Object.assign(f.info, { platform: "portable", runtime: "npm:bun", nativePackage: "@opentui/core@0.4.5" });
  f.info.files = f.info.files.filter(file => !file.path.startsWith("node_modules/") && !/^runtime\/bun/.test(file.path));
  f.writeFrontend("main.js", 'import "@opentui/core-win32-x64"; import "@opentui/core-linux-x64"; import "./chunk.js";\n');
  f.writeInfo();
  return f;
}
test("one npm artifact declares every native target, with pinned runtime and no host binary", t => {
  const f = portableFixture(t), result = stagePackage(f.source, f.stage);
  assert.deepEqual(result.manifest.os, ["win32", "darwin", "linux"]);
  assert.deepEqual(result.manifest.cpu, ["x64", "arm64"]);
  assert.equal(result.manifest.dependencies.bun, undefined);
  assert.equal(Object.keys(result.manifest.optionalDependencies).length, 16);
  assert.equal(result.manifest.dependencies["better-sqlite3"], "13.0.3");
  for (const name of ["@langchain/core", "@langchain/langgraph", "@langchain/langgraph-checkpoint-sqlite", "langsmith"]) {
    assert.equal(result.manifest.dependencies[name], undefined);
  }
  assert.equal(frontendPackageFiles(f.info).some(path => /runtime\/bun|node_modules/.test(path)), false);
  assert.equal(verifyPackageEntries(stagedEntries(f.stage)).forbiddenPaths, 0);
});
test("missing target, mismatched runtime and accidental host restriction fail verification", t => {
  const f = portableFixture(t); stagePackage(f.source, f.stage);
  for (const mutate of [p => delete p.optionalDependencies["@opentui/core-darwin-arm64"], p => p.dependencies.bun = "latest", p => p.os = ["win32"]]) {
    const entries = stagedEntries(f.stage), pkg = JSON.parse(entries.get("package/package.json"));
    mutate(pkg); entries.set("package/package.json", Buffer.from(JSON.stringify(pkg)));
    assert.throws(() => verifyPackageEntries(entries), /beta_portable_dependencies_invalid/);
  }
});
test("portable inventory rejects embedded host runtimes and libraries", t => {
  const f = portableFixture(t);
  for (const path of ["runtime/bun.exe", "runtime/bun", "node_modules/@opentui/core-win32-x64/lib.dll"]) {
    const info = structuredClone(f.info); info.files.push({ ...info.files[0], path });
    assert.throws(() => frontendPackageFiles(info), /beta_frontend_file_forbidden/);
  }
  assert.throws(() => portableDependencies({ ...f.info, bun: "^1.4.0" }), /portable_runtime_manifest_invalid/);
});
test("platform selection includes both architectures and Linux libc variants", () => {
  for (const target of NATIVE_TARGETS) {
    const [os, cpu, musl] = target.split("-");
    assert.equal(nativeTarget(os, cpu, os === "linux" && !musl ? "2.35" : ""), target);
  }
  assert.throws(() => nativeTarget("linux", "ia32", "2.35"), /portable_platform_unsupported/);
});
test("runtime resolves local dependencies, checks versions and rejects binary path escape", t => {
  const f = portableFixture(t), deps = join(f.source, "node_modules");
  const target = `${process.platform}-${process.arch}`;
  const bunName = BUN_PACKAGE_TARGETS[target], bunDir = join(deps, bunName), nativeDir = join(deps, `@opentui/core-${target}`);
  mkdirSync(join(bunDir, "bin"), { recursive: true }); mkdirSync(nativeDir, { recursive: true });
  const runtimeName = target.startsWith("win32-") ? "bun.exe" : "bun";
  const pkg = { name: bunName, version: f.info.bun };
  const writeBun = () => writeFileSync(join(bunDir, "package.json"), JSON.stringify(pkg));
  writeBun(); writeFileSync(join(bunDir, `bin/${runtimeName}`), "fixture");
  writeFileSync(join(nativeDir, "package.json"), JSON.stringify({ name: `@opentui/core-${target}`, version: "0.4.5" }));
  assert.equal(resolvePortableRuntime(f.frontendDir, target).runtime, join(bunDir, `bin/${runtimeName}`));
  pkg.version = "9.0.0"; writeBun(); assert.throws(() => resolvePortableRuntime(f.frontendDir, target), /portable_bun_version_mismatch/);
  pkg.version = f.info.bun; writeBun(); rmSync(join(bunDir, `bin/${runtimeName}`)); assert.throws(() => resolvePortableRuntime(f.frontendDir, target), /portable_bun_binary_missing/);
});

test("public first use is one npm command without global install or PATH repair", () => {
  const internalFirstRun = new URL("../../../docs/beta/FIRST-RUN-BETA.md", import.meta.url);
  const documents = [new URL("../README.md", import.meta.url),
    existsSync(internalFirstRun) ? internalFirstRun : new URL("../FIRST-RUN-BETA.md", import.meta.url)];
  // These editorial sources belong to the private workspace, not the public
  // projection. Review them when present; never export them to satisfy a test.
  for (const relative of ["../../../docs/beta/FIRST-RUN-BETA-NPM.md", "../../../docs/product/UPTOKEY-PRODUCT-OVERVIEW.md"]) {
    const url = new URL(relative, import.meta.url);
    if (existsSync(url)) documents.push(url);
  }
  for (const url of documents) {
    const text = readFileSync(url, "utf8");
    assert.match(text, /npx --yes uptokey@latest/);
    assert.doesNotMatch(text, /npm install -g uptokey|npm prefix|\.zshrc|sudo|uptokey@beta/);
    assert.doesNotMatch(text, /(?<!@latest )\buptokey (?:doctor|version|--version|help|mcp|--lang|--screen-reader)\b/);
  }
});
