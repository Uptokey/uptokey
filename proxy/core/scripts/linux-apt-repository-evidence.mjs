import { createHash } from "node:crypto";
import { closeSync, lstatSync, mkdtempSync, openSync, readFileSync, readSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { requiredCompiledVersion } from "./build-update-trust.mjs";
import { validateDebianControl, validateMaintainerScript } from "./build-linux-deb.mjs";

const SCHEMA = "uptokey-linux-apt-repository-evidence-v1";
const EXPECTED_PATHS = [
  "usr/bin/uptokey",
  "usr/lib/systemd/user/uptokey.service",
  "usr/share/doc/uptokey/README.Debian",
  "usr/share/doc/uptokey/copyright",
];
const REPOSITORY_FILES = [
  "dists/stable/InRelease",
  "dists/stable/Release",
  "dists/stable/Release.gpg",
  "dists/stable/main/binary-amd64/Packages",
  "dists/stable/main/binary-amd64/Packages.gz",
  "uptokey-archive-keyring.gpg",
];

export function validateAptRepositoryReceipt(value, expected) {
  const errors = [];
  if (!record(value) || !exact(value, ["schema", "subjectSha256", "verifiedAt", "toolchain", "package", "repository", "signer", "checks"]) || value.schema !== SCHEMA) return ["linux_apt_receipt_schema_invalid"];
  if (value.subjectSha256 !== expected.subjectSha256) errors.push("linux_apt_receipt_subject_mismatch");
  if (!Number.isFinite(Date.parse(value.verifiedAt ?? ""))) errors.push("linux_apt_receipt_timestamp_invalid");
  if (JSON.stringify(value.toolchain) !== JSON.stringify(["dpkg-deb", "gpgv", "tar"])) errors.push("linux_apt_receipt_toolchain_invalid");
  if (!record(value.package) || !exact(value.package, ["path", "sha256", "name", "version", "architecture", "installedPaths", "depends"])) errors.push("linux_apt_receipt_package_schema_invalid");
  else {
    if (value.package.path !== "uptokey-linux-amd64.deb" || value.package.sha256 !== expected.packageSha256 || value.package.name !== "uptokey" || value.package.version !== expected.version || value.package.architecture !== "amd64") errors.push("linux_apt_receipt_package_mismatch");
    if (JSON.stringify(value.package.installedPaths) !== JSON.stringify(EXPECTED_PATHS) || !String(value.package.depends).includes("libsecret-1-0") || !String(value.package.depends).includes("dbus-session-bus")) errors.push("linux_apt_receipt_package_contract_invalid");
  }
  if (!record(value.repository) || !exact(value.repository, ["suite", "component", "architecture", "files"]) || value.repository.suite !== "stable" || value.repository.component !== "main" || value.repository.architecture !== "amd64" || !Array.isArray(value.repository.files)) errors.push("linux_apt_receipt_repository_schema_invalid");
  else {
    const paths = value.repository.files.map((item) => record(item) ? item.path : null);
    if (JSON.stringify(paths) !== JSON.stringify(expected.repositoryFiles) || value.repository.files.some((item) => !record(item) || !exact(item, ["path", "sha256"]) || !/^[a-f0-9]{64}$/.test(item.sha256 ?? ""))) errors.push("linux_apt_receipt_repository_files_invalid");
    const byPath = new Map(value.repository.files.filter(record).map((item) => [item.path, item.sha256]));
    const poolPath = `pool/main/u/uptokey/uptokey_${expected.version}_amd64.deb`;
    if (byPath.get(poolPath) !== expected.packageSha256 || byPath.get("uptokey-archive-keyring.gpg") !== expected.publicKeySha256) errors.push("linux_apt_receipt_repository_binding_invalid");
  }
  if (!record(value.signer) || !exact(value.signer, ["fingerprint"]) || value.signer.fingerprint !== expected.signerFingerprint || !/^[A-F0-9]{40,64}$/.test(value.signer.fingerprint ?? "")) errors.push("linux_apt_receipt_signer_invalid");
  if (!record(value.checks) || !exact(value.checks, ["debMetadata", "installedPaths", "maintainerScripts", "packageIndex", "releaseChecksums", "inRelease", "releaseGpg", "keyringIsolated", "archiveContents"]) || Object.values(value.checks).some((item) => item !== true)) errors.push("linux_apt_receipt_checks_invalid");
  return [...new Set(errors)];
}

export function createLinuxAptRepositoryEvidence(options) {
  if (process.platform !== "linux") throw new Error("linux_apt_evidence_requires_linux");
  const version = requiredCompiledVersion(options.version); const signer = canonicalFingerprint(options.expectedSigner);
  const repository = checkedDirectory(options.repositoryRoot, "linux_apt_repository"); const archive = checkedRegular(options.archivePath, "linux_apt_archive"); const packagePath = checkedRegular(options.packagePath, "linux_apt_package"); const keyring = checkedRegular(options.keyringPath, "linux_apt_keyring");
  const packageSha256 = sha256File(packagePath); const subjectSha256 = sha256File(archive);
  const packageFields = run("dpkg-deb", ["--field", packagePath]); const controlErrors = validateDebianControl(packageFields, version); if (controlErrors.length) throw new Error(controlErrors[0]);
  const controlRoot = mkdtempSync(resolve(tmpdir(), "uptokey-deb-control-"));
  try {
    run("dpkg-deb", ["--control", packagePath, controlRoot]);
    for (const kind of ["postinst", "prerm"]) { const path = checkedRegular(resolve(controlRoot, kind), `linux_apt_${kind}`); const errors = validateMaintainerScript(readBounded(path, 16 * 1024), kind); if (errors.length) throw new Error(errors[0]); }
  } finally { rmSync(controlRoot, { recursive: true, force: true }); }
  const installedPaths = packageInstalledPaths(run("dpkg-deb", ["--contents", packagePath]));
  if (JSON.stringify(installedPaths) !== JSON.stringify(EXPECTED_PATHS)) throw new Error("linux_apt_installed_paths_invalid");

  const expectedPool = resolve(repository, `pool/main/u/uptokey/uptokey_${version}_amd64.deb`); if (sha256File(checkedRegular(expectedPool, "linux_apt_pool_package")) !== packageSha256) throw new Error("linux_apt_pool_package_mismatch");
  const publicKeySha256 = sha256File(keyring); if (sha256File(repositoryFile(repository, "uptokey-archive-keyring.gpg")) !== publicKeySha256) throw new Error("linux_apt_repository_keyring_mismatch");
  const packages = readRepositoryFile(repository, "dists/stable/main/binary-amd64/Packages", 1024 * 1024);
  if (!new RegExp(`^Package: uptokey$[\\s\\S]*^Version: ${escape(version)}$[\\s\\S]*^Architecture: amd64$[\\s\\S]*^Filename: pool/main/u/uptokey/uptokey_${escape(version)}_amd64\\.deb$[\\s\\S]*^SHA256: ${packageSha256}$`, "m").test(packages)) throw new Error("linux_apt_packages_binding_invalid");
  const releasePath = repositoryFile(repository, "dists/stable/Release"); const release = readBounded(releasePath, 1024 * 1024);
  for (const [field, expected] of [["Suite", "stable"], ["Codename", "stable"], ["Architectures", "amd64"], ["Components", "main"]]) if (!new RegExp(`^${field}: ${expected}$`, "m").test(release)) throw new Error("linux_apt_release_metadata_invalid");
  for (const path of ["main/binary-amd64/Packages", "main/binary-amd64/Packages.gz"]) assertReleaseSha256(release, resolve(repository, "dists", "stable", path), path);

  const verifyRoot = mkdtempSync(resolve(tmpdir(), "uptokey-gpgv-"));
  try {
    const extractedInRelease = resolve(verifyRoot, "InRelease.payload");
    const inReleaseStatus = run("gpgv", ["--homedir", verifyRoot, "--status-fd", "1", "--keyring", keyring, "--output", extractedInRelease, repositoryFile(repository, "dists/stable/InRelease")]);
    assertValidSig(inReleaseStatus, signer); if (!readFileSync(extractedInRelease).equals(readFileSync(releasePath))) throw new Error("linux_apt_inrelease_payload_mismatch");
    const detachedStatus = run("gpgv", ["--homedir", verifyRoot, "--status-fd", "1", "--keyring", keyring, repositoryFile(repository, "dists/stable/Release.gpg"), releasePath]);
    assertValidSig(detachedStatus, signer);
  } finally { rmSync(verifyRoot, { recursive: true, force: true }); }

  const files = repositoryEvidenceFiles(repository, version); assertArchiveMatches(archive, repository, files.map((item) => item.path));
  const receipt = { schema: SCHEMA, subjectSha256, verifiedAt: new Date().toISOString(), toolchain: ["dpkg-deb", "gpgv", "tar"], package: { path: "uptokey-linux-amd64.deb", sha256: packageSha256, name: "uptokey", version, architecture: "amd64", installedPaths, depends: field(packageFields, "Depends") }, repository: { suite: "stable", component: "main", architecture: "amd64", files }, signer: { fingerprint: signer }, checks: { debMetadata: true, installedPaths: true, maintainerScripts: true, packageIndex: true, releaseChecksums: true, inRelease: true, releaseGpg: true, keyringIsolated: true, archiveContents: true } };
  const errors = validateAptRepositoryReceipt(receipt, { subjectSha256, packageSha256, publicKeySha256, version, signerFingerprint: signer, repositoryFiles: files.map((item) => item.path) }); if (errors.length) throw new Error(errors[0]);
  writeFileSync(resolve(options.outputPath), `${JSON.stringify(receipt, null, 2)}\n`, { flag: "wx", mode: 0o600 }); return receipt;
}

function repositoryEvidenceFiles(repository, version) { return [...REPOSITORY_FILES, `pool/main/u/uptokey/uptokey_${version}_amd64.deb`].sort().map((path) => ({ path, sha256: sha256File(repositoryFile(repository, path)) })); }
function packageInstalledPaths(output) { return [...new Set(output.replaceAll("\r", "").split("\n").map((line) => / \.\/([^\s]+)$/.exec(line)?.[1]).filter((path) => path && !path.endsWith("/")))].sort(); }
function assertReleaseSha256(release, path, relativePath) { const digest = sha256File(checkedRegular(path, "linux_apt_release_subject")); const size = statSync(path).size; const line = new RegExp(`^ ${digest} +${size} ${escape(relativePath)}$`, "m"); if (!line.test(release)) throw new Error("linux_apt_release_checksum_mismatch"); }
function assertValidSig(status, signer) { const fingerprints = [...status.matchAll(/^\[GNUPG:\] VALIDSIG ([A-F0-9]{40,64}) /gm)].map((match) => match[1]); if (fingerprints.length !== 1 || fingerprints[0] !== signer) throw new Error("linux_apt_signature_invalid"); }
function assertArchiveMatches(archive, repository, expectedFiles) { const listed = run("tar", ["-tzf", archive]).replaceAll("\r", "").split("\n").filter(Boolean); if (listed.some((name) => name !== "./" && !/^\.\/(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+\/?$/.test(name))) throw new Error("linux_apt_archive_path_invalid"); const listedFiles = listed.filter((name) => name !== "./" && !name.endsWith("/")).map((name) => name.slice(2)).sort(); if (JSON.stringify(listedFiles) !== JSON.stringify([...expectedFiles].sort())) throw new Error("linux_apt_archive_file_set_invalid"); const target = mkdtempSync(resolve(tmpdir(), "uptokey-apt-archive-")); try { run("tar", ["-xzf", archive, "-C", target, "--no-same-owner", "--no-same-permissions"]); for (const path of expectedFiles) if (sha256File(repositoryFile(target, path)) !== sha256File(repositoryFile(repository, path))) throw new Error("linux_apt_archive_content_mismatch"); } finally { rmSync(target, { recursive: true, force: true }); } }
function readRepositoryFile(root, path, maximum) { return readBounded(repositoryFile(root, path), maximum); }
function repositoryFile(root, path) { if (!/^(?:[A-Za-z0-9._+-]+\/)*[A-Za-z0-9._+-]+$/.test(path)) throw new Error("linux_apt_repository_path_invalid"); const candidate = checkedRegular(resolve(root, path), "linux_apt_repository_file"); const fromRoot = relative(root, candidate); if (!fromRoot || fromRoot.startsWith(`..${sep}`) || fromRoot === "..") throw new Error("linux_apt_repository_path_outside"); return candidate; }
function checkedRegular(input, label) { const path = resolve(input); const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error(`${label}_regular_file_required`); return realpathSync(path); }
function checkedDirectory(input, label) { const path = resolve(input); const metadata = lstatSync(path); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}_directory_required`); return realpathSync(path); }
function readBounded(path, maximum) { const metadata = statSync(path); if (metadata.size < 1 || metadata.size > maximum) throw new Error("linux_apt_text_size_invalid"); return new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(path)); }
function sha256File(path) { const handle = openSync(path, "r"); const hash = createHash("sha256"); const buffer = Buffer.allocUnsafe(64 * 1024); try { for (;;) { const count = readSync(handle, buffer, 0, buffer.length, null); if (!count) break; hash.update(buffer.subarray(0, count)); } } finally { closeSync(handle); } return hash.digest("hex"); }
function canonicalFingerprint(value) { if (typeof value !== "string" || !/^[A-F0-9]{40,64}$/.test(value)) throw new Error("linux_apt_signer_invalid"); return value; }
function field(text, name) { return new RegExp(`^${name}: (.+)$`, "m").exec(text)?.[1]?.trim() ?? ""; }
function escape(value) { return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }
function run(command, args) { const result = spawnSync(command, args, { encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); if (result.status !== 0 || result.error || result.signal) throw new Error(`${command}_failed`); return result.stdout; }
function record(value) { return value !== null && typeof value === "object" && !Array.isArray(value); }
function exact(value, keys) { return record(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()); }

function parseArgs(argv) { const parsed = {}; for (let index = 0; index < argv.length; index += 2) { const key = argv[index], value = argv[index + 1]; if (!key?.startsWith("--") || value === undefined || Object.hasOwn(parsed, key.slice(2))) throw new Error("linux_apt_evidence_arguments_invalid"); parsed[key.slice(2)] = value; } return parsed; }
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) { try { const args = parseArgs(process.argv.slice(2)); for (const key of ["repository", "archive", "package", "keyring", "expectedSigner", "version", "out"]) if (!args[key]) throw new Error("linux_apt_evidence_arguments_invalid"); const receipt = createLinuxAptRepositoryEvidence({ repositoryRoot: args.repository, archivePath: args.archive, packagePath: args.package, keyringPath: args.keyring, expectedSigner: args.expectedSigner, version: args.version, outputPath: args.out }); process.stdout.write(`linux_apt_repository_evidence_valid signer=${receipt.signer.fingerprint}\n`); } catch { process.stderr.write("linux_apt_repository_evidence_invalid\n"); process.exitCode = 1; } }
