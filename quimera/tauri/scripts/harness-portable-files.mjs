import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';

// Exact public-source closure used by the existing Harness native menu and its
// lifecycle helpers. This is deliberately not a recursive copy of the checkout.
// Native binaries, Node and @napi-rs/keyring are attested by the package builder;
// profiles, computer grants, pairing state and output are created at destination.
const lab = 'experiments/deepseek-workbench';
const scripts = [
  'account-client', 'account-disconnect', 'account', 'approved-context-client',
  'approved-context', 'attachment-cache-policy', 'canonical-account-client',
  'canonical-account', 'computer-session', 'context-identity', 'controller',
  'core-bridge-server', 'core-bridge', 'desktop', 'desktop-build-target',
  'desktop-target', 'diagnostics', 'executor',
  'export-workspace-encrypted', 'export-workspace', 'harness-paths', 'host-environment',
  'hosted-catalog-client', 'hosted-dispatch', 'hosted-transport',
  'image-materialization-policy', 'import-public-api', 'import-workspace-bytes',
  'import-workspace-encrypted', 'import-workspace', 'lab', 'local-model-bridge',
  'product-contract', 'installed-runtime', 'podman-secret-input', 'provider-model-refresh-client', 'provider-model-refresh',
  'public-api-config', 'public-api-selection', 'reconnect', 'register-public-api',
  'restart-runtime', 'runtime-checkpoint', 'runtime-engine', 'runtime-health',
  'startup-link', 'transposition-gate', 'vault-key', 'workspace-export-crypto',
  'workspace-volume-policy',
];

export const HARNESS_PORTABLE_EXTERNALS = Object.freeze(['@napi-rs/keyring']);
export const HARNESS_PORTABLE_FILES = Object.freeze([
  ...scripts.map(name => `${lab}/scripts/${name}.mjs`),
  `${lab}/scripts/workspace-archive.py`,
  `${lab}/scripts/workspace-import.py`,
  `${lab}/package.json`,
  // lab.mjs checks the two runtime descriptors before connecting to an existing
  // image. Shipping them does not ship/build an OCI image or enable a build UI.
  `${lab}/runtime/package.json`,
  `${lab}/runtime/Containerfile`,
  `${lab}/runtime/account/protocol.mjs`,
  `${lab}/runtime/account/provider-setup.mjs`,
  `${lab}/runtime/contracts/context-protocol.mjs`,
  ...['hosted-catalog', 'hosted-provider-replay', 'hosted-receipt', 'hosted-request', 'hosted-result', 'plain-data']
    .map(name => `${lab}/runtime/contracts/${name}.js`),
  'proxy/contratos/account-native.js',
  'quimera/tauri/computer-use/resource-launcher.mjs',
  'quimera/tauri/computer-use/session/host-environment.mjs',
  // desktop.mjs statically imports its build helpers even in recover/start.
  // Keep those source imports intact; the portable launcher exposes no build.
  'quimera/tauri/scripts/computer-resource.mjs',
  'quimera/tauri/scripts/computer-runtime-contract.mjs',
  // The existing offline product-contract reads these exact canonical files.
  'quimera/tauri/Cargo.toml',
  'quimera/tauri/tauri.conf.json',
  'quimera/tauri/tauri.harness.conf.json',
  'quimera/tauri/scripts/verify-sidecar.mjs',
  'quimera/tauri/resources/sidecar/manifest.json',
  '.github/workflows/ci.yml',
].sort());

const forbidden = /(?:^|\/)(?:\.local|\.git|node_modules|output|target|upstream|profiles?|credentials?)(?:\/|$)|(?:^|\/)\.env(?:\.|$)|\.(?:test|spec)\.[cm]?js$/i;
const publicExtensions = /\.(?:mjs|js|json|py|toml|yml)$/;
const allowed = new Set(HARNESS_PORTABLE_FILES);

function validateName(path) {
  if (typeof path !== 'string' || isAbsolute(path) || path.includes('\\') || path.split('/').some(part => !part || part === '.' || part === '..')
      || forbidden.test(path) || (!publicExtensions.test(path) && !path.endsWith('/Containerfile'))) {
    throw Error('harness_portable_path_invalid');
  }
}

function validateImports(root, path, text) {
  // All current public helpers use literal static imports/re-exports. Runtime
  // selected resources (Python and the attested computer closure) are explicit
  // above or supplied by their existing verifier, never discovered by walking.
  const imports = /(?:^|\n)\s*(?:import|export)\s+(?:[^'";]*?\s+from\s*)?['"]([^'"]+)['"]/g;
  for (const match of text.matchAll(imports)) {
    const specifier = match[1];
    if (specifier.startsWith('node:') || HARNESS_PORTABLE_EXTERNALS.includes(specifier)) continue;
    if (!specifier.startsWith('.')) throw Error(`harness_portable_external_unlisted:${path}:${specifier}`);
    const target = relative(root, resolve(root, dirname(path), specifier)).split(sep).join('/');
    validateName(target);
    if (!allowed.has(target)) throw Error(`harness_portable_import_unlisted:${path}:${target}`);
  }
}

/** Return public files only; caller copies each entry to application/<path>. */
export function collectHarnessPortableFiles(repoRoot, { installedSidecar = false } = {}) {
  const root = realpathSync(repoRoot);
  if (!lstatSync(root).isDirectory()) throw Error('harness_portable_root_invalid');
  // In the canonical sidecar the real outer manifest attests this entire
  // closure. Copying it inside itself would be recursive; copying the checkout
  // manifest would falsely point at an older core. Legacy portable stays intact.
  const files = installedSidecar ? HARNESS_PORTABLE_FILES.filter(path => path !== 'quimera/tauri/resources/sidecar/manifest.json') : HARNESS_PORTABLE_FILES;
  return files.map(path => {
    validateName(path);
    let source = root;
    for (const part of path.split('/')) {
      source = resolve(source, part);
      const stat = lstatSync(source);
      // Check every component so a junction/symlink cannot redirect a public
      // source path into a personal profile or another checkout.
      if (stat.isSymbolicLink() || realpathSync(source) !== source) throw Error(`harness_portable_link_forbidden:${path}`);
    }
    const stat = lstatSync(source);
    if (!stat.isFile() || stat.size === 0 || stat.size > 8 * 1024 * 1024) throw Error(`harness_portable_file_invalid:${path}`);
    if (/\.[cm]?js$/.test(path)) validateImports(root, path, readFileSync(source, 'utf8'));
    return { source, path };
  });
}
