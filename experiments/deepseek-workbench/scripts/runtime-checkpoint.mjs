import {spawnSync} from 'node:child_process';
import {lstatSync,readFileSync,writeFileSync,renameSync,unlinkSync,realpathSync} from 'node:fs';
import {resolve,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {assertAttachmentCachePolicy} from './attachment-cache-policy.mjs';
import {IMAGE_VOLUME,IMAGE_PATH,assertImageMount,assertImageVolume} from './image-materialization-policy.mjs';
import {executorNetwork,ensureExecutor,runtimeImage} from './executor.mjs';
import {prepareControllerRecovery} from './controller.mjs';
import {WORKSPACE_VOLUME} from './workspace-volume-policy.mjs';
import {statePath} from './harness-paths.mjs';
const controller='uptokey-deepseek-workbench',executor='uptokey-workbench-executor';
export const checkpointVolumes=['uptokey-deepseek-workbench-home',WORKSPACE_VOLUME,'uptokey-workbench-attachments','uptokey-workbench-executor-home',IMAGE_VOLUME];
const required=['uptokey-workbench-vault-key','uptokey-workbench-local-model-public-key'];
const core=['uptokey-workbench-core-public-key','uptokey-workbench-core-gate'];
const own=labels=>labels?.['io.uptokey.experiment']==='deepseek-workbench';
// A verified local OCI image may take minutes to unpack, especially on a
// software-emulated or slow filesystem. Metadata probes remain short.
export function checkpointCommandTimeout(args){
 return args.length===3&&args[0]==='load'&&args[1]==='--input'&&typeof args[2]==='string'&&args[2].length>0?900000:30000;
}
export function checkpointOperations(connection,env){
 const call=args=>spawnSync('podman',[...connection,...args],{env,encoding:'utf8',windowsHide:true,timeout:checkpointCommandTimeout(args)});
 const run=args=>{const r=call(args);if(r.error||r.status!==0)throw Error('runtime-checkpoint-metadata-unavailable');return r.stdout.trim();};
 const exists=(kind,name)=>{const r=call([kind,'exists',name]);if(r.error||![0,1].includes(r.status))throw Error('runtime-checkpoint-status-unavailable');return r.status===0;};
 return {run,exists,inspect:()=>exists('container',executor)?JSON.parse(run(['inspect',executor]))[0]:null};
}
function state(image,{run,exists}){
 if(!/^(sha256:)?[a-f0-9]{64}$/.test(image??'')||!exists('image',image))throw Error('runtime-checkpoint-image-unavailable');
 const volumes=checkpointVolumes.map(name=>{
  if(!exists('volume',name))throw Error('runtime-checkpoint-volume-missing');
  const v=JSON.parse(run(['volume','inspect',name]))[0];
  // Original named volumes predate owner labels. Their exact creation identity is pinned.
  if(v.Name!==name||v.Driver!=='local'||!Number.isFinite(Date.parse(v.CreatedAt)))throw Error('runtime-checkpoint-volume-invalid');
  if(name===IMAGE_VOLUME)assertImageVolume(v);
  return {name,createdAt:v.CreatedAt,driver:v.Driver,options:v.Options??{}};
 });
 if(!exists('network',executorNetwork))throw Error('runtime-checkpoint-network-missing');
 const n=JSON.parse(run(['network','inspect',executorNetwork]))[0];
 if(!own(n.labels)||typeof n.id!=='string'||!n.id)throw Error('runtime-checkpoint-network-invalid');
 const names=new Set(run(['secret','ls','--format','{{.Name}}']).split(/\r?\n/));
 if(core.some(n=>names.has(n))&&!core.every(n=>names.has(n)))throw Error('runtime-checkpoint-core-incomplete');
 const secrets=[...required,...(core.every(n=>names.has(n))?core:[])].map(name=>{
  if(!names.has(name))throw Error('runtime-checkpoint-secret-missing');
  const s=JSON.parse(run(['secret','inspect',name]))[0];
  if(!own(s.Spec?.Labels)||typeof s.ID!=='string'||!s.ID)throw Error('runtime-checkpoint-secret-invalid');
  return {name,id:s.ID};
 });
 return {version:1,image,volumes,network:{name:executorNetwork,id:n.id},secrets};
}
export function captureRuntimeCheckpoint(c,x,operations){
 const image=runtimeImage('start',c,null);
 for(const item of [c,x])if(!item?.State?.Running||!own(item.Config?.Labels)||item.Image!==image||item.HostConfig?.ReadonlyRootfs!==true||!Array.isArray(item.Mounts)||item.Mounts.some(m=>m.Type==='bind'))throw Error('runtime-checkpoint-pair-invalid');
 if(c.Config.Labels['io.uptokey.execution']!=='ssh-v1'||c.Config.Labels['io.uptokey.credentials']!=='encrypted-v1')throw Error('runtime-checkpoint-controller-invalid');
 assertAttachmentCachePolicy(c);assertImageMount(c);assertImageMount(x,true);
 for(const [item,home] of [[c,checkpointVolumes[0]],[x,checkpointVolumes[3]]]){
  const expected=[['/home/node',home,true],['/workspace',checkpointVolumes[1],true],['/home/node/.dsh/attachments',checkpointVolumes[2],item===c],[IMAGE_PATH,IMAGE_VOLUME,item===c]];
  for(const [destination,name,rw] of expected){const mounts=item.Mounts.filter(m=>m.Destination===destination);if(mounts.length!==1||mounts[0].Type!=='volume'||mounts[0].Name!==name||mounts[0].RW!==rw)throw Error('runtime-checkpoint-mount-invalid');}
 }
 const snapshot=state(image,operations);
 const mounted=c.Config.Secrets;
 if(!Array.isArray(mounted)||mounted.length!==snapshot.secrets.length||snapshot.secrets.some(s=>mounted.filter(m=>m.Name===s.name&&m.ID===s.id).length!==1))throw Error('runtime-checkpoint-mounted-secret-changed');
 return snapshot;
}
/** All admission checks precede the first creation. No secret values or mutable tags. */
export function preparePairRecovery(checkpoint,connection,env,{operations=checkpointOperations(connection,env)}={}){
 const validate=()=>{
  if(operations.exists('container',controller)||operations.exists('container',executor))throw Error('runtime-checkpoint-pair-present');
  if(checkpoint?.version!==1||JSON.stringify(state(checkpoint.image,operations))!==JSON.stringify(checkpoint))throw Error('runtime-checkpoint-state-changed');
 };
 validate();
 return ()=>{
  validate();
  ensureExecutor(checkpoint.image,connection,env,{operations});
  const x=operations.inspect();
  prepareControllerRecovery(x,connection,env,{operations})();
  return checkpoint.image;
 };
}
function safePath(root){
 const directory=statePath(root,'.local');
 if(lstatSync(directory).isSymbolicLink()||realpathSync(directory)!==directory)throw Error('runtime-checkpoint-directory-invalid');
 return resolve(directory,'runtime-checkpoint.json');
}
function checkFile(path){try{const s=lstatSync(path);if(!s.isFile()||s.isSymbolicLink()||s.nlink!==1||s.size>32768)throw Error('runtime-checkpoint-file-invalid');return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}}
export function readRuntimeCheckpoint(root){const path=safePath(root);if(!checkFile(path))throw Error('runtime-checkpoint-missing');return JSON.parse(readFileSync(path,'utf8'));}
export function invalidateRuntimeCheckpoint(root){const path=safePath(root);if(checkFile(path))unlinkSync(path);}
export function writeRuntimeCheckpoint(root,value){
 const path=safePath(root),data=JSON.stringify(value,null,2)+'\n';
 if(checkFile(path)&&readFileSync(path,'utf8')===data)return false;
 const temporary=resolve(dirname(path),`checkpoint-${randomUUID()}.tmp`);
 try{writeFileSync(temporary,data,{flag:'wx',mode:0o600});checkFile(path);renameSync(temporary,path);}finally{try{unlinkSync(temporary);}catch(e){if(e.code!=='ENOENT')throw e;}}
 return true;
}
