import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, toNamespacedPath } from 'node:path';
import { admitFreshNodeRuntime, freshNodeRuntimeFromEnvironment, freshNodeArchiveTool, verifiedFreshNodeStagedRuntime, FRESH_NODE_VERSION, FRESH_NODE_ABI, FRESH_NODE_SIGNER } from './fresh-node-runtime.mjs';
import { stageNodeRuntimeLicense } from './accepted-sidecar-artifacts.mjs';

const sha = bytes => createHash('sha256').update(bytes).digest('hex');
function fixture(t, platform = 'win32') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'uptokey-node-fixture-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const prefix = `node-${FRESH_NODE_VERSION}-${platform === 'win32' ? 'win' : 'linux'}-x64`;
  const archiveName = prefix + (platform === 'win32' ? '.zip' : '.tar.xz');
  const runtimeEntry = prefix + (platform === 'win32' ? '/node.exe' : '/bin/node'), licenseEntry = prefix + '/LICENSE';
  const runtime = Buffer.from('synthetic upstream runtime fixture; never executable');
  const license = Buffer.from('Synthetic full archive LICENSE including every bundled component notice.\n');
  const archive = Buffer.from('synthetic archive fixture; tools are injected, no real GPG/archive/runtime verification');
  const inputs = { runtimePath: join(root, 'bin', 'node'), licensePath: join(root, 'LICENSE'), archivePath: join(root, archiveName),
    signedChecksumsPath: join(root, 'SHASUMS256.txt.asc'), keyringPath: join(root, 'public-keys.kbx'), platform, arch: 'x64' };
  mkdirSync(dirname(inputs.runtimePath));
  for (const [path, bytes] of [[inputs.runtimePath, runtime], [inputs.licensePath, license], [inputs.archivePath, archive],
    [inputs.signedChecksumsPath, 'synthetic signed checksums fixture'], [inputs.keyringPath, 'synthetic public keyring fixture']]) writeFileSync(path, bytes);
  const controls = {}, calls = [];
  const runner = (command, args, options) => {
    calls.push({ command, args, options });
    assert.equal(options.shell, false); assert.equal(options.stdio[0], 'ignore');
    assert.ok(options.timeout > 0 && options.timeout <= 60000 && options.maxBuffer > 0);
    for (const name of ['NODE_OPTIONS', 'NODE_PATH', 'GNUPGHOME', 'OPENAI_API_KEY', 'AWS_SECRET_ACCESS_KEY']) assert.equal(Object.hasOwn(options.env, name), false);
    if (controls.failure) return controls.failure;
    let bytes;
    if (command === 'gpgv') {
      assert.ok(args.includes('--homedir')); assert.ok(args.includes('--keyring'));
      assert.equal(args[args.indexOf('--homedir') + 1], '.');
      const home = options.cwd, keyring = args[args.indexOf('--keyring') + 1];
      assert.equal(keyring, 'nodejs-release-keys.kbx');
      assert.deepEqual(readFileSync(join(home, keyring)), readFileSync(inputs.keyringPath));
      assert.equal(args.at(-1), 'SHASUMS256.txt.asc');
      assert.deepEqual(readFileSync(join(home, args.at(-1))), readFileSync(inputs.signedChecksumsPath));
      assert.ok(args.every(arg => !arg.includes(':') && !arg.includes('\\') && !arg.startsWith('/')));
      writeFileSync(join(home, args[args.indexOf('--output') + 1]), controls.checksums ?? `${sha(archive)}  ${archiveName}\n`);
      controls.onGpg?.(join(home, keyring), join(home, args.at(-1)));
      bytes = Buffer.from(controls.status ?? `[GNUPG:] VALIDSIG ${FRESH_NODE_SIGNER} 2026-10-21 1792540800 0 4 0 1 8 01 ${FRESH_NODE_SIGNER}\n`);
    } else if (command === freshNodeArchiveTool()) {
      assert.equal(args[1], inputs.archivePath);
      if (args[0] === '-tf') bytes = Buffer.from(controls.listing ?? `${prefix}/\n${runtimeEntry}\n${licenseEntry}\n`);
      else if (args[0] === '-tvf') bytes = Buffer.from(controls.metadata ?? `-rw-r--r-- 0 root root ${runtime.length} Oct 21 12:00 ${runtimeEntry}\n-rw-r--r-- 0 root root ${license.length} Oct 21 12:00 ${licenseEntry}\n`);
      else if (args[0] === '-xOf') {
        bytes = args[2] === runtimeEntry ? (controls.archiveRuntime ?? runtime) : (controls.archiveLicense ?? license);
        if (args[2] === licenseEntry) controls.onArchiveRead?.();
      }
      else assert.fail('Unexpected archive operation');
    } else {
      assert.notEqual(command, inputs.runtimePath); assert.equal(args[0], '-p');
      assert.equal(dirname(command), calls[0].options.cwd, 'probe belongs to the private verifier home');
      assert.deepEqual(readFileSync(command), runtime, 'only authenticated runtime bytes may reach the probe');
      assert.equal(calls.filter(call => call.command === freshNodeArchiveTool()).length, 4, 'probe must follow all archive checks');
      controls.onProbe?.(command);
      bytes = Buffer.from(controls.identity ?? JSON.stringify({ version: FRESH_NODE_VERSION, abi: FRESH_NODE_ABI, platform, arch: 'x64' }));
    }
    return { status: 0, stdout: bytes, stderr: Buffer.alloc(0) };
  };
  return { root, inputs, runtime, license, archive, prefix, archiveName, runtimeEntry, licenseEntry, controls, calls, runner };
}
function admitted(f) { return admitFreshNodeRuntime(f.inputs, { runner: f.runner }); }
function noProbe(f) { assert.equal(f.calls.some(call => call.args[0] === '-p'), false); }

