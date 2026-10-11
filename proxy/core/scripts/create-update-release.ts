import { createHash } from "node:crypto";
import { closeSync, lstatSync, openSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { validUpdateVersion } from "../src/update-manifest.ts";
import { pathToFileURL } from "node:url";
import { parseUpdateManifest } from "../src/update-manifest.ts";

const ALL_ARTIFACTS = [
  { platform: "macos", path: "uptokey-macos.zip" },
  { platform: "windows", path: "uptokey-windows.exe" },
  { platform: "linux", path: "uptokey-linux-amd64.deb" },
] as const;

function selectArtifacts(platforms: readonly string[]): (typeof ALL_ARTIFACTS)[number][] {
  if (platforms.length < 1 || platforms.length > ALL_ARTIFACTS.length) throw new Error("update_release_platforms_count_invalid");
  if (new Set(platforms).size !== platforms.length) throw new Error("update_release_platforms_duplicate");
  return platforms.map((platform) => {
    const item = ALL_ARTIFACTS.find((entry) => entry.platform === platform);
    if (!item) throw new Error(`update_release_platform_unknown:${platform}`);
    return item;
  });
}

export function createUpdateRelease(rootInput: string, version: string, minimumVersion: string, publishedAt: string, originInput: string, platforms: readonly string[] = ALL_ARTIFACTS.map((item) => item.platform)) {
  if (!validUpdateVersion(version) || !validUpdateVersion(minimumVersion)) throw new Error("update_release_version_invalid");
  if (!Number.isFinite(Date.parse(publishedAt)) || new Date(publishedAt).toISOString() !== publishedAt) throw new Error("update_release_published_at_invalid");
  const origin = new URL(originInput);
  if (origin.protocol !== "https:" || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash || origin.origin !== originInput) throw new Error("update_release_origin_invalid");
  const artifacts = selectArtifacts(platforms);
  const requestedRoot = resolve(rootInput); const rootMetadata = lstatSync(requestedRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) throw new Error("update_release_root_directory_required");
  const root = realpathSync(requestedRoot);
  const observed = artifacts.map((item) => { const file = checkedRegular(root, item.path); return { ...item, sha256: sha256File(file), size: lstatSync(file).size }; });
  const checksumEntries = observed.flatMap((item) => {
    if (item.platform === "windows") {
      const helperPath = "uptokey-update-helper.exe"; const helper = checkedRegular(root, helperPath);
      return [item, { path: helperPath, sha256: sha256File(helper), size: lstatSync(helper).size }];
    }
    if (item.platform === "linux") {
      const repositoryPath = "uptokey-apt-repository.tar.gz"; const repository = checkedRegular(root, repositoryPath);
      return [item, { path: repositoryPath, sha256: sha256File(repository), size: lstatSync(repository).size }];
    }
    return [item];
  });
  const checksumText = checksumEntries.map((item) => `${item.sha256}  ${item.path}`).join("\n");
  const checksumsPath = resolve(root, "SHA256SUMS"); writeFileSync(checksumsPath, checksumText, { flag: "wx" });
  const manifest = { schema: "uptokey-update-manifest-v1", version, minimumVersion, publishedAt, checksumsSha256: digest(Buffer.from(checksumText)), artifacts: observed.map((item) => ({ ...item, url: `${origin.origin}/${version}/${item.path}` })) };
  parseUpdateManifest(Buffer.from(JSON.stringify(manifest)));
  const manifestPath = resolve(root, "update-manifest.json");
  try { writeFileSync(manifestPath, JSON.stringify(manifest), { flag: "wx" }); }
  catch (error) { try { unlinkSync(checksumsPath); } catch {} throw error; }
  return { checksumsPath, manifestPath, manifest };
}

function checkedRegular(root: string, name: string) { const path = resolve(root, name); let metadata; try { metadata = lstatSync(path); } catch { throw new Error(`update_release_artifact_regular_file_required:${name}`); } if (!metadata.isFile() || metadata.isSymbolicLink()) throw new Error(`update_release_artifact_regular_file_required:${name}`); const canonical = realpathSync(path); if (!canonical.startsWith(`${root}\\`) && !canonical.startsWith(`${root}/`)) throw new Error(`update_release_artifact_outside_root:${name}`); return canonical; }
function sha256File(path: string) { const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { closeSync(handle); } return hash.digest("hex"); }
function digest(value: Buffer) { return createHash("sha256").update(value).digest("hex"); }
function parseArgs(argv: string[]) { const parsed: Record<string, string> = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index]; const value = argv[index + 1]; if (!key?.startsWith("--") || !value) throw new Error("create_update_release_arguments_invalid"); parsed[key.slice(2)] = value; } return parsed; }

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (!args.root || !args.version || !args.minimumVersion || !args.publishedAt || !args.origin) throw new Error("uso: --root <dir> --version <vX.Y.Z> --minimumVersion <vX.Y.Z> --publishedAt <ISO> --origin <https-origin> [--platforms <csv, default macos,windows,linux>]");
    const platforms = args.platforms ? args.platforms.split(",") : undefined;
    const result = platforms
      ? createUpdateRelease(args.root, args.version, args.minimumVersion, args.publishedAt, args.origin, platforms)
      : createUpdateRelease(args.root, args.version, args.minimumVersion, args.publishedAt, args.origin);
    process.stdout.write(`Update manifest criado em ${result.manifestPath}.\n`);
  }
  catch { process.stderr.write("Update manifest recusado: creation_failed\n"); process.exitCode = 1; }
}
