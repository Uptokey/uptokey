/** Speech-to-text intent, captured request and persisted transcript. Parsing never authorizes an effect. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';
import {WORKFLOW_LIMITS} from './workflow.js';
import {inspectAudioContainer} from './audio-container.js';

export const TRANSCRIPTION_CONTRACT_VERSION = 1;
/** Local bound: min(W0 artifact bound, documented 25 MB OpenAI upload limit). Not a provider allowance. */
export const TRANSCRIPTION_AUDIO_MAX_BYTES = WORKFLOW_LIMITS.artifactBytes;
export const TRANSCRIPT_TEXT_MAX_BYTES = 1_048_576;
export const TRANSCRIPT_SEGMENTS_MAX = 10_000;
/** Speech containers the pinned OpenAI-compatible endpoint accepts; MP3 keeps its own structural walker. */
export const TRANSCRIPTION_AUDIO_MEDIA_TYPES = Object.freeze(['audio/mpeg','audio/wav','audio/ogg','audio/webm','audio/mp4']);
const AUDIO_FILENAME = Object.freeze({'audio/mpeg':'audio.mp3','audio/wav':'audio.wav','audio/ogg':'audio.ogg','audio/webm':'audio.webm','audio/mp4':'audio.mp4'});
const fail = kind => {throw new Error(`transcription_${kind}_invalid`);};
const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const artifactId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const finite = value => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function audioReference(value) {
  if (!keys(value, ['artifactId','sha256','byteLength','mediaType']) || !artifactId(value.artifactId) || !hash(value.sha256) ||
      !Number.isSafeInteger(value.byteLength) || value.byteLength < 1 || value.byteLength > TRANSCRIPTION_AUDIO_MAX_BYTES ||
      !TRANSCRIPTION_AUDIO_MEDIA_TYPES.includes(value.mediaType)) fail('request');
  return Object.freeze({...value});
}

/** The audio is an authorized workspace artifact bound by hash, never a disk path or URL. */
export function parseTranscriptionRequest(value) {
  if (!keys(value, ['schemaVersion','model','audio','timestamps'], ['language']) || value.schemaVersion !== 1) fail('request');
  if (typeof value.model !== 'string' || !/^openai\/[A-Za-z0-9][A-Za-z0-9._:-]{0,198}$/.test(value.model)) fail('request');
  if (typeof value.timestamps !== 'boolean') fail('request');
  if (Object.hasOwn(value, 'language') && (typeof value.language !== 'string' || !/^[a-z]{2}$/.test(value.language))) fail('request');
  return Object.freeze({...value, audio: audioReference(value.audio)});
}
export function canonicalTranscriptionPayload(value) {return canonicalJson(parseTranscriptionRequest(value));}

/** Exact multipart text fields for the pinned OpenAI-compatible STT handler, in wire order. */
export function transcriptionProviderFields(value) {
  const request = parseTranscriptionRequest(value);
  return Object.freeze([['model', request.model.slice('openai/'.length)],
    ...(request.language !== undefined ? [['language', request.language]] : []),
    ['response_format', request.timestamps ? 'verbose_json' : 'json']].map(pair => Object.freeze(pair)));
}

