import './isolated-gateway-profile.mjs';
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestCommand, passedVerificationDigest, successfulWrite } from '../src/tui/verification-evidence.ts';

const digest = 'a'.repeat(64);
const call = (argv: string[]) => ({ callId: 'fixture', name: 'execute_command', arguments: { argv, profile: 'node-app' } });
const result = (status = 'succeeded', check = 'pass', exitCode: number | null = 0) => ({ receiptId: 'actual-fixture-receipt', persistedOutput: { status }, output: JSON.stringify({ status, report: { manifestDigest: digest, checks: [{ status: check, exitCode }] } }) });

test('passing tests require a receipt, successful checks and their exact project snapshot', () => {
  assert.equal(passedVerificationDigest(call(['node', '--test']), result()), digest);
  for (const value of [result('failed', 'fail', 1), result('not_executed', 'blocked', null), result('not_completed'), { ...result(), receiptId: undefined }]) {
    assert.equal(passedVerificationDigest(call(['node', '--test']), value), null);
  }
  assert.equal(passedVerificationDigest(call(['node', '--version']), result()), null);
  assert.equal(successfulWrite(result('not_completed')), false, 'a failed write receipt is not an applied edit');
  assert.equal(successfulWrite(result()), true);
});

test('informational, collection-only and compound commands cannot be test evidence', () => {
  for (const argv of [['npm', 'test'], ['pnpm', 'run', 'test:unit'], ['bun', 'test'], ['node', '--test'], ['pytest'], ['python', '-m', 'unittest'], ['vitest', 'run']]) assert.equal(isTestCommand(call(argv)), true, JSON.stringify(argv));
  for (const argv of [['node', '--version'], ['npm', 'test', '--', '--help'], ['pytest', '--collect-only'], ['jest', '--listTests'], ['vitest', 'list'], ['echo', 'npm', 'test'], ['npm', 'run', 'contest']]) assert.equal(isTestCommand(call(argv)), false, JSON.stringify(argv));
  assert.equal(isTestCommand({ name: 'shadow_bash_run', arguments: { command: 'npm test || true' } }), false);
  assert.equal(isTestCommand({ name: 'shadow_bash_run', arguments: { command: 'npm test\necho pass' } }), false);
  const shadow = { callId: 'shell', name: 'shadow_bash_run', arguments: { command: 'npm test' } };
  const completed = { receiptId: 'actual-host-fixture-receipt', persistedOutput: {}, output: JSON.stringify({ status: 'completed', exitCode: 0 }) };
  assert.equal(passedVerificationDigest(shadow, completed), null, 'host tests need the pre-execution snapshot');
  assert.equal(passedVerificationDigest(shadow, completed, digest), digest);
  assert.equal(passedVerificationDigest(shadow, { ...completed, output: JSON.stringify({ status: 'failed', exitCode: 1 }) }, digest), null);
});
