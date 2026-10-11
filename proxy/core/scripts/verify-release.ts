import { createHash } from "node:crypto";
import { closeSync, existsSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import process from "node:process";
import { validateNativeReceipt } from "./native-signature-evidence.mjs";
import { validateUpdateSignatureReceipt, verifyUpdateSignatureContent } from "./update-signature-evidence.mjs";
import { validateProvenanceReceipt } from "./provenance-evidence.mjs";
import { validReleaseVersion, validateArtifactVersionReceipt } from "./artifact-version-evidence.mjs";
import { parseUpdateManifest } from "../src/update-manifest.ts";
import { validateAptRepositoryReceipt } from "./linux-apt-repository-evidence.mjs";

interface EvidenceFile { path?: string; sha256?: string; subjectSha256?: string }
interface PlatformSignature { verified?: boolean; signerId?: string; hardenedRuntime?: boolean; notarized?: boolean; stapled?: boolean; hardwareBacked?: boolean; evidence?: EvidenceFile }
interface WindowsUpdateHelper {
  path?: string; sha256?: string;
  platformSignature?: PlatformSignature;
  sbom?: EvidenceFile & { format?: string };
  provenance?: EvidenceFile;
}
interface LinuxAptRepository {
  path?: string; sha256?: string; signerId?: string;
  publicKey?: FileEvidence;
  evidence?: EvidenceFile;
  provenance?: EvidenceFile;
}
interface ReleaseArtifact {
  platform: string; path: string; sha256: string;
  buildVersion?: EvidenceFile & { version?: string };
  platformSignature?: PlatformSignature;
  windowsUpdateHelper?: WindowsUpdateHelper;
  linuxAptRepository?: LinuxAptRepository;
}
interface ReleaseManifest {
  version?: string; commit?: string; buildIdentity?: { updateOrigin?: string; primaryKeyFingerprint?: string; nextKeyFingerprint?: string | null }; artifacts?: ReleaseArtifact[]; checksums?: { path?: string };
  license?: FileEvidence;
  updateManifest?: EvidenceFile;
  sbom?: Array<EvidenceFile & { format?: string }>;
  updateSignature?: EvidenceFile & { verified?: boolean; signerId?: string; signature?: FileEvidence; publicKey?: FileEvidence };
  provenance?: EvidenceFile[];
}
interface FileEvidence { path?: string; sha256?: string }

const RELEASE_MANIFEST_MAX_BYTES = 1024 * 1024;
const RECEIPT_MAX_BYTES = 64 * 1024;
const CHECKSUMS_MAX_BYTES = 4 * 1024;
const UPDATE_MANIFEST_MAX_BYTES = 1024 * 1024;
const SBOM_MAX_BYTES = 32 * 1024 * 1024;
const PROVENANCE_RECEIPT_MAX_BYTES = 256 * 1024;
const LICENSE_MAX_BYTES = 64 * 1024;
const AGPL_LICENSE_SHA256 = "0d96a4ff68ad6d4b6f1f30f713b18d5184912ba8dd389f86aa7710db079abcb0";

export function verifyRelease(manifestPath: string, expectedRepository: string, expectedCommit?: string, expectedVersion?: string): string[] {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(expectedRepository)) throw new Error("release_repository_invalid");
  const absoluteManifest = resolve(manifestPath);
  const root = realpathSync(dirname(absoluteManifest));
  const manifest = readReleaseManifest(absoluteManifest);
  const errors: string[] = [];
  const knownPlatforms = new Set(["macos", "windows", "linux"]);
  const artifactDigests: string[] = [];
  const companionDigests: string[] = [];
  const artifactSizes = new Map<string, number>();
  const artifactPlatformByDigest = new Map<string, string>();
  const observedBuildIdentities: string[] = [];

  if (!validReleaseVersion(manifest.version)) errors.push("version_tag_invalid");
  if (!/^[a-f0-9]{40}$/.test(manifest.commit ?? "")) errors.push("commit_sha_invalid");
  if (!validBuildIdentity(manifest.buildIdentity)) errors.push("release_build_identity_invalid");
  if (expectedCommit !== undefined && (!/^[a-f0-9]{40}$/.test(expectedCommit) || manifest.commit !== expectedCommit)) errors.push("release_commit_external_mismatch");
  if (expectedVersion !== undefined && (!validReleaseVersion(expectedVersion) || manifest.version !== expectedVersion)) errors.push("release_version_external_mismatch");
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length < 1) errors.push("at_least_one_platform_artifact_required");
  if (Array.isArray(manifest.artifacts) && new Set(manifest.artifacts.map((artifact) => artifact.platform)).size !== manifest.artifacts.length) errors.push("artifact_platforms_duplicate");

  const licensePath = verifyFileEvidence(root, manifest.license, "license", errors);
  if (licensePath) {
    const licenseBytes = readBoundedUtf8(licensePath, LICENSE_MAX_BYTES, "license");
    if (manifest.license?.path !== "LICENSE" || sha256(licensePath) !== AGPL_LICENSE_SHA256 || !licenseBytes.startsWith("                    GNU AFFERO GENERAL PUBLIC LICENSE\n")) errors.push("canonical_agpl_license_required");
  }

  const checksumsPath = checkedFile(root, manifest.checksums?.path, "checksums", errors);
  const checksumEntries = checksumsPath ? parseChecksums(readBoundedUtf8(checksumsPath, CHECKSUMS_MAX_BYTES, "checksums"), errors) : new Map<string, string>();
  for (const artifact of manifest.artifacts ?? []) {
    if (!knownPlatforms.has(artifact.platform)) errors.push(`artifact_platform_invalid_${artifact.platform}`);
    const signature = artifact.platformSignature;
    const artifactPath = checkedFile(root, artifact.path, `artifact_${artifact.platform}`, errors);
    if (!artifactPath) continue;
    const digest = sha256(artifactPath);
    artifactDigests.push(digest);
    artifactPlatformByDigest.set(digest, artifact.platform);
    artifactSizes.set(artifact.platform, statSync(artifactPath).size);
    if (artifact.sha256 !== digest) errors.push(`artifact_${artifact.platform}_digest_mismatch`);
    if (checksumEntries.get(normalizedRelativePath(artifact.path)) !== digest) errors.push(`artifact_${artifact.platform}_missing_checksum`);
    const buildVersionPath = verifyEvidence(root, artifact.buildVersion, digest, `artifact_${artifact.platform}_build_version_evidence`, errors);
    if (artifact.buildVersion?.version !== manifest.version) errors.push(`artifact_${artifact.platform}_build_version_manifest_mismatch`);
    if (buildVersionPath) {
      try {
        const receipt = JSON.parse(readBoundedUtf8(buildVersionPath, RECEIPT_MAX_BYTES, "build_version_receipt"));
        for (const error of validateArtifactVersionReceipt(receipt, { platform: artifact.platform, version: manifest.version ?? "", updateOrigin: manifest.buildIdentity?.updateOrigin ?? "", primaryKeyFingerprint: manifest.buildIdentity?.primaryKeyFingerprint ?? "", nextKeyFingerprint: manifest.buildIdentity?.nextKeyFingerprint ?? null, artifact: artifact.path, subjectSha256: digest })) errors.push(`artifact_${artifact.platform}_${error}`);
        if (isRecord(receipt) && isRecord(receipt.updateTrust)) observedBuildIdentities.push(JSON.stringify([receipt.version, receipt.updateOrigin, receipt.updateTrust.primaryKeyFingerprint, receipt.updateTrust.nextKeyFingerprint]));
      } catch { errors.push(`artifact_${artifact.platform}_build_version_receipt_json_invalid`); }
    }
    if (signature?.verified !== true || !signature.signerId) errors.push(`artifact_${artifact.platform}_platform_signature_unverified`);
    const nativeEvidencePath = verifyEvidence(root, signature?.evidence, digest, `artifact_${artifact.platform}_signature_evidence`, errors);
    if (nativeEvidencePath) {
      try {
        const receipt = JSON.parse(readBoundedUtf8(nativeEvidencePath, RECEIPT_MAX_BYTES, "native_receipt"));
        for (const error of validateNativeReceipt(receipt, artifact.platform, digest)) errors.push(`artifact_${artifact.platform}_${error}`);
        if (artifact.platform === "macos" && receipt?.checks?.archivePreflight !== true) errors.push("artifact_macos_archive_preflight_missing");
        const observedSignerId = artifact.platform === "macos" ? receipt?.signer?.teamId : artifact.platform === "windows" ? receipt?.signer?.thumbprint : receipt?.signer?.fingerprint;
        if (signature?.signerId !== observedSignerId) errors.push(`artifact_${artifact.platform}_signer_id_mismatch`);
        if (artifact.platform === "windows" && signature?.hardwareBacked === true && (receipt?.checks?.hardwareBackedService !== true || receipt?.signer?.service !== "azure-artifact-signing")) {
          errors.push("windows_hardware_backed_evidence_missing");
        }
      } catch { errors.push(`artifact_${artifact.platform}_native_receipt_json_invalid`); }
    }
    if (artifact.platform === "macos") {
      if (signature?.hardenedRuntime !== true) errors.push("macos_hardened_runtime_missing");
      if (signature?.notarized !== true) errors.push("macos_notarization_missing");
      if (signature?.stapled !== true) errors.push("macos_stapling_missing");
    }
    if (artifact.platform === "windows" && signature?.hardwareBacked !== true) errors.push("windows_hardware_backed_signature_missing");
    verifyWindowsUpdateHelper(root, artifact, digest, manifest, expectedRepository, checksumEntries, companionDigests, errors);
    verifyLinuxAptRepository(root, artifact, digest, manifest, expectedRepository, checksumEntries, companionDigests, errors);
  }
  if (new Set(observedBuildIdentities).size > 1) errors.push("artifact_build_identities_mismatch");
  if (checksumEntries.size !== artifactDigests.length + companionDigests.length) errors.push("checksums_must_contain_only_artifacts_and_companions");

  const sbomSubjects: string[] = [];
  if (!Array.isArray(manifest.sbom) || manifest.sbom.length !== (manifest.artifacts ?? []).length) errors.push("sbom_count_must_match_artifacts");
  for (const [index, evidence] of (manifest.sbom ?? []).entries()) {
    const label = `sbom_${index}`;
    const sbomPath = checkedFile(root, evidence.path, label, errors);
    if (!sbomPath) continue;
    if (evidence.sha256 !== sha256(sbomPath)) errors.push(`${label}_digest_mismatch`);
    if (evidence.format !== "spdx-json") errors.push(`${label}_format_invalid`);
    if (!validSpdx(readBoundedUtf8(sbomPath, SBOM_MAX_BYTES, "sbom"))) errors.push(`${label}_spdx_invalid_or_empty`);
    if (!/^[a-f0-9]{64}$/.test(evidence.subjectSha256 ?? "")) errors.push(`${label}_subject_invalid`); else sbomSubjects.push(evidence.subjectSha256!);
  }
  if (new Set(sbomSubjects).size !== sbomSubjects.length || JSON.stringify([...sbomSubjects].sort()) !== JSON.stringify([...artifactDigests].sort())) errors.push("sbom_subjects_mismatch");

  const checksumsDigest = checksumsPath ? sha256(checksumsPath) : "";
  const updateManifestPath = checkedFile(root, manifest.updateManifest?.path, "update_manifest", errors);
  const updateManifestDigest = updateManifestPath ? sha256(updateManifestPath) : "";
  if (updateManifestPath && manifest.updateManifest?.sha256 !== updateManifestDigest) errors.push("update_manifest_digest_mismatch");
  let updateManifestText = "";
  if (updateManifestPath) {
    try {
      updateManifestText = readBoundedUtf8(updateManifestPath, UPDATE_MANIFEST_MAX_BYTES, "update_manifest");
      const update = parseUpdateManifest(Buffer.from(updateManifestText));
      if (update.version !== manifest.version) errors.push("update_manifest_release_version_mismatch");
      if (update.checksumsSha256 !== checksumsDigest) errors.push("update_manifest_checksums_mismatch");
      const updateOrigins = new Set(update.artifacts.map((artifact) => new URL(artifact.url).origin));
      if (updateOrigins.size !== 1 || !updateOrigins.has(manifest.buildIdentity?.updateOrigin ?? "")) errors.push("update_manifest_build_origin_mismatch");
      const expectedArtifacts = (manifest.artifacts ?? []).map((artifact) => ({ platform: artifact.platform, path: artifact.path, sha256: artifact.sha256, size: artifactSizes.get(artifact.platform) ?? -1 })).sort((a, b) => a.platform.localeCompare(b.platform));
      const actualArtifacts = update.artifacts.map(({ platform, path, sha256, size }) => ({ platform, path, sha256, size })).sort((a, b) => a.platform.localeCompare(b.platform));
      if (JSON.stringify(actualArtifacts) !== JSON.stringify(expectedArtifacts)) errors.push("update_manifest_artifacts_mismatch");
    } catch { errors.push("update_manifest_invalid"); }
  }
  const updateEvidencePath = verifyEvidence(root, manifest.updateSignature, updateManifestDigest, "update_signature_evidence", errors);
  if (updateEvidencePath) {
    try {
      const receipt = JSON.parse(readBoundedUtf8(updateEvidencePath, RECEIPT_MAX_BYTES, "update_receipt"));
      for (const error of validateUpdateSignatureReceipt(receipt, updateManifestDigest, manifest.updateSignature?.signerId)) errors.push(error);
    } catch { errors.push("update_signature_receipt_json_invalid"); }
  }
  const rawSignaturePath = verifyFileEvidence(root, manifest.updateSignature?.signature, "update_signature_raw", errors);
  const publicKeyPath = verifyFileEvidence(root, manifest.updateSignature?.publicKey, "update_public_key", errors);
  if (updateManifestText && rawSignaturePath && publicKeyPath) {
    try {
      const observed = verifyUpdateSignatureContent(Buffer.from(updateManifestText), readBoundedUtf8(rawSignaturePath, 1024, "update_signature_raw").trim(), Buffer.from(readBoundedUtf8(publicKeyPath, 8 * 1024, "update_public_key")));
      if (observed.subjectSha256 !== updateManifestDigest || observed.keyFingerprint !== manifest.updateSignature?.signerId) errors.push("update_signature_cryptographic_binding_mismatch");
    } catch { errors.push("update_signature_cryptographic_invalid"); }
  }
  if (manifest.updateSignature?.verified !== true) errors.push("update_signature_unverified");
  if (manifest.updateSignature?.signerId !== manifest.buildIdentity?.primaryKeyFingerprint) errors.push("update_signer_build_primary_key_mismatch");
  const platformSignerIds = new Set((manifest.artifacts ?? []).map((item) => item.platformSignature?.signerId).filter(Boolean));
  if (!manifest.updateSignature?.signerId || platformSignerIds.has(manifest.updateSignature.signerId)) errors.push("update_signer_must_be_distinct");

  const provenanceSubjects: string[] = [];
  if (!Array.isArray(manifest.provenance) || manifest.provenance.length !== (manifest.artifacts ?? []).length) errors.push("provenance_count_must_match_artifacts");
  for (const [index, evidence] of (manifest.provenance ?? []).entries()) {
    const label = `provenance_${index}`;
    const provenancePath = checkedFile(root, evidence?.path, label, errors);
    if (!provenancePath) continue;
    if (evidence?.sha256 !== sha256(provenancePath)) errors.push(`${label}_digest_mismatch`);
    if (!/^[a-f0-9]{64}$/.test(evidence?.subjectSha256 ?? "")) { errors.push(`${label}_subject_invalid`); continue; }
    provenanceSubjects.push(evidence.subjectSha256!);
    try {
      const receipt = JSON.parse(readBoundedUtf8(provenancePath, PROVENANCE_RECEIPT_MAX_BYTES, "provenance_receipt"));
      const platform = artifactPlatformByDigest.get(evidence.subjectSha256!);
      const signerWorkflow = platform ? `${expectedRepository}/.github/workflows/${platformSignerWorkflow(platform)}` : "";
      for (const error of validateProvenanceReceipt(receipt, [evidence.subjectSha256!], manifest.commit ?? "", expectedRepository, signerWorkflow)) errors.push(`${label}_${error}`);
    } catch { errors.push(`${label}_receipt_json_invalid`); }
  }
  if (new Set(provenanceSubjects).size !== provenanceSubjects.length || JSON.stringify([...provenanceSubjects].sort()) !== JSON.stringify([...artifactDigests].sort())) errors.push("provenance_subjects_mismatch");

  return [...new Set(errors)];
}

