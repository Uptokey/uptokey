import type {GatewayChatRequest,GatewayProtocolRequest} from '@uptokey/sync-contract/gateway';
import type {WorkspaceGateway} from '../gateway-service.ts';
import type {GatewayProtocolStream} from '../gateway-protocol-stream.ts';
import type {EffectRequest} from './executor.ts';
import type {JournalRunRecord} from './store.ts';

type StreamRequest=Pick<EffectRequest,'principalId'|'projectId'|'runId'|'attemptId'|'signal'>;
type Slot={attemptId:string;controller:AbortController;stream?:GatewayProtocolStream;queue:Promise<void>;events:string[];bytes:number;done:boolean;failed:boolean};
const MAX=262144;
/** Bounded observation state; never authorizes or dispatches an inference. */
export class ProtocolStreams {
  private readonly gateway:WorkspaceGateway;
  private readonly slots=new Map<string,Slot>();
  private closed=false;
  constructor(gateway:WorkspaceGateway){this.gateway=gateway;}
  private key(principal:string,projectId:string,runId:string){return JSON.stringify([principal,projectId,runId]);}
  private async release(slot:Slot){try{await slot.stream?.close();}catch{/* Observation cannot change execution. */}finally{slot.controller.abort();slot.stream=undefined;}}
  private enqueue(slot:Slot,action:()=>Promise<void>):Promise<void>{
    slot.queue=slot.queue.then(action).catch(async()=>{slot.failed=true;await this.release(slot);});
    return slot.queue;
  }
  private append(slot:Slot,events:string[]){
    if(!Array.isArray(events))throw new Error('gateway_protocol_output_invalid');
    let bytes=0;
    for(const event of events){if(typeof event!=='string'||!event.length)throw new Error('gateway_protocol_output_invalid');bytes+=Buffer.byteLength(event);}
    if(slot.bytes+bytes>MAX||slot.events.length+events.length>MAX)throw new Error('gateway_protocol_output_overflow');
    for(const event of events)slot.events.push(event);slot.bytes+=bytes;
  }
  push(request:StreamRequest,protocol:GatewayProtocolRequest,chat:GatewayChatRequest,chunk:Record<string,unknown>):Promise<void>{
    if(this.closed)return Promise.resolve();
    const key=this.key(request.principalId,request.projectId,request.runId);
    let slot=this.slots.get(key);
    if(!slot){
      if(this.slots.size>=32){const completed=[...this.slots].find(([,entry])=>entry.done||entry.failed);if(completed)this.slots.delete(completed[0]);else return Promise.reject(new Error('gateway_protocol_stream_capacity'));}
      slot={attemptId:request.attemptId,controller:new AbortController(),queue:Promise.resolve(),events:[],bytes:0,done:false,failed:false};this.slots.set(key,slot);
    }
    const current=slot;const input=structuredClone(chunk),tools=chat.tools===undefined?undefined:structuredClone(chat.tools);
    return this.enqueue(current,async()=>{
      if(current.done||current.failed)return;
      if(current.attemptId!==request.attemptId)throw new Error('gateway_protocol_attempt_changed');
      request.signal.throwIfAborted();
      if(!current.stream){
        if(typeof input.id!=='string'||!input.id||!Number.isSafeInteger(input.created)||Number(input.created)<1||typeof input.model!=='string'||!input.model||!this.gateway.openProtocolStream)throw new Error('gateway_protocol_identity_missing');
        current.stream=await this.gateway.openProtocolStream(protocol.protocol,{id:input.id,created:Number(input.created),model:input.model},tools,current.controller.signal);
      }
      request.signal.throwIfAborted();current.controller.signal.throwIfAborted();
      const events=await current.stream.push([input]);current.controller.signal.throwIfAborted();this.append(current,events);
    });
  }
  committed(principal:string,projectId:string,runId:string,record:JournalRunRecord):Promise<void>{
    const slot=this.slots.get(this.key(principal,projectId,runId));if(!slot)return Promise.resolve();
    const snapshot=structuredClone(record);
    return this.enqueue(slot,async()=>{
      if(slot.done||slot.failed)return;
      if(snapshot.run.status==='running')return;
      const receipt=snapshot.receipts.find(item=>item.attemptId===slot.attemptId);
      if(snapshot.run.id!==runId||snapshot.run.projectId!==projectId||snapshot.run.principalId!==principal||snapshot.run.status!=='succeeded'||
          receipt?.status!=='succeeded'||!receipt.outputArtifactRefs.includes(`protocol_${slot.attemptId}`)||!slot.stream)throw new Error('gateway_protocol_run_not_succeeded');
      const events=await slot.stream.finish();slot.controller.signal.throwIfAborted();this.append(slot,events);slot.done=true;await this.release(slot);
    });
  }
  snapshot(principal:string,projectId:string,runId:string,after:number):{events:string[];cursor:number;done:boolean;failed:boolean}|undefined{
    if(!Number.isSafeInteger(after)||after<0)throw new Error('gateway_protocol_cursor_invalid');
    const slot=this.slots.get(this.key(principal,projectId,runId));if(!slot)return undefined;
    if(after>slot.events.length)throw new Error('gateway_protocol_cursor_invalid');
    return {events:slot.events.slice(after),cursor:slot.events.length,done:slot.done,failed:slot.failed};
  }
  async close():Promise<void>{
    this.closed=true;
    // Interrupt open/push/finish now; queued cleanup must not wait for their timeout.
    for(const slot of this.slots.values())slot.controller.abort();
    await Promise.all([...this.slots.values()].map(slot=>this.enqueue(slot,async()=>{if(!slot.done)slot.failed=true;await this.release(slot);})));this.slots.clear();
  }
}
