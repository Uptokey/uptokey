import {spawn} from 'node:child_process';
import tar from 'tar-stream';
import {randomUUID,createHash} from 'node:crypto';
import path from 'node:path';
import {isSafeRelativePath} from '@uptokey/sync-contract/project-agent';

export interface ProjectRunnerOptions {podmanPath?:string;podmanConnection?:string;nodeImage?:string;pythonImage?:string}
export interface OciResult {stdout:Buffer;stderr:Buffer;exitCode:number;limited:boolean}
export type OciCommand=(args:readonly string[],options:{timeoutMs:number;outputLimitBytes:number;signal?:AbortSignal;stdin?:Buffer;onOutput?:(channel:'stdout'|'stderr',bytes:Buffer)=>void})=>Promise<OciResult>;
export class ProjectRuntimeError extends Error {readonly code:string;constructor(code:string){super(code);this.code=code;this.name='ProjectRuntimeError';}}
export function validateProjectRunnerOptions(options:ProjectRunnerOptions):ProjectRunnerOptions {
 if(options.podmanPath&&!path.isAbsolute(options.podmanPath))throw new ProjectRuntimeError('runtime_executable_must_be_absolute');
 if(options.podmanConnection&&!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/.test(options.podmanConnection))throw new ProjectRuntimeError('runtime_connection_invalid');
 for(const image of [options.nodeImage,options.pythonImage])if(image&&!/^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(image))throw new ProjectRuntimeError('runtime_image_digest_required');
 return {...options};
}
/** Only the trusted Podman CLI runs on the host. Generated code never reaches a host shell. */
export function podmanCommand(executable:string,connection?:string):OciCommand{validateProjectRunnerOptions({podmanConnection:connection});return (args,options)=>new Promise((resolve,reject)=>{
 if(options.signal?.aborted){reject(new ProjectRuntimeError('runtime_cancelled'));return;}
 const env:NodeJS.ProcessEnv={};for(const key of ['PATH','Path','SystemRoot','WINDIR','HOME','USERPROFILE','LOCALAPPDATA','APPDATA','XDG_RUNTIME_DIR'])if(process.env[key])env[key]=process.env[key];
 const child=spawn(executable,[...(connection?[`--connection=${connection}`]:[]),...args],{shell:false,windowsHide:true,env,stdio:['pipe','pipe','pipe']});
 const out:Buffer[]=[],err:Buffer[]=[];let size=0,limited=false,timedOut=false,cancelled=false;
 const consume=(chunks:Buffer[],channel:'stdout'|'stderr')=> (data:Buffer)=>{const remaining=Math.max(0,options.outputLimitBytes-size);size+=data.length;if(remaining){const bytes=data.subarray(0,remaining);chunks.push(bytes);options.onOutput?.(channel,bytes);}if(size>options.outputLimitBytes){limited=true;child.kill();}};
 child.stdout.on('data',consume(out,'stdout'));child.stderr.on('data',consume(err,'stderr'));
 const timeout=setTimeout(()=>{timedOut=true;child.kill();},options.timeoutMs);
 const abort=()=>{cancelled=true;child.kill();};options.signal?.addEventListener('abort',abort,{once:true});
 child.on('error',()=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);reject(new ProjectRuntimeError('runtime_unavailable'));});
 child.on('close',code=>{clearTimeout(timeout);options.signal?.removeEventListener('abort',abort);if(cancelled)reject(new ProjectRuntimeError('runtime_cancelled'));else if(timedOut)reject(new ProjectRuntimeError('runtime_timeout'));else resolve({stdout:Buffer.concat(out),stderr:Buffer.concat(err),exitCode:code??137,limited});});
 child.stdin.on('error',()=>{});child.stdin.end(options.stdin);
 });}
