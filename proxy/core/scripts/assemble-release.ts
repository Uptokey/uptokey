import { createHash } from "node:crypto";
import { closeSync, fstatSync, lstatSync, openSync, readSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "./verify-release.ts";
import { validReleaseVersion } from "./artifact-version-evidence.mjs";
import { publicUpdateKeyFingerprint } from "./build-update-trust.mjs";

interface ReleaseLayout {
  platform: "macos" | "windows" | "linux";
  artifact: string; signature: string; buildVersion: string; sbom: string; provenance: string;
  windowsUpdateHelper?: { artifact: string; signature: string; sbom: string; provenance: string };
  linuxAptRepository?: { archive: string; publicKey: string; evidence: string; provenance: string };
}

const ALL_LAYOUTS: readonly ReleaseLayout[] = [
  { platform: "macos", artifact: "uptokey-macos.zip", signature: "macos.signature.json", buildVersion: "macos.version.json", sbom: "uptokey-macos.zip.spdx.json", provenance: "macos.provenance.json" },
  {
    platform: "windows", artifact: "uptokey-windows.exe", signature: "windows.signature.json", buildVersion: "windows.version.json", sbom: "uptokey-windows.exe.spdx.json", provenance: "windows.provenance.json",
    windowsUpdateHelper: { artifact: "uptokey-update-helper.exe", signature: "windows-helper.signature.json", sbom: "uptokey-update-helper.exe.spdx.json", provenance: "windows-helper.provenance.json" },
  },
  {
    platform: "linux", artifact: "uptokey-linux-amd64.deb", signature: "linux.signature.json", buildVersion: "linux.version.json", sbom: "uptokey-linux-amd64.deb.spdx.json", provenance: "linux.provenance.json",
    linuxAptRepository: { archive: "uptokey-apt-repository.tar.gz", publicKey: "linux-public.gpg", evidence: "linux-apt-repository.json", provenance: "linux-apt.provenance.json" },
  },
] as const;

export function selectLayouts(platforms: readonly string[]): (typeof ALL_LAYOUTS)[number][] {
  if (platforms.length < 1 || platforms.length > ALL_LAYOUTS.length) throw new Error("release_platforms_count_invalid");
  if (new Set(platforms).size !== platforms.length) throw new Error("release_platforms_duplicate");
  const selected = platforms.map((platform) => {
    const layout = ALL_LAYOUTS.find((item) => item.platform === platform);
    if (!layout) throw new Error(`release_platform_unknown:${platform}`);
    return layout;
  });
  return selected;
}

export interface ReleaseBuildIdentity { updateOrigin: string; primaryKeyFingerprint: string; nextKeyFingerprint: string | null }

export function assembleReleaseManifest(rootInput: string, version: string, commit: string, repository: string, platforms: readonly string[] = ALL_LAYOUTS.map((item) => item.platform), buildIdentity?: ReleaseBuildIdentity) {
  if (!validReleaseVersion(version)) throw new Error("release_version_invalid");
  if (!/^[a-f0-9]{40}$/.test(commit)) throw new Error("release_commit_invalid");
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("release_repository_invalid");
  const layouts = selectLayouts(platforms);
  validateReleaseBuildIdentity(buildIdentity);
  const requestedRoot = resolve(rootInput); const rootMetadata = lstatSync(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("release_root_directory_required");
  const root = realpathSync(requestedRoot);
  const artifacts = layouts.map((layout) => {
    const artifact = checkedRegular(root, layout.artifact); const artifactDigest = sha256File(artifact);
    const signature = readJson(checkedRegular(root, layout.signature), 64 * 1024, "native_receipt");
    const signerId = layout.platform === "macos" ? signature?.signer?.teamId : layout.platform === "windows" ? signature?.signer?.thumbprint : signature?.signer?.fingerprint;
    if (typeof signerId !== "string") throw new Error(`${layout.platform}_signer_missing`);
    const windowsUpdateHelper = layout.windowsUpdateHelper ? assembleWindowsUpdateHelper(root, layout.windowsUpdateHelper, signerId) : undefined;
    const linuxAptRepository = layout.linuxAptRepository ? assembleLinuxAptRepository(root, layout.linuxAptRepository, signerId) : undefined;
    return {
      platform: layout.platform, path: layout.artifact, sha256: artifactDigest,
      buildVersion: { path: layout.buildVersion, sha256: sha256File(checkedRegular(root, layout.buildVersion)), subjectSha256: artifactDigest, version },
      platformSignature: {
        verified: true, signerId,
        hardenedRuntime: layout.platform === "macos", notarized: layout.platform === "macos", stapled: layout.platform === "macos", hardwareBacked: layout.platform === "windows",
        evidence: { path: layout.signature, sha256: sha256File(resolve(root, layout.signature)), subjectSha256: artifactDigest },
      },
      ...(windowsUpdateHelper ? { windowsUpdateHelper } : {}),
      ...(linuxAptRepository ? { linuxAptRepository } : {}),
    };
  });
  const byPlatform = new Map(artifacts.map((artifact) => [artifact.platform, artifact.sha256]));
  const sbom = layouts.map((layout) => ({ path: layout.sbom, sha256: sha256File(checkedRegular(root, layout.sbom)), subjectSha256: byPlatform.get(layout.platform), format: "spdx-json" }));
  const provenance = layouts.map((layout) => ({ path: layout.provenance, sha256: sha256File(checkedRegular(root, layout.provenance)), subjectSha256: byPlatform.get(layout.platform) }));
  const updateManifestPath = checkedRegular(root, "update-manifest.json"); const updateManifestDigest = sha256File(updateManifestPath);
  const updateReceiptPath = checkedRegular(root, "update.signature.json"); const updateReceipt = readJson(updateReceiptPath, 64 * 1024, "update_receipt");
  const rawSignaturePath = checkedRegular(root, "update-manifest.sig"); const publicKeyPath = checkedRegular(root, "update-public.pem");
  const updateSignerId = updateReceipt?.signer?.keyFingerprint;
  if (typeof updateSignerId !== "string") throw new Error("update_signer_missing");
  checkedRegular(root, "SHA256SUMS");
  const licensePath = checkedRegular(root, "LICENSE");
  const manifest = {
    version, commit, buildIdentity, artifacts, checksums: { path: "SHA256SUMS" }, license: { path: "LICENSE", sha256: sha256File(licensePath) },
    updateManifest: { path: "update-manifest.json", sha256: updateManifestDigest }, sbom,
    updateSignature: { path: "update.signature.json", sha256: sha256File(updateReceiptPath), subjectSha256: updateManifestDigest, verified: true, signerId: updateSignerId, signature: { path: "update-manifest.sig", sha256: sha256File(rawSignaturePath) }, publicKey: { path: "update-public.pem", sha256: sha256File(publicKeyPath) } },
    provenance,
  };
  const output = resolve(root, "release-manifest.json");
  writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
  try {
    const errors = verifyRelease(output, repository);
    if (errors.length) throw new Error(`release_manifest_verification_failed:${errors.join(",")}`);
    return { output, manifest };
  } catch (error) {
    unlinkSync(output); throw error;
  }
}

function assembleLinuxAptRepository(root: string, layout: NonNullable<ReleaseLayout["linuxAptRepository"]>, mainSignerId: string) {
  const archive = checkedRegular(root, layout.archive); const archiveDigest = sha256File(archive);
  const evidencePath = checkedRegular(root, layout.evidence); const evidence = readJson(evidencePath, 256 * 1024, "linux_apt_repository_receipt");
  if (evidence?.signer?.fingerprint !== mainSignerId || evidence?.subjectSha256 !== archiveDigest) throw new Error("linux_apt_repository_binding_mismatch");
  return {
    path: layout.archive, sha256: archiveDigest, signerId: mainSignerId,
    publicKey: { path: layout.publicKey, sha256: sha256File(checkedRegular(root, layout.publicKey)) },
    evidence: { path: layout.evidence, sha256: sha256File(evidencePath), subjectSha256: archiveDigest },
    provenance: { path: layout.provenance, sha256: sha256File(checkedRegular(root, layout.provenance)), subjectSha256: archiveDigest },
  };
}

function validateReleaseBuildIdentity(value: ReleaseBuildIdentity | undefined): asserts value is ReleaseBuildIdentity {
  if (!value) throw new Error("release_build_identity_required");
  let parsed; try { parsed = new URL(value.updateOrigin); } catch { throw new Error("release_build_origin_invalid"); }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash || parsed.origin !== value.updateOrigin) throw new Error("release_build_origin_invalid");
  if (!/^[a-f0-9]{64}$/.test(value.primaryKeyFingerprint) || !(value.nextKeyFingerprint === null || /^[a-f0-9]{64}$/.test(value.nextKeyFingerprint)) || value.nextKeyFingerprint === value.primaryKeyFingerprint) throw new Error("release_build_trust_invalid");
}

function assembleWindowsUpdateHelper(root: string, layout: NonNullable<ReleaseLayout["windowsUpdateHelper"]>, mainSignerId: string) {
  const artifact = checkedRegular(root, layout.artifact); const artifactDigest = sha256File(artifact);
  const signaturePath = checkedRegular(root, layout.signature); const signature = readJson(signaturePath, 64 * 1024, "windows_helper_native_receipt");
  const signerId = signature?.signer?.thumbprint;
  if (typeof signerId !== "string" || signerId !== mainSignerId) throw new Error("windows_helper_signer_mismatch");
  return {
    path: layout.artifact, sha256: artifactDigest,
    platformSignature: { verified: true, signerId, hardwareBacked: true, evidence: { path: layout.signature, sha256: sha256File(signaturePath), subjectSha256: artifactDigest } },
    sbom: { path: layout.sbom, sha256: sha256File(checkedRegular(root, layout.sbom)), subjectSha256: artifactDigest, format: "spdx-json" },
    provenance: { path: layout.provenance, sha256: sha256File(checkedRegular(root, layout.provenance)), subjectSha256: artifactDigest },
  };
}

function checkedRegular(root: string, name: string) {
  const path = resolve(root, name); let metadata; try { metadata = lstatSync(path); } catch { throw new Error(`release_input_regular_file_required:${name}`); }
  if (!metadata.isFile() || metadata.isSymbolicLink() || resolve(root, name) !== path) throw new Error(`release_input_regular_file_required:${name}`);
  const canonical = realpathSync(path);
  if (!canonical.startsWith(`${root}\\`) && !canonical.startsWith(`${root}/`)) throw new Error(`release_input_outside_root:${name}`);
  return canonical;
}

function sha256File(path: string) {
  const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024);
  try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (count === 0) break; hash.update(buffer.subarray(0, count)); } }
  finally { closeSync(handle); }
  return hash.digest("hex");
}

