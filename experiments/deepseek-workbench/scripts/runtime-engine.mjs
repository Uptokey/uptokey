import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {hostEnvironment} from './host-environment.mjs';

const execute = promisify(execFile);
const machine = 'uptokey-runner';
const connection = ['--connection', 'uptokey-runner-root'];
// Native canonicalization may leave a Win32 verbatim process cwd. Podman's Go
// configuration lookup cannot use that spelling. Resolve the same admitted
// resource directory from this module instead of inheriting the process cwd.
const commandDirectory = fileURLToPath(new URL('..',import.meta.url));

/** Explicit Start may boot the existing lab engine. Never create, reset or stop one. */
export async function ensureRuntimeEngine({platform=process.platform, available, inspect, start}={}) {
  const managedMachinePlatform=platform==='win32'||platform==='darwin';
  const run = (args, timeout) => execute('podman', args, {
    cwd: commandDirectory, env: hostEnvironment(), windowsHide: true, timeout, maxBuffer: 65536,
  });
  available ??= async () => {
    try {
      await run([...(platform==='win32'?connection:[]), 'info', '--format', '{{.Host.Arch}}'], 7000);
      return true;
    } catch { return false; }
  };
  inspect ??= async () => JSON.parse((await run(['machine','inspect',machine],10000)).stdout);
  start ??= async () => { await run(['machine','start',machine],60000); };
  if(await available()) return {engineStarted:false};
  // Podman Desktop uses a managed VM on both Windows and macOS. Linux uses
  // the native engine and must never trigger machine creation or guessing.
  if(!managedMachinePlatform) throw Error('runtime-engine-unavailable');
  let items;
  try { items = await inspect(); } catch { throw Error('runtime-engine-unavailable'); }
  if(!Array.isArray(items)||items.length!==1||items[0]?.Name!==machine||items[0]?.State!=='stopped') {
    throw Error('runtime-engine-not-startable');
  }
  try { await start(); } catch { throw Error('runtime-engine-start-failed'); }
  if(!await available()) throw Error('runtime-engine-not-ready');
  return {engineStarted:true};
}
