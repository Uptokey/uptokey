export const VOICE_SESSION_CONTRACT_VERSION:1;
export const VOICE_SESSION_MAX_DURATION_MS:number;
export const VOICE_SESSION_MAX_BUFFERED_AUDIO_MS:number;
export type VoiceTransport='websocket'|'webrtc';
export type VoiceCodec='pcm16'|'opus';
export type VoiceTurnPolicy='server_vad'|'push_to_talk';
export type VoiceModality='text'|'audio';
export type VoiceToolChoice='auto'|'none'|'required';
export type VoiceEventType='session_ready'|'session_closed'|'error'|'input_committed'|'speech_started'|'speech_stopped'|
  'transcript_delta'|'transcript_final'|'response_created'|'response_done'|'audio_chunk'|'audio_done'|'turn_interrupted'|
  'item_truncated'|'tool_proposed'|'function_arguments_delta'|'function_arguments_done'|'rate_limits';
export const VOICE_TRANSPORTS:readonly VoiceTransport[];
export const VOICE_CODECS:readonly VoiceCodec[];
export const VOICE_TURN_POLICIES:readonly VoiceTurnPolicy[];
export const VOICE_MODALITIES:readonly VoiceModality[];
export const VOICE_TOOL_CHOICES:readonly VoiceToolChoice[];
export const VOICE_EVENT_TYPES:readonly VoiceEventType[];
export const VOICE_EVENT_DEDUPLICATED:readonly VoiceEventType[];
export interface VoiceSession {
  readonly profileRevision:number;readonly transport:VoiceTransport;readonly codec:VoiceCodec;readonly sampleRate:number;
  readonly maxDurationMs:number;readonly allowedTools:readonly string[];readonly turnPolicy:VoiceTurnPolicy;
  readonly modalities?:readonly VoiceModality[];readonly voice?:string;
  readonly inputAudioFormat?:VoiceCodec;readonly outputAudioFormat?:VoiceCodec;
  readonly instructions?:string;readonly interruptResponse?:boolean;readonly temperature?:number;
  readonly toolChoice?:VoiceToolChoice;readonly maxResponseOutputTokens?:number;
}
export interface VoiceEvent {
  readonly sessionId:string;readonly runId:string;readonly sequence:number;readonly turnId:string;readonly type:VoiceEventType;
  readonly direction?:'client'|'server';readonly responseId?:string;readonly itemId?:string;readonly payloadRef?:string;
  readonly usage?:Readonly<{inputTokens?:number;outputTokens?:number;audioMs?:number}>;
}
export function parseVoiceSession(value:unknown):VoiceSession;
export function canonicalVoiceSessionPayload(value:unknown):string;
export function parseVoiceEvent(value:unknown):VoiceEvent;
export function canonicalVoiceEventPayload(value:unknown):string;
export function assertMonotonicVoiceEvents(events:unknown):readonly VoiceEvent[];
