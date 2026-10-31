import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { existsSync, lstatSync, realpathSync } from 'node:fs';
import { Entry } from '@napi-rs/keyring';
import { reconcileVaultKey } from './vault-key.mjs';
import { ensureLocalBridge, connectLocalBridge, bridgePaths } from './local-model-bridge.mjs';
import {ensureCoreBridge,connectCoreBridge,startCorePairing,finishCorePairing} from './core-bridge.mjs';
import { hostEnvironment } from './host-environment.mjs';
import {ensureExecutor,provisionExecutor,stopExecutor,runtimeImage,inspectExecutor,prepareExecutorRecovery} from './executor.mjs';
import {assertAttachmentCachePolicy} from './attachment-cache-policy.mjs';
import {controllerArguments} from './controller.mjs';
import {waitForRuntimeReady} from './restart-runtime.mjs';
import {checkpointOperations,checkpointVolumes,invalidateRuntimeCheckpoint,captureRuntimeCheckpoint,writeRuntimeCheckpoint} from './runtime-checkpoint.mjs';
import {IMAGE_VOLUME,ensureImageVolume,assertImageMount,supportsExplicitVolumeOwnership} from './image-materialization-policy.mjs';
import {ensureWorkspaceVolume,imageUsesEncryptedWorkspace,assertWorkspaceMount,preflightWorkspaceMount,workspaceMountPreflightNeeded} from './workspace-volume-policy.mjs';
import {verifyTauriTransposition} from './transposition-gate.mjs';
import {statePath} from './harness-paths.mjs';
import {ensureInstalledRuntime} from './installed-runtime.mjs';
import {podmanSecretInput} from './podman-secret-input.mjs';

