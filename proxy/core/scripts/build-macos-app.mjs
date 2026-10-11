import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";
import { compiledVersionDefineArgs, requiredCompiledVersion, updateOriginDefineArgs, updateTrustDefineArgs } from "./build-update-trust.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

export function macosBundleLayout(outputRoot = resolve(root, "dist", "Uptokey.app")) {
  return {
    app: outputRoot,
    executable: resolve(outputRoot, "Contents", "MacOS", "uptokey"),
    nativeModule: resolve(outputRoot, "Contents", "Frameworks", "uptokey-macos-protected-keyring.node"),
    updateHelper: resolve(outputRoot, "Contents", "Helpers", "uptokey-update-helper"),
    license: resolve(outputRoot, "Contents", "Resources", "LICENSE"),
    infoPlist: resolve(outputRoot, "Contents", "Info.plist"),
  };
}

export function buildMacosApp(outputRoot) {
  if (process.platform !== "darwin") throw new Error("macos_app_build_requires_macos");
  const layout = macosBundleLayout(outputRoot ? resolve(outputRoot) : undefined);
  if (existsSync(layout.app)) throw new Error("macos_app_output_already_exists");
  const nativeRoot = resolve(root, "native", "macos-protected-keyring");
  run("cargo", ["build", "--release", "--locked"], nativeRoot);
  const nativeLibrary = realpathSync(resolve(nativeRoot, "target", "release", "libuptokey_macos_protected_keyring.dylib"));
  mkdirSync(dirname(layout.executable), { recursive: true });
  mkdirSync(dirname(layout.nativeModule), { recursive: true });
  mkdirSync(dirname(layout.updateHelper), { recursive: true });
  mkdirSync(dirname(layout.license), { recursive: true });
  const buildVersion = requiredCompiledVersion();
  const defines = [...updateTrustDefineArgs(), ...updateOriginDefineArgs(), ...compiledVersionDefineArgs(buildVersion)];
  run("bun", ["build", "--compile", ...defines, "src/cli.ts", "--outfile", layout.executable], root);
  run("bun", ["build", "--compile", ...defines, "scripts/macos-update-helper-cli.mjs", "--outfile", layout.updateHelper], root);
  copyFileSync(nativeLibrary, layout.nativeModule, 1);
  materializeMacosInfoPlist(resolve(root, "packaging", "macos", "Info.plist"), layout.infoPlist, buildVersion);
  copyFileSync(resolve(root, "LICENSE"), layout.license, 1);
  chmodSync(layout.executable, 0o755); chmodSync(layout.updateHelper, 0o755); chmodSync(layout.nativeModule, 0o755);
  for (const path of [layout.executable, layout.updateHelper, layout.nativeModule, layout.infoPlist, layout.license]) if (!statSync(path).isFile() || statSync(path).size === 0) throw new Error("macos_app_file_invalid");
  return layout;
}

export function materializeMacosInfoPlist(templatePath, outputPath, buildVersion) {
  const version = requiredCompiledVersion(buildVersion); const template = readFileSync(templatePath, "utf8");
  const marker = "__UPTOKEY_BUILD_VERSION__";
  if (template.split(marker).length !== 2) throw new Error("macos_info_plist_version_marker_invalid");
  writeFileSync(outputPath, template.replace(marker, version), { flag: "wx" });
}

function run(command, args, cwd) {
  const result = spawnSync(command, args, { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`${command}_failed:${String(result.stderr || result.stdout).replace(/[\r\n]+/g, " ").slice(0, 300)}`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  try { const layout = buildMacosApp(process.argv[2]); process.stdout.write(`App macOS não assinado criado em ${layout.app}.\n`); }
  catch { process.stderr.write("Build macOS recusado: build_failed\n"); process.exitCode = 1; }
}
