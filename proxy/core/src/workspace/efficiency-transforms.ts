import {createHash} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {getActiveEfficiencyPolicy,applyEfficiencyBeforeDigest} from './efficiency-pipeline.ts';
import {compareExternalCandidate,type ToolResultInput} from './context-projection.ts';
import type {EfficiencyPolicy} from '../efficiency-policy.ts';
import type {TransformationReceipt} from '../efficiency-receipts.ts';
// Reuse the already inventoried RTK port. Do not run a host shell to compress output.
// @ts-ignore Upstream is JavaScript; adapter below validates its result.
import {autoDetectFilter} from "../../../integracoes/9router/app/open-sse/rtk/autodetect.js";

const hash=(s:string)=>createHash('sha256').update(s).digest('hex');
export function headroomEndpoint(value=process.env.UPTOKEY_HEADROOM_URL):string|undefined{
 if(!value)return undefined;
 try{const u=new URL(value);if(u.protocol!=='http:'||!['127.0.0.1','[::1]'].includes(u.hostname)||u.username||u.password||u.search||u.hash||!['/','/v1/compress'].includes(u.pathname))return undefined;u.pathname='/v1/compress';return u.href;}catch{return undefined;}
}
export function efficiencyProcessors(){return {rtk:{available:true,source:'9router-rtk-port'},headroom:{available:Boolean(headroomEndpoint()),endpoint:headroomEndpoint()??null}};}
/** Headroom's documented messages API, restricted to an explicitly configured local process. */
async function headroom(input:ToolResultInput,signal:AbortSignal,fetcher:typeof fetch):Promise<string>{
 const endpoint=headroomEndpoint();if(!endpoint)throw Error('transformer_unavailable');
 const response=await fetcher(endpoint,{method:'POST',headers:{'content-type':'application/json'},redirect:'error',credentials:'omit',signal:AbortSignal.any([signal,AbortSignal.timeout(3000)]),body:JSON.stringify({messages:[{role:'tool',tool_call_id:input.callId,content:input.content}],config:{compress_user_messages:false}})});
 if(!response.ok||!response.body)throw Error('compressor_failed');
 const reader=response.body.getReader(),parts:Uint8Array[]=[];let size=0;
 try{for(;;){signal.throwIfAborted();const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>1_048_576)throw Error('compressor_output_too_large');parts.push(next.value);}}catch(e){await reader.cancel().catch(()=>{});throw e;}finally{reader.releaseLock();}
 const value:unknown=JSON.parse(Buffer.concat(parts).toString('utf8'));if(!isDataRecord(value)||!Array.isArray(value.messages)||value.messages.length!==1)throw Error('compressor_invalid');
 const message=value.messages[0];if(!isDataRecord(message)||message.role!=='tool'||message.tool_call_id!==input.callId||typeof message.content!=='string')throw Error('compressor_binding_changed');return message.content;
}
/** Transforms execute once during preparation; signed plans retain the resulting bytes and receipts. */
export async function prepareEfficiency(input:ToolResultInput,signal:AbortSignal,policy:EfficiencyPolicy=getActiveEfficiencyPolicy(),fetcher:typeof fetch=fetch){
 let content=input.content;const receipts:TransformationReceipt[]=[];const originalHash=hash(content);
 if(policy.enabled&&!input.authoritative&&!input.isError&&!input.truncatedUpstream&&Buffer.byteLength(content)<=1_048_576){
  for(const step of policy.transforms){if(!step.enabled)continue;signal.throwIfAborted();
   if(step.kind==='deterministic_projection'){
    const projected=applyEfficiencyBeforeDigest({...input,content},undefined,{...policy,transforms:[step]},{retainOriginal:false});
    if(projected.projected){content=typeof projected.payloadForDigest==='string'?projected.payloadForDigest:projected.payloadForDigest.content;receipts.push(projected.receipt);}continue;
   }
   const before=content,started=performance.now();let candidate=before,reason='no_gain';
   try{
    if(step.kind==='rtk'){const filter=autoDetectFilter(before);if(typeof filter==='function'){const result=filter(before);if(typeof result==='string')candidate=result.replace(/^\s*\.\.\. \((\d+ duplicate lines)\)$/gm,'[compressed $1]');}}
    else candidate=await headroom({...input,content:before},signal,fetcher);
    signal.throwIfAborted();
    const framed=candidate.includes(input.callId)?candidate:`tool_call_id: ${input.callId}\n${candidate}`;
    const comparison=compareExternalCandidate(before,input.callId,input.declaredIds??[],{name:step.kind,version:'1',text:framed,compressorMs:performance.now()-started});
    if(comparison.measuredGain){content=framed;reason='extractive_view';}else reason=comparison.fidelity==='pass'?'no_gain':comparison.fidelity;
   }catch{signal.throwIfAborted();reason='compressor_unavailable';}
   const changed=content!==before;
   receipts.push({sourceHash:hash(before),viewHash:hash(content),sourceArtifactRefs:[...input.sourceArtifactRefs],transformer:step.kind,version:'1',configHash:hash(JSON.stringify(step)),bytesBefore:Buffer.byteLength(before),bytesAfter:Buffer.byteLength(content),tokensBefore:null,tokensAfter:null,tokenizer:'unmeasured',latencyMs:Math.max(0,performance.now()-started),costMicros:null,knownLosses:[reason],fidelity:changed?'lossy_declared':'bypassed'});
  }
 }
 signal.throwIfAborted();return {content,transformed:content!==input.content,sourceHash:originalHash,viewHash:hash(content),sourceArtifactRefs:[...input.sourceArtifactRefs],receipts,policyRevision:policy.revision};
}
