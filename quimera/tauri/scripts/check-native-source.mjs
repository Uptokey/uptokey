// Source checking only: this deliberately does not attest a desktop release.
import { spawnSync } from 'node:child_process';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { hostEnvironment } from '../computer-use/session/host-environment.mjs';
import { releaseBuildArgs } from './release-cargo.mjs';

const tauriDirectory = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const overlay = JSON.stringify({ bundle: { resources: [] } });

export function nativeSourceCheckPlan(args = []) {
  if (!Array.isArray(args) || (args.length !== 0 && (args.length !== 1 || args[0] !== '--print-plan'))) {
    throw new Error('native_source_check_arguments_invalid');
  }
  const [, ...buildArgs] = releaseBuildArgs('harness');
  return {
    purpose: 'source-check-only',
    interfaceMode: 'harness',
    steps: [
      { id: 'desktop', command: 'cargo', args: ['check', ...buildArgs.filter(value => value !== '--release')],
        cwd: tauriDirectory, configurationOverlay: { bundle: { resources: [] } } },
      { id: 'computer-use', command: 'cargo',
        args: ['check', '--locked', '--offline', '--manifest-path', 'computer-use/Cargo.toml', '-j', '1'],
        cwd: tauriDirectory },
    ],
    limits: ['Writes compiler cache and generated schemas in the check workspace',
      'No sidecar verification', 'No linking or executable artifact', 'No tools or input exercised',
      'No installation or release acceptance'],
  };
}

export function runNativeSourceCheck({ runner = spawnSync } = {}) {
  const plan = nativeSourceCheckPlan();
  // Reuse the host tool allowlist. No Cargo/Rust overrides, source commit stamp,
  // provider credentials, signing credentials or inherited Tauri config survive.
  const host = hostEnvironment();
  let result;
  for (const step of plan.steps) {
    const env = { ...host };
    if (step.configurationOverlay) env.TAURI_CONFIG = overlay;
    result = runner(step.command, step.args, {
      cwd: step.cwd, env, shell: false, windowsHide: true, stdio: 'inherit',
    });
    if (result?.error || result?.signal || result?.status !== 0) return result;
  }
  return result;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), plan = nativeSourceCheckPlan(args);
    if (args.length) console.log(JSON.stringify(plan, null, 2));
    else {
      const result = runNativeSourceCheck();
      if (result.error || result.signal || !Number.isInteger(result.status)) {
        console.error('native_source_check_failed');
        process.exitCode = 1;
      } else process.exitCode = result.status;
    }
  } catch {
    console.error('native_source_check_failed');
    process.exitCode = 1;
  }
}
