import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, renameSync, rmSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { verifyRelease } from "./verify-release.ts";

const KNOWN_PLATFORMS = new Set(["macos", "windows", "linux"]);
const SAFE_ASSET = /^(?!-)[A-Za-z0-9][A-Za-z0-9._-]*$/;

export interface PublicationEvidence { platforms: string[]; assets: string[]; digest: string }

export function publicationAssetsForManifest(manifest: unknown): { platforms: string[]; assets: string[] } {
  const release = record(manifest);
  if (!release || !Array.isArray(release.artifacts)) throw new Error("publication_manifest_invalid");
  const artifacts = release.artifacts;
  if (artifacts.length < 1 || artifacts.length > 3) throw new Error("publication_platforms_count_invalid");
  const platforms = artifacts.map((artifact) => requiredString(artifact, "platform", "publication_platform_invalid"));
  if (new Set(platforms).size !== platforms.length) throw new Error("publication_platforms_duplicate");
  for (const platform of platforms) if (!KNOWN_PLATFORMS.has(platform)) throw new Error(`publication_platform_unknown:${platform}`);

  const assets: string[] = [];
  for (const artifact of artifacts) {
    if (!record(artifact)) throw new Error("publication_artifact_invalid");
    const platform = requiredString(artifact, "platform", "publication_platform_invalid");
    const subject = requiredString(artifact, "sha256", "publication_artifact_digest_invalid");
    assets.push(
      requiredString(artifact, "path", "publication_artifact_path_invalid"),
      nestedPath(artifact.buildVersion, "publication_build_version_invalid"),
      nestedPath(record(artifact.platformSignature)?.evidence, "publication_signature_invalid"),
      evidenceForSubject(release.sbom, subject, "publication_sbom_invalid"),
      evidenceForSubject(release.provenance, subject, "publication_provenance_invalid"),
    );
    if (platform === "windows") {
      const helper = record(artifact.windowsUpdateHelper);
      if (!helper) throw new Error("publication_windows_helper_required");
      assets.push(
        requiredString(helper, "path", "publication_windows_helper_invalid"),
        nestedPath(record(helper.platformSignature)?.evidence, "publication_windows_helper_signature_invalid"),
        nestedPath(helper.sbom, "publication_windows_helper_sbom_invalid"),
        nestedPath(helper.provenance, "publication_windows_helper_provenance_invalid"),
      );
    } else if (artifact.windowsUpdateHelper !== undefined) throw new Error("publication_windows_helper_forbidden");
    if (platform === "linux") {
      const apt = record(artifact.linuxAptRepository);
      if (!apt) throw new Error("publication_linux_apt_repository_required");
      assets.push(
        requiredString(apt, "path", "publication_linux_apt_archive_invalid"),
        nestedPath(apt.publicKey, "publication_linux_apt_public_key_invalid"),
        nestedPath(apt.evidence, "publication_linux_apt_evidence_invalid"),
        nestedPath(apt.provenance, "publication_linux_apt_provenance_invalid"),
      );
    } else if (artifact.linuxAptRepository !== undefined) throw new Error("publication_linux_apt_repository_forbidden");
  }

  const updateSignature = record(release.updateSignature);
  assets.push(
    nestedPath(release.license, "publication_license_invalid"),
    nestedPath(release.checksums, "publication_checksums_invalid"),
    nestedPath(release.updateManifest, "publication_update_manifest_invalid"),
    nestedPath(updateSignature, "publication_update_signature_invalid"),
    nestedPath(updateSignature?.signature, "publication_update_signature_raw_invalid"),
    nestedPath(updateSignature?.publicKey, "publication_update_public_key_invalid"),
    "release-manifest.json",
  );
  for (const asset of assets) if (!SAFE_ASSET.test(asset)) throw new Error(`publication_asset_name_invalid:${asset}`);
  if (new Set(assets).size !== assets.length) throw new Error("publication_assets_duplicate");
  return { platforms, assets };
}

