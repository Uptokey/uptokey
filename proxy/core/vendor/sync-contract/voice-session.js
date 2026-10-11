/** PROPOSED E2-10: governed realtime voice session intent and ordered events. Parsing never authorizes an effect. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';

export const VOICE_SESSION_CONTRACT_VERSION = 1;
/** Local pilot bound (10 minutes); not a provider allowance. */
export const VOICE_SESSION_MAX_DURATION_MS = 600_000;
/** At most 2 seconds of audio may be queued locally before the session is considered backpressured. */
export const VOICE_SESSION_MAX_BUFFERED_AUDIO_MS = 2_000;
export const VOICE_TRANSPORTS = Object.freeze(['websocket','webrtc']);
export const VOICE_CODECS = Object.freeze(['pcm16','opus']);
export const VOICE_TURN_POLICIES = Object.freeze(['server_vad','push_to_talk']);
export const VOICE_MODALITIES = Object.freeze(['text','audio']);
export const VOICE_TOOL_CHOICES = Object.freeze(['auto','none','required']);
/**
 * Normalized, provider-agnostic vocabulary mapped from an official realtime API. It covers the session lifecycle,
 * turn detection/barge-in, user transcription, response lifecycle, interruption/truncation, tool calls and rate limits.
 * A future adapter maps provider events to exactly one of these; unknown provider events are dropped, never invented.
 */
export const VOICE_EVENT_TYPES = Object.freeze([
  'session_ready','session_closed','error',
  'input_committed','speech_started','speech_stopped',
  'transcript_delta','transcript_final',
  'response_created','response_done','audio_chunk','audio_done',
  'turn_interrupted','item_truncated',
  'tool_proposed','function_arguments_delta','function_arguments_done',
  'rate_limits',
]);
/** Events whose repetition under the same turn would double an effect; deduplicated by the monotonic guard. */
export const VOICE_EVENT_DEDUPLICATED = Object.freeze(['transcript_final','function_arguments_done','response_done']);
const fail = kind => {throw new Error(`voice_session_${kind}_invalid`);};
const stableId = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value);
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));

/**
 * A session is configured before it starts. Required fields describe transport and turn policy; the optional fields
 * mirror the modern realtime `session.update` surface (modalities, voice, formats, instructions, tool choice,
 * interrupt-on-barge-in, output ceiling). The provider credential never travels in this object.
 */
export function parseVoiceSession(value) {
  if (!keys(value, ['allowedTools','codec','maxDurationMs','profileRevision','sampleRate','transport','turnPolicy'],
    ['inputAudioFormat','instructions','interruptResponse','maxResponseOutputTokens','modalities','outputAudioFormat','temperature','toolChoice','voice'])) fail('request');
  if (!Number.isSafeInteger(value.profileRevision) || value.profileRevision < 1) fail('request');
  if (!VOICE_TRANSPORTS.includes(value.transport) || !VOICE_CODECS.includes(value.codec) || !VOICE_TURN_POLICIES.includes(value.turnPolicy)) fail('request');
  if (!Number.isSafeInteger(value.sampleRate) || value.sampleRate < 8000 || value.sampleRate > 48000) fail('request');
  if (!Number.isSafeInteger(value.maxDurationMs) || value.maxDurationMs < 1000 || value.maxDurationMs > VOICE_SESSION_MAX_DURATION_MS) fail('request');
  if (!Array.isArray(value.allowedTools) || value.allowedTools.length > 32 || new Set(value.allowedTools).size !== value.allowedTools.length ||
      value.allowedTools.some(tool => !stableId(tool))) fail('request');
  if (Object.hasOwn(value,'modalities')) {
    if (!Array.isArray(value.modalities) || value.modalities.length < 1 || value.modalities.length > VOICE_MODALITIES.length ||
        new Set(value.modalities).size !== value.modalities.length || value.modalities.some(item => !VOICE_MODALITIES.includes(item))) fail('request');
  }
  if (Object.hasOwn(value,'voice') && (typeof value.voice !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value.voice))) fail('request');
  if (Object.hasOwn(value,'inputAudioFormat') && !VOICE_CODECS.includes(value.inputAudioFormat)) fail('request');
  if (Object.hasOwn(value,'outputAudioFormat') && !VOICE_CODECS.includes(value.outputAudioFormat)) fail('request');
  if (Object.hasOwn(value,'instructions') && (typeof value.instructions !== 'string' || value.instructions.length > 4000)) fail('request');
  if (Object.hasOwn(value,'interruptResponse') && typeof value.interruptResponse !== 'boolean') fail('request');
  if (Object.hasOwn(value,'temperature') && (typeof value.temperature !== 'number' || !Number.isFinite(value.temperature) || value.temperature < 0 || value.temperature > 2)) fail('request');
  if (Object.hasOwn(value,'toolChoice') && !VOICE_TOOL_CHOICES.includes(value.toolChoice)) fail('request');
  if (Object.hasOwn(value,'maxResponseOutputTokens') && (!Number.isSafeInteger(value.maxResponseOutputTokens) || value.maxResponseOutputTokens < 1 || value.maxResponseOutputTokens > 65536)) fail('request');
  return Object.freeze({...value, allowedTools:Object.freeze([...value.allowedTools]), ...(Object.hasOwn(value,'modalities') ? {modalities:Object.freeze([...value.modalities])} : {})});
}
export function canonicalVoiceSessionPayload(value) {return canonicalJson(parseVoiceSession(value));}

