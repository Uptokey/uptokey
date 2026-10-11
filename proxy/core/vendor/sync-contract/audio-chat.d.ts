export const AUDIO_CHAT_CONTRACT_VERSION:1;
export const AUDIO_CHAT_MAX_DURATION_MS:number;
export type AudioChatFormat='mp3'|'wav'|'pcm16'|'opus';
export type AudioChatDirection='input'|'output';
export const AUDIO_CHAT_FORMATS:Readonly<Record<AudioChatFormat,string>>;
export const AUDIO_CHAT_DIRECTIONS:readonly AudioChatDirection[];
export interface AudioChatPart {
  readonly artifactRef:Readonly<{artifactId:string;sha256:string;byteLength:number;mediaType:string}>;
  readonly format:AudioChatFormat;readonly durationMs:number;readonly direction:AudioChatDirection;
  /** Known text rendering supplied by the provider; never invented locally. */
  readonly transcript?:string;readonly sampleRate?:number;readonly channels?:1|2;
}
export function parseAudioChatPart(value:unknown):AudioChatPart;
export function canonicalAudioChatPartPayload(value:unknown):string;
