import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { validateNativeContractsWorkflow, NATIVE_CONTRACT_TEST_COMMAND } from './native-contracts-policy.mjs';
const workflow = readFileSync(fileURLToPath(new URL('../ci/native-contracts.yml', import.meta.url)), 'utf8');

test('reviewed three-OS source workflow is admitted without build or signing authority', () => {
  assert.deepEqual(validateNativeContractsWorkflow(workflow), []);
  assert.deepEqual(validateNativeContractsWorkflow(workflow.replaceAll('\n', '\r\n')), []);
});
test('removing a platform or bypassing the required policy job fails', () => {
  for (const text of [workflow.replace(', macos-15', ''), workflow.replace('windows-2025', 'windows-latest'),
    workflow.replace('    needs: policy\n', ''), workflow.replace('    needs: policy', '    needs: unrelated'),
    workflow.replace('    steps:', '    if: always()\n    steps:'), workflow.replace('    steps:', '    continue-on-error: true\n    steps:')]) {
    assert.notDeepEqual(validateNativeContractsWorkflow(text), []);
  }
});
test('unreviewed actions, floating tools and persisted credentials fail', () => {
  for (const text of [workflow.replace(/actions\/checkout@[a-f0-9]{40}/, 'actions/checkout@v4'),
    workflow.replace('24.21.0', '24'), workflow.replace('persist-credentials: false', 'persist-credentials: true'),
    workflow.replace('  contents: read', '  contents: write'), workflow.replace('    steps:', '    env:\n      TOKEN: value\n    steps:')]) {
    assert.notDeepEqual(validateNativeContractsWorkflow(text), []);
  }
});
test('an added publish, build, command suffix or privileged trigger fails', () => {
  for (const text of [workflow.replace(NATIVE_CONTRACT_TEST_COMMAND, 'npm publish'),
    workflow.replace(NATIVE_CONTRACT_TEST_COMMAND, NATIVE_CONTRACT_TEST_COMMAND + '; npm publish'),
    workflow + '\n      - run: cargo build --release\n', workflow.replace('  pull_request:', '  pull_request_target:'),
    workflow.replace('    steps:', '    environment: release-publication\n    steps:'),
    workflow.replace('jobs:', 'jobs:\n  unexpected:\n    runs-on: ubuntu-24.04')]) {
    assert.notDeepEqual(validateNativeContractsWorkflow(text), []);
  }
});
test('job-local permissions, YAML continuations and quoted jobs cannot evade the bounded grammar', () => {
  for (const text of [
    workflow.replace('    runs-on: ubuntu-24.04', '    permissions:\n      contents: write\n    runs-on: ubuntu-24.04'),
    workflow.replace(`        run: ${NATIVE_CONTRACT_TEST_COMMAND}`, `        run: ${NATIVE_CONTRACT_TEST_COMMAND}\n          ; echo UNREVIEWED_COMMAND`),
    workflow + '\n  "publish":\n    "runs-on": ubuntu-24.04\n    "permissions":\n      "contents": write\n    "steps":\n      - "run": npm publish\n',
    workflow.replace(`        run: ${NATIVE_CONTRACT_TEST_COMMAND}\n`, '').replace('  contracts:', `      - name: Verify native source contracts without starting the application\n        run: ${NATIVE_CONTRACT_TEST_COMMAND}\n  contracts:`),
  ]) assert.notDeepEqual(validateNativeContractsWorkflow(text), []);
});
test('checkout credential policy and Node version remain bound to their own action', () => {
  const swapped = workflow.replace(/persist-credentials: false|node-version: 24\.21\.0/g,
    value => value.startsWith('persist-credentials') ? 'node-version: 24.21.0' : 'persist-credentials: false');
  assert.ok(validateNativeContractsWorkflow(swapped).includes('native_contract_action_input_unbound'));
});
