#!/usr/bin/env node
// Native release artifacts (no installer bundling, signing or publication):
//   1. verify the prepared Harness resources (legacy PWA requires --interface=shell)
//   2. preserve the single attested sidecar/core (schema 2, node runtime)
//   3. locked Cargo release with Tauri's production protocol (compiled app)
//   4. emit to a fresh output/bridge-integracao/native-release-* directory:
//        - artifact files (app exe + sidecar directory)
//        - integrity.json        : SHA-256 of every artifact (integrity hash)
//        - sbom.cdx.json         : CycloneDX 1.4 SBOM (real component list)
//        - provenance.json       : build inputs/outputs/tools (provenance)
//
// Differentiation (deliberate): integrity hash != publisher signature !=
// build provenance. Native platform signing and the updater's separate trust
// remain external; neither is fabricated by this build script.
//
// Installer bundling (NSIS/MSI/dmg/deb) requires @tauri-apps/cli on each
// target runner; tauri.conf.json already declares the bundle targets. This
// script proves the compiled app + attested sidecar, not an installed app.
import {spawnSync} from 'node:child_process';
import {existsSync, mkdirSync, copyFileSync, cpSync, readFileSync, writeFileSync, readdirSync} from 'node:fs';
import {join, resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash, randomUUID} from 'node:crypto';
import {releaseBuildEnvironment, assertNoPersonalBuildPaths} from './release-cargo.mjs';
import {createReleaseBuildPlan, releaseSourceCommit, releaseIdentityOptions, releaseFrontendInputs, releaseFrontendFiles, assertReleaseFrontendUnchanged, releaseCanonicalInputs, assertReleaseCanonicalInputsUnchanged} from './release-build-plan.mjs';
import {verifyHarnessPayload} from './frontend-hook.mjs';
import {verifySidecar} from './verify-sidecar.mjs';
import {createNativeArtifactVersionEvidence} from '../../../proxy/core/scripts/native-artifact-version-evidence.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '..');
const repoRoot = resolve(tauriDir, '../..');
const pwaDir = resolve(tauriDir, '../uptokey/uptokey-pwa');
const outDir = resolve(repoRoot, 'output/bridge-integracao', `native-release-${new Date().toISOString().replace(/[:.]/g, '-')}-${randomUUID()}`);
let plan;
try { plan = createReleaseBuildPlan(process.argv.slice(2)); }
catch (error) { console.error(error.message); process.exit(2); }
const cargoArgs = plan.args;
if (plan.printPlan) {
  console.log(JSON.stringify({...plan, outputDirectory: outDir}));
  process.exit(0);
}
let sourceCommit;
try {
  sourceCommit = releaseSourceCommit(plan, process.env);
  if (plan.interfaceMode === 'harness' && ['TAURI_CONFIG', 'CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET'].some(name => process.env[name])) {
    throw new Error('release_untracked_build_override');
  }
} catch (error) { console.error(error.message); process.exit(2); }
const harness = plan.interfaceMode === 'harness';
const sidecarDirectory = join(tauriDir, 'resources', 'sidecar');
// Refuse stale/legacy resources before Cargo or an output directory is created.
if (harness) verifyHarnessPayload(sidecarDirectory);
const harnessCanonicalBeforeBuild = harness ? releaseCanonicalInputs(tauriDir, plan) : null;
const harnessFrontendBeforeBuild = harness ? releaseFrontendInputs(tauriDir, plan) : null;
const harnessManifestBeforeBuild = harness ? sha256Hex(join(sidecarDirectory, 'manifest.json')) : null;

function run(cmd, args, options = {}) {
  const result = spawnSync(cmd, args, {stdio: 'inherit', windowsHide: true, ...options});
  if (result.error) {
    console.error(`Cannot launch ${cmd}: ${result.error.message}`);
    process.exit(1);
  }
  if (result.status !== 0) {
    console.error(`Failed: ${cmd} ${args.join(' ')}`);
    process.exit(result.status ?? 1);
  }
}
function sha256Hex(path) {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}
function toolVersion(cmd, args = ['--version']) {
  const result = spawnSync(cmd, args, {encoding: 'utf8', windowsHide: true});
  return result.status === 0 ? String(result.stdout).trim().split('\n')[0] : 'unavailable';
}
const startedAt = new Date().toISOString();
const tools = {
  node: toolVersion(process.execPath),
  cargo: toolVersion('cargo'),
  rustc: toolVersion('rustc'),
  bun: toolVersion(process.platform === 'win32' ? 'bun.exe' : 'bun'),
};