function verifyLinuxAptRepository(root: string, artifact: ReleaseArtifact, packageDigest: string, manifest: ReleaseManifest, expectedRepository: string, checksumEntries: Map<string, string>, companionDigests: string[], errors: string[]): void {
  const repository = artifact.linuxAptRepository;
  if (artifact.platform !== "linux") {
    if (repository !== undefined) errors.push(`artifact_${artifact.platform}_linux_apt_repository_forbidden`);
    return;
  }
  if (!repository) { errors.push("linux_apt_repository_required"); return; }
  if (artifact.path !== "uptokey-linux-amd64.deb") errors.push("linux_deb_artifact_path_invalid");
  if (repository.path !== "uptokey-apt-repository.tar.gz") errors.push("linux_apt_repository_path_invalid");
  if (repository.signerId !== artifact.platformSignature?.signerId) errors.push("linux_apt_repository_signer_must_match_deb");
  const archivePath = checkedFile(root, repository.path, "linux_apt_repository", errors);
  if (!archivePath) return;
  const archiveDigest = sha256(archivePath); companionDigests.push(archiveDigest);
  if (repository.sha256 !== archiveDigest) errors.push("linux_apt_repository_digest_mismatch");
  if (checksumEntries.get(repository.path!) !== archiveDigest) errors.push("linux_apt_repository_missing_checksum");
  const publicKeyPath = verifyFileEvidence(root, repository.publicKey, "linux_apt_repository_public_key", errors);
  if (repository.publicKey?.path !== "linux-public.gpg") errors.push("linux_apt_repository_public_key_path_invalid");
  if (publicKeyPath && statSync(publicKeyPath).size > 64 * 1024) errors.push("linux_apt_repository_public_key_size_invalid");
  const receiptPath = verifyEvidence(root, repository.evidence, archiveDigest, "linux_apt_repository_evidence", errors);
  if (repository.evidence?.path !== "linux-apt-repository.json") errors.push("linux_apt_repository_evidence_path_invalid");
  if (receiptPath) {
    try {
      const receipt = JSON.parse(readBoundedUtf8(receiptPath, PROVENANCE_RECEIPT_MAX_BYTES, "linux_apt_repository_receipt"));
      const version = (manifest.version ?? "").replace(/^v/, "");
      const repositoryFiles = ["dists/stable/InRelease", "dists/stable/Release", "dists/stable/Release.gpg", "dists/stable/main/binary-amd64/Packages", "dists/stable/main/binary-amd64/Packages.gz", `pool/main/u/uptokey/uptokey_${version}_amd64.deb`, "uptokey-archive-keyring.gpg"].sort();
      for (const error of validateAptRepositoryReceipt(receipt, { subjectSha256: archiveDigest, packageSha256: packageDigest, publicKeySha256: repository.publicKey?.sha256 ?? "", version, signerFingerprint: repository.signerId ?? "", repositoryFiles })) errors.push(error);
    } catch { errors.push("linux_apt_repository_receipt_json_invalid"); }
  }
  if (repository.provenance?.path !== "linux-apt.provenance.json") errors.push("linux_apt_repository_provenance_path_invalid");
  const provenancePath = verifyEvidence(root, repository.provenance, archiveDigest, "linux_apt_repository_provenance", errors);
  if (provenancePath) {
    try {
      const receipt = JSON.parse(readBoundedUtf8(provenancePath, PROVENANCE_RECEIPT_MAX_BYTES, "linux_apt_repository_provenance_receipt"));
      const workflow = `${expectedRepository}/.github/workflows/linux-deb-apt-acceptance.yml`;
      for (const error of validateProvenanceReceipt(receipt, [archiveDigest], manifest.commit ?? "", expectedRepository, workflow)) errors.push(`linux_apt_repository_${error}`);
    } catch { errors.push("linux_apt_repository_provenance_receipt_json_invalid"); }
  }
}