/** Multipart body is materialized by the parent from the hash-verified artifact at dispatch time. */
export function parseTranscriptionWireRequest(value, intent) {
  if (!keys(value, ['schemaVersion','driver','driverRevision','provider','model','url','method','encoding','fields','file']) ||
      value.schemaVersion !== 1 || value.driver !== '9router' || typeof value.driverRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.driverRevision) ||
      typeof value.provider !== 'string' || !/^openai-compatible-[a-z0-9-]{1,90}$/.test(value.provider) || value.method !== 'POST' ||
      value.encoding !== 'multipart/form-data') fail('wire');
  if (typeof value.url !== 'string' || value.url.length > 2048) fail('wire');
  let url;try {url = new URL(value.url);} catch {fail('wire');}
  if (url.href !== value.url || url.username || url.password || url.search || url.hash || url.pathname !== '/v1/audio/transcriptions' ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) fail('wire');
  if (!Array.isArray(value.fields) || value.fields.length > 8 || value.fields.some(pair => !Array.isArray(pair) || pair.length !== 2 ||
      typeof pair[0] !== 'string' || typeof pair[1] !== 'string')) fail('wire');
  if (!keys(value.file, ['field','filename','mediaType','sha256','byteLength']) || value.file.field !== 'file' ||
      !TRANSCRIPTION_AUDIO_MEDIA_TYPES.includes(value.file.mediaType) || value.file.filename !== AUDIO_FILENAME[value.file.mediaType]) fail('wire');
  let request;
  try {
    const language = value.fields.find(pair => pair[0] === 'language')?.[1];
    request = parseTranscriptionRequest({schemaVersion:1, model:`openai/${value.fields.find(pair => pair[0] === 'model')?.[1] ?? ''}`,
      audio:{artifactId:intent?.audio?.artifactId ?? 'unbound', sha256:value.file.sha256, byteLength:value.file.byteLength, mediaType:value.file.mediaType},
      timestamps:value.fields.find(pair => pair[0] === 'response_format')?.[1] === 'verbose_json', ...(language !== undefined ? {language} : {})});
    if (request.model !== value.model || canonicalJson(transcriptionProviderFields(request)) !== canonicalJson(value.fields)) fail('wire');
    if (intent !== undefined && canonicalTranscriptionPayload(intent) !== canonicalTranscriptionPayload(request)) fail('wire');
  } catch {fail('wire');}
  return Object.freeze({...value, fields:Object.freeze(value.fields.map(pair => Object.freeze([...pair]))), file:Object.freeze({...value.file})});
}
export function canonicalTranscriptionWirePayload(value, intent) {return canonicalJson(parseTranscriptionWireRequest(value, intent));}

const MPEG1_L3 = [0,32,40,48,56,64,80,96,112,128,160,192,224,256,320];
const MPEG2_L3 = [0,8,16,24,32,40,48,56,64,80,96,112,128,144,160];
const RATES = {3:[44100,48000,32000], 2:[22050,24000,16000], 0:[11025,12000,8000]};
/**
 * Structural MP3 check before any upload/publication: optional ID3v2, a contiguous run of
 * MPEG Layer III frames ending exactly at EOF (or an ID3v1 tag). Truncation and foreign bytes fail.
 * Does not decode audio and does not prove the content is speech.
 */
export function inspectMp3(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 4 || bytes.byteLength > WORKFLOW_LIMITS.artifactBytes) fail('audio');
  let offset = 0;
  if (bytes[0] === 0x49 && bytes[1] === 0x44 && bytes[2] === 0x33) {
    if (bytes.byteLength < 10 || [6,7,8,9].some(i => bytes[i] & 0x80)) fail('audio');
    offset = 10 + (bytes[6] << 21 | bytes[7] << 14 | bytes[8] << 7 | bytes[9]) + (bytes[5] & 0x10 ? 10 : 0);
  }
  let frames = 0, seconds = 0;
  while (offset < bytes.byteLength) {
    const rest = bytes.byteLength - offset;
    if (frames && rest === 128 && bytes[offset] === 0x54 && bytes[offset+1] === 0x41 && bytes[offset+2] === 0x47) break;
    if (rest < 4 || bytes[offset] !== 0xff || (bytes[offset+1] & 0xe0) !== 0xe0) fail('audio');
    const version = bytes[offset+1] >> 3 & 3, layer = bytes[offset+1] >> 1 & 3;
    const bitrateIndex = bytes[offset+2] >> 4, rateIndex = bytes[offset+2] >> 2 & 3, padding = bytes[offset+2] >> 1 & 1;
    if (version === 1 || layer !== 1 || bitrateIndex === 0 || bitrateIndex === 15 || rateIndex === 3) fail('audio');
    const rate = RATES[version][rateIndex], kbps = (version === 3 ? MPEG1_L3 : MPEG2_L3)[bitrateIndex];
    const length = Math.floor((version === 3 ? 144 : 72) * kbps * 1000 / rate) + padding;
    if (length < 4 || length > rest) fail('audio');
    offset += length;frames++;seconds += (version === 3 ? 1152 : 576) / rate;
  }
  if (!frames) fail('audio');
  return Object.freeze({mediaType:'audio/mpeg', frames, durationSeconds:Math.round(seconds * 1000) / 1000});
}