for (const platform of ['win32', 'linux']) test(`synthetic ${platform} chain binds signed archive, complete license and ABI before allowing staging`, t => {
  const f = fixture(t, platform), result = admitted(f);
  assert.equal(result.version, 'v24.22.1'); assert.equal(result.signatureVerified, true);
  assert.equal(result.nodeSha256, sha(f.runtime)); assert.equal(result.licenseSha256, sha(f.license));
  assert.equal(result.receipt.nativeRuntimeAccepted, false); assert.equal(result.receipt.publicNativeBuildReady, false);
  assert.equal(result.receipt.signerFingerprint, FRESH_NODE_SIGNER);
  const out = join(f.root, 'out'); mkdirSync(out); stageNodeRuntimeLicense(out, result);
  assert.deepEqual(readFileSync(join(out, 'NODE-LICENSE.txt')), f.license);
  assert.throws(() => stageNodeRuntimeLicense(out, result), /EEXIST/);
});

test('synthetic signature failures, wrong signer and ambiguous signatures refuse before archive/runtime access', t => {
  for (const status of ['', '[GNUPG:] BADSIG fixture\n',
    `[GNUPG:] VALIDSIG ${'A'.repeat(40)} 2026-10-21 1792540800 0 4 0 1 8 01 ${'A'.repeat(40)}\n`,
    `[GNUPG:] VALIDSIG ${FRESH_NODE_SIGNER} 2026-10-21 1792540800 0 4 0 1 8 01 ${FRESH_NODE_SIGNER}\n`.repeat(2)]) {
    const f = fixture(t); f.controls.status = status;
    assert.throws(() => admitted(f), /signature|signer/); assert.equal(f.calls.length, 1); noProbe(f);
  }
  const f = fixture(t); f.controls.status = `[GNUPG:] VALIDSIG ${'A'.repeat(40)} 2026-10-21 1792540800 0 4 0 1 8 01 ${FRESH_NODE_SIGNER}\n`;
  assert.equal(admitted(f).receipt.signingFingerprint, 'A'.repeat(40), 'a cryptographically verified subkey must bind the pinned primary');
});

test('synthetic checksums require the exact patched release archive once, with no self-attested receipt fallback', t => {
  for (const checksum of [`${'0'.repeat(64)}  node-${FRESH_NODE_VERSION}-win-x64.zip\n`,
    `${'0'.repeat(64)}  node-v24.21.0-win-x64.zip\n`, 'not checksums']) {
    const f = fixture(t); f.controls.checksums = checksum;
    assert.throws(() => admitted(f), /archive_checksum/); assert.equal(f.calls.length, 1); noProbe(f);
  }
  const f = fixture(t); f.controls.checksums = `${sha(f.archive)}  ${f.archiveName}\n`.repeat(2);
  assert.throws(() => admitted(f), /archive_checksum/); noProbe(f);
});

