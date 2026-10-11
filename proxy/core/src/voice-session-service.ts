import {randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {
  parseVoiceSession, parseVoiceEvent, assertMonotonicVoiceEvents,
  VOICE_SESSION_MAX_BUFFERED_AUDIO_MS,
  type VoiceSession, type VoiceEvent,
} from '@uptokey/sync-contract/voice-session';

export class VoiceSessionError extends Error {
  readonly outcome:'not_sent'|'unknown'; readonly code:string;
  constructor(code:string,outcome:'not_sent'|'unknown'='not_sent'){super(code);this.code=code;this.outcome=outcome;}
}

/** A transport moves frames and provider events. It never receives or exposes the provider credential. */
export interface VoiceTransportHandlers {
  onEvent(event:unknown):void;
  onClose(reason:'provider_closed'|'transport_failed'):void;
}
export interface VoicePlayback {itemId:string;audioEndMs:number;}
export interface VoiceTransport {
  open(session:VoiceSession,handlers:VoiceTransportHandlers):Promise<void>;
  sendAudio(frame:Uint8Array):Promise<void>;
  commitInput():Promise<void>;
  interrupt(playback?:VoicePlayback):Promise<void>;
  close():Promise<void>;
}
export interface VoiceAuthority {principalId:string;projectId:string;sessionId:string;runId:string;}
export interface VoiceTransportFactory { create(profileRevision:number,authority?:VoiceAuthority):VoiceTransport; }

/**
 * Normalized, provider-agnostic event vocabulary. Only the mapped types are persisted; an unknown provider event is
 * dropped rather than invented. This is the single adapter point a real provider mapping must use.
 */
const PROVIDER_EVENT_MAP:Readonly<Record<string,string>> = Object.freeze({
  'session.created':'session_ready','session.updated':'session_ready',
  'input_audio_buffer.committed':'input_committed',
  'input_audio_buffer.speech_started':'speech_started','input_audio_buffer.speech_stopped':'speech_stopped',
  'conversation.item.input_audio_transcription.delta':'transcript_delta',
  'conversation.item.input_audio_transcription.completed':'transcript_final',
  'response.created':'response_created','response.done':'response_done',
  'response.output_audio.delta':'audio_chunk','response.output_audio.done':'audio_done',
  'response.output_audio_transcript.delta':'transcript_delta','response.output_audio_transcript.done':'transcript_final',
  'response.function_call_arguments.delta':'function_arguments_delta','response.function_call_arguments.done':'function_arguments_done',
  'conversation.item.truncated':'item_truncated','response.canceled':'turn_interrupted',
  'rate_limits.updated':'rate_limits','error':'error',
});
const stableId = (value:unknown):string|undefined => typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)?value:undefined;
/** Map one provider event to a normalized event; unknown types and malformed records return undefined. */
export function normalizeVoiceProviderEvent(raw:unknown):{type:string;turnId?:string;responseId?:string;itemId?:string;payloadRef?:string}|undefined {
  if(!isDataRecord(raw)||typeof raw.type!=='string')return undefined;
  const type=PROVIDER_EVENT_MAP[raw.type]; if(!type)return undefined;
  return {type,turnId:stableId(raw.turn_id)??stableId(raw.turnId),responseId:stableId(raw.response_id)??(isDataRecord(raw.response)?stableId(raw.response.id):undefined),
    itemId:stableId(raw.item_id)};
}

