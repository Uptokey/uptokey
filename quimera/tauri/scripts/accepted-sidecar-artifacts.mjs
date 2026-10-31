// Reuse only the already reviewed beta.22 bundles and Windows computer binary.
// This is build-time admission; it never launches a runtime or changes a pointer.
import { constants, copyFileSync, existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep, toNamespacedPath } from 'node:path';
import { createHash } from 'node:crypto';
import { parsePreparationArgs } from './sidecar-output.mjs';
import { sha256File } from './verify-sidecar.mjs';
import { verifyComputerResource } from '../computer-use/resource-launcher.mjs';
import { stageComputerResource } from './computer-resource.mjs';
import { COMPUTER_TOOLS, computerBinaryName, computerNativeTarget } from './computer-runtime-contract.mjs';

const HEX64 = /^[a-f0-9]{64}$/;
const VERSION = '0.1.0-beta.22';
const LAB = 'experiments/deepseek-workbench';
const CORE_DIRECTORY = 'output/harness-core-byok-refresh-20261025';
const LINUX_CORE_DIRECTORY = 'output/harness-linux-deb-core-20261027';
const LINUX_DIRECTORY = `${LAB}/output/computer-linux-native-20261027`;
const CORE_FILES = Object.freeze(['BUILD_INFO.json', 'THIRD-PARTY-NOTICES.md', 'cli.js', 'composition-worker.js', 'service-schema-worker.js', 'workspace-context-helper.js']);
export const ACCEPTED_SIDECAR_RECEIPTS = Object.freeze({
  core: Object.freeze({ path: `${LAB}/output/paired-tauri-byok-refresh-authority-20261025/ACCEPTANCE.json`, sha256: '165d177067855a17a905666732073dd7e5f2bb0877fd9efb84b0feab93dd96b5' }),
  linuxCore: Object.freeze({ path: `${LINUX_DIRECTORY}/CORE-DEB-ACCEPTANCE.json`, sha256: 'a9b9485933ac15e54e42fc2db3ffd98a551a669e72d135da20d1aecc86549592' }),
  computer: Object.freeze({ path: `${LAB}/output/automation-integration-20261026/FINAL.json`, sha256: '1c9c127c0536ff068335a7100d7c532c350db5a1a53bb6e92370ce53b5b4cd3e' }),
  nodeLicense: Object.freeze({ path: `${LAB}/output/node-runtime-license-20261027/ACCEPTANCE.json`, sha256: '5631edb057a78554b6bd9efd0884252be8411a8431106abe2b08850d9d731b54' }),
  linuxNodeLicense: Object.freeze({ path: `${LINUX_DIRECTORY}/node-acceptance.json`, sha256: '8618a79f4485bdb088ba99f3aaa5623da852ff2d75f1c97bd0cd045ecd6789ed' }),
  macosNodeLicense: Object.freeze({ path: 'experiments/deepseek-workbench/output/node-macos-provenance-20261027/ACCEPTANCE.json', sha256: 'fa8748f2f5e0655e0a4902cba65899029d85f306668173e9839345db05a22012' }),
  macosNodeSignature: Object.freeze({ path: 'experiments/deepseek-workbench/output/node-macos-provenance-20261027/SIGNATURE-ACCEPTANCE.json', sha256: 'ff14f914e211fb8a3be8412dec8a29e1a0252b142128b8ad565fedcfb0397fa4' }),
  linuxComputer: Object.freeze({ path: `${LAB}/output/computer-linux-manual-20261028/ACCEPTANCE.json`, sha256: 'd2401c2298446b313d4665bb52f20defe41368c00b88803ea3432f27159ae1a8' }),
});
const COMPUTER_MANIFEST_SHA256 = '425b1c75939cb52900f51eea9aea9f446ce41002ea3cff9122ba7c895e3e2000';

