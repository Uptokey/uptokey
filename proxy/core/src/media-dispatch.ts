import {spawn,type ChildProcess} from 'node:child_process';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import {readFileSync,statSync,lstatSync} from 'node:fs';
import path from 'node:path';
import type {EffectRequest} from './workspace/executor.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {assertPublicHost,fetchPinnedPublic,NetworkPolicyError,type HostResolver} from './network-policy.ts';

export const MEDIA_DRIVER_REVISION='17c4cc76877bd1755030a8414f8d0083f48dcccf';
export type ProviderErrorClass='auth'|'quota'|'rate_limit'|'model'|'policy'|'network'|'unknown';
/** Stable provider error classes; quota is never inferred from a local reservation. */
export function classifyProviderStatus(status:number):ProviderErrorClass{
 if(status===401||status===403)return 'auth';if(status===402)return 'quota';if(status===429)return 'rate_limit';
 if(status===404)return 'model';if(status===400||status===413||status===415||status===422)return 'policy';return 'unknown';
}
export class MediaEffectError extends Error {
 readonly outcome:'not_sent'|'unknown';readonly errorClass:ProviderErrorClass;
 /** Typed refusal code kept up to the journal/UI; present only for certain not-sent refusals. */
 readonly code?:string;
 constructor(outcome:'not_sent'|'unknown',errorClass:ProviderErrorClass='unknown',code?:string){super('media_operation_failed');this.outcome=outcome;this.errorClass=errorClass;if(code)this.code=code;}
}
/** Last-moment authority owned by the caller (account funding, identity); run just before the transport. */
export interface MediaDispatchGate { validate(signal:AbortSignal):Promise<void> }
const REFUSAL=/^(budget_[a-z_]{1,60}|account_funding_[a-z_]{1,60})$/;
export const refusalCode=(error:unknown,fallback:string)=>error instanceof Error&&REFUSAL.test(error.message)?error.message:fallback;

/** The dispatched receipt, read after every await, is the only permit to read the credential or send. */
export async function admitDispatched(store:Pick<WorkspaceStore,'readRun'>,effect:EffectRequest,signal:AbortSignal):Promise<void>{
 signal.throwIfAborted();const record=await store.readRun(effect.principalId,effect.projectId,effect.runId);signal.throwIfAborted();
 const receipts=record?.receipts.filter(r=>r.attemptId===effect.attemptId),r=receipts?.[0];
 if(!record||record.run.id!==effect.runId||record.run.principalId!==effect.principalId||record.run.projectId!==effect.projectId||record.run.status!=='running'||
  receipts?.length!==1||r?.status!=='dispatched'||r.stepId!==effect.stepId||r.projectId!==effect.projectId||r.runId!==effect.runId||
  r.capabilityId!==effect.capability.id||r.capabilityVersion!==effect.capability.version)throw new MediaEffectError('not_sent');
}

/** Total deadline of the run bounds the effect; no local retry renews it. */
export function effectSignal(effect:EffectRequest,lifetime:AbortSignal):{signal:AbortSignal;abort():void}{
 const timeout=Math.min(Date.parse(effect.deadlineAt)-Date.now(),effect.limits.timeoutMs);
 if(!Number.isSafeInteger(effect.limits.timeoutMs)||!Number.isFinite(timeout)||timeout<1||!Number.isSafeInteger(effect.limits.maxOutputBytes)||effect.limits.maxOutputBytes<1)throw new MediaEffectError('not_sent');
 const operation=new AbortController();
 return {signal:AbortSignal.any([effect.signal,lifetime,operation.signal,AbortSignal.timeout(Math.ceil(timeout))]),abort:()=>operation.abort()};
}

/** Bytes are counted while streaming, before JSON decoding. */
export async function readBoundedJson(response:Response,limit:number,signal:AbortSignal):Promise<unknown>{
 if(response.headers.get('content-type')?.split(';')[0]?.trim()!=='application/json'||!response.body){void response.body?.cancel().catch(()=>{});throw new Error('media_response_type');}
 const reader=response.body.getReader();const chunks:Uint8Array[]=[];let size=0;
 const abort=()=>{void reader.cancel().catch(()=>{});};signal.addEventListener('abort',abort,{once:true});
 try{for(;;){signal.throwIfAborted();const next=await reader.read();signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>limit)throw new Error('media_response_limit');chunks.push(next.value);}}
 finally{signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});}
 return JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(Buffer.concat(chunks)));
}