/**
 * Structural check for any admitted speech container before upload. MP3 uses the frame walker; wav/ogg/webm/mp4 use
 * magic-byte container detection. It does not decode audio and does not prove the content is speech.
 */
export function inspectTranscriptionAudio(bytes, mediaType) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 1 || bytes.byteLength > TRANSCRIPTION_AUDIO_MAX_BYTES) fail('audio');
  if (!TRANSCRIPTION_AUDIO_MEDIA_TYPES.includes(mediaType)) fail('audio');
  if (mediaType === 'audio/mpeg') inspectMp3(bytes);
  else inspectAudioContainer(bytes, mediaType);
  return Object.freeze({mediaType, byteLength:bytes.byteLength});
}

function segment(value) {
  if (!keys(value, ['start','end','text']) || !finite(value.start) || !finite(value.end) || value.end < value.start ||
      typeof value.text !== 'string' || value.text.length > 65536) fail('result');
  return Object.freeze({...value});
}
/** Persisted transcript. Absent language/timestamps stay null; nothing is inferred locally. */
export function parseTranscriptionResult(value) {
  if (!keys(value, ['schemaVersion','text','language','durationSeconds','segments','timestampsRequested','source','model','provider','endpoint','requestDigest','wireDigest','observedAt']) ||
      value.schemaVersion !== 1 || typeof value.text !== 'string' || new TextEncoder().encode(value.text).byteLength > TRANSCRIPT_TEXT_MAX_BYTES ||
      value.language !== null && (typeof value.language !== 'string' || !/^[\p{L}\p{M} _-]{1,64}$/u.test(value.language)) ||
      value.durationSeconds !== null && !finite(value.durationSeconds) || typeof value.timestampsRequested !== 'boolean' ||
      !keys(value.source, ['artifactId','sha256']) || !artifactId(value.source.artifactId) || !hash(value.source.sha256) ||
      typeof value.model !== 'string' || typeof value.provider !== 'string' || typeof value.endpoint !== 'string' ||
      !hash(value.requestDigest) || !hash(value.wireDigest) || typeof value.observedAt !== 'string' || Number.isNaN(Date.parse(value.observedAt))) fail('result');
  if (value.segments !== null && (!Array.isArray(value.segments) || value.segments.length > TRANSCRIPT_SEGMENTS_MAX)) fail('result');
  const segments = value.segments === null ? null : value.segments.map(segment);
  if (segments?.some((item, i) => i > 0 && item.start < segments[i-1].start)) fail('result');
  return Object.freeze({...value, source:Object.freeze({...value.source}), segments:segments && Object.freeze(segments)});
}

/**
 * Maps an OpenAI-compatible json/verbose_json response. Missing text is an invalid response;
 * empty text, unknown language and missing segments are preserved as reported.
 */
export function normalizeTranscriptionResponse(body, request) {
  const intent = parseTranscriptionRequest(request);
  if (!isDataRecord(body) || typeof body.text !== 'string') fail('response');
  const language = typeof body.language === 'string' && /^[\p{L}\p{M} _-]{1,64}$/u.test(body.language) ? body.language : null;
  const durationSeconds = finite(body.duration) ? body.duration : null;
  let segments = null;
  if (intent.timestamps && Array.isArray(body.segments)) {
    if (body.segments.length > TRANSCRIPT_SEGMENTS_MAX) fail('response');
    segments = body.segments.map(item => {
      if (!isDataRecord(item)) fail('response');
      return segment({start:item.start, end:item.end, text:item.text});
    });
    if (segments.some((item, i) => i > 0 && item.start < segments[i-1].start)) fail('response');
  }
  return Object.freeze({text:body.text, language, durationSeconds, segments});
}