function checkedPath(path, directory = false) {
  if (!isAbsolute(path) || resolve(path) !== path) throw Error('accepted_artifact_path_invalid');
  for (let current = path;; current = dirname(current)) {
    const meta = lstatSync(current);
    if (meta.isSymbolicLink() || (current !== path || directory ? !meta.isDirectory() : !meta.isFile())) throw Error('accepted_artifact_path_invalid');
    if (current === dirname(current)) break;
  }
  if (toNamespacedPath(realpathSync.native(path)) !== toNamespacedPath(path)) throw Error('accepted_artifact_path_invalid');
  return path;
}
function readReceipt(path, expectedSha256) {
  checkedPath(path);
  if (!HEX64.test(expectedSha256) || lstatSync(path).size > 1024 * 1024) throw Error('accepted_receipt_invalid');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expectedSha256) throw Error('accepted_receipt_changed');
  return JSON.parse(bytes);
}
function verifyFile(path, record) {
  checkedPath(path);
  if (!record || !Number.isSafeInteger(record.bytes) || record.bytes <= 0 || record.bytes > 64 * 1024 * 1024 || !HEX64.test(record.sha256)
    || lstatSync(path).size !== record.bytes || sha256File(path) !== record.sha256) throw Error('accepted_artifact_changed');
}
function contains(parent, child) {
  const rel = relative(toNamespacedPath(parent), toNamespacedPath(child));
  return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
}

export function admitNodeRuntimeLicense({runtimePath, licensePath, receiptPath, receiptSha256}) {
  const receipt = readReceipt(receiptPath, receiptSha256);
  if (receipt.schema !== 'uptokey.node-runtime-license.v1' || receipt.version !== 'v24.21.0'
    || receipt.platform !== 'win32' || receipt.architecture !== 'x64' || receipt.nodeModuleAbi !== 137
    || receipt.distribution?.url !== 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip'
    || receipt.distribution.checksumMatched !== true || receipt.nodeExecutable?.requestedBinaryMatched !== true
    || receipt.license?.complete !== true || receipt.license.file !== 'LICENSE') throw Error('accepted_node_license_receipt_invalid');
  const node = receipt.nodeExecutable;
  checkedPath(runtimePath);
  if (!Number.isSafeInteger(node.bytes) || node.bytes <= 0 || node.bytes > 512 * 1024 * 1024
    || !HEX64.test(node.sha256) || lstatSync(runtimePath).size !== node.bytes
    || sha256File(runtimePath) !== node.sha256) throw Error('accepted_node_runtime_changed');
  verifyFile(licensePath, receipt.license);
  return Object.freeze({runtimePath, licensePath, receiptPath, receiptSha256, version:receipt.version,
    nodeSha256:node.sha256, licenseSha256:receipt.license.sha256, licenseBytes:receipt.license.bytes,
    sourceUrl:receipt.distribution.url, signatureVerified:receipt.checksums?.signatureVerified === true});
}

