import assert from "node:assert/strict";
import fs from "node:fs";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, symlinkSync, readFileSync, realpathSync, writeFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, toNamespacedPath } from "node:path";
import { test } from "node:test";
import { syncBuiltinESMExports } from "node:module";
import { createNativeArtifactVersionEvidence, validateNativeBuildIdentity, validateNativeArtifactVersionReceipt } from "./native-artifact-version-evidence.mjs";

const expected = { version: "0.2.0", targetOs: "windows", targetArch: "x86_64", defaultInterface: "Harness", sourceCommit: "a".repeat(40) };
const identity = { schema: "uptokey-native-build-identity-v1", product: "uptokey-tauri", version: expected.version,
  defaultInterface: expected.defaultInterface, target: { os: expected.targetOs, arch: expected.targetArch }, sourceCommit: expected.sourceCommit };
const receipt = { schema: "uptokey-native-artifact-build-evidence-v1", identity, artifact: "uptokey_tauri.exe", subjectSha256: "b".repeat(64), checks: { staticCommandSupport: true, executableBuildIdentity: true } };
const receiptExpected = { ...expected, artifact: receipt.artifact, subjectSha256: receipt.subjectSha256 };

test("native schema is exact, separate from core and carries no updater claim", () => {
  assert.deepEqual(validateNativeBuildIdentity(identity, expected), []);
  for (const value of [{ ...identity, updateTrust: {} }, { ...identity, schema: "uptokey-compiled-build-identity-v1" },
    { ...identity, target: { ...identity.target, updater: true } }, { ...identity, product: "uptokey" }]) {
    assert.ok(validateNativeBuildIdentity(value, expected).length);
  }
});

test("every identity binding and externally expected commit must match", () => {
  for (const [key, value] of Object.entries({ version: "0.2.1", defaultInterface: "shell", sourceCommit: "c".repeat(40) })) {
    assert.ok(validateNativeBuildIdentity({ ...identity, [key]: value }, expected).length);
  }
  assert.ok(validateNativeBuildIdentity({ ...identity, target: { os: "linux", arch: "aarch64" } }, expected).length);
  for (const value of [undefined, "", "A".repeat(40), "a".repeat(39)]) {
    assert.ok(validateNativeBuildIdentity(identity, { ...expected, sourceCommit: value }).length);
  }
});

test("receipt requires exact schema, digest, artifact and both checks", () => {
  assert.deepEqual(validateNativeArtifactVersionReceipt(receipt, receiptExpected), []);
  for (const value of [{ ...receipt, subjectSha256: "c".repeat(64) }, { ...receipt, artifact: "old.exe" },
    { ...receipt, checks: { executableBuildIdentity: true } }, { ...receipt, updateTrust: {} },
    { ...receipt, checks: { ...receipt.checks, staticCommandSupport: false } }]) {
    assert.ok(validateNativeArtifactVersionReceipt(value, receiptExpected).length);
  }
});

test("receipt rejects absent expectation and nonportable artifact basenames", () => {
  for (const value of [null, undefined, {}, { ...receiptExpected, sourceCommit: undefined }]) {
    assert.deepEqual(validateNativeArtifactVersionReceipt(receipt, value), ["native_identity_expected_invalid"]);
  }
  for (const artifact of ["", ".", "..", "path/file.exe", "path\\file.exe", "a\n.exe", "a\x00.exe", "a:stream", "NUL.exe", "file.exe."]) {
    assert.ok(validateNativeArtifactVersionReceipt({ ...receipt, artifact }, { ...receiptExpected, artifact }).length, JSON.stringify(artifact));
  }
});

