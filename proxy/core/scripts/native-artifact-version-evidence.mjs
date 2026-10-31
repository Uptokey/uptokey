import { createHash } from "node:crypto";
import { lstatSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { basename, dirname, parse, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { validReleaseVersion } from "./artifact-version-evidence.mjs";

export const NATIVE_IDENTITY_COMMAND = "--native-build-identity";
export const NATIVE_IDENTITY_SCHEMA = "uptokey-native-build-identity-v1";
const RECEIPT_SCHEMA = "uptokey-native-artifact-build-evidence-v1";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value, keys) => record(value) && Object.keys(value).sort().join(",") === [...keys].sort().join(",");
const sha40 = (value) => typeof value === "string" && /^[a-f0-9]{40}$/.test(value);
const sha64 = (value) => typeof value === "string" && /^[a-f0-9]{64}$/.test(value);
const portableBasename = (value) => typeof value === "string" && value.length > 0
  && value !== "." && value !== ".." && value.trim() === value && !value.endsWith(".")
  && /^[^/\\:\x00-\x1f\x7f-\x9f]+$/u.test(value)
  && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value);

function checkedPath(input, output = false) {
  if (typeof input !== "string" || !portableBasename(basename(input))
      || input.split(/[\\/]/).some((part) => part === "." || part === "..")) throw new Error("native_identity_path_invalid");
  const path = resolve(input);
  const root = parse(path).root;
  for (let current = path; ;) {
    // Reuse product-contract's root handling: only metadata spelling changes.
    // dirname on a verbatim drive root can otherwise descend to drive-relative C:.
    const metadataPath = current === root && /^\\\\\?\\[A-Za-z]:\\$/.test(root) ? root.slice(4) : current;
    const metadata = lstatSync(metadataPath, { throwIfNoEntry: false });
    if (!metadata) {
      if (!output || current !== path) throw new Error("native_identity_path_missing");
    } else if (metadata.isSymbolicLink() || (current !== path && !metadata.isDirectory())) {
      throw new Error("native_identity_path_link_or_ancestor_invalid");
    }
    if (current === root) break;
    const parent = dirname(current);
    current = parent.length < root.length ? root : parent;
  }
  return path;
}

function validExpected(value) {
  return record(value) && typeof value.version === "string" && validReleaseVersion(`v${value.version}`)
    && ["windows", "macos", "linux"].includes(value.targetOs)
    && ["x86_64", "aarch64"].includes(value.targetArch)
    && ["Harness", "shell"].includes(value.defaultInterface) && sha40(value.sourceCommit);
}

export function validateNativeBuildIdentity(value, expected) {
  if (!validExpected(expected)) return ["native_identity_expected_invalid"];
  if (!exact(value, ["schema", "product", "version", "defaultInterface", "target", "sourceCommit"])
      || value.schema !== NATIVE_IDENTITY_SCHEMA || value.product !== "uptokey-tauri"
      || !exact(value.target, ["os", "arch"])) return ["native_identity_schema_invalid"];
  const errors = [];
  for (const field of ["version", "defaultInterface", "sourceCommit"]) {
    if (value[field] !== expected[field]) errors.push(`native_identity_${field}_mismatch`);
  }
  if (!sha40(value.sourceCommit)) errors.push("native_identity_commit_invalid");
  if (value.target.os !== expected.targetOs || value.target.arch !== expected.targetArch) errors.push("native_identity_target_mismatch");
  return errors;
}

export function validateNativeArtifactVersionReceipt(value, expected) {
  if (!validExpected(expected)) return ["native_identity_expected_invalid"];
  if (!exact(value, ["schema", "identity", "artifact", "subjectSha256", "checks"])
      || value.schema !== RECEIPT_SCHEMA) return ["native_identity_receipt_schema_invalid"];
  const errors = validateNativeBuildIdentity(value.identity, expected);
  if (!portableBasename(expected.artifact) || !portableBasename(value.artifact)
      || value.artifact !== expected.artifact) errors.push("native_identity_receipt_artifact_mismatch");
  if (!sha64(expected.subjectSha256) || value.subjectSha256 !== expected.subjectSha256) errors.push("native_identity_receipt_subject_mismatch");
  if (!exact(value.checks, ["staticCommandSupport", "executableBuildIdentity"])
      || value.checks.staticCommandSupport !== true || value.checks.executableBuildIdentity !== true) errors.push("native_identity_receipt_checks_invalid");
  return errors;
}

/** A fixed native command only: never pass old Tauri artifacts to the core probe. */
export function createNativeArtifactVersionEvidence(options) {
  if (!validExpected(options) || !sha64(options.expectedSubjectSha256)) throw new Error("native_identity_expected_invalid");
  // Reject caller-selected interpreters, argument lists and boolean support claims.
  const allowed = ["artifactPath", "outputPath", "expectedSubjectSha256", "version", "targetOs", "targetArch", "defaultInterface", "sourceCommit"];
  if (!Object.keys(options).every((key) => allowed.includes(key))) throw new Error("native_identity_options_invalid");
  const output = checkedPath(options.outputPath, true);
  const path = checkedPath(options.artifactPath);
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size === 0 || stat.size > 256 * 1024 * 1024) throw new Error("native_identity_artifact_invalid");
  const artifact = realpathSync(path);
  const bytes = readFileSync(artifact);
  const digest = sha256(bytes);
  if (digest !== options.expectedSubjectSha256) throw new Error("native_identity_artifact_hash_mismatch");
  // Both strings are compiled by the new dispatcher. A boolean is never proof of support.
  if (!bytes.includes(Buffer.from(NATIVE_IDENTITY_SCHEMA)) || !bytes.includes(Buffer.from(NATIVE_IDENTITY_COMMAND))) throw new Error("native_identity_command_unsupported");
  const hostOs = { win32: "windows", darwin: "macos", linux: "linux" }[process.platform];
  const hostArch = { x64: "x86_64", arm64: "aarch64" }[process.arch];
  if (options.targetOs !== hostOs || options.targetArch !== hostArch) throw new Error("native_identity_probe_host_mismatch");
  const result = spawnSync(artifact, [NATIVE_IDENTITY_COMMAND], {
    windowsHide: true, shell: false, timeout: 10_000, maxBuffer: 4096,
    stdio: ["ignore", "pipe", "pipe"],
  });
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stdout)
      || !Buffer.isBuffer(result.stderr) || result.stderr.length) throw new Error("native_identity_probe_failed");
  let identity;
  try {
    const stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout);
    if (!/^[^\r\n]+\r?\n$/.test(stdout)) throw new Error();
    identity = JSON.parse(stdout.trimEnd());
  } catch { throw new Error("native_identity_probe_output_invalid"); }
  const errors = validateNativeBuildIdentity(identity, options);
  if (errors.length) throw new Error(errors[0]);
  if (sha256(readFileSync(artifact)) !== digest) throw new Error("native_identity_artifact_changed");
  const receipt = {
    schema: RECEIPT_SCHEMA, identity, artifact: basename(artifact), subjectSha256: digest,
    checks: { staticCommandSupport: true, executableBuildIdentity: true },
  };
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { output, receipt };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    // One reviewed JSON input avoids an open-ended generic probe command.
    if (process.argv.length !== 3) throw new Error();
    createNativeArtifactVersionEvidence(JSON.parse(readFileSync(process.argv[2], "utf8")));
    process.stdout.write("native_artifact_identity_evidence_valid\n");
  } catch {
    process.stderr.write("native_artifact_identity_evidence_invalid\n");
    process.exitCode = 1;
  }
}
