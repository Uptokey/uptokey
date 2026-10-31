// Smoke only the native help path. Invalid operational-profile values ensure
// that moving profile/core initialization before help fails this gate.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function verifyHarnessEntry(binary, { run = spawnSync, env = process.env } = {}) {
  const result = run(binary, ['--help'], {
    env: { ...env, UPTOKEY_QUIMERA_DATA_DIR: 'relative-intentionally-invalid', UPTOKEY_SECRET_SERVICE: 'invalid-intentionally' },
    encoding: 'utf8', windowsHide: true, timeout: 15000, maxBuffer: 16384,
  });
  if (result.error || result.signal || result.status !== 0 || result.stderr?.trim()) {
    throw new Error('harness_entry_help_failed');
  }
  const lines = String(result.stdout).replaceAll('\r\n', '\n').trim().split('\n');
  if (!/^Uptokey \d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(lines[0])
      || lines[1] !== 'Default interface: Harness'
      || !lines.includes('--harness-recovery  Open recovery without starting core')) {
    throw new Error('harness_default_entry_missing');
  }
  return { defaultInterface: 'Harness', helpExitedBeforeProfile: true, bootstrapAccepted: false };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const binary = resolve(dirname(fileURLToPath(import.meta.url)), '../target/debug', process.platform === 'win32' ? 'uptokey_tauri.exe' : 'uptokey_tauri');
  try { console.log(JSON.stringify(verifyHarnessEntry(binary))); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
