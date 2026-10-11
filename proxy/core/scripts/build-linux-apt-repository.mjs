import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { gzipSync } from "node:zlib";
import { requiredCompiledVersion } from "./build-update-trust.mjs";

const project = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function linuxAptLayout(outputRoot = resolve(project, "dist"), version = process.env.UPTOKEY_BUILD_VERSION ?? "") {
  const normalized = requiredCompiledVersion(version);
  const repository = resolve(outputRoot, "apt-repository");
  return {
    repository,
    poolPackage: resolve(repository, "pool", "main", "u", "uptokey", `uptokey_${normalized}_amd64.deb`),
    packages: resolve(repository, "dists", "stable", "main", "binary-amd64", "Packages"),
    packagesGzip: resolve(repository, "dists", "stable", "main", "binary-amd64", "Packages.gz"),
    release: resolve(repository, "dists", "stable", "Release"),
    inRelease: resolve(repository, "dists", "stable", "InRelease"),
    releaseSignature: resolve(repository, "dists", "stable", "Release.gpg"),
    publicKey: resolve(repository, "uptokey-archive-keyring.gpg"),
    archive: resolve(outputRoot, "uptokey-apt-repository.tar.gz"),
    version: normalized,
    architecture: "amd64",
    suite: "stable",
    component: "main",
  };
}

export function buildLinuxAptRepository(debPath, outputRoot) {
  if (process.platform !== "linux") throw new Error("linux_apt_repository_build_requires_linux");
  const layout = linuxAptLayout(outputRoot ? resolve(outputRoot) : undefined);
  const source = checkedRegular(debPath, "linux_apt_deb");
  if (existsSync(layout.repository) || existsSync(layout.archive)) throw new Error("linux_apt_repository_output_already_exists");
  mkdirSync(dirname(layout.poolPackage), { recursive: true }); mkdirSync(dirname(layout.packages), { recursive: true });
  copyFileSync(source, layout.poolPackage);
  const fields = run("dpkg-deb", ["--field", layout.poolPackage], project);
  if (field(fields, "Package") !== "uptokey" || field(fields, "Version") !== layout.version || field(fields, "Architecture") !== layout.architecture) throw new Error("linux_apt_deb_metadata_mismatch");
  const packages = run("dpkg-scanpackages", ["--multiversion", "pool/main/u/uptokey", "/dev/null"], layout.repository);
  if (!packages.endsWith("\n") || !packages.includes(`Filename: pool/main/u/uptokey/uptokey_${layout.version}_amd64.deb\n`)) throw new Error("linux_apt_packages_invalid");
  writeFileSync(layout.packages, packages, { flag: "wx", mode: 0o644 });
  writeFileSync(layout.packagesGzip, gzipSync(Buffer.from(packages), { level: 9, mtime: 0 }), { flag: "wx", mode: 0o644 });
  const release = run("apt-ftparchive", [
    "-o", "APT::FTPArchive::Release::Origin=Uptokey",
    "-o", "APT::FTPArchive::Release::Label=Uptokey",
    "-o", "APT::FTPArchive::Release::Suite=stable",
    "-o", "APT::FTPArchive::Release::Codename=stable",
    "-o", "APT::FTPArchive::Release::Architectures=amd64",
    "-o", "APT::FTPArchive::Release::Components=main",
    "-o", "APT::FTPArchive::Release::Description=Uptokey signed Debian repository",
    "release", "dists/stable",
  ], layout.repository);
  if (!/^Architectures: amd64$/m.test(release) || !/^Components: main$/m.test(release) || !/^Suite: stable$/m.test(release) || !/^SHA256:$/m.test(release)) throw new Error("linux_apt_release_invalid");
  writeFileSync(layout.release, release, { flag: "wx", mode: 0o644 });
  return layout;
}

export function archiveLinuxAptRepository(repositoryRoot, archivePath) {
  if (process.platform !== "linux") throw new Error("linux_apt_archive_requires_linux");
  const repository = checkedDirectory(repositoryRoot, "linux_apt_repository"); const output = resolve(archivePath);
  if (existsSync(output)) throw new Error("linux_apt_archive_already_exists");
  run("tar", ["--sort=name", "--owner=0", "--group=0", "--numeric-owner", "--mtime=UTC 1970-01-01", "--format=posix", "-czf", output, "-C", repository, "."], project);
  if (!statSync(output).isFile() || statSync(output).size === 0) throw new Error("linux_apt_archive_invalid");
  return realpathSync(output);
}

function field(text, name) { return new RegExp(`^${name}: (.+)$`, "m").exec(text)?.[1]?.trim(); }
function checkedRegular(input, label) { const path = resolve(input); const metadata = lstatSync(path); if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size === 0) throw new Error(`${label}_regular_file_required`); return realpathSync(path); }
function checkedDirectory(input, label) { const path = resolve(input); const metadata = lstatSync(path); if (!metadata.isDirectory() || metadata.isSymbolicLink()) throw new Error(`${label}_directory_required`); return realpathSync(path); }
function run(command, args, cwd) { const result = spawnSync(command, args, { cwd, encoding: "utf8", windowsHide: true, maxBuffer: 4 * 1024 * 1024 }); if (result.status !== 0 || result.error || result.signal) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 300)}`); return result.stdout; }

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv[2] === "archive") {
      if (!process.argv[3] || !process.argv[4]) throw new Error("linux_apt_archive_arguments_invalid");
      const archive = archiveLinuxAptRepository(process.argv[3], process.argv[4]); process.stdout.write(`Arquivo do repositório apt criado em ${archive}.\n`);
    } else {
      const deb = process.argv[2]; if (!deb) throw new Error("linux_apt_deb_required");
      const layout = buildLinuxAptRepository(deb, process.argv[3]); process.stdout.write(`Repositório apt não assinado criado em ${layout.repository}.\n`);
    }
  } catch { process.stderr.write("Build do repositório apt recusado: build_failed\n"); process.exitCode = 1; }
}
