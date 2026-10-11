/** PROPOSED E2-10: audio content part for the multimodal gateway. Parsing does not authorize a provider call. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';

export const AUDIO_CHAT_CONTRACT_VERSION = 1;
/** Local pilot bound; not a provider allowance. */
export const AUDIO_CHAT_MAX_DURATION_MS = 600_000;
export const AUDIO_CHAT_FORMATS = Object.freeze({mp3:'audio/mpeg',wav:'audio/wav',pcm16:'audio/pcm16',opus:'audio/opus'});
export const AUDIO_CHAT_DIRECTIONS = Object.freeze(['input','output']);
/** `transcript` mirrors the modern input_audio field: a known text rendering of the audio, when the provider supplies one. */
const fail = () => {throw new Error('audio_chat_part_invalid');};
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/**
 * The part references an authorized workspace artifact by identity, never a path, URL or inline payload.
 * Optional `transcript`, `sampleRate` and `channels` carry provider-known metadata without inventing content.
 */
export function parseAudioChatPart(value) {
  if (!keys(value, ['artifactRef','direction','durationMs','format'], ['channels','sampleRate','transcript'])) fail();
  if (!AUDIO_CHAT_DIRECTIONS.includes(value.direction) || !Object.hasOwn(AUDIO_CHAT_FORMATS,value.format)) fail();
  if (!Number.isSafeInteger(value.durationMs) || value.durationMs < 0 || value.durationMs > AUDIO_CHAT_MAX_DURATION_MS) fail();
  if (Object.hasOwn(value,'transcript') && (typeof value.transcript !== 'string' || value.transcript.length > 20000)) fail();
  if (Object.hasOwn(value,'sampleRate') && (!Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 48000)) fail();
  if (Object.hasOwn(value,'channels') && ![1,2].includes(value.channels)) fail();
  const ref = value.artifactRef;
  if (!keys(ref, ['artifactId','byteLength','mediaType','sha256'])) fail();
  if (typeof ref.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(ref.artifactId)) fail();
  if (typeof ref.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(ref.sha256)) fail();
  if (!Number.isSafeInteger(ref.byteLength) || ref.byteLength < 1) fail();
  if (ref.mediaType !== AUDIO_CHAT_FORMATS[value.format]) fail();
  return Object.freeze({...value, artifactRef:Object.freeze({...ref})});
}
export function canonicalAudioChatPartPayload(value) {return canonicalJson(parseAudioChatPart(value));}