/** Launches a credential-free preparation worker from the pinned 9Router checkout. */
export async function launchPreparationWorker(appRoot:string,workerName:string,readyType:string,driverRevision:string):Promise<ChildProcess>{
 for(let cursor=path.resolve(appRoot);;cursor=path.dirname(cursor)){if(lstatSync(cursor).isSymbolicLink())throw Error('media_linked_path');if(path.dirname(cursor)===cursor)break;}
 if(lstatSync(path.join(appRoot,'quimera-profile.cjs')).isSymbolicLink())throw Error('media_linked_path');
 const require=createRequire(import.meta.url),profile=require(path.join(appRoot,'quimera-profile.cjs'));profile.appRoot(appRoot);
 const worker=profile.assertUnlinked(path.join(appRoot,'..',workerName)),manifestPath=profile.assertUnlinked(path.join(appRoot,'..','source-manifest.json'));
 if(statSync(manifestPath).size>10485760)throw Error('media_manifest_limit');
 if(JSON.parse(readFileSync(manifestPath,'utf8')).commit!==driverRevision||driverRevision!==MEDIA_DRIVER_REVISION)throw Error('media_revision_invalid');
 const child=spawn(process.execPath,[worker],{cwd:appRoot,env:profile.childEnvironment(process.env,appRoot),stdio:['ignore','ignore','ignore','ipc'],windowsHide:true});
 try{await new Promise<void>((resolve,reject)=>{const timer=setTimeout(()=>done(Error('media_start_timeout')),10000);const message=(value:any)=>{if(value?.type===readyType)done();};const exit=()=>done(Error('media_child_closed'));const done=(error?:Error)=>{clearTimeout(timer);child.off('message',message);child.off('exit',exit);child.off('error',done);error?reject(error):resolve();};child.on('message',message);child.on('exit',exit);child.on('error',done);});return child;}
 catch(error){child.kill();throw error;}
}

/** One IPC round trip; the worker never receives credentials or reaches the network. */
export function requestPreparation<T>(child:ChildProcess,type:string,replyType:string,payload:Record<string,unknown>,signal:AbortSignal,accept:(wire:unknown)=>T):Promise<T>{
 const id=crypto.randomUUID();
 return new Promise<T>((resolve,reject)=>{
  const cleanup=()=>{child.off('message',message);child.off('error',fail);child.off('exit',fail);child.off('disconnect',fail);signal.removeEventListener('abort',fail);};
  const fail=()=>{cleanup();reject(new MediaEffectError('not_sent'));};
  const message=(value:any)=>{if(value?.type!==replyType||value.id!==id)return;try{signal.throwIfAborted();if(value.error)throw Error();const wire=accept(value.wire);cleanup();resolve(wire);}catch{fail();}};
  if(signal.aborted){reject(new MediaEffectError('not_sent'));return;}
  child.on('message',message);child.on('error',fail);child.on('exit',fail);child.on('disconnect',fail);signal.addEventListener('abort',fail,{once:true});
  try{child.send({type,id,...payload},error=>{if(error)fail();});}catch{fail();}
 });
}

export async function stopWorker(child:ChildProcess):Promise<void>{
 if(child.exitCode!==null||child.signalCode!==null)return;
 await new Promise<void>((resolve,reject)=>{const exit=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{child.off('exit',exit);reject(Error('media_stop_timeout'));},3000);child.once('exit',exit);child.kill();});
}