function verifyWindowsUpdateHelper(root: string, artifact: ReleaseArtifact, mainDigest: string, manifest: ReleaseManifest, expectedRepository: string, checksumEntries: Map<string, string>, companionDigests: string[], errors: string[]): void {
  const helper = artifact.windowsUpdateHelper;
  if (artifact.platform !== "windows") {
    if (helper !== undefined) errors.push(`artifact_${artifact.platform}_windows_update_helper_forbidden`);
    return;
  }
  if (!helper) { errors.push("windows_update_helper_required"); return; }
  if (helper.path !== "uptokey-update-helper.exe") errors.push("windows_update_helper_path_invalid");
  const helperPath = checkedFile(root, helper.path, "windows_update_helper", errors);
  if (!helperPath) return;
  if (statSync(helperPath).size === 0) errors.push("windows_update_helper_empty");
  const helperDigest = sha256(helperPath);
  companionDigests.push(helperDigest);
  if (helper.sha256 !== helperDigest) errors.push("windows_update_helper_digest_mismatch");
  if (checksumEntries.get(helper.path!) !== helperDigest) errors.push("windows_update_helper_missing_checksum");
  if (helperDigest === mainDigest) errors.push("windows_update_helper_must_be_distinct");

  const signature = helper.platformSignature;
  if (signature?.verified !== true || !signature.signerId) errors.push("windows_update_helper_platform_signature_unverified");
  if (signature?.hardwareBacked !== true) errors.push("windows_update_helper_hardware_backed_signature_missing");
  if (signature?.signerId !== artifact.platformSignature?.signerId) errors.push("windows_update_helper_signer_must_match_daemon");
  if (signature?.evidence?.path !== "windows-helper.signature.json") errors.push("windows_update_helper_signature_evidence_path_invalid");
  const signatureEvidencePath = verifyEvidence(root, signature?.evidence, helperDigest, "windows_update_helper_signature_evidence", errors);
  if (signatureEvidencePath) {
    try {
      const receipt = JSON.parse(readBoundedUtf8(signatureEvidencePath, RECEIPT_MAX_BYTES, "windows_helper_native_receipt"));
      for (const error of validateNativeReceipt(receipt, "windows", helperDigest)) errors.push(`windows_update_helper_${error}`);
      if (signature?.signerId !== receipt?.signer?.thumbprint) errors.push("windows_update_helper_signer_id_mismatch");
      if (receipt?.checks?.hardwareBackedService !== true || receipt?.signer?.service !== "azure-artifact-signing") errors.push("windows_update_helper_hardware_backed_evidence_missing");
    } catch { errors.push("windows_update_helper_native_receipt_json_invalid"); }
  }

  if (helper.sbom?.path !== "uptokey-update-helper.exe.spdx.json") errors.push("windows_update_helper_sbom_path_invalid");
  const sbomPath = verifyEvidence(root, helper.sbom, helperDigest, "windows_update_helper_sbom", errors);
  if (helper.sbom?.format !== "spdx-json") errors.push("windows_update_helper_sbom_format_invalid");
  if (sbomPath && !validSpdx(readBoundedUtf8(sbomPath, SBOM_MAX_BYTES, "windows_helper_sbom"))) errors.push("windows_update_helper_sbom_spdx_invalid_or_empty");

  if (helper.provenance?.path !== "windows-helper.provenance.json") errors.push("windows_update_helper_provenance_path_invalid");
  const provenancePath = verifyEvidence(root, helper.provenance, helperDigest, "windows_update_helper_provenance", errors);
  if (provenancePath) {
    try {
      const receipt = JSON.parse(readBoundedUtf8(provenancePath, PROVENANCE_RECEIPT_MAX_BYTES, "windows_helper_provenance_receipt"));
      const workflow = `${expectedRepository}/.github/workflows/windows-signed-acceptance.yml`;
      for (const error of validateProvenanceReceipt(receipt, [helperDigest], manifest.commit ?? "", expectedRepository, workflow)) errors.push(`windows_update_helper_${error}`);
    } catch { errors.push("windows_update_helper_provenance_receipt_json_invalid"); }
  }
}