function readJson(path: string, maximum: number, label: string): any {
  const handle = openSync(path, "r"); const metadata = fstatSync(handle);
  try {
    if (!metadata.isFile() || metadata.size < 1 || metadata.size > maximum) throw new Error(`${label}_size_invalid`);
    const bytes = Buffer.allocUnsafe(metadata.size); let offset = 0;
    while (offset < bytes.length) { const count = readSync(handle, bytes, offset, bytes.length - offset, null); if (count === 0) break; offset += count; }
    if (offset !== bytes.length) throw new Error(`${label}_truncated`);
    try { return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); } catch { throw new Error(`${label}_json_invalid`); }
  } finally { closeSync(handle); }
}

function parseArgs(argv: string[]) {
  const parsed: Record<string, string> = {};
  for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("assemble_release_arguments_invalid"); parsed[key.slice(2)] = value; }
  return parsed;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.root || !args.version || !args.commit || !args.repository || !args.expectedOrigin || !args.primaryPublicKey) throw new Error("uso: --root <release-dir> --version <vX.Y.Z> --commit <sha40> --repository <owner/repo> --expectedOrigin <https-origin> --primaryPublicKey <pem> [--nextPublicKey <pem>] [--platforms <csv>]");
    const platforms = args.platforms ? args.platforms.split(",") : undefined;
    const buildIdentity = { updateOrigin: args.expectedOrigin, primaryKeyFingerprint: publicUpdateKeyFingerprint(args.primaryPublicKey), nextKeyFingerprint: args.nextPublicKey ? publicUpdateKeyFingerprint(args.nextPublicKey) : null };
    const result = platforms
      ? assembleReleaseManifest(args.root, args.version, args.commit, args.repository, platforms, buildIdentity)
      : assembleReleaseManifest(args.root, args.version, args.commit, args.repository, undefined, buildIdentity);
    process.stdout.write(`Manifesto verificado criado em ${result.output}.\n`);
  } catch { process.stderr.write("Manifesto recusado: assembly_failed\n"); process.exitCode = 1; }
}
