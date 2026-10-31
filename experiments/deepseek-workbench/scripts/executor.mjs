import {spawnSync} from 'node:child_process';
import {IMAGE_VOLUME,IMAGE_PATH,imageMountArguments,assertImageMount,assertImageVolume} from './image-materialization-policy.mjs';
import {assertAttachmentCachePolicy} from './attachment-cache-policy.mjs';
import {WORKSPACE_VOLUME,workspaceVolumeArguments} from './workspace-volume-policy.mjs';
const name='uptokey-workbench-executor';
export const executorNetwork='uptokey-workbench-execution-lab';
const owner='io.uptokey.experiment=deepseek-workbench';
function commands(connection,env){
 const run=(args,input)=>{const r=spawnSync('podman',[...connection,...args],{env,input,encoding:'utf8',windowsHide:true});if(r.error||r.status!==0)throw Error(`Executor ${args[0]} failed: ${r.stderr?.slice(0,400)}`);return r.stdout.trim()};
 const exists=(kind,id)=>{const r=spawnSync('podman',[...connection,kind,'exists',id],{env,windowsHide:true});if(![0,1].includes(r.status))throw Error('Executor status unavailable');return r.status===0};
 const inspect=()=>{if(!exists('container',name))return null;const item=JSON.parse(run(['inspect',name]))[0];if(item.Config.Labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('Executor belongs to another owner');return item};
 return {run,exists,inspect};
}
export function inspectExecutor(connection,env){return commands(connection,env).inspect();}
export function runtimeImage(action,controller,requested){
 if(!['start','refresh'].includes(action))throw Error('runtime-action-invalid');
 if(action==='refresh'||!controller)return requested;
 if(controller.Config?.Labels?.['io.uptokey.experiment']!=='deepseek-workbench'||!/^(sha256:)?[a-f0-9]{64}$/.test(controller.Image??''))throw Error('runtime-image-invalid');
 // A build moves the development tag. Start must retain the running release.
 return controller.Image;
}
export function ensureExecutor(image,connection,env,{refresh=false,operations=commands(connection,env)}={}){
 const {run,exists,inspect}=operations;
 if(!exists('network',executorNetwork))run(['network','create','--label',owner,executorNetwork]);
 else if(JSON.parse(run(['network','inspect',executorNetwork]))[0].labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('Executor network belongs to another owner');
 let item=inspect();const imageId=JSON.parse(run(['image','inspect',image]))[0].Id.replace(/^sha256:/,'');
 let oldPolicy=false;if(item)try{assertImageMount(item,true);}catch{oldPolicy=true;}
 const changedImage=item&&item.Image.replace(/^sha256:/,'')!==imageId;
 if(changedImage&&!refresh)throw Error('Executor image differs from controller; explicit refresh required');
 if(item&&refresh&&(changedImage||oldPolicy)){if(item.State.Running)run(['stop','--time','10',name]);run(['rename',name,`${name}-previous-${Date.now()}`]);item=null;}
 if(item?.State.Running){assertImageMount(item,true);return false;}
 if(item){assertImageMount(item,true);run(['start',name]);return true;}
 run(['run','-d','--init','--name',name,'--label',owner,'--network',executorNetwork,'--network-alias','workbench-executor',
  '--user','0:0','--cap-drop=ALL','--cap-add=SETUID','--cap-add=SETGID','--cap-add=SYS_CHROOT','--cap-add=CHOWN',
  '--security-opt=no-new-privileges','--read-only','--memory=768m','--pids-limit=192','--cpus=2',
  '--tmpfs','/tmp:rw,nosuid,nodev,size=256m',
  ...imageMountArguments(true),
  '-v','uptokey-workbench-executor-home:/home/node',
  ...workspaceVolumeArguments(),
  '-v','uptokey-workbench-attachments:/home/node/.dsh/attachments:ro',
  '--entrypoint','node',image,'/opt/harness/execution/server.mjs']);return true;
}
/** Admission is read-only. Only the returned operation may recreate the absent executor. */
export function prepareExecutorRecovery(controller,connection,env,{operations=commands(connection,env)}={}){
 const {run,exists,inspect}=operations;
 if(controller?.Config?.Labels?.['io.uptokey.execution']!=='ssh-v1'||controller.Config.Labels['io.uptokey.experiment']!=='deepseek-workbench'||controller.Mounts?.some(m=>m.Type==='bind'))throw Error('runtime-recovery-controller-invalid');
 const image=runtimeImage('start',controller,null);
 assertAttachmentCachePolicy(controller);assertImageMount(controller);
 const durable=[['/home/node','uptokey-deepseek-workbench-home'],['/workspace',WORKSPACE_VOLUME],['/home/node/.dsh/attachments','uptokey-workbench-attachments'],[IMAGE_PATH,IMAGE_VOLUME]];
 for(const [destination,volume] of durable){
  const mounts=controller.Mounts.filter(m=>m.Destination===destination);
  if(mounts.length!==1||mounts[0].Type!=='volume'||mounts[0].Name!==volume||mounts[0].RW!==true)throw Error('runtime-recovery-volume-invalid');
 }
 if(inspect())throw Error('runtime-recovery-executor-present');
 // Missing durable state is not permission to silently create an empty replacement.
 for(const volume of [...durable.map(x=>x[1]),'uptokey-workbench-executor-home'])if(!exists('volume',volume))throw Error('runtime-recovery-volume-missing');
 assertImageVolume(JSON.parse(run(['volume','inspect',IMAGE_VOLUME]))[0]);
 if(!exists('network',executorNetwork)||JSON.parse(run(['network','inspect',executorNetwork]))[0].labels?.['io.uptokey.experiment']!=='deepseek-workbench')throw Error('runtime-recovery-network-invalid');
 if(!exists('image',image))throw Error('runtime-recovery-image-missing');
 return ()=>ensureExecutor(image,connection,env,{operations});
}
export function provisionExecutor(controller,connection,env,{operations=commands(connection,env)}={}){
 const {run,inspect}=operations;if(!inspect()?.State.Running)throw Error('Executor is unavailable');
 const setup='const fs=require("fs");const cp=require("child_process");const d="/home/node/.ssh";fs.mkdirSync(d,{recursive:true,mode:448});if(fs.lstatSync(d).isSymbolicLink())throw Error("Unsafe SSH directory");const k=d+"/executor";if(!fs.existsSync(k))cp.execFileSync("ssh-keygen",["-q","-t","ed25519","-N","","-f",k],{stdio:"ignore"});if(fs.lstatSync(k).isSymbolicLink()||(fs.statSync(k).mode&63))throw Error("Unsafe SSH key");console.log(fs.readFileSync(k+".pub","utf8"))';
 const pub=run(['exec',controller,'node','-e',setup]);
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(pub))throw Error('Invalid executor identity');
 run(['exec','--user','1000:1000','-i',name,'node','-e','let x="";process.stdin.on("data",d=>x+=d);process.stdin.on("end",()=>require("fs").writeFileSync("/home/node/.ssh/authorized_keys",x,{mode:384}))'],pub+'\n');
 const hostKey=run(['exec',name,'cat','/tmp/executor/host_ed25519.pub']);
 if(!/^ssh-ed25519 [A-Za-z0-9+/=]+(?: .*)?$/.test(hostKey))throw Error('Invalid executor host identity');
 const config='# Uptokey workbench executor\nHost workbench-executor\n HostName workbench-executor\n Port 43201\n User node\n IdentityFile /home/node/.ssh/executor\n IdentitiesOnly yes\n UserKnownHostsFile /home/node/.ssh/executor_known_hosts\n StrictHostKeyChecking yes\n';
 run(['exec','-i',controller,'node','-e','let x="";process.stdin.on("data",d=>x+=d);process.stdin.on("end",()=>{const fs=require("fs"),d=JSON.parse(x),p="/home/node/.ssh/config";if(fs.existsSync(p)&&!fs.readFileSync(p,"utf8").startsWith("# Uptokey workbench executor"))throw Error("Existing SSH config is not managed");for(const [n,v] of Object.entries(d))fs.writeFileSync("/home/node/.ssh/"+n,v,{mode:384});})'],JSON.stringify({config,executor_known_hosts:'[workbench-executor]:43201 '+hostKey+'\n'}));
 run(['exec',controller,'ssh','-o','BatchMode=yes','workbench-executor','/usr/local/bin/node --version']);
 run(['exec',controller,'node','-e','require("fs").writeFileSync("/tmp/uptokey-executor-ready","ready",{mode:384})']);
}
export function stopExecutor(connection,env){const {run,inspect}=commands(connection,env);if(inspect()?.State.Running)run(['stop','--time','10',name]);}