test('synthetic archive listing rejects duplicate, escaping, missing, symlink and hardlink selected entries', t => {
  for (const kind of ['duplicate', 'escape', 'missing', 'symlink', 'hardlink']) {
    const f = fixture(t);
    if (kind === 'duplicate') f.controls.listing = `${f.runtimeEntry}\n${f.runtimeEntry}\n${f.licenseEntry}\n`;
    if (kind === 'escape') f.controls.listing = `${f.runtimeEntry}\n${f.licenseEntry}\n${f.prefix}/../private\n`;
    if (kind === 'missing') f.controls.listing = `${f.runtimeEntry}\n`;
    if (kind === 'symlink' || kind === 'hardlink') f.controls.metadata = `${kind === 'symlink' ? 'l' : 'h'}rw-r--r-- root/root 50 Oct 21 12:00 ${f.runtimeEntry}\n-rw-r--r-- root/root 50 Oct 21 12:00 ${f.licenseEntry}\n`;
    assert.throws(() => admitted(f), /archive_entr/); noProbe(f);
  }
});

test('synthetic runtime substitutions and truncated MIT-only licenses cannot replace full archive content', t => {
  for (const which of ['runtime', 'license']) {
    const f = fixture(t); writeFileSync(which === 'runtime' ? f.inputs.runtimePath : f.inputs.licensePath, which === 'runtime' ? 'substituted binary' : 'MIT only');
    assert.throws(() => admitted(f), /archive_content/); noProbe(f);
  }
});

test('synthetic probe rejects old patch, wrong ABI/host, uncertain tool failure and inputs mutated during verification', t => {
  for (const changed of [{ version: 'v24.21.0' }, { abi: '138' }, { platform: 'darwin' }, { arch: 'arm64' }]) {
    const f = fixture(t); f.controls.identity = JSON.stringify({ version: FRESH_NODE_VERSION, abi: FRESH_NODE_ABI, platform: 'win32', arch: 'x64', ...changed });
    assert.throws(() => admitted(f), /identity_invalid/);
  }
  for (const failure of [{ status: 1 }, { status: null, signal: 'SIGTERM' }, { status: null, error: new Error('synthetic timeout') }]) {
    const f = fixture(t); f.controls.failure = failure; assert.throws(() => admitted(f), /tool_failed/); noProbe(f);
  }
  const f = fixture(t); f.controls.onProbe = () => writeFileSync(f.inputs.licensePath, 'changed after matching archive');
  assert.throws(() => admitted(f), /input_changed/);
});

test('fresh configuration requires all explicit local inputs and preserves the macOS historical boundary', t => {
  assert.throws(() => freshNodeRuntimeFromEnvironment({}), /provenance_inputs_required/);
  const f = fixture(t);
  assert.throws(() => admitFreshNodeRuntime({ ...f.inputs, platform: 'darwin' }, { runner: f.runner }), /platform_unsupported/);
  assert.throws(() => admitFreshNodeRuntime({ ...f.inputs, runtimePath: 'relative/node' }, { runner: f.runner }), /path_invalid/); noProbe(f);
  const source = readFileSync(new URL('./prepare-sidecar.mjs', import.meta.url), 'utf8');
  assert.ok(source.indexOf('freshNode = admitFreshNodeRuntime') < source.indexOf('Building proxy-local'));
  assert.ok(source.includes("else if (process.platform !== 'darwin')"));
  assert.ok(source.includes('const nodeLicense = freshNode ?? (accepted || isMac ? admitAcceptedNodeRuntimeLicense'));
});

test('fresh local inputs reject a directory junction before running a verifier', t => {
  const f = fixture(t), directory = dirname(f.inputs.runtimePath), moved = join(f.root, 'moved-bin');
  renameSync(directory, moved);
  try { symlinkSync(moved, directory, process.platform === 'win32' ? 'junction' : 'dir'); }
  catch (error) { if (['EPERM', 'EACCES'].includes(error.code)) { t.skip('Host denies creating test link'); return; } throw error; }
  assert.throws(() => admitted(f), /path_invalid/); assert.equal(f.calls.length, 0);
  if (process.platform === 'win32') {
    f.inputs.runtimePath = toNamespacedPath(f.inputs.runtimePath);
    assert.throws(() => admitted(f), /path_invalid/); assert.equal(f.calls.length, 0);
  }
});

