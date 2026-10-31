import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const schema = "uptokey-native-signature-evidence-v1";
const scriptsDirectory = dirname(fileURLToPath(import.meta.url));

export function validateNativeReceipt(receipt, platform, subjectSha256) {
  const errors = [];
  if (!receipt || receipt.schema !== schema) errors.push("native_receipt_schema_invalid");
  if (!nativeReceiptShape(receipt, platform)) errors.push("native_receipt_schema_invalid");
  if (receipt?.platform !== platform) errors.push("native_receipt_platform_mismatch");
  if (receipt?.subjectSha256 !== subjectSha256) errors.push("native_receipt_subject_mismatch");
  if (!/^\d{4}-\d{2}-\d{2}T/.test(receipt?.verifiedAt ?? "")) errors.push("native_receipt_timestamp_invalid");
  if (!Array.isArray(receipt?.toolchain) || receipt.toolchain.length === 0 || receipt.toolchain.some((tool) => typeof tool !== "string" || tool.length === 0)) errors.push("native_receipt_toolchain_invalid");
  const checks = receipt?.checks;
  if (!checks || Object.values(checks).some((value) => value !== true)) errors.push("native_receipt_check_failed");
  if (platform === "windows" && (!checks?.authenticode || !checks?.timestamp || !/^[A-F0-9]{40,64}$/.test(receipt?.signer?.thumbprint ?? ""))) errors.push("windows_native_receipt_invalid");
  if (platform === "macos" && (!checks?.codesign || !checks?.hardenedRuntime || !checks?.safeEntitlements || !checks?.applicationBoundKeychain || !checks?.gatekeeper || !checks?.stapled || !/^[A-Z0-9]{10}$/.test(receipt?.signer?.teamId ?? ""))) errors.push("macos_native_receipt_invalid");
  if (platform === "linux" && (!checks?.gpgv || !/^[A-F0-9]{40,64}$/.test(receipt?.signer?.fingerprint ?? ""))) errors.push("linux_native_receipt_invalid");
  return [...new Set(errors)];
}

function nativeReceiptShape(receipt, platform) {
  if (!isRecord(receipt) || !isRecord(receipt.signer) || !isRecord(receipt.checks)) return false;
  if (receipt.schema !== schema || receipt.platform !== platform || !/^[a-f0-9]{64}$/.test(receipt.subjectSha256 ?? "") || typeof receipt.verifiedAt !== "string" || !Number.isFinite(Date.parse(receipt.verifiedAt))) return false;
  const base = ["schema", "platform", "subjectSha256", "verifiedAt", "toolchain", "signer", "checks"];
  if (platform === "windows") {
    if (!exactKeys(receipt, [...base, "timestamp"]) || !isRecord(receipt.timestamp)) return false;
    const service = Object.hasOwn(receipt.signer, "service");
    return JSON.stringify(receipt.toolchain) === JSON.stringify(["Get-AuthenticodeSignature"])
      && exactKeys(receipt.signer, service ? ["subject", "thumbprint", "ekuOids", "service"] : ["subject", "thumbprint", "ekuOids"])
      && exactKeys(receipt.timestamp, ["subject", "thumbprint"])
      && exactKeys(receipt.checks, service ? ["authenticode", "timestamp", "hardwareBackedService"] : ["authenticode", "timestamp"])
      && typeof receipt.signer.subject === "string" && Array.isArray(receipt.signer.ekuOids) && receipt.signer.ekuOids.every((oid) => typeof oid === "string")
      && typeof receipt.timestamp.subject === "string" && /^[A-F0-9]{40,64}$/.test(receipt.timestamp.thumbprint ?? "")
      && (!service || receipt.signer.service === "azure-artifact-signing");
  }
  if (!exactKeys(receipt, base)) return false;
  if (platform === "macos") {
    const archive = Object.hasOwn(receipt.checks, "archivePreflight");
    return JSON.stringify(receipt.toolchain) === JSON.stringify(archive ? ["ditto", "codesign", "spctl", "xcrun stapler"] : ["codesign", "spctl", "xcrun stapler"])
      && exactKeys(receipt.signer, ["teamId", "authority"])
      && exactKeys(receipt.checks, archive ? ["codesign", "hardenedRuntime", "safeEntitlements", "applicationBoundKeychain", "gatekeeper", "stapled", "archivePreflight"] : ["codesign", "hardenedRuntime", "safeEntitlements", "applicationBoundKeychain", "gatekeeper", "stapled"])
      && Array.isArray(receipt.signer.authority) && receipt.signer.authority.length > 0 && receipt.signer.authority.every((item) => typeof item === "string" && item.length > 0);
  }
  return platform === "linux" && JSON.stringify(receipt.toolchain) === JSON.stringify(["gpgv"]) && exactKeys(receipt.signer, ["fingerprint"]) && exactKeys(receipt.checks, ["gpgv"]);
}

