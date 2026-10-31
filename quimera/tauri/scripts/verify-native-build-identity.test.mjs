import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { nativeIdentityCheckOptions } from './verify-native-build-identity.mjs';

const commit = 'b'.repeat(40);
test('CI refuses absent or divergent commit pins before reading any native artifact', () => {
  for (const env of [{}, { GITHUB_SHA: commit }, { GITHUB_SHA: commit, UPTOKEY_RELEASE_SOURCE_COMMIT: 'a'.repeat(40) },
    { GITHUB_SHA: 'B'.repeat(40), UPTOKEY_RELEASE_SOURCE_COMMIT: 'B'.repeat(40) }]) {
    assert.throws(() => nativeIdentityCheckOptions({ env, root: '/nonexistent-no-read' }), /source_commit_not_pinned/);
  }
});

test('the CI consumer binds only the current target debug build, Harness and checked-in native version', () => {
  const root = mkdtempSync(join(realpathSync(tmpdir()), 'uptokey-native-ci-identity-'));
  try {
    mkdirSync(join(root, 'target/debug'), { recursive: true });
    writeFileSync(join(root, 'tauri.conf.json'), JSON.stringify({ version: '0.2.0' }));
    writeFileSync(join(root, 'target/debug/uptokey_tauri.exe'), 'synthetic-windows-not-executed');
    writeFileSync(join(root, 'target/debug/uptokey_tauri'), 'synthetic-unix-not-executed');
    const env = { GITHUB_SHA: commit, UPTOKEY_RELEASE_SOURCE_COMMIT: commit };
    for (const [platform, targetOs, arch, targetArch] of [
      ['win32', 'windows', 'x64', 'x86_64'], ['linux', 'linux', 'x64', 'x86_64'], ['darwin', 'macos', 'arm64', 'aarch64']]) {
      const options = nativeIdentityCheckOptions({ root, env, platform, arch });
      assert.equal(options.sourceCommit, commit);
      assert.equal(options.version, '0.2.0');
      assert.equal(options.defaultInterface, 'Harness');
      assert.equal(options.targetOs, targetOs);
      assert.equal(options.targetArch, targetArch);
      assert.equal(options.artifactPath, join(root, 'target/debug', platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri'));
      assert.match(options.expectedSubjectSha256, /^[a-f0-9]{64}$/);
    }
    assert.throws(() => nativeIdentityCheckOptions({ root, env, platform: 'freebsd', arch: 'x64' }), /target_unsupported/);
    writeFileSync(join(root, 'tauri.conf.json'), JSON.stringify({ version: '0.2.0 invalid' }));
    assert.throws(() => nativeIdentityCheckOptions({ root, env }), /version_invalid/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});
