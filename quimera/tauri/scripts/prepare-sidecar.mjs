#!/usr/bin/env node
// Prepare the proxy-local sidecar for the Tauri shell.
//
// Layout (schema 2, "node runtime"): instead of a Bun single-binary compile,
// the sidecar is the real Node runtime (ABI-matched with the shipped native
// addons) plus the verified entry bundles:
//
//   resources/sidecar/
//     uptokey-windows.exe      <- Node runtime (renamed; keeps the installed
//                                 daemon name used by the update trust)
//     cli.js                   <- proxy/core dist/cli.js (never modified)
//     composition-worker.js    <- proxy/core dist/composition-worker.js
//     node_modules/...         <- external runtime deps (native + JS closure)
//     manifest.json            <- schema 2: every file attested (sha256+size)
//
// dist/ is NEVER rewritten by regex or otherwise: entries are copied and
// hashed before/after to prove the core bundle was not mutated.
//
// The Node runtime preserves protocol/storage and runs the real
// composition-worker.js as a real file, so `new Worker(new URL('./worker.js',
// import.meta.url))` resolves normally — no worker is replaced by a stub.

import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync, cpSync, rmSync, chmodSync } from "node:fs";
import { readdirSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve, join, dirname, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { verifySidecar, sha256File } from './verify-sidecar.mjs';
import { validateOutputTarget, createStagingOutput, publishStagingOutput } from './sidecar-output.mjs';
import { parseAcceptedPreparationArgs, validateAcceptedOutput, admitAcceptedSidecarArtifacts,
  stageAcceptedCoreArtifact, stageAcceptedComputerRuntime, verifyAcceptedStagedArtifacts,
  admitAcceptedNodeRuntimeLicense, stageNodeRuntimeLicense } from './accepted-sidecar-artifacts.mjs';
import { extractRuntimeSpecifiers } from '../../../proxy/core/scripts/npm-pack-beta.mjs';
import { CONTEXT_HELPER_ENTRY, contextHelperPackages, contextHelperAttestation } from './context-helper-attestation.mjs';
import { terminalRuntimePackages } from './terminal-runtime-packages.mjs';
import { verifyTerminalRuntime } from './verify-terminal-runtime.mjs';
import { verifyServiceSchemaRuntime } from './verify-service-schema-runtime.mjs';
import { prepareComputerRuntime } from './computer-runtime.mjs';
import { signMacosEmbeddedCore } from '../../../proxy/core/scripts/sign-notarize-macos.mjs';


const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, "..");
const proxyDir = resolve(tauriDir, "../../proxy/core");
const repositoryRoot = resolve(tauriDir, '../..');
let preparation;
try { preparation = parseAcceptedPreparationArgs(process.argv.slice(2), { tauriDir }); }
catch (error) { console.error(error.message); process.exit(2); }
if (preparation.check) {
  try { console.log(JSON.stringify(verifySidecar(preparation.directory))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
  process.exit(process.exitCode || 0);
}
const protectedDirectories = [tauriDir, proxyDir, repositoryRoot, dirname(process.execPath)];
let accepted;
try {
  validateOutputTarget(preparation.directory, protectedDirectories);
  if (preparation.reuseAccepted) {
    validateAcceptedOutput(preparation.directory, repositoryRoot);
    accepted = admitAcceptedSidecarArtifacts(repositoryRoot);
    if (process.env.UPTOKEY_BUILD_VERSION && process.env.UPTOKEY_BUILD_VERSION !== accepted.core.version) throw Error('accepted_build_version_mismatch');
  }
}
catch (error) { console.error(error.message); process.exit(2); }

function sha256Hex(path) {
  return sha256File(path);
}

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, { stdio: "inherit", windowsHide: true, ...options });
  if (result.error) {
    console.error(`Cannot launch ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(" ")}`);
    process.exit(result.status ?? 1);
  }
}