function isRecord(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exactKeys(value, expected) { return isRecord(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...expected].sort()); }

export function createNativeReceipt(platform, artifact, options = {}) {
  const artifactPath = realpathSync(artifact);
  const subjectSha256 = sha256Path(artifactPath);
  if (platform === "windows") return windowsReceipt(artifactPath, subjectSha256, options.windowsService);
  if (platform === "macos") return macosReceipt(artifactPath, subjectSha256);
  if (platform === "linux") return linuxReceipt(artifactPath, subjectSha256, options.signature, options.keyring, options.expectedSigner);
  throw new Error("native_platform_invalid");
}

export async function createMacosDistributionReceipt(archive) {
  if (process.platform !== "darwin") throw new Error("macos_archive_verification_requires_macos");
  const requestedPath = resolve(archive); const requestedMetadata = lstatSync(requestedPath);
  if (!requestedMetadata.isFile() || requestedMetadata.isSymbolicLink()) throw new Error("macos_archive_regular_file_required");
  const archivePath = realpathSync(requestedPath);
  const { inspectMacosUpdateArchive } = await import("./macos-update-helper.mjs"); inspectMacosUpdateArchive(archivePath);
  const work = mkdtempSync(resolve(tmpdir(), "uptokey-signature-evidence-"));
  try {
    run("ditto", ["-x", "-k", archivePath, work]);
    const bundle = resolve(work, "Uptokey.app"); if (!statSync(bundle).isDirectory()) throw new Error("macos_archive_bundle_missing"); rejectExtractedTree(bundle);
    const receipt = macosReceipt(bundle, sha256File(archivePath)); receipt.toolchain.unshift("ditto"); receipt.checks.archivePreflight = true; return receipt;
  } finally { rmSync(work, { recursive: true, force: true }); }
}

