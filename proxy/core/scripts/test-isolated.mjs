// Each test file owns its profile. Never reuse a developer's daemon data.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(core, '../..');
const run = await mkdtemp(join(tmpdir(), 'uptokey-core-tests-'));
const output = join(root, 'output/proxy-programa', basename(run));
await mkdir(output, { recursive: true });
const requested = process.argv.slice(2);
const available = (await readdir(join(core, 'test'))).filter(f => /\.test\.(?:ts|mjs)$/.test(f)).sort();
const files = requested.length ? [...new Set(requested)] : available;
for (const f of files) if (basename(f) !== f || !available.includes(f)) throw Error('invalid_test_file');
// These multi-journey SQLite suites are measured separately. Running them beside
// other fsync-heavy suites caused deadline failures on the same Windows host.
// Suites that drive a real terminal (ConPTY) also run alone: closing a pseudo-console delivers Ctrl+C to the
// processes attached to the console of a concurrent suite, which then exit with STATUS_CONTROL_C_EXIT. Voice
// funding and terminal replay also have host deadlines tied to PTY/ConPTY scheduling, so sharing the two-worker
// pool can turn a valid bounded test into a false timeout under a full suite.
const exclusive = files.filter(f => ['workspace-gateway.test.ts','workspace-video-runtime.test.ts','tui-i18n-regression-check.test.ts','interactive-terminal.test.ts','voice-account-funding.test.ts',
  // These suites use Windows file replacement/temporary-directory cleanup
  // and a loopback Ollama server. Running them beside the broad pool makes
  // unrelated workers contend for the same filesystem primitives and causes
  // nondeterministic EPERM/ENOTEMPTY failures. Keep their assertions and
  // deadlines unchanged; only serialize the host-sensitive harness.
  'ephemeral-cache-authority.test.ts','model-install-ollama-http.test.ts'].includes(f));
const parallel = files.filter(f => !exclusive.includes(f));
const results = [];
let cursor = 0;
async function execute(file) {
  const profile = join(run, file);
  await mkdir(profile, { recursive: true });
  // Allowlist OS plumbing, never inherit provider tokens or product overrides.
  const osKeys = new Set(['systemroot','windir','path','pathext','temp','tmp','comspec','processor_architecture','number_of_processors','programfiles','programfiles(x86)','lang','lc_all']);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => osKeys.has(key.toLowerCase())));
  Object.assign(env, { UPTOKEY_QUIMERA_DATA_DIR: join(profile, 'data'), UPTOKEY_SETTINGS_DIR: join(profile, 'settings'), UPTOKEY_AUTOMATIONS_DIR: join(profile, 'automations'),
    // The host may run a local SearXNG on its default port; tests never see it (discard port, nothing listens).
    UPTOKEY_SEARXNG_URL: 'http://127.0.0.1:9' });
  const logPath = join(output, `${file}.log`);
  const log = createWriteStream(logPath);
  const start = Date.now();
  const child = spawn(process.execPath, ['--experimental-strip-types', '--test', '--test-reporter=tap', join(core, 'test', file)], { cwd: core, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
  let timeout = false;
  const deadline = setTimeout(() => {
    timeout = true;
    if (process.platform === 'win32') spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
  }, 120_000);
  const outcome = await new Promise(resolve => {
    child.once('error', error => resolve({ code: null, error: error.code }));
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  clearTimeout(deadline);
  await new Promise(resolve => log.end(resolve));
  const text = await readFile(logPath, 'utf8');
  const counts = Object.fromEntries(['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(k => [k, Number(text.match(new RegExp(`^# ${k} (\\d+)$`, 'm'))?.[1] ?? NaN)]));
  const result = { file, ...outcome, timeout, durationMs: Date.now() - start, complete: Number.isFinite(counts.tests), counts, log: logPath };
  results.push(result);
  await writeFile(join(output, 'results.json'), JSON.stringify({ node: process.version, output, results }, null, 2));
  console.log(`${result.code === 0 && result.complete && !timeout ? 'PASS' : 'FAIL'} ${file} (${counts.pass}/${counts.tests})${timeout ? ' TIMEOUT' : ''}`);
}
await Promise.all(Array.from({ length: 2 }, async () => { while (cursor < parallel.length) await execute(parallel[cursor++]); }));
for (const file of exclusive) await execute(file);
const failed = results.filter(r => r.code !== 0 || !r.complete || r.timeout);
console.log(JSON.stringify({ files: results.length, failed: failed.length, evidence: join(output, 'results.json') }));
process.exitCode = failed.length ? 1 : 0;
