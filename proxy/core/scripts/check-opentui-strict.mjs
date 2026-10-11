import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const core = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const baseline = JSON.parse(readFileSync(new URL('./opentui-upstream-type-baseline.json', import.meta.url), 'utf8'));
const compiler = JSON.parse(readFileSync(resolve(core, 'node_modules/typescript/package.json'), 'utf8')).version;
if (compiler !== baseline.compiler) throw Error('opentui_compiler_changed: review the upstream baseline with the installed compiler');
const result = spawnSync(process.execPath, [resolve(core, 'node_modules/typescript/lib/tsc.js'), '--project', 'src/tui/frontend/tsconfig.json', '--strict', '--noImplicitAny', '--noUncheckedIndexedAccess', '--noEmit', '--pretty', 'false'], { cwd: core, encoding: 'utf8', windowsHide: true });
if (result.error || (result.status !== 0 && result.status !== 1 && result.status !== 2)) throw result.error ?? Error('opentui_compiler_failed');
const output = (result.stdout ?? '') + (result.stderr ?? '');
const unparsed = output.split(/\r?\n/).filter(line => /error TS\d+:/.test(line) && !/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/.test(line));
if (unparsed.length) throw Error('opentui_compiler_global_errors:' + unparsed.join('\n'));
const diagnostics = output.split(/\r?\n/).flatMap(line => {
  const match = line.match(/^(.*?)\(\d+,\d+\): error (TS\d+): (.*)$/);
  return match ? [{ path: match[1].replaceAll('\\', '/'), code: match[2], message: match[3] }] : [];
});
if (result.status !== 0 && diagnostics.length === 0) throw Error('opentui_compiler_output_unrecognized:' + output);
const seen = new Map();
const own = diagnostics.filter(item => !item.path.startsWith('src/tui/frontend/vendor/'));
for (const item of diagnostics.filter(item => item.path.startsWith('src/tui/frontend/vendor/'))) {
  const key = `${item.path}|${item.code}|${item.message}`;
  seen.set(key, (seen.get(key) ?? 0) + 1);
}
const allowed = new Map(baseline.diagnostics.map(item => [item.key, item.count]));
const increased = [...seen].filter(([key, count]) => count > (allowed.get(key) ?? 0));
if (own.length || increased.length) {
  console.error(JSON.stringify({ firstParty: own, upstreamGrowth: increased }, null, 2));
  process.exitCode = 1;
} else console.log(JSON.stringify({ firstPartyDiagnostics: 0, upstreamDiagnostics: diagnostics.length, reviewedUpstreamCeiling: baseline.total, compiler: baseline.compiler, status: 'passed_first_party_strict_upstream_ratchet' }));
