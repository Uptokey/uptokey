import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, symlinkSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { admitCoreArtifact, admitComputerArtifact, parseAcceptedPreparationArgs, validateAcceptedOutput,
  stageAcceptedCoreArtifact, stageAcceptedComputerRuntime, verifyAcceptedStagedArtifacts,
  admitNodeRuntimeLicense, stageNodeRuntimeLicense } from './accepted-sidecar-artifacts.mjs';
import { verifyComputerResource } from '../computer-use/resource-launcher.mjs';
import { stageComputerResource } from './computer-resource.mjs';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');
const fixtureBase = join(repo, 'output', 'accepted-sidecar-artifact-tests');
const binary = 'uptokey-computer-mcp.exe';
const buildInfo = {
  version: '0.1.0-beta.22', target: 'node', entry: 'src/cli.ts', compositionWorker: 'composition-worker.js',
  serviceSchemaWorker: 'service-schema-worker.js', contextHelper: { entry: 'workspace-context-helper.js' },
  thirdPartyNotices: 'THIRD-PARTY-NOTICES.md',
};
function fixture(t) {
  mkdirSync(fixtureBase, { recursive: true });
  const root = mkdtempSync(join(fixtureBase, 'case-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(fixtureBase)); rmSync(root, { recursive: true }); });
  return root;
}
function receipt(path, value) {
  const bytes = Buffer.from(JSON.stringify(value) + '\n'); writeFileSync(path, bytes);
  return hash(bytes);
}

test('Node license admission binds the exact runtime bytes, license and source receipt before copying', t => {
  const root=fixture(t),runtimePath=join(root,'node.exe'),licensePath=join(root,'LICENSE'),receiptPath=join(root,'node-receipt.json');
  const runtime=Buffer.from('synthetic runtime; never execute'),license=Buffer.from('synthetic license');
  writeFileSync(runtimePath,runtime);writeFileSync(licensePath,license);
  const record={schema:'uptokey.node-runtime-license.v1',version:'v24.21.0',platform:'win32',architecture:'x64',nodeModuleAbi:137,
    distribution:{url:'https://nodejs.org/dist/v24.21.0/node-v24.21.0-win-x64.zip',checksumMatched:true},
    nodeExecutable:{bytes:runtime.length,sha256:hash(runtime),requestedBinaryMatched:true},
    license:{bytes:license.length,sha256:hash(license),file:'LICENSE',complete:true},checksums:{signatureVerified:false}};
  const args={runtimePath,licensePath,receiptPath,receiptSha256:receipt(receiptPath,record)},admitted=admitNodeRuntimeLicense(args);
  const destination=join(root,'staged');mkdirSync(destination);stageNodeRuntimeLicense(destination,admitted);
  assert.deepEqual(readFileSync(join(destination,'NODE-LICENSE.txt')),license);assert.equal(admitted.signatureVerified,false);
  writeFileSync(runtimePath,Buffer.alloc(runtime.length,120));assert.throws(()=>admitNodeRuntimeLicense(args),/accepted_node_runtime_changed/);writeFileSync(runtimePath,runtime);
  writeFileSync(licensePath,'npm license is not Node license');assert.throws(()=>admitNodeRuntimeLicense(args),/accepted_artifact_changed/);
  assert.throws(()=>stageNodeRuntimeLicense(destination,admitted),/EEXIST/);
});
function core(root) {
  const directory = join(root, 'core'); mkdirSync(directory);
  const contents = {
    'BUILD_INFO.json': JSON.stringify(buildInfo), 'THIRD-PARTY-NOTICES.md': '# synthetic notice\n',
    'cli.js': 'throw Error("synthetic CLI must never execute");\n',
    'composition-worker.js': 'throw Error("synthetic worker must never execute");\n',
    'service-schema-worker.js': 'throw Error("synthetic schema must never execute");\n',
    'workspace-context-helper.js': 'throw Error("synthetic helper must never execute");\n',
  };
  const files = Object.fromEntries(Object.entries(contents).map(([name, value]) => {
    const bytes = Buffer.from(value); writeFileSync(join(directory, name), bytes);
    return [name, { bytes: bytes.length, sha256: hash(bytes) }];
  }));
  const record = { compiledCandidate: { version: buildInfo.version, target: 'node', directory: 'output/harness-core-byok-refresh-20261025', files } };
  const receiptPath = join(root, 'core-receipt.json');
  return { directory, receiptPath, receiptSha256: receipt(receiptPath, record), record };
}
function computer(root) {
  const directory = join(root, 'computer'); mkdirSync(join(directory, 'session'), { recursive: true });
  const names = [binary, 'resource-launcher.mjs', 'session/computer-session.mjs', 'session/computer-transport.mjs',
    'session/computer-session-lease.mjs', 'session/host-environment.mjs'];
  const files = Object.fromEntries(names.map(name => {
    const bytes = Buffer.from(`synthetic accepted resource ${name}; never execute`); writeFileSync(join(directory, name), bytes);
    return [name, { size: bytes.length, sha256: hash(bytes) }];
  }));
  const manifest = { schema: 'uptokey.computer.resource.v1', platform: 'win32', arch: 'x64', binary, files };
  const manifestSha256 = receipt(join(directory, 'computer-resource.json'), manifest);
  const record = { state: 'active_functional_browser_and_windows_computer_use', nativeResource: {
    manifestSha256, binarySha256: files[binary].sha256, sourceBinaryMatches: true, files,
  } };
  const receiptPath = join(root, 'computer-receipt.json');
  return { directory, receiptPath, receiptSha256: receipt(receiptPath, record), platform: 'win32', arch: 'x64', record };
}

test('Linux reuse refuses an npm core even when its bytes and receipt hashes match', t => {
  const root=fixture(t), sample=core(root);
  sample.record.compiledCandidate.directory='output/harness-linux-deb-core-20261027';
  sample.record.state='linux_deb_core_health_verified_isolated';
  sample.record.evidence={healthStatus:200,nativeSecretServiceSynthetic:true};
  sample.linuxDeb=true;
  sample.receiptSha256=receipt(sample.receiptPath,sample.record);
  assert.throws(()=>admitCoreArtifact(sample),/accepted_core_debian_channel_required/);
  const bytes=Buffer.from(JSON.stringify({...buildInfo,distributionChannel:'native',linuxPackageChannel:'deb'}));
  writeFileSync(join(sample.directory,'BUILD_INFO.json'),bytes);
  sample.record.compiledCandidate.files['BUILD_INFO.json']={bytes:bytes.length,sha256:hash(bytes)};
  sample.receiptSha256=receipt(sample.receiptPath,sample.record);
  const admitted=admitCoreArtifact(sample);
  assert.equal(admitted.linuxDeb,true);
  const target=join(root,'debian');mkdirSync(target);stageAcceptedCoreArtifact(target,admitted);
  assert.deepEqual(readFileSync(join(target,'BUILD_INFO.json')),bytes);
});

test('reuse requires explicit fresh output; default and check retain the existing parser contract', () => {
  const options = { tauriDir: join(repo, 'quimera/tauri'), cwd: repo };
  assert.deepEqual(parseAcceptedPreparationArgs([], options), { check: false, directory: join(options.tauriDir, 'resources/sidecar'), reuseAccepted: false });
  assert.equal(parseAcceptedPreparationArgs(['--check'], options).check, true);
  const candidate = parseAcceptedPreparationArgs(['--reuse-accepted', '--output', 'output/new-candidate'], options);
  assert.equal(candidate.directory, join(repo, 'output/new-candidate')); assert.equal(candidate.reuseAccepted, true);
  for (const args of [['--reuse-accepted'], ['--reuse-accepted', 'output/candidate'], ['--reuse-accepted', '--check', '--output', 'output/candidate'], ['--reuse-accepted', '--reuse-accepted']]) {
    assert.throws(() => parseAcceptedPreparationArgs(args, options), /accepted_preparation_/);
  }
});

test('six core artifacts including BUILD_INFO are copied exactly from a verified receipt without execution', t => {
  const root = fixture(t), source = core(root), admitted = admitCoreArtifact(source), target = join(root, 'staged'); mkdirSync(target);
  stageAcceptedCoreArtifact(target, admitted);
  for (const [name, record] of Object.entries(admitted.files)) {
    assert.deepEqual(readFileSync(join(target, name)), readFileSync(join(source.directory, name)));
    assert.equal(hash(readFileSync(join(target, name))), record.sha256);
  }
  assert.equal(Object.keys(admitted.files).length, 6);
  assert.equal(hash(readFileSync(source.receiptPath)), source.receiptSha256);
  assert.throws(() => stageAcceptedCoreArtifact(target, admitted), /EEXIST/);
});

test('core receipt digest, missing files and changed bytes fail closed', t => {
  const source = core(fixture(t));
  assert.throws(() => admitCoreArtifact({ ...source, receiptSha256: '0'.repeat(64) }), /accepted_receipt_changed/);
  const cli = join(source.directory, 'cli.js'), original = readFileSync(cli);
  writeFileSync(cli, Buffer.alloc(original.length, 120));
  assert.throws(() => admitCoreArtifact(source), /accepted_artifact_changed/);
  writeFileSync(cli, original); rmSync(cli);
  assert.throws(() => admitCoreArtifact(source), /ENOENT/);
});

test('a self-consistent receipt still must name beta.22, the exact six entries and matching BUILD_INFO', t => {
  const source = core(fixture(t));
  const original = structuredClone(source.record);
  for (const change of [r => { r.compiledCandidate.version = '0.1.0-beta.15'; }, r => { r.compiledCandidate.target = 'bun'; },
    r => { r.compiledCandidate.files['unexpected.js'] = r.compiledCandidate.files['cli.js']; }]) {
    const record = structuredClone(original); change(record);
    assert.throws(() => admitCoreArtifact({ ...source, receiptSha256: receipt(source.receiptPath, record) }), /accepted_core_receipt_invalid/);
  }
  const changedInfo = Buffer.from(JSON.stringify({ ...buildInfo, version: '0.1.0-beta.15' }));
  writeFileSync(join(source.directory, 'BUILD_INFO.json'), changedInfo);
  original.compiledCandidate.files['BUILD_INFO.json'] = { bytes: changedInfo.length, sha256: hash(changedInfo) };
  assert.throws(() => admitCoreArtifact({ ...source, receiptSha256: receipt(source.receiptPath, original) }), /accepted_core_build_info_invalid/);
});

test('native bytes are reused with a fresh manifest of the current canonical helper closure', t => {
  const root = fixture(t), source = computer(root), admitted = admitComputerArtifact(source), target = join(root, 'staged'); mkdirSync(target);
  const result = stageAcceptedComputerRuntime(target, admitted);
  assert.deepEqual(readFileSync(join(target, binary)), readFileSync(admitted.executable));
  assert.equal(result.target, 'x86_64-pc-windows-msvc'); assert.equal(result.tools.length, 7);
  assert.notEqual(result.resourceManifestSha256, admitted.manifestSha256);
  verifyComputerResource(target, result.resourceManifestSha256, 'win32', 'x64');
  assert.equal(existsSync(join(root, 'computer-resource-current.json')), false);
  assert.throws(() => stageAcceptedComputerRuntime(target, admitted), /accepted_computer_destination_exists/);
});

test('computer reuse rejects other platforms, mismatched receipts and changed resource files', t => {
  const source = computer(fixture(t));
  assert.throws(() => admitComputerArtifact({ ...source, platform:'linux', arch:'x64' }), /accepted_computer_receipt_invalid/);
  for (const [platform, arch] of [['darwin', 'arm64'], ['win32', 'arm64']]) {
    assert.throws(() => admitComputerArtifact({ ...source, platform, arch }), /accepted_computer_platform_unproven/);
  }
  assert.throws(() => admitComputerArtifact({ ...source, receiptSha256: '0'.repeat(64) }), /accepted_receipt_changed/);
  const altered = structuredClone(source.record); altered.nativeResource.binarySha256 = '0'.repeat(64);
  assert.throws(() => admitComputerArtifact({ ...source, receiptSha256: receipt(source.receiptPath, altered) }), /accepted_computer_receipt_invalid/);
  receipt(source.receiptPath, source.record);
  writeFileSync(join(source.directory, 'session/computer-session.mjs'), 'changed helper');
  assert.throws(() => admitComputerArtifact(source), /computer_resource_file_changed/);
});

test('Linux reuse binds the scoped X11 proof and rejects a changed proof or mismatched platform', t => {
  const root = fixture(t), source = computer(root), linuxBinary = 'uptokey-computer-mcp';
  const old = JSON.parse(readFileSync(join(source.directory, 'computer-resource.json'), 'utf8'));
  const bytes = readFileSync(join(source.directory, binary));
  writeFileSync(join(source.directory, linuxBinary), bytes);
  rmSync(join(source.directory, binary));
  const files = { ...old.files, [linuxBinary]: old.files[binary] }; delete files[binary];
  const manifest = { ...old, platform:'linux', binary:linuxBinary, files };
  const manifestSha256 = receipt(join(source.directory, 'computer-resource.json'), manifest);
  const proofPath = join(root, 'mcp-result3.json');
  const proof = { platform:'linux', fixtureOnly:true, selectedWindow:true, screenshotPng:true, typedExact:true };
  const mcpProofSha256 = receipt(proofPath, proof);
  const record = { state:'linux_x11_fixture_mcp_observed', scope:'isolated_x11_direct_mcp_only', mcpProofSha256,
    nativeResource:{manifestSha256, binarySha256:files[linuxBinary].sha256, sourceBinaryMatches:true, files} };
  const args = {...source, platform:'linux', arch:'x64', receiptSha256:receipt(source.receiptPath, record)};
  assert.equal(admitComputerArtifact(args).binarySha256, hash(bytes));
  writeFileSync(proofPath, JSON.stringify({...proof, typedExact:false}));
  assert.throws(() => admitComputerArtifact(args), /accepted_receipt_changed/);
  assert.throws(() => admitComputerArtifact({...args, platform:'win32'}), /accepted_computer_receipt_invalid/);
});

test('current Linux manual-focus backend is admitted only with its bounded X11 proof and exact resource manifest', t => {
  const root=fixture(t), directory=join(root,'linux-resource'); mkdirSync(directory);
  const executable=join(root,'synthetic-linux-backend'); writeFileSync(executable,'synthetic executable bytes; never execute');
  const resource=stageComputerResource(directory,executable,{platform:'linux',arch:'x64'});
  const receiptPath=join(root,'linux-manual-receipt.json');
  const evidence={schema:'uptokey.computer.linux.manual-backend.v1',state:'linux_x11_backend_manual_return_timeout_cancel_eof_verified',
    environment:{personalMounts:false,privileged:false,noNewPrivileges:true,publishedPorts:[]},
    build:{exitCode:0,offline:true,personalPathsAbsent:true,result:{platform:'linux',arch:'x64',target:'x86_64-unknown-linux-gnu',resourceManifestSha256:resource.manifestSha256},
      binary:{bytes:readFileSync(executable).length,sha256:hash(readFileSync(executable))}},
    acceptance:{scope:'direct_mcp_backend_x11_synthetic_only',uiApprovalAccepted:false,checks:{
      manualReturn:{pendingBeforeFixtureReturn:true,productPreservedDecoyForeground:true,exactText:'UPTOKEY_LINUX_MANUAL_OK',decoyUnchanged:true},
      timeout:{elapsedMs:15001,error:'manual_focus_timeout_recapture_required',zeroInput:true,replayError:'screenshot_required'},
      cancel:{pendingBeforeCancel:true,zeroInputAfterTargetReturn:true,replayError:'screenshot_required'},
      eof:{pendingBeforeEof:true,exitCode:0,zeroInputAfterTargetReturn:true}}},
    cleanup:{containerRemoved:true,volumeRemoved:false,imageRemoved:false}};
  const source={directory,receiptPath,receiptSha256:receipt(receiptPath,evidence),platform:'linux',arch:'x64'};
  const admitted=admitComputerArtifact(source);
  assert.equal(admitted.binarySha256,hash(readFileSync(executable)));
  for(const change of [r=>{r.environment.personalMounts=true;},r=>{r.environment.noNewPrivileges=false;},
    r=>{r.acceptance.uiApprovalAccepted=true;},r=>{r.acceptance.checks.timeout.zeroInput=false;},
    r=>{r.acceptance.checks.timeout.elapsedMs=14999;},
    r=>{r.acceptance.checks.eof.zeroInputAfterTargetReturn=false;},r=>{r.cleanup.volumeRemoved=true;}]){
    const altered=structuredClone(evidence);change(altered);
    assert.throws(()=>admitComputerArtifact({...source,receiptSha256:receipt(receiptPath,altered)}),/accepted_computer_receipt_invalid/);
  }
  receipt(receiptPath,evidence);
  const manifest=JSON.parse(readFileSync(join(directory,'computer-resource.json'),'utf8'));
  manifest.files[manifest.binary].sha256='0'.repeat(64);
  receipt(join(directory,'computer-resource.json'),manifest);
  assert.throws(()=>admitComputerArtifact(source),/computer_resource_manifest_changed/);
});

test('final verification detects destination corruption and source replacement after admission', t => {
  const root = fixture(t), artifacts = { core: admitCoreArtifact(core(root)), computer: admitComputerArtifact(computer(root)) };
  const target = join(root, 'staged'); mkdirSync(target);
  stageAcceptedCoreArtifact(target, artifacts.core); stageAcceptedComputerRuntime(target, artifacts.computer);
  verifyAcceptedStagedArtifacts(target, artifacts);
  for (const name of ['cli.js', 'BUILD_INFO.json', binary]) {
    const file = join(target, name), original = readFileSync(file); writeFileSync(file, Buffer.alloc(original.length, 120));
    assert.throws(() => verifyAcceptedStagedArtifacts(target, artifacts), /accepted_artifact_changed/);
    writeFileSync(file, original);
  }
  writeFileSync(join(artifacts.core.directory, 'cli.js'), 'source replaced after admission');
  assert.throws(() => verifyAcceptedStagedArtifacts(target, artifacts), /accepted_artifact_changed/);
});

test('candidate output cannot replace active resources, old output or accepted source', t => {
  const root = fixture(t); mkdirSync(join(root, 'output'));
  const candidate = join(root, 'output/new-candidate');
  assert.equal(validateAcceptedOutput(candidate, root), candidate);
  for (const path of [root, join(root, 'output'), join(root, 'quimera/tauri/resources/sidecar'), join(root, 'output/harness-core-byok-refresh-20261025/nested')]) {
    assert.throws(() => validateAcceptedOutput(path, root), /accepted_output_not_fresh_candidate/);
  }
  mkdirSync(candidate); assert.throws(() => validateAcceptedOutput(candidate, root), /accepted_output_not_fresh_candidate/);
});

test('candidate output rejects linked ancestors', t => {
  const root = fixture(t), candidate = join(root, 'output/target'); mkdirSync(candidate, { recursive: true });
  const linked = join(root, 'output/link'); symlinkSync(candidate, linked, process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => validateAcceptedOutput(join(linked, 'new-candidate'), root), /accepted_artifact_path_invalid/);
});
