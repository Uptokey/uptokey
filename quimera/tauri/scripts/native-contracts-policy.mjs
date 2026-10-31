// A deliberately bounded, dependency-free gate for this source-only workflow.
// It does not validate product builds, signatures or platform acceptance.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const NATIVE_CONTRACT_POLICY_COMMAND = 'node quimera/tauri/scripts/native-contracts-policy.mjs .github/workflows/native-contracts.yml';
export const NATIVE_CONTRACT_TEST_COMMAND = 'node --test quimera/tauri/scripts/native-contracts-policy.test.mjs quimera/tauri/scripts/build-release.test.mjs quimera/tauri/scripts/release-cargo.test.mjs quimera/tauri/scripts/verify-native-build-identity.test.mjs proxy/core/scripts/native-artifact-version-evidence.test.mjs quimera/tauri/scripts/check-native-source.test.mjs quimera/tauri/scripts/fresh-node-runtime.test.mjs';
const checkout = 'actions/checkout@11d5960a326750d5838078e36cf38b85af677262';
const node = 'actions/setup-node@49933ea5288caeca8642d1e84afbd3f7d6820020';
const keys = new Set(['name', 'on', 'pull_request', 'push', 'branches', 'permissions', 'contents', 'jobs', 'policy', 'contracts',
  'runs-on', 'timeout-minutes', 'steps', 'uses', 'with', 'persist-credentials', 'node-version', 'run', 'needs', 'strategy', 'fail-fast', 'matrix', 'os']);
const physicalLines = new Set([
  'name: Native Harness source contracts', 'on:', '  pull_request:', '  push:', '    branches: [main]',
  'permissions:', '  contents: read', 'jobs:', '  policy:', '  contracts:', '    runs-on: ubuntu-24.04',
  '    timeout-minutes: 10', '    steps:', `      - uses: ${checkout}`, `      - uses: ${node}`,
  '        with:', '          persist-credentials: false', '          node-version: 24.22.1',
  '      - name: Verify source-only workflow policy', `        run: ${NATIVE_CONTRACT_POLICY_COMMAND}`,
  '    needs: policy', '    strategy:', '      fail-fast: false', '      matrix:',
  '        os: [ubuntu-24.04, windows-2025, macos-15]', '    runs-on: ${{ matrix.os }}',
  '      - name: Verify native source contracts without starting the application', `        run: ${NATIVE_CONTRACT_TEST_COMMAND}`,
]);

export function validateNativeContractsWorkflow(input) {
  if (typeof input !== 'string' || input.length > 16384) return ['native_contract_workflow_invalid'];
  const text = input.replaceAll('\r\n', '\n'); const errors = [];
  if (/\t|\$\{\{\s*(?:secrets\.|github\.token)|^\s*(?:if|continue-on-error|environment|env|container|services|workflow_run|pull_request_target)\s*:/m.test(text)
      || /^\s*(?:<<:|[\w-]+:\s*[&*])/m.test(text)) errors.push('native_contract_unexpected_execution_or_access');
  for (const line of text.split('\n')) {
    const physical = line.replace(/\s+#.*$/, '').trimEnd();
    if (physical.trim() && !physical.trimStart().startsWith('#') && !physicalLines.has(physical)) errors.push('native_contract_unreviewed_physical_line');
    const key = /^\s*(?:-\s+)?([\w-]+):/.exec(line)?.[1];
    if (key && !keys.has(key)) errors.push('native_contract_unknown_key');
  }
  if (!/^name: Native Harness source contracts$/m.test(text)
      || !/^permissions:\n  contents: read\n/m.test(text)
      || (text.match(/^permissions:/gm) ?? []).length !== 1
      || !/^on:\n  pull_request:\n  push:\n    branches: \[main\]\n/m.test(text)) errors.push('native_contract_trigger_or_permissions_changed');
  const jobs = text.slice(text.indexOf('\njobs:\n') + 1);
  const ids = [...jobs.matchAll(/^  ([\w-]+):$/gm)].map(match => match[1]);
  if (JSON.stringify(ids) !== JSON.stringify(['policy', 'contracts'])) errors.push('native_contract_jobs_changed');
  const split = jobs.indexOf('\n  contracts:\n');
  const policy = jobs.slice(0, split), contracts = jobs.slice(split);
  if (!/^    runs-on: ubuntu-24\.04$/m.test(policy)
      || !/^    needs: policy$/m.test(contracts)
      || !/^        os: \[ubuntu-24\.04, windows-2025, macos-15\]$/m.test(contracts)
      || !/^      fail-fast: false$/m.test(contracts)
      || !/^    runs-on: \$\{\{ matrix\.os \}\}$/m.test(contracts)) errors.push('native_contract_platform_or_gate_missing');
  for (const [job, command] of [[policy, NATIVE_CONTRACT_POLICY_COMMAND], [contracts, NATIVE_CONTRACT_TEST_COMMAND]]) {
    const boundJob = job.split('\n').map(line => line.replace(/\s+#.*$/, '').trimEnd())
      .filter(line => line.trim() && !line.trimStart().startsWith('#')).join('\n');
    for (const block of [`      - uses: ${checkout}\n        with:\n          persist-credentials: false`,
      `      - uses: ${node}\n        with:\n          node-version: 24.22.1`]) {
      if (boundJob.split(block).length !== 2) errors.push('native_contract_action_input_unbound');
    }
    const actions = [...job.matchAll(/^\s+(?:-\s+)?uses: ([^\s#]+)/gm)].map(match => match[1]);
    if (JSON.stringify(actions) !== JSON.stringify([checkout, node])
        || (job.match(/^          persist-credentials: false$/gm) ?? []).length !== 1
        || (job.match(/^          node-version: 24\.22\.1$/gm) ?? []).length !== 1
        || (job.match(/^    timeout-minutes: 10$/gm) ?? []).length !== 1
        || (job.match(/^    runs-on:/gm) ?? []).length !== 1) errors.push('native_contract_tools_or_runner_unpinned');
    const jobCommands = [...job.matchAll(/^\s+(?:-\s+)?run: (.+)$/gm)].map(match => match[1]);
    if (JSON.stringify(jobCommands) !== JSON.stringify([command])) errors.push('native_contract_job_command_changed');
  }
  const commands = [...text.matchAll(/^\s+(?:-\s+)?run: (.+)$/gm)].map(match => match[1]);
  if (JSON.stringify(commands) !== JSON.stringify([NATIVE_CONTRACT_POLICY_COMMAND, NATIVE_CONTRACT_TEST_COMMAND])) errors.push('native_contract_command_changed');
  return [...new Set(errors)];
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw Error();
    const errors = validateNativeContractsWorkflow(readFileSync(resolve(process.argv[2]), 'utf8'));
    if (errors.length) throw Error(errors.join(','));
    console.log('native_source_contract_workflow_valid_not_release_acceptance');
  } catch { console.error('native_source_contract_workflow_invalid'); process.exitCode = 1; }
}