function readReleaseManifest(path: string): ReleaseManifest {
  const metadata = lstatSync(path);
  if (metadata.isSymbolicLink() || !metadata.isFile()) throw new Error("release_manifest_regular_file_required");
  const text = readBoundedUtf8(path, RELEASE_MANIFEST_MAX_BYTES, "release_manifest");
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error("release_manifest_json_invalid"); }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("release_manifest_shape_invalid");
  assertReleaseManifestSchema(value);
  return value as ReleaseManifest;
}

function assertReleaseManifestSchema(value: unknown): asserts value is ReleaseManifest {
  if (!isRecord(value) || !exactKeys(value, ["version", "commit", "buildIdentity", "artifacts", "checksums", "license", "updateManifest", "sbom", "updateSignature", "provenance"])) throw new Error("release_manifest_schema_invalid");
  if (typeof value.version !== "string" || typeof value.commit !== "string" || !Array.isArray(value.artifacts) || !Array.isArray(value.provenance)) throw new Error("release_manifest_schema_invalid");
  if (!exactRecord(value.buildIdentity, ["updateOrigin", "primaryKeyFingerprint", "nextKeyFingerprint"]) || !strings(value.buildIdentity, ["updateOrigin", "primaryKeyFingerprint"]) || !(value.buildIdentity.nextKeyFingerprint === null || typeof value.buildIdentity.nextKeyFingerprint === "string")) throw new Error("release_manifest_schema_invalid");
  if (!exactRecord(value.checksums, ["path"]) || typeof value.checksums.path !== "string") throw new Error("release_manifest_schema_invalid");
  if (!fileEvidenceShape(value.license)) throw new Error("release_manifest_schema_invalid");
  if (!exactRecord(value.updateManifest, ["path", "sha256"]) || !strings(value.updateManifest, ["path", "sha256"])) throw new Error("release_manifest_schema_invalid");
  if (!Array.isArray(value.sbom) || value.sbom.some((sbom) => !exactRecord(sbom, ["path", "sha256", "subjectSha256", "format"]) || !strings(sbom, ["path", "sha256", "subjectSha256", "format"]))) throw new Error("release_manifest_schema_invalid");
  if (!exactRecord(value.updateSignature, ["path", "sha256", "subjectSha256", "verified", "signerId", "signature", "publicKey"]) || !strings(value.updateSignature, ["path", "sha256", "subjectSha256", "signerId"]) || typeof value.updateSignature.verified !== "boolean" || !fileEvidenceShape(value.updateSignature.signature) || !fileEvidenceShape(value.updateSignature.publicKey)) throw new Error("release_manifest_schema_invalid");
  for (const artifact of value.artifacts) {
    if (!isRecord(artifact) || !onlyKeys(artifact, ["platform", "path", "sha256", "buildVersion", "platformSignature", "windowsUpdateHelper", "linuxAptRepository"]) || !requiredKeys(artifact, ["platform", "path", "sha256", "buildVersion", "platformSignature"]) || !strings(artifact, ["platform", "path", "sha256"])) throw new Error("release_manifest_schema_invalid");
    if (!exactRecord(artifact.buildVersion, ["path", "sha256", "subjectSha256", "version"]) || !strings(artifact.buildVersion, ["path", "sha256", "subjectSha256", "version"])) throw new Error("release_manifest_schema_invalid");
    const signature = artifact.platformSignature;
    if (!isRecord(signature) || !onlyKeys(signature, ["verified", "signerId", "hardenedRuntime", "notarized", "stapled", "hardwareBacked", "evidence"]) || !requiredKeys(signature, ["verified", "signerId", "evidence"]) || typeof signature.verified !== "boolean" || typeof signature.signerId !== "string") throw new Error("release_manifest_schema_invalid");
    for (const key of ["hardenedRuntime", "notarized", "stapled", "hardwareBacked"]) if (key in signature && typeof signature[key] !== "boolean") throw new Error("release_manifest_schema_invalid");
    if (!evidenceShape(signature.evidence)) throw new Error("release_manifest_schema_invalid");
    if ("windowsUpdateHelper" in artifact && !windowsUpdateHelperShape(artifact.windowsUpdateHelper)) throw new Error("release_manifest_schema_invalid");
    if ("linuxAptRepository" in artifact && !linuxAptRepositoryShape(artifact.linuxAptRepository)) throw new Error("release_manifest_schema_invalid");
  }
  if (value.provenance.some((evidence) => !evidenceShape(evidence))) throw new Error("release_manifest_schema_invalid");
}

