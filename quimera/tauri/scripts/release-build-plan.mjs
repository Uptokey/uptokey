// Pure selection for the native release entry. Planning never reads artifacts,
// creates output, or launches a tool. The legacy sidecar entry remains separate.
import { releaseBuildArgs } from './release-cargo.mjs';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, join, resolve, relative, parse } from 'node:path';
import { sha256File } from './verify-sidecar.mjs';

export function createReleaseBuildPlan(argv) {
  const values = new Map();
  for (const argument of argv) {
    const match = /^(--interface|--reuse-sidecar-sha256|--reuse-app-sha256)=(.+)$/.exec(argument);
    const key = match?.[1] ?? argument;
    if (!match && !['--print-plan', '--skip-pwa-build'].includes(argument)) throw new Error('release_arguments_invalid');
    if (values.has(key)) throw new Error('release_argument_duplicate');
    values.set(key, match ? match[2] : true);
  }
  const interfaceMode = values.get('--interface') ?? 'harness';
  if (!['harness', 'shell'].includes(interfaceMode)) throw new Error('release_interface_invalid');
  const skipPwaBuild = values.has('--skip-pwa-build');
  if (interfaceMode === 'harness' && skipPwaBuild) throw new Error('release_harness_pwa_flag_forbidden');
  const reuseSidecarSha = values.get('--reuse-sidecar-sha256');
  const reuseAppSha = values.get('--reuse-app-sha256');
  if (Boolean(reuseSidecarSha) !== Boolean(reuseAppSha)
      || [reuseSidecarSha, reuseAppSha].some(value => value !== undefined && !/^[a-f0-9]{64}$/.test(value))) {
    throw new Error('reuse_artifact_hashes_invalid');
  }
  return {
    interfaceMode, printPlan: values.has('--print-plan'), skipPwaBuild,
    reuseSidecarSha, reuseAppSha, reusePreparedArtifacts: Boolean(reuseSidecarSha),
    command: 'cargo', args: releaseBuildArgs(interfaceMode),
    frontend: interfaceMode === 'harness' ? 'prepared-harness-assets' : skipPwaBuild ? 'existing-pwa' : 'build-pwa',
    sidecar: interfaceMode === 'harness' ? 'verify-prepared-harness' : reuseSidecarSha ? 'verify-pinned-existing' : 'prepare-sidecar',
    cargoBuild: reuseAppSha ? 'reused_explicit_sha256' : 'built',
    nativeIdentityRequired: interfaceMode === 'harness',
  };
}

export function releaseSourceCommit(plan, env) {
  if (plan.interfaceMode !== 'harness') return null;
  if (!/^[a-f0-9]{40}$/.test(env.UPTOKEY_RELEASE_SOURCE_COMMIT ?? '')) throw new Error('release_source_commit_required');
  return env.UPTOKEY_RELEASE_SOURCE_COMMIT;
}

export function releaseIdentityOptions({ plan, sourceCommit, artifactPath, outputPath, sha256, version, platform = process.platform, arch = process.arch }) {
  if (plan.interfaceMode !== 'harness' || !/^[a-f0-9]{40}$/.test(sourceCommit ?? '')) throw new Error('release_source_commit_required');
  const targetOs = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform];
  const targetArch = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!targetOs || !targetArch) throw new Error('release_target_unsupported');
  return { artifactPath, outputPath, expectedSubjectSha256: sha256, version, targetOs, targetArch, defaultInterface: 'Harness', sourceCommit };
}

