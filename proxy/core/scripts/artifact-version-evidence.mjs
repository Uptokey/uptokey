import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { basename, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { publicUpdateKeyFingerprint } from "./build-update-trust.mjs";

const PLATFORMS = new Set(["macos", "windows", "linux"]);
const RELEASE_VERSION = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

export function createArtifactVersionEvidence(options) {
  const platform = options?.platform;
  const version = options?.expectedVersion;
  if (!PLATFORMS.has(platform)) throw new Error("artifact_version_platform_invalid");
  if (!validReleaseVersion(version)) throw new Error("artifact_version_expected_invalid");
  const updateOrigin = validUpdateOrigin(options?.expectedUpdateOrigin);
  const primaryKeyFingerprint = publicUpdateKeyFingerprint(options?.expectedPrimaryPublicKeyPath);
  const nextKeyFingerprint = options?.expectedNextPublicKeyPath ? publicUpdateKeyFingerprint(options.expectedNextPublicKeyPath) : null;
  if (nextKeyFingerprint === primaryKeyFingerprint) throw new Error("artifact_update_rotation_key_duplicate");
  if (typeof options?.probeCommand !== "string" || options.probeCommand.length === 0) throw new Error("artifact_version_probe_invalid");
  if (!Array.isArray(options?.probeArgs) || options.probeArgs.some((value) => typeof value !== "string")) throw new Error("artifact_version_probe_args_invalid");

  const artifact = checkedRegular(options.artifactPath, "artifact");
  const artifactDigestBeforeProbe = sha256File(artifact);
  const result = spawnSync(options.probeCommand, [...options.probeArgs, "build-identity"], {
    windowsHide: true, timeout: 30_000, maxBuffer: 4 * 1024,
  });
  if (result.error || result.signal || result.status !== 0 || !Buffer.isBuffer(result.stderr) || result.stderr.length !== 0 || !Buffer.isBuffer(result.stdout)) throw new Error("artifact_build_identity_probe_failed");
  let stdout;
  try { stdout = new TextDecoder("utf-8", { fatal: true }).decode(result.stdout); } catch { throw new Error("artifact_build_identity_probe_utf8_invalid"); }
  if (!stdout.endsWith("\n") || stdout.slice(0, -1).includes("\n")) throw new Error("artifact_build_identity_probe_output_invalid");
  let observed;
  try { observed = JSON.parse(stdout.slice(0, -1).replace(/\r$/, "")); } catch { throw new Error("artifact_build_identity_probe_json_invalid"); }
  const identityErrors = validateCompiledBuildIdentity(observed, { version, updateOrigin, primaryKeyFingerprint, nextKeyFingerprint });
  if (identityErrors.length) throw new Error(identityErrors[0]);
  const artifactDigestAfterProbe = sha256File(artifact);
  if (artifactDigestAfterProbe !== artifactDigestBeforeProbe) throw new Error("artifact_changed_during_build_identity_probe");

  const receipt = Object.freeze({
    schema: "uptokey-artifact-build-evidence-v2",
    platform,
    version,
    updateOrigin,
    updateTrust: Object.freeze({ primaryKeyFingerprint, nextKeyFingerprint }),
    artifact: basename(artifact),
    subjectSha256: artifactDigestAfterProbe,
    checks: Object.freeze({ executableBuildIdentity: true }),
  });
  const output = resolve(options.outputPath);
  writeFileSync(output, `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 });
  return { output, receipt };
}

export function validateArtifactVersionReceipt(value, expected) {
  const errors = [];
  if (!record(value) || !exactKeys(value, ["schema", "platform", "version", "updateOrigin", "updateTrust", "artifact", "subjectSha256", "checks"])) return ["build_identity_receipt_schema_invalid"];
  if (value.schema !== "uptokey-artifact-build-evidence-v2") errors.push("build_identity_receipt_schema_invalid");
  if (value.platform !== expected.platform) errors.push("build_version_receipt_platform_mismatch");
  if (value.version !== expected.version) errors.push("build_version_receipt_version_mismatch");
  if (value.updateOrigin !== expected.updateOrigin) errors.push("build_identity_receipt_origin_mismatch");
  if (!record(value.updateTrust) || !exactKeys(value.updateTrust, ["primaryKeyFingerprint", "nextKeyFingerprint"])) errors.push("build_identity_receipt_trust_schema_invalid");
  else {
    if (value.updateTrust.primaryKeyFingerprint !== expected.primaryKeyFingerprint) errors.push("build_identity_receipt_primary_key_mismatch");
    if (value.updateTrust.nextKeyFingerprint !== expected.nextKeyFingerprint) errors.push("build_identity_receipt_next_key_mismatch");
    if (!/^[a-f0-9]{64}$/.test(value.updateTrust.primaryKeyFingerprint ?? "") || !(value.updateTrust.nextKeyFingerprint === null || /^[a-f0-9]{64}$/.test(value.updateTrust.nextKeyFingerprint ?? "")) || value.updateTrust.nextKeyFingerprint === value.updateTrust.primaryKeyFingerprint) errors.push("build_identity_receipt_trust_invalid");
  }
  if (value.artifact !== expected.artifact) errors.push("build_version_receipt_artifact_mismatch");
  if (value.subjectSha256 !== expected.subjectSha256) errors.push("build_version_receipt_subject_mismatch");
  if (!record(value.checks) || !exactKeys(value.checks, ["executableBuildIdentity"]) || value.checks.executableBuildIdentity !== true) errors.push("build_identity_receipt_check_missing");
  return errors;
}

export function validateCompiledBuildIdentity(value, expected) {
  const errors = [];
  if (!record(value) || !exactKeys(value, ["schema", "version", "updateOrigin", "updateTrust"]) || value.schema !== "uptokey-compiled-build-identity-v1") return ["artifact_build_identity_schema_invalid"];
  if (value.version !== expected.version) errors.push("artifact_version_mismatch");
  if (value.updateOrigin !== expected.updateOrigin) errors.push("artifact_update_origin_mismatch");
  if (!record(value.updateTrust) || !exactKeys(value.updateTrust, ["primaryKeyFingerprint", "nextKeyFingerprint"])) errors.push("artifact_update_rotation_partial");
  else {
    if (value.updateTrust.primaryKeyFingerprint !== expected.primaryKeyFingerprint) errors.push("artifact_update_primary_key_mismatch");
    if (value.updateTrust.nextKeyFingerprint !== expected.nextKeyFingerprint) errors.push("artifact_update_next_key_mismatch");
    if (!/^[a-f0-9]{64}$/.test(value.updateTrust.primaryKeyFingerprint ?? "") || !(value.updateTrust.nextKeyFingerprint === null || /^[a-f0-9]{64}$/.test(value.updateTrust.nextKeyFingerprint ?? "")) || value.updateTrust.nextKeyFingerprint === value.updateTrust.primaryKeyFingerprint) errors.push("artifact_update_trust_invalid");
  }
  return errors;
}

export function validReleaseVersion(value) {
  if (typeof value !== "string") return false;
  const match = RELEASE_VERSION.exec(value);
  return Boolean(match && value.length <= 100 && match.slice(1, 4).every((part) => Number.isSafeInteger(Number(part))) && (!match[4] || match[4].split(".").every((part) => !/^\d+$/.test(part) || /^(?:0|[1-9]\d*)$/.test(part))));
}

function validUpdateOrigin(value) { if (typeof value !== "string") throw new Error("artifact_update_origin_expected_invalid"); let parsed; try { parsed = new URL(value); } catch { throw new Error("artifact_update_origin_expected_invalid"); } if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value) throw new Error("artifact_update_origin_expected_invalid"); return value; }

function checkedRegular(input, label) {
  if (typeof input !== "string" || input.length === 0) throw new Error(`artifact_version_${label}_invalid`);
  const requested = resolve(input); const metadata = lstatSync(requested);
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error(`artifact_version_${label}_invalid`);
  return realpathSync(requested);
}

function sha256File(path) {
  const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); } }
  finally { closeSync(handle); }
  return hash.digest("hex");
}

function record(value) { return typeof value === "object" && value !== null && !Array.isArray(value); }
function exactKeys(value, keys) { return Object.keys(value).sort().join(",") === [...keys].sort().join(","); }

function parseArgs(argv) {
  const parsed = { probeArgs: [] };
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index]; const value = argv[index + 1];
    if (!key?.startsWith("--") || value === undefined) throw new Error("artifact_version_arguments_invalid");
    if (key === "--probe-arg") parsed.probeArgs.push(value);
    else {
      const name = key.slice(2);
      if (Object.hasOwn(parsed, name)) throw new Error("artifact_version_arguments_duplicate");
      parsed[name] = value;
    }
  }
  return parsed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.platform || !args.artifact || !args.probe || !args.expected || !args.expectedOrigin || !args.expectedPrimaryPublicKey || !args.out) throw new Error("artifact_version_arguments_invalid");
    const result = createArtifactVersionEvidence({ platform: args.platform, artifactPath: args.artifact, probeCommand: args.probe, probeArgs: args.probeArgs, expectedVersion: args.expected, expectedUpdateOrigin: args.expectedOrigin, expectedPrimaryPublicKeyPath: args.expectedPrimaryPublicKey, expectedNextPublicKeyPath: args.expectedNextPublicKey, outputPath: args.out });
    process.stdout.write(`artifact_version_evidence_valid platform=${result.receipt.platform} version=${result.receipt.version}\n`);
  } catch {
    process.stderr.write("artifact_version_evidence_invalid\n");
    process.exitCode = 1;
  }
}
