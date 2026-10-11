import Ws from 'ws';
import {randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import type {VoiceBudgetLimits} from './voice-budget.ts';
import {parseVoiceSession,type VoiceSession} from '@uptokey/sync-contract/voice-session';
import {VoiceSessionError,type VoiceTransport,type VoiceTransportFactory,type VoiceTransportHandlers,type VoicePlayback} from './voice-session-service.ts';

export interface RealtimeSocket {
 readonly readyState:number;readonly bufferedAmount?:number;
 send(data:string):void;close():void;terminate?():void;
 addEventListener(type:string,listener:(event?:any)=>void):void;
 removeEventListener?(type:string,listener:(event?:any)=>void):void;
}
export interface OpenAIRealtimeOptions {
 model:string;profileRevision:number;
 resolveCredential:()=>Promise<string|undefined>;
 funding?:{limits:VoiceBudgetLimits;reserve(turnId:string):Promise<RealtimeTurnReservation>};
 connect?:(url:string,options:{headers:Record<string,string>;handshakeTimeout:number;maxPayload:number;followRedirects:false})=>RealtimeSocket;
}
export interface RealtimeTurnReservation {validate():Promise<void>;compensate():Promise<void>;settleUsage(usage:unknown):Promise<void>;}
export const REALTIME_VOICES=Object.freeze(['alloy','ash','ballad','coral','echo','sage','shimmer','verse','marin','cedar']);
/** Official GA wire; transport, profile and duration are local governance fields. */
export function openAIRealtimeSession(input:VoiceSession,model:string){
 const session=parseVoiceSession(input);
 if(session.transport!=='websocket'||session.codec!=='pcm16'||session.sampleRate!==24000||session.allowedTools.length||session.toolChoice&&session.toolChoice!=='none'||session.inputAudioFormat&&session.inputAudioFormat!=='pcm16'||session.outputAudioFormat&&session.outputAudioFormat!=='pcm16'||session.temperature!==undefined||session.voice&&!REALTIME_VOICES.includes(session.voice))throw new VoiceSessionError('voice_profile_unsupported');
 return {type:'realtime',model,output_modalities:['audio'],tools:[],tool_choice:'none',
  ...(session.instructions?{instructions:session.instructions}:{}),...(session.maxResponseOutputTokens?{max_output_tokens:session.maxResponseOutputTokens}:{}),
  audio:{input:{format:{type:'audio/pcm',rate:24000},turn_detection:session.turnPolicy==='push_to_talk'?null:{type:'server_vad',create_response:true,interrupt_response:session.interruptResponse!==false}},output:{format:{type:'audio/pcm',rate:24000},voice:session.voice??'marin'}}};
}

/** ws is used only in the daemon: BYOK is an Authorization header, never a URL or browser subprotocol. */
export class OpenAIRealtimeTransport implements VoiceTransport {
 private socket?:RealtimeSocket;private opened=false;private closing=false;private pushToTalk=false;private responding=false;
 private readonly options:OpenAIRealtimeOptions;
 private events=Promise.resolve();private activeTurn?:{reservation:RealtimeTurnReservation;responseId?:string;sent:boolean};
 private committed=new Set<string>();private completed=new Set<string>();private waiting:string[]=[];private epoch=0;
 constructor(options:OpenAIRealtimeOptions){this.options=options;}
 async open(session:VoiceSession,handlers:VoiceTransportHandlers){
  const wire=openAIRealtimeSession(session,this.options.model);
  if(this.options.funding){
   const limits=this.options.funding.limits;
   if(session.maxResponseOutputTokens!==undefined&&session.maxResponseOutputTokens>limits.maxOutputTokens)throw new VoiceSessionError('voice_budget_limits_exceeded');
   Object.assign(wire,{instructions:session.instructions??'',max_output_tokens:session.maxResponseOutputTokens??limits.maxOutputTokens,
    truncation:{type:'retention_ratio',retention_ratio:1,token_limits:{post_instructions:limits.maxPostInstructionsTokens}}});
   if(wire.audio.input.turn_detection)Object.assign(wire.audio.input.turn_detection,{create_response:false,interrupt_response:false});
  }
  const credential=await this.options.resolveCredential();if(this.closing)throw new VoiceSessionError('voice_session_closed');if(!credential||/[\r\n]/.test(credential))throw new VoiceSessionError('voice_credential_missing');
  const url=new URL('wss://api.openai.com/v1/realtime');url.searchParams.set('model',this.options.model);
  const connect=this.options.connect??((url,options)=>new Ws(url,options));
  const socket:RealtimeSocket=connect(url.href,{headers:{Authorization:`Bearer ${credential}`},handshakeTimeout:10000,maxPayload:1_048_576,followRedirects:false});this.socket=socket;this.pushToTalk=session.turnPolicy==='push_to_talk';
  try{await new Promise<void>((resolve,reject)=>{
   let settled=false;
   const deadline=setTimeout(()=>complete(new VoiceSessionError('voice_connect_timeout',this.opened?'unknown':'not_sent')),12000);
   const complete=(error?:Error)=>{if(settled)return;settled=true;clearTimeout(deadline);if(error)reject(error);else resolve();};
   const sendUpdate=()=>{this.opened=true;try{socket.send(JSON.stringify({type:'session.update',session:wire}));}catch{complete(new VoiceSessionError('voice_transport_failed','unknown'));}};
   socket.addEventListener('open',sendUpdate);
   socket.addEventListener('message',event=>{
    let raw;try{const text=String(event?.data??'');if(text.length>1_048_576)throw Error();raw=JSON.parse(text);if(!raw||typeof raw!=='object'||Array.isArray(raw)||typeof raw.type!=='string')throw Error();}catch{complete(new VoiceSessionError('voice_provider_event_invalid','unknown'));handlers.onClose('transport_failed');void this.close();return;}
    if(raw.type==='error'){complete(new VoiceSessionError('voice_provider_rejected','unknown'));handlers.onEvent({type:'error'});void this.close();return;}
    if(this.options.funding){
     if(raw.type==='session.updated'){
      const accepted=raw.session,turn=accepted?.audio?.input?.turn_detection;
      if(!isDataRecord(accepted)||accepted.max_output_tokens!==wire.max_output_tokens||accepted.instructions!==wire.instructions
       ||!isDataRecord(accepted.truncation)||accepted.truncation.type!=='retention_ratio'||accepted.truncation.retention_ratio!==1||!isDataRecord(accepted.truncation.token_limits)||accepted.truncation.token_limits.post_instructions!==this.options.funding.limits.maxPostInstructionsTokens
       ||(this.pushToTalk?turn!==null:!turn||turn.create_response!==false||turn.interrupt_response!==false)){
       complete(new VoiceSessionError('voice_budget_limits_unconfirmed'));void this.close();return;
      }
      complete();
     }
     this.events=this.events.then(()=>this.fundedEvent(raw,handlers)).catch(error=>{
      const code=error instanceof Error&&/^(?:budget|account_funding|voice)_[a-z_]{1,60}$/.test(error.message)?error.message:'voice_transport_failed';
      handlers.onEvent({type:'error',code});void this.close();
     });
     return;
    }
    if(raw.type==='session.updated')complete();
    if(raw.type==='response.created')this.responding=true;
    if(raw.type==='response.done'||raw.type==='response.canceled'||raw.type==='input_audio_buffer.speech_started'&&!this.pushToTalk&&session.interruptResponse!==false)this.responding=false;
    handlers.onEvent(raw);
   });
   socket.addEventListener('error',(event:unknown)=>{if(process.env.UPTOKEY_VOICE_DEBUG==='1')process.stderr.write(`voice transport error: ${String((event as {message?:unknown;error?:{message?:unknown}})?.message??(event as {error?:{message?:unknown}})?.error?.message??'unknown').replace(/sk-[A-Za-z0-9_*-]+/g,'[key]').slice(0,300)}\n`);complete(new VoiceSessionError('voice_transport_failed',this.opened?'unknown':'not_sent'));if(!this.closing)handlers.onClose('transport_failed');});
   socket.addEventListener('close',()=>{complete(new VoiceSessionError('voice_transport_closed',this.opened?'unknown':'not_sent'));if(!this.closing)handlers.onClose('provider_closed');});
   if(socket.readyState===1)sendUpdate();
  });}catch(error){await this.close();throw error;}
 }
 private canSend(){if(!this.socket||this.socket.readyState!==1||this.closing)throw new VoiceSessionError('voice_transport_closed');if((this.socket.bufferedAmount??0)>128_000)throw new VoiceSessionError('voice_backpressure');}
 private send(value:object){this.canSend();this.socket!.send(JSON.stringify(value));}
 private async fundedEvent(raw:Record<string,any>,handlers:VoiceTransportHandlers){
  if(raw.type==='response.done'){
   const id=raw.response?.id;
   if(typeof id!=='string'||!id||id.length>100)throw new VoiceSessionError('voice_response_unmatched','unknown');
   if(this.completed.has(id))return;
   const turn=this.activeTurn;
   if(!turn?.sent||turn.responseId!==id)throw new VoiceSessionError('voice_response_unmatched','unknown');
   await turn.reservation.settleUsage(raw.response.usage);
   this.completed.add(id);this.activeTurn=undefined;this.responding=false;
   handlers.onEvent(raw);if(!this.closing)await this.startFundedTurn();return;
  }
  if(this.closing)return;
  if(raw.type==='response.created'){
   const id=raw.response?.id;
   if(typeof id!=='string'||!id||id.length>100||this.completed.has(id)||!this.activeTurn?.sent
    ||this.activeTurn.responseId&&this.activeTurn.responseId!==id)throw new VoiceSessionError('voice_response_unmatched','unknown');
   this.activeTurn.responseId=id;this.responding=true;
  }
  handlers.onEvent(raw);
  if(raw.type==='input_audio_buffer.committed'){
   const id=raw.item_id;
   if(typeof id!=='string'||!id||id.length>100)throw new VoiceSessionError('voice_input_commit_invalid');
   if(this.committed.has(id))return;
   if(this.committed.size>=4096||this.waiting.length>=8)throw new VoiceSessionError('voice_backpressure');
   this.committed.add(id);this.waiting.push(id);await this.startFundedTurn();
  }
 }
 private async startFundedTurn(){
  if(this.closing||this.activeTurn||!this.waiting.length)return;
  this.waiting.shift();const epoch=this.epoch;
  const reservation=await this.options.funding!.reserve(randomUUID());
  try{
   await reservation.validate();
   if(this.closing||this.epoch!==epoch)throw new VoiceSessionError('voice_session_closed');
   this.canSend();
  }catch(error){await reservation.compensate();throw error;}
  // From this point a socket failure is ambiguous; never compensate or retry.
  this.activeTurn={reservation,sent:true};
  this.socket!.send(JSON.stringify({type:'response.create'}));
 }
 async sendAudio(frame:Uint8Array){this.send({type:'input_audio_buffer.append',audio:Buffer.from(frame).toString('base64')});}
 async commitInput(){if(!this.pushToTalk)throw new VoiceSessionError('voice_commit_not_required');this.send({type:'input_audio_buffer.commit'});if(!this.options.funding)this.send({type:'response.create'});}
 async interrupt(playback?:VoicePlayback){this.epoch++;this.waiting=[];if(this.responding||this.activeTurn?.sent){this.send({type:'response.cancel'});this.responding=false;}if(playback)this.send({type:'conversation.item.truncate',item_id:playback.itemId,content_index:0,audio_end_ms:playback.audioEndMs});}
 async close(){this.closing=true;this.epoch++;this.waiting=[];const socket=this.socket;this.socket=undefined;if(socket){try{socket.close();}catch{}if(socket.readyState!==3){const timer=setTimeout(()=>socket.terminate?.(),1000);timer.unref();}}}
}
export function createOpenAIRealtimeFactory(options:OpenAIRealtimeOptions):VoiceTransportFactory{
 if(!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,99}$/.test(options.model)||!Number.isSafeInteger(options.profileRevision)||options.profileRevision<1)throw new VoiceSessionError('voice_profile_invalid');
 return {create(revision){if(revision!==options.profileRevision)throw new VoiceSessionError('voice_profile_changed');return new OpenAIRealtimeTransport(options);}};
}
