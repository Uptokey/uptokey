export const TRANSCRIPTION_CONTRACT_VERSION:1;
/** Local bound; not a provider allowance. */
export const TRANSCRIPTION_AUDIO_MAX_BYTES:number;
export const TRANSCRIPT_TEXT_MAX_BYTES:number;
export const TRANSCRIPT_SEGMENTS_MAX:number;
export type TranscriptionAudioMediaType='audio/mpeg'|'audio/wav'|'audio/ogg'|'audio/webm'|'audio/mp4';
export const TRANSCRIPTION_AUDIO_MEDIA_TYPES:readonly TranscriptionAudioMediaType[];
export interface TranscriptionAudioReference {readonly artifactId:string;readonly sha256:string;readonly byteLength:number;readonly mediaType:TranscriptionAudioMediaType;}
export interface TranscriptionRequest {
  readonly schemaVersion:1;
  /** openai/<opaque model ID>; syntax does not prove model availability. */
  readonly model:string;
  readonly audio:TranscriptionAudioReference;
  /** ISO 639-1 hint; absent means provider detection. */
  readonly language?:string;
  readonly timestamps:boolean;
}
export interface TranscriptionWireRequest {
  readonly schemaVersion:1;readonly driver:'9router';readonly driverRevision:string;readonly provider:string;readonly model:string;
  readonly url:string;readonly method:'POST';readonly encoding:'multipart/form-data';
  readonly fields:readonly (readonly [string,string])[];
  readonly file:Readonly<{field:'file';filename:'audio.mp3'|'audio.wav'|'audio.ogg'|'audio.webm'|'audio.mp4';mediaType:TranscriptionAudioMediaType;sha256:string;byteLength:number}>;
}
export interface TranscriptSegment {readonly start:number;readonly end:number;readonly text:string;}
export interface TranscriptionResult {
  readonly schemaVersion:1;readonly text:string;readonly language:string|null;readonly durationSeconds:number|null;
  readonly segments:readonly TranscriptSegment[]|null;readonly timestampsRequested:boolean;
  readonly source:Readonly<{artifactId:string;sha256:string}>;readonly model:string;readonly provider:string;readonly endpoint:string;
  readonly requestDigest:string;readonly wireDigest:string;readonly observedAt:string;
}
export function parseTranscriptionRequest(value:unknown):TranscriptionRequest;
export function canonicalTranscriptionPayload(value:unknown):string;
export function transcriptionProviderFields(value:unknown):readonly (readonly [string,string])[];
export function parseTranscriptionWireRequest(value:unknown,intent?:unknown):TranscriptionWireRequest;
export function canonicalTranscriptionWirePayload(value:unknown,intent?:unknown):string;
/** Structural MP3 frame walk; rejects truncation and foreign bytes. Does not decode audio. */
export function inspectMp3(bytes:Uint8Array):Readonly<{mediaType:'audio/mpeg';frames:number;durationSeconds:number}>;
/** Structural container check for any admitted speech type before upload. Does not decode audio. */
export function inspectTranscriptionAudio(bytes:Uint8Array,mediaType:TranscriptionAudioMediaType):Readonly<{mediaType:TranscriptionAudioMediaType;byteLength:number}>;
export function parseTranscriptionResult(value:unknown):TranscriptionResult;
export function normalizeTranscriptionResponse(body:unknown,request:unknown):Readonly<{text:string;language:string|null;durationSeconds:number|null;segments:readonly TranscriptSegment[]|null}>;