export function admitAcceptedNodeRuntimeLicense(repositoryRoot, runtimePath, { platform = process.platform, arch = process.arch } = {}) {
  const root = checkedPath(resolve(repositoryRoot), true);
  if (platform === 'darwin' && ['x64', 'arm64'].includes(arch)) {
    const record = ACCEPTED_SIDECAR_RECEIPTS.macosNodeLicense;
    const receiptPath = join(root, record.path), receipt = readReceipt(receiptPath, record.sha256);
    const artifacts = receipt.architectures?.[arch]?.files;
    const node = artifacts?.['bin/node'], license = artifacts?.LICENSE;
    if (receipt.version !== '24.21.0' || receipt.platform !== 'darwin'
        || receipt.checksumSource !== 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt'
        || receipt.signatureVerified !== false || receipt.executed !== false
        || node?.file !== 'node-' + arch || license?.file !== 'LICENSE-' + arch) {
      throw Error('accepted_node_license_receipt_invalid');
    }
    const signatureRecord = ACCEPTED_SIDECAR_RECEIPTS.macosNodeSignature;
    const signature = readReceipt(join(root, signatureRecord.path), signatureRecord.sha256);
    const directory = dirname(receiptPath), licensePath = join(directory, license.file);
    if (signature.schema !== 'uptokey.node-release-signature.v1' || signature.version !== '24.21.0'
        || signature.signerFingerprint !== '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356'
        || signature.signatureValid !== true || signature.signedContentMatchesDownloadedChecksums !== true
        || sha256File(checkedPath(join(directory, 'SHASUMS256.txt'))) !== signature.signedChecksumSha256
        || sha256File(checkedPath(join(directory, 'SHASUMS256.txt.asc'))) !== signature.signatureSha256
        || sha256File(checkedPath(join(directory, 'nodejs-release-keys.kbx'))) !== signature.keyringSha256) {
      throw Error('accepted_node_signature_invalid');
    }
    checkedPath(runtimePath);
    if (!node || !HEX64.test(node.sha256) || !Number.isSafeInteger(node.bytes)
        || node.bytes <= 0 || node.bytes > 512 * 1024 * 1024
        || lstatSync(runtimePath).size !== node.bytes || sha256File(runtimePath) !== node.sha256) {
      throw Error('accepted_node_runtime_changed');
    }
    verifyFile(licensePath, license);
    return Object.freeze({ runtimePath, licensePath, receiptPath, receiptSha256: record.sha256, receipt: record,
      version: 'v24.21.0', nodeSha256: node.sha256, licenseSha256: license.sha256, licenseBytes: license.bytes,
      sourceUrl: 'https://nodejs.org/dist/v24.21.0/node-v24.21.0-darwin-' + arch + '.tar.gz', signatureVerified: true, signatureReceipt: signatureRecord });
  }
  if (platform === 'linux' && arch === 'x64') {
    const record = ACCEPTED_SIDECAR_RECEIPTS.linuxNodeLicense;
    const receiptPath = join(root, record.path), receipt = readReceipt(receiptPath, record.sha256);
    const node = receipt.files?.['node-linux-x64'], license = receipt.files?.['node-LICENSE.txt'];
    if (receipt.version !== '24.21.0' || receipt.platform !== 'linux' || receipt.arch !== 'x64'
      || receipt.checksumSource !== 'https://nodejs.org/dist/v24.21.0/SHASUMS256.txt'
      || receipt.imageBinaryMatches !== true || receipt.signatureVerified !== false
      || !node || !HEX64.test(node.sha256) || !Number.isSafeInteger(node.bytes) || node.bytes <= 0 || node.bytes > 512 * 1024 * 1024)
      throw Error('accepted_node_license_receipt_invalid');
    checkedPath(runtimePath);
    if (lstatSync(runtimePath).size !== node.bytes || sha256File(runtimePath) !== node.sha256) throw Error('accepted_node_runtime_changed');
    const licensePath = join(root, LINUX_DIRECTORY, 'node-LICENSE.txt');
    verifyFile(licensePath, license);
    return Object.freeze({runtimePath, licensePath, receiptPath, receiptSha256:record.sha256, receipt:record,
      version:'v24.21.0', nodeSha256:node.sha256, licenseSha256:license.sha256, licenseBytes:license.bytes,
      sourceUrl:'https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz', signatureVerified:false});
  }
  if (platform !== 'win32' || arch !== 'x64') throw Error('accepted_node_platform_unsupported');
  const record = ACCEPTED_SIDECAR_RECEIPTS.nodeLicense;
  return Object.freeze({...admitNodeRuntimeLicense({runtimePath, licensePath:join(root, LAB, 'output/node-runtime-license-20261027/LICENSE'),
    receiptPath:join(root, record.path), receiptSha256:record.sha256}), receipt:record});
}

export function stageNodeRuntimeLicense(outDir, admitted) {
  checkedPath(outDir, true);
  const destination = join(outDir, 'NODE-LICENSE.txt');
  copyFileSync(admitted.licensePath, destination, constants.COPYFILE_EXCL);
  verifyFile(destination, {bytes:admitted.licenseBytes,sha256:admitted.licenseSha256});
}

