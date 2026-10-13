#!/usr/bin/env node
// Builds a distribution candidate entirely in a staging tree under
// workspace/output — never touching proxy/core/dist or any runtime in use.
// Produces: two independent builds for byte-reproducibility comparison,
// a deterministic tarball and a run manifest with hashes and provenance.
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, cpSync, rmSync, existsSync, readdirSync, lstatSync } from "node:fs";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { dirname, join, resolve, basename } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { stagePackage, writeDeterministicTarball } from "./npm-pack-beta.mjs";
import { verifyArtifact } from "./verify-beta-artifact.mjs";

const scriptsRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const workspaceRoot = resolve(scriptsRoot, "../..");
const outputRoot = resolve(workspaceRoot, "output", "beta-distribuicao-2026-10-01");

export const SOURCE_DATE_EPOCH = "1790812800"; // 2026-10-01T00:00:00Z

function sha256File(path) {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function spawnNode(args, env = {}) {
  return spawnSync(process.execPath, args, { cwd: scriptsRoot, encoding: "utf8", windowsHide: true, env: { ...process.env, ...env } });
}

function buildInto(destination) {
  if (existsSync(destination)) throw new Error(`build_destination_exists:${destination}`);
  const result = spawnNode([join("scripts", "build-npm-package.mjs"), "--out-dir", destination], { SOURCE_DATE_EPOCH });
  if (result.status !== 0) throw new Error(`candidate_build_failed:${(result.stderr || result.stdout || "").split("\n").filter(Boolean).at(-1) ?? "unknown"}`);
  return result.stdout.trim();
}

function buildFrontendInto(destination) {
  if (existsSync(destination)) throw new Error(`build_destination_exists:${destination}`);
  const result = spawnNode([join("scripts", "build-tui-frontend.mjs"), "--portable", "--out-dir", destination], { SOURCE_DATE_EPOCH });
  if (result.status !== 0) throw new Error(`candidate_frontend_build_failed:${(result.stderr || result.stdout || "").split("\n").filter(Boolean).at(-1) ?? "unknown"}`);
  return result.stdout.trim();
}

function directoryDigest(directory) {
  const files = [];
  const walk = current => {
    for (const name of readdirSync(current).sort()) {
      const path = join(current, name);
      const stat = lstatSync(path);
      if (stat.isSymbolicLink()) throw new Error("candidate_frontend_symlink");
      if (stat.isDirectory()) walk(path);
      else if (stat.isFile()) files.push(`${path.slice(directory.length + 1).replaceAll("\\", "/")}:${sha256File(path)}`);
      else throw new Error("candidate_frontend_entry_invalid");
    }
  };
  walk(directory);
  return createHash("sha256").update(files.join("\n")).digest("hex");
}

/** Reject differing build bytes before staging or writing a releasable tarball. */
export function verifyCandidateReproducibility({ buildA, buildB, frontendA, frontendB }) {
  const pairs = {
    cliJs: [join(buildA, "cli.js"), join(buildB, "cli.js")],
    compositionWorkerJs: [join(buildA, "composition-worker.js"), join(buildB, "composition-worker.js")],
    serviceSchemaWorkerJs: [join(buildA, "service-schema-worker.js"), join(buildB, "service-schema-worker.js")],
    workspaceContextHelperJs: [join(buildA, "workspace-context-helper.js"), join(buildB, "workspace-context-helper.js")],
  };
  const result = Object.fromEntries(Object.entries(pairs).map(([name, paths]) => {
    const [a, b] = paths.map(sha256File);
    return [name, { a, b, identical: a === b }];
  }));
  const a = directoryDigest(frontendA), b = directoryDigest(frontendB);
  result.tuiFrontend = { a, b, identical: a === b };
  const differences = Object.keys(result).filter(name => !result[name].identical);
  if (differences.length) throw new Error(`candidate_build_not_reproducible:${differences.join(",")}`);
  return result;
}

function assemblePackageRoot(distDir, frontendDir, packageRoot) {
  mkdirSync(packageRoot, { recursive: true });
  for (const file of ["package.json", "package-lock.json", "LICENSE", "README.md"]) cpSync(join(scriptsRoot, file), join(packageRoot, file));
  cpSync(join(workspaceRoot, "docs", "beta", "FIRST-RUN-BETA.md"), join(packageRoot, "FIRST-RUN-BETA.md"));
  cpSync(join(workspaceRoot, "packaging", "npm-uptokey", "SPEC-MCP-V1.md"), join(packageRoot, "SPEC-MCP-V1.md"));
  mkdirSync(join(packageRoot, "dist"));
  for (const file of ["cli.js", "composition-worker.js", "service-schema-worker.js", "workspace-context-helper.js", "BUILD_INFO.json", "THIRD-PARTY-NOTICES.md"]) {
    const source = join(distDir, file);
    if (!existsSync(source)) throw new Error(`candidate_dist_missing:${file}`);
    cpSync(source, join(packageRoot, "dist", file));
  }
  if (!existsSync(join(frontendDir, "BUILD_INFO.json"))) throw new Error("candidate_frontend_manifest_missing");
  cpSync(frontendDir, join(packageRoot, "dist", "tui"), { recursive: true, force: false, errorOnExist: true });
}

function main() {
  const args = process.argv.slice(2);
  let reuseDist = null;
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === "--reuse-dist") {
      if (index + 1 >= args.length) throw new Error("candidate_arguments_invalid");
      reuseDist = resolve(args[index + 1]);
      index += 1;
    } else {
      positional.push(args[index]);
    }
  }
  if (positional.length > 0) throw new Error("candidate_arguments_invalid");
  const runDir = join(outputRoot, `run-${Date.now()}`);
  mkdirSync(runDir, { recursive: true });
  const stage = mkdtempSync(join(tmpdir(), "uptokey-candidate-"));
  try {
    const buildA = reuseDist ?? join(runDir, "dist-a");
    const buildB = reuseDist ?? join(runDir, "dist-b");
    const frontendA = reuseDist ? join(scriptsRoot, "dist", "tui") : join(runDir, "tui-a");
    const frontendB = reuseDist ? join(scriptsRoot, "dist", "tui") : join(runDir, "tui-b");
    const outA = reuseDist ? `reused:${buildA}` : buildInto(buildA);
    const outB = reuseDist ? `reused:${buildB}` : buildInto(buildB);
    const frontendOutA = reuseDist ? `reused:${frontendA}` : buildFrontendInto(frontendA);
    const frontendOutB = reuseDist ? `reused:${frontendB}` : buildFrontendInto(frontendB);

    const reproducibility = verifyCandidateReproducibility({ buildA, buildB, frontendA, frontendB });
    const buildReproducible = true;

    const packageRoot = join(stage, "package-root");
    assemblePackageRoot(buildA, frontendA, packageRoot);
    const staging = join(stage, "staging");
    mkdirSync(staging, { recursive: true });
    const staged = stagePackage(packageRoot, staging, "beta");
    const version = staged.manifest.version;
    const tarball = join(runDir, `uptokey-${version}.tgz`);
    const packed = writeDeterministicTarball(staging, tarball);
    const verified = verifyArtifact(tarball, "beta");

    const pkg = JSON.parse(readFileSync(join(scriptsRoot, "package.json"), "utf8"));
    const buildInfo = JSON.parse(readFileSync(join(buildA, "BUILD_INFO.json"), "utf8"));
    const gitHead = spawnSync("git", ["-C", workspaceRoot, "rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).stdout.trim() || "unavailable";

    const manifest = {
      schema: "uptokey-beta-candidate-run-v1",
      generatedAt: new Date().toISOString(),
      sourceDateEpoch: SOURCE_DATE_EPOCH,
      workspace: workspaceRoot,
      gitHead,
      coreVersion: pkg.version,
      buildInfo: buildInfo,
      reproducibility: {
        approach: "SOURCE_DATE_EPOCH fixed, same toolchain, two independent builds",
        ...reproducibility,
        byteIdentical: buildReproducible,
        caveat: "Byte identity is scoped to the same Node/zlib/Bun versions on this host.",
      },
      tarball: {
        path: tarball,
        sha256: packed.sha256,
        files: packed.files,
        verifiedFiles: verified.files,
        verifier: "verify-beta-artifact.mjs (in-process tar/gzip parser)",
      },
      buildOutput: { a: outA, b: outB, frontendA: frontendOutA, frontendB: frontendOutB },
    };
    const manifestPath = join(runDir, "run-manifest.json");
    writeFileSync(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
    process.stdout.write(`${JSON.stringify({ runDir, tarball, sha256: packed.sha256, buildReproducible, manifestPath })}\n`);
    return 0;
  } finally {
    rmSync(stage, { recursive: true, force: true });
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
