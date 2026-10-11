import {TypeSafeClient,choice,type EntryType,type Question} from '@typesafe-ai/sdk';
import {publicHttpsFetch} from './governed-transport.ts';

/** Shared transport, not an executor. Callers must first validate canonical W5
 * admission. SDK 0.6.0 (MIT), official /v1/systemone Choice contract checked
 * 2026-09-21: https://docs.typesafe.ai/sdk/javascript and /primitives/choice. */
export async function performTypeSafeChoice(input:{credential:string;model:string;state:EntryType;questionId:string;instructions:string;criteria:Record<string,string>;timeoutMs:number;maxBytes:number;signal:AbortSignal;fetchFn?:typeof fetch;onDispatch:()=>void}){
 input.signal.throwIfAborted();
 const client=new TypeSafeClient({apiKey:input.credential,baseURL:'https://api.typesafe.ai',defaultModel:input.model,logLevel:'off',retry:{maxRetries:0},fetch:async(url,init)=>{
  input.signal.throwIfAborted();if(String(url)!=='https://api.typesafe.ai/v1/systemone')throw Error('typesafe_destination_denied');input.onDispatch();
  const response=await(input.fetchFn??publicHttpsFetch)(url,{...init,redirect:'manual',signal:input.signal});let count=0;
  const body=response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){count+=chunk.byteLength;if(count>input.maxBytes)throw Error('typesafe_output_limit');controller.enqueue(chunk);}}));
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 }});
 return client.systemOne({model:input.model,state:input.state,questions:{[input.questionId]:choice(input.instructions,input.criteria)}},{signal:input.signal,timeout:input.timeoutMs,retry:{maxRetries:0}});
}

/** Same governed transport for several independent questions over one state (Noul/Choice/Score as documented at
 * docs.typesafe.ai/api). Non-authorizing: callers use the answers to inform a person or a deterministic rule. */
export async function performTypeSafeJudgment(input:{credential:string;model:string;state:EntryType;questions:Record<string,Question>;timeoutMs:number;maxBytes:number;signal:AbortSignal;fetchFn?:typeof fetch;onDispatch:()=>void}){
 input.signal.throwIfAborted();
 const client=new TypeSafeClient({apiKey:input.credential,baseURL:'https://api.typesafe.ai',defaultModel:input.model,logLevel:'off',retry:{maxRetries:0},fetch:async(url,init)=>{
  input.signal.throwIfAborted();if(String(url)!=='https://api.typesafe.ai/v1/systemone')throw Error('typesafe_destination_denied');input.onDispatch();
  const response=await(input.fetchFn??publicHttpsFetch)(url,{...init,redirect:'manual',signal:input.signal});let count=0;
  const body=response.body?.pipeThrough(new TransformStream<Uint8Array,Uint8Array>({transform(chunk,controller){count+=chunk.byteLength;if(count>input.maxBytes)throw Error('typesafe_output_limit');controller.enqueue(chunk);}}));
  return new Response(body,{status:response.status,statusText:response.statusText,headers:response.headers});
 }});
 return client.systemOne({model:input.model,state:input.state,questions:input.questions},{signal:input.signal,timeout:input.timeoutMs,retry:{maxRetries:0}});
}