export function stageReleasePublication(sourceInput: string, outputInput: string, repository: string, commit: string, version: string): PublicationEvidence {
  const source = checkedDirectory(sourceInput, "publication_source"); const output = resolve(outputInput);
  if (existsSync(output)) throw new Error("publication_output_exists");
  const manifestPath = resolve(source, "release-manifest.json"); const errors = verifyRelease(manifestPath, repository, commit, version);
  if (errors.length) throw new Error(`publication_release_gate_failed:${errors.join(",")}`);
  const selected = publicationAssetsForManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  mkdirSync(dirname(output), { recursive: true });
  const temporary = mkdtempSync(resolve(dirname(output), `.${basename(output)}.${process.pid}.${randomUUID()}.`));
  try {
    for (const asset of selected.assets) copyFileSync(checkedAsset(source, asset), resolve(temporary, asset), constants.COPYFILE_EXCL);
    const evidence = verifyReleasePublication(temporary, repository, commit, version);
    renameSync(temporary, output); return evidence;
  } catch (error) { rmSync(temporary, { recursive: true, force: true }); throw error; }
}

export function verifyReleasePublication(rootInput: string, repository: string, commit: string, version: string): PublicationEvidence {
  const root = checkedDirectory(rootInput, "publication_root"); const manifestPath = resolve(root, "release-manifest.json");
  const errors = verifyRelease(manifestPath, repository, commit, version);
  if (errors.length) throw new Error(`publication_release_gate_failed:${errors.join(",")}`);
  const selected = publicationAssetsForManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  return { platforms: selected.platforms, assets: selected.assets, digest: verifyPublicationAssetSet(root, selected.assets) };
}

export function verifyPublicationAssetSet(rootInput: string, assets: readonly string[]): string {
  const root = checkedDirectory(rootInput, "publication_root");
  if (assets.length === 0 || new Set(assets).size !== assets.length) throw new Error("publication_assets_invalid");
  for (const asset of assets) if (!SAFE_ASSET.test(asset)) throw new Error(`publication_asset_name_invalid:${asset}`);
  const entries = readdirSync(root, { withFileTypes: true });
  const observed = entries.map((entry) => entry.name).sort(); const expected = [...assets].sort();
  if (JSON.stringify(observed) !== JSON.stringify(expected)) throw new Error("publication_asset_set_mismatch");
  for (const entry of entries) if (!entry.isFile() || entry.isSymbolicLink()) throw new Error(`publication_asset_regular_file_required:${entry.name}`);
  const digestInput = assets.map((asset) => `${sha256File(checkedAsset(root, asset))}  ${asset}\n`).join("");
  return createHash("sha256").update(digestInput).digest("hex");
}

function evidenceForSubject(value: unknown, subject: string, error: string): string {
  if (!Array.isArray(value)) throw new Error(error);
  const matches = value.filter((item) => record(item)?.subjectSha256 === subject);
  if (matches.length !== 1) throw new Error(error);
  return nestedPath(matches[0], error);
}
function nestedPath(value: unknown, error: string): string { const item = record(value); if (!item) throw new Error(error); return requiredString(item, "path", error); }
function requiredString(value: unknown, key: string, error: string): string { const item = record(value); if (!item || typeof item[key] !== "string" || item[key].length === 0) throw new Error(error); return item[key] as string; }
function record(value: unknown): Record<string, any> | undefined { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : undefined; }
function checkedDirectory(input: string, label: string): string { const path = resolve(input); let metadata; try { metadata = lstatSync(path); } catch { throw new Error(`${label}_directory_required`); } if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}_directory_required`); return realpathSync(path); }
function checkedAsset(root: string, asset: string): string { if (!SAFE_ASSET.test(asset)) throw new Error(`publication_asset_name_invalid:${asset}`); const path = resolve(root, asset); let metadata; try { metadata = lstatSync(path); } catch { throw new Error(`publication_asset_missing:${asset}`); } if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`publication_asset_regular_file_required:${asset}`); return realpathSync(path); }
function sha256File(path: string): string { const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { closeSync(handle); } return hash.digest("hex"); }
function parseArgs(argv: string[]): Record<string, string> { const parsed: Record<string, string> = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("publication_arguments_invalid"); parsed[key.slice(2)] = value; } return parsed; }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.root || !args.repository || !args.commit || !args.version) throw new Error("uso: --root <release-dir> --repository <owner/repo> --commit <sha40> --version <vX.Y.Z> [--out <publication-dir>]");
    const evidence = args.out ? stageReleasePublication(args.root, args.out, args.repository, args.commit, args.version) : verifyReleasePublication(args.root, args.repository, args.commit, args.version);
    process.stdout.write(`${JSON.stringify(evidence)}\n`);
  } catch { process.stderr.write("Publicação recusada: evidence_failed\n"); process.exitCode = 1; }
}