export function parseAcceptedPreparationArgs(args, options) {
  const count = args.filter(arg => arg === '--reuse-accepted').length;
  if (count > 1) throw Error('accepted_preparation_arguments_invalid');
  const reuseAccepted = count === 1;
  if (reuseAccepted && (!args.includes('--output') || args.includes('--check'))) throw Error('accepted_preparation_requires_new_output');
  return { ...parsePreparationArgs(args.filter(arg => arg !== '--reuse-accepted'), options), reuseAccepted };
}

// The reuse mode must not replace an existing package, accepted source or active
// resources. Restrict it to a fresh candidate below the repository's outputs.
export function validateAcceptedOutput(directory, repositoryRoot) {
  const root = checkedPath(resolve(repositoryRoot), true), target = resolve(directory);
  const allowed = [join(root, 'output'), join(root, LAB, 'output')];
  if (!allowed.some(parent => contains(parent, target) && parent !== target) || existsSync(target)
    || contains(join(root, CORE_DIRECTORY), target) || contains(target, join(root, CORE_DIRECTORY))) throw Error('accepted_output_not_fresh_candidate');
  let parent = dirname(target);
  while (!existsSync(parent)) { if (parent === dirname(parent)) throw Error('accepted_output_invalid'); parent = dirname(parent); }
  checkedPath(parent, true);
  return target;
}

// Explicit receipt hashes are parameters here solely so admission can be tested
// with finite synthetic artifacts. The preparer uses the pinned wrapper below.
export function admitCoreArtifact({ directory, receiptPath, receiptSha256, linuxDeb = false }) {
  checkedPath(directory, true);
  const receipt = readReceipt(receiptPath, receiptSha256), candidate = receipt.compiledCandidate;
  if (!candidate || candidate.version !== VERSION || candidate.target !== 'node' || candidate.directory !== (linuxDeb ? LINUX_CORE_DIRECTORY : CORE_DIRECTORY)
    || JSON.stringify(Object.keys(candidate.files ?? {}).sort()) !== JSON.stringify(CORE_FILES)) throw Error('accepted_core_receipt_invalid');
  for (const name of CORE_FILES) verifyFile(join(directory, name), candidate.files[name]);
  const info = JSON.parse(readFileSync(join(directory, 'BUILD_INFO.json'), 'utf8'));
  if (linuxDeb && (info.distributionChannel !== 'native' || info.linuxPackageChannel !== 'deb'
    || receipt.state !== 'linux_deb_core_health_verified_isolated' || receipt.evidence?.healthStatus !== 200
    || receipt.evidence?.nativeSecretServiceSynthetic !== true)) throw Error('accepted_core_debian_channel_required');
  if (info.version !== candidate.version || info.target !== 'node' || info.entry !== 'src/cli.ts'
    || info.compositionWorker !== 'composition-worker.js' || info.serviceSchemaWorker !== 'service-schema-worker.js'
    || info.contextHelper?.entry !== 'workspace-context-helper.js' || info.thirdPartyNotices !== 'THIRD-PARTY-NOTICES.md') throw Error('accepted_core_build_info_invalid');
  const files = Object.freeze(Object.fromEntries(CORE_FILES.map(name => [name, Object.freeze({ ...candidate.files[name] })])));
  return Object.freeze({ directory, receiptPath, receiptSha256, linuxDeb, version: candidate.version, files });
}