function evidenceShape(value: unknown): boolean {
  return exactRecord(value, ["path", "sha256", "subjectSha256"]) && strings(value, ["path", "sha256", "subjectSha256"]);
}
function windowsUpdateHelperShape(value: unknown): boolean {
  if (!exactRecord(value, ["path", "sha256", "platformSignature", "sbom", "provenance"]) || !strings(value, ["path", "sha256"])) return false;
  const signature = value.platformSignature;
  if (!exactRecord(signature, ["verified", "signerId", "hardwareBacked", "evidence"]) || typeof signature.verified !== "boolean" || typeof signature.signerId !== "string" || typeof signature.hardwareBacked !== "boolean" || !evidenceShape(signature.evidence)) return false;
  return exactRecord(value.sbom, ["path", "sha256", "subjectSha256", "format"]) && strings(value.sbom, ["path", "sha256", "subjectSha256", "format"]) && evidenceShape(value.provenance);
}
function linuxAptRepositoryShape(value: unknown): boolean {
  return exactRecord(value, ["path", "sha256", "signerId", "publicKey", "evidence", "provenance"])
    && strings(value, ["path", "sha256", "signerId"])
    && fileEvidenceShape(value.publicKey) && evidenceShape(value.evidence) && evidenceShape(value.provenance);
}
function fileEvidenceShape(value: unknown): boolean { return exactRecord(value, ["path", "sha256"]) && strings(value, ["path", "sha256"]); }
function validBuildIdentity(value: ReleaseManifest["buildIdentity"]): boolean {
  if (!value || !/^[a-f0-9]{64}$/.test(value.primaryKeyFingerprint ?? "") || !(value.nextKeyFingerprint === null || /^[a-f0-9]{64}$/.test(value.nextKeyFingerprint ?? "")) || value.nextKeyFingerprint === value.primaryKeyFingerprint) return false;
  try { const origin = new URL(value.updateOrigin ?? ""); return origin.protocol === "https:" && !origin.username && !origin.password && origin.pathname === "/" && !origin.search && !origin.hash && origin.origin === value.updateOrigin; } catch { return false; }
}