const {skipPwaBuild, reuseSidecarSha, reuseAppSha, reusePreparedArtifacts} = plan;
const appExe = join(tauriDir, 'target', 'release', process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri');
let pwaBuildState = harness ? 'not_used' : 'built';
if (harness) {
  console.log('--- Harness selected; prepared resources verified, no PWA or second core build ---');
} else if (skipPwaBuild) {
  pwaBuildState = 'skipped_by_flag';
  console.log('PWA build skipped (--skip-pwa-build): dist reused; interface version gate blocks unversioned rebuild (B9 owns version:interface).');
} else if (process.platform === 'win32') {
  run(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', 'npm run build'], {cwd: pwaDir});
} else {
  run('npm', ['run', 'build'], {cwd: pwaDir});
}
if (reusePreparedArtifacts) {
  const manifestPath = join(tauriDir, 'resources', 'sidecar', 'manifest.json');
  if (!existsSync(manifestPath) || sha256Hex(manifestPath) !== reuseSidecarSha || !existsSync(appExe) || sha256Hex(appExe) !== reuseAppSha) {
    console.error('reuse_artifact_hash_mismatch');
    process.exit(2);
  }
  console.log('--- Reusing explicitly pinned, previously verified sidecar and compiled Tauri app ---');
} else {
  if (!harness) {
    console.log('--- Preparing attested sidecar ---');
    run(process.execPath, [join(here, 'prepare-sidecar.mjs')], {cwd: tauriDir});
  }
  console.log('--- Generating bundle icons from licensed brand asset ---');
  run(process.execPath, [join(here, 'generate-icons.mjs')], {cwd: tauriDir});
  console.log('--- Building Tauri app (release) ---');
  run('cargo', cargoArgs, {cwd: tauriDir, env: releaseBuildEnvironment()});
}

if (!existsSync(appExe)) {
  console.error('release_binary_missing');
  process.exit(1);
}
const canonicalAfterBuild = releaseCanonicalInputs(tauriDir, plan);
if (harness) assertReleaseCanonicalInputsUnchanged(harnessCanonicalBeforeBuild, canonicalAfterBuild);
const canonicalInputs = harness ? harnessCanonicalBeforeBuild : canonicalAfterBuild;
assertNoPersonalBuildPaths(readFileSync(appExe));
const appSha256 = sha256Hex(appExe);
mkdirSync(outDir, {recursive: true});
let nativeIdentity;
if (harness) {
  const {version} = JSON.parse(readFileSync(join(tauriDir, 'tauri.harness.conf.json'), 'utf8'));
  // This reviewed command is checked statically and bounded before execution.
  // An old shell binary cannot be relabelled as a Harness build by hash alone.
  nativeIdentity = createNativeArtifactVersionEvidence(releaseIdentityOptions({plan, sourceCommit,
    artifactPath: appExe, outputPath: join(outDir, 'native-build-identity.json'), sha256: appSha256, version})).receipt;
}
copyFileSync(appExe, join(outDir, process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri'));
cpSync(sidecarDirectory, join(outDir, 'sidecar'), {recursive: true});
if (harness) verifyHarnessPayload(join(outDir, 'sidecar'));
else verifySidecar(join(outDir, 'sidecar'));
if (harness && sha256Hex(join(outDir, 'sidecar', 'manifest.json')) !== harnessManifestBeforeBuild) throw new Error('release_harness_manifest_changed');

const sidecarManifest = JSON.parse(readFileSync(join(outDir, 'sidecar', 'manifest.json'), 'utf8'));
const frontend = releaseFrontendInputs(tauriDir, plan);
if (harness) assertReleaseFrontendUnchanged(harnessFrontendBeforeBuild, frontend);
const {directory: frontendDirectory, prefix: frontendPrefix, files: frontendFiles} = frontend;
cpSync(frontendDirectory, join(outDir, frontendPrefix), {recursive: true});
const copiedFrontendDirectory = join(outDir, frontendPrefix);
assertReleaseFrontendUnchanged({...frontend, directory: copiedFrontendDirectory}, releaseFrontendFiles(copiedFrontendDirectory, frontendPrefix));

const integrity = {};
integrity[process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri'] = appSha256;
integrity['sidecar/manifest.json'] = sha256Hex(join(outDir, 'sidecar', 'manifest.json'));
for (const rel of Object.keys(sidecarManifest.files)) {
  integrity[`sidecar/${rel}`] = sidecarManifest.files[rel].sha256;
}
for (const rel of Object.keys(frontendFiles)) {
  const digest = frontend.hashes[rel];
  if (sha256Hex(join(outDir, frontendPrefix, rel)) !== digest) throw new Error('release_assets_copy_changed');
  integrity[`${frontendPrefix}/${rel}`] = digest;
}
if (sha256Hex(join(outDir, process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri')) !== appSha256) throw new Error('release_binary_copy_changed');
if (nativeIdentity) integrity['native-build-identity.json'] = sha256Hex(join(outDir, 'native-build-identity.json'));
writeFileSync(join(outDir, 'integrity.json'), JSON.stringify({generatedAt: startedAt, algorithm: 'sha256', files: integrity}, null, 2) + '\n');

// --- SBOM (CycloneDX 1.4) ---------------------------------------------------
function parseCargoLock() {
  const raw = readFileSync(join(tauriDir, 'Cargo.lock'), 'utf8');
  const packages = [];
  for (const block of raw.split('[[package]]').slice(1)) {
    const name = block.match(/^name\s*=\s*"([^"]+)"/m)?.[1];
    const version = block.match(/^version\s*=\s*"([^"]+)"/m)?.[1];
    const source = block.match(/^source\s*=\s*"([^"]+)"/m)?.[1];
    const checksum = block.match(/^checksum\s*=\s*"([^"]+)"/m)?.[1];
    const deps = [...block.matchAll(/^"([^" ]+)"$/gm)].map(m => m[1]).filter(d => d !== name);
    if (name && version) packages.push({name, version, source: source || 'local', checksum: checksum || null, dependencies: deps});
  }
  return packages;
}
function parseNodePackages(sidecarNodeModules) {
  const out = [];
  const root = join(sidecarNodeModules);
  if (!existsSync(root)) return out;
  for (const dir of readdirSync(root, {withFileTypes: true})) {
    const scoped = dir.name.startsWith('@');
    const parents = scoped
      ? readdirSync(join(root, dir.name), {withFileTypes: true}).filter(e => e.isDirectory()).map(e => `${dir.name}/${e.name}`)
      : [dir.name];
    for (const rel of parents) {
      try {
        const pkg = JSON.parse(readFileSync(join(root, rel, 'package.json'), 'utf8'));
        out.push({name: pkg.name || rel, version: pkg.version || '0.0.0', license: pkg.license || null});
      } catch { /* not a package */ }
    }
  }
  return out;
}
const cargoPackages = parseCargoLock();
const nodePackages = parseNodePackages(join(outDir, 'sidecar', 'node_modules'));
const components = [
  {type: 'application', name: 'uptokey-tauri', version: readFileSync(join(tauriDir, 'Cargo.toml'), 'utf8').match(/^version\s*=\s*"([^"]+)"/m)[1], purl: 'pkg:cargo/uptokey_tauri', description: `Uptokey ${harness ? 'Harness' : 'legacy shell'} (Tauri), canonical local core supervisor`},
  ...cargoPackages.map(p => ({type: 'library', name: p.name, version: p.version, purl: `pkg:cargo/${encodeURIComponent(p.name)}@${p.version}`, ...(p.checksum ? {hashes: [{alg: 'SHA-256', content: p.checksum}]} : {})})),
  ...nodePackages.map(p => ({type: 'library', name: p.name, version: p.version, purl: `pkg:npm/${encodeURIComponent(p.name)}@${p.version}`, ...(p.license ? {licenses: [{expression: String(p.license)}]} : {})})),
  {type: 'file', name: 'uptokey-sidecar-runtime', version: sidecarManifest.build_version, description: 'Node runtime (ABI 137) + cli.js + composition-worker.js + native addons, attested', hashes: [{alg: 'SHA-256', content: sidecarManifest.files[sidecarManifest.binary_name].sha256}]},
  {type: 'file', name: 'uptokey-sidecar-worker', version: sidecarManifest.build_version, description: 'Real composition worker (never a stub)', hashes: [{alg: 'SHA-256', content: sidecarManifest.files[sidecarManifest.worker].sha256}]},
  ...Object.keys(frontendFiles).map(rel => ({type: 'file', name: `${frontendPrefix}/${rel}`, hashes: [{alg: 'SHA-256', content: integrity[`${frontendPrefix}/${rel}`]}]})),
];
const sbom = {
  bomFormat: 'CycloneDX', specVersion: '1.4', serialNumber: `urn:uuid:${randomUUID()}`, version: 1,
  metadata: {timestamp: startedAt, component: {type: 'application', name: 'uptokey-tauri', version: components[0].version}},
  components,
};
writeFileSync(join(outDir, 'sbom.cdx.json'), JSON.stringify(sbom, null, 2) + '\n');

// --- Provenance ---------------------------------------------------------------
const provenance = {
  generatedAt: startedAt,
  kind: 'build-provenance',
  note: 'Local build input inventory, not authenticated source provenance, installer acceptance, platform signature or updater signature. Those release gates remain separate.',
  interface: harness ? 'Harness' : 'shell',
  sourceCommit,
  inputs: {
    ...canonicalInputs,
    'sidecar/manifest.json': sha256Hex(join(outDir, 'sidecar', 'manifest.json')),
    [`sidecar/${sidecarManifest.entry}`]: sidecarManifest.files[sidecarManifest.entry].sha256,
    [`sidecar/${sidecarManifest.worker}`]: sidecarManifest.files[sidecarManifest.worker].sha256,
    [`sidecar/${sidecarManifest.serviceSchemaWorker}`]: sidecarManifest.files[sidecarManifest.serviceSchemaWorker].sha256,
    [`sidecar/${sidecarManifest.binary_name}`]: sidecarManifest.files[sidecarManifest.binary_name].sha256,
    ...Object.fromEntries(Object.keys(frontendFiles).map(rel => [`${frontendPrefix}/${rel}`, integrity[`${frontendPrefix}/${rel}`]])),
  },
  excludedInputs: {
    'proxy/core/dist': 'The sidecar preparer builds an isolated review artifact; the personal dist tree is preserved and is not a build input.',
  },
  tools,
  pwaBuild: pwaBuildState,
  frontend: {kind: frontendPrefix, files: Object.keys(frontendFiles).length},
  sidecarBuild: harness ? 'prepared_verified_not_built' : reusePreparedArtifacts ? 'reused_explicit_sha256' : 'built_and_verified',
  cargoBuild: reusePreparedArtifacts ? 'reused_explicit_sha256' : 'built',
  buildCommand: `node quimera/tauri/scripts/build-release.mjs ${process.argv.slice(2).join(' ')}`.trim(),
  cargoCommand: {command: 'cargo', args: cargoArgs},
  outputs: {integrity, sbom: sha256Hex(join(outDir, 'sbom.cdx.json')), appBinary: integrity[process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri']},
};
writeFileSync(join(outDir, 'provenance.json'), JSON.stringify(provenance, null, 2) + '\n');
console.log(`Artifacts emitted to ${outDir}`);
console.log(JSON.stringify({interface: provenance.interface, appBinary: Object.keys(integrity)[0], sbomComponents: components.length, attestedSidecarFiles: Object.keys(sidecarManifest.files).length, frontend: provenance.frontend, signed: false, installerBundled: false, nativeReleaseAccepted: false}, null, 2));