/**
 * One ordered session event. `direction` distinguishes the client's committed input from the server's stream.
 * Correlation ids (`turnId`, `responseId`, `itemId`) let a reconnection replay durable events without re-sending frames
 * or re-running a tool call. `usage` is provider-reported audio/token accounting, never a local price.
 */
export function parseVoiceEvent(value) {
  if (!keys(value, ['runId','sequence','sessionId','turnId','type'], ['direction','itemId','payloadRef','responseId','usage'])) fail('event');
  if (!stableId(value.sessionId) || !stableId(value.runId) || !stableId(value.turnId)) fail('event');
  if (!Number.isSafeInteger(value.sequence) || value.sequence < 0 || !VOICE_EVENT_TYPES.includes(value.type)) fail('event');
  if (Object.hasOwn(value,'direction') && !['client','server'].includes(value.direction)) fail('event');
  for (const key of ['itemId','payloadRef','responseId']) if (Object.hasOwn(value,key) && !stableId(value[key])) fail('event');
  if (Object.hasOwn(value,'usage')) {
    if (!keys(value.usage, [], ['audioMs','inputTokens','outputTokens'])) fail('event');
    for (const item of Object.values(value.usage)) if (!Number.isSafeInteger(item) || item < 0) fail('event');
  }
  return Object.freeze({...value, ...(Object.hasOwn(value,'usage') ? {usage:Object.freeze({...value.usage})} : {})});
}
export function canonicalVoiceEventPayload(value) {return canonicalJson(parseVoiceEvent(value));}

/** Correlation id used to deduplicate one event without collapsing legitimate repeats (e.g. a second response in a turn). */
function dedupeKey(event) {
  if (event.type === 'transcript_final') return `${event.type}:${event.itemId ?? event.responseId ?? event.turnId}`;
  if (event.type === 'response_done') return `${event.type}:${event.responseId ?? event.turnId}`;
  if (event.type === 'function_arguments_done') return `${event.type}:${event.itemId ?? event.turnId}`;
  return null;
}
/**
 * Events are sequence-ordered and monotonic. A replayed stream cannot repeat a final transcript, a completed tool
 * call or a completed response for the same correlation id. A repeated sequence fails closed.
 */
export function assertMonotonicVoiceEvents(events) {
  if (!Array.isArray(events) || events.length > 4096) fail('sequence');
  let last = -1; const seen = new Set();
  const parsed = events.map(parseVoiceEvent);
  for (const event of parsed) {
    if (event.sequence <= last) fail('sequence');
    last = event.sequence;
    const key = dedupeKey(event);
    if (key !== null) { if (seen.has(key)) fail('sequence'); seen.add(key); }
  }
  return Object.freeze(parsed);
}
