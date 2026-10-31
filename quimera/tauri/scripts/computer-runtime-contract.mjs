export const COMPUTER_TOOLS = Object.freeze([
  'computer_click', 'computer_key', 'computer_screenshot', 'computer_scroll',
  'computer_snapshot', 'computer_type', 'computer_windows',
]);

export function computerBinaryName(platform) {
  if (!['win32', 'linux', 'darwin'].includes(platform)) throw Error('computer_platform_unsupported');
  return platform === 'win32' ? 'uptokey-computer-mcp.exe' : 'uptokey-computer-mcp';
}

export function computerNativeTarget(platform, arch) {
  computerBinaryName(platform);
  const cpu = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!cpu) throw Error('computer_arch_unsupported');
  return `${cpu}-${{ win32: 'pc-windows-msvc', linux: 'unknown-linux-gnu', darwin: 'apple-darwin' }[platform]}`;
}

export function validateComputerAttestation(manifest, platform, arch) {
  const name = computerBinaryName(platform), record = manifest.computerMcp;
  // Old sidecars remain verifiable; every newly prepared product includes this record.
  if (record === undefined && !Object.keys(manifest.files).some(file => /^uptokey-computer-mcp(?:\.exe)?$/.test(file))) return;
  if (!record || record.schema_version !== 1 || record.binary !== name
    || record.platform !== platform || record.arch !== arch
    || record.target !== computerNativeTarget(platform, arch)
    || JSON.stringify(record.tools) !== JSON.stringify(COMPUTER_TOOLS)
    || !manifest.files[name] || !/^[a-f0-9]{64}$/.test(record.resourceManifestSha256)
    || manifest.files['computer-resource.json']?.sha256 !== record.resourceManifestSha256) throw Error('computer_runtime_attestation_invalid');
}
