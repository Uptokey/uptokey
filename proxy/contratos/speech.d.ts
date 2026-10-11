export const SPEECH_CONTRACT_VERSION: 1;
/** Local byte limit, not a claim about provider limits. */
export const SPEECH_INPUT_MAX_BYTES: 12000;
export interface SpeechRequest {
  readonly schemaVersion: 1;
  /** Full discovered catalog ID; parsing alone does not prove availability. */
  readonly model: string;
  readonly input: string;
}
export function parseSpeechRequest(value: unknown): SpeechRequest;
export function canonicalSpeechPayload(value: unknown): string;
export interface SpeechWireRequest {
  readonly schemaVersion:1;
  readonly driver:'9router';
  readonly driverRevision:string;
  readonly provider:string;
  readonly model:string;
  readonly url:string;
  readonly method:'POST';
  readonly headers:Readonly<{'content-type':'application/json';accept?:'audio/mpeg'}>;
  readonly body:string;
}
export function parseSpeechWireRequest(value:unknown):SpeechWireRequest;
export function canonicalSpeechWirePayload(value:unknown):string;