test("input and output directory junctions or symlinks are refused before spawn", () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "uptokey-native-identity-links-"));
  try {
    const real = join(dir, "real");
    const link = join(dir, "link");
    mkdirSync(real);
    symlinkSync(real, link, process.platform === "win32" ? "junction" : "dir");
    const bytes = Buffer.from("old unsupported executable");
    const artifactPath = join(real, "old.exe");
    writeFileSync(artifactPath, bytes);
    const options = { ...expected, artifactPath, outputPath: join(dir, "receipt.json"), expectedSubjectSha256: createHash("sha256").update(bytes).digest("hex") };
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, artifactPath: join(link, "old.exe") }), /path_link_or_ancestor_invalid/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, outputPath: join(link, "receipt.json") }), /path_link_or_ancestor_invalid/);
    assert.equal(existsSync(join(real, "receipt.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("unsupported old executable is refused before spawn; boolean support is rejected", () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "uptokey-native-identity-"));
  try {
    const artifactPath = join(dir, process.platform === "win32" ? "old.cmd" : "old");
    const sentinel = join(dir, "STARTED");
    const bytes = Buffer.from(process.platform === "win32" ? `@echo started>"${sentinel}"\r\n` : `#!/bin/sh\necho started > '${sentinel}'\n`);
    writeFileSync(artifactPath, bytes, { mode: 0o700 });
    const options = { ...expected, artifactPath, outputPath: join(dir, "receipt.json"), expectedSubjectSha256: createHash("sha256").update(bytes).digest("hex") };
    assert.throws(() => createNativeArtifactVersionEvidence(options), /command_unsupported/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, supportsIdentity: true }), /options_invalid/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, probeCommand: process.execPath }), /options_invalid/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, runner: () => {} }), /options_invalid/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, expectedSubjectSha256: "d".repeat(64) }), /hash_mismatch/);
    assert.equal(existsSync(sentinel), false);
    assert.equal(existsSync(options.outputPath), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("native dispatch precedes profile, resources, context and single instance", () => {
  const main = readFileSync(new URL("../../../quimera/tauri/src/main.rs", import.meta.url), "utf8");
  const start = main.indexOf("fn main() {");
  const dispatch = main.indexOf("native_build_identity::dispatch(&args)", start);
  assert.ok(dispatch > start);
  for (const operation of ["OperationalProfile::from_env()", "tauri::generate_context!", "tauri::Builder::default()", ".plugin(single_instance_init("]) {
    assert.ok(main.indexOf(operation, start) > dispatch, operation);
  }
  assert.match(main.slice(dispatch, main.indexOf("let harness =", dispatch)), /return;/);
  const build = readFileSync(new URL("../../../quimera/tauri/build.rs", import.meta.url), "utf8");
  assert.ok(build.indexOf("valid_source_commit(value)") < build.indexOf("tauri_build::try_build"));
  assert.match(build, /cargo:rerun-if-env-changed=UPTOKEY_RELEASE_SOURCE_COMMIT/);
});

test("supported module-only fixture can produce evidence without entering startup", { skip: !process.env.UPTOKEY_NATIVE_IDENTITY_TEST_FIXTURE }, () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "uptokey-native-identity-fixture-"));
  try {
    const artifactPath = process.env.UPTOKEY_NATIVE_IDENTITY_TEST_FIXTURE;
    const bytes = readFileSync(artifactPath);
    const options = { ...expected, targetOs: { win32: "windows", darwin: "macos", linux: "linux" }[process.platform],
      targetArch: { x64: "x86_64", arm64: "aarch64" }[process.arch], artifactPath,
      expectedSubjectSha256: createHash("sha256").update(bytes).digest("hex"), outputPath: join(dir, "receipt.json") };
    const result = createNativeArtifactVersionEvidence(options);
    assert.deepEqual(validateNativeArtifactVersionReceipt(result.receipt, { ...options, artifact: result.receipt.artifact, subjectSha256: options.expectedSubjectSha256 }), []);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, sourceCommit: "c".repeat(40), outputPath: join(dir, "wrong.json") }), /sourceCommit_mismatch/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, targetOs: options.targetOs === "linux" ? "windows" : "linux", outputPath: join(dir, "wrong-host.json") }), /probe_host_mismatch/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("Windows verbatim identity paths preserve drive-root checks and reject traversal and junctions", {
  skip: process.platform !== "win32" || !process.env.UPTOKEY_NATIVE_IDENTITY_TEST_FIXTURE,
}, () => {
  const dir = mkdtempSync(join(realpathSync.native(tmpdir()), "uptokey-native-identity-namespace-"));
  try {
    const artifact = process.env.UPTOKEY_NATIVE_IDENTITY_TEST_FIXTURE;
    const digest = createHash("sha256").update(readFileSync(artifact)).digest("hex");
    const options = { ...expected, expectedSubjectSha256: digest };
    for (const [index, artifactPath] of [artifact, toNamespacedPath(artifact)].entries()) {
      for (const namespacedOutput of [false, true]) {
        const output = join(dir, `receipt-${index}-${namespacedOutput}.json`);
        const outputPath = namespacedOutput ? toNamespacedPath(output) : output;
        const result = createNativeArtifactVersionEvidence({ ...options, artifactPath, outputPath });
        assert.deepEqual(validateNativeArtifactVersionReceipt(result.receipt, { ...options, artifact: result.receipt.artifact, subjectSha256: digest }), []);
      }
    }
    mkdirSync(join(dir, "nested"));
    const traversingOutput = `${toNamespacedPath(dir)}\\nested\\..\\traversal.json`;
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, artifactPath: artifact, outputPath: traversingOutput }), /path_invalid/);
    const traversingArtifact = `${toNamespacedPath(dirname(artifact))}\\nested\\..\\${basename(artifact)}`;
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, artifactPath: traversingArtifact, outputPath: join(dir, "not-written.json") }), /path_invalid/);
    const link = join(dir, "linked");
    symlinkSync(dir, link, "junction");
    writeFileSync(join(dir, "old.exe"), "unsupported fixture; never execute");
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, artifactPath: artifact, outputPath: toNamespacedPath(join(link, "receipt.json")) }), /path_link_or_ancestor_invalid/);
    assert.throws(() => createNativeArtifactVersionEvidence({ ...options, artifactPath: toNamespacedPath(join(link, "old.exe")), outputPath: join(dir, "not-written.json") }), /path_link_or_ancestor_invalid/);
    assert.equal(existsSync(join(dir, "traversal.json")), false);
    assert.equal(existsSync(join(dir, "not-written.json")), false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

function syntheticSubject(t) {
  const parent = realpathSync.native(tmpdir());
  const directory = mkdtempSync(join(parent, "uptokey-native-identity-race-"));
  t.after(() => {
    assert.equal(dirname(directory), parent);
    rmSync(directory, { recursive: true, force: true });
  });
  const artifactPath = join(directory, "original-subject.exe");
  // Never executable: the subprocess is mocked locally in these synthetic unit cases.
  const bytes = Buffer.from("uptokey-native-build-identity-v1 --native-build-identity synthetic subject");
  writeFileSync(artifactPath, bytes);
  const options = { ...expected, artifactPath, outputPath: join(directory, "receipt.json"),
    targetOs: { win32: "windows", darwin: "macos", linux: "linux" }[process.platform],
    targetArch: { x64: "x86_64", arm64: "aarch64" }[process.arch],
    expectedSubjectSha256: createHash("sha256").update(bytes).digest("hex") };
  const response = () => ({ status: 0, signal: null, stdout: Buffer.from(JSON.stringify({ ...identity,
    target: { os: options.targetOs, arch: options.targetArch } }) + "\n"), stderr: Buffer.alloc(0) });
  return { directory, bytes, options, response };
}

test("synthetic original replacement cannot redirect the fixed command from private verified bytes", t => {
  const f = syntheticSubject(t), write = fs.writeFileSync;
  let snapshot, calls = 0;
  t.mock.method(fs, "writeFileSync", (path, bytes, options) => {
    const result = write(path, bytes, options);
    if (basename(dirname(path)).startsWith("uptokey-native-identity-probe-")) {
      snapshot = path;
      assert.equal(options.flag, "wx");
      write(f.options.artifactPath, "synthetic changed original; never execute");
    }
    return result;
  });
  t.mock.method(childProcess, "spawnSync", (command, args) => {
    calls++;
    assert.equal(command, snapshot);
    assert.notEqual(command, f.options.artifactPath);
    assert.deepEqual(args, ["--native-build-identity"]);
    assert.deepEqual(readFileSync(command), f.bytes);
    return f.response();
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createNativeArtifactVersionEvidence(f.options), /artifact_changed/);
    assert.equal(calls, 1);
    assert.equal(existsSync(dirname(snapshot)), false);
    assert.equal(existsSync(f.options.outputPath), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("synthetic private copy corruption is refused before spawn and its directory is cleaned", t => {
  const f = syntheticSubject(t), write = fs.writeFileSync;
  let snapshot, calls = 0;
  t.mock.method(fs, "writeFileSync", (path, bytes, options) => {
    const result = write(path, bytes, options);
    if (basename(dirname(path)).startsWith("uptokey-native-identity-probe-")) {
      snapshot = path;
      write(path, "synthetic corrupted private copy");
    }
    return result;
  });
  t.mock.method(childProcess, "spawnSync", () => { calls++; throw Error("unexpected synthetic probe"); });
  syncBuiltinESMExports();
  try {
    assert.throws(() => createNativeArtifactVersionEvidence(f.options), /snapshot_changed/);
    assert.equal(calls, 0);
    assert.equal(existsSync(dirname(snapshot)), false);
    assert.equal(existsSync(f.options.outputPath), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test("synthetic private probe preserves the original subject basename and rechecks output ancestors", t => {
  const f = syntheticSubject(t);
  let snapshot;
  t.mock.method(childProcess, "spawnSync", command => {
    snapshot = command;
    assert.deepEqual(readFileSync(command), f.bytes);
    return f.response();
  });
  syncBuiltinESMExports();
  try {
    const result = createNativeArtifactVersionEvidence(f.options);
    assert.equal(result.receipt.artifact, basename(f.options.artifactPath));
    assert.equal(result.receipt.subjectSha256, f.options.expectedSubjectSha256);
    assert.equal(existsSync(dirname(snapshot)), false);
    const outputDirectory = join(f.directory, "output"), moved = join(f.directory, "moved"), target = join(f.directory, "target");
    mkdirSync(outputDirectory); mkdirSync(target);
    t.mock.restoreAll(); syncBuiltinESMExports();
    t.mock.method(childProcess, "spawnSync", () => {
      fs.renameSync(outputDirectory, moved);
      symlinkSync(target, outputDirectory, process.platform === "win32" ? "junction" : "dir");
      return f.response();
    });
    syncBuiltinESMExports();
    assert.throws(() => createNativeArtifactVersionEvidence({ ...f.options, outputPath: join(outputDirectory, "race.json") }), /path_link_or_ancestor_invalid/);
    assert.equal(existsSync(join(target, "race.json")), false);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});
