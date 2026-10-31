import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, mkdirSync, writeFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join, relative, resolve, isAbsolute} from 'node:path';
import {terminalRuntimePackages} from './terminal-runtime-packages.mjs';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'uptokey-terminal-packaging-'));
  t.after(() => {
    const tail = relative(resolve(tmpdir()), resolve(directory));
    assert.ok(tail && !tail.startsWith('..') && !isAbsolute(tail));
    rmSync(directory, {recursive: true, force: true});
  });
  const write = (name, metadata) => {
    const folder = join(directory, ...name.split('/'));
    mkdirSync(folder, {recursive: true});
    writeFileSync(join(folder, 'package.json'), JSON.stringify({name, ...metadata}));
    return folder;
  };
  write('@lydell/node-pty', {version: '1.2.0-beta.15', optionalDependencies: {'@lydell/node-pty-win32-x64': '1.2.0-beta.15'}});
  return {directory, write};
}
test('a missing platform addon fails packaging despite the JS wrapper being present', t => {
  const f = fixture(t);
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'x64'), /ENOENT/);
});
test('a mismatched platform payload cannot be shipped with the wrapper', t => {
  const f = fixture(t);
  f.write('@lydell/node-pty-win32-x64', {version: '0.0.0'});
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'x64'), /terminal_addon_version_mismatch/);
});

test('missing or nonexact metadata cannot make an unversioned wrapper/addon pair appear compatible', t => {
  const f = fixture(t);
  f.write('@lydell/node-pty', {}); f.write('@lydell/node-pty-win32-x64', {});
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'x64'), /terminal_package_invalid/);
  f.write('@lydell/node-pty', {version: '1.2.0-beta.15'});
  f.write('@lydell/node-pty-win32-x64', {version: '1.2.0-beta.15'});
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'x64'), /terminal_addon_version_mismatch/);
  f.write('@lydell/node-pty', {version: '^1.2.0', optionalDependencies: {'@lydell/node-pty-win32-x64': '1.2.0-beta.15'}});
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'x64'), /terminal_package_invalid/);
});
test('only the matching platform closure is selected, and unsupported targets fail explicitly', t => {
  const f = fixture(t);
  const expected = f.write('@lydell/node-pty-win32-x64', {version: '1.2.0-beta.15'});
  f.write('@lydell/node-pty-darwin-arm64', {version: '1.2.0-beta.15'});
  const selected = terminalRuntimePackages(f.directory, 'win32', 'x64');
  assert.equal(selected.length, 2); assert.equal(selected[1], expected);
  assert.throws(() => terminalRuntimePackages(f.directory, 'win32', 'ia32'), /terminal_platform_unsupported/);
});
