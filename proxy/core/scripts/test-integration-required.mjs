import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync, existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const repo = resolve(core, '../..');
const mode = process.argv[2];
assert.ok(['artifact', 'renderer'].includes(mode), 'choose artifact or renderer');
const output = join(repo, 'output/integration-required', `${new Date().toISOString().replaceAll(':', '-')}-${randomUUID()}`);
mkdirSync(output, { recursive: true });
const safe = new Set(['systemroot', 'windir', 'path', 'pathext', 'temp', 'tmp', 'comspec', 'lang', 'lc_all', 'home', 'userprofile']);
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => safe.has(key.toLowerCase())));
const suites = mode === 'artifact' ? ['tui-v2-artifact.test.ts'] : ['uptokey/panels/account.test.tsx', 'uptokey/transcript-selection.native.test.ts', 'uptokey/backend/stability.test.ts', 'uptokey/model-cycling.test.tsx'];
const artifact = join(core, 'dist/cli.js');
if (mode === 'artifact') for (const name of ['cli.js', 'BUILD_INFO.json']) assert.ok(existsSync(join(core, 'dist', name)), `required built artifact missing: ${name}; build before this gate`);
const junit = join(output, 'renderer.xml');
const command = mode === 'artifact' ? process.execPath : process.env.BUN_BIN || (process.platform === 'win32' ? 'bun.exe' : 'bun');
const args = mode === 'artifact' ? ['scripts/test-isolated.mjs', ...suites] : ['test', '--reporter=junit', `--reporter-outfile=${junit}`, ...suites];
const cwd = mode === 'artifact' ? core : join(core, 'src/tui/frontend');
const result = spawnSync(command, args, { cwd, env, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 16 * 1024 * 1024 });
writeFileSync(join(output, 'stdout.log'), result.stdout ?? ''); writeFileSync(join(output, 'stderr.log'), result.stderr ?? '');
let counts;
try {
  assert.equal(result.error, undefined, 'required test process must start and complete');
  assert.equal(result.status, 0, 'required test process must succeed');
  if (mode === 'artifact') {
    const tail = result.stdout.trim().split(/\r?\n/).at(-1);
    const report = JSON.parse(readFileSync(JSON.parse(tail).evidence, 'utf8'));
    assert.equal(report.results.length, suites.length);
    for (const row of report.results) {
      assert.equal(row.code, 0); assert.equal(row.complete, true); assert.equal(row.timeout, false);
      assert.ok(row.counts.tests > 0); assert.equal(row.counts.fail, 0); assert.equal(row.counts.cancelled, 0); assert.equal(row.counts.skipped, 0, 'J15 must execute after build; skip is not acceptance');
    }
    counts = report.results.map(row => ({ suite: row.file, ...row.counts }));
  } else {
    const xml = readFileSync(junit, 'utf8');
    const summary = xml.match(/<testsuites\b([^>]*)>/)?.[1];
    assert.ok(summary, 'native renderer must emit a test result');
    const number = key => Number(summary.match(new RegExp(`\\b${key}="(\\d+)"`))?.[1]);
    counts = { tests: number('tests'), failures: number('failures'), skipped: number('skipped') };
    assert.ok(counts.tests >= suites.length); assert.equal(counts.failures, 0); assert.equal(counts.skipped, 0, 'native renderer tests are required');
    const normalized = xml.replaceAll('\\', '/');
    for (const suite of suites) assert.ok(normalized.includes(`file="${suite}"`), `required native suite missing from report: ${suite}`);
  }
  writeFileSync(join(output, 'RESULT.json'), JSON.stringify({ mode, command: [command, ...args], cwd, suites, exitCode: result.status, counts, artifact: mode === 'artifact' ? artifact : null, status: 'passed', output }, null, 2));
  console.log(JSON.stringify({ mode, status: 'passed', counts, output }));
} catch (error) {
  writeFileSync(join(output, 'RESULT.json'), JSON.stringify({ mode, command: [command, ...args], cwd, suites, exitCode: result.status, status: 'failed', reason: error.message, output }, null, 2));
  console.error(result.stderr ?? ''); console.error(error); process.exitCode = 1;
}