function windowsReceipt(artifact, subjectSha256, requiredService) {
  if (process.platform !== "win32") throw new Error("windows_verification_requires_windows");
  const output = run("powershell.exe", ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", resolve(scriptsDirectory, "verify-authenticode.ps1"), "-Artifact", artifact]);
  const value = JSON.parse(output);
  if (value.status !== "Valid" || !value.signerThumbprint || !value.timestampThumbprint) throw new Error(`authenticode_not_valid:${value.status ?? "unknown"}`);
  const ekuOids = Array.isArray(value.signerEnhancedKeyUsages) ? value.signerEnhancedKeyUsages : [];
  if (requiredService && requiredService !== "artifact-signing") throw new Error("windows_signing_service_invalid");
  if (requiredService === "artifact-signing" && !ekuOids.includes("1.3.6.1.4.1.311.97.1.0")) throw new Error("artifact_signing_public_trust_eku_missing");
  const receipt = {
    schema, platform: "windows", subjectSha256, verifiedAt: new Date().toISOString(), toolchain: ["Get-AuthenticodeSignature"],
    signer: { subject: value.signerSubject, thumbprint: value.signerThumbprint, ekuOids, ...(requiredService ? { service: "azure-artifact-signing" } : {}) },
    timestamp: { subject: value.timestampSubject, thumbprint: value.timestampThumbprint },
    checks: { authenticode: true, timestamp: true, ...(requiredService ? { hardwareBackedService: true } : {}) },
  };
  assertReceipt(receipt, "windows", subjectSha256); return receipt;
}

function macosReceipt(artifact, subjectSha256) {
  if (process.platform !== "darwin") throw new Error("macos_verification_requires_macos");
  run("codesign", ["--verify", "--deep", "--strict", "--verbose=2", artifact]);
  const details = runCombined("codesign", ["-d", "--verbose=4", artifact]);
  const entitlements = runCombined("codesign", ["-d", "--entitlements", ":-", artifact]);
  if (!/Runtime Version=/.test(details) && !/flags=.*runtime/i.test(details)) throw new Error("macos_hardened_runtime_missing");
  if (/allow-unsigned-executable-memory|disable-library-validation|com\.apple\.security\.get-task-allow/.test(entitlements)) throw new Error("macos_forbidden_entitlement");
  run("spctl", ["--assess", "--type", "execute", "--verbose=4", artifact]);
  run("xcrun", ["stapler", "validate", artifact]);
  const teamId = /TeamIdentifier=([^\r\n]+)/.exec(details)?.[1]?.trim();
  const authority = [...details.matchAll(/^Authority=([^\r\n]+)/gm)].map((match) => match[1]?.trim()).filter(Boolean);
  if (!teamId || authority.length === 0) throw new Error("macos_signer_identity_missing");
  assertMacosKeychainEntitlements(entitlements, teamId);
  const receipt = {
    schema, platform: "macos", subjectSha256, verifiedAt: new Date().toISOString(), toolchain: ["codesign", "spctl", "xcrun stapler"],
    signer: { teamId, authority }, checks: { codesign: true, hardenedRuntime: true, safeEntitlements: true, applicationBoundKeychain: true, gatekeeper: true, stapled: true },
  };
  assertReceipt(receipt, "macos", subjectSha256); return receipt;
}

export function assertMacosKeychainEntitlements(entitlements, teamId) {
  const expected = `${teamId}.com.uptokey.proxy`;
  // macOS uses the Apple-prefixed entitlement. A legacy alias cannot substitute
  // for it or disagree with it; both retain the existing app/group identity.
  const applications = [...entitlements.matchAll(/<key>com\.apple\.application-identifier<\/key>\s*<string>([^<]+)<\/string>/g)];
  const aliases = [...entitlements.matchAll(/<key>application-identifier<\/key>\s*<string>([^<]+)<\/string>/g)];
  const group = /<key>keychain-access-groups<\/key>\s*<array>\s*<string>([^<]+)<\/string>\s*<\/array>/.exec(entitlements)?.[1];
  if (!/^[A-Z0-9]{10}$/.test(teamId) || applications.length !== 1 || applications[0][1] !== expected
      || (entitlements.match(/<key>com\.apple\.application-identifier<\/key>/g) ?? []).length !== 1
      || aliases.length > 1 || aliases.some(match => match[1] !== expected)
      || (entitlements.match(/<key>application-identifier<\/key>/g) ?? []).length !== aliases.length
      || (entitlements.match(/<key>keychain-access-groups<\/key>/g) ?? []).length !== 1 || group !== expected) {
    throw new Error("macos_application_bound_keychain_entitlement_missing");
  }
}

function linuxReceipt(artifact, subjectSha256, signature, keyring, expectedSigner) {
  if (process.platform !== "linux") throw new Error("linux_verification_requires_linux");
  if (!signature || !keyring) throw new Error("linux_signature_and_keyring_required");
  const output = run("gpgv", ["--status-fd", "1", "--keyring", realpathSync(keyring), realpathSync(signature), artifact]);
  const fingerprint = /^\[GNUPG:\] VALIDSIG ([A-F0-9]{40,64}) /m.exec(output)?.[1];
  if (!fingerprint) throw new Error("gpg_validsig_missing");
  if (expectedSigner !== undefined) assertLinuxSignerFingerprint(fingerprint, expectedSigner);
  const receipt = {
    schema, platform: "linux", subjectSha256, verifiedAt: new Date().toISOString(), toolchain: ["gpgv"],
    signer: { fingerprint }, checks: { gpgv: true },
  };
  assertReceipt(receipt, "linux", subjectSha256); return receipt;
}

export function assertLinuxSignerFingerprint(observed, expected) {
  if (!/^(?:[A-F0-9]{40}|[A-F0-9]{64})$/.test(expected ?? "") || observed !== expected) throw new Error("linux_signer_fingerprint_mismatch");
}

function assertReceipt(receipt, platform, subjectSha256) {
  const errors = validateNativeReceipt(receipt, platform, subjectSha256);
  if (errors.length) throw new Error(errors.join(","));
}

function run(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command}_failed:${sanitize(result.stderr || result.stdout)}`);
  return result.stdout.trim();
}

function runCombined(command, args) {
  const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true });
  if (result.status !== 0) throw new Error(`${command}_failed:${sanitize(result.stderr || result.stdout)}`);
  return `${result.stdout}\n${result.stderr}`;
}

function sanitize(value) { return String(value).replace(/[\r\n]+/g, " ").slice(0, 300); }
export function sha256Path(path) {
  const root = realpathSync(path); const metadata = statSync(root);
  if (metadata.isFile()) return sha256File(root);
  if (!metadata.isDirectory()) throw new Error("signature_subject_not_file_or_directory");
  const hash = createHash("sha256");
  for (const file of walk(root)) {
    const name = relative(root, file).replaceAll("\\", "/");
    hash.update(name); hash.update("\0"); hash.update(Buffer.from(sha256File(file), "hex"));
  }
  return hash.digest("hex");
}

function sha256File(path) {
  const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); } }
  finally { closeSync(handle); }
  return hash.digest("hex");
}

function walk(directory) {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name); const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("signature_subject_symlink_forbidden");
    if (metadata.isDirectory()) files.push(...walk(path)); else if (metadata.isFile()) files.push(path); else throw new Error("signature_subject_special_file_forbidden");
  }
  return files;
}

function rejectExtractedTree(directory) {
  for (const name of readdirSync(directory)) {
    const path = resolve(directory, name); const metadata = lstatSync(path);
    if (metadata.isSymbolicLink()) throw new Error("macos_archive_symlink_forbidden");
    if (metadata.isDirectory()) rejectExtractedTree(path); else if (!metadata.isFile()) throw new Error("macos_archive_special_file_forbidden");
  }
}