export type VoiceSessionStatus='ready'|'active'|'closed'|'failed'|'expired';
export interface VoiceSessionRecord {
  readonly schemaVersion:1;
  readonly sessionId:string; readonly runId:string; readonly projectId:string; readonly principalId:string;
  readonly status:VoiceSessionStatus; readonly session:VoiceSession;
  readonly events:readonly VoiceEvent[];
  readonly bufferedAudioMs:number;
  readonly startedAt:string; readonly endedAt:string|null; readonly reason:string|null;
}
export function parseVoiceSessionRecord(value:unknown):VoiceSessionRecord {
 if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='bufferedAudioMs,endedAt,events,principalId,projectId,reason,runId,schemaVersion,session,sessionId,startedAt,status'||value.schemaVersion!==1||!['ready','active','closed','failed','expired'].includes(String(value.status)))throw new VoiceSessionError('voice_record_invalid');
 for(const name of ['sessionId','runId','projectId','principalId'])if(!stableId(value[name]))throw new VoiceSessionError('voice_record_invalid');
 const session=parseVoiceSession(value.session);if(session.instructions!==undefined)throw new VoiceSessionError('voice_record_contains_content');
 const events=assertMonotonicVoiceEvents(value.events);if(events.some(event=>event.sessionId!==value.sessionId||event.runId!==value.runId))throw new VoiceSessionError('voice_record_invalid');
 if(!Number.isSafeInteger(value.bufferedAudioMs)||Number(value.bufferedAudioMs)<0||Number(value.bufferedAudioMs)>VOICE_SESSION_MAX_BUFFERED_AUDIO_MS||typeof value.startedAt!=='string'||!Number.isFinite(Date.parse(value.startedAt))||value.endedAt!==null&&(typeof value.endedAt!=='string'||!Number.isFinite(Date.parse(value.endedAt)))||value.reason!==null&&(typeof value.reason!=='string'||!/^[-a-z0-9_]{1,80}$/.test(value.reason)))throw new VoiceSessionError('voice_record_invalid');
 return Object.freeze({...value,session,events}) as unknown as VoiceSessionRecord;
}
export interface VoiceLivePayload {sequence:number;type:'audio'|'text';speaker:'user'|'assistant';audioBase64?:string;text?:string;itemId?:string;final?:boolean;}
export interface VoiceSessionStore {
  save(record:VoiceSessionRecord):Promise<void>;
  get(principalId:string,projectId:string,sessionId:string):Promise<VoiceSessionRecord|undefined>;
}
/** Pilot store: bounded in-memory journal. A durable store can replace it without changing the supervisor. */
export class MemoryVoiceSessionStore implements VoiceSessionStore {
  private readonly records=new Map<string,VoiceSessionRecord>();
  private key(principalId:string,projectId:string,sessionId:string){return JSON.stringify([principalId,projectId,sessionId]);}
  async save(record:VoiceSessionRecord):Promise<void>{this.records.set(this.key(record.principalId,record.projectId,record.sessionId),record);}
  async get(principalId:string,projectId:string,sessionId:string):Promise<VoiceSessionRecord|undefined>{return this.records.get(this.key(principalId,projectId,sessionId));}
}

export interface VoiceSessionSupervisorOptions {
  profile?:VoiceProfile|(()=>VoiceProfile|Promise<VoiceProfile>);
  transports:VoiceTransportFactory;
  store?:VoiceSessionStore;
  now?:()=>Date;
  maxSessions?:number;
  maxEvents?:number;
  /** Hard ceiling regardless of the requested maxDurationMs; never above the contract pilot bound. */
  maxDurationMs?:number;
}
export interface VoiceProfile {model:string;connectionId?:string;profileRevision:number;provider:'openai';configured:boolean;voices:readonly string[];
 budgetRequired?:boolean;budgetReady?:boolean;budgetReason?:string;budgetLimits?:{maxPostInstructionsTokens:number;maxOutputTokens:number};reservationMicros?:string;}
interface ActiveSession { record:VoiceSessionRecord; transport:VoiceTransport; timer:NodeJS.Timeout; closed:boolean; currentTurnId:string; pending:Promise<void>;payloads:Array<VoiceLivePayload&{at:number}>;responseId?:string;audioItems:Map<string,number>; }
const DEFAULT_MAX_EVENTS=4096;

/**
 * Governed realtime session supervisor. It owns session lifetime, event normalization and durable replay; the transport
 * owns the wire. Frames are never persisted and reload only returns already-durable events, so a reconnect cannot
 * replay audio or re-run a tool call. The provider credential is resolved outside this module.
 */
