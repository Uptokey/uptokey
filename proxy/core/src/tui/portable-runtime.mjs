import { existsSync, readFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

// npm selects native optional packages by OS/CPU/libc. Application code stays shared.
export const NATIVE_TARGETS = Object.freeze([
  "win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64",
  "linux-x64", "linux-arm64", "linux-x64-musl", "linux-arm64-musl",
]);
export const BUN_PACKAGE_TARGETS = Object.freeze({
  "win32-x64": "@oven/bun-windows-x64",
  "win32-arm64": "@oven/bun-windows-aarch64",
  "darwin-x64": "@oven/bun-darwin-x64",
  "darwin-arm64": "@oven/bun-darwin-aarch64",
  "linux-x64": "@oven/bun-linux-x64",
  "linux-arm64": "@oven/bun-linux-aarch64",
  "linux-x64-musl": "@oven/bun-linux-x64-musl",
  "linux-arm64-musl": "@oven/bun-linux-aarch64-musl",
});
const exactVersion = value => typeof value === "string" && /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(value);
function dependencyManifest(artifact, name) {
  for (let directory = resolve(artifact); ; directory = dirname(directory)) {
    const candidate = join(directory, "node_modules", name, "package.json");
    if (existsSync(candidate)) return candidate;
    if (dirname(directory) === directory) break;
  }
  throw new Error(`portable_dependency_missing:${name}`);
}
export function portableDependencies(info) {
  if (info.platform !== "portable" || info.runtime !== "npm:bun" || !exactVersion(info.bun)
    || !/^@opentui\/core@\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(info.nativePackage ?? "")) {
    throw new Error("portable_runtime_manifest_invalid");
  }
  const version = info.nativePackage.slice(info.nativePackage.lastIndexOf("@") + 1);
  return { dependencies: {}, optionalDependencies: Object.fromEntries([
    ...NATIVE_TARGETS.map(target => [`@opentui/core-${target}`, version]),
    ...NATIVE_TARGETS.map(target => [BUN_PACKAGE_TARGETS[target], info.bun]),
  ]) };
}

export function nativeTarget(platform = process.platform, arch = process.arch, glibc = platform === "linux" ? process.report?.getReport()?.header?.glibcVersionRuntime : undefined) {
  const target = `${platform}-${arch}${platform === "linux" && !glibc ? "-musl" : ""}`;
  if (!NATIVE_TARGETS.includes(target)) throw new Error(`portable_platform_unsupported:${target}`);
  return target;
}

/** Resolve only this installed package's pinned runtime; never PATH or another app's Bun. */
export function resolvePortableRuntime(artifact, target = nativeTarget()) {
  const info = JSON.parse(readFileSync(join(artifact, "BUILD_INFO.json"), "utf8"));
  const expected = portableDependencies(info);
  if (!NATIVE_TARGETS.includes(target)) throw new Error(`portable_platform_unsupported:${target}`);
  const bunName = BUN_PACKAGE_TARGETS[target];
  const bunManifest = dependencyManifest(artifact, bunName);
  const bun = JSON.parse(readFileSync(bunManifest, "utf8"));
  if (bun.name !== bunName || bun.version !== expected.optionalDependencies[bunName]) throw new Error("portable_bun_version_mismatch");
  const runtime = resolve(dirname(bunManifest), "bin", target.startsWith("win32-") ? "bun.exe" : "bun");
  const rel = relative(dirname(bunManifest), runtime);
  if (!rel || isAbsolute(rel) || rel.startsWith("..") || !existsSync(runtime)) throw new Error("portable_bun_binary_missing");
  const nativeName = `@opentui/core-${target}`;
  const nativeManifest = dependencyManifest(artifact, nativeName);
  const native = JSON.parse(readFileSync(nativeManifest, "utf8"));
  if (native.name !== nativeName || native.version !== expected.optionalDependencies[nativeName]) throw new Error("portable_renderer_version_mismatch");
  return { runtime, env: target.startsWith("linux-") ? { OPENTUI_LIBC: target.endsWith("-musl") ? "musl" : "glibc" } : {} };
}