export function admitComputerArtifact({ directory, receiptPath, receiptSha256, platform = process.platform, arch = process.arch }) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64') throw Error('accepted_computer_platform_unproven');
  checkedPath(directory, true);
  const receipt = readReceipt(receiptPath, receiptSha256), accepted = receipt.nativeResource;
  if (platform === 'linux' && receipt.schema === 'uptokey.computer.linux.manual-backend.v1') {
    const build = receipt.build, proof = receipt.acceptance, cleanup = receipt.cleanup;
    const binary = build?.binary, manifestSha256 = build?.result?.resourceManifestSha256;
    if (receipt.state !== 'linux_x11_backend_manual_return_timeout_cancel_eof_verified'
      || receipt.environment?.personalMounts !== false || receipt.environment?.privileged !== false
      || receipt.environment?.noNewPrivileges !== true || receipt.environment?.publishedPorts?.length !== 0
      || build?.exitCode !== 0 || build?.offline !== true || build?.personalPathsAbsent !== true
      || build?.result?.platform !== 'linux' || build?.result?.arch !== 'x64'
      || build?.result?.target !== 'x86_64-unknown-linux-gnu'
      || proof?.scope !== 'direct_mcp_backend_x11_synthetic_only' || proof?.uiApprovalAccepted !== false
      || proof?.checks?.manualReturn?.exactText !== 'UPTOKEY_LINUX_MANUAL_OK'
      || proof?.checks?.manualReturn?.pendingBeforeFixtureReturn !== true
      || proof?.checks?.manualReturn?.productPreservedDecoyForeground !== true
      || proof?.checks?.manualReturn?.decoyUnchanged !== true
      || proof?.checks?.timeout?.error !== 'manual_focus_timeout_recapture_required'
      || !Number.isSafeInteger(proof?.checks?.timeout?.elapsedMs) || proof.checks.timeout.elapsedMs < 15000 || proof.checks.timeout.elapsedMs > 16000
      || proof?.checks?.timeout?.zeroInput !== true
      || proof?.checks?.timeout?.replayError !== 'screenshot_required'
      || proof?.checks?.cancel?.pendingBeforeCancel !== true
      || proof?.checks?.cancel?.zeroInputAfterTargetReturn !== true
      || proof?.checks?.cancel?.replayError !== 'screenshot_required'
      || proof?.checks?.eof?.pendingBeforeEof !== true || proof?.checks?.eof?.exitCode !== 0 || proof?.checks?.eof?.zeroInputAfterTargetReturn !== true
      || cleanup?.containerRemoved !== true || cleanup?.volumeRemoved !== false || cleanup?.imageRemoved !== false
      || !Number.isSafeInteger(binary?.bytes) || binary.bytes <= 0 || !HEX64.test(binary?.sha256)
      || !HEX64.test(manifestSha256)) throw Error('accepted_computer_receipt_invalid');
    const resource = verifyComputerResource(directory, manifestSha256, platform, arch);
    verifyFile(resource.executable, { bytes: binary.bytes, sha256: binary.sha256 });
    if (resource.manifest.files[computerBinaryName(platform)].sha256 !== binary.sha256
      || resource.manifest.files[computerBinaryName(platform)].size !== binary.bytes) throw Error('accepted_computer_receipt_invalid');
    return Object.freeze({ directory, receiptPath, receiptSha256, platform, arch, executable: resource.executable,
      manifestSha256, binarySha256: binary.sha256, binaryBytes: binary.bytes });
  }
  const name = computerBinaryName(platform), expected = accepted?.files?.[name];
  const state = platform === 'linux' ? 'linux_x11_fixture_mcp_observed' : 'active_functional_browser_and_windows_computer_use';
  if (receipt.state !== state || !accepted || !HEX64.test(accepted.manifestSha256)
    || accepted.sourceBinaryMatches !== true || expected?.sha256 !== accepted.binarySha256) throw Error('accepted_computer_receipt_invalid');
  if (platform === 'linux') {
    if (receipt.scope !== 'isolated_x11_direct_mcp_only' || !HEX64.test(receipt.mcpProofSha256)) throw Error('accepted_computer_receipt_invalid');
    const proof = readReceipt(join(dirname(receiptPath), 'mcp-result3.json'), receipt.mcpProofSha256);
    if (proof.platform !== 'linux' || proof.fixtureOnly !== true || proof.selectedWindow !== true || proof.screenshotPng !== true || proof.typedExact !== true) throw Error('accepted_computer_receipt_invalid');
  }
  const resource = verifyComputerResource(directory, accepted.manifestSha256, platform, arch);
  verifyFile(resource.executable, { bytes: expected.size, sha256: expected.sha256 });
  if (resource.manifest.files[name].sha256 !== expected.sha256 || resource.manifest.files[name].size !== expected.size) throw Error('accepted_computer_receipt_invalid');
  return Object.freeze({ directory, receiptPath, receiptSha256, platform, arch, executable: resource.executable, manifestSha256: accepted.manifestSha256, binarySha256: expected.sha256, binaryBytes: expected.size });
}

