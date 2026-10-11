import {createHash} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import {parseTranscriptionRequest,parseTranscriptionWireRequest,canonicalTranscriptionPayload,canonicalTranscriptionWirePayload,
  inspectTranscriptionAudio,normalizeTranscriptionResponse,TRANSCRIPT_TEXT_MAX_BYTES,type TranscriptionRequest,type TranscriptionWireRequest} from '@uptokey/sync-contract/transcription';
import type {EffectRequest} from './workspace/executor.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {MediaEffectError,admitDispatched,effectSignal,readBoundedJson,classifyProviderStatus,launchPreparationWorker,requestPreparation,stopWorker} from './media-dispatch.ts';

export type TranscriptionOutput=ReturnType<typeof normalizeTranscriptionResponse>;
export interface WorkspaceTranscription {
 readonly model:string;readonly available?:boolean;readonly endpoint?:string;
 prepare(request:TranscriptionRequest,signal:AbortSignal):Promise<TranscriptionWireRequest>;
 /** audio must be the hash-verified artifact bytes; the service re-checks hash and declared audio container before sending. */
 execute(request:TranscriptionRequest,wire:TranscriptionWireRequest,audio:Uint8Array,effect:EffectRequest):Promise<TranscriptionOutput>;
}
export interface TranscriptionOptions {child:ChildProcess;model:string;provider:string;providerUrl:string;driverRevision:string;store:Pick<WorkspaceStore,'readRun'>;resolveCredential():Promise<string>;fetchImpl?:import('./fetch-types.ts').FetchTransport;}
/** Transcript JSON can exceed the text bound through segment metadata; keep a fixed response ceiling. */
const RESPONSE_MAX_BYTES=4*TRANSCRIPT_TEXT_MAX_BYTES;

export class IpcWorkspaceTranscription implements WorkspaceTranscription {
 readonly model:string;readonly endpoint:string;private lifetime=new AbortController();private busy=false;private consumed=new Set<string>();private options:TranscriptionOptions;
 constructor(options:TranscriptionOptions){this.options={...options};this.model=options.model;this.endpoint=options.providerUrl;}
 get available(){return this.options.child.connected&&!this.lifetime.signal.aborted;}
 dispose(){this.lifetime.abort();}
 async close(){this.dispose();}
 private wire(value:unknown,request:TranscriptionRequest){const wire=parseTranscriptionWireRequest(value,request);if(wire.model!==this.model||wire.url!==this.options.providerUrl||wire.provider!==this.options.provider||wire.driverRevision!==this.options.driverRevision)throw new MediaEffectError('not_sent');return wire;}
 async prepare(input:TranscriptionRequest,signal:AbortSignal):Promise<TranscriptionWireRequest>{
  if(this.busy||!this.available)throw new MediaEffectError('not_sent');const request=parseTranscriptionRequest(input);if(request.model!==this.model)throw new MediaEffectError('not_sent');
  this.busy=true;
  try{return await requestPreparation(this.options.child,'transcription-prepare','transcription-prepared',{request,provider:this.options.provider,providerUrl:this.options.providerUrl,driverRevision:this.options.driverRevision},
   AbortSignal.any([signal,this.lifetime.signal,AbortSignal.timeout(10000)]),wire=>this.wire(wire,request));}finally{this.busy=false;}
 }
 async execute(input:TranscriptionRequest,wireInput:TranscriptionWireRequest,audioInput:Uint8Array,effectInput:EffectRequest):Promise<TranscriptionOutput>{
  if(this.busy||!this.available)throw new MediaEffectError('not_sent');
  let request:TranscriptionRequest,wire:TranscriptionWireRequest;try{request=parseTranscriptionRequest(input);wire=this.wire(wireInput,request);}catch{throw new MediaEffectError('not_sent');}
  const audio=new Uint8Array(audioInput);
  try{inspectTranscriptionAudio(audio,request.audio.mediaType);}catch{throw new MediaEffectError('not_sent','policy');}
  if(audio.byteLength!==request.audio.byteLength||createHash('sha256').update(audio).digest('hex')!==request.audio.sha256)throw new MediaEffectError('not_sent');
  const effect={...effectInput,arguments:structuredClone(effectInput.arguments),capability:structuredClone(effectInput.capability),limits:{...effectInput.limits}};
  const a=effect.arguments.request,b=effect.arguments.wire;
  if(a?.kind!=='literal'||b?.kind!=='literal'||canonicalTranscriptionPayload(a.value)!==canonicalTranscriptionPayload(request)||canonicalTranscriptionWirePayload(b.value,request)!==canonicalTranscriptionWirePayload(wire,request)||
   effect.capability.effect!=='inference'||effect.capability.retryClass!=='never_automatic'||effect.capability.dataDestination.kind!=='provider')throw new MediaEffectError('not_sent');
  const key=JSON.stringify([effect.principalId,effect.projectId,effect.runId,effect.attemptId]);
  const {signal,abort}=effectSignal(effect,this.lifetime.signal);let sent=false;this.busy=true;
  try{
   if(this.consumed.has(key))throw new MediaEffectError('not_sent');
   await admitDispatched(this.options.store,effect,signal);const secret=await this.options.resolveCredential();signal.throwIfAborted();if(!secret)throw new MediaEffectError('not_sent','auth');
   await admitDispatched(this.options.store,effect,signal);
   // F1: caller authority revalidated after the last wait, before the transport.
   await effect.dispatchGate?.validate(signal);signal.throwIfAborted();this.consumed.add(key);
   const form=new FormData();form.append('file',new File([audio],wire.file.filename,{type:wire.file.mediaType}));for(const [name,value] of wire.fields)form.append(name,value);
   sent=true;
   const response=await(this.options.fetchImpl??fetch)(wire.url,{method:'POST',body:form,headers:{authorization:'Bearer '+secret},redirect:'error',signal});
   if(!response.ok){void response.body?.cancel().catch(()=>{});throw new MediaEffectError('unknown',classifyProviderStatus(response.status));}
   const body=await readBoundedJson(response,Math.min(RESPONSE_MAX_BYTES,effect.limits.maxOutputBytes),signal);signal.throwIfAborted();
   return normalizeTranscriptionResponse(body,request);
  }catch(error){if(error instanceof MediaEffectError&&(error.outcome==='not_sent'&&!sent||error.outcome==='unknown'))throw error;throw new MediaEffectError(sent?'unknown':'not_sent',signal.aborted&&sent?'network':'unknown');}
  finally{abort();this.busy=false;}
 }
}

export async function launchWorkspaceTranscription(appRoot:string,options:Omit<TranscriptionOptions,'child'>):Promise<IpcWorkspaceTranscription>{
 const child=await launchPreparationWorker(appRoot,'transcription-worker.mjs','transcription-ready',options.driverRevision);
 const service=new IpcWorkspaceTranscription({...options,child});const dispose=service.dispose.bind(service);
 service.dispose=()=>{dispose();child.kill();};service.close=async()=>{dispose();await stopWorker(child);};return service;
}