export async function projectArchive(files:readonly {path:string;bytes:Buffer}[],writable=false):Promise<Buffer>{
 const pack=tar.pack(),chunks:Buffer[]=[];const done=new Promise<Buffer>((resolve,reject)=>{pack.on('data',(chunk:Buffer)=>chunks.push(chunk));pack.on('end',()=>resolve(Buffer.concat(chunks)));pack.on('error',reject);});
 pack.entry({name:'workspace/',type:'directory',mode:0o755,uid:1000,gid:1000});
 const directories=new Set<string>();
 for(const file of files){
  if(!isSafeRelativePath(file.path))throw new ProjectRuntimeError('runtime_snapshot_path_invalid');
  const parts=file.path.split('/');for(let i=1;i<parts.length;i++){const directory=parts.slice(0,i).join('/');if(!directories.has(directory)){directories.add(directory);pack.entry({name:`workspace/${directory}/`,type:'directory',mode:0o755,uid:1000,gid:1000});}}
  pack.entry({name:`workspace/${file.path}`,type:'file',mode:writable?0o644:0o444,size:file.bytes.length,uid:1000,gid:1000},file.bytes);
 }
 pack.finalize();return done;
}
export class ProjectOciBackend {
 readonly config:ProjectRunnerOptions;readonly command:OciCommand;
 readonly namespace:string;readonly instance=randomUUID();
 private reconciled:boolean;private reconciling:Promise<void>|undefined;
 constructor(options:ProjectRunnerOptions={},command?:OciCommand,namespace?:string){this.config=validateProjectRunnerOptions(options);this.command=command??podmanCommand(options.podmanPath??'podman',options.podmanConnection);if(namespace!==undefined&&!/^[a-f0-9]{64}$/.test(namespace))throw new ProjectRuntimeError('runtime_namespace_invalid');this.namespace=namespace??createHash('sha256').update(randomUUID()).digest('hex');this.reconciled=namespace===undefined;}
 /** Called only after the canonical workspace process lock is held. Labels never contain paths or credentials. */
 async initialize():Promise<void>{
  if(this.reconciled||(!this.config.nodeImage&&!this.config.pythonImage))return;
  if(this.reconciling)return this.reconciling;
  this.reconciling=this.reconcileOrphans().then(()=>{this.reconciled=true;}).finally(()=>{this.reconciling=undefined;});return this.reconciling;
 }
 private async reconcileOrphans():Promise<void>{
  try{
   const listed=await this.command(['ps','--all','--no-trunc','--filter',`label=io.uptokey.owner=${this.namespace}`,'--filter','label=io.uptokey.runtime=project-oci-v1','--format','{{.ID}}'],{timeoutMs:10000,outputLimitBytes:16384});
   if(listed.exitCode||listed.limited)throw Error();
   const ids=listed.stdout.toString().trim().split(/\s+/).filter(Boolean);if(ids.length>128||ids.some(id=>!/^[a-f0-9]{64}$/.test(id)))throw Error();
   for(const id of new Set(ids)){
    const result=await this.command(['container','inspect',id],{timeoutMs:5000,outputLimitBytes:262144});if(result.exitCode||result.limited)throw Error();
    const entries=JSON.parse(result.stdout.toString());if(!Array.isArray(entries)||entries.length!==1)throw Error();
    const item=entries[0],labels=item.Config?.Labels;
    // Recheck the immutable ID and every ownership marker even when the list filter matched.
    if(item.Id!==id||!/^\/?uptokey-project-[a-f0-9-]{36}$/.test(item.Name??'')||labels?.['io.uptokey.owner']!==this.namespace||labels?.['io.uptokey.runtime']!=='project-oci-v1'||!/^[a-f0-9-]{36}$/.test(labels?.['io.uptokey.instance']??''))throw Error();
    if(labels['io.uptokey.instance']===this.instance)continue;
    const removed=await this.command(['rm','--force','--ignore','--time','0',id],{timeoutMs:10000,outputLimitBytes:4096});if(removed.exitCode||removed.limited)throw Error();
   }
  }catch{throw new ProjectRuntimeError('runtime_reconciliation_failed');}
 }
 async probe(image:string|undefined,signal?:AbortSignal):Promise<{available:boolean;diagnostic?:string;fingerprint:string}>{
  if(!image)return {available:false,diagnostic:'runtime_image_not_configured',fingerprint:'unconfigured'};
  try{signal?.throwIfAborted();await this.initialize();const info=await this.command(['info','--format','json'],{timeoutMs:5000,outputLimitBytes:256000,signal});if(info.exitCode||info.limited)throw Error();const data=JSON.parse(info.stdout.toString());if((data.host?.security?.rootless!==true&&process.env.UPTOKEY_RUNNER_ALLOW_ROOTFUL!=='1')||data.host?.cgroupVersion!=='v2')return {available:false,diagnostic:'runtime_rootless_cgroup_v2_required',fingerprint:image};
   const check=await this.command(['image','inspect',image],{timeoutMs:5000,outputLimitBytes:256000,signal});if(check.exitCode||check.limited)return {available:false,diagnostic:'runtime_image_missing',fingerprint:image};
   return {available:true,fingerprint:`podman:${String(data.version?.Version??data.version?.version??'unknown')};${image}`};
  }catch(error){return {available:false,diagnostic:error instanceof ProjectRuntimeError?error.code:'runtime_unavailable',fingerprint:image};}
 }
  async create(input:{image:string;executable:string;args:readonly string[];directory:string;archive:Buffer;timeoutMs:number;writable?: boolean;resources?:{cpus:number;memoryMiB:number;diskMiB:number};signal?:AbortSignal}):Promise<string>{
  if('networkPolicy' in input && input.networkPolicy!=='none')throw new ProjectRuntimeError('runtime_network_policy_unsupported');
  input.signal?.throwIfAborted();await this.initialize();
  const name=`uptokey-project-${randomUUID()}`;
  const resources=input.resources??{cpus:1,memoryMiB:256,diskMiB:128};
  if(!Number.isInteger(resources.memoryMiB)||resources.memoryMiB<64||resources.memoryMiB>2048||!Number.isInteger(resources.diskMiB)||resources.diskMiB<32||resources.diskMiB>512||!Number.isFinite(resources.cpus)||resources.cpus<0.25||resources.cpus>4||!Number.isInteger(resources.cpus*4))throw new ProjectRuntimeError('runtime_resources_invalid');
  const readOnlyArgs = input.writable ? ['--storage-opt',`size=${resources.diskMiB}M`] : ['--read-only', '--read-only-tmpfs=false'];
  const args=['create','--name',name,'--label',`io.uptokey.owner=${this.namespace}`,'--label','io.uptokey.runtime=project-oci-v1','--label',`io.uptokey.instance=${this.instance}`,'--pull=never','--network=none',...readOnlyArgs,'--tmpfs','/tmp:rw,noexec,nosuid,nodev,size=32m,mode=1777','--tmpfs','/run:rw,noexec,nosuid,nodev,size=8m,mode=755',
   '--cap-drop=ALL','--security-opt=no-new-privileges','--user=1000:1000','--userns=auto','--pids-limit=64',`--memory=${resources.memoryMiB}m`,`--memory-swap=${resources.memoryMiB}m`,`--cpus=${resources.cpus}`,'--ulimit=nofile=128:128',
   '--image-volume=ignore','--http-proxy=false','--unsetenv-all','--env','PATH=/usr/local/bin:/usr/bin:/bin','--env','HOME=/tmp','--env','PORT=3000','--env','PYTHONDONTWRITEBYTECODE=1',
   '--no-hosts','--log-driver=none','--restart=no','--timeout',String(Math.max(1,Math.ceil(input.timeoutMs/1000))),'--workdir',`/workspace${input.directory==='.'||!input.directory?'':`/${input.directory}`}`,'--entrypoint',input.executable,input.image,...input.args];
  try{input.signal?.throwIfAborted();const created=await this.command(args,{timeoutMs:10000,outputLimitBytes:4096,signal:input.signal});if(created.exitCode||created.limited)throw new ProjectRuntimeError(input.writable&&/quota|storage.opt|backing.*file.?system|xfs/i.test(created.stderr.toString())?'runtime_writable_quota_unavailable':'runtime_create_failed');
   const copied=await this.command(['cp','-',`${name}:/`],{stdin:input.archive,timeoutMs:10000,outputLimitBytes:4096,signal:input.signal});if(copied.exitCode||copied.limited)throw new ProjectRuntimeError('runtime_snapshot_failed');return name;
  }catch(error){await this.stop(name);throw error;}
 }
 /** Podman cp supports stopped containers. Parse in memory; never extract an untrusted TAR onto the host. */
 async extractFiles(name:string,paths:readonly string[],signal?:AbortSignal):Promise<Map<string,Buffer>>{
  if(!/^uptokey-project-[a-f0-9-]{36}$/.test(name))throw new ProjectRuntimeError('runtime_job_invalid');
  if(paths.length>32||paths.some(p=>!isSafeRelativePath(p)))throw new ProjectRuntimeError('runtime_output_path_invalid');
  if(!paths.length)return new Map();
  const result=await this.command(['cp',`${name}:/workspace`,'-'],{timeoutMs:10000,outputLimitBytes:32*1024*1024,signal});
  if(result.limited)throw new ProjectRuntimeError('runtime_output_archive_limit');
  if(result.exitCode)throw new ProjectRuntimeError('runtime_output_copy_failed');
  const extract=tar.extract(),found=new Map<string,Buffer>(),seen=new Set<string>();let count=0,total=0;
  await new Promise<void>((resolve,reject)=>{
   extract.on('error',()=>reject(new ProjectRuntimeError('runtime_output_archive_invalid')));
   extract.on('finish',resolve);
   extract.on('entry',(header,stream,next)=>{
    const fail=()=>{stream.resume();extract.destroy(new ProjectRuntimeError('runtime_output_archive_invalid'));};
    if(signal?.aborted){fail();return;}
    const name=header.name.replace(/\/$/,'');
    if(++count>10000||!isSafeRelativePath(name)||!(name==='workspace'||name.startsWith('workspace/'))||seen.has(name)){fail();return;}seen.add(name);
    const relative=name.slice('workspace/'.length),selected=paths.includes(relative),ancestor=paths.some(p=>p.startsWith(`${relative}/`));
    if((selected&&(header.type!=='file'||header.linkname||!Number.isSafeInteger(header.size)||header.size!>1048576))||((name==='workspace'||ancestor)&&header.type!=='directory')){fail();return;}
    const chunks:Buffer[]=[];let size=0;
    stream.on('data',(chunk:Buffer)=>{if(selected){size+=chunk.length;total+=chunk.length;if(size>1048576||total>4*1048576)fail();else chunks.push(chunk);}});
    stream.on('end',()=>{if(selected){if(size!==header.size){fail();return;}found.set(relative,Buffer.concat(chunks));}next();});stream.on('error',fail);stream.resume();
   });
   extract.end(result.stdout);
  });
  signal?.throwIfAborted();
  if(paths.some(p=>!found.has(p)))throw new ProjectRuntimeError('runtime_output_missing');
  return found;
 }
 async stop(name:string):Promise<void>{if(!/^uptokey-project-[a-f0-9-]{36}$/.test(name))throw new ProjectRuntimeError('runtime_job_invalid');const result=await this.command(['rm','--force','--ignore','--time','0',name],{timeoutMs:10000,outputLimitBytes:4096});if(result.exitCode||result.limited)throw new ProjectRuntimeError('runtime_cleanup_failed');}
 async run(name:string,timeoutMs:number,outputLimitBytes:number,signal?:AbortSignal,afterExit?:(result:OciResult)=>Promise<void>,onOutput?:(channel:'stdout'|'stderr',bytes:Buffer)=>void):Promise<OciResult>{
  try{const result=await this.command(['start','--attach',name],{timeoutMs,outputLimitBytes,signal,onOutput});signal?.throwIfAborted();await afterExit?.(result);return result;}finally{await this.stop(name);}
 }
}