export class VoiceSessionSupervisor {
  private readonly getProfile:()=>VoiceProfile|Promise<VoiceProfile>;
  private readonly transports:VoiceTransportFactory;
  private readonly store:VoiceSessionStore;
  private readonly now:()=>Date;
  private readonly maxSessions:number;
  private readonly maxEvents:number;
  private readonly maxDurationMs:number;
  private readonly active=new Map<string,ActiveSession>();
  constructor(options:VoiceSessionSupervisorOptions){
    this.getProfile=typeof options.profile==='function'?options.profile:()=>options.profile as VoiceProfile ?? {model:'',profileRevision:1,provider:'openai',configured:false,voices:[]};
    this.transports=options.transports; this.store=options.store??new MemoryVoiceSessionStore(); this.now=options.now??(()=>new Date());
    this.maxSessions=options.maxSessions??4; this.maxEvents=options.maxEvents??DEFAULT_MAX_EVENTS;
    this.maxDurationMs=options.maxDurationMs??600_000;
  }
  async profile():Promise<VoiceProfile>{return this.getProfile();}
  private key(principalId:string,projectId:string,sessionId:string){return JSON.stringify([principalId,projectId,sessionId]);}
  private snapshot(record:VoiceSessionRecord):VoiceSessionRecord{return Object.freeze({...record,events:Object.freeze([...record.events])});}

  async start(principalId:string,projectId:string,input:unknown,authority?:{runId:string}):Promise<VoiceSessionRecord>{
    const session=parseVoiceSession(input);
    if(session.maxDurationMs>this.maxDurationMs)throw new VoiceSessionError('voice_duration_exceeds_profile');
    if(this.active.size>=this.maxSessions)throw new VoiceSessionError('voice_session_limit');
    if(authority&&!stableId(authority.runId))throw new VoiceSessionError('voice_authority_invalid');
    const sessionId=randomUUID(),runId=authority?.runId??randomUUID(),transport=this.transports.create(session.profileRevision,{principalId,projectId,sessionId,runId});
    const {instructions:_instructions,...metadataSession}=session;
    let record:VoiceSessionRecord={schemaVersion:1,sessionId,runId,projectId,principalId,status:'ready',session:metadataSession,events:Object.freeze([]),
      bufferedAudioMs:0,startedAt:this.now().toISOString(),endedAt:null,reason:null};
    const timer=setTimeout(()=>{void this.finish(sessionId,'expired','max_duration');},session.maxDurationMs);
    // Never let a session deadline keep the daemon alive on its own.
    if(typeof (timer as {unref?:()=>void}).unref==='function')(timer as {unref:()=>void}).unref();
    const entry:ActiveSession={record,transport,timer,closed:false,currentTurnId:randomUUID(),pending:Promise.resolve(),payloads:[],audioItems:new Map()};
    this.active.set(this.key(principalId,projectId,sessionId),entry);
    try{
      await this.store.save(record);
      await transport.open(session,{onEvent:event=>{entry.pending=entry.pending.then(()=>this.onProviderEvent(sessionId,event)).catch(()=>this.finish(sessionId,'failed','event_invalid'));},onClose:reason=>{void this.finish(sessionId,reason==='provider_closed'?'closed':'failed',reason);}});
      await entry.pending;
      if(entry.closed)throw new VoiceSessionError('voice_transport_closed','unknown');
      record=await this.record(entry,{type:'session_ready',turnId:entry.currentTurnId,direction:'server'});
      entry.record=Object.freeze({...record,status:'active'});await this.store.save(entry.record);
    }catch(error){await this.finish(sessionId,'failed','voice_connect_failed');
      if(process.env.UPTOKEY_VOICE_DEBUG==='1'&&!(error instanceof VoiceSessionError))process.stderr.write(`voice open error: ${String((error as Error)?.stack??error).replace(/sk-[A-Za-z0-9_*-]+/g,'[key]').slice(0,600)}\n`);
      throw error instanceof VoiceSessionError?error:new VoiceSessionError('voice_transport_failed');}
    return this.snapshot(entry.record);
  }