function isRecord(value: unknown): value is Record<string, unknown> { return Boolean(value) && typeof value === "object" && !Array.isArray(value); }
function onlyKeys(value: Record<string, unknown>, allowed: string[]): boolean { return Object.keys(value).every((key) => allowed.includes(key)); }
function requiredKeys(value: Record<string, unknown>, required: string[]): boolean { return required.every((key) => Object.hasOwn(value, key)); }
function exactKeys(value: Record<string, unknown>, keys: string[]): boolean { return onlyKeys(value, keys) && requiredKeys(value, keys); }
function exactRecord(value: unknown, keys: string[]): value is Record<string, unknown> { return isRecord(value) && exactKeys(value, keys); }
function strings(value: Record<string, unknown>, keys: string[]): boolean { return keys.every((key) => typeof value[key] === "string"); }

function readBoundedUtf8(path: string, maximum: number, label: string): string {
  const handle = openSync(path, "r");
  const chunks: Buffer[] = [];
  const buffer = Buffer.allocUnsafe(Math.min(64 * 1024, maximum + 1));
  let total = 0;
  try {
    const metadata = fstatSync(handle);
    if (!metadata.isFile()) throw new Error(`${label}_regular_file_required`);
    if (metadata.size === 0 || metadata.size > maximum) throw new Error(`${label}_size_invalid`);
    for (;;) {
      const count = readSync(handle, buffer, 0, buffer.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximum) throw new Error(`${label}_size_invalid`);
      chunks.push(Buffer.from(buffer.subarray(0, count)));
    }
  } finally { closeSync(handle); }
  if (total === 0) throw new Error(`${label}_size_invalid`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, total)); }
  catch { throw new Error(`${label}_utf8_invalid`); }
}

