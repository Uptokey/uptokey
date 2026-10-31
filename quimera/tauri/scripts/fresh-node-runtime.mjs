// Upstream Node runtime/license verification only; not native release acceptance.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, parse, resolve, toNamespacedPath, win32 } from 'node:path';
import { chmodSync, constants, copyFileSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { sha256File } from './verify-sidecar.mjs';
import { assertLinuxSignerFingerprint } from '../../../proxy/core/scripts/native-signature-evidence.mjs';
import { hostEnvironment } from '../computer-use/session/host-environment.mjs';

// Security release, 2026-10-21: https://nodejs.org/en/blog/release/v24.22.1
// Primary signer pinned from the corresponding nodejs/node v24.22.1 README.
export const FRESH_NODE_VERSION = 'v24.22.1';
export const FRESH_NODE_ABI = '137';
export const FRESH_NODE_SIGNER = '5BE8A3F6C8A5C01D106C0AD820B1A390B168D356';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
const PROBE = 'JSON.stringify({version:process.version,abi:process.versions.modules,platform:process.platform,arch:process.arch})';

export function freshNodeArchiveTool(env = hostEnvironment(), hostPlatform = process.platform) {
  if (hostPlatform !== 'win32') return 'tar';
  const systemRoot = Object.entries(env).find(([name]) => name.toLowerCase() === 'systemroot')?.[1];
  if (typeof systemRoot !== 'string' || !/^[A-Za-z]:\\/.test(systemRoot) || win32.resolve(systemRoot) !== systemRoot) {
    throw Error('fresh_node_windows_systemroot_required');
  }
  // Windows' OS bsdtar supports the official zip and native drive paths. Git's
  // GNU tar treats those paths as remote hosts; never select it through PATH.
  return win32.join(systemRoot, 'System32', 'tar.exe');
}

function checkedFile(path, maximum) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) throw Error('fresh_node_path_invalid');
  const root = parse(path).root;
  for (let current = path; ;) {
    // Same root-only metadata spelling as native-artifact-version-evidence.
    // Never let dirname descend from a verbatim drive root to relative C:.
    const metadataPath = current === root && /^\\\\\?\\[A-Za-z]:\\$/.test(root) ? root.slice(4) : current;
    const meta = lstatSync(metadataPath);
    if (meta.isSymbolicLink() || (current === path ? !meta.isFile() : !meta.isDirectory())) throw Error('fresh_node_path_invalid');
    if (current === root) break;
    const parent = dirname(current);
    current = parent.length < root.length ? root : parent;
  }
  if (toNamespacedPath(realpathSync.native(path)) !== toNamespacedPath(path)) throw Error('fresh_node_path_invalid');
  const bytes = lstatSync(path).size;
  if (!Number.isSafeInteger(bytes) || bytes <= 0 || bytes > maximum) throw Error('fresh_node_file_size_invalid');
  return { bytes, sha256: sha256File(path) };
}

/** Byte identity assertion only. Upstream trust must already be admitted. */
export function verifiedFreshNodeStagedRuntime(path, admitted) {
  const record = checkedFile(path, 512 * 1024 * 1024);
  if (record.bytes !== admitted.nodeBytes || record.sha256 !== admitted.nodeSha256) throw Error('fresh_node_probe_snapshot_changed');
  return path;
}

function execute(runner, command, args, env, maximum = 65536, timeout = 30000, cwd) {
  const result = runner(command, args, { env, shell: false, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    encoding: null, timeout, maxBuffer: maximum, ...(cwd ? { cwd } : {}) });
  if (result?.error || result?.signal || result?.status !== 0 || !Buffer.isBuffer(result.stdout)
      || result.stdout.length > maximum) throw Error('fresh_node_verification_tool_failed');
  return result.stdout;
}

function verifiedSigner(status) {
  if (/^\[GNUPG:\] (?:BADSIG|ERRSIG|REVKEYSIG|EXPKEYSIG|EXPSIG|NO_PUBKEY|NODATA|FAILURE|ERROR)\b/m.test(status)) throw Error('fresh_node_signature_invalid');
  const signatures = [...status.matchAll(/^\[GNUPG:\] VALIDSIG ([^\r\n]+)$/gm)];
  if (signatures.length !== 1) throw Error('fresh_node_signature_invalid');
  const fields = signatures[0][1].split(' ');
  if (![9, 10].includes(fields.length) || !/^[A-F0-9]{40}$/.test(fields[0])
      || !['8', '9', '10', '11'].includes(fields[7])) throw Error('fresh_node_signature_invalid');
  const primary = fields.length === 10 ? fields[9] : fields[0];
  assertLinuxSignerFingerprint(primary, FRESH_NODE_SIGNER);
  return { primary, signing: fields[0] };
}

