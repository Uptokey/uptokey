import { randomUUID } from 'node:crypto';
import { readBoundedJson } from '@uptokey/sync-contract/limits';
import { isDataRecord } from '@uptokey/sync-contract/plain-data';
import type { GatewayChatRequest, GatewayProtocolRequest } from '@uptokey/sync-contract/gateway';

export interface ProtocolStreamIdentity { id:string; created:number; model:string }
export type ProtocolStreamCommand =
  | {operation:'open';sessionId:string;protocol:GatewayProtocolRequest['protocol'];identity:ProtocolStreamIdentity;approvedTools?:GatewayChatRequest['tools']}
  | {operation:'push';sessionId:string;chunks:unknown[]}
  | {operation:'finish'|'close';sessionId:string};
export interface GatewayProtocolStream {
  push(chunks:unknown[]):Promise<string[]>;
  /** Caller must first verify the run and receipt committed successfully. */
  finish():Promise<string[]>;
  close():Promise<void>;
}
export type SendProtocolStream = (command:ProtocolStreamCommand,requestId:string,signal:AbortSignal)=>Promise<Response>;

/** Local translation only; intentionally independent of the provider dispatch slot. */
export async function openGatewayProtocolStream(send:SendProtocolStream,protocol:GatewayProtocolRequest['protocol'],identity:ProtocolStreamIdentity,
  approvedTools:GatewayChatRequest['tools']|undefined,signal:AbortSignal):Promise<GatewayProtocolStream> {
  const sessionId=randomUUID(),controller=new AbortController();
  const lifetime=AbortSignal.any([signal,controller.signal,AbortSignal.timeout(120_000)]);
  let busy=false,closed=false,inputBytes=0,outputBytes=0;
  const failed=()=>new Error('gateway_protocol_stream_failed');
  const call=async(command:ProtocolStreamCommand):Promise<string[]>=>{
    if(closed||busy)throw failed();
    busy=true;
    try{
      lifetime.throwIfAborted();
      const encoded=JSON.stringify(command);
      if(Buffer.byteLength(encoded)>131072)throw failed();
      if(command.operation==='push'){
        inputBytes+=command.chunks.reduce<number>((n,chunk)=>n+Buffer.byteLength(JSON.stringify(chunk)),0);
        if(inputBytes>131072)throw failed();
      }
      const response=await send(JSON.parse(encoded),randomUUID(),lifetime);
      const bounded=new Response(response.body?.pipeThrough(new TransformStream(),{signal:lifetime}),{status:response.status,headers:response.headers});
      const result=await readBoundedJson(bounded,262144,30_000);
      lifetime.throwIfAborted();
      if(!response.ok||!result.ok||!isDataRecord(result.value)||Object.keys(result.value).join(',')!=='events'||
        !Array.isArray(result.value.events)||result.value.events.some(event=>typeof event!=='string'))throw failed();
      const events=result.value.events as string[];
      outputBytes+=events.reduce((n,event)=>n+Buffer.byteLength(event),0);
      if(outputBytes>262144)throw failed();
      return events;
    }catch{closed=true;controller.abort();throw failed();}
    finally{busy=false;}
  };
  await call({operation:'open',sessionId,protocol,identity:structuredClone(identity),...(approvedTools?{approvedTools:structuredClone(approvedTools)}:{})});
  return {
    async push(chunks){
      if(!Array.isArray(chunks)||chunks.length<1||chunks.length>32)throw failed();
      return call({operation:'push',sessionId,chunks:structuredClone(chunks)});
    },
    async finish(){try{return await call({operation:'finish',sessionId});}finally{closed=true;controller.abort();}},
    async close(){
      closed=true;controller.abort();
      try{const response=await send({operation:'close',sessionId},randomUUID(),AbortSignal.timeout(5000));await response.body?.cancel();}catch{/* Child TTL also removes abandoned sessions. */}
    },
  };
}