// Default preparation still builds a fresh review artifact. Explicit reuse is
// limited to receipt-pinned artifacts and a fresh candidate output directory.
const reviewDist = accepted?.core.directory ?? resolve(proxyDir, '../../output', `sidecar-build-${Date.now()}-${process.pid}`);
if (accepted) console.log(`Reusing accepted core ${accepted.core.version} and ${accepted.computer.platform} computer binary.`);
else {
  console.log("Building proxy-local...");
  const platformProfile = process.platform === 'linux' ? ['--linux-deb'] : process.platform === 'darwin' ? ['--macos-native'] : [];
  run(process.execPath, [join(proxyDir, "scripts", "build-npm-package.mjs"), ...platformProfile, '--out-dir', reviewDist]);
}

const distCli = join(reviewDist, "cli.js");
const distWorker = join(reviewDist, "composition-worker.js");
const distSchemaWorker = join(reviewDist, "service-schema-worker.js");
const distNotices = join(reviewDist, "THIRD-PARTY-NOTICES.md");
const distHelper = join(reviewDist, CONTEXT_HELPER_ENTRY);
// The installed Debian runtime requires its canonical build-time vault channel.
if (process.platform === 'linux') {
  const info = JSON.parse(readFileSync(join(reviewDist, 'BUILD_INFO.json'), 'utf8'));
  if (info.distributionChannel !== 'native' || info.linuxPackageChannel !== 'deb') {
    throw Error('sidecar_linux_deb_channel_required');
  }
}
if (process.platform === 'darwin') {
  const info = JSON.parse(readFileSync(join(reviewDist, 'BUILD_INFO.json'), 'utf8'));
  if (info.distributionChannel !== 'native') throw Error('sidecar_macos_native_channel_required');
}
if (!existsSync(distCli) || !existsSync(distWorker) || !existsSync(distSchemaWorker) || !existsSync(distHelper) || !existsSync(distNotices) || statSync(distNotices).size === 0) {
  console.error("Required CLI, composition worker or third-party notices not found after build.");
  process.exit(1);
}

// Proxy build version: same rule as proxy-local/scripts/build-npm-package.mjs.
const proxyPkg = JSON.parse(readFileSync(join(proxyDir, "package.json"), "utf8"));
const buildVersion = accepted?.core.version ?? (process.env.UPTOKEY_BUILD_VERSION || proxyPkg.version);
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(buildVersion)) {
  console.error(`compiled_version_invalid:${buildVersion}`);
  process.exit(1);
}
// Informative only: the Tauri shell package version (never used for identity).
const tauriCargo = readFileSync(join(tauriDir, "Cargo.toml"), "utf8");
const packageVersion = tauriCargo.match(/^version\s*=\s*"([^"]+)"/m)?.[1] ?? "0.0.0";

const isWin = process.platform === "win32";
const isMac = process.platform === "darwin";
const runtimePrefix = isMac ? "UptokeyCore.app/Contents/MacOS/" : "";
const binaryName = runtimePrefix + (isWin ? "uptokey-windows.exe" : "uptokey");
// An explicit output allows isolated packaging checks without replacing desktop resources.
// Build/validate beside the destination; a failure preserves the previous package.
const outDir = createStagingOutput(preparation.directory, protectedDirectories);
const runtimeDir = join(outDir, runtimePrefix);
if (isMac) mkdirSync(runtimeDir, { recursive: true });

// --- Node runtime -------------------------------------------------------
const runtimeSource = process.env.UPTOKEY_NODE_RUNTIME || (isMac
  ? join(repositoryRoot, 'experiments/deepseek-workbench/output/node-macos-provenance-20261027', 'node-' + process.arch)
  : process.execPath);
