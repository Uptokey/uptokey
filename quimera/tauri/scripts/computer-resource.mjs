import { copyFileSync, mkdirSync, lstatSync, readFileSync, writeFileSync, renameSync, rmSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash, randomBytes } from 'node:crypto';
import { computerBinaryName } from './computer-runtime-contract.mjs';
import { verifyComputerResource } from '../computer-use/resource-launcher.mjs';

const source = resolve(dirname(fileURLToPath(import.meta.url)), '../computer-use');
const modules = ['resource-launcher.mjs', 'session/computer-session.mjs', 'session/computer-transport.mjs', 'session/computer-session-lease.mjs', 'session/computer-focus-tickets.mjs', 'session/host-environment.mjs'];
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
export function stageComputerResource(directory, executable, { platform = process.platform, arch = process.arch } = {}) {
  const binary = computerBinaryName(platform);
  const input = lstatSync(executable);
  if (!input.isFile() || input.isSymbolicLink() || input.size <= 0) throw Error('computer_resource_file_invalid');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const destination = join(directory, binary);
  if (resolve(executable) !== resolve(destination)) copyFileSync(executable, destination);
  if (platform !== 'win32') chmodSync(destination, 0o755);
  for (const name of modules) { mkdirSync(dirname(join(directory, name)), { recursive: true, mode: 0o700 }); copyFileSync(join(source, name), join(directory, name)); }
  const files = Object.fromEntries([binary, ...modules].sort().map(name => {
    const path = join(directory, name), stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) throw Error('computer_resource_file_invalid');
    const bytes = readFileSync(path); return [name, { size: bytes.length, sha256: sha256(bytes) }];
  }));
  const manifest = { schema: 'uptokey.computer.resource.v2', platform, arch, binary, files };
  const bytes = Buffer.from(JSON.stringify(manifest, null, 2) + '\n'), manifestSha256 = sha256(bytes);
  writeFileSync(join(directory, 'computer-resource.json'), bytes, { mode: 0o600 });
  verifyComputerResource(resolve(directory), manifestSha256, platform, arch);
  return { manifest, manifestSha256 };
}
export function publishComputerResource(stateParent, executable) {
  const parent = join(resolve(stateParent), 'computer-resources'); mkdirSync(parent, { recursive: true, mode: 0o700 });
  const stage = join(parent, `.stage-${randomBytes(12).toString('hex')}`); mkdirSync(stage, { mode: 0o700 });
  try {
    const result = stageComputerResource(stage, executable), name = `computer-resource-${result.manifestSha256}`, directory = join(parent, name);
    if (existsSync(directory)) { verifyComputerResource(directory, result.manifestSha256); rmSync(stage, { recursive: true }); }
    else renameSync(stage, directory);
    const pointer = join(resolve(stateParent), 'computer-resource-current.json'), pending = `${pointer}.${randomBytes(8).toString('hex')}.tmp`;
    writeFileSync(pending, JSON.stringify({ schema: 'uptokey.computer.resource.pointer.v1', directory: name, manifestSha256: result.manifestSha256 }) + '\n', { mode: 0o600 });
    renameSync(pending, pointer);
    return { directory, pointer, ...result };
  } catch (error) {
    if (dirname(stage) === parent && existsSync(stage)) rmSync(stage, { recursive: true });
    throw error;
  }
}
