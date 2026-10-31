import { fileURLToPath } from 'node:url';
import { hostEnvironment as cleanHostEnvironment } from '../../../quimera/tauri/computer-use/session/host-environment.mjs';
import { HARNESS_STATE_ENV, harnessStateRoot } from './harness-paths.mjs';

const resources = fileURLToPath(new URL('..', import.meta.url));
export function hostEnvironment() {
  const environment = cleanHostEnvironment();
  // Nested host helpers retain only this validated Harness state location.
  // Core profile overrides and provider credentials are never propagated.
  if (process.env[HARNESS_STATE_ENV] !== undefined) environment[HARNESS_STATE_ENV] = harnessStateRoot(resources);
  return environment;
}
