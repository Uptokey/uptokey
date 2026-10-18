import test from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { gunzipSync } from "node:zlib";
import { betaPackageFixture, stagedEntries } from "./helpers/beta-package-fixture.mjs";
import { extractRuntimeAssets, extractRuntimeImports, extractRuntimeSpecifiers, frontendPackageFiles } from "../scripts/beta-runtime-contract.mjs";
import { packMain, stagePackage, writeDeterministicTarball } from "../scripts/npm-pack-beta.mjs";
import { packageFiles, verifyArtifact, verifyPackageEntries, verifyStagedPackage } from "../scripts/verify-beta-artifact.mjs";

function changeManifest(files, change) {
  const manifest = JSON.parse(files.get("package/package.json")); change(manifest);
  files.set("package/package.json", Buffer.from(JSON.stringify(manifest)));
}
function changeFrontendInfo(files, change) {
  const info = JSON.parse(files.get("package/dist/tui/BUILD_INFO.json")); change(info);
  files.set("package/dist/tui/BUILD_INFO.json", Buffer.from(JSON.stringify(info)));
}

test("import inventory includes all entry/chunk imports and excludes quoted prose, comments and regex", () => {
  const code = 'import "side-effect"; export {x} from "@scope/pkg/subpath"; import("dynamic"); require2("commonjs"); __require3("numbered"); createRequire(import.meta.url)("created"); import `static-template`; const t = `${import("nested-template")}`; const r=()=>/require("fake-regex")/; const p="import(\\\"fake-prose\\\")"; /* import("fake-comment") */ import "node:fs"; require("fs/promises"); import "bun:ffi";';
  assert.deepEqual(extractRuntimeSpecifiers(code), ["@scope/pkg", "commonjs", "created", "dynamic", "nested-template", "numbered", "side-effect", "static-template"]);
  assert.ok(extractRuntimeImports('import "./chunk.js";').includes("./chunk.js"));
  assert.deepEqual(extractRuntimeAssets('const a="./parser.wasm", b="./syntax.scm", c="./audio-a1.ts", d="./source.ts";'), ["./audio-a1.ts", "./parser.wasm", "./syntax.scm"]);
  assert.deepEqual(extractRuntimeAssets('new Worker(new URL("./repo-map-worker.js", import.meta.url));'), ["./repo-map-worker.js"]);
});

test("beta stages the exact production manifest, both runtime entries and locked frontend dependencies", t => {
  const fixture = betaPackageFixture(t);
  fixture.writeFrontend(`node_modules/@opentui/core-${fixture.info.platform}/index.d.ts`, "export declare const renderer: unknown;\n");
  writeFileSync(join(fixture.frontendDir, "fixture-entry.js"), "excluded fixture");
  writeFileSync(join(fixture.frontendDir, "unlisted.js"), "excluded unlisted file");
  const result = stagePackage(fixture.source, fixture.stage);
  assert.equal(result.files, packageFiles("beta", fixture.info).length);
  assert.deepEqual(result.manifest.uptokeyTui, { manifest: "dist/tui/BUILD_INFO.json", entry: "dist/tui/main.js", accessibleEntry: "dist/tui/linear-entry.js", accessibleRuntime: "node", platform: fixture.info.platform });
  for (const name of ["web-tree-sitter", "pngjs", "@napi-rs/keyring"]) assert.equal(result.manifest.dependencies[name], fixture.lock.packages[`node_modules/${name}`].version);
  assert.equal(Object.keys(result.manifest.dependencies).some(name => name.startsWith("@opentui/core-")), false);
  assert.equal(stagedEntries(fixture.stage).has("package/dist/tui/fixture-entry.js"), false);
  assert.equal(stagedEntries(fixture.stage).has("package/dist/tui/unlisted.js"), false);
  assert.equal(verifyStagedPackage(fixture.stage).files, result.files);
});

test("beta cannot ship an absent frontend or a missing accessible entry", t => {
  const fixture = betaPackageFixture(t);
  rmSync(join(fixture.frontendDir, "BUILD_INFO.json"));
  assert.throws(() => stagePackage(fixture.source, fixture.stage), /beta_frontend_manifest_missing/);
  fixture.info.files = fixture.info.files.filter(file => file.path !== "linear-entry.js"); fixture.writeInfo();
  assert.throws(() => stagePackage(fixture.source, fixture.stage), /beta_frontend_required_missing:linear-entry.js/);
});

