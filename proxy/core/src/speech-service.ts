import {randomUUID} from 'node:crypto';
import type {ChildProcess} from 'node:child_process';
import {parseSpeechRequest,parseSpeechWireRequest,canonicalSpeechPayload,canonicalSpeechWirePayload,type SpeechRequest,type SpeechWireRequest} from '@uptokey/sync-contract/speech';
import {WORKFLOW_LIMITS} from '@uptokey/sync-contract/workflow';
import type {EffectRequest} from './workspace/executor.ts';
import type {WorkspaceStore} from './workspace/store.ts';
export interface WorkspaceSpeech {readonly model:string;readonly available?:boolean;prepare(request:SpeechRequest,signal:AbortSignal):Promise<SpeechWireRequest>;execute(request:SpeechRequest,wire:SpeechWireRequest,effect:EffectRequest):Promise<Uint8Array>;}
export class SpeechError extends Error {readonly outcome:'not_sent'|'unknown';constructor(outcome:'not_sent'|'unknown'){super('speech_operation_failed');this.outcome=outcome;}}
export interface SpeechOptions {child:ChildProcess;model:string;provider:string;providerUrl:string;driverRevision:string;store:Pick<WorkspaceStore,'readRun'>;resolveCredential():Promise<string>;fetchImpl?:import('./fetch-types.ts').FetchTransport;}
export class IpcWorkspaceSpeech implements WorkspaceSpeech {
 readonly model:string;private lifetime=new AbortController();private busy=false;private consumed=new Set<string>();
 private options:SpeechOptions; constructor(options:SpeechOptions){this.options={...options};this.model=options.model;}
 get available(){return this.options.child.connected&&!this.lifetime.signal.aborted;}
 dispose(){this.lifetime.abort();}
 async close():Promise<void>{this.dispose();}
 prepare(request:SpeechRequest,signal:AbortSignal):Promise<SpeechWireRequest>{return this.operation(request,undefined,undefined,signal) as Promise<SpeechWireRequest>;}
 execute(request:SpeechRequest,wire:SpeechWireRequest,effect:EffectRequest):Promise<Uint8Array>{return this.operation(request,wire,effect,effect.signal) as Promise<Uint8Array>;}
 private wire(value:unknown,request:SpeechRequest){const wire=parseSpeechWireRequest(value),body=JSON.parse(wire.body),parts=request.model.split('/');if(wire.model!==this.model||wire.provider!==this.options.provider||wire.url!==this.options.providerUrl||wire.driverRevision!==this.options.driverRevision||body.input!==request.input||body.model!==parts[1]||body.voice!==parts[2])throw new SpeechError('not_sent');return wire;}
 private async operation(input:SpeechRequest,inputWire:SpeechWireRequest|undefined,effectInput:EffectRequest|undefined,signal:AbortSignal):Promise<SpeechWireRequest|Uint8Array>{
  if(this.busy||!this.available)throw new SpeechError('not_sent');const request=parseSpeechRequest(input);if(request.model!==this.model)throw new SpeechError('not_sent');
  const wire=inputWire?this.wire(inputWire,request):undefined;const effect=effectInput?{...effectInput,arguments:structuredClone(effectInput.arguments),capability:structuredClone(effectInput.capability),limits:{...effectInput.limits}}:undefined;
  if(effect&&(!Number.isSafeInteger(effect.limits.maxOutputBytes)||effect.limits.maxOutputBytes<1||!Number.isSafeInteger(effect.limits.timeoutMs)||effect.limits.timeoutMs<1))throw new SpeechError('not_sent');
  if(effect){const a=effect.arguments.request,b=effect.arguments.wire;if(a?.kind!=='literal'||b?.kind!=='literal'||canonicalSpeechPayload(a.value)!==canonicalSpeechPayload(request)||canonicalSpeechWirePayload(b.value)!==canonicalSpeechWirePayload(wire)||effect.capability.effect!=='inference'||effect.capability.retryClass!=='never_automatic'||effect.capability.dataDestination.kind!=='provider')throw new SpeechError('not_sent');}
  const timeout=effect?Math.min(Date.parse(effect.deadlineAt)-Date.now(),effect.limits.timeoutMs):30000;if(!Number.isFinite(timeout)||timeout<1)throw new SpeechError('not_sent');
  const operationController=new AbortController();const current=AbortSignal.any([operationController.signal,signal,this.lifetime.signal,AbortSignal.timeout(Math.ceil(timeout))]);current.throwIfAborted();this.busy=true;
  const id=randomUUID();let sent=false,dispatchSeen=false;const child=this.options.child;const send=(message:any)=>{if(!child.connected)throw new Error('speech_disconnected');child.send(message);};
  try{return await new Promise<SpeechWireRequest|Uint8Array>((resolve,reject)=>{
   const fail=()=>reject(new SpeechError(sent?'unknown':'not_sent'));
   const abort=()=>{try{send({type:'speech-cancel',id});}catch{}fail();};
   const closed=()=>fail();
   const listener=(message:any)=>{void handle(message).catch(fail);};
   const cleanup=()=>{current.removeEventListener('abort',abort);child.off('message',listener);child.off('exit',closed);child.off('disconnect',closed);child.off('error',closed);};
   const handle=async(message:any)=>{
    if(message?.type==='speech-result'&&message.id===id){current.throwIfAborted();if(message.error)throw new Error();if(!effect){if(dispatchSeen)throw new Error();resolve(this.wire(message.wire,request));}else{if(!sent||typeof message.base64!=='string'||message.format!=='mp3'||message.base64.length>Math.ceil(WORKFLOW_LIMITS.artifactBytes/3)*4||!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(message.base64))throw new Error();const bytes=Buffer.from(message.base64,'base64');if(!bytes.length||bytes.length>Math.min(WORKFLOW_LIMITS.artifactBytes,effect.limits.maxOutputBytes))throw new Error();resolve(bytes);}return;}
    if(message?.type!=='dispatch'||message.requestId!==id)return;
    if(!effect||!wire||dispatchSeen||typeof message.id!=='string')throw new Error();dispatchSeen=true;
    if(canonicalSpeechWirePayload(this.wire(message.wire,request))!==canonicalSpeechWirePayload(wire))throw new Error();
    const key=JSON.stringify([effect.principalId,effect.projectId,effect.runId,effect.attemptId]);if(this.consumed.has(key))throw new Error();
    const admit=async()=>{const record=await this.options.store.readRun(effect.principalId,effect.projectId,effect.runId);current.throwIfAborted();const receipts=record?.receipts.filter(r=>r.attemptId===effect.attemptId),r=receipts?.[0];if(!record||record.run.id!==effect.runId||record.run.principalId!==effect.principalId||record.run.projectId!==effect.projectId||record.run.status!=='running'||receipts?.length!==1||r?.status!=='dispatched'||r.stepId!==effect.stepId||r.projectId!==effect.projectId||r.runId!==effect.runId||r.capabilityId!==effect.capability.id||r.capabilityVersion!==effect.capability.version)throw new Error();};
    await admit();const secret=await this.options.resolveCredential();current.throwIfAborted();if(!secret)throw new Error();await admit();/* F1: caller authority revalidated after the last wait, before the transport. */await effect.dispatchGate?.validate(current);current.throwIfAborted();this.consumed.add(key);sent=true;
    const response=await (this.options.fetchImpl??fetch)(wire.url,{method:'POST',body:wire.body,headers:{...wire.headers,authorization:'Bearer '+secret},redirect:'error',signal:current});
    if(!response.ok||!['audio/mpeg','audio/mp3'].includes(response.headers.get('content-type')?.split(';')[0]?.trim()??'')||!response.body){void response.body?.cancel();throw new Error();}
    const reader=response.body.pipeThrough(new TransformStream(),{signal:current}).getReader();let size=0;const chunks:Uint8Array[]=[];try{for(;;){const value=await reader.read();current.throwIfAborted();if(value.done)break;size+=value.value.length;if(size>Math.min(WORKFLOW_LIMITS.artifactBytes,effect.limits.maxOutputBytes))throw new Error();chunks.push(value.value);}}finally{void reader.cancel().catch(()=>{});reader.releaseLock();}if(!size)throw new Error();
    send({type:'stream-start',id:message.id,requestId:id,status:200,headers:{'content-type':'audio/mpeg'}});send({type:'stream-chunk',id:message.id,requestId:id,data:Buffer.concat(chunks).toString('base64')});send({type:'stream-end',id:message.id,requestId:id});
   };
   child.on('message',listener);child.on('exit',closed);child.on('disconnect',closed);child.on('error',closed);current.addEventListener('abort',abort,{once:true});
   // Promise settlement always removes process listeners, including provider and child failures.
   const originalResolve=resolve,originalReject=reject;resolve=value=>{cleanup();originalResolve(value);};reject=reason=>{cleanup();originalReject(reason);};
   try{send({type:'speech',id,request,wire});}catch{fail();}
  });}finally{operationController.abort();this.busy=false;try{send({type:'speech-cancel',id});}catch{}}
 }
}