  private async record(entry:ActiveSession,input:{type:string;turnId?:string;direction?:'client'|'server';responseId?:string;itemId?:string;payloadRef?:string;usage?:Record<string,number>}):Promise<VoiceSessionRecord>{
    const next=parseVoiceEvent({sessionId:entry.record.sessionId,runId:entry.record.runId,sequence:entry.record.events.length,
      turnId:input.turnId??entry.currentTurnId,type:input.type,direction:input.direction??'server',
      ...(input.responseId?{responseId:input.responseId}:{}),...(input.itemId?{itemId:input.itemId}:{}),
      ...(input.payloadRef?{payloadRef:input.payloadRef}:{}),...(input.usage?{usage:input.usage}:{})});
    let events:readonly VoiceEvent[];
    try{events=assertMonotonicVoiceEvents([...entry.record.events,next]);}catch{throw new VoiceSessionError('voice_event_sequence_invalid');}
    entry.record=Object.freeze({...entry.record,events:Object.freeze(events)});
    await this.store.save(entry.record);
    if(events.length>this.maxEvents){await this.finish(entry.record.sessionId,'closed','event_limit');}
    return entry.record;
  }

  private async onProviderEvent(sessionId:string,raw:unknown):Promise<void>{
    const entry=this.find(sessionId); if(!entry||entry.closed)return;
    const normalized=normalizeVoiceProviderEvent(raw); if(!normalized)return;
    try{
      if(entry.record.events.length>=Math.min(this.maxEvents,4096)-1){await this.finish(sessionId,'closed','event_limit');return;}
      if(normalized.type==='input_committed'||normalized.type==='speech_started')entry.currentTurnId=randomUUID();
      const wasResponding=Boolean(entry.responseId);
      if(normalized.type==='response_created')entry.responseId=normalized.responseId??entry.currentTurnId;
      if(normalized.type==='response_done'||normalized.type==='turn_interrupted')entry.responseId=undefined;
      await this.record(entry,{...normalized,turnId:normalized.turnId??entry.currentTurnId});
      if(normalized.type==='error'){const code=isDataRecord(raw)&&typeof raw.code==='string'&&/^(?:budget|account_funding|voice)_[a-z_]{1,60}$/.test(raw.code)?raw.code:'provider_error';await this.finish(sessionId,'failed',code);return;}
      if(isDataRecord(raw)){
        const sequence=entry.record.events.at(-1)!.sequence,at=Date.now(),speaker=String(raw.type).startsWith('conversation.item.input_')?'user' as const:'assistant' as const;
        let payload:VoiceLivePayload|undefined;
        if(normalized.type==='audio_chunk'&&typeof raw.delta==='string'&&raw.delta.length<=128000&&/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(raw.delta))payload={sequence,type:'audio',speaker:'assistant',audioBase64:raw.delta,...(normalized.itemId?{itemId:normalized.itemId}:{})};
        const text=normalized.type==='transcript_delta'?raw.delta:normalized.type==='transcript_final'?raw.transcript:undefined;
        if(typeof text==='string'&&text.length<=16000)payload={sequence,type:'text',speaker,text,final:normalized.type==='transcript_final'};
        entry.payloads=entry.payloads.filter(item=>at-item.at<10000);
        if(payload){entry.payloads.push({...payload,at});while(entry.payloads.length>128||JSON.stringify(entry.payloads).length>1_048_576)entry.payloads.shift();}
        if(payload?.type==='audio'&&payload.itemId){entry.audioItems.set(payload.itemId,(entry.audioItems.get(payload.itemId)??0)+Buffer.from(payload.audioBase64!,'base64').length/48);while(entry.audioItems.size>16)entry.audioItems.delete(entry.audioItems.keys().next().value!);}
      }
      // Barge-in: user speech while a response is pending interrupts it when the profile allows it; the interruption is
      // recorded after the detected speech so the durable order reflects what actually happened.
      if(normalized.type==='speech_started'&&entry.record.session.interruptResponse===true&&wasResponding){
        entry.record=Object.freeze({...entry.record,bufferedAudioMs:0});try{await entry.transport.interrupt();}catch{}
        await this.record(entry,{type:'turn_interrupted',turnId:entry.currentTurnId,direction:'client'});
      }
    }catch{await this.finish(sessionId,'failed','event_invalid');}
  }

