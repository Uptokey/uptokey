import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, resolve, join, toNamespacedPath, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { publishComputerResource } from './computer-resource.mjs';
import { currentComputerResource, validateComputerState } from '../computer-use/resource-launcher.mjs';
import {computerSessionHostPath} from '../computer-use/session/computer-session.mjs';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'uptokey-computer-resource-'));
  t.after(() => { assert.equal(dirname(resolve(root)), resolve(tmpdir())); rmSync(root, { recursive: true }); });
  const executable = join(root, 'build-output'); writeFileSync(executable, 'synthetic native binary, never executed');
  const published = publishComputerResource(root, executable);
  return { root, executable, ...published };
}
test('publishes one immutable closure, reuses it unchanged, and resolves only its attested native binary', t => {
  const f = fixture(t), current = currentComputerResource(f.pointer);
  assert.equal(current.directory, f.directory);
  assert.equal(current.manifestSha256, f.manifestSha256);
  assert.equal(current.manifest.schema,'uptokey.computer.resource.v2');
  assert.ok(current.manifest.files['session/computer-focus-tickets.mjs']);
  assert.equal(currentComputerResource(toNamespacedPath(f.pointer)).manifestSha256, f.manifestSha256);
  assert.deepEqual(readFileSync(current.executable), readFileSync(f.executable));
  assert.equal(publishComputerResource(f.root, f.executable).directory, f.directory);
  assert.equal(existsSync(join(f.root, 'computer-state')), false);
});

test('focus handshake implementation is attested before owner code can load it',t=>{
  const f=fixture(t);
  writeFileSync(join(f.directory,'session/computer-focus-tickets.mjs'),'throw Error("must never load");');
  assert.throws(()=>currentComputerResource(f.pointer),/computer_resource_file_changed/);
});
test('a resource change is refused before helper import or any native action', t => {
  const f = fixture(t);
  writeFileSync(join(f.directory, 'session/computer-session.mjs'), 'throw Error("must not execute");');
  assert.throws(() => currentComputerResource(f.pointer), /computer_resource_file_changed/);
  const launcher = readFileSync(fileURLToPath(new URL('../computer-use/resource-launcher.mjs', import.meta.url)), 'utf8');
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', launcher, '--', '--computer-resource', f.pointer, join(f.root, 'computer-state'), '--window-id', '1', '--pid', '2'], { encoding: 'utf8', windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /computer_resource_file_changed/);
  assert.doesNotMatch(result.stderr, /must not execute/);
  assert.equal(existsSync(join(f.root, 'computer-state')), false);
});
test('pointer traversal and a modified manifest cannot redirect execution', t => {
  const f = fixture(t), original = readFileSync(f.pointer);
  writeFileSync(f.pointer, JSON.stringify({ schema: 'uptokey.computer.resource.pointer.v1', directory: '../escape', manifestSha256: f.manifestSha256 }));
  assert.throws(() => currentComputerResource(f.pointer), /computer_resource_pointer_invalid/);
  writeFileSync(f.pointer, original);
  writeFileSync(join(f.directory, 'computer-resource.json'), '{}');
  assert.throws(() => currentComputerResource(f.pointer), /computer_resource_manifest_changed/);
});

test('installed computer grants use only separate validated state and retain immutable resource pointers', t => {
  const f = fixture(t);
  const application = join(f.root, 'application'), local = join(application, '.local');
  const state = join(f.root, 'state'), stateLocal = join(state, '.local');
  mkdirSync(local, { recursive: true }); mkdirSync(stateLocal, { recursive: true });
  const pointer = join(local, 'computer-resource-current.json'), target = join(stateLocal, 'computer-state');
  writeFileSync(pointer, 'synthetic pointer not opened by state validation');
  assert.equal(validateComputerState(pointer, join(local, 'computer-state'), {}), join(local, 'computer-state'));
  const environment = { UPTOKEY_HARNESS_STATE_ROOT: toNamespacedPath(state) };
  assert.equal(validateComputerState(pointer, target, environment), target);
  assert.equal(validateComputerState(toNamespacedPath(pointer), toNamespacedPath(target), environment), toNamespacedPath(target));
  assert.throws(() => validateComputerState(pointer, join(local, 'computer-state'), environment), /state_invalid/);
  assert.throws(() => validateComputerState(pointer, target, {}), /state_invalid/);
  for (const overlap of [application, toNamespacedPath(application), f.root, local]) {
    assert.throws(() => validateComputerState(pointer, target, { UPTOKEY_HARNESS_STATE_ROOT: overlap }), /state_invalid/);
  }
  assert.equal(existsSync(target), false);
  assert.equal(existsSync(join(local, 'computer-state')), false);
});

test('session keeps ordinary paths and URL-significant characters intact',()=>{
  const ordinary=process.platform==='win32'?'C:\\Uptokey space\\#data%20\\computer-state':'/tmp/Uptokey space/#data%20/computer-state';
  assert.equal(computerSessionHostPath(ordinary),ordinary);
});

test('Win32 extended disk paths become the same ordinary path for host tools',{skip:process.platform!=='win32'},()=>{
  for(const ordinary of ['C:\\Uptokey space\\computer-state','C:\\Uptokey\\#data%20\\mcp.exe']){
    assert.equal(computerSessionHostPath(win32.toNamespacedPath(ordinary)),ordinary);
  }
});

test('Win32 extended UNC paths preserve their original server and share',{skip:process.platform!=='win32'},()=>{
  const ordinary='\\\\server\\share\\Uptokey space\\computer-state';
  assert.equal(computerSessionHostPath(win32.toNamespacedPath(ordinary)),ordinary);
});
