#!/usr/bin/env node
import { mkdtempSync, cpSync, writeFileSync, readFileSync, rmSync, mkdirSync, readdirSync, lstatSync, existsSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { createHash } from "node:crypto";
import { tmpdir } from "node:os";
import { join, resolve, dirname, relative, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { QUIMERA_DEV_DEPENDENCIES, QUIMERA_DEV_PROFILE, packageFiles, verifyStagedPackage, verifyArtifact } from "./verify-beta-artifact.mjs";
import { extractRuntimeSpecifiers, frontendPackageFiles } from "./beta-runtime-contract.mjs";
export { extractRuntimeSpecifiers } from "./beta-runtime-contract.mjs";
import { portableDependencies } from "../src/tui/portable-runtime.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Shipped docs whose canonical location is no longer the core package root.
 * Keeps pack:beta working after the workspace reorganization without restoring
 * deleted files or keeping duplicated copies editable in the package tree.
 */
export const SHIPPED_FILE_SOURCES = Object.freeze({
  "FIRST-RUN-BETA.md": "../../docs/beta/FIRST-RUN-BETA.md",
  "SPEC-MCP-V1.md": "../../packaging/npm-uptokey/SPEC-MCP-V1.md",
});

/** Every bundler external the shipped cli.js can import at runtime. Missing entries crash the
 *  installed CLI at startup (ERR_MODULE_NOT_FOUND); keep this in sync with build-npm-package.mjs. */
export const PUBLISHED_RUNTIME_DEPENDENCIES = Object.freeze([
  "@lydell/node-pty",
  "@hpke/core", "@napi-rs/keyring", "@simplewebauthn/server", "eventsource-parser",
  "js-tiktoken", "hono", "@hono/node-server", "@modelcontextprotocol/sdk", "zod",
  "better-sqlite3", "@repomix/tree-sitter-wasms", "tree-sitter-wasm",
]);

// The public terminal uses better-sqlite3 for its local symbol index. Version 13
// ships audited native binaries for every supported target and avoids the
// deprecated prebuild-install hook. The private Quimera composition profile
// remains pinned independently and is never part of this public manifest.
const PUBLIC_DEPENDENCY_VERSIONS = Object.freeze({ "better-sqlite3": "13.0.3" });

function publishedDependency(name, pkg, lock) {
  if (PUBLIC_DEPENDENCY_VERSIONS[name]) return PUBLIC_DEPENDENCY_VERSIONS[name];
  const range = pkg.dependencies[name];
  if (range !== undefined && /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(range)) return range;
  const locked = lock?.packages?.[`node_modules/${name}`]?.version;
  if (/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(locked ?? "")) return locked;
  if (range !== undefined) return range;
  throw new Error(`published_dependency_missing:${name}`);
}

const INTERNAL_FILE_DEPENDENCIES = new Set(["@uptokey/sync-contract"]);

export function packageManifest(pkg, lock, profile = "beta", runtimeSpecifiers = [], frontendInfo) {
  packageFiles(profile);
  const dependencies = {};
  for (const name of PUBLISHED_RUNTIME_DEPENDENCIES) dependencies[name] = publishedDependency(name, pkg, lock);
  for (const name of runtimeSpecifiers) {
    if (INTERNAL_FILE_DEPENDENCIES.has(name) || dependencies[name] !== undefined) continue;
    if (name.startsWith("@opentui/core-")) continue;
    dependencies[name] = publishedDependency(name, pkg, lock);
  }
  const published = {
  name: "uptokey",
  version: pkg.version,
  description: pkg.description,
  license: pkg.license,
  type: "module",
  bin: { uptokey: "dist/cli.js" },
  main: "dist/cli.js",
  files: ["dist", "LICENSE", "README.md", "FIRST-RUN-BETA.md", "SPEC-MCP-V1.md"],
  engines: { node: ">=22.12.0" },
  dependencies,
  publishConfig: { access: "public", tag: "beta" },
  keywords: ["coding-agent", "terminal", "tui", "byok", "llm", "proxy", "openai-compatible", "local-first"]
  };
  if (profile === "beta" && frontendInfo) {
    frontendPackageFiles(frontendInfo);
    if (frontendInfo.platform === "portable") {
      const native = portableDependencies(frontendInfo);
      Object.assign(published.dependencies, native.dependencies);
      published.optionalDependencies = native.optionalDependencies;
      published.os = ["win32", "darwin", "linux"];
      published.cpu = ["x64", "arm64"];
    } else {
      // A self-contained artifact must not install the wrong native binary on another host.
      const [os, cpu] = frontendInfo.platform.split("-");
      published.os = [os]; published.cpu = [cpu];
    }
    published.uptokeyTui = { manifest: "dist/tui/BUILD_INFO.json", entry: "dist/tui/main.js", accessibleEntry: "dist/tui/linear-entry.js", accessibleRuntime: "node", platform: frontendInfo.platform };
  }
  if (profile === "quimera-dev") {
    if (pkg.name !== "@uptokey/proxy-local" || pkg.private !== true) throw new Error("quimera_private_copy_required");
    const dependencies = {};
    for (const name of QUIMERA_DEV_DEPENDENCIES) {
      const entry = lock?.packages?.[`node_modules/${name}`];
      if (!pkg.dependencies?.[name] || lock?.packages?.[""]?.dependencies?.[name] !== pkg.dependencies[name] ||
          !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(entry?.version ?? "") ||
          typeof entry?.integrity !== "string" || !/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/.test(entry.integrity)) {
        throw new Error("quimera_dev_locked_dependency_required");
      }
      dependencies[name] = entry.version;
    }
    delete published.publishConfig;
    Object.assign(published, {
      name: "@uptokey/quimera-proxy-dev", private: true,
      description: "Experimental Quimera CLI and composition worker only; requires separately prepared Windows x64 ABI137 dependencies and application trees.",
      bin: { "uptokey-quimera": "dist/cli.js" }, engines: { node: ">=24.0.0 <25.0.0" }, os: ["win32"], cpu: ["x64"],
      dependencies, quimeraDev: structuredClone(QUIMERA_DEV_PROFILE),
    });
  }
  return published;
}

/** Copies product files and the manifest-verified platform renderer into an empty stage. */
export function stagePackage(sourceRoot, stage, profile = "beta", options = {}) {
  if (!lstatSync(stage).isDirectory() || lstatSync(stage).isSymbolicLink() || readdirSync(stage).length) throw new Error("package_stage_not_empty");
  const pkg = JSON.parse(readFileSync(join(sourceRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(sourceRoot, "package-lock.json"), "utf8"));
  const distDir = resolve(options.distDir ?? join(sourceRoot, "dist"));
  const frontendDir = resolve(options.frontendDir ?? join(distDir, "tui"));
  const checkedFrontendFile = name => {
    let current = frontendDir;
    if (lstatSync(current).isSymbolicLink()) throw new Error("package_link_forbidden");
    for (const component of name.split("/")) { current = join(current, component); if (lstatSync(current).isSymbolicLink()) throw new Error("package_link_forbidden"); }
    if (!lstatSync(current).isFile()) throw new Error("package_source_file_invalid");
    return current;
  };
  let frontendInfo;
  const runtimeSpecifiers = new Set(extractRuntimeSpecifiers(readFileSync(join(distDir, "cli.js"), "utf8")));
  for (const dependency of extractRuntimeSpecifiers(readFileSync(join(distDir, "workspace-context-helper.js"), "utf8"))) runtimeSpecifiers.add(dependency);
  for (const dependency of extractRuntimeSpecifiers(readFileSync(join(distDir, "service-schema-worker.js"), "utf8"))) runtimeSpecifiers.add(dependency);
  if (profile === "beta") {
    if (!existsSync(join(frontendDir, "BUILD_INFO.json"))) throw new Error("beta_frontend_manifest_missing");
    frontendInfo = JSON.parse(readFileSync(checkedFrontendFile("BUILD_INFO.json"), "utf8"));
    for (const name of frontendPackageFiles(frontendInfo).filter(name => name.endsWith(".js"))) {
      for (const dependency of extractRuntimeSpecifiers(readFileSync(checkedFrontendFile(name.slice("dist/tui/".length)), "utf8"))) runtimeSpecifiers.add(dependency);
    }
  }
  const manifest = packageManifest(pkg, lock, profile, [...runtimeSpecifiers].sort(), frontendInfo);
  for (const name of packageFiles(profile, frontendInfo).filter(name => name !== "package.json")) {
    const frontendFile = name.startsWith("dist/tui/");
    const direct = frontendFile ? join(frontendDir, name.slice("dist/tui/".length)) : name.startsWith("dist/") ? join(distDir, name.slice("dist/".length)) : join(sourceRoot, name);
    const source = SHIPPED_FILE_SOURCES[name] && !existsSync(direct) ? join(sourceRoot, SHIPPED_FILE_SOURCES[name]) : direct;
    const target = join(stage, name), stat = lstatSync(source);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("package_source_file_invalid");
    if (frontendFile) checkedFrontendFile(name.slice("dist/tui/".length));
    mkdirSync(dirname(target), { recursive: true });
    cpSync(source, target);
  }
  writeFileSync(join(stage, "package.json"), JSON.stringify(manifest, null, 2) + "\n", { flag: "wx" });
  return { ...verifyStagedPackage(stage, profile), manifest };
}

// ── Deterministic tarball (tar + gzip without npm) ─────────────────────────
// npm pack embeds build-time metadata (file mtimes, gzip MTIME) that makes two
// packs of identical content differ byte-wise. This writer emits a fixed
// header layout with mtime 0, sorted entry order and a zeroed gzip MTIME, so
// the same stage always produces the same bytes on the same zlib version.
// The result is still a valid ustar archive accepted by npm and by the
// in-process verifier (verify-beta-artifact.mjs).

function stageFiles(stage, directory = stage, prefix = "") {
  const files = [];
  for (const name of readdirSync(directory).sort()) {
    const path = join(directory, name);
    const info = lstatSync(path);
    if (info.isSymbolicLink()) throw new Error("package_link_forbidden");
    if (info.isDirectory()) { files.push(...stageFiles(stage, path, `${prefix}${name}/`)); continue; }
    if (!info.isFile()) throw new Error("package_file_invalid");
    files.push({ name: `${prefix}${name}`, path, size: info.size });
  }
  return files;
}

function tarHeader(name, size, mode) {
  let prefix = "";
  if (Buffer.byteLength(name, "utf8") > 100) {
    const split = [...name.matchAll(/\//g)].map(match => match.index).reverse().find(index =>
      Buffer.byteLength(name.slice(index + 1), "utf8") <= 100 && Buffer.byteLength(name.slice(0, index), "utf8") <= 155);
    if (split === undefined) throw new Error(`package_tar_name_too_long:${name}`);
    prefix = name.slice(0, split); name = name.slice(split + 1);
  }
  const header = Buffer.alloc(512);
  const put = (offset, value, length) => { const text = String(value); Buffer.from(text.slice(0, length), "utf8").copy(header, offset); };
  Buffer.from(name, "utf8").copy(header, 0);
  Buffer.from(prefix, "utf8").copy(header, 345);
  put(100, `0000${mode.toString(8)}`.slice(-7), 8);        // mode, NUL-terminated octal
  put(108, "0000000", 8);                                   // uid
  put(116, "0000000", 8);                                   // gid
  put(124, size.toString(8).padStart(11, "0"), 12);         // size, octal + space
  put(136, "00000000000", 12);                              // mtime 0
  header.fill(0x20, 148, 156);                              // chksum placeholder
  header[156] = 0x30;                                       // typeflag '0'
  Buffer.from("ustar").copy(header, 257);
  Buffer.from("00").copy(header, 263);
  put(265, "root", 32);                                     // uname
  put(297, "root", 32);                                     // gname
  put(329, "0000000", 8);                                   // devmajor
  put(337, "0000000", 8);                                   // devminor
  // checksum over all 512 bytes with chksum field as spaces
  const sum = header.reduce((acc, byte) => acc + byte, 0);
  put(148, sum.toString(8).padStart(6, "0"), 7);
  header[155] = 0x20;
  return header;
}

export function writeDeterministicTarball(stage, destination) {
  if (!existsSync(stage) || !lstatSync(stage).isDirectory()) throw new Error("package_stage_missing");
  mkdirSync(dirname(destination), { recursive: true });
  const files = stageFiles(stage);
  const chunks = [];
  for (const file of files) {
    const data = readFileSync(file.path);
    chunks.push(tarHeader(`package/${file.name}`, data.length, ["dist/cli.js", "dist/tui/runtime/bun"].includes(file.name) ? 0o755 : 0o644));
    chunks.push(data);
    const padding = (512 - (data.length % 512)) % 512;
    if (padding) chunks.push(Buffer.alloc(padding));
  }
  chunks.push(Buffer.alloc(1024)); // two zero blocks
  const gz = gzipSync(Buffer.concat(chunks), { level: 9 });
  gz.writeUInt32LE(0, 4); // gzip MTIME -> 0 (header only; CRC/ISIZE untouched)
  writeFileSync(destination, gz);
  return { destination, files: files.length, sha256: createHash("sha256").update(gz).digest("hex") };
}

export function packMain(args = process.argv.slice(2), sourceRoot = root) {
  const flags = new Set();
  let outDir = sourceRoot;
  const sourceOptions = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--out") {
      if (index + 1 >= args.length) throw new Error("package_arguments_invalid");
      outDir = resolve(args[index + 1]);
      index += 1;
    } else if (["--dist-dir", "--frontend-dir"].includes(arg)) {
      if (index + 1 >= args.length || args[index + 1].startsWith("--")) throw new Error("package_arguments_invalid");
      sourceOptions[arg === "--dist-dir" ? "distDir" : "frontendDir"] = resolve(args[++index]);
    } else if (["--quimera-dev", "--dry-run", "--deterministic"].includes(arg)) {
      flags.add(arg);
    } else {
      positional.push(arg);
    }
  }
  if (positional.length > 0) throw new Error("package_arguments_invalid");
  const profile = flags.has("--quimera-dev") ? "quimera-dev" : "beta";
  const dryRun = flags.has("--dry-run");
  const deterministic = flags.has("--deterministic");
  const stage = mkdtempSync(join(tmpdir(), "uptokey-npm-pack-"));
  try {
    const result = stagePackage(sourceRoot, stage, profile, sourceOptions);
    if (dryRun) {
      process.stdout.write(JSON.stringify({ dryRun: true, profile, files: result.files, completeApplication: false,
        name: result.manifest.name, engines: result.manifest.engines, dependencies: result.manifest.dependencies,
        ...(profile === "quimera-dev" ? { quimeraDev: result.manifest.quimeraDev } : {}) }) + "\n");
      return 0;
    }
    if (deterministic) {
      const filename = `${result.manifest.name}-${result.manifest.version}.tgz`;
      const packed = writeDeterministicTarball(stage, join(outDir, filename));
      const verified = verifyArtifact(packed.destination, profile);
      if (verified.sha256 !== packed.sha256) throw new Error("package_deterministic_sha_mismatch");
      process.stdout.write(`${JSON.stringify({ packed: packed.destination, files: packed.files, sha256: packed.sha256, verifiedFiles: verified.files })}\n`);
      return 0;
    }
// Invoke npm's JS entrypoint on Windows so no shell interpolation is involved.
const npmExecutable = process.platform === "win32"
  ? process.execPath
  : "npm";
const npmArgs = process.platform === "win32"
  ? [join(dirname(process.execPath), "node_modules", "npm", "bin", "npm-cli.js"), "pack", "--pack-destination", outDir]
  : ["pack", "--pack-destination", outDir];
const pack = spawnSync(npmExecutable, npmArgs, { cwd: stage, encoding: "utf8", windowsHide: true });
process.stdout.write(pack.stdout || "");
process.stderr.write(pack.stderr || "");
// Keep native spawn details out of stderr; the release harness only needs a
// stable, opaque failure marker and the exit status remains authoritative.
    if (pack.error) process.stderr.write("npm_pack_spawn_failed\n");
    return pack.status ?? 1;
  } finally {
    // stage is the absolute directory returned by mkdtemp above; never an input path.
    rmSync(stage, { recursive: true, force: true });
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = packMain();