/** Inventory the configured embedded frontend, not whichever old dist exists. */
export function releaseFrontendInputs(tauriDirectory, plan) {
  const configuration = plan.interfaceMode === 'harness' ? 'tauri.harness.conf.json' : 'tauri.conf.json';
  checkedReleaseInput(join(tauriDirectory, configuration));
  const config = JSON.parse(readFileSync(join(tauriDirectory, configuration), 'utf8'));
  const frontendDist = config.build?.frontendDist;
  if (typeof frontendDist !== 'string' || !frontendDist.startsWith('.') || frontendDist.includes('\0') || /[:]/.test(frontendDist)) throw new Error('release_frontend_path_invalid');
  const repoRoot = resolve(tauriDirectory, '../..');
  const expected = plan.interfaceMode === 'harness'
    ? resolve(repoRoot, 'experiments/deepseek-workbench/desktop/assets')
    : resolve(repoRoot, 'quimera/uptokey/uptokey-pwa/dist');
  const directory = resolve(tauriDirectory, frontendDist);
  // Only these two reviewed layouts are embedded by the native entry. Do not
  // let a relative config path turn a personal directory into release assets.
  if (directory !== expected) throw new Error('release_frontend_layout_invalid');
  return releaseFrontendFiles(directory, plan.interfaceMode === 'harness' ? 'harness-assets' : 'pwa');
}

function checkedReleaseAncestors(directory) {
  const root = parse(directory).root;
  for (let parent = directory; ;) {
    const metadataPath = parent === root && /^\\\\\?\\[A-Za-z]:\\$/.test(root) ? root.slice(4) : parent;
    const meta = lstatSync(metadataPath);
    if (!meta.isDirectory() || meta.isSymbolicLink()) throw new Error('release_assets_directory_invalid');
    if (parent === root) break;
    const next = dirname(parent); parent = next.length < root.length ? root : next;
  }
}

function checkedReleaseInput(path) {
  checkedReleaseAncestors(dirname(path));
  const meta = lstatSync(path);
  if (!meta.isFile() || meta.isSymbolicLink() || meta.size <= 0 || meta.size > 2 * 1024 * 1024) throw new Error('release_source_input_invalid');
}

const sensitiveAssetName = /^(?:\.env(?:\..*)?|\.npmrc|\.git|\.local|\.ssh|node_modules|output|profiles?|credentials?|secrets?)$/i;

export function releaseFrontendFiles(directory, prefix) {
  const files = {}, hashes = {};
  checkedReleaseAncestors(directory);
  const visit = current => {
    for (const entry of readdirSync(current, {withFileTypes: true})) {
      if (sensitiveAssetName.test(entry.name)) throw new Error('release_assets_sensitive_path_forbidden');
      const path = join(current, entry.name), meta = lstatSync(path);
      if (meta.isSymbolicLink()) throw new Error('release_assets_link_forbidden');
      if (meta.isDirectory()) visit(path);
      else if (meta.isFile()) {
        const name = relative(directory, path).split('\\').join('/');
        files[name] = path; hashes[name] = sha256File(path);
      } else throw new Error('release_assets_file_invalid');
    }
  };
  visit(directory);
  if (!Object.hasOwn(files, 'index.html')) throw new Error('release_frontend_index_missing');
  return { directory, prefix, files, hashes };
}

export function assertReleaseFrontendUnchanged(before, after) {
  const stable = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (before.directory !== after.directory || before.prefix !== after.prefix || stable(before.hashes) !== stable(after.hashes)) throw new Error('release_frontend_changed_during_build');
}

/** A bounded local input inventory; not authenticated full-source provenance. */
export function releaseCanonicalInputs(tauriDirectory, plan) {
  const names = ['Cargo.lock', 'Cargo.toml', 'tauri.conf.json', ...(plan.interfaceMode === 'harness'
    ? ['tauri.harness.conf.json', 'capabilities/harness-account.json', 'capabilities/harness-theme.json', 'capabilities/harness-public-api.json', 'capabilities/harness-notification.json', 'capabilities/harness-computer-focus.json']
    : ['capabilities/default.json'])];
  return Object.fromEntries(names.map(name => {
    const path = join(tauriDirectory, name); checkedReleaseInput(path);
    return [`quimera/tauri/${name}`, sha256File(path)];
  }));
}

export function assertReleaseCanonicalInputsUnchanged(before, after) {
  const stable = value => JSON.stringify(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)));
  if (stable(before) !== stable(after)) throw new Error('release_source_inputs_changed_during_build');
}