const root = realpathSync(fileURLToPath(new URL('..', import.meta.url)));
const name = 'uptokey-deepseek-workbench';
const image = 'localhost/uptokey-deepseek-workbench:0.2.1-rc.2';
const owner = 'io.uptokey.experiment=deepseek-workbench';
const command = process.argv[2] ?? 'status';
const env = hostEnvironment();
// These host values locate Podman only; none is forwarded into the container.
const connection = process.platform === 'win32' ? ['--connection', 'uptokey-runner-root'] : [];
function podman(args, capture = false) {
  const result = spawnSync('podman', [...connection, ...args], { cwd: root, env, encoding: 'utf8', stdio: capture ? 'pipe' : 'inherit', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Podman ${args[0]} failed (${result.status}): ${capture ? result.stderr.trim() : 'see output'}`);
  return result.stdout;
}
function inspect() {
  const result = spawnSync('podman', [...connection, 'container', 'exists', name], { cwd: root, env, windowsHide: true });
  if (result.status === 1) return null;
  if (result.status !== 0) throw new Error('Podman unavailable; start its engine first.');
  const item = JSON.parse(podman(['inspect', name], true))[0];
  if (item.Config.Labels?.['io.uptokey.experiment'] !== 'deepseek-workbench') throw new Error('Container name belongs to another owner');
  return item;
}
function ensureVaultKey() {
  const secretName = 'uptokey-workbench-vault-key';
  const native = new Entry('com.uptokey.harness.lab','credential-master-key');
  return reconcileVaultKey({
    readNative:()=>native.getPassword(),
    writeNative:key=>native.setPassword(key),
    readRuntime:()=>{
      const names=podman(['secret','ls','--format','{{.Name}}'],true).trim().split(/\r?\n/);
      if(!names.includes(secretName))return undefined;
      const metadata=JSON.parse(podman(['secret','inspect',secretName],true))[0];
      if(metadata.Spec?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('Vault key belongs to another owner');
      // Capture only in memory; never inherit stdout or include output in errors.
      const value=spawnSync('podman',[...connection,'secret','inspect','--showsecret',secretName],{env,encoding:'utf8',windowsHide:true});
      if(value.status!==0)throw Error('vault_runtime_key_unavailable');
      let key;try{key=JSON.parse(value.stdout)[0]?.SecretData}catch{throw Error('vault_runtime_key_invalid')}
      if(typeof key!=='string'||!/^[a-f0-9]{64}$/.test(key))throw Error('vault_runtime_key_invalid');
      return key;
    },
    writeRuntime:key=>{
      const created=podmanSecretInput([...connection,'secret','create','--label',owner,secretName,'-'],{env,input:key});
      if(created.status!==0)throw Error('Unable to create laboratory vault key');
    },
    canInitialize:()=>{
  // Never regenerate a missing key while its encrypted data might survive.
  const volume = spawnSync('podman', [...connection, 'volume', 'exists', 'uptokey-deepseek-workbench-home'], {env,windowsHide:true});
  if (volume.status !== 0 && volume.status !== 1) throw new Error('Unable to inspect laboratory volume');
  if (volume.status === 0) {
    const inspected = inspect();
    if (!inspected?.State.Running || inspected.Config.Labels?.['io.uptokey.credentials'] === 'encrypted-v1') throw new Error('Vault key missing: restore it, do not reset it');
    const encryptedExists = podman(['exec', name, 'node', '-e', 'console.log(require("fs").existsSync("/home/node/.dsh/credentials.encrypted.json"))'], true).trim();
    if (encryptedExists !== 'false') throw new Error('Existing encrypted vault requires its original key');
  }
      return true;
    },
  });
}
for (const path of ['runtime', 'runtime/package.json', 'runtime/Containerfile']) {
  const target = resolve(root, path);
  if (lstatSync(target).isSymbolicLink() || !realpathSync(target).startsWith(root + (process.platform === 'win32' ? '\\' : '/'))) throw new Error('Runtime path leaves experiment');
}
if (existsSync(resolve(root, '.git')) || existsSync(resolve(root, 'upstream/.git'))) throw new Error('Git metadata is forbidden in this experiment');
if (command === 'vault-protect') {
  console.log(JSON.stringify(ensureVaultKey()));
} else if (command === 'build') {
  verifyTauriTransposition(root,env);
  podman(['build', '--label', owner, '-t', image, '-f', 'runtime/Containerfile', 'runtime']);
} else if (command === 'start' || command === 'refresh') {
  let item = inspect();
  const metadata=checkpointOperations(connection,env);
   if(command==='start'&&!item&&(inspectExecutor(connection,env)||existsSync(statePath(root,'.local','runtime-checkpoint.json'))||checkpointVolumes.some(v=>metadata.exists('volume',v)))){
    const r=spawnSync(process.execPath,['scripts/restart-runtime.mjs','--start'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:150000});
    if(r.error||r.status!==0)throw Error('Runtime recovery was not verified; existing state was preserved');
    console.log(r.stdout.trim());
  }else{
  // A failed refresh must not leave a prior image checkpoint eligible for recovery.
  if(command==='refresh')invalidateRuntimeCheckpoint(root);
  // Admit recovery before touching keys or stopping the surviving controller.
  const executorBefore=command==='start'?inspectExecutor(connection,env):null;
  const recoverExecutor=command==='start'&&item&&!executorBefore
    ? prepareExecutorRecovery(item,connection,env):null;
  // Installed resources select an immutable accepted ID; do this before vault
  // access or container mutations. Development keeps its existing image tag.
  const packaged=(!item||command==='refresh')?ensureInstalledRuntime(metadata):null;
  if(command==='start'&&item)assertAttachmentCachePolicy(item);
  if(command==='start'&&item)assertImageMount(item);
  if(command==='start'&&item&&item.Config.Labels?.['io.uptokey.execution']!=='ssh-v1')throw Error('Legacy laboratory runtime: use refresh to enable the separate executor');
  ensureImageVolume({exists:()=>{const r=spawnSync('podman',[...connection,'volume','exists',IMAGE_VOLUME],{env,windowsHide:true});if(![0,1].includes(r.status))throw Error('Image volume unavailable');return r.status===0;},supportsExplicitOwnership:()=>{const r=spawnSync('podman',[...connection,'volume','create','--help'],{cwd:root,env,encoding:'utf8',windowsHide:true,timeout:10000,maxBuffer:1024*1024});if(r.error||r.status!==0)throw Error('image_volume_capabilities_unavailable');return supportsExplicitVolumeOwnership(r.stdout);},run:args=>podman(args,true)});
  const selectedImage=runtimeImage(command,item,packaged?.image??image);
  const workspacePolicy=imageUsesEncryptedWorkspace(selectedImage,metadata);
  if(workspaceMountPreflightNeeded(workspacePolicy,command,item,executorBefore))preflightWorkspaceMount(selectedImage,metadata);
  if(workspacePolicy)ensureWorkspaceVolume(metadata);
  // Do not initialize native credentials or either bridge until the protected
  // workspace mount is proven by the same engine that will start the runtime.
  ensureVaultKey();
  ensureLocalBridge(root,connection,env);
  let coreBridgePrepared=false;
  try {ensureCoreBridge(root,connection,env);coreBridgePrepared=true;}
  catch {console.warn('Uptokey core bridge setup is unavailable; continuing with the isolated Harness.');}
  if(recoverExecutor&&item.State.Running){podman(['stop','--time','15',item.Id]);item=inspect();}
  const executorRestarted=recoverExecutor?recoverExecutor():ensureExecutor(selectedImage,connection,env,{refresh:command==='refresh'});
  if(executorRestarted&&item?.State.Running&&item.Config.Labels?.['io.uptokey.execution']==='ssh-v1'){
    podman(['stop','--time','15',name]);item=inspect();
  }
  if (command === 'refresh' && item) {
    if (item.State.Running) podman(['stop', '--time', '15', name]);
    podman(['rename', name, `${name}-previous-${Date.now()}`]);
    item = null;
  }
  if (item) {
    if (!item.State.Running) podman(['start', name]);
  } else {
    podman(controllerArguments(selectedImage,coreBridgePrepared));
  }
  assertAttachmentCachePolicy(inspect());
  assertImageMount(inspect());
  if(workspacePolicy){assertWorkspaceMount(inspect());assertWorkspaceMount(inspectExecutor(connection,env));}
  if(inspect()?.Config.Labels?.['io.uptokey.execution']==='ssh-v1')provisionExecutor(name,connection,env);
  console.log('Harness: http://127.0.0.1:43180 — use the startup authentication link from local container logs if requested.');
  if (existsSync(bridgePaths(root).state)) {
    try { await connectLocalBridge(root,connection,env); }
    catch { console.warn('Ollama local is disconnected. Use connect-local when its service is available.'); }
  }
  if(coreBridgePrepared){
    try {if(await connectCoreBridge(root,connection,env))console.log('Uptokey core bridge: connected');}
    catch {console.warn('Uptokey core bridge is unavailable; the laboratory remains usable.');}
  }
  if(!await waitForRuntimeReady())throw Error('Runtime readiness was not verified');
  writeRuntimeCheckpoint(root,captureRuntimeCheckpoint(inspect(),inspectExecutor(connection,env),metadata));
  }
} else if (command === 'connect-local') {
  if (!inspect()?.State.Running) throw new Error('Start the laboratory first');
  await connectLocalBridge(root,connection,env);
} else if (command === 'core-pair') {
  console.log(JSON.stringify(await startCorePairing(root),null,2));
} else if (command === 'core-pair-finish') {
  console.log(JSON.stringify(await finishCorePairing(root),null,2));
} else if (command === 'connect-core') {
  if(!inspect()?.State.Running)throw Error('Start the laboratory first');
  if(!await connectCoreBridge(root,connection,env))throw Error('Pair the laboratory with Uptokey first');
  console.log('Uptokey core bridge: connected');
} else if (command === 'open') {
  if (!inspect()?.State.Running) throw new Error('Start the laboratory first.');
  const logs = spawnSync('podman', [...connection, 'logs', name], { cwd: root, env, encoding: 'utf8', windowsHide: true });
  if (logs.status !== 0) throw new Error('Unable to read startup link.');
  const urls = [...(logs.stdout + logs.stderr).matchAll(/http:\/\/127\.0\.0\.1:43180\/\?token=[A-Za-z0-9._~%-]+/g)];
  const url = urls.at(-1)?.[0];
  if (!url) throw new Error('Startup authentication link unavailable.');
  const [executable, ...args] = process.platform === 'win32'
    ? ['rundll32.exe', 'url.dll,FileProtocolHandler', url]
    : process.platform === 'darwin' ? ['open', url] : ['xdg-open', url];
  const browser = spawn(executable, args, { env, stdio: 'ignore', detached: true, windowsHide: true });
  browser.on('error', error => { console.error(error.message); process.exitCode = 1; });
  browser.unref();
} else if (command === 'stop') {
  if (inspect()?.State.Running) podman(['stop', '--time', '15', name]);
  stopExecutor(connection,env);
} else if (command === 'status') {
  const item = inspect();
  console.log(JSON.stringify({ container: name, running: item?.State.Running ?? false, url: 'http://127.0.0.1:43180', mounts: item?.Mounts.map(m => ({ type: m.Type, destination: m.Destination })) ?? [] }, null, 2));
} else throw new Error('Use build, start, open, refresh, stop, connect-local, core-pair, core-pair-finish, or connect-core');
