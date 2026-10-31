import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {existsSync} from 'node:fs';
import {statePath} from './harness-paths.mjs';
import {ensureInstalledRuntime} from './installed-runtime.mjs';
import {hostEnvironment} from './host-environment.mjs';
import {provisionExecutor,prepareExecutorRecovery} from './executor.mjs';
import {reconnectServices} from './reconnect.mjs';
import {authenticatedStartup} from './startup-link.mjs';
import {ensureRuntimeEngine} from './runtime-engine.mjs';
import {prepareControllerRecovery} from './controller.mjs';
import {checkpointOperations,checkpointVolumes,captureRuntimeCheckpoint,readRuntimeCheckpoint,writeRuntimeCheckpoint,preparePairRecovery} from './runtime-checkpoint.mjs';
import {imageUsesEncryptedWorkspace,preflightWorkspaceMount} from './workspace-volume-policy.mjs';
const execute=promisify(execFile);
const controllerName='uptokey-deepseek-workbench',executorName='uptokey-workbench-executor';
const stages=new Set(['engine','inspection','archive','fresh-start','recovery','provision','connect','web']);
class RuntimeStageError extends Error {
 constructor(stage){super(`runtime-stage-${stage}`);this.stage=stage;}
}
// Retain only a fixed stage identifier; never forward Podman output, paths or secrets.
export async function runtimeStage(stage, operation){
 if(!stages.has(stage))throw Error('runtime-stage-invalid');
 try{return await operation();}catch(error){if(error instanceof RuntimeStageError)throw error;throw new RuntimeStageError(stage);}
}
export function runtimeFailureReceipt(error){
 return {restarted:false,error:error instanceof RuntimeStageError&&stages.has(error.stage)?`runtime-stage-${error.stage}`:'runtime-restart-unverified'};
}
function owned(item,requireRunning=true){
 if(item?.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||typeof item.State?.Running!=='boolean'||(requireRunning&&!item.State.Running)||!/^[a-f0-9]{64}$/.test(item.Id??'')||!Array.isArray(item.Mounts)||item.Mounts.some(m=>m.Type==='bind'))throw Error('runtime-ownership-invalid');
 return {id:item.Id,image:item.Image,startedAt:item.State.StartedAt};
}
/** Restart the exact owned controller, never replace its image or restart its executor. */
export async function restartRuntime({inspect,restart,provision,reconnect,ready}){
 const before=owned(await inspect(controllerName));
 const executor=owned(await inspect(executorName));
 await restart(before.id);
 await provision();
 const after=owned(await inspect(controllerName));
 const executorAfter=owned(await inspect(executorName));
 if(after.id!==before.id||after.image!==before.image||after.startedAt===before.startedAt||JSON.stringify(executorAfter)!==JSON.stringify(executor))throw Error('runtime-identity-changed');
 const connections=await reconnect();
 const webReady=await ready();
 return {restarted:true,webReady,connections:connections.services,controllerId:after.id,image:after.image,executorRestarted:false,personalCoreRestarted:false};
}
export async function setRuntimeState(action,{inspect,start,stop,provision,reconnect,ready,ensureEngine,prepareRecovery,prepareController,preparePair,prepareFresh,preflightWorkspace}){
 if(!['start','stop'].includes(action))throw Error('runtime-action-invalid');
 if(action==='start')await ensureEngine?.();
 let c=await inspect(controllerName),x=await inspect(executorName),recoveredController=false,recoveredPair=false,createdFresh=false;
 if(!c&&!x&&action==='start'&&prepareFresh){
  const image=await prepareFresh();
  if(image){
   c=await inspect(controllerName);x=await inspect(executorName);
   if(owned(c).image.replace(/^sha256:/,'')!==image||owned(x).image.replace(/^sha256:/,'')!==image)throw Error('runtime-fresh-identity-changed');
   createdFresh=true;
  }
 }
 if(!c&&!x&&action==='start'&&preparePair){
  const restore=await preparePair(),image=await restore();
  c=await inspect(controllerName);x=await inspect(executorName);
  if(owned(c).image!==image||owned(x).image!==image)throw Error('runtime-recovery-identity-changed');
  recoveredPair=true;
 }
 if(action==='start'&&c&&(!x||!c.State.Running||!x.State.Running))await preflightWorkspace?.(c.Image);
 if(!c&&x&&action==='start'&&prepareController){
  const survivor=owned(x,false),wasRunning=x.State.Running,restore=await prepareController(x);
  if(!x.State.Running)await start(survivor.id);
  await restore();
  c=await inspect(controllerName);x=await inspect(executorName);
  const restored=owned(c),after=owned(x);
  if(restored.image!==survivor.image||after.id!==survivor.id||after.image!==survivor.image||(wasRunning&&survivor.startedAt!==after.startedAt))throw Error('runtime-recovery-identity-changed');
  recoveredController=true;
 }
 const controller=owned(c,false);let recoveredExecutor=false;
 if(!x){
  if(action!=='start'||!prepareRecovery)throw Error('runtime-executor-missing');
  const restore=await prepareRecovery(c);
  if(c.State.Running)await stop(controller.id);
  await restore();
  x=await inspect(executorName);
  const restored=owned(x),survivor=owned(await inspect(controllerName),false);
  if(restored.image!==controller.image||survivor.id!==controller.id||survivor.image!==controller.image)throw Error('runtime-recovery-identity-changed');
  recoveredExecutor=true;
 }
 const executor=owned(x,false);
 if(action==='stop'){
  if(c.State.Running)await stop(controller.id);
  if(x.State.Running)await stop(executor.id);
 }else{
  // A restarted executor has a new SSH host key; controller must receive it before serving tools.
  if(!x.State.Running&&c.State.Running)await stop(controller.id);
  if(!x.State.Running)await start(executor.id);
  if(!c.State.Running||!x.State.Running||recoveredExecutor)await start(controller.id);
  await provision();
 }
 const ca=await inspect(controllerName),xa=await inspect(executorName);
 const a=owned(ca,false),b=owned(xa,false),running=action==='start';
 if(a.id!==controller.id||a.image!==controller.image||b.id!==executor.id||b.image!==executor.image||ca.State.Running!==running||xa.State.Running!==running)throw Error('runtime-transition-unverified');
 const connections=running?await reconnect():undefined;
 return {state:running?'running':'stopped',createdFresh,alreadyRunning:running&&!createdFresh&&c.State.Running&&x.State.Running&&!recoveredExecutor&&!recoveredController&&!recoveredPair,recoveredPair,recoveredExecutor,recoveredController,controllerId:a.id,image:a.image,executorId:b.id,webReady:running?await ready():false,...(connections?{connections:connections.services}:{}),personalCoreChanged:false};
}
export async function waitForRuntimeReady(){const deadline=Date.now()+30000;while(Date.now()<deadline){try{const response=await fetch('http://127.0.0.1:43180/',{redirect:'manual',signal:AbortSignal.timeout(1000)});await response.body?.cancel();if([200,401].includes(response.status))return true;}catch{}await new Promise(done=>setTimeout(done,250));}return false;}
async function main(){
 const args=process.argv.slice(2);
 if(args.some(a=>!['--native','--start','--stop'].includes(a))||(args.includes('--start')&&args.includes('--stop')))throw Error('runtime-action-invalid');
 const root=fileURLToPath(new URL('..',import.meta.url)),env=hostEnvironment();
 const connection=process.platform==='win32'?['--connection','uptokey-runner-root']:[];
 const podman=args=>execute('podman',[...connection,...args],{cwd:root,env,windowsHide:true,timeout:30000,maxBuffer:1024*1024});
 const metadata=checkpointOperations(connection,env);
 const operations={
  ensureEngine:()=>runtimeStage('engine',()=>ensureRuntimeEngine()),
  prepareFresh:()=>runtimeStage('fresh-start',async()=>{
   // Existing state always follows the exact checkpoint/recovery contract.
   if(existsSync(statePath(root,'.local','runtime-checkpoint.json'))||checkpointVolumes.some(v=>metadata.exists('volume',v)))return null;
   const packaged=await runtimeStage('archive',()=>ensureInstalledRuntime(metadata));if(!packaged)return null;
   await execute(process.execPath,[resolve(root,'scripts/lab.mjs'),'start'],{cwd:root,env,windowsHide:true,timeout:600000,maxBuffer:65536});
   return packaged.image;
  }),
  inspect:name=>runtimeStage('inspection',async()=>{try{await podman(['container','exists',name]);}catch(error){if(error.code===1)return null;throw error;}return JSON.parse((await podman(['inspect',name])).stdout)[0];}),
  prepareRecovery:controller=>runtimeStage('recovery',()=>prepareExecutorRecovery(controller,connection,env)),
  prepareController:executor=>runtimeStage('recovery',()=>{if(imageUsesEncryptedWorkspace(executor.Image,metadata))preflightWorkspaceMount(executor.Image,metadata);return prepareControllerRecovery(executor,connection,env);}),
  preparePair:()=>runtimeStage('recovery',()=>{const checkpoint=readRuntimeCheckpoint(root);if(imageUsesEncryptedWorkspace(checkpoint.image,metadata))preflightWorkspaceMount(checkpoint.image,metadata);return preparePairRecovery(checkpoint,connection,env);}),
  preflightWorkspace:image=>runtimeStage('recovery',()=>{if(imageUsesEncryptedWorkspace(image,metadata))preflightWorkspaceMount(image,metadata);}),
  restart:id=>podman(['restart','--time','15',id]),
  start:id=>podman(['start',id]),stop:id=>podman(['stop','--time','15',id]),
  provision:()=>runtimeStage('provision',()=>provisionExecutor(controllerName,connection,env)),
  reconnect:()=>runtimeStage('connect',()=>reconnectServices(command=>execute(process.execPath,[resolve(root,'scripts/lab.mjs'),command],{cwd:root,env,windowsHide:true,timeout:20000,maxBuffer:65536}))),
  ready:()=>runtimeStage('web',waitForRuntimeReady),
 };
 const action=args.includes('--start')?'start':args.includes('--stop')?'stop':'restart';
 const result=action==='restart'?await restartRuntime(operations):await setRuntimeState(action,operations);
 if(action!=='stop'&&result.webReady)writeRuntimeCheckpoint(root,captureRuntimeCheckpoint(await operations.inspect(controllerName),await operations.inspect(executorName),checkpointOperations(connection,env)));
 if(args.includes('--native')&&action!=='stop'){
  if(!result.webReady)throw Error('runtime-web-unavailable');
  const item=JSON.parse((await podman(['inspect',controllerName])).stdout)[0];
  if(owned(item).id!==result.controllerId)throw Error('runtime-identity-changed');
  const {url,cookie}=await authenticatedStartup(async()=>{const logs=await podman(['logs','--since',item.State.StartedAt,controllerName]);return logs.stdout+logs.stderr;});
  // Captured by the native helper; normal CLI output never includes this credential.
  console.log(JSON.stringify({...result,url,cookie}));
 }else console.log(JSON.stringify(result));
}
if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){main().catch(error=>{console.log(JSON.stringify(runtimeFailureReceipt(error)));process.exitCode=1});}
