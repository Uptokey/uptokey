import { chmodSync, copyFileSync, existsSync, mkdirSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compiledVersionDefineArgs, updateOriginDefineArgs, updateTrustDefineArgs } from "./build-update-trust.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function linuxFlatpakLayout(outputRoot = resolve(root, "dist")) {
  return {
    stage: resolve(outputRoot, "linux-flatpak-stage"),
    executable: resolve(outputRoot, "linux-flatpak-stage", "uptokey"),
    nativeModule: resolve(outputRoot, "linux-flatpak-stage", "uptokey-linux-secret-portal.node"),
    license: resolve(outputRoot, "linux-flatpak-stage", "LICENSE"),
    build: resolve(outputRoot, "flatpak-build"),
    repository: resolve(outputRoot, "flatpak-repo"),
    bundle: resolve(outputRoot, "uptokey-linux.flatpak"),
  };
}

export function buildLinuxFlatpak(outputRoot) {
  if (process.platform !== "linux") throw new Error("linux_flatpak_build_requires_linux");
  const layout = linuxFlatpakLayout(outputRoot ? resolve(outputRoot) : undefined);
  for (const path of [layout.stage, layout.build, layout.repository, layout.bundle]) if (existsSync(path)) throw new Error("linux_flatpak_output_already_exists");
  const nativeRoot = resolve(root, "native", "linux-secret-portal");
  run("cargo", ["build", "--release", "--locked"], nativeRoot);
  const nativeLibrary = realpathSync(resolve(nativeRoot, "target", "release", "libuptokey_linux_secret_portal.so"));
  mkdirSync(layout.stage, { recursive: true });
  run("bun", ["build", "--compile", ...updateTrustDefineArgs(), ...updateOriginDefineArgs(), ...compiledVersionDefineArgs(), "--define", 'UPTOKEY_LINUX_PACKAGE_CHANNEL="flatpak"', "src/cli.ts", "--outfile", layout.executable], root);
  copyFileSync(nativeLibrary, layout.nativeModule, 1);
  copyFileSync(resolve(root, "LICENSE"), layout.license, 1);
  chmodSync(layout.executable, 0o755); chmodSync(layout.nativeModule, 0o755);
  run("flatpak-builder", ["--disable-rofiles-fuse", layout.build, resolve(root, "packaging", "linux", "com.uptokey.proxy.yml")], root);
  run("flatpak", ["build-export", layout.repository, layout.build], root);
  run("flatpak", ["build-bundle", layout.repository, layout.bundle, "com.uptokey.proxy"], root);
  for (const path of [layout.executable, layout.nativeModule, layout.license, layout.bundle]) if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error("linux_flatpak_artifact_invalid");
  return layout;
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { const layout = buildLinuxFlatpak(process.argv[2]); process.stdout.write(`Flatpak Linux não assinado criado em ${layout.bundle}.\n`); }
  catch { process.stderr.write("Build Flatpak recusado: build_failed\n"); process.exitCode = 1; }
}
