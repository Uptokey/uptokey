import { cpSync, chmodSync, lstatSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { releaseBuildEnvironment, assertNoPersonalBuildPaths } from './release-cargo.mjs';
import { COMPUTER_TOOLS, computerBinaryName, computerNativeTarget } from './computer-runtime-contract.mjs';
import { stageComputerResource } from './computer-resource.mjs';
import { signMacosComputer } from '../../../proxy/core/scripts/sign-notarize-macos.mjs';

const tauriDir = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Compile the one canonical Rust helper for this host, without starting a desktop grant. */
export function prepareComputerRuntime(outDir, {
  platform = process.platform, arch = process.arch, run = spawnSync, env = process.env, signNative = signMacosComputer,
  source = join(tauriDir, 'computer-use'), targetDir = join(tauriDir, 'target', 'computer-use-native'),
  toolchain,
} = {}) {
  const name = computerBinaryName(platform), target = computerNativeTarget(platform, arch);
  if (toolchain !== undefined && (typeof toolchain !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,100}$/.test(toolchain))) throw Error('computer_runtime_toolchain_invalid');
  const toolchainArgs = toolchain === undefined ? [] : [`+${toolchain}`];
  const invoke = (command, args, options = {}) => {
    const result = run(command, args, { cwd: tauriDir, windowsHide: true, encoding: 'utf8', ...options });
    if (result.error || result.status !== 0) throw Error('computer_runtime_build_or_probe_failed');
    return result.stdout;
  };
  const buildEnv = { ...releaseBuildEnvironment(env), CARGO_TARGET_DIR: targetDir };
  // The installed default may already be the pinned release even when a named
  // rustup alias is incomplete. Verify its version instead of repairing rustup.
  const version = invoke('rustc', [...toolchainArgs, '-vV'], { env: buildEnv, timeout: 10000 });
  if (version.match(/^host: (.+)$/m)?.[1].trim() !== target) throw Error('computer_runtime_requires_native_target');
  if (version.match(/^release: (.+)$/m)?.[1].trim() !== '1.98.1') throw Error('computer_runtime_compiler_version_invalid');
  invoke('cargo', [...toolchainArgs, 'build', '--release', '--locked', '--manifest-path', join(source, 'Cargo.toml'), '--target', target, '-j', '1'],
    { env: buildEnv, stdio: 'inherit' });
  const executable = join(targetDir, target, 'release', name);
  const stat = lstatSync(executable);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw Error('computer_runtime_binary_invalid');
  const bytes = readFileSync(executable);
  assertNoPersonalBuildPaths(bytes);
  const hash = createHash('sha256').update(bytes).digest('hex');
  const probeEnv = Object.fromEntries(Object.entries(env).filter(([key]) =>
    /^(PATH|PATHEXT|SYSTEMROOT|WINDIR|TEMP|TMP|HOME|USERPROFILE|XDG_RUNTIME_DIR)$/i.test(key)));
  // Static declarations only: no window listing, capture, focus, input or vault access.
  const raw = invoke(executable, ['--tools-json'], { env: probeEnv, timeout: 10000, maxBuffer: 256 * 1024 });
  let tools;
  try { tools = JSON.parse(raw).tools.map(tool => tool.name).sort(); } catch { throw Error('computer_runtime_tools_invalid'); }
  if (JSON.stringify(tools) !== JSON.stringify(COMPUTER_TOOLS)) throw Error('computer_runtime_tools_invalid');
  const destination = join(outDir, name);
  cpSync(executable, destination, { errorOnExist: true, force: false });
  if (platform !== 'win32') chmodSync(destination, 0o755);
  if ([executable, destination].some(path => createHash('sha256').update(readFileSync(path)).digest('hex') !== hash))
    throw Error('computer_runtime_changed_during_packaging');
  // Signing mutates Mach-O bytes; attest the signed destination, never the pre-sign hash.
  if (platform === 'darwin') signNative({ executable: destination, identity: env.UPTOKEY_APPLE_SIGNING_IDENTITY, teamId: env.UPTOKEY_APPLE_TEAM_ID });
  const resource = stageComputerResource(outDir, destination, { platform, arch });
  return { schema_version: 1, binary: name, platform, arch, target, tools, resourceManifestSha256: resource.manifestSha256 };
}
