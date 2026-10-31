// Compatibility entry for lab commands; the native host embeds this trusted launcher.
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { statePath } from './harness-paths.mjs';
import { runComputerResource } from '../../../quimera/tauri/computer-use/resource-launcher.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
await runComputerResource({ pointer: resolve(root, '.local/computer-resource-current.json'), stateRoot: statePath(root, '.local', 'computer-state'), args: process.argv.slice(2) });