  async appendAudio(principalId:string,projectId:string,sessionId:string,frame:Uint8Array,audioMs:number):Promise<void>{
    const entry=this.require(principalId,projectId,sessionId);
    if(!(frame instanceof Uint8Array)||!frame.byteLength||frame.byteLength>192000||!Number.isSafeInteger(audioMs)||audioMs<1||audioMs>VOICE_SESSION_MAX_BUFFERED_AUDIO_MS)throw new VoiceSessionError('voice_frame_invalid');
    if(entry.record.session.codec==='pcm16'&&(frame.byteLength%2!==0||Math.round(frame.byteLength*500/entry.record.session.sampleRate)!==audioMs))throw new VoiceSessionError('voice_frame_duration_mismatch');
    if(entry.record.bufferedAudioMs+audioMs>VOICE_SESSION_MAX_BUFFERED_AUDIO_MS)throw new VoiceSessionError('voice_backpressure');
    entry.record=Object.freeze({...entry.record,bufferedAudioMs:entry.record.bufferedAudioMs+audioMs});
    try{await entry.transport.sendAudio(frame);}catch(error){throw error instanceof VoiceSessionError?error:new VoiceSessionError('voice_transport_failed');}
    finally{entry.record=Object.freeze({...entry.record,bufferedAudioMs:Math.max(0,entry.record.bufferedAudioMs-audioMs)});}
  }
  async commitInput(principalId:string,projectId:string,sessionId:string):Promise<void>{
    const entry=this.require(principalId,projectId,sessionId);
    try{await entry.transport.commitInput();}catch{throw new VoiceSessionError('voice_transport_failed');}
  }
  async interrupt(principalId:string,projectId:string,sessionId:string,playback?:VoicePlayback):Promise<void>{
    const entry=this.require(principalId,projectId,sessionId);
    if(playback&&(!stableId(playback.itemId)||!Number.isSafeInteger(playback.audioEndMs)||playback.audioEndMs<0||!entry.audioItems.has(playback.itemId)||playback.audioEndMs>Math.ceil(entry.audioItems.get(playback.itemId)!)))throw new VoiceSessionError('voice_playback_invalid');
    entry.record=Object.freeze({...entry.record,bufferedAudioMs:0});
    try{await entry.transport.interrupt(playback);}catch{throw new VoiceSessionError('voice_transport_failed');}
    await this.record(entry,{type:'turn_interrupted',turnId:entry.currentTurnId,direction:'client'});
  }
  async stop(principalId:string,projectId:string,sessionId:string):Promise<VoiceSessionRecord>{
    const active=this.active.get(this.key(principalId,projectId,sessionId));
    if(!active||active.closed){const saved=await this.reload(principalId,projectId,sessionId);if(saved)return saved.record;throw new VoiceSessionError('voice_session_missing');}
    const entry=active;
    await this.finish(sessionId,'closed','client_stop');
    return this.snapshot(entry.record);
  }
  /** Durable replay only: returns persisted events after `after`; never re-sends frames or re-runs a tool call. */
  async reload(principalId:string,projectId:string,sessionId:string,after=0):Promise<{record:VoiceSessionRecord;events:readonly VoiceEvent[];done:boolean}|undefined>{
    if(!Number.isSafeInteger(after)||after<0)throw new VoiceSessionError('voice_cursor_invalid');
    let record=await this.store.get(principalId,projectId,sessionId); if(!record)return undefined;
    if(['ready','active'].includes(record.status)&&!this.find(sessionId)){record={...record,status:'failed',endedAt:this.now().toISOString(),reason:'daemon_restarted',bufferedAudioMs:0};await this.store.save(record);}
    const events=Object.freeze(record.events.filter(event=>event.sequence>=after));
    return {record:this.snapshot(record),events,done:['closed','failed','expired'].includes(record.status)};
  }
  /** Ephemeral playback is available only while this process owns the session. */
  async live(principalId:string,projectId:string,sessionId:string,after=0){
    const page=await this.reload(principalId,projectId,sessionId,after);if(!page)return undefined;
    const entry=this.active.get(this.key(principalId,projectId,sessionId));
    const payloads=entry?.payloads.filter(item=>item.sequence>=after&&Date.now()-item.at<10000).map(({at:_at,...payload})=>payload)??[];
    return {...page,payloads,nextSequence:page.record.events.length};
  }
  private find(sessionId:string):ActiveSession|undefined{for(const entry of this.active.values())if(entry.record.sessionId===sessionId)return entry;return undefined;}
  private require(principalId:string,projectId:string,sessionId:string):ActiveSession{
    const entry=this.active.get(this.key(principalId,projectId,sessionId));
    if(!entry||entry.closed)throw new VoiceSessionError('voice_session_missing');
    return entry;
  }
  private async finish(sessionId:string,status:Exclude<VoiceSessionStatus,'ready'|'active'>,reason:string):Promise<void>{
    const entry=this.find(sessionId); if(!entry||entry.closed)return;
    entry.closed=true;clearTimeout(entry.timer);
    entry.record=Object.freeze({...entry.record,status,endedAt:this.now().toISOString(),reason});
    try{await entry.transport.close();}catch{}
    try{await this.record(entry,{type:'session_closed',turnId:entry.currentTurnId,direction:'server'});}catch{}
    await this.store.save(entry.record);
    this.active.delete(this.key(entry.record.principalId,entry.record.projectId,sessionId));
  }
  async close():Promise<void>{for(const entry of [...this.active.values()])await this.finish(entry.record.sessionId,'closed','daemon_stopped');}
  async closeProject(principalId:string,projectId:string):Promise<void>{for(const entry of [...this.active.values()])if(entry.record.principalId===principalId&&entry.record.projectId===projectId)await this.finish(entry.record.sessionId,'closed','project_deleted');}
}