if (!existsSync(runtimeSource)) {
  console.error(`node_runtime_missing:${runtimeSource}`);
  process.exit(1);
}
const nodeLicense = accepted || isMac ? admitAcceptedNodeRuntimeLicense(repositoryRoot, runtimeSource) : undefined;
// The checked archive can originate on another OS and need not be executable there.
const stagedRuntime = join(outDir, binaryName);
if (isMac) {
  cpSync(runtimeSource, stagedRuntime);
  if (sha256Hex(stagedRuntime) !== nodeLicense.nodeSha256) throw Error('accepted_node_runtime_changed');
  chmodSync(stagedRuntime, 0o755);
}
const runtimeAbi = spawnSync(isMac ? stagedRuntime : runtimeSource, ["-p", "process.versions.modules"], { encoding: "utf8", windowsHide: true });
const abi = runtimeAbi.stdout?.trim();
if (runtimeAbi.status !== 0 || !abi) {
  console.error("node_runtime_abi_unreadable");
  process.exit(1);
}
// Composition runtime requires ABI 137 (Node 24) with the shipped SQLite
// addon; reject a mismatched runtime instead of shipping a broken pair.
if (abi !== "137") {
  console.error(`node_runtime_abi_incompatible:${abi} (required: 137)`);
  process.exit(1);
}
console.log(`Packaging Node runtime ${runtimeSource} (ABI ${abi})...`);
if (!isMac) cpSync(runtimeSource, stagedRuntime);
if (nodeLicense) stageNodeRuntimeLicense(outDir, nodeLicense);
if (nodeLicense && sha256Hex(join(outDir, binaryName)) !== nodeLicense.nodeSha256) throw Error('accepted_node_runtime_changed');
if (!isWin && !isMac) chmodSync(stagedRuntime, 0o755);

// Reuse the existing Protected Data keyring binding in the same signed
// sidecar directory as Node and the core bundles. Its bytes are attested below.
if (process.platform === 'darwin') {
  const nativeRoot = join(proxyDir, 'native', 'macos-protected-keyring');
  run('cargo', ['build', '--release', '--locked'], { cwd: nativeRoot });
  const binding = join(nativeRoot, 'target', 'release', 'libuptokey_macos_protected_keyring.dylib');
  if (!existsSync(binding) || statSync(binding).size === 0) throw Error('sidecar_macos_keyring_binding_missing');
  cpSync(binding, join(runtimeDir, 'uptokey-macos-protected-keyring.node'));
}

// Native addon loadability proof against the exact runtime being shipped.
run(isMac ? stagedRuntime : runtimeSource, ["-e", "require('better-sqlite3'); console.log('sqlite-ok')"], { cwd: proxyDir });
run(isMac ? stagedRuntime : runtimeSource, ["-e", "require('@napi-rs/keyring'); console.log('keyring-ok')"], { cwd: proxyDir });

// --- Verified entries (copied, never rewritten) --------------------------
const sourceHashes = [distCli, distWorker, distSchemaWorker, distNotices, distHelper].map(sha256Hex);
if (accepted) stageAcceptedCoreArtifact(runtimeDir, accepted.core);
else {
  cpSync(distCli, join(runtimeDir, "cli.js"));
  cpSync(distWorker, join(runtimeDir, "composition-worker.js"));
  cpSync(distSchemaWorker, join(runtimeDir, "service-schema-worker.js"));
  cpSync(distNotices, join(runtimeDir, "THIRD-PARTY-NOTICES.md"));
  cpSync(distHelper, join(runtimeDir, CONTEXT_HELPER_ENTRY));
}
writeFileSync(join(runtimeDir,'package.json'),JSON.stringify({name:'uptokey-desktop-sidecar',private:true,type:'module',version:buildVersion},null,2)+'\n');
if ([distCli, distWorker, distSchemaWorker, distNotices, distHelper].some((file, index) => sha256Hex(file) !== sourceHashes[index])) {
  console.error("sidecar_prepare_mutated_core_bundle");
  process.exit(1);
}

