import test from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
// @ts-ignore
import { betaPackageFixture } from "./helpers/beta-package-fixture.mjs";
// @ts-ignore
import { stagePackage, writeDeterministicTarball, packMain } from "../scripts/npm-pack-beta.mjs";
// @ts-ignore
import { verifyArtifact, verifyPackageEntries } from "../scripts/verify-beta-artifact.mjs";
// @ts-ignore
import { buildTimestamp } from "../scripts/build-npm-package.mjs";

test("buildTimestamp honors SOURCE_DATE_EPOCH and falls back to now", () => {
  const epoch = buildTimestamp(Date.parse("2026-10-01T00:00:00.000Z"), { SOURCE_DATE_EPOCH: "1790812800" });
  assert.equal(epoch, "2026-10-01T00:00:00.000Z");
  const now = buildTimestamp(1_600_000_000_000, {});
  assert.equal(now, new Date(1_600_000_000_000).toISOString());
});

test("stagePackage resolves shipped docs outside the core root", t => {
    const { source, stage, info } = betaPackageFixture(t);
    const result = stagePackage(source, stage, "beta");
    assert.equal(result.manifest.name, "uptokey");
    assert.equal(result.files, 11 + info.files.length);
    const published = Object.keys(result.manifest.dependencies);
    for (const required of [
      "@hono/node-server", "@hpke/core", "@modelcontextprotocol/sdk", "@napi-rs/keyring",
      "@simplewebauthn/server", "better-sqlite3", "eventsource-parser", "hono",
      "js-tiktoken", "tree-sitter-wasm", "zod",
    ]) assert.ok(published.includes(required), `missing published dependency: ${required}`);
    for (const privateOnly of ["@langchain/core", "@langchain/langgraph", "@langchain/langgraph-checkpoint-sqlite", "langsmith"]) {
      assert.ok(!published.includes(privateOnly), `private-only dependency leaked: ${privateOnly}`);
    }
    assert.equal(result.manifest.dependencies["better-sqlite3"], "13.0.3");
});

test("deterministic tarball: same stage, identical bytes, verifier round-trip", t => {
    const { source, stage, directory: out } = betaPackageFixture(t);
    const result = stagePackage(source, stage, "beta");
    const first = writeDeterministicTarball(stage, join(out, "a", "uptokey-0.1.0-beta.7.tgz"));
    const second = writeDeterministicTarball(stage, join(out, "b", "uptokey-0.1.0-beta.7.tgz"));
    assert.equal(first.sha256, second.sha256);
    const verified = verifyArtifact(first.destination, "beta");
    assert.equal(verified.sha256, first.sha256);
    assert.equal(verified.files, result.files);
});

test("packMain --dry-run reports the published shape without writing artifacts", t => {
    const { source, directory: out } = betaPackageFixture(t);
    const code = packMain(["--dry-run", "--out", out], source);
    assert.equal(code, 0);
});

test("verifier lists missing and extra files in the failure diagnostics", () => {
  const expected = new Map();
  assert.throws(
    () => verifyPackageEntries(expected, "beta"),
    (error: unknown) => error instanceof Error && error.message.includes("beta_artifact_contents_invalid:missing:") && error.message.includes("package/dist/cli.js"),
  );
});
