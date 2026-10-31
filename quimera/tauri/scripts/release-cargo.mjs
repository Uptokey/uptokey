import { homedir } from 'node:os';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = resolve(dirname(fileURLToPath(import.meta.url)), '../../..');

// Tauri's production protocol is a Cargo feature, independent of optimization.
export function releaseBuildArgs(interfaceMode = 'shell') {
  if (!['shell', 'harness'].includes(interfaceMode)) throw new Error('release_interface_invalid');
  if (interfaceMode === 'harness') {
    return ['build', '--release', '--locked', '--offline', '--bin', 'uptokey_tauri',
      '--features', 'harness-entry,tauri/custom-protocol', '-j', '1'];
  }
  return ['build', '--release', '--locked', '--features', 'tauri/custom-protocol'];
}

export function releaseBuildEnvironment(env = process.env, home = homedir(), root = sourceRoot) {
  // Cargo's encoded form preserves arguments containing spaces without shell parsing.
  if (env.RUSTFLAGS?.trim() && !env.CARGO_ENCODED_RUSTFLAGS) {
    throw new Error('release_use_encoded_rustflags_to_preserve_custom_arguments');
  }
  const flags = env.CARGO_ENCODED_RUSTFLAGS ? env.CARGO_ENCODED_RUSTFLAGS.split('\x1f') : [];
  flags.push(`--remap-path-prefix=${home}=/uptokey-build`, `--remap-path-prefix=${root}=/uptokey-source`);
  const result = { ...env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
  delete result.RUSTFLAGS;
  return result;
}

function containsPathPrefix(binary, prefix, encoding) {
  const needle = Buffer.from(prefix, encoding);
  if (!needle.length) throw new Error('release_build_path_prefix_empty');
  for (let offset = binary.indexOf(needle); offset !== -1; offset = binary.indexOf(needle, offset + 1)) {
    const next = offset + needle.length;
    if (/[\\/]$/.test(prefix) || next === binary.length) return true;
    // Match a whole directory component, including a bare terminated path.
    // HOME=/root must reject /root/.cargo, but not MCP's /roots/list_changed.
    // Continue scanning after incidental prefixes: a later real path still fails.
    if (encoding === 'utf16le' && next + 1 >= binary.length) return true;
    const code = encoding === 'utf16le' ? binary.readUInt16LE(next) : binary[next];
    if (code <= 0x20 || '/\\"\'`()[]{},;:#?'.includes(String.fromCharCode(code))) return true;
  }
  return false;
}

export function assertNoPersonalBuildPaths(binary, home = homedir(), root = sourceRoot) {
  for (const value of [home, root]) {
    for (const prefix of new Set([value, value.replaceAll('\\', '/'), value.replaceAll('/', '\\')])) {
      if (containsPathPrefix(binary, prefix, 'utf8') || containsPathPrefix(binary, prefix, 'utf16le')) {
        throw new Error('release_binary_contains_personal_build_path');
      }
    }
  }
}