export type ControlledContentCode='media_download_denied'|'media_download_limit'|'media_response_type'|'media_output_invalid';
export class ControlledContentError extends Error {readonly code:ControlledContentCode;constructor(code:ControlledContentCode){super(code);this.code=code;}}
const isLoopbackHost=(hostname:string):boolean=>hostname==='127.0.0.1'||hostname==='[::1]'||hostname==='::1'||hostname==='localhost';
/** PROPOSED E2-09: the provider URL is never identity; only https (or an explicitly enabled loopback fixture) without credentials, query or fragment is admissible. */
export function assertContentUrl(value:string,allowLoopback=false):URL{
 if(typeof value!=='string'||value.length>2048)throw new ControlledContentError('media_download_denied');
 let url;try{url=new URL(value);}catch{throw new ControlledContentError('media_download_denied');}
 if(url.href!==value||url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||allowLoopback&&url.protocol==='http:'&&isLoopbackHost(url.hostname)))throw new ControlledContentError('media_download_denied');
 return url;
}
/** PROPOSED E2-09: fetch a provider URL under local control — host resolved and revalidated against the shared private/metadata policy at every hop, MIME checked, bytes counted while streaming. */
export async function fetchControlledContent(input:string,options:{maxBytes:number;mediaTypes:readonly string[];maxRedirects?:number;signal:AbortSignal;fetchImpl?:typeof fetch;allowLoopback?:boolean;resolve?:HostResolver;expectedSha256?:string}):Promise<{bytes:Uint8Array;mediaType:string}>{
 if(!Number.isSafeInteger(options.maxBytes)||options.maxBytes<1||!options.mediaTypes.length)throw new ControlledContentError('media_download_limit');
 if(options.expectedSha256!==undefined&&!/^[a-f0-9]{64}$/.test(options.expectedSha256))throw new ControlledContentError('media_download_denied');
 const maxRedirects=options.maxRedirects??3,allowLoopback=options.allowLoopback??false;
 const destination=async(value:string)=>{
  const url=assertContentUrl(value,allowLoopback);
  if(allowLoopback&&isLoopbackHost(url.hostname))return {url,addresses:null};
  try{return {url,addresses:await assertPublicHost(url.hostname,options.resolve)};}catch(error){if(error instanceof NetworkPolicyError)throw new ControlledContentError('media_download_denied');throw error;}
 };
 let current=await destination(input);
 for(let hop=0;;hop++){
  options.signal.throwIfAborted();
  const target=current.url.href,init:RequestInit={method:'GET',redirect:'manual',signal:options.signal};
  const response=await(options.fetchImpl?options.fetchImpl(target,init):current.addresses?fetchPinnedPublic(target,init,current.addresses):fetch(target,init));
  if([301,302,303,307,308].includes(response.status)){
   const location=response.headers.get('location');void response.body?.cancel().catch(()=>{});
   if(!location||hop>=maxRedirects)throw new ControlledContentError('media_download_denied');
   current=await destination(new URL(location,target).href);continue;
  }
  if(!response.ok||!response.body){void response.body?.cancel().catch(()=>{});throw new ControlledContentError('media_download_denied');}
  const mediaType=response.headers.get('content-type')?.split(';')[0]?.trim()??'';
  if(!options.mediaTypes.includes(mediaType)){void response.body.cancel().catch(()=>{});throw new ControlledContentError('media_response_type');}
  const declared=response.headers.get('content-length');
  if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>options.maxBytes)){void response.body.cancel().catch(()=>{});throw new ControlledContentError('media_download_limit');}
  const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
  const abort=()=>{void reader.cancel().catch(()=>{});};options.signal.addEventListener('abort',abort,{once:true});
  try{for(;;){options.signal.throwIfAborted();const next=await reader.read();options.signal.throwIfAborted();if(next.done)break;size+=next.value.byteLength;if(size>options.maxBytes)throw new ControlledContentError('media_download_limit');chunks.push(next.value);}}
  finally{options.signal.removeEventListener('abort',abort);void reader.cancel().catch(()=>{});}
  const bytes=Buffer.concat(chunks);
  // A content-addressed artifact is published only when the bytes match the provider-declared digest.
  if(options.expectedSha256!==undefined&&createHash('sha256').update(bytes).digest('hex')!==options.expectedSha256)throw new ControlledContentError('media_output_invalid');
  return {bytes,mediaType};
 }
}