function verifyEvidence(root: string, evidence: EvidenceFile | undefined, subjectSha256: string, label: string, errors: string[]): string | null {
  const path = checkedFile(root, evidence?.path, label, errors);
  if (!path) return null;
  if (statSync(path).size === 0) errors.push(`${label}_empty`);
  if (evidence?.sha256 !== sha256(path)) errors.push(`${label}_digest_mismatch`);
  if (!subjectSha256 || evidence?.subjectSha256 !== subjectSha256) errors.push(`${label}_subject_mismatch`);
  return path;
}

function verifyFileEvidence(root: string, evidence: FileEvidence | undefined, label: string, errors: string[]): string | null {
  const path = checkedFile(root, evidence?.path, label, errors);
  if (!path) return null;
  if (evidence?.sha256 !== sha256(path)) errors.push(`${label}_digest_mismatch`);
  return path;
}

function checkedFile(root: string, input: string | undefined, label: string, errors: string[]): string | null {
  if (typeof input !== "string" || input.length === 0 || isAbsolute(input) || input.includes("\\") || normalizedRelativePath(input) !== input) {
    errors.push(`${label}_path_invalid`); return null;
  }
  const candidate = resolve(root, input);
  if (!existsSync(candidate)) { errors.push(`${label}_missing`); return null; }
  if (lstatSync(candidate).isSymbolicLink()) { errors.push(`${label}_symlink_forbidden`); return null; }
  const real = realpathSync(candidate);
  const fromRoot = relative(root, real);
  if (!fromRoot || fromRoot.startsWith("..") || isAbsolute(fromRoot)) { errors.push(`${label}_path_outside_release`); return null; }
  if (!statSync(real).isFile()) { errors.push(`${label}_not_regular_file`); return null; }
  return real;
}