test("worker base parser is mandatory even when all language grammar assets remain", t => {
  const fixture = betaPackageFixture(t);
  const info = structuredClone(fixture.info); info.files = info.files.filter(file => file.path !== info.parserRuntime);
  assert.throws(() => frontendPackageFiles(info), /beta_frontend_required_missing:tree-sitter-abc123.wasm/);
  assert.throws(() => frontendPackageFiles({ ...fixture.info, parserRuntime: undefined }), /beta_frontend_manifest_invalid/);
});

test("new releases require the repository worker and referenced workers cannot disappear from legacy manifests", t => {
  const fixture = betaPackageFixture(t);
  const info = structuredClone(fixture.info); info.version = "0.1.0-beta.18";
  info.files = info.files.filter(file => file.path !== "repo-map-worker.js");
  assert.throws(() => frontendPackageFiles(info), /beta_frontend_required_missing:repo-map-worker\.js/);
  stagePackage(fixture.source, fixture.stage);
  let files = stagedEntries(fixture.stage); files.delete("package/dist/tui/repo-map-worker.js");
  assert.throws(() => verifyPackageEntries(files), /contents_invalid:missing:package\/dist\/tui\/repo-map-worker\.js/);
  files = stagedEntries(fixture.stage); files.delete("package/dist/tui/repo-map-worker.js");
  changeFrontendInfo(files, value => { value.version = "0.1.0-beta.17"; value.files = value.files.filter(file => file.path !== "repo-map-worker.js"); });
  changeManifest(files, value => { value.version = "0.1.0-beta.17"; });
  assert.throws(() => verifyPackageEntries(files), /beta_frontend_import_missing:main\.js:\.\/repo-map-worker\.js/);
});

test("verifier rejects missing or changed frontend files and unrelated payload", t => {
  const fixture = betaPackageFixture(t); stagePackage(fixture.source, fixture.stage);
  let files = stagedEntries(fixture.stage); files.delete("package/dist/tui/linear-entry.js");
  assert.throws(() => verifyPackageEntries(files), /contents_invalid:missing:package\/dist\/tui\/linear-entry.js/);
  files = stagedEntries(fixture.stage); files.set("package/dist/tui/chunk.js", Buffer.from("changed"));
  assert.throws(() => verifyPackageEntries(files), /beta_frontend_file_mismatch:chunk.js/);
  files = stagedEntries(fixture.stage); files.set("package/dist/tui/extra.js", Buffer.from("extra"));
  assert.throws(() => verifyPackageEntries(files), /contents_invalid:extra:package\/dist\/tui\/extra.js/);
});

test("fixtures, traversal, duplicate paths and wrong native platforms cannot enter the shipping manifest", t => {
  const fixture = betaPackageFixture(t);
  for (const path of ["fixture-entry.js", "tests/check.js", "../outside.js", "runtime/../main.js", ".env", "node_modules/other/state.json"]) {
    const info = structuredClone(fixture.info); info.files.push({ ...info.files[0], path });
    assert.throws(() => frontendPackageFiles(info), /beta_frontend_file_(invalid|forbidden)/);
  }
  const duplicate = structuredClone(fixture.info); duplicate.files.push(duplicate.files[0]);
  assert.throws(() => frontendPackageFiles(duplicate), /beta_frontend_file_invalid/);
  assert.throws(() => frontendPackageFiles({ ...fixture.info, nativePackage: "@opentui/core-linux-x64@0.4.5" }), /beta_frontend_native_platform_invalid/);
});

test("relative chunk and parser/audio resource references require a listed shipped file", t => {
  const fixture = betaPackageFixture(t);
  fixture.writeFrontend("main.js", 'import "./chunk.js"; const parser="./parser.wasm"; const query="./syntax.scm"; const audio="./audio-a1.ts";\n');
  fixture.writeFrontend("audio-a1.ts", "fixture audio\n"); stagePackage(fixture.source, fixture.stage);
  for (const path of ["chunk.js", "parser.wasm", "syntax.scm", "audio-a1.ts"]) {
    const files = stagedEntries(fixture.stage); files.delete(`package/dist/tui/${path}`);
    changeFrontendInfo(files, info => { info.files = info.files.filter(file => file.path !== path); });
    assert.throws(() => verifyPackageEntries(files), /beta_frontend_import_missing:main.js:/);
  }
});

test("the Node pipe controller resolves the shipped repository worker from the CLI directory", t => {
  const fixture = betaPackageFixture(t); stagePackage(fixture.source, fixture.stage);
  assert.doesNotThrow(() => verifyPackageEntries(stagedEntries(fixture.stage)));
  for (const path of ["./repo-map-worker.ts", "./repo-map-worker.js", "./tui/missing-worker.js"]) {
    const entries = stagedEntries(fixture.stage);
    entries.set("package/dist/cli.js", Buffer.from(`import "hono"; const repositoryWorker = new URL(${JSON.stringify(path)}, import.meta.url);\n`));
    assert.throws(() => verifyPackageEntries(entries), /beta_core_repo_map_worker_invalid/);
  }
});

