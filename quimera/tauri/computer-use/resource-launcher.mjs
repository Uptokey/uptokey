// This same source is embedded in the Rust host before any resource code executes.
import { readFileSync, lstatSync, realpathSync } from 'node:fs';
import { dirname, resolve, join, isAbsolute, relative, sep, toNamespacedPath } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const fixedModules = ['resource-launcher.mjs', 'session/computer-session.mjs', 'session/computer-transport.mjs', 'session/computer-session-lease.mjs', 'session/host-environment.mjs'];
function exactPath(path, file = false) {
  if (!isAbsolute(path) || resolve(path) !== path || toNamespacedPath(realpathSync.native(path)) !== toNamespacedPath(path)) throw Error('computer_resource_path_invalid');
  for (let at = realpathSync.native(path);; at = dirname(at)) {
    if (lstatSync(at).isSymbolicLink()) throw Error('computer_resource_path_invalid');
    if (dirname(at) === at) break;
  }
  if (file && !lstatSync(path).isFile()) throw Error('computer_resource_path_invalid');
}
export function verifyComputerResource(directory, expectedHash, platform = process.platform, arch = process.arch) {
  exactPath(directory);
  const path = join(directory, 'computer-resource.json'); exactPath(path, true);
  if (!/^[a-f0-9]{64}$/.test(expectedHash) || lstatSync(path).size > 65536) throw Error('computer_resource_manifest_invalid');
  const bytes = readFileSync(path);
  if (sha256(bytes) !== expectedHash) throw Error('computer_resource_manifest_changed');
  const manifest = JSON.parse(bytes), binary = platform === 'win32' ? 'uptokey-computer-mcp.exe' : 'uptokey-computer-mcp';
  // v1 stays readable to reuse the accepted native binary during preparation.
  // New sessions require v2; they cannot silently fall back to an old owner
  // which lacks the correlated native focus handshake.
  const names = [binary, ...fixedModules, ...(manifest.schema==='uptokey.computer.resource.v2'?['session/computer-focus-tickets.mjs']:[])].sort();
  if (!['uptokey.computer.resource.v1','uptokey.computer.resource.v2'].includes(manifest.schema) || manifest.platform !== platform || manifest.arch !== arch || manifest.binary !== binary
    || JSON.stringify(Object.keys(manifest.files ?? {}).sort()) !== JSON.stringify(names)) throw Error('computer_resource_manifest_invalid');
  for (const name of names) {
    const file = join(directory, name), record = manifest.files[name]; exactPath(file, true);
    if (!record || !Number.isSafeInteger(record.size) || record.size <= 0 || !/^[a-f0-9]{64}$/.test(record.sha256)
      || lstatSync(file).size !== record.size || sha256(readFileSync(file)) !== record.sha256) throw Error('computer_resource_file_changed');
  }
  return { directory, executable: join(directory, binary), manifest, manifestSha256: expectedHash };
}
export function currentComputerResource(pointer) {
  exactPath(pointer, true);
  if (lstatSync(pointer).size > 4096) throw Error('computer_resource_pointer_invalid');
  const record = JSON.parse(readFileSync(pointer, 'utf8'));
  if (record.schema !== 'uptokey.computer.resource.pointer.v1' || !/^[a-f0-9]{64}$/.test(record.manifestSha256)
    || record.directory !== `computer-resource-${record.manifestSha256}`) throw Error('computer_resource_pointer_invalid');
  return verifyComputerResource(join(dirname(pointer), 'computer-resources', record.directory), record.manifestSha256);
}
export function validateComputerState(pointer, stateRoot, environment = process.env) {
  const installedState = environment.UPTOKEY_HARNESS_STATE_ROOT;
  let parent = dirname(pointer);
  if (installedState !== undefined) {
    exactPath(installedState);
    if (!lstatSync(installedState).isDirectory()) throw Error('computer_resource_state_invalid');
    const resources = dirname(dirname(pointer)); exactPath(resources);
    const contains = (base, candidate) => {
      const rel = relative(toNamespacedPath(base), toNamespacedPath(candidate));
      return rel === '' || (!isAbsolute(rel) && rel !== '..' && !rel.startsWith(`..${sep}`));
    };
    if (contains(resources, installedState) || contains(installedState, resources)) throw Error('computer_resource_state_invalid');
    parent = join(installedState, '.local');
  }
  if (toNamespacedPath(stateRoot) !== toNamespacedPath(join(parent, 'computer-state'))) throw Error('computer_resource_state_invalid');
  exactPath(parent);
  try { exactPath(stateRoot); } catch (error) { if (error.code !== 'ENOENT') throw error; }
  return stateRoot;
}
export async function runComputerResource({ pointer, stateRoot, args }) {
  // The desktop's existing Node runtime is retained; no additional Node or core is started.
  if (process.versions.modules !== '137') throw Error('computer_resource_node_abi_invalid');
  const resource = currentComputerResource(pointer);
  validateComputerState(pointer, stateRoot);
  if (args.length === 1 && ['--list-windows', '--tools-json'].includes(args[0])) {
    const output = execFileSync(resource.executable, args, { env: process.env, windowsHide: true, timeout: 10000, maxBuffer: 256 * 1024, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    process.stdout.write(output); return;
  }
  if (args.length !== 4 || args[0] !== '--window-id' || args[2] !== '--pid'
    || !args[1] || !args[3] || !/^\d{1,10}$/.test(args[1]) || !/^\d{1,10}$/.test(args[3])) throw Error('computer_resource_arguments_invalid');
  if(resource.manifest.schema!=='uptokey.computer.resource.v2')throw Error('computer_resource_owner_upgrade_required');
  const { runComputerSession } = await import(pathToFileURL(join(resource.directory, 'session/computer-session.mjs')));
  await runComputerSession({ executable: resource.executable, stateRoot, args });
}
if (process.argv[1] === '--computer-resource') {
  try { await runComputerResource({ pointer: process.argv[2], stateRoot: process.argv[3], args: process.argv.slice(4) }); }
  catch (error) { process.stderr.write(/^(computer_resource_[a-z_]+)$/.test(error?.message) ? `${error.message}\n` : 'computer_resource_unavailable\n'); process.exitCode = 1; }
}