test('Windows-native public keyring paths use an isolated basename with unchanged exact bytes', t => {
  const f = fixture(t); admitted(f);
  const gpg = f.calls[0], home = gpg.options.cwd;
  assert.notEqual(home, dirname(f.inputs.keyringPath));
  assert.equal(gpg.args[gpg.args.indexOf('--keyring') + 1].includes(':'), false);
  assert.equal(gpg.args.includes(f.inputs.keyringPath), false);
  const changed = fixture(t); changed.controls.onGpg = path => writeFileSync(path, 'synthetic changed public keyring');
  assert.throws(() => admitted(changed), /keyring_copy_changed/); noProbe(changed);
  const signedChanged = fixture(t); signedChanged.controls.onGpg = (_keyring, signature) => writeFileSync(signature, 'synthetic changed signed checksums');
  assert.throws(() => admitted(signedChanged), /signature_copy_changed/); noProbe(signedChanged);
});

test('canonical Windows OS tar selection ignores shadowing Git PATH while GPG arguments stay relative', t => {
  assert.equal(freshNodeArchiveTool({ SystemRoot: 'C:\\Windows', PATH: 'C:\\Program Files\\Git\\usr\\bin' }, 'win32'), 'C:\\Windows\\System32\\tar.exe');
  assert.equal(freshNodeArchiveTool({ SYSTEMROOT: 'D:\\Windows' }, 'win32'), 'D:\\Windows\\System32\\tar.exe');
  assert.equal(freshNodeArchiveTool({ PATH: '/usr/bin' }, 'linux'), 'tar');
  for (const env of [{}, { SystemRoot: 'relative' }, { SystemRoot: 'C:\\Windows\\..\\other' }]) {
    assert.throws(() => freshNodeArchiveTool(env, 'win32'), /systemroot_required/);
  }
  const f = fixture(t); admitted(f);
  assert.equal(f.calls.filter(call => call.command === freshNodeArchiveTool()).length, 4);
  if (process.platform === 'win32') assert.match(f.calls[1].command, /^[A-Za-z]:\\.*\\System32\\tar\.exe$/);
  assert.equal(f.calls[0].command, 'gpgv'); assert.equal(f.calls[0].args.includes('.'), true);
});

test('runtime input replacement before probing is never executed; private snapshot and original rechecks remain bound', t => {
  const beforeSnapshot = fixture(t);
  beforeSnapshot.controls.onArchiveRead = () => writeFileSync(beforeSnapshot.inputs.runtimePath, 'synthetic attacker replacement executable');
  assert.throws(() => admitted(beforeSnapshot), /probe_snapshot_changed/); noProbe(beforeSnapshot);
  const afterSnapshot = fixture(t); let probed;
  afterSnapshot.controls.onProbe = command => {
    probed = command; writeFileSync(afterSnapshot.inputs.runtimePath, 'synthetic swapped original input');
    assert.deepEqual(readFileSync(command), afterSnapshot.runtime);
  };
  assert.throws(() => admitted(afterSnapshot), /input_changed/);
  assert.ok(probed); assert.notEqual(probed, afterSnapshot.inputs.runtimePath);
});

test('fresh addon probes select the exact verified staged runtime and reject a replaced staged binary', t => {
  const f = fixture(t), stage = join(f.root, 'staged-node'); writeFileSync(stage, f.runtime);
  const identity = { nodeBytes: f.runtime.length, nodeSha256: sha(f.runtime) };
  assert.equal(verifiedFreshNodeStagedRuntime(stage, identity), stage);
  writeFileSync(stage, 'synthetic replaced staged executable');
  assert.throws(() => verifiedFreshNodeStagedRuntime(stage, identity), /probe_snapshot_changed/);
  const source = readFileSync(new URL('./prepare-sidecar.mjs', import.meta.url), 'utf8');
  assert.ok(source.includes('freshNode ? verifiedFreshNodeStagedRuntime(stagedRuntime, freshNode)'));
  assert.ok(source.includes('run(addonProbeRuntime(), ["-e", "require(\'better-sqlite3\')'));
  assert.ok(source.includes('run(addonProbeRuntime(), ["-e", "require(\'@napi-rs/keyring\')'));
});

test('Windows verbatim-root inputs retain absolute nonlink admission for all five local artifacts', { skip: process.platform !== 'win32' }, t => {
  const f = fixture(t);
  for (const key of ['runtimePath', 'licensePath', 'archivePath', 'signedChecksumsPath', 'keyringPath']) f.inputs[key] = toNamespacedPath(f.inputs[key]);
  assert.equal(admitted(f).nodeSha256, sha(f.runtime));
  assert.equal(f.calls.some(call => call.command === f.inputs.runtimePath), false);
});