// --- External runtime dependencies ----------------------------------------
// cli.js/worker.js are bundled except the packages below (external). Copy the
// transitive runtime closure so Node can resolve them inside the sidecar dir.
const rootExternals = [...new Set([
  "better-sqlite3",
  "@napi-rs/keyring",
  "@langchain/langgraph",
  "@langchain/langgraph-checkpoint",
  "@langchain/langgraph-checkpoint-sqlite",
  "@langchain/langgraph-sdk",
  "@langchain/protocol",
  "@langchain/core",
  "langsmith",
  "@modelcontextprotocol/sdk",
  "@hpke/core",
  "@simplewebauthn/server",
  "eventsource-parser",
  "hono",
  "@hono/node-server",
  "zod",
  "js-tiktoken",
  ...extractRuntimeSpecifiers(readFileSync(distCli, 'utf8')),
  ...extractRuntimeSpecifiers(readFileSync(distWorker, 'utf8')),
  ...extractRuntimeSpecifiers(readFileSync(distSchemaWorker, 'utf8')),
  ...extractRuntimeSpecifiers(readFileSync(distHelper, 'utf8')),
])];
const requireFromCore = createRequire(join(proxyDir, "noop.js"));
const nmRoot = join(proxyDir, "node_modules");
function packageDirOf(specifier) {
  // Resolve the package root even when the external is an exported subpath.
  // Treating the full specifier as a package directory made scoped ESM-only
  // exports fall through to CommonJS require.resolve and fail during Linux
  // sidecar assembly.
  const segments = specifier.split("/");
  const packageSegments = segments[0]?.startsWith("@") ? 2 : 1;
  if (segments.length < packageSegments || segments.slice(0, packageSegments).some(part => !part)) {
    throw new Error(`external_package_specifier_invalid:${specifier}`);
  }
  const candidate = join(nmRoot, ...segments.slice(0, packageSegments));
  if (existsSync(join(candidate, "package.json"))) return candidate;
  {
    // Fallback: full Node resolution when the package root resolves cleanly.
    const entry = requireFromCore.resolve(specifier);
    const parts = entry.split(sep);
    const idx = parts.lastIndexOf("node_modules");
    if (idx === -1) throw new Error(`external_not_in_node_modules:${specifier}`);
    const scoped = parts[idx + 1]?.startsWith("@");
    const end = idx + 1 + (scoped ? 2 : 1);
    return parts.slice(0, end).join(sep);
  }
  return candidate;
}
const closure = new Set();
function collect(pkgDir) {
  if (closure.has(pkgDir)) return;
  closure.add(pkgDir);
  let pkg;
  try { pkg = JSON.parse(readFileSync(join(pkgDir, "package.json"), "utf8")); } catch { return; }
  for (const dep of Object.keys(pkg.dependencies || {})) {
    try { collect(packageDirOf(dep)); } catch { /* bundled into the entry or dev-only */ }
  }
}
for (const spec of rootExternals) collect(packageDirOf(spec));
const helperPackages = contextHelperPackages(nmRoot, readFileSync(distHelper, 'utf8'));
for (const directory of helperPackages) closure.add(directory);
if (rootExternals.includes('@lydell/node-pty')) {
  for (const directory of terminalRuntimePackages(nmRoot)) closure.add(directory);
}
for (const pkgDir of closure) {
  const rel = relative(nmRoot, pkgDir);
  cpSync(pkgDir, join(runtimeDir, "node_modules", rel), { recursive: true });
}
console.log(`Copied ${closure.size} external dependency packages into the sidecar.`);

// Remove zero-byte files (non-functional placeholders) so attestation stays strict.
function pruneEmpty(dir) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) pruneEmpty(full);
    else if (entry.isFile() && statSync(full).size === 0) rmSync(full, { force: true });
  }
}
pruneEmpty(outDir);

