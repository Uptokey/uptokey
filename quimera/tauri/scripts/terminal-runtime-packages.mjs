import {readFileSync, lstatSync} from 'node:fs';
import {join} from 'node:path';
const exactVersion = /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** node-pty loads its platform addon dynamically; the bundler cannot discover it. */
export function terminalRuntimePackages(nodeModules, platform = process.platform, arch = process.arch) {
  if (!['win32', 'linux', 'darwin'].includes(platform) || !['x64', 'arm64'].includes(arch)) {
    throw Error('terminal_platform_unsupported');
  }
  const names = ['@lydell/node-pty', `@lydell/node-pty-${platform}-${arch}`];
  const directories = names.map(name => join(nodeModules, ...name.split('/')));
  const packages = directories.map((directory, index) => {
    if (!lstatSync(directory).isDirectory() || lstatSync(directory).isSymbolicLink()) throw Error('terminal_package_invalid');
    const value = JSON.parse(readFileSync(join(directory, 'package.json'), 'utf8'));
    if (value.name !== names[index] || typeof value.version !== 'string' || !exactVersion.test(value.version)) throw Error('terminal_package_invalid');
    return value;
  });
  if (packages[0].optionalDependencies?.[names[1]] !== packages[1].version) throw Error('terminal_addon_version_mismatch');
  return directories;
}
