import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { hostEnvironment } from '../computer-use/session/host-environment.mjs';
import { nativeSourceCheckPlan, runNativeSourceCheck } from './check-native-source.mjs';

const script = fileURLToPath(new URL('./check-native-source.mjs', import.meta.url));
const expectedArgs = ['check', '--locked', '--offline', '--bin', 'uptokey_tauri',
  '--features', 'harness-entry,tauri/custom-protocol', '-j', '1'];
const expectedComputerArgs = ['check', '--locked', '--offline', '--manifest-path', 'computer-use/Cargo.toml', '-j', '1'];

test('source checks run desktop then Computer Use with the resource overlay only on desktop', () => {
  const before = process.env.TAURI_CONFIG;
  let called = 0;
  const result = runNativeSourceCheck({ runner(command, args, options) {
    called++;
    assert.equal(command, 'cargo'); assert.deepEqual(args, called === 1 ? expectedArgs : expectedComputerArgs);
    assert.equal(args.some(arg => ['build', 'run', '--release'].includes(arg)), false);
    assert.match(options.cwd, /[\\/]quimera[\\/]tauri$/);
    assert.equal(options.shell, false); assert.equal(options.stdio, 'inherit');
    if (called === 1) {
      assert.deepEqual(JSON.parse(options.env.TAURI_CONFIG), { bundle: { resources: [] } });
      assert.equal(Object.hasOwn(JSON.parse(options.env.TAURI_CONFIG), 'build'), false);
      assert.equal(Object.hasOwn(JSON.parse(options.env.TAURI_CONFIG), 'app'), false);
    } else assert.equal(Object.hasOwn(options.env, 'TAURI_CONFIG'), false);
    return { status: 0 };
  } });
  assert.deepEqual(result, { status: 0 }); assert.equal(called, 2);
  assert.equal(process.env.TAURI_CONFIG, before, 'the overlay belongs only to the check child');
});

test('source check does not forward credentials, source stamps or inherited tool/config overrides', () => {
  const names = ['UPTOKEY_RELEASE_SOURCE_COMMIT', 'TAURI_CONFIG', 'CARGO_TARGET_DIR', 'CARGO_BUILD_TARGET',
    'CARGO_HOME', 'RUSTUP_HOME', 'RUSTFLAGS', 'CARGO_ENCODED_RUSTFLAGS', 'RUSTC_WRAPPER', 'RUSTC',
    'CARGO_REGISTRIES_CRATES_IO_TOKEN', 'AWS_SECRET_ACCESS_KEY', 'AZURE_CLIENT_SECRET',
    'GOOGLE_APPLICATION_CREDENTIALS', 'OPENAI_API_KEY', 'UPTOKEY_IPC_SECRET', 'NPM_TOKEN'];
  const before = new Map(names.map(name => [name, process.env[name]]));
  try {
    for (const name of names) process.env[name] = 'synthetic-inherited-value';
    const allowed = hostEnvironment();
    let called = 0;
    runNativeSourceCheck({ runner(_command, _args, { env }) {
      called++;
      assert.deepEqual(env, called === 1 ? { ...allowed, TAURI_CONFIG: '{"bundle":{"resources":[]}}' } : allowed);
      for (const name of names.filter(name => name !== 'TAURI_CONFIG')) assert.equal(Object.hasOwn(env, name), false, name);
      return { status: 0 };
    } });
    assert.equal(called, 2);
    assert.equal(process.env.TAURI_CONFIG, 'synthetic-inherited-value');
  } finally {
    for (const [name, value] of before) if (value === undefined) delete process.env[name]; else process.env[name] = value;
  }
});

test('desktop failure, signal or spawn error stops before the Computer Use check', () => {
  for (const result of [{ status: 73 }, { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('synthetic-spawn-failure') }]) {
    let called = 0;
    assert.equal(runNativeSourceCheck({ runner: () => { called++; return result; } }), result);
    assert.equal(called, 1);
  }
});

test('Computer Use failure, signal or spawn error is preserved after desktop success', () => {
  for (const result of [{ status: 74 }, { status: null, signal: 'SIGTERM' },
    { status: null, error: new Error('synthetic-computer-spawn-failure') }]) {
    let called = 0;
    assert.equal(runNativeSourceCheck({ runner: () => ++called === 1 ? { status: 0 } : result }), result);
    assert.equal(called, 2);
  }
});

test('print-plan is pure with no Cargo available and all other or duplicate arguments fail', () => {
  const env = { ...hostEnvironment(), PATH: '', TAURI_CONFIG: 'synthetic-invalid-config',
    UPTOKEY_RELEASE_SOURCE_COMMIT: 'not-a-commit' };
  const printed = spawnSync(process.execPath, [script, '--print-plan'], { env, encoding: 'utf8', windowsHide: true });
  assert.ifError(printed.error); assert.equal(printed.status, 0, printed.stderr);
  const plan = JSON.parse(printed.stdout);
  assert.equal(plan.purpose, 'source-check-only');
  assert.deepEqual(plan.steps.map(step => step.id), ['desktop', 'computer-use']);
  assert.deepEqual(plan.steps.map(step => step.args), [expectedArgs, expectedComputerArgs]);
  assert.deepEqual(plan.steps[0].configurationOverlay, { bundle: { resources: [] } });
  assert.equal(Object.hasOwn(plan.steps[1], 'configurationOverlay'), false);
  assert.deepEqual(nativeSourceCheckPlan(['--print-plan']), plan);
  for (const args of [['--help'], ['--build'], ['--print-plan', '--print-plan'], ['--print-plan=1'], ['--', '--print-plan']]) {
    assert.throws(() => nativeSourceCheckPlan(args), /arguments_invalid/);
    const rejected = spawnSync(process.execPath, [script, ...args], { env, encoding: 'utf8', windowsHide: true });
    assert.ifError(rejected.error); assert.equal(rejected.status, 1); assert.equal(rejected.stdout, '');
    assert.equal(rejected.stderr.trim(), 'native_source_check_failed');
  }
});