export function admitAcceptedSidecarArtifacts(repositoryRoot, { platform = process.platform, arch = process.arch } = {}) {
  const root = checkedPath(resolve(repositoryRoot), true);
  const linux = platform === 'linux' && arch === 'x64';
  const coreReceipt = linux ? ACCEPTED_SIDECAR_RECEIPTS.linuxCore : ACCEPTED_SIDECAR_RECEIPTS.core;
  const core = admitCoreArtifact({ directory: join(root, linux ? LINUX_CORE_DIRECTORY : CORE_DIRECTORY), receiptPath: join(root, coreReceipt.path), receiptSha256: coreReceipt.sha256, linuxDeb:linux });
  const computerReceipt = linux ? ACCEPTED_SIDECAR_RECEIPTS.linuxComputer : ACCEPTED_SIDECAR_RECEIPTS.computer;
  const computer = admitComputerArtifact({ directory: linux ? join(root, LAB, 'output/computer-linux-manual-20261028/resource') : join(root, LAB, '.local/computer-resources', `computer-resource-${COMPUTER_MANIFEST_SHA256}`), receiptPath: join(root, computerReceipt.path), receiptSha256: computerReceipt.sha256, platform, arch });
  if (!linux && computer.manifestSha256 !== COMPUTER_MANIFEST_SHA256) throw Error('accepted_computer_receipt_invalid');
  return Object.freeze({ core, coreReceipt, computer, computerReceipt });
}

export function revalidateAcceptedSidecarArtifacts(artifacts) {
  admitCoreArtifact(artifacts.core);
  admitComputerArtifact(artifacts.computer);
}

export function stageAcceptedCoreArtifact(outDir, accepted) {
  const current = admitCoreArtifact(accepted);
  checkedPath(outDir, true);
  for (const [name, record] of Object.entries(current.files)) {
    const destination = join(outDir, name);
    copyFileSync(join(current.directory, name), destination, constants.COPYFILE_EXCL);
    verifyFile(destination, record);
  }
  admitCoreArtifact(accepted);
}

// Run after all preparation probes, immediately before candidate publication.
// Checking the copied bytes against the receipt closes the source/copy gap;
// checking the source again also refuses replacement during preparation.
export function verifyAcceptedStagedArtifacts(outDir, artifacts) {
  checkedPath(outDir, true);
  revalidateAcceptedSidecarArtifacts(artifacts);
  for (const [name, record] of Object.entries(artifacts.core.files)) verifyFile(join(outDir, name), record);
  verifyFile(join(outDir, computerBinaryName(artifacts.computer.platform)), {
    bytes: artifacts.computer.binaryBytes, sha256: artifacts.computer.binarySha256,
  });
}

export function stageAcceptedComputerRuntime(outDir, accepted) {
  const current = admitComputerArtifact(accepted);
  checkedPath(outDir, true);
  const name = computerBinaryName(current.platform), destination = join(outDir, name);
  if (existsSync(destination)) throw Error('accepted_computer_destination_exists');
  copyFileSync(current.executable, destination, constants.COPYFILE_EXCL);
  verifyFile(destination, { bytes: current.binaryBytes, sha256: current.binarySha256 });
  // Reuse the native bytes; package the current canonical JS closure, including
  // the separately tested installed-state seam. This creates a new manifest.
  const resource = stageComputerResource(outDir, destination, { platform: current.platform, arch: current.arch });
  admitComputerArtifact(accepted);
  return { schema_version: 1, binary: name, platform: current.platform, arch: current.arch,
    target: computerNativeTarget(current.platform, current.arch), tools: COMPUTER_TOOLS, resourceManifestSha256: resource.manifestSha256 };
}