// --- Manifest v2: every file attested -------------------------------------
// The Rust window helper shares this attested bundle; it adds no Node/core runtime.
const computerMcp = accepted ? stageAcceptedComputerRuntime(outDir, accepted.computer) : prepareComputerRuntime(outDir);
function walkFiles(dir, base) {
  const out = {};
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    const rel = join(base, entry.name).split(sep).join("/");
    if (entry.isDirectory()) Object.assign(out, walkFiles(full, rel));
    else if (entry.isFile()) {
      out[rel] = { sha256: sha256Hex(full), size_bytes: statSync(full).size };
    }
  }
  return out;
}
if (isMac) {
  const info = '<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "https://www.apple.com/DTDs/PropertyList-1.0.dtd"><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.uptokey.proxy</string><key>CFBundleExecutable</key><string>uptokey</string><key>CFBundlePackageType</key><string>APPL</string><key>CFBundleVersion</key><string>' + packageVersion + '</string></dict></plist>';
  writeFileSync(join(outDir, 'UptokeyCore.app/Contents/Info.plist'), info, { flag: 'wx' });
  signMacosEmbeddedCore({ appPath: join(outDir, 'UptokeyCore.app'), identity: process.env.UPTOKEY_APPLE_SIGNING_IDENTITY,
    provisioningProfile: process.env.UPTOKEY_APPLE_PROVISIONING_PROFILE, teamId: process.env.UPTOKEY_APPLE_TEAM_ID });
}
const files = walkFiles(outDir, "");
if (nodeLicense && ((!isMac && files[binaryName]?.sha256 !== nodeLicense.nodeSha256) || files['NODE-LICENSE.txt']?.sha256 !== nodeLicense.licenseSha256)) throw Error('accepted_node_runtime_or_license_changed');
if (!files[binaryName] || !files[runtimePrefix+"cli.js"] || !files[runtimePrefix+"composition-worker.js"] || !files[runtimePrefix+"service-schema-worker.js"]) {
  console.error("sidecar_required_files_missing");
  process.exit(1);
}

const manifest = {
  schema_version: 2,
  runtime: "node",
  binary_name: binaryName,
  entry: runtimePrefix + "cli.js",
  worker: runtimePrefix + "composition-worker.js",
  serviceSchemaWorker: runtimePrefix + "service-schema-worker.js",
  build_version: buildVersion,
  package_version: packageVersion,
  target: process.platform,
  files,
  computerMcp,

  ...(nodeLicense ? { runtimeLicense: {file:'NODE-LICENSE.txt',version:nodeLicense.version,sourceUrl:nodeLicense.sourceUrl,
    nodeSha256:files[binaryName].sha256,...(isMac ? {sourceNodeSha256:nodeLicense.nodeSha256} : {}),sha256:nodeLicense.licenseSha256,receipt:nodeLicense.receipt,
    signatureVerified:nodeLicense.signatureVerified,...(isMac ? {signatureReceipt:nodeLicense.signatureReceipt} : {})} } : {}),
  ...(accepted ? { reusedArtifacts: {
    core: { receipt: accepted.coreReceipt, version: accepted.core.version, files: accepted.core.files },
    computer: { receipt: accepted.computerReceipt, binarySha256: accepted.computer.binarySha256,
      sourceManifestSha256: accepted.computer.manifestSha256, helperClosure: 'current-canonical-source' },
  } } : {}),
  contextHelper: contextHelperAttestation(files, binaryName, helperPackages, nmRoot, readFileSync(distHelper, 'utf8')),
};
writeFileSync(join(outDir, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`Sidecar prepared at ${outDir} (${Object.keys(files).length} attested files)`);
console.log("--- Verifying sidecar integrity ---");
run(process.execPath, [join(here, "verify-sidecar.mjs"), outDir]);
// Integrity alone cannot detect a missing runtime import. Verify the packaged
// entry actually loads before atomically replacing desktop resources.
run(join(outDir,binaryName),[join(runtimeDir,'cli.js'),'--help'],{cwd:runtimeDir});
console.log(JSON.stringify({serviceSchemaRuntime: verifyServiceSchemaRuntime(join(outDir, binaryName), runtimeDir)}));
if (rootExternals.includes('@lydell/node-pty')) {
  console.log(JSON.stringify({terminalRuntime: verifyTerminalRuntime(join(outDir, binaryName), runtimeDir)}));
}
if (accepted) {
  verifyAcceptedStagedArtifacts(outDir, accepted);
  validateAcceptedOutput(preparation.directory, repositoryRoot);
}
const backup = publishStagingOutput(outDir, preparation.directory, protectedDirectories);
console.log(`Sidecar published at ${preparation.directory}`);
if (backup) console.log(`Previous sidecar preserved at ${backup}`);
