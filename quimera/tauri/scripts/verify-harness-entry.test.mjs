import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyHarnessEntry } from './verify-harness-entry.mjs';

const stdout = 'Uptokey 0.2.0\nDefault interface: Harness\n--harness-recovery  Open recovery without starting core\n';
const good = { status: 0, stdout, stderr: '' };

test('only help is invoked and an operational profile cannot be initialized', () => {
  const result = verifyHarnessEntry('/synthetic/native', { env: { PATH: 'fixture-path' }, run(binary, args, options) {
    assert.equal(binary, '/synthetic/native');
    assert.deepEqual(args, ['--help']);
    assert.equal(options.env.UPTOKEY_QUIMERA_DATA_DIR, 'relative-intentionally-invalid');
    assert.equal(options.env.UPTOKEY_SECRET_SERVICE, 'invalid-intentionally');
    assert.equal(options.timeout, 15000);
    assert.equal(options.maxBuffer, 16384);
    return good;
  } });
  assert.equal(result.bootstrapAccepted, false);
});

test('legacy shell and incidental Harness text do not pass the product entry gate', () => {
  for (const output of [stdout.replace('Default interface: Harness', 'Default interface: shell'), stdout.replace('Default interface: Harness', 'Harness'), stdout.replace('--harness-recovery', '--other')]) {
    assert.throws(() => verifyHarnessEntry('/synthetic/native', { run: () => ({ ...good, stdout: output }) }), /harness_default_entry_missing/);
  }
});

test('timeout, failed initialization and stderr cannot masquerade as successful help', () => {
  for (const failure of [{ status: 1 }, { signal: 'SIGTERM' }, { error: new Error('timeout') }, { stderr: 'profile initialization failed' }]) {
    assert.throws(() => verifyHarnessEntry('/synthetic/native', { run: () => ({ ...good, ...failure }) }), /harness_entry_help_failed/);
  }
});
