import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, symlinkSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { candidateBuildEvidence, verifyCandidateReproducibility } from "../scripts/beta-build-candidate.mjs";

const bundleNames = {
  cliJs: "cli.js",
  compositionWorkerJs: "composition-worker.js",
  serviceSchemaWorkerJs: "service-schema-worker.js",
  workspaceContextHelperJs: "workspace-context-helper.js",
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), "uptokey-reproducibility-"));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = Object.fromEntries(["buildA", "buildB", "frontendA", "frontendB"].map(name => [name, join(root, name)]));
  for (const directory of Object.values(paths)) mkdirSync(directory);
  for (const directory of [paths.buildA, paths.buildB]) {
    for (const name of Object.values(bundleNames)) writeFileSync(join(directory, name), `// ${name}\n`);
  }
  for (const directory of [paths.frontendA, paths.frontendB]) {
    mkdirSync(join(directory, "parsers"));
    writeFileSync(join(directory, "main.js"), "export default 1;\n");
    writeFileSync(join(directory, "parsers", "language.wasm"), Buffer.from([0, 97, 115, 109]));
    writeFileSync(join(directory, "BUILD_INFO.json"), '{"builtAt":"2026-10-01T00:00:00.000Z"}\n');
  }
  return paths;
}

test("independent identical builds retain per-component digests", t => {
  const result = verifyCandidateReproducibility(fixture(t));
  assert.deepEqual(Object.keys(result), [...Object.keys(bundleNames), "tuiFrontend"]);
  for (const item of Object.values(result)) {
    assert.equal(item.identical, true);
    assert.equal(item.a, item.b);
    assert.match(item.a, /^[a-f0-9]{64}$/);
  }
});

test("independent build evidence preserves the publication manifest contract", t => {
  const paths = fixture(t);
  const evidence = candidateBuildEvidence(paths);
  assert.equal(evidence.evidenceMode, "independent_builds");
  assert.equal(evidence.byteIdentical, true);
  assert.equal(evidence.approach, "SOURCE_DATE_EPOCH fixed, same toolchain, two independent builds");
  for (const [name, digest] of Object.entries(verifyCandidateReproducibility(paths))) assert.deepEqual(evidence[name], digest);
  assert.equal(evidence.reusedArtifacts, undefined);
});

for (const [component, source, comparison] of [["core", "buildA", "buildB"], ["tuiFrontend", "frontendA", "frontendB"]]) {
  test(`same ${component} directory cannot establish reproducibility`, t => {
    const paths = fixture(t);
    paths[comparison] = paths[source];
    assert.throws(() => candidateBuildEvidence(paths), {
      message: `candidate_independent_build_directories_required:${component}`,
    });
  });

  test(`${component} directory aliases cannot establish reproducibility`, t => {
    const paths = fixture(t);
    const alias = paths[source] + "-alias";
    symlinkSync(paths[source], alias, process.platform === "win32" ? "junction" : "dir");
    paths[comparison] = alias;
    assert.throws(() => verifyCandidateReproducibility(paths), {
      message: `candidate_independent_build_directories_required:${component}`,
    });
  });
}

test("reused artifacts retain identity digests without satisfying publication reproducibility", t => {
  const paths = fixture(t);
  const independent = verifyCandidateReproducibility(paths);
  // Reuse needs only the existing artifacts, not a second build of either component.
  rmSync(paths.buildB, { recursive: true });
  rmSync(paths.frontendB, { recursive: true });
  const evidence = candidateBuildEvidence({ buildA: paths.buildA, frontendA: paths.frontendA }, { reuse: true });
  assert.equal(evidence.evidenceMode, "reused_artifacts");
  assert.equal(evidence.byteIdentical, false);
  assert.doesNotMatch(evidence.approach, /two independent builds/);
  assert.match(evidence.caveat, /do not establish reproducibility/);
  assert.equal(evidence.reusedArtifacts.core.directory, realpathSync.native(paths.buildA));
  for (const [name, filename] of Object.entries(bundleNames)) {
    const digest = createHash("sha256").update(`// ${filename}\n`).digest("hex");
    assert.equal(evidence.reusedArtifacts.core.files[name], digest);
    assert.equal(evidence[name], undefined);
  }
  assert.equal(evidence.reusedArtifacts.tuiFrontend.directory, realpathSync.native(paths.frontendA));
  assert.equal(evidence.reusedArtifacts.tuiFrontend.sha256, independent.tuiFrontend.a);
  assert.equal(evidence.tuiFrontend, undefined);
});

for (const [component, filename] of Object.entries(bundleNames)) {
  test(`different ${filename} refuses a release candidate`, t => {
    const paths = fixture(t);
    writeFileSync(join(paths.buildB, filename), "different build bytes\n");
    assert.throws(() => verifyCandidateReproducibility(paths), { message: `candidate_build_not_reproducible:${component}` });
  });
}

test("nested parser and manifest drift cannot pass frontend reproducibility", t => {
  const paths = fixture(t);
  writeFileSync(join(paths.frontendB, "parsers", "language.wasm"), Buffer.from([0, 97, 115, 109, 1]));
  writeFileSync(join(paths.frontendB, "BUILD_INFO.json"), '{"builtAt":"2026-10-02T00:00:00.000Z"}\n');
  assert.throws(() => verifyCandidateReproducibility(paths), { message: "candidate_build_not_reproducible:tuiFrontend" });
});

test("unexpected frontend files and simultaneous worker drift are reported together", t => {
  const paths = fixture(t);
  writeFileSync(join(paths.frontendB, "extra.js"), "unlisted output\n");
  writeFileSync(join(paths.buildB, "composition-worker.js"), "changed worker\n");
  assert.throws(() => verifyCandidateReproducibility(paths), {
    message: "candidate_build_not_reproducible:compositionWorkerJs,tuiFrontend",
  });
});

test("a missing independently built component cannot be accepted", t => {
  const paths = fixture(t);
  rmSync(join(paths.buildB, "cli.js"));
  assert.throws(() => verifyCandidateReproducibility(paths), { code: "ENOENT" });
});
