// Hook paths belong to this module, independent of the caller's working directory.
import { spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { sha256File, verifySidecar } from './verify-sidecar.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const tauriDir = resolve(here, '..');
const pwaDir = resolve(tauriDir, '../uptokey/uptokey-pwa');

// The Harness already has an attested payload. Never invoke the PWA hook or
// prepare a different core while bundling it. Fail before hashing a legacy or
// stale payload; the canonical verifier remains the sole byte verifier.
export function verifyHarnessPayload(directory) {
  const manifest = JSON.parse(readFileSync(join(directory, 'manifest.json'), 'utf8'));
  if (manifest.schema_version !== 2 || manifest.runtime !== 'node'
      || manifest.harness?.schema_version !== 1
      || manifest.harness?.lab !== 'harness/experiments/deepseek-workbench'
      || manifest.harness?.scope?.personalStateIncluded !== false) {
    throw Error('harness_bundle_payload_required');
  }
  for (const name of ['Cargo.toml', 'tauri.harness.conf.json']) {
    const record = manifest.files?.[`harness/quimera/tauri/${name}`];
    if (!record || record.sha256 !== sha256File(join(tauriDir, name))) {
      throw Error('harness_bundle_source_changed');
    }
  }
  return verifySidecar(directory);
}

export function runFrontendHook(mode, { run = spawnSync, platform = process.platform, sidecarDirectory = join(tauriDir, 'resources/sidecar') } = {}) {
  if (mode === 'harness') {
    verifyHarnessPayload(sidecarDirectory);
    return 0;
  }
  if (mode !== 'dev' && mode !== 'build') throw new Error('frontend_hook_mode_invalid');
  const script = mode === 'dev' ? 'npm run dev -- --port 5273 --strictPort' : 'npm run build';
  const command = platform === 'win32' ? (process.env.ComSpec || 'cmd.exe') : 'npm';
  const args = platform === 'win32' ? ['/d', '/s', '/c', script]
    : ['run', mode, ...(mode === 'dev' ? ['--', '--port', '5273', '--strictPort'] : [])];
  const result = run(command, args, { cwd: pwaDir, stdio: 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (mode === 'dev') return 0;
  // A failed frontend must never package a stale interface or replace the sidecar.
  const sidecar = run(process.execPath, [join(here, 'prepare-sidecar.mjs')], {
    cwd: tauriDir, stdio: 'inherit', windowsHide: true,
  });
  if (sidecar.error) throw sidecar.error;
  return sidecar.status ?? 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { process.exitCode = runFrontendHook(process.argv[2]); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
