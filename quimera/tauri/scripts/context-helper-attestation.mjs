import { existsSync, lstatSync, readFileSync } from 'node:fs';
import { join, relative, isAbsolute } from 'node:path';
import { extractRuntimeSpecifiers } from '../../../proxy/core/scripts/beta-runtime-contract.mjs';

export const CONTEXT_HELPER_ENTRY = 'workspace-context-helper.js';
const EXTERNALS = ['@napi-rs/keyring', 'undici'];
const UNDICI_VERSION = '7.30.0';

/** A narrow executable closure keeps native account linking responsive without a hash cache. */
export function contextHelperPackages(nodeModules, code) {
  const imports = extractRuntimeSpecifiers(code);
  if (JSON.stringify(imports) !== JSON.stringify(EXTERNALS)) throw new Error('context_helper_dependency_drift');
  const packages = new Set();
  function visit(name, optional = false) {
    if (name !== 'undici' && !/^@napi-rs\/keyring(?:-[a-z0-9-]+)?$/.test(name)) throw new Error('context_helper_dependency_drift');
    const path = join(nodeModules, ...name.split('/'));
    if (optional && !existsSync(path)) return;
    const tail = relative(nodeModules, path);
    if (!tail || isAbsolute(tail) || tail.startsWith('..')) throw new Error('context_helper_package_invalid');
    let current = nodeModules;
    for (const segment of tail.split(/[\\/]/)) {
      current = join(current, segment);
      if (!lstatSync(current).isDirectory() || lstatSync(current).isSymbolicLink()) throw new Error('context_helper_package_invalid');
    }
    if (packages.has(path)) return;
    const metadata = join(path, 'package.json');
    if (!lstatSync(metadata).isFile() || lstatSync(metadata).isSymbolicLink()) throw new Error('context_helper_package_invalid');
    const pkg = JSON.parse(readFileSync(metadata, 'utf8'));
    if (pkg.name !== name) throw new Error('context_helper_package_invalid');
    // The portable core keeps Undici external. Accept only its reviewed, dependency-free release.
    if (name === 'undici' && (pkg.version !== UNDICI_VERSION || pkg.main !== 'index.js'
        || ['dependencies', 'optionalDependencies', 'peerDependencies'].some(key => Object.keys(pkg[key] ?? {}).length))) throw new Error('context_helper_dependency_drift');
    packages.add(path);
    for (const dependency of Object.keys(pkg.dependencies ?? {}).sort()) visit(dependency);
    for (const dependency of Object.keys(pkg.optionalDependencies ?? {}).sort()) visit(dependency, true);
  }
  for (const name of EXTERNALS) visit(name);
  return [...packages].sort();
}

export function contextHelperAttestation(files, binaryName, packages, nodeModules, code, platform = process.platform) {
  const expectedPackages = contextHelperPackages(nodeModules, code);
  if (JSON.stringify([...packages].sort()) !== JSON.stringify(expectedPackages)) throw new Error('context_helper_closure_incomplete');
  const nested = platform === 'darwin' && binaryName === 'UptokeyCore.app/Contents/MacOS/uptokey';
  const base = nested ? 'UptokeyCore.app/Contents/MacOS/' : '';
  const prefixes = packages.map(path => `${base}node_modules/${relative(nodeModules, path).replaceAll('\\', '/')}/`);
  const macosFiles = platform === 'darwin' ? ['cli.js', 'composition-worker.js', 'service-schema-worker.js', 'uptokey-macos-protected-keyring.node'].map(name => base + name) : [];
  const entry = base + CONTEXT_HELPER_ENTRY;
  const names = [binaryName, entry, base + 'package.json', ...macosFiles, ...Object.keys(files).filter(name => prefixes.some(prefix => name.startsWith(prefix)))].sort();
  if (names.length > 384 || new Set(names).size !== names.length || names.some(name => !files[name])
      || !names.includes(base + 'node_modules/@napi-rs/keyring/package.json') || !names.includes(base + 'node_modules/@napi-rs/keyring/index.js')
      || !names.includes(base + 'node_modules/undici/package.json') || !names.includes(base + 'node_modules/undici/index.js')
      || !names.some(name => name.endsWith('.node'))) throw new Error('context_helper_closure_incomplete');
  return { entry, files: names, externalSpecifiers: [...EXTERNALS] };
}
