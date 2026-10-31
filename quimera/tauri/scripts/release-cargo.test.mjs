import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { releaseBuildEnvironment, assertNoPersonalBuildPaths } from './release-cargo.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const plans = new Map();
test('release remaps source and dependency paths without losing encoded compiler flags', () => {
  const original = { PATH: 'system', CARGO_ENCODED_RUSTFLAGS: '-C\x1ftarget-cpu=x86-64' };
  const result = releaseBuildEnvironment(original, 'C:\\Users\\build account', 'D:\\private source');
  assert.deepEqual(result.CARGO_ENCODED_RUSTFLAGS.split('\x1f'), [
    '-C', 'target-cpu=x86-64', '--remap-path-prefix=C:\\Users\\build account=/uptokey-build',
    '--remap-path-prefix=D:\\private source=/uptokey-source',
  ]);
  assert.equal(result.PATH, 'system');
  assert.equal(original.CARGO_ENCODED_RUSTFLAGS, '-C\x1ftarget-cpu=x86-64');
  assert.throws(() => releaseBuildEnvironment({ RUSTFLAGS: '-C target-cpu=native' }), /encoded_rustflags/);
});
test('final binary gate rejects ASCII, slash-normalized and UTF16 private paths', () => {
  for (const value of ['C:\\Users\\user\\.cargo\\x.rs', 'C:/Users/user/project/file.rs', 'D:\\private source\\src\\x.rs']) {
    for (const encoding of ['utf8', 'utf16le']) {
      assert.throws(() => assertNoPersonalBuildPaths(Buffer.from(value, encoding), 'C:\\Users\\user', 'D:\\private source'), /personal_build_path/);
    }
  }
  assert.doesNotThrow(() => assertNoPersonalBuildPaths(Buffer.from('/uptokey-build/.cargo/x.rs /uptokey-source/src/x.rs'), 'C:\\Users\\user', 'D:\\private source'));
});
test('directory boundaries distinguish MCP roots names from actual Linux home/source paths', () => {
  for (const encoding of ['utf8', 'utf16le']) {
    for (const incidental of ['notifications/roots/list_changed', '/rooted/file', '/root-name/file', '/root2/file', '/root.git', '/rooté/file', '/out/sources/file']) {
      assert.doesNotThrow(() => assertNoPersonalBuildPaths(Buffer.from(incidental, encoding), '/root', '/out/source'));
    }
    for (const actual of ['/root/.cargo/x.rs', '\\root\\.cargo\\x.rs', '/out/source/src/main.rs', '/root', '"/root"', '/root\0suffix', '/root:73', 'notifications/roots/list_changed\0/root/private.rs']) {
      assert.throws(() => assertNoPersonalBuildPaths(Buffer.from(actual, encoding), '/root', '/out/source'), /personal_build_path/);
    }
    assert.throws(() => assertNoPersonalBuildPaths(Buffer.from('/root/file', encoding), '/root/', '/out/source'), /personal_build_path/);
  }
  assert.throws(() => assertNoPersonalBuildPaths(Buffer.from('anything'), '', '/out/source'), /prefix_empty/);
});
for (const script of ['build-release.mjs', 'sidecar-build.mjs']) {
  test(`${script}: exact production command includes locked dependencies and the embedded asset protocol`, () => {
    const result = spawnSync(process.execPath, [join(here, script), '--print-plan'], {encoding: 'utf8', windowsHide: true});
    assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
    const plan = JSON.parse(result.stdout); plans.set(script, plan);
    assert.equal(plan.command, 'cargo');
    assert.deepEqual(plan.args, script === 'build-release.mjs'
      ? ['build', '--release', '--locked', '--offline', '--bin', 'uptokey_tauri', '--features', 'harness-entry,tauri/custom-protocol', '-j', '1']
      : ['build', '--release', '--locked', '--features', 'tauri/custom-protocol']);
    assert.equal(plan.args.includes('--no-default-features'), false);
    if (plan.outputDirectory) {
      assert.match(plan.outputDirectory, /[\\/]native-release-[^\\/]+$/);
      assert.equal(existsSync(plan.outputDirectory), false, 'planning must not create or replace evidence');
    }
  });
}
test('release outputs are unique and cannot replace the historical B3 artifact directory', () => {
  const result = spawnSync(process.execPath, [join(here, 'build-release.mjs'), '--print-plan'], {encoding: 'utf8', windowsHide: true});
  assert.ifError(result.error); assert.equal(result.status, 0, result.stderr);
  const plan = JSON.parse(result.stdout), previous = plans.get('build-release.mjs');
  assert.notEqual(plan.outputDirectory, previous.outputDirectory);
  assert.equal(plan.outputDirectory.includes('b3-artifacts'), false);
});
