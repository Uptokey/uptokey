import {randomUUID,createHash} from 'node:crypto';
import {spawn,type ChildProcess} from 'node:child_process';
import {createRequire} from 'node:module';
import {readFileSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';
import {parseImageRequest,parseImageWireRequest,canonicalImagePayload,canonicalImageWirePayload,detectImageMediaType,type ImageRequest,type ImageWireRequest} from '@uptokey/sync-contract/image';
import {WORKFLOW_LIMITS} from '@uptokey/sync-contract/workflow';
import type {EffectRequest} from './workspace/executor.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import type {FetchTransport} from './fetch-types.ts';

export interface ImageResult {bytes:Uint8Array;mediaType:'image/png'|'image/jpeg'|'image/webp';}
export interface WorkspaceImage {readonly model:string;readonly available?:boolean;readonly supportedOperations?:readonly string[];prepare(request:ImageRequest,signal:AbortSignal):Promise<ImageWireRequest>;execute(request:ImageRequest,wire:ImageWireRequest,effect:EffectRequest):Promise<ImageResult[]>;}
export class ImageError extends Error {readonly outcome:'not_sent'|'unknown';constructor(outcome:'not_sent'|'unknown',reason='image_operation_failed'){super(reason);this.outcome=outcome;}}
export interface ImageOptions {child:ChildProcess;model:string;provider:string;providerUrl:string;providerEditUrl?:string;driverRevision:string;store:Pick<WorkspaceStore,'readRun'>&Partial<Pick<WorkspaceStore,'readBinaryArtifactMedia'>>;resolveCredential():Promise<string>;fetchImpl?:FetchTransport;}

export class IpcWorkspaceImage implements WorkspaceImage {
 readonly model:string;readonly supportedOperations:readonly string[];private lifetime=new AbortController();private busy=false;private consumed=new Set<string>();private options:ImageOptions;
 constructor(options:ImageOptions){this.options={...options};this.model=options.model;
  if(options.providerEditUrl){const edit=new URL(options.providerEditUrl),base=new URL(options.providerUrl);if(edit.origin!==base.origin||edit.pathname!=='/v1/images/edits'||edit.search||edit.hash||edit.username||edit.password||!(edit.protocol==='https:'||edit.protocol==='http:'&&edit.hostname==='127.0.0.1')||!/^openai\/gpt-image-[A-Za-z0-9._-]+$/.test(options.model)||!options.store.readBinaryArtifactMedia)throw Error('image_edit_configuration_invalid');}
  this.supportedOperations=Object.freeze(options.providerEditUrl?['generate','edit']:['generate']);
 }
 get available(){return this.options.child.connected&&!this.lifetime.signal.aborted;}
 dispose(){this.lifetime.abort();}
 async close(){this.dispose();}
 private wire(value:unknown,request:ImageRequest){const wire=parseImageWireRequest(value,request);if(!this.supportedOperations.includes(request.operation)||wire.model!==this.model||wire.url!==(request.operation==='edit'?this.options.providerEditUrl:this.options.providerUrl)||wire.provider!==this.options.provider||wire.driverRevision!==this.options.driverRevision)throw new ImageError('not_sent');return wire;}
 async prepare(input:ImageRequest,signal:AbortSignal):Promise<ImageWireRequest>{
  if(this.busy||!this.available)throw new ImageError('not_sent');const request=parseImageRequest(input);if(request.model!==this.model)throw new ImageError('not_sent');
  const current=AbortSignal.any([signal,this.lifetime.signal,AbortSignal.timeout(10000)]);current.throwIfAborted();this.busy=true;
  const child=this.options.child,id=randomUUID();
  try{return await new Promise<ImageWireRequest>((resolve,reject)=>{
   const cleanup=()=>{child.off('message',message);child.off('error',fail);child.off('exit',fail);child.off('disconnect',fail);current.removeEventListener('abort',fail);};
   const fail=()=>{cleanup();reject(new ImageError('not_sent'));};
   const message=(value:any)=>{if(value?.type!=='image-prepared'||value.id!==id)return;try{current.throwIfAborted();if(value.error)throw Error();const wire=this.wire(value.wire,request);cleanup();resolve(wire);}catch{fail();}};
   child.on('message',message);child.on('error',fail);child.on('exit',fail);child.on('disconnect',fail);current.addEventListener('abort',fail,{once:true});
   try{child.send({type:'image-prepare',id,request,provider:this.options.provider,providerUrl:this.options.providerUrl,providerEditUrl:this.options.providerEditUrl,driverRevision:this.options.driverRevision},error=>{if(error)fail();});}catch{fail();}
  });}finally{this.busy=false;}
 }
 async execute(input:ImageRequest,wireInput:ImageWireRequest,effectInput:EffectRequest):Promise<ImageResult[]>{
  let sent=false;
  if(this.busy||!this.available)throw new ImageError('not_sent');
  let request:ImageRequest,wire:ImageWireRequest;try{request=parseImageRequest(input);wire=this.wire(wireInput,request);}catch{throw new ImageError('not_sent');}
  const effect={...effectInput,arguments:structuredClone(effectInput.arguments),capability:structuredClone(effectInput.capability),limits:{...effectInput.limits}};
  const a=effect.arguments.request,b=effect.arguments.wire;
  if(a?.kind!=='literal'||b?.kind!=='literal'||canonicalImagePayload(a.value)!==canonicalImagePayload(request)||canonicalImageWirePayload(b.value,request)!==canonicalImageWirePayload(wire,request)||effect.capability.effect!=='inference'||effect.capability.retryClass!=='never_automatic'||effect.capability.dataDestination.kind!=='provider'||!Number.isSafeInteger(effect.limits.maxOutputBytes)||effect.limits.maxOutputBytes<1)throw new ImageError('not_sent');
  const timeout=Math.min(Date.parse(effect.deadlineAt)-Date.now(),effect.limits.timeoutMs);if(!Number.isSafeInteger(effect.limits.timeoutMs)||!Number.isFinite(timeout)||timeout<1)throw new ImageError('not_sent');
  const operation=new AbortController(),current=AbortSignal.any([effect.signal,this.lifetime.signal,operation.signal,AbortSignal.timeout(Math.ceil(timeout))]);
  const key=JSON.stringify([effect.principalId,effect.projectId,effect.runId,effect.attemptId]);
  this.busy=true;
  try{
   const admit=async()=>{current.throwIfAborted();if(this.consumed.has(key))throw Error();const record=await this.options.store.readRun(effect.principalId,effect.projectId,effect.runId);current.throwIfAborted();const receipts=record?.receipts.filter(r=>r.attemptId===effect.attemptId),r=receipts?.[0];if(!record||record.run.id!==effect.runId||record.run.principalId!==effect.principalId||record.run.projectId!==effect.projectId||record.run.status!=='running'||receipts?.length!==1||r?.status!=='dispatched'||r.stepId!==effect.stepId||r.projectId!==effect.projectId||r.runId!==effect.runId||r.capabilityId!==effect.capability.id||r.capabilityVersion!==effect.capability.version)throw Error();};
   await admit();let body:string|FormData=wire.body;
   const headers:Record<string,string>={...wire.headers};
   if(request.operation==='edit'){
    const form=new FormData(),metadata=JSON.parse(wire.body);
    for(const [name,value] of Object.entries(metadata.fields))form.append(name,value as string);
    const refs=[...request.inputRefs,...(request.maskRef?[request.maskRef]:[])];
    for(const [index,ref] of refs.entries()){
     const source=await this.options.store.readBinaryArtifactMedia!(effect.principalId,effect.projectId,ref.artifactId);current.throwIfAborted();
     if(source.bytes.byteLength!==ref.bytes||source.mediaType!==ref.mediaType||detectImageMediaType(source.bytes)!==ref.mediaType||createHash('sha256').update(source.bytes).digest('hex')!==ref.sha256)throw Error('image_input_mismatch');
     const extension=ref.mediaType==='image/png'?'png':ref.mediaType==='image/jpeg'?'jpg':'webp';
     form.append(ref.role==='mask'?'mask':request.inputRefs.length>1?'image[]':'image',new Blob([Uint8Array.from(source.bytes)],{type:ref.mediaType}),`input-${index}.${extension}`);
    }
    body=form;delete headers['content-type'];
   }
   const secret=await this.options.resolveCredential();current.throwIfAborted();if(!secret)throw Error();await admit();/* F1: caller authority revalidated after the last wait, before the transport. */await effect.dispatchGate?.validate(current);current.throwIfAborted();this.consumed.add(key);sent=true;
   const response=await(this.options.fetchImpl??fetch)(wire.url,{method:'POST',body,headers:{...headers,authorization:'Bearer '+secret},redirect:'error',signal:current});
   if(!response.ok||response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'||!response.body){void response.body?.cancel();throw Error();}
   // Account for base64 and JSON overhead separately from decoded artifact quota.
   const byteLimit=Math.min(effect.limits.maxOutputBytes,request.n*WORKFLOW_LIMITS.artifactBytes);
   const wireLimit=4*Math.ceil(byteLimit/3)+WORKFLOW_LIMITS.commandBytes;
   const reader=response.body.pipeThrough(new TransformStream(),{signal:current}).getReader();let size=0;const chunks:Uint8Array[]=[];
   try{for(;;){const next=await reader.read();current.throwIfAborted();if(next.done)break;size+=next.value.length;if(size>wireLimit)throw Error();chunks.push(next.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
   const parsed=JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
   if(!Array.isArray(parsed?.data)||parsed.data.length!==request.n)throw Error();
   let total=0;const results:ImageResult[]=[];
   for(const item of parsed.data){
    if(item?.url!==undefined)throw new ImageError('unknown','image_url_response_unsupported');
    const b64=item?.b64_json;if(typeof b64!=='string'||!b64.length||b64.length>4*Math.ceil(WORKFLOW_LIMITS.artifactBytes/3)||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(b64))throw Error();
    const bytes=Buffer.from(b64,'base64');if(bytes.toString('base64')!==b64)throw Error();total+=bytes.length;if(total>byteLimit)throw Error();results.push({bytes,mediaType:detectImageMediaType(bytes)});
   }
   current.throwIfAborted();return results;
  }catch(error){throw new ImageError(sent?'unknown':'not_sent',error instanceof ImageError?error.message:undefined);}finally{operation.abort();this.busy=false;}
 }
}

/** Launches the pinned pure adapter in the existing filtered Quimera worker environment. */
export async function launchWorkspaceImage(appRoot:string,options:Omit<ImageOptions,'child'>):Promise<IpcWorkspaceImage>{
 for(let cursor=path.resolve(appRoot);;cursor=path.dirname(cursor)){if(lstatSync(cursor).isSymbolicLink())throw Error('image_linked_path');if(path.dirname(cursor)===cursor)break;}
 if(lstatSync(path.join(appRoot,'quimera-profile.cjs')).isSymbolicLink())throw Error('image_linked_path');
 const require=createRequire(import.meta.url),profile=require(path.join(appRoot,'quimera-profile.cjs'));profile.appRoot(appRoot);
 const worker=profile.assertUnlinked(path.join(appRoot,'..','image-worker.mjs')),manifestPath=profile.assertUnlinked(path.join(appRoot,'..','source-manifest.json'));
 if(statSync(manifestPath).size>10485760)throw Error('image_manifest_limit');
 if(JSON.parse(readFileSync(manifestPath,'utf8')).commit!==options.driverRevision||options.driverRevision!=='17c4cc76877bd1755030a8414f8d0083f48dcccf')throw Error('image_revision_invalid');
 const child=spawn(process.execPath,[worker],{cwd:appRoot,env:profile.childEnvironment(process.env,appRoot),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>done(Error('image_start_timeout')),10000);const message=(value:any)=>{if(value?.type==='image-ready')done();};const exit=()=>done(Error('image_child_closed'));const done=(error?:Error)=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',done);error?reject(error):resolve();};child.on('message',message);child.on('exit',exit);child.on('error',done);});
  const service=new IpcWorkspaceImage({...options,child});const dispose=service.dispose.bind(service);service.dispose=()=>{dispose();child.kill();};service.close=async()=>{dispose();if(child.exitCode!==null||child.signalCode!==null)return;await new Promise<void>((resolve,reject)=>{const exit=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{child.off('exit',exit);reject(Error('image_stop_timeout'));},3000);child.once('exit',exit);child.kill();});};return service;
 }catch(error){child.kill();throw error;}
}