/** Offline admission from official signed archive bytes, not a caller's receipt flags.
 * Injectable runner is for synthetic tests; ordinary callers use bounded real tools.
 * macOS deliberately retains its separate accepted Node/signing path. */
export function admitFreshNodeRuntime({ runtimePath, licensePath, archivePath, signedChecksumsPath, keyringPath,
  platform = process.platform, arch = process.arch }, { runner = spawnSync } = {}) {
  if (!['win32', 'linux'].includes(platform) || arch !== 'x64') throw Error('fresh_node_platform_unsupported');
  const os = platform === 'win32' ? 'win' : 'linux';
  const prefix = `node-${FRESH_NODE_VERSION}-${os}-${arch}`;
  const archiveName = prefix + (platform === 'win32' ? '.zip' : '.tar.xz');
  const runtimeEntry = prefix + (platform === 'win32' ? '/node.exe' : '/bin/node'), licenseEntry = prefix + '/LICENSE';
  const inputs = [
    [runtimePath, 512 * 1024 * 1024], [licensePath, 16 * 1024 * 1024], [archivePath, 256 * 1024 * 1024],
    [signedChecksumsPath, 2 * 1024 * 1024], [keyringPath, 8 * 1024 * 1024],
  ].map(([path, maximum]) => ({ path, maximum, ...checkedFile(path, maximum) }));
  const [runtime, license, archive, signature, keyring] = inputs;
  const temporary = realpathSync(mkdtempSync(join(tmpdir(), 'uptokey-node-verify-')));
  try {
    const env = hostEnvironment(), archiveTool = freshNodeArchiveTool(env), checksumPath = join(temporary, 'SHASUMS256.txt');
    // Git's GPG also misinterprets native absolute home/signature paths. Keep
    // every GPG path relative to this isolated cwd on both Windows and Unix.
    const localKeyringName = 'nodejs-release-keys.kbx', localKeyring = join(temporary, localKeyringName);
    const localSignatureName = 'SHASUMS256.txt.asc', localSignature = join(temporary, localSignatureName);
    copyFileSync(keyringPath, localKeyring, constants.COPYFILE_EXCL);
    copyFileSync(signedChecksumsPath, localSignature, constants.COPYFILE_EXCL);
    const copiedKeyring = checkedFile(localKeyring, keyring.maximum);
    if (copiedKeyring.bytes !== keyring.bytes || copiedKeyring.sha256 !== keyring.sha256) throw Error('fresh_node_keyring_copy_changed');
    const copiedSignature = checkedFile(localSignature, signature.maximum);
    if (copiedSignature.bytes !== signature.bytes || copiedSignature.sha256 !== signature.sha256) throw Error('fresh_node_signature_copy_changed');
    const status = execute(runner, 'gpgv', ['--homedir', '.', '--status-fd', '1', '--keyring', localKeyringName,
      '--output', 'SHASUMS256.txt', localSignatureName], env, 65536, 30000, temporary).toString('utf8');
    const usedKeyring = checkedFile(localKeyring, keyring.maximum);
    if (usedKeyring.bytes !== keyring.bytes || usedKeyring.sha256 !== keyring.sha256) throw Error('fresh_node_keyring_copy_changed');
    const usedSignature = checkedFile(localSignature, signature.maximum);
    if (usedSignature.bytes !== signature.bytes || usedSignature.sha256 !== signature.sha256) throw Error('fresh_node_signature_copy_changed');
    const signer = verifiedSigner(status);
    checkedFile(checksumPath, 2 * 1024 * 1024);
    const checksums = readFileSync(checksumPath), rows = checksums.toString('utf8').split(/\r?\n/).filter(Boolean);
    const expected = rows.map(line => /^([a-f0-9]{64}) {2}([^\s]+)$/.exec(line)).filter(match => match?.[2] === archiveName);
    if (expected.length !== 1 || expected[0][1] !== archive.sha256) throw Error('fresh_node_archive_checksum_invalid');
    const listing = execute(runner, archiveTool, ['-tf', archivePath], env, 16 * 1024 * 1024).toString('utf8').split(/\r?\n/).filter(Boolean);
    const names = new Set();
    if (!listing.length || listing.length > 100000) throw Error('fresh_node_archive_entries_invalid');
    for (const name of listing) {
      const clean = name.replace(/\/$/, '');
      if (name.length > 1024 || name.includes('\\') || clean !== prefix && !clean.startsWith(prefix + '/')
          || clean.split('/').some(part => !part || part === '.' || part === '..') || names.has(clean)) throw Error('fresh_node_archive_entries_invalid');
      names.add(clean);
    }
    if (!names.has(runtimeEntry) || !names.has(licenseEntry)) throw Error('fresh_node_archive_entries_invalid');
    const metadata = execute(runner, archiveTool, ['-tvf', archivePath, runtimeEntry, licenseEntry], env).toString('utf8').split(/\r?\n/).filter(Boolean);
    if (metadata.length !== 2 || [runtimeEntry, licenseEntry].some(entry => {
      const rows = metadata.filter(row => row.endsWith(' ' + entry));
      return rows.length !== 1 || rows[0][0] !== '-';
    })) throw Error('fresh_node_archive_entry_type_invalid');
    for (const [entry, record] of [[runtimeEntry, runtime], [licenseEntry, license]]) {
      const bytes = execute(runner, archiveTool, ['-xOf', archivePath, entry], env, record.bytes + 1024, 60000);
      if (bytes.length !== record.bytes || sha(bytes) !== record.sha256) throw Error('fresh_node_archive_content_mismatch');
    }
    // Execute a private verified snapshot, never the caller's mutable input path.
    // This prevents an input-path swap; it does not promise isolation from a
    // malicious process already running as this same OS user.
    const probeRuntime = join(temporary, platform === 'win32' ? 'node.exe' : 'node');
    copyFileSync(runtimePath, probeRuntime, constants.COPYFILE_EXCL);
    const probeIdentity = { nodeBytes: runtime.bytes, nodeSha256: runtime.sha256 };
    verifiedFreshNodeStagedRuntime(probeRuntime, probeIdentity);
    if (process.platform !== 'win32') chmodSync(probeRuntime, 0o700);
    const probe = execute(runner, probeRuntime, ['-p', PROBE], env, 4096, 15000).toString('utf8');
    verifiedFreshNodeStagedRuntime(probeRuntime, probeIdentity);
    let identity; try { identity = JSON.parse(probe); } catch { throw Error('fresh_node_identity_invalid'); }
    if (Object.keys(identity ?? {}).sort().join(',') !== 'abi,arch,platform,version' || identity.version !== FRESH_NODE_VERSION
        || identity.abi !== FRESH_NODE_ABI || identity.platform !== platform || identity.arch !== arch) throw Error('fresh_node_identity_invalid');
    for (const input of inputs) {
      const current = checkedFile(input.path, input.maximum);
      if (current.bytes !== input.bytes || current.sha256 !== input.sha256) throw Error('fresh_node_input_changed');
    }
    return Object.freeze({ runtimePath, licensePath, version: FRESH_NODE_VERSION, nodeSha256: runtime.sha256, nodeBytes: runtime.bytes,
      licenseSha256: license.sha256, licenseBytes: license.bytes, signatureVerified: true,
      sourceUrl: `https://nodejs.org/dist/${FRESH_NODE_VERSION}/${archiveName}`,
      receipt: Object.freeze({ schema: 'uptokey-node-upstream-verification-v1', scope: 'node-runtime-and-full-license-only',
        version: FRESH_NODE_VERSION, platform, arch, nodeModuleAbi: Number(FRESH_NODE_ABI),
        archive: { file: archiveName, sha256: archive.sha256 }, signedChecksumsSha256: signature.sha256,
        verifiedChecksumsSha256: sha(checksums), keyringSha256: keyring.sha256, signerFingerprint: signer.primary,
        signingFingerprint: signer.signing, runtimeSha256: runtime.sha256, licenseSha256: license.sha256,
        nativeRuntimeAccepted: false, publicNativeBuildReady: false }) });
  } finally { rmSync(temporary, { recursive: true, force: true }); }
}

export function freshNodeRuntimeFromEnvironment(env = process.env) {
  const names = ['UPTOKEY_NODE_RUNTIME', 'UPTOKEY_NODE_LICENSE', 'UPTOKEY_NODE_ARCHIVE',
    'UPTOKEY_NODE_SIGNED_CHECKSUMS', 'UPTOKEY_NODE_RELEASE_KEYRING'];
  if (names.some(name => typeof env[name] !== 'string' || !env[name])) throw Error('fresh_node_provenance_inputs_required');
  return { runtimePath: env[names[0]], licensePath: env[names[1]], archivePath: env[names[2]],
    signedChecksumsPath: env[names[3]], keyringPath: env[names[4]] };
}
