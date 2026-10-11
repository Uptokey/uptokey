import fs from 'node:fs';
import { createHash } from 'node:crypto';
import {StringDecoder} from 'node:string_decoder';
import {parseProjectRunRequest,parseProjectFileManifest,parseProjectVerificationReport,type ProjectFileManifest,type ProjectRunRequest,type ProjectVerificationReport,type ProjectCheckResult} from '@uptokey/sync-contract/project-agent';
import { ProjectRootService,isProtectedProjectPath } from './project-root-service.ts';
import {ProjectOciBackend,ProjectRuntimeError,projectArchive,type ProjectRunnerOptions,type OciCommand} from './project-oci.ts';
import {ARTIFACT_CODE_ACTIONS,ARTIFACT_CODE_SUPERVISOR,isArtifactCodeAction,artifactCodeFiles,artifactCodeResult,type ArtifactCodeInput} from './project-artifact-verification.ts';
import {fetchProjectDependencies} from './project-runner-dependencies.ts';
export type {ProjectRunnerOptions} from './project-oci.ts';

export interface RuntimeProfileInfo {
  readonly id: string;
  readonly name: string;
  readonly runtime: string;
  readonly available: boolean;
  readonly isolation: 'oci_container' | 'static_checker';
  readonly diagnostic?: string;
  readonly defaultActions: readonly string[];
}