function normalizedRelativePath(input: string): string {
  const parts = input.split("/");
  return parts.length > 0 && parts.every((part) => part.length > 0 && part !== "." && part !== "..") ? parts.join("/") : "";
}

function platformSignerWorkflow(platform: string): string {
  if (platform === "macos") return "macos-signed-acceptance.yml";
  if (platform === "windows") return "windows-signed-acceptance.yml";
  if (platform === "linux") return "linux-deb-apt-acceptance.yml";
  return "invalid";
}

function parseChecksums(content: string, errors: string[]): Map<string, string> {
  const entries = new Map<string, string>();
  for (const line of content.split(/\r?\n/).filter(Boolean)) {
    const match = /^([a-f0-9]{64})  ([A-Za-z0-9._/-]+)$/.exec(line);
    if (!match || normalizedRelativePath(match[2] ?? "") !== match[2]) { errors.push("checksums_format_invalid"); continue; }
    if (entries.has(match[2]!)) errors.push("checksums_duplicate_path");
    entries.set(match[2]!, match[1]!);
  }
  return entries;
}

function validSpdx(content: string): boolean {
  try {
    const value = JSON.parse(content) as Record<string, unknown>;
    if (!isRecord(value) || !/^SPDX-2\.(?:2|3)$/.test(String(value.spdxVersion ?? "")) || value.dataLicense !== "CC0-1.0" || value.SPDXID !== "SPDXRef-DOCUMENT" || typeof value.name !== "string" || value.name.length === 0) return false;
    if (typeof value.documentNamespace !== "string" || !safeHttpsNamespace(value.documentNamespace)) return false;
    const creation = value.creationInfo;
    if (!isRecord(creation) || typeof creation.created !== "string" || !Number.isFinite(Date.parse(creation.created)) || !Array.isArray(creation.creators) || creation.creators.length === 0 || creation.creators.some((creator) => typeof creator !== "string" || !/^(?:Tool|Organization|Person): .+/.test(creator))) return false;
    const packages = Array.isArray(value.packages) ? value.packages : [];
    const files = Array.isArray(value.files) ? value.files : [];
    if (packages.length + files.length === 0) return false;
    const ids = new Set(["SPDXRef-DOCUMENT"]);
    for (const item of [...packages, ...files]) {
      if (!isRecord(item) || typeof item.SPDXID !== "string" || !/^SPDXRef-[A-Za-z0-9.-]+$/.test(item.SPDXID) || typeof item.name !== "string" || item.name.length === 0 || ids.has(item.SPDXID)) return false;
      ids.add(item.SPDXID);
    }
    if (Array.isArray(value.documentDescribes) && value.documentDescribes.some((id) => typeof id !== "string" || !ids.has(id))) return false;
    if (Array.isArray(value.relationships) && value.relationships.some((edge) => !isRecord(edge) || typeof edge.spdxElementId !== "string" || typeof edge.relatedSpdxElement !== "string" || !ids.has(edge.spdxElementId) || !ids.has(edge.relatedSpdxElement) || typeof edge.relationshipType !== "string" || edge.relationshipType.length === 0)) return false;
    return true;
  } catch { return false; }
}

function safeHttpsNamespace(value: string): boolean {
  try { const url = new URL(value); return url.protocol === "https:" && !url.username && !url.password && !url.hash; } catch { return false; }
}

function sha256(path: string): string {
  const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); } }
  finally { closeSync(handle); }
  return hash.digest("hex");
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(new URL(import.meta.url).pathname.replace(/^\/(.:)/, "$1"))) {
  const manifestPath = process.argv[2];
  const expectedRepository = process.argv[3];
  const expectedCommit = process.argv[4]; const expectedVersion = process.argv[5];
  if (!manifestPath || !expectedRepository) { console.error("Uso: npm run gate:release -- <release-manifest.json> <owner/repo> [commit-sha40] [vX.Y.Z]"); process.exit(2); }
  try {
    const errors = verifyRelease(manifestPath, expectedRepository, expectedCommit, expectedVersion);
    if (errors.length) { console.error(`Release recusado:\n- ${errors.join("\n- ")}`); process.exit(1); }
    console.log("SPEC-019 aprovada estruturalmente: bundle íntegro e evidências vinculadas; verificadores nativos externos continuam obrigatórios.");
  } catch (error) {
    console.error(`Release recusado: ${error instanceof Error ? error.message : "manifest_invalid"}`);
    process.exit(1);
  }
}