test("dependency inventory cannot silently skip an undeclared external or missing installed dependency", t => {
  const fixture = betaPackageFixture(t);
  fixture.writeFrontend("chunk.js", 'import "missing-frontend-dependency";\n');
  assert.throws(() => stagePackage(fixture.source, fixture.stage), /published_dependency_missing:missing-frontend-dependency/);
  fixture.writeFrontend("chunk.js", 'import "pngjs";\n'); stagePackage(fixture.source, fixture.stage);
  for (const name of ["pngjs", "web-tree-sitter"]) {
    const files = stagedEntries(fixture.stage); changeManifest(files, pkg => { delete pkg.dependencies[name]; });
    assert.throws(() => verifyPackageEntries(files), new RegExp(`beta_artifact_runtime_dependencies_missing:${name}`));
  }
  const files = stagedEntries(fixture.stage); changeManifest(files, pkg => { pkg.dependencies["web-tree-sitter"] = "file:../private"; });
  assert.throws(() => verifyPackageEntries(files), /beta_artifact_runtime_dependencies_missing:web-tree-sitter/);
});

test("build identity, native identity, package metadata and notices remain bound to the payload", t => {
  const fixture = betaPackageFixture(t); stagePackage(fixture.source, fixture.stage);
  let files = stagedEntries(fixture.stage); changeFrontendInfo(files, info => { info.version = "0.0.0"; });
  assert.throws(() => verifyPackageEntries(files), /beta_frontend_version_mismatch/);
  files = stagedEntries(fixture.stage); changeFrontendInfo(files, info => { info.nativePackage = "@opentui/core-win32-x64@0.0.0"; });
  assert.throws(() => verifyPackageEntries(files), /beta_frontend_native_manifest_invalid/);
  files = stagedEntries(fixture.stage); changeManifest(files, pkg => { pkg.uptokeyTui.accessibleRuntime = "bun"; });
  assert.throws(() => verifyPackageEntries(files), /beta_frontend_package_metadata_invalid/);
  fixture.writeFrontend("chunk.js", "// node_modules/missing-notice/index.js\nexport {};\n");
  const stage = join(fixture.directory, "notice-stage"); mkdirSync(stage);
  assert.throws(() => stagePackage(fixture.source, stage), /beta_frontend_notices_incomplete:missing-notice/);
});

test("candidate source directories work without promotion and dry-run creates no package", t => {
  const fixture = betaPackageFixture(t), distDir = join(fixture.directory, "candidate-core"), frontendDir = join(fixture.directory, "candidate-tui"), out = join(fixture.directory, "packages");
  cpSync(fixture.distDir, distDir, { recursive: true }); cpSync(fixture.frontendDir, frontendDir, { recursive: true }); mkdirSync(out);
  rmSync(fixture.distDir, { recursive: true });
  assert.equal(packMain(["--dry-run", "--dist-dir", distDir, "--frontend-dir", frontendDir, "--out", out], fixture.source), 0);
  assert.deepEqual(readdirSync(out), []);
});

test("dynamic manifest tarballs remain byte-identical with POSIX runtime mode and ustar long paths", t => {
  const fixture = betaPackageFixture(t, "linux-x64");
  fixture.writeFrontend(`node_modules/@opentui/core-linux-x64/${"nested".repeat(12)}/metadata.json`, "{}\n");
  const result = stagePackage(fixture.source, fixture.stage);
  const first = writeDeterministicTarball(fixture.stage, join(fixture.directory, "a.tgz")), second = writeDeterministicTarball(fixture.stage, join(fixture.directory, "b.tgz"));
  assert.equal(first.sha256, second.sha256); assert.equal(verifyArtifact(first.destination).files, result.files);
  const tar = gunzipSync(readFileSync(first.destination)); let found = false;
  for (let offset = 0; offset + 512 <= tar.length;) {
    const header = tar.subarray(offset, offset + 512); if (header.every(byte => byte === 0)) break;
    const text = (start, length) => header.subarray(start, start + length).toString("utf8").replace(/\0.*$/, "");
    const path = [text(345, 155), text(0, 100)].filter(Boolean).join("/"); const size = Number.parseInt(text(124, 12), 8);
    if (path === "package/dist/tui/runtime/bun") { found = true; assert.equal(Number.parseInt(text(100, 8), 8), 0o755); }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  assert.equal(found, true);
});
