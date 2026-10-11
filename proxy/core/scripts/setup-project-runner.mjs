#!/usr/bin/env node
/** Prepare the existing OCI runner; never run generated project code on the host. */
import {spawn} from 'node:child_process';
import {mkdtemp, readFile, writeFile, mkdir} from 'node:fs/promises';
import {resolve, join} from 'node:path';
import {homedir} from 'node:os';
import {fileURLToPath, pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';

const core = fileURLToPath(new URL('../', import.meta.url));
const root = resolve(core, '../..');
const digestReference = /^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/;
export const NODE_BASE = 'docker.io/library/node:24-bookworm-slim';
export const PYTHON_BASE = 'docker.io/library/python:3.12-slim-bookworm';
export function runnerContainerfile(nodeBase, compilerVersion, arch='x64') {
  if (!digestReference.test(nodeBase) || !/^\d+\.\d+\.\d+$/.test(compilerVersion) || !['x64','arm64'].includes(arch)) throw Error('runner_build_input_invalid');
  const native=Number(compilerVersion.split('.')[0])>=7;
  return `FROM ${nodeBase}\nCOPY typescript-${compilerVersion}.tgz node-types.tgz undici-types.tgz${native?' typescript-native.tgz':''} /tmp/\nRUN npm install --global --offline --ignore-scripts --no-audit --no-fund /tmp/typescript-${compilerVersion}.tgz && mkdir -p /usr/local/lib/node_modules/@types/node /usr/local/lib/node_modules/undici-types && tar -xzf /tmp/node-types.tgz --strip-components=1 -C /usr/local/lib/node_modules/@types/node && tar -xzf /tmp/undici-types.tgz --strip-components=1 -C /usr/local/lib/node_modules/undici-types${native?` && mkdir -p /usr/local/lib/node_modules/@typescript/typescript-linux-${arch} && tar -xzf /tmp/typescript-native.tgz --strip-components=1 -C /usr/local/lib/node_modules/@typescript/typescript-linux-${arch}`:''} && rm /tmp/*.tgz && npm cache clean --force\nUSER 1000:1000\nWORKDIR /workspace\n`;
}
export function runRunnerSetupCommand(executable, args, timeoutMs = 30_000) {
  return new Promise((resolveResult, reject) => {
    const child = spawn(executable, args, {shell:false, windowsHide:true, stdio:['ignore','pipe','pipe']});
    let stdout = '', limited = false, timedOut = false;
    child.stdout.on('data', chunk => { stdout += String(chunk); if (stdout.length > 1_048_576) {limited = true; child.kill();} });
    // CLI errors may contain registry credentials. Only a stable local error code is emitted.
    child.stderr.resume();
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, timeoutMs);
    child.on('error', () => {clearTimeout(timer); reject(Error('runner_command_unavailable'));});
    child.on('close', code => {clearTimeout(timer); if (code !== 0 || limited || timedOut) reject(Error('runner_command_failed')); else resolveResult(stdout);});
  });
}
export async function setupRunner(args, command = runRunnerSetupCommand) {
  if (args.some(arg => !['--check','--prepare-images'].includes(arg)) || args.length > 1) throw Error('runner_arguments_invalid');
  const podman = process.env.UPTOKEY_PODMAN_PATH || 'podman';
  const connection = process.env.UPTOKEY_PODMAN_CONNECTION;
  if (connection !== undefined && !/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(connection)) throw Error('runner_connection_invalid');
  const execute = (args, timeout) => command(podman, [...(connection ? ['--connection',connection] : []),...args],timeout);
  let info;
  try { info = JSON.parse(await execute(['info','--format','json'])); }
  catch { return {schema:'uptokey-runner-setup-v1', ready:false, code:'podman_machine_unavailable', next:process.platform === 'win32' ? 'Run scripts/setup-project-runner-windows.ps1 from an administrator PowerShell; restart only when Windows requests it.' : 'Install Podman and configure a rootless cgroup-v2 machine.'}; }
  // Rootful is accepted only by an explicit opt-in (hosts such as Podman on WSL cannot delegate memory limits to rootless containers).
  if ((info.host?.security?.rootless !== true && process.env.UPTOKEY_RUNNER_ALLOW_ROOTFUL !== '1') || String(info.host?.cgroupVersion) !== 'v2') return {schema:'uptokey-runner-setup-v1',ready:false,code:'rootless_cgroup_v2_required'};
  if (args[0] !== '--prepare-images') {
    const images = [process.env.UPTOKEY_RUNNER_NODE_IMAGE, process.env.UPTOKEY_RUNNER_PYTHON_IMAGE];
    if (images.some(image => !image || !digestReference.test(image))) return {schema:'uptokey-runner-setup-v1',ready:false,code:'runtime_images_missing',next:'node proxy/core/scripts/setup-project-runner.mjs --prepare-images'};
    for (const image of images) await execute(['image','inspect',image]);
    return {schema:'uptokey-runner-setup-v1',ready:true,code:'rootless_runtime_and_images_available'};
  }
  // Download/install only during explicit preparation. Production execution remains --pull=never and network=none.
  const output = join(root, 'output', 'project-runner'); await mkdir(output, {recursive:true});
  const directory = await mkdtemp(join(output, 'prepare-'));
  const pkg = JSON.parse(await readFile(join(core, 'node_modules','typescript','package.json'), 'utf8'));
  const packages = JSON.parse(await readFile(join(core,'package-lock.json'),'utf8')).packages;
  const lock = packages?.['node_modules/typescript'];
  if (lock?.version !== pkg.version || !/^sha512-[A-Za-z0-9+/]+=*$/.test(lock.integrity ?? '')) throw Error('runtime_compiler_lock_invalid');
  const lockedArtifacts = [
    {name:'typescript',entry:lock,file:`typescript-${pkg.version}.tgz`},
    {name:'@types/node',entry:packages?.['node_modules/@types/node'],file:'node-types.tgz'},
    {name:'undici-types',entry:packages?.['node_modules/undici-types'],file:'undici-types.tgz'},
  ];
  const arch={amd64:'x64',x86_64:'x64',arm64:'arm64',aarch64:'arm64'}[info.host?.arch];
  if(!arch)throw Error('runtime_architecture_unsupported');
  if(Number(pkg.version.split('.')[0])>=7){
    const name=`@typescript/typescript-linux-${arch}`,entry=packages?.[`node_modules/${name}`];
    if(entry?.version!==pkg.version)throw Error('runtime_compiler_lock_invalid');
    lockedArtifacts.push({name,entry,file:'typescript-native.tgz'});
  }
  for (const artifact of lockedArtifacts) {
    const entry=artifact.entry;
    if (!entry || !/^\d+\.\d+\.\d+$/.test(entry.version) || !/^sha512-[A-Za-z0-9+/]+=*$/.test(entry.integrity??'')) throw Error('runtime_compiler_lock_invalid');
    const base=artifact.name.split('/').at(-1);
    const response = await fetch(`https://registry.npmjs.org/${artifact.name}/-/${base}-${entry.version}.tgz`, {redirect:'error',signal:AbortSignal.timeout(60_000)});
    if (!response.ok || Number(response.headers.get('content-length')) > 32_000_000) throw Error('runtime_compiler_download_failed');
    const chunks=[]; let size=0;
    for await (const chunk of response.body) {size+=chunk.length;if(size>32_000_000)throw Error('runtime_compiler_download_failed');chunks.push(chunk);}
    const archive = Buffer.concat(chunks);
    if ('sha512-'+createHash('sha512').update(archive).digest('base64') !== entry.integrity) throw Error('runtime_compiler_integrity_failed');
    await writeFile(join(directory,artifact.file),archive);
  }
  async function pullPinned(reference) {
    await execute(['pull',reference], 600_000);
    const [image] = JSON.parse(await execute(['image','inspect',reference]));
    const pinned = image.RepoDigests?.find(value => digestReference.test(value));
    if (!pinned) throw Error('runtime_image_digest_unavailable');
    return pinned;
  }
  const nodeBase = await pullPinned(NODE_BASE), pythonImage = await pullPinned(PYTHON_BASE);
  const containerfile = join(directory, 'Containerfile');
  await writeFile(containerfile, runnerContainerfile(nodeBase, pkg.version,arch));
  const tag = `localhost/uptokey-project-node:node24-ts${pkg.version}`;
  await execute(['build','--pull=never','--network=none','--file',containerfile,'--tag',tag,directory], 600_000);
  const [built] = JSON.parse(await execute(['image','inspect',tag]));
  if (!/^sha256:[a-f0-9]{64}$/.test(built.Digest ?? '')) throw Error('runtime_built_digest_unavailable');
  const nodeImage = `${tag}@${built.Digest}`;
  await execute(['image','inspect',nodeImage]);
  const compiler = (await execute(['run','--rm','--pull=never','--network=none','--read-only','--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--entrypoint=node',nodeImage,'/usr/local/lib/node_modules/typescript/bin/tsc','--version'])).trim().replace(/^Version /,'');
  if (compiler !== pkg.version) throw Error('runtime_compiler_mismatch');
  const manifest = {schema:'uptokey-runner-images-v1', preparedAt:new Date().toISOString(), nodeBase,nodeImage,pythonImage,typescript:compiler,compilerPackages:lockedArtifacts.map(({name,entry})=>({name,version:entry.version,integrity:entry.integrity})),...(connection?{connection}:{})};
  await writeFile(join(directory,'images.json'), JSON.stringify(manifest,null,2)+'\n');
  // Not .env and not a launch/restart: the operator explicitly loads these non-secret process settings.
  await writeFile(join(directory,'activate.ps1'), `$env:UPTOKEY_RUNNER_NODE_IMAGE = '${nodeImage}'\n$env:UPTOKEY_RUNNER_PYTHON_IMAGE = '${pythonImage}'\n`+(connection?`$env:UPTOKEY_PODMAN_CONNECTION = '${connection}'\n`:''));
  // The profile keeps the same non-secret settings, so a service started later (also by the TUI) finds the runner
  // without the activation variables (src/workspace/runner-settings.ts; environment variables keep precedence).
  const profile = process.env.UPTOKEY_QUIMERA_DATA_DIR ?? join(homedir(), '.uptokey-quimera');
  await mkdir(profile, {recursive:true});
  await writeFile(join(profile,'project-runner.json'), JSON.stringify({schema:'uptokey-project-runner-v1',nodeImage,pythonImage,...(connection?{podmanConnection:connection}:{}),...(podman!=='podman'?{podmanPath:podman}:{}),...(process.env.UPTOKEY_RUNNER_ALLOW_ROOTFUL==='1'?{allowRootful:true}:{})},null,2)+'\n');
  return {schema:'uptokey-runner-setup-v1',ready:true,code:'images_prepared',manifest:join(directory,'images.json'),activation:join(directory,'activate.ps1'),profileSettings:join(profile,'project-runner.json')};
}
if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  try {const result = await setupRunner(process.argv.slice(2)); process.stdout.write(JSON.stringify(result)+'\n'); if (!result.ready) process.exitCode = 2;}
  catch (error) {process.stdout.write(JSON.stringify({schema:'uptokey-runner-setup-v1',ready:false,code:/^runner_|^runtime_/.test(error?.message) ? error.message : 'runner_setup_failed'})+'\n'); process.exitCode = 1;}
}