export {OpenAIRealtimeTransport as WebSocketVoiceTransport} from './voice-realtime-transport.ts';
export type {RealtimeSocket as WebSocketLike} from './voice-realtime-transport.ts';

/** Deterministic fake transport for the pilot and tests. It emits scripted provider events and records sent frames. */
export class ScriptedVoiceTransport implements VoiceTransport {
  readonly frames:Uint8Array[]=[]; readonly commands:string[]=[];
  private handlers?:VoiceTransportHandlers; private readonly script:readonly unknown[]; private closed=false;
  constructor(script:readonly unknown[]=[]){this.script=script;}
  async open(_session:VoiceSession,handlers:VoiceTransportHandlers):Promise<void>{this.handlers=handlers;}
  /** Emit the configured script in order (caller awaits settle); deterministic for tests and pilots. */
  async runScript():Promise<void>{for(const event of this.script)this.emit(event);}
  async sendAudio(frame:Uint8Array):Promise<void>{if(this.closed)throw new Error('voice_closed');this.frames.push(new Uint8Array(frame));}
  async commitInput():Promise<void>{this.commands.push('commit');}
  async interrupt():Promise<void>{this.commands.push('interrupt');}
  async close():Promise<void>{this.closed=true;}
  emit(event:unknown):void{this.handlers?.onEvent(event);}
}
export class ScriptedVoiceTransportFactory implements VoiceTransportFactory {
  readonly transports:ScriptedVoiceTransport[]=[];
  private readonly script:readonly unknown[];
  constructor(script:readonly unknown[]=[]){this.script=script;}
  create():VoiceTransport{const transport=new ScriptedVoiceTransport(this.script);this.transports.push(transport);return transport;}
}