const profiles={
 'node-app':{executable:'/usr/local/bin/node',actions:{test:['--test','--test-reporter=tap'],run:['src/index.js'],preview:['src/index.js'],exec:[]}},
 'python-app':{executable:'/usr/local/bin/python',actions:{test:['-B','-s','-m','unittest','discover','-s','tests'],run:['-B','-s','main.py'],preview:['-B','-s','main.py'],exec:[]}}
} as const;
export interface ProjectRunnerInput {runId:string;rootBindingId:string;request:ProjectRunRequest;manifest?:ProjectFileManifest;criteriaIds?:readonly string[];signal?:AbortSignal;artifact?:ArtifactCodeInput;runtimeFingerprint?:string;assertAuthority?:()=>void|Promise<void>;collectOutput?:(path:string,bytes:Buffer)=>string}
export interface ProjectOutputEvent {sequence:number;channel:'stdout'|'stderr';text:string}
/** Governed adapter only. W5 owns approval, journal, recovery and result artifacts. */
export class ProjectRunnerService {
  private readonly rootService: ProjectRootService;
  readonly backend:ProjectOciBackend;
  private readonly outputs=new Map<string,{events:ProjectOutputEvent[];cursor:number;bytes:number;stdout:StringDecoder;stderr:StringDecoder}>();
  constructor(rootService: ProjectRootService,options:ProjectRunnerOptions={},command?:OciCommand,namespace?:string) {this.rootService=rootService;this.backend=new ProjectOciBackend(options,command,namespace);}
  async initialize():Promise<void>{await this.backend.initialize();}
  deleteOutput(runId: string, rootBindingId?: string) {
    if (rootBindingId) this.rootService.getVerifiedRoot(rootBindingId);
    this.outputs.delete(runId);
  }
  /** Ephemeral progress only. Authority is checked by the runtime for every read, never by runId alone. */
  readOutput(runId:string,rootBindingId:string,after=0,limit=500):{events:ProjectOutputEvent[];cursor:number;dropped:boolean;done:boolean}|null{
    this.rootService.getVerifiedRoot(rootBindingId);
    if(!Number.isSafeInteger(after)||after<0)throw new ProjectRuntimeError('runtime_output_cursor_invalid');
    const state=this.outputs.get(runId);if(!state)return null;
    if(after>state.cursor)throw new ProjectRuntimeError('runtime_output_cursor_invalid');
    const events=state.events.filter(event=>event.sequence>after).slice(0,limit);
    return {events:events.map(event=>({...event})),cursor:events.length?events[events.length-1]!.sequence:state.cursor,dropped:after<(state.events[0]?.sequence??1)-1,done:false};
  }
  initRunOutput(runId:string){
    if(this.outputs.size>=64){
      const oldest=this.outputs.keys().next().value;
      if(oldest)this.outputs.delete(oldest);
    }
    this.outputs.set(runId,{events:[],cursor:0,bytes:0,stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')});
  }
  pushRunOutput(runId:string,channel:'stdout'|'stderr',bytes:Buffer){
    this.pushOutput(runId,channel,bytes);
  }
  private pushOutput(runId:string,channel:'stdout'|'stderr',bytes:Buffer){
    const state=this.outputs.get(runId);if(!state)return;
    const text=state[channel].write(bytes);
    for(let offset=0;offset<text.length;){let end=Math.min(text.length,offset+2048);if(end<text.length&&/[\uD800-\uDBFF]/.test(text[end-1]!))end--;
      const chunk=text.slice(offset,end);offset=end;state.events.push({sequence:++state.cursor,channel,text:chunk});state.bytes+=Buffer.byteLength(chunk);
      while(state.events.length>128||state.bytes>65536)state.bytes-=Buffer.byteLength(state.events.shift()!.text);
    }
  }

  async getAvailableProfiles(): Promise<RuntimeProfileInfo[]> {
    const dynamic=await Promise.all((['node-app','python-app'] as const).map(async id=>{const probe=await this.backend.probe(this.image(id));return {id,name:id,runtime:probe.fingerprint,available:probe.available,isolation:'oci_container' as const,diagnostic:probe.diagnostic,defaultActions:['test','run','preview','exec',...(id==='node-app'?ARTIFACT_CODE_ACTIONS:[])]};}));
    return [
      {id:'static-web',name:'Static file inspection',runtime:'static-file-inspection:v1',available:true,isolation:'static_checker',defaultActions:['check_html','check_assets']},
      ...dynamic
    ];
  }
  private image(id:string){return id==='node-app'?this.backend.config.nodeImage:id==='python-app'?this.backend.config.pythonImage:undefined;}
  /** Snapshot is the exact public manifest approved by the person, with bytes rechecked before dispatch. */
  async prepare(input:ProjectRunnerInput){
    const request=parseProjectRunRequest(input.request),root=this.rootService.getVerifiedRoot(input.rootBindingId);
    if(request.execution?.outputPaths.some(p=>isProtectedProjectPath(p)||p.startsWith('.uptokey-dependencies/')))throw new ProjectRuntimeError('runtime_output_path_protected');
    const artifactAction=isArtifactCodeAction(request.actionId);
    if(request.timeoutMs>300000||request.outputLimitBytes>1048576||(!artifactAction&&request.artifactInputRefs.length))throw new ProjectRuntimeError('runtime_limits_invalid');
    if(artifactAction&&(request.runtimeProfileId!=='node-app'||request.artifactInputRefs.length!==1||request.artifactInputRefs[0]!==input.artifact?.id))throw new ProjectRuntimeError('runtime_artifact_input_invalid');
    const profile=profiles[request.runtimeProfileId as keyof typeof profiles];
    let executable:string|undefined=profile?.executable;
    let action:readonly string[]|undefined=profile?.actions[request.actionId as 'run'|'test'|'preview'];
    if(request.actionId==='exec'){
      // argv is sealed in the W5 plan by parseProjectRunRequest. It runs only
      // as the container entrypoint, with the existing network/resource policy.
      executable=request.argv![0];
      if(!executable||executable.startsWith('-'))throw new ProjectRuntimeError('runtime_executable_invalid');
      action=request.argv!.slice(1);
    }
    if(artifactAction)action=[];
    if(!profile||!action||!executable)throw new ProjectRuntimeError('runtime_action_unavailable');
    if(!input.manifest)throw new ProjectRuntimeError('runtime_manifest_required');
    const manifest=parseProjectFileManifest(input.manifest);
    if(manifest.rootBindingId!==input.rootBindingId||manifest.projectId!==root.binding.projectId||manifest.snapshotDigest!==request.manifestDigest||createHash('sha256').update(JSON.stringify(manifest.entries.map(e=>({p:e.relativePath,h:e.sha256})))).digest('hex')!==manifest.snapshotDigest)throw new ProjectRuntimeError('runtime_manifest_conflict');
    if(manifest.entries.length>1000)throw new ProjectRuntimeError('runtime_snapshot_limit');
    const files:{path:string;bytes:Buffer}[]=[];let total=0;
    for(const entry of manifest.entries){input.signal?.throwIfAborted();if(entry.kind!=='file')continue;
      if(entry.sensitivity!=='public'||isProtectedProjectPath(entry.relativePath)||entry.relativePath.split('/').some(p=>['node_modules','dist','__pycache__'].includes(p)))continue;
      if(entry.byteLength>5*1024*1024||(total+=entry.byteLength)>10*1024*1024)throw new ProjectRuntimeError('runtime_snapshot_limit');
      const absolute=this.rootService.resolveVerifiedPath(input.rootBindingId,entry.relativePath);
      const fd=fs.openSync(absolute,fs.constants.O_RDONLY|(fs.constants.O_NOFOLLOW??0));let bytes:Buffer;
      try{const stat=fs.fstatSync(fd);if(!stat.isFile()||stat.nlink!==1||stat.size!==entry.byteLength)throw new ProjectRuntimeError('runtime_manifest_conflict');bytes=fs.readFileSync(fd);}finally{fs.closeSync(fd);}
      if(createHash('sha256').update(bytes).digest('hex')!==entry.sha256)throw new ProjectRuntimeError('runtime_manifest_conflict');
      files.push({path:entry.relativePath,bytes});
    }
    if(artifactAction){
      const added=artifactCodeFiles(input.artifact!,request.relativeWorkingDirectory);
      const supervisor={path:'uptokey-verification-supervisor.cjs',bytes:Buffer.from(ARTIFACT_CODE_SUPERVISOR)};
      if([...added,supervisor].some(file=>files.some(existing=>existing.path===file.path)))throw new ProjectRuntimeError('runtime_artifact_path_conflict');
      files.push(...added,supervisor);
      action=[`/workspace/${supervisor.path}`,request.actionId,JSON.stringify(added.map(file=>`/workspace/${file.path}`))];
    }
    if(!files.length&&!request.execution)throw new ProjectRuntimeError('runtime_snapshot_empty');
    this.rootService.getVerifiedRoot(input.rootBindingId);
    const image=this.image(request.runtimeProfileId),probe=await this.backend.probe(image,input.signal);if(!probe.available||!image)throw new ProjectRuntimeError(probe.diagnostic??'runtime_unavailable');
    if(input.runtimeFingerprint&&probe.fingerprint!==input.runtimeFingerprint)throw new ProjectRuntimeError('runtime_profile_changed');
    const dependencies=await fetchProjectDependencies(request.execution?.dependencies,input.signal,async()=>{this.rootService.getVerifiedRoot(input.rootBindingId);await input.assertAuthority?.();});
    if(files.some(file=>file.path.startsWith('.uptokey-dependencies/')))throw new ProjectRuntimeError('runtime_dependency_path_conflict');
    // Nothing observed before an await grants authority afterward.
    this.rootService.getVerifiedRoot(input.rootBindingId);await input.assertAuthority?.();input.signal?.throwIfAborted();
    return {request,profile,executable,action,image,fingerprint:probe.fingerprint,archive:await projectArchive([...files,...dependencies],request.execution?.writable)};
  }
  async startPreview(input:ProjectRunnerInput):Promise<{jobId:string;fetch:(pathname:string)=>Promise<{status:number;contentType:string;bytes:Buffer}>;stop:()=>Promise<void>}>{
    const prepared=await this.prepare(input);if(prepared.request.actionId!=='preview')throw new ProjectRuntimeError('runtime_preview_action_required');
    this.rootService.getVerifiedRoot(input.rootBindingId);input.signal?.throwIfAborted();
    const jobId=await this.backend.create({image:prepared.image,executable:prepared.executable,args:prepared.action,directory:prepared.request.relativeWorkingDirectory,archive:prepared.archive,timeoutMs:prepared.request.timeoutMs,signal:input.signal});
    try{const start=await this.backend.command(['start',jobId],{timeoutMs:10000,outputLimitBytes:4096,signal:input.signal});if(start.exitCode)throw new ProjectRuntimeError('runtime_start_failed');}catch(error){await this.backend.stop(jobId);throw error;}
    let stopped=false;const stop=async()=>{if(stopped)return;await this.backend.stop(jobId);stopped=true;};
    return {jobId,stop,fetch:async pathname=>{
      if(stopped||input.signal?.aborted)throw new ProjectRuntimeError('runtime_cancelled');this.rootService.getVerifiedRoot(input.rootBindingId);
      if(!pathname.startsWith('/')||pathname.startsWith('//')||pathname.includes('\\')||pathname.length>4096)throw new ProjectRuntimeError('runtime_preview_path_invalid');
      // These adapters only contact container loopback. No port publication, host network or URL supplied by generated code.
      const node="const http=require('node:http');const q=http.get({host:'127.0.0.1',port:3000,path:process.argv[1],timeout:3000},r=>{let n=0,c=[];r.on('data',b=>{n+=b.length;if(n>1048576){r.destroy();process.exitCode=2}else c.push(b)});r.on('end',()=>console.log(JSON.stringify({status:r.statusCode,contentType:r.headers['content-type']||'application/octet-stream',body:Buffer.concat(c).toString('base64')}))});q.on('timeout',()=>q.destroy());q.on('error',()=>{process.exitCode=1});";
      const python="import sys,http.client,json,base64\nc=http.client.HTTPConnection('127.0.0.1',3000,timeout=3)\nc.request('GET',sys.argv[1])\nr=c.getresponse()\nb=r.read(1048577)\nif len(b)>1048576: sys.exit(2)\nprint(json.dumps(dict(status=r.status,contentType=r.getheader('Content-Type','application/octet-stream'),body=base64.b64encode(b).decode())))";
      const argv=prepared.request.runtimeProfileId==='node-app'?['-e',node,pathname]:['-I','-B','-c',python,pathname];
      const reply=await this.backend.command(['exec',jobId,prepared.profile.executable,...argv],{timeoutMs:5000,outputLimitBytes:1500000,signal:input.signal});
      if(reply.exitCode||reply.limited)throw new ProjectRuntimeError('runtime_preview_unavailable');
      let raw:any;try{raw=JSON.parse(reply.stdout.toString());}catch{throw new ProjectRuntimeError('runtime_preview_response_invalid');}
      if(!Number.isInteger(raw.status)||raw.status<100||raw.status>599||typeof raw.contentType!=='string'||raw.contentType.length>128||/[\r\n]/.test(raw.contentType)||typeof raw.body!=='string'||!/^[A-Za-z0-9+/]*={0,2}$/.test(raw.body))throw new ProjectRuntimeError('runtime_preview_response_invalid');
      const bytes=Buffer.from(raw.body,'base64');if(bytes.length>1048576)throw new ProjectRuntimeError('runtime_output_limit');return {status:raw.status,contentType:raw.contentType,bytes};
    }};
  }

  async runVerification(params:ProjectRunnerInput): Promise<ProjectVerificationReport> {
    if(this.outputs.size>=64){
      const oldest=this.outputs.keys().next().value;
      if(oldest)this.outputs.delete(oldest);
    }
    this.outputs.set(params.runId,{events:[],cursor:0,bytes:0,stdout:new StringDecoder('utf8'),stderr:new StringDecoder('utf8')});
    try {
      return await this.performVerification(params);
    } finally {
      // Output is a bounded progress stream, not durable run history.  Final
      // results live in the journal/artifact receipt; remove the transient
      // buffer as soon as the run settles so stale output cannot be read by a
      // later request using the same run id.
      this.outputs.delete(params.runId);
    }
  }
  private async performVerification(params:ProjectRunnerInput): Promise<ProjectVerificationReport> {
    this.rootService.getVerifiedRoot(params.rootBindingId);
    const {request}=params;
    const checks:ProjectCheckResult[]=[];
    if(request.runtimeProfileId==='static-web') {
      for(const [id,relativePath] of [['readme','docs/README.md'],['index','web/index.html']]) {
        const filename=this.rootService.resolveVerifiedPath(params.rootBindingId,relativePath!);
        const stat=fs.existsSync(filename)?fs.lstatSync(filename):undefined;
        const bounded=Boolean(stat?.isFile()&&stat.size>0&&stat.size<=Math.min(request.outputLimitBytes,1024*1024));
        const bytes=bounded?fs.readFileSync(filename):undefined;
        checks.push({id:`AC-19-04-${id}`,method:'bounded_nonempty_file_inspection',expected:`${relativePath}: regular non-empty file within size limit`,
          observed:bytes?`${bytes.length} bytes; sha256=${createHash('sha256').update(bytes).digest('hex')}`:'Missing, empty, non-regular or oversized file',
          artifactRefs:[],status:bytes?'pass':'fail'});
      }
    } else {let fingerprint='runtime:unavailable';
      try{const prepared=await this.prepare(params);fingerprint=prepared.fingerprint;if(request.actionId==='preview')throw new ProjectRuntimeError('runtime_preview_requires_session');
        params.signal?.throwIfAborted();this.rootService.getVerifiedRoot(params.rootBindingId);
        const start=Date.now(),name=await this.backend.create({image:prepared.image,executable:prepared.executable,args:prepared.action,directory:request.relativeWorkingDirectory,archive:prepared.archive,timeoutMs:request.timeoutMs,writable:request.execution?.writable,resources:request.execution?.resources,signal:params.signal});
        const outputRefs:string[]=[];
        const result=await this.backend.run(name,Math.max(1,request.timeoutMs-(Date.now()-start)),request.outputLimitBytes,params.signal,request.execution?async()=>{
          await params.assertAuthority?.();params.signal?.throwIfAborted();
          const outputs=await this.backend.extractFiles(name,request.execution!.outputPaths,params.signal);
          await params.assertAuthority?.();params.signal?.throwIfAborted();
          if(outputs.size&&!params.collectOutput)throw new ProjectRuntimeError('runtime_output_collector_required');
          for(const [path,bytes] of outputs)outputRefs.push(params.collectOutput!(path,bytes));
        }:undefined,(channel,bytes)=>this.pushOutput(params.runId,channel,bytes));
        if(isArtifactCodeAction(request.actionId)){
          checks.push(artifactCodeResult(request.actionId,params.artifact!,result));
          return parseProjectVerificationReport({taskId:request.taskId,runId:params.runId,manifestDigest:request.manifestDigest,runtimeFingerprint:fingerprint,checks});
        }
        const output=Buffer.concat([result.stdout,result.stderr]).toString('utf8');
        const testCount=request.runtimeProfileId==='node-app'?Number(output.match(/^# tests (\d+)$/m)?.[1]??0):Number(output.match(/Ran (\d+) tests? in /)?.[1]??0);
        checks.push({id:'runtime-process',method:'isolated_process_exit',command:[prepared.executable,...prepared.action].join(' '),exitCode:result.exitCode,expected:request.actionId==='test'?'Exit 0, at least one discovered test, bounded output':'Exit 0; does not assert application correctness',observed:JSON.stringify({job:name,elapsedMs:Date.now()-start,output,outputLimited:result.limited,workspace:request.execution?'disposable_writable':'read_only',network:'none'}),artifactRefs:outputRefs,status:result.exitCode!==0||result.limited?'fail':request.actionId==='test'&&testCount===0?'blocked':'pass'});
      }catch(error){if(error instanceof ProjectRuntimeError&&error.code==='runtime_cleanup_failed')throw error;
        const code=error instanceof ProjectRuntimeError?error.code:params.signal?.aborted?'runtime_cancelled':'runtime_execution_failed';
        checks.push(isArtifactCodeAction(request.actionId)&&params.artifact?{id:request.actionId,method:'isolated_artifact_code_v1',expected:'Configured OCI runtime, approved artifact and immutable project snapshot',observed:JSON.stringify({artifactId:params.artifact.id,sha256:params.artifact.sha256,action:request.actionId,code}),artifactRefs:[params.artifact.id],status:'blocked'}:{id:'runtime-process',method:'isolated_process_execution',expected:'Configured rootless OCI runtime and approved immutable snapshot',observed:code,artifactRefs:[],status:'blocked'});}
      return parseProjectVerificationReport({taskId:request.taskId,runId:params.runId,manifestDigest:request.manifestDigest,runtimeFingerprint:fingerprint,checks});
    }
    return parseProjectVerificationReport({taskId:request.taskId,runId:params.runId,manifestDigest:request.manifestDigest,
      runtimeFingerprint:'static-file-inspection:v1',checks});
  }
}
