import {randomUUID,createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {parseVideoRequest,parseVideoWireRequest,canonicalVideoPayload,canonicalVideoWirePayload,videoProviderBody,parseVideoStatus,parseVideoJob,canonicalVideoJob,videoJobUrl,detectVideoMediaType,type VideoRequest,type VideoWireRequest,type VideoStatus,type VideoJob} from '@uptokey/sync-contract/video';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {WORKFLOW_LIMITS} from '@uptokey/sync-contract/workflow';
import type {EffectRequest} from './workspace/executor.ts';
import type {WorkspaceStore} from './workspace/store.ts';
export interface WorkspaceVideo {readonly model:string;readonly available?:boolean;readonly supportedOperations?:readonly string[];prepare(request:VideoRequest,signal:AbortSignal):Promise<VideoWireRequest>;create(request:VideoRequest,wire:VideoWireRequest,effect:EffectRequest):Promise<VideoStatus>;poll(job:VideoJob,effect:EffectRequest):Promise<VideoStatus>;content(job:VideoJob,effect:EffectRequest):Promise<Uint8Array>;}
export class VideoError extends Error {readonly outcome:'not_sent'|'unknown';constructor(outcome:'not_sent'|'unknown',reason='video_operation_failed'){super(reason);this.outcome=outcome;}}
export interface VideoOptions {child:ChildProcess;model:string;provider:string;providerUrl:string;imageOrigins?:readonly string[];driverRevision:string;store:Pick<WorkspaceStore,'readRun'|'readTextArtifact'>;resolveCredential():Promise<string>;fetchImpl?:import('./fetch-types.ts').FetchTransport;}
interface PreparedHttp {method:'POST'|'GET';url:string;headers:Record<string,string>;body?:string;}
const digest=(v:string)=>createHash('sha256').update(v).digest('hex');
export class IpcWorkspaceVideo implements WorkspaceVideo {
 readonly model:string;get supportedOperations(){return this.options.imageOrigins?.length?['text_to_video','image_to_video']:['text_to_video'];}private lifetime=new AbortController();private busy=false;private consumed=new Set<string>();private options:VideoOptions;
 constructor(options:VideoOptions){this.options={...options};this.model=options.model;}
 get available(){return this.options.child.connected&&!this.lifetime.signal.aborted;}
 dispose(){this.lifetime.abort();}
 async close(){this.dispose();}
 private wire(value:unknown,request:VideoRequest){const wire=parseVideoWireRequest(value,request);if(wire.model!==this.model||wire.url!==this.options.providerUrl||wire.provider!==this.options.provider||wire.driverRevision!==this.options.driverRevision||request.firstFrameUrl&&!this.options.imageOrigins?.includes(new URL(request.firstFrameUrl).origin))throw new VideoError('not_sent');return wire;}
 private prepareHttp(input:Record<string,unknown>,signal:AbortSignal):Promise<PreparedHttp>{
  const child=this.options.child,id=randomUUID();signal.throwIfAborted();
  return new Promise((resolve,reject)=>{const cleanup=()=>{child.off('message',message);child.off('error',fail);child.off('exit',fail);child.off('disconnect',fail);signal.removeEventListener('abort',fail);};const fail=()=>{cleanup();reject(new VideoError('not_sent'));};
   const message=(value:any)=>{if(value?.type!=='video-prepared'||value.id!==id)return;try{signal.throwIfAborted();if(value.error||!value.request)throw Error();const r=value.request;
    const expected=input.operation==='create'?this.options.providerUrl:videoJobUrl(this.options.providerUrl,String(input.jobId),input.operation as 'poll'|'content');
    const expectedHeaders:Record<string,string>=input.operation==='create'?{accept:'application/json','content-type':'application/json'}:{accept:input.operation==='content'?'video/mp4':'application/json'};
    if(r.url!==expected||r.method!==(input.operation==='create'?'POST':'GET')||r.body!==input.rawBody||!r.headers||Object.keys(r.headers).length!==Object.keys(expectedHeaders).length)throw Error();
    const headers=Object.fromEntries(Object.entries(r.headers).map(([k,v])=>[k.toLowerCase(),v]));if(canonicalJson(headers)!==canonicalJson(expectedHeaders))throw Error();
    cleanup();resolve({url:r.url,method:r.method,headers:expectedHeaders,...(r.body===undefined?{}:{body:r.body})});}catch{fail();}};
   child.on('message',message);child.on('error',fail);child.on('exit',fail);child.on('disconnect',fail);signal.addEventListener('abort',fail,{once:true});try{child.send({type:'video-prepare',id,input},error=>{if(error)fail();});}catch{fail();}
  });
 }
 async prepare(input:VideoRequest,signal:AbortSignal):Promise<VideoWireRequest>{
  if(this.busy||!this.available)throw new VideoError('not_sent');const request=parseVideoRequest(input);if(request.model!==this.model||request.firstFrameUrl&&!this.options.imageOrigins?.includes(new URL(request.firstFrameUrl).origin))throw new VideoError('not_sent');this.busy=true;
  try{const current=AbortSignal.any([signal,this.lifetime.signal,AbortSignal.timeout(10000)]),r=await this.prepareHttp({endpoint:this.options.providerUrl,operation:'create',rawBody:canonicalJson(videoProviderBody(request))},current);
   return this.wire({schemaVersion:1,driver:'9router',driverRevision:this.options.driverRevision,provider:this.options.provider,model:request.model,url:r.url,method:r.method,headers:r.headers,body:r.body},request);
  }finally{this.busy=false;}
 }
 create(request:VideoRequest,wire:VideoWireRequest,effect:EffectRequest):Promise<VideoStatus>{return this.operation('create',effect,request,wire) as Promise<VideoStatus>;}
 poll(job:VideoJob,effect:EffectRequest):Promise<VideoStatus>{return this.operation('poll',effect,undefined,undefined,job) as Promise<VideoStatus>;}
 content(job:VideoJob,effect:EffectRequest):Promise<Uint8Array>{return this.operation('content',effect,undefined,undefined,job) as Promise<Uint8Array>;}
 private async operation(kind:'create'|'poll'|'content',effectInput:EffectRequest,input?:VideoRequest,wireInput?:VideoWireRequest,jobInput?:VideoJob):Promise<VideoStatus|Uint8Array>{
  if(this.busy||!this.available)throw new VideoError('not_sent');let sent=false;this.busy=true;const operation=new AbortController();
  try{
   const effect={...effectInput,arguments:structuredClone(effectInput.arguments),capability:structuredClone(effectInput.capability),limits:{...effectInput.limits}};
   const timeout=Math.min(Date.parse(effect.deadlineAt)-Date.now(),effect.limits.timeoutMs);
   if(!Number.isSafeInteger(effect.limits.timeoutMs)||!Number.isSafeInteger(effect.limits.maxOutputBytes)||effect.limits.maxOutputBytes<1||!Number.isFinite(timeout)||timeout<1||effect.capability.dataDestination.kind!=='provider')throw Error();
   if(kind==='create'?(effect.capability.effect!=='inference'||effect.capability.retryClass!=='never_automatic'):(effect.capability.effect!=='read_external'||effect.capability.retryClass!=='read_only'))throw Error();
   const current=AbortSignal.any([effect.signal,this.lifetime.signal,operation.signal,AbortSignal.timeout(Math.ceil(timeout))]);current.throwIfAborted();
   const a=effect.arguments.request,b=effect.arguments.wire;if(a?.kind!=='literal'||b?.kind!=='literal')throw Error();
   const request=parseVideoRequest(a.value),wire=this.wire(b.value,request);
   if(kind==='create'&&(canonicalVideoPayload(input)!==canonicalVideoPayload(request)||canonicalVideoWirePayload(wireInput,request)!==canonicalVideoWirePayload(wire,request)))throw Error();
   let job:VideoJob|undefined;
   if(kind!=='create'){
    job=parseVideoJob(jobInput);if(job.model!==this.model||job.provider!==this.options.provider||job.endpoint!==this.options.providerUrl||job.requestDigest!==digest(canonicalVideoPayload(request))||job.wireDigest!==digest(canonicalVideoWirePayload(wire,request))||kind==='content'&&job.status!=='completed')throw Error();
    const binding=effect.arguments.job;let ref:string|undefined;
    if(binding?.kind==='step_output'&&binding.artifactRefs.length===1)ref=binding.artifactRefs[0];
    if(binding?.kind==='literal'&&typeof binding.value==='object'&&binding.value!==null&&!Array.isArray(binding.value)&&Object.keys(binding.value).join(',')==='artifactId'&&typeof binding.value.artifactId==='string')ref=binding.value.artifactId;
    if(!ref)throw Error();const stored=JSON.parse(await this.options.store.readTextArtifact(effect.principalId,effect.projectId,ref));if(canonicalVideoJob(stored)!==canonicalVideoJob(job))throw Error();current.throwIfAborted();
   }
   const r=kind==='create'?{url:wire.url,method:'POST' as const,headers:{...wire.headers},body:wire.body}:await this.prepareHttp({endpoint:this.options.providerUrl,operation:kind,jobId:job!.jobId},current);
   const key=JSON.stringify([effect.principalId,effect.projectId,effect.runId,effect.attemptId]);
   const admit=async()=>{current.throwIfAborted();if(this.consumed.has(key))throw Error();const record=await this.options.store.readRun(effect.principalId,effect.projectId,effect.runId);current.throwIfAborted();const receipts=record?.receipts.filter(item=>item.attemptId===effect.attemptId),receipt=receipts?.[0];if(!record||record.run.status!=='running'||record.run.id!==effect.runId||record.run.projectId!==effect.projectId||record.run.principalId!==effect.principalId||receipts?.length!==1||receipt?.status!=='dispatched'||receipt.stepId!==effect.stepId||receipt.runId!==effect.runId||receipt.projectId!==effect.projectId||receipt.capabilityId!==effect.capability.id||receipt.capabilityVersion!==effect.capability.version)throw Error();};
   await admit();const secret=await this.options.resolveCredential();current.throwIfAborted();if(!secret)throw Error();await admit();/* F1: caller authority revalidated after the last wait, before the transport. */await effect.dispatchGate?.validate(current);current.throwIfAborted();this.consumed.add(key);sent=true;
   const response=await(this.options.fetchImpl??fetch)(r.url,{method:r.method,headers:{...r.headers,authorization:'Bearer '+secret},...(r.body===undefined?{}:{body:r.body}),signal:current,redirect:'error'});
   const mime=response.headers.get('content-type')?.split(';')[0]?.trim();
   if(!response.ok||mime!==(kind==='content'?'video/mp4':'application/json')||!response.body){void response.body?.cancel();throw Error();}
   const limit=kind==='content'?Math.min(effect.limits.maxOutputBytes,WORKFLOW_LIMITS.videoArtifactBytes):WORKFLOW_LIMITS.commandBytes;
   const declared=response.headers.get('content-length');if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>limit)){void response.body.cancel();throw Error();}
   const reader=response.body.pipeThrough(new TransformStream(),{signal:current}).getReader(),chunks:Uint8Array[]=[];let size=0;
   try{for(;;){const next=await reader.read();current.throwIfAborted();if(next.done)break;size+=next.value.length;if(size>limit)throw Error();chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
   const bytes=Buffer.concat(chunks);current.throwIfAborted();
   if(kind==='content'){detectVideoMediaType(bytes);return bytes;}
   const raw=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(bytes));const status=parseVideoStatus({jobId:raw?.id,status:raw?.status});if(job&&status.jobId!==job.jobId)throw Error();return status;
  }catch(error){throw new VideoError(sent?'unknown':'not_sent',error instanceof VideoError?error.message:undefined);}finally{operation.abort();this.busy=false;}
 }
}
export async function launchWorkspaceVideo(appRoot:string,options:Omit<VideoOptions,'child'>):Promise<IpcWorkspaceVideo>{
 for(let cursor=path.resolve(appRoot);;cursor=path.dirname(cursor)){if(lstatSync(cursor).isSymbolicLink())throw Error('video_linked_path');if(path.dirname(cursor)===cursor)break;}
 const profilePath=path.join(appRoot,'quimera-profile.cjs');if(lstatSync(profilePath).isSymbolicLink())throw Error('video_linked_path');const profile=createRequire(import.meta.url)(profilePath);profile.appRoot(appRoot);
 const worker=profile.assertUnlinked(path.join(appRoot,'..','video-worker.mjs')),manifest=profile.assertUnlinked(path.join(appRoot,'..','source-manifest.json'));
 if(statSync(manifest).size>10485760||JSON.parse(readFileSync(manifest,'utf8')).commit!==options.driverRevision||options.driverRevision!=='17c4cc76877bd1755030a8414f8d0083f48dcccf')throw Error('video_revision_invalid');
 const child=spawn(process.execPath,[worker],{cwd:appRoot,env:profile.childEnvironment(process.env,appRoot),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>done(Error('video_start_timeout')),10000);const message=(m:any)=>{if(m?.type==='video-ready')done();};const exit=()=>done(Error('video_child_closed'));const done=(error?:Error)=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',done);error?reject(error):resolve();};child.on('message',message);child.on('error',done);child.on('exit',exit);});
  const service=new IpcWorkspaceVideo({...options,child});const dispose=service.dispose.bind(service);service.dispose=()=>{dispose();child.kill();};service.close=async()=>{dispose();if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>((resolve,reject)=>{const exit=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{child.off('exit',exit);reject(Error('video_stop_timeout'));},3000);child.once('exit',exit);child.kill();});};return service;
 }catch(error){child.kill();throw error;}
}

