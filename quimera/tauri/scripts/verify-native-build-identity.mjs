// CI checks only its freshly built native application. This is not the core
// updater's build-identity command and never probes an installed application.
import { createHash } from 'node:crypto';
import { lstatSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validReleaseVersion } from '../../../proxy/core/scripts/artifact-version-evidence.mjs';
import { createNativeArtifactVersionEvidence } from '../../../proxy/core/scripts/native-artifact-version-evidence.mjs';

const nativeRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export function nativeIdentityCheckOptions({ root = nativeRoot, env = process.env, platform = process.platform, arch = process.arch } = {}) {
  const sourceCommit = env.GITHUB_SHA;
  if (!/^[a-f0-9]{40}$/.test(sourceCommit ?? '') || env.UPTOKEY_RELEASE_SOURCE_COMMIT !== sourceCommit) {
    throw new Error('native_ci_source_commit_not_pinned');
  }
  const targetOs = { win32: 'windows', darwin: 'macos', linux: 'linux' }[platform];
  const targetArch = { x64: 'x86_64', arm64: 'aarch64' }[arch];
  if (!targetOs || !targetArch) throw new Error('native_ci_target_unsupported');
  const { version } = JSON.parse(readFileSync(resolve(root, 'tauri.conf.json'), 'utf8'));
  if (typeof version !== 'string' || !validReleaseVersion(`v${version}`)) throw new Error('native_ci_version_invalid');
  const artifactPath = resolve(root, 'target/debug', platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri');
  const stat = lstatSync(artifactPath);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > 256 * 1024 * 1024) {
    throw new Error('native_ci_artifact_invalid');
  }
  return {
    artifactPath, outputPath: resolve(root, 'target/debug/native-build-identity.json'),
    expectedSubjectSha256: createHash('sha256').update(readFileSync(artifactPath)).digest('hex'),
    version, targetOs, targetArch, defaultInterface: 'Harness', sourceCommit,
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length !== 2) throw new Error('native_ci_arguments_invalid');
    const { receipt } = createNativeArtifactVersionEvidence(nativeIdentityCheckOptions());
    console.log(JSON.stringify({ nativeIdentityVerified: true, sourceCommit: receipt.identity.sourceCommit,
      target: receipt.identity.target, defaultInterface: receipt.identity.defaultInterface,
      signedReleaseAccepted: false, bootstrapAccepted: false }));
  } catch {
    console.error('native_ci_identity_invalid');
    process.exitCode = 1;
  }
}
