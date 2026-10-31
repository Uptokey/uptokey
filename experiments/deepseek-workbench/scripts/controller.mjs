import {spawnSync} from 'node:child_process';
import {attachmentCacheArguments} from './attachment-cache-policy.mjs';
import {IMAGE_VOLUME,IMAGE_PATH,imageMountArguments,assertImageMount,assertImageVolume} from './image-materialization-policy.mjs';
import {executorNetwork,runtimeImage} from './executor.mjs';
import {WORKSPACE_VOLUME,workspaceVolumeArguments} from './workspace-volume-policy.mjs';
const name='uptokey-deepseek-workbench',owner='io.uptokey.experiment=deepseek-workbench';
export function controllerArguments(image,coreBridgePrepared=false){return ['run','-d','--name',name,'--label',owner,
 '--label','io.uptokey.credentials=encrypted-v1','--label','io.uptokey.execution=ssh-v1','--network',executorNetwork,
 '--env','UPTOKEY_SEPARATE_EXECUTOR=1',
 '--secret','uptokey-workbench-vault-key,type=mount,uid=1000,gid=1000,mode=0400',
 '--secret','uptokey-workbench-local-model-public-key,type=mount,uid=1000,gid=1000,mode=0400',
 ...(coreBridgePrepared?['--secret','uptokey-workbench-core-public-key,type=mount,uid=1000,gid=1000,mode=0400','--secret','uptokey-workbench-core-gate,type=mount,uid=1000,gid=1000,mode=0400']:[]),
 '--user','1000:1000','--cap-drop=ALL','--security-opt=no-new-privileges','--pids-limit=256','--memory=1536m','--cpus=2','--read-only',
 ...attachmentCacheArguments(),...imageMountArguments(),'--tmpfs','/tmp:rw,nosuid,nodev,size=256m',
 '-p','127.0.0.1:43180:43180','-p','127.0.0.1:43191:43191',
 '-v','uptokey-deepseek-workbench-home:/home/node','-v','uptokey-workbench-attachments:/home/node/.dsh/attachments',...workspaceVolumeArguments(),image];}
function commands(connection,env){
 const call=args=>spawnSync('podman',[...connection,...args],{env,encoding:'utf8',windowsHide:true,timeout:30000});
 return {run:args=>{const r=call(args);if(r.error||r.status!==0)throw Error('runtime-recovery-metadata-unavailable');return r.stdout.trim();},exists:(kind,id)=>{const r=call([kind,'exists',id]);if(r.error||![0,1].includes(r.status))throw Error('runtime-recovery-status-unavailable');return r.status===0;}};
}
/** Recover only from the surviving executor and existing state; never initialize a key. */
export function prepareControllerRecovery(executor,connection,env,{operations=commands(connection,env)}={}){
 const {run,exists}=operations;
 const image=runtimeImage('start',executor,null);
 if(!executor||executor.HostConfig?.ReadonlyRootfs!==true||executor.Mounts?.some(m=>m.Type==='bind'))throw Error('runtime-recovery-executor-invalid');
 assertImageMount(executor,true);
 const mounts=[['/home/node','uptokey-workbench-executor-home',true],['/workspace',WORKSPACE_VOLUME,true],['/home/node/.dsh/attachments','uptokey-workbench-attachments',false],[IMAGE_PATH,IMAGE_VOLUME,false]];
 for(const [path,volume,rw] of mounts){const found=executor.Mounts.filter(m=>m.Destination===path);if(found.length!==1||found[0].Type!=='volume'||found[0].Name!==volume||found[0].RW!==rw)throw Error('runtime-recovery-volume-invalid');}
 if(exists('container',name))throw Error('runtime-recovery-controller-present');
 for(const volume of [...mounts.map(x=>x[1]),'uptokey-deepseek-workbench-home'])if(!exists('volume',volume))throw Error('runtime-recovery-volume-missing');
 assertImageVolume(JSON.parse(run(['volume','inspect',IMAGE_VOLUME]))[0]);
 if(!exists('network',executorNetwork)||JSON.parse(run(['network','inspect',executorNetwork]))[0].labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('runtime-recovery-network-invalid');
 if(!exists('image',image))throw Error('runtime-recovery-image-missing');
 const secrets=new Set(run(['secret','ls','--format','{{.Name}}']).split(/\r?\n/));
 const required=['uptokey-workbench-vault-key','uptokey-workbench-local-model-public-key'];
 const core=['uptokey-workbench-core-public-key','uptokey-workbench-core-gate'];
 if(core.some(n=>secrets.has(n))&&!core.every(n=>secrets.has(n)))throw Error('runtime-recovery-core-secrets-incomplete');
 const hasCore=core.every(n=>secrets.has(n));
 for(const secret of [...required,...(hasCore?core:[])]){
  if(!secrets.has(secret))throw Error('runtime-recovery-secret-missing');
  if(JSON.parse(run(['secret','inspect',secret]))[0]?.Spec?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('runtime-recovery-secret-owner-invalid');
 }
 return ()=>{if(exists('container',name))throw Error('runtime-recovery-controller-present');return run(controllerArguments(image,hasCore));};
}
