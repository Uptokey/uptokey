/** Final wire request v1. Parsing is not authorization; W3 owns admission. */
import { isDataRecord, projectDataArray } from './plain-data.js';
import { canonicalJson } from './canonical.js';

export const GATEWAY_CONTRACT_VERSION = 1;
/** Additive chat revision: sampling, tools and governed audio content parts are part of consent. */
export const GATEWAY_CHAT_CONTRACT_REVISION = 5;
export const GATEWAY_WIRE_MAX_BYTES = 131_072;
export const GATEWAY_CHAT_MAX_BYTES = 12_000;
/** A chat that carries an admitted audio part is bounded by the wire ceiling, not the text-only 12 KB limit. */
export const GATEWAY_CHAT_MULTIMODAL_MAX_BYTES = 120_000;
/** Base64 ceiling for one input_audio part; a longer clip must use the governed transcription adaptation. */
export const GATEWAY_AUDIO_PART_MAX_BYTES = 96_000;
export const GATEWAY_AUDIO_FORMATS = Object.freeze(['wav','mp3','ogg','webm','mp4']);
export const GATEWAY_PREVIEW_MAX_BYTES = 65_536;
export const GATEWAY_TOOL_CONTRACT_VERSION = 1;
export const GATEWAY_TOOL_MAX_COUNT = 16;
export const GATEWAY_TOOL_MAX_BYTES = 65_536;
export const GATEWAY_PROTOCOL_CONTRACT_VERSION = 1;
/** Input envelope only: translation and protocol field validation precede plan creation. */
export function parseGatewayProtocolRequest(input) {
  const invalid=()=>{throw new Error('gateway_protocol_invalid');};
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='body,protocol,schemaVersion'||input.schemaVersion!==1||
    !['openai-responses','anthropic-messages'].includes(input.protocol)||typeof input.body!=='string')invalid();
  if(new TextEncoder().encode(input.body).byteLength>GATEWAY_CHAT_MAX_BYTES||
    new TextDecoder().decode(new TextEncoder().encode(input.body))!==input.body)invalid();
  let body;try{body=JSON.parse(input.body);canonicalJson(body);}catch{invalid();}
  if(!isDataRecord(body))invalid();
  return Object.freeze({...input});
}
const fields = ['schemaVersion', 'driver', 'driverRevision', 'provider', 'model', 'url', 'method', 'headers', 'body'];
const fail = () => { throw new Error('gateway_wire_invalid'); };
export function parseGatewayWireRequest(input) {
  if (!isDataRecord(input) || Object.keys(input).length !== fields.length || fields.some(k => !Object.hasOwn(input, k))) fail();
  if (input.schemaVersion !== 1 || input.driver !== '9router' || typeof input.driverRevision !== 'string' || !/^[a-f0-9]{40}$/.test(input.driverRevision)) fail();
  if (typeof input.provider !== 'string' || !/^openai-compatible-[a-z0-9-]{1,90}$/.test(input.provider)) fail();
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model)) fail();
  if (input.method !== 'POST' || typeof input.url !== 'string' || input.url.length > 2048) fail();
  let url;
  try { url = new URL(input.url); } catch { fail(); }
  if (url.href !== input.url || url.username || url.password || url.hash || url.search ||
      !(url.protocol === 'https:' || (url.protocol === 'http:' && url.hostname === '127.0.0.1')) ||
      !url.pathname.endsWith('/chat/completions')) fail();
  if (!isDataRecord(input.headers) || Object.keys(input.headers).some(k => !['content-type', 'accept'].includes(k)) ||
      input.headers['content-type'] !== 'application/json' ||
      ![undefined, 'application/json', 'text/event-stream'].includes(input.headers.accept)) fail();
  if (typeof input.body !== 'string' || new TextEncoder().encode(input.body).byteLength > GATEWAY_WIRE_MAX_BYTES) fail();
  if (new TextDecoder().decode(new TextEncoder().encode(input.body)) !== input.body) fail();
  let body;
  try { body = JSON.parse(input.body); canonicalJson(body); } catch { fail(); }
  if (!isDataRecord(body) || body.model !== input.model || typeof body.stream !== 'boolean') fail();
  // Preserve exact serialized bytes, not a reserialized approximation of the body.
  return Object.freeze({ ...input, headers: Object.freeze({ ...input.headers }) });
}
export function canonicalGatewayWirePayload(input) {
  return canonicalJson(parseGatewayWireRequest(input));
}

/**
 * Message content is a UTF-8 string or an ordered array of parts. Only `text` and `input_audio` are admitted;
 * `input_audio` mirrors the OpenAI-compatible shape (`{data, format}`) and is bounded so the wire stays inside
 * GATEWAY_WIRE_MAX_BYTES. The artifact that produced the audio is bound separately in the plan provenance.
 */
function chatContent(value) {
  if (typeof value === 'string') {
    if (new TextDecoder().decode(new TextEncoder().encode(value)) !== value) return undefined;
    return value;
  }
  const parts = projectDataArray(value, 8);
  if (!parts?.length) return undefined;
  const parsed = [];
  for (const part of parts) {
    if (!isDataRecord(part) || typeof part.type !== 'string') return undefined;
    if (part.type === 'text') {
      if (Object.keys(part).sort().join(',') !== 'text,type' || typeof part.text !== 'string') return undefined;
      if (new TextDecoder().decode(new TextEncoder().encode(part.text)) !== part.text) return undefined;
      parsed.push(Object.freeze({ type:'text', text:part.text })); continue;
    }
    if (part.type === 'input_audio') {
      if (Object.keys(part).sort().join(',') !== 'input_audio,type' || !isDataRecord(part.input_audio) ||
          Object.keys(part.input_audio).sort().join(',') !== 'data,format') return undefined;
      const { data, format } = part.input_audio;
      if (typeof data !== 'string' || !data.length || data.length > GATEWAY_AUDIO_PART_MAX_BYTES ||
          !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data) ||
          typeof format !== 'string' || !GATEWAY_AUDIO_FORMATS.includes(format)) return undefined;
      parsed.push(Object.freeze({ type:'input_audio', input_audio:Object.freeze({ data, format }) })); continue;
    }
    return undefined;
  }
  return Object.freeze(parsed);
}

/** Approved inference input. Tools describe proposals, never permission to execute. */
export function parseGatewayChatRequest(input) {
  const invalid = () => { throw new Error('gateway_chat_invalid'); };
  const required = ['model', 'messages', 'stream', 'max_tokens'];
  const sampling = ['temperature', 'top_p'];
  const toolFields = ['tools','tool_choice','parallel_tool_calls'];
  if (!isDataRecord(input) || required.some(key => !Object.hasOwn(input, key)) ||
      Object.keys(input).some(key => !required.includes(key) && !sampling.includes(key) && !toolFields.includes(key))) invalid();
  let tools, choice;
  if (Object.hasOwn(input,'tools')) { try { tools=parseGatewayFunctionTools(input.tools); } catch { invalid(); } }
  if (Object.hasOwn(input,'tool_choice')) {
    if (!tools) invalid();
    choice=input.tool_choice;
    if (!['auto','none','required'].includes(choice)) {
      if (!isDataRecord(choice) || Object.keys(choice).sort().join(',')!=='function,type' || choice.type!=='function' ||
          !isDataRecord(choice.function) || Object.keys(choice.function).join(',')!=='name' ||
          !tools.some(tool=>tool.function.name===choice.function.name)) invalid();
      choice=toolCopy(choice);
    }
  }
  if (Object.hasOwn(input,'parallel_tool_calls') && (!tools || typeof input.parallel_tool_calls!=='boolean')) invalid();
  for (const key of sampling) if (Object.hasOwn(input, key) &&
      (typeof input[key] !== 'number' || !Number.isFinite(input[key]) || input[key] < 0 || input[key] > (key === 'temperature' ? 2 : 1))) invalid();
  if (typeof input.model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(input.model) || typeof input.stream !== 'boolean' ||
      !Number.isSafeInteger(input.max_tokens) || input.max_tokens < 1 || input.max_tokens > 4096) invalid();
  const sourceMessages=projectDataArray(input.messages,128);
  if (!sourceMessages?.length) invalid();
  const pending=new Set(),seenCalls=new Set();
  let carriesAudio=false;
  const messages = sourceMessages.map(message => {
    if (!isDataRecord(message)) invalid();
    if(message.role==='assistant'&&Object.hasOwn(message,'tool_calls')){
      if(pending.size||Object.keys(message).sort().join(',')!=='content,role,tool_calls')invalid();
      let proposal;try{proposal=parseGatewayToolProposal({schemaVersion:1,content:message.content,toolCalls:message.tool_calls},tools);}catch{invalid();}
      for(const call of proposal.toolCalls){if(seenCalls.has(call.id))invalid();seenCalls.add(call.id);pending.add(call.id);}
      return Object.freeze({role:'assistant',content:proposal.content,tool_calls:proposal.toolCalls});
    }
    if(message.role==='tool'){
      if(Object.keys(message).sort().join(',')!=='content,role,tool_call_id'||!pending.has(message.tool_call_id)||typeof message.content!=='string')invalid();
      if(new TextDecoder().decode(new TextEncoder().encode(message.content))!==message.content)invalid();
      pending.delete(message.tool_call_id);
      return Object.freeze({role:'tool',content:message.content,tool_call_id:message.tool_call_id});
    }
    if (pending.size||Object.keys(message).sort().join(',') !== 'content,role' ||
        !['system', 'user', 'assistant'].includes(message.role)) invalid();
    const content=chatContent(message.content,invalid);
    if(content===undefined)invalid();
    if(Array.isArray(content)&&content.some(part=>part.type==='input_audio'))carriesAudio=true;
    return Object.freeze({ role: message.role, content });
  });
  if(pending.size)invalid();
  const chat = { model: input.model, messages: Object.freeze(messages), stream: input.stream, max_tokens: input.max_tokens,
    ...(Object.hasOwn(input, 'temperature') ? { temperature: input.temperature } : {}),
    ...(Object.hasOwn(input, 'top_p') ? { top_p: input.top_p } : {}),
    ...(tools?{tools}:{}), ...(choice!==undefined?{tool_choice:choice}:{}),
    ...(Object.hasOwn(input,'parallel_tool_calls')?{parallel_tool_calls:input.parallel_tool_calls}:{}) };
  const bound=carriesAudio?GATEWAY_CHAT_MULTIMODAL_MAX_BYTES:GATEWAY_CHAT_MAX_BYTES;
  if (new TextEncoder().encode(canonicalJson(chat)).byteLength > bound) invalid();
  return Object.freeze(chat);
}
export function canonicalGatewayChatPayload(input) {
  return canonicalJson(parseGatewayChatRequest(input));
}

// These are proposal data, never permissions or executable callbacks.
const toolInvalid = () => { throw new Error('gateway_tool_invalid'); };
const toolName = value => typeof value === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(value);
function toolCopy(value) {
  let serialized;
  try { serialized = canonicalJson(value); } catch { toolInvalid(); }
  if (new TextEncoder().encode(serialized).byteLength > GATEWAY_TOOL_MAX_BYTES) toolInvalid();
  const freeze = item => {
    if (typeof item === 'string' && new TextDecoder().decode(new TextEncoder().encode(item)) !== item) toolInvalid();
    if (item && typeof item === 'object') {
      for (const [key, child] of Object.entries(item)) { freeze(key); freeze(child); }
      Object.freeze(item);
    }
    return item;
  };
  return freeze(JSON.parse(serialized));
}
export function parseGatewayFunctionTools(input) {
  const tools = projectDataArray(input, GATEWAY_TOOL_MAX_COUNT);
  if (!tools?.length) toolInvalid();
  const names = new Set();
  for (const tool of tools) {
    if (!isDataRecord(tool) || Object.keys(tool).sort().join(',') !== 'function,type' || tool.type !== 'function') toolInvalid();
    const fn = tool.function;
    if (!isDataRecord(fn) || !toolName(fn.name) || names.has(fn.name) ||
        !Object.hasOwn(fn, 'parameters') || !isDataRecord(fn.parameters) || fn.parameters.type !== 'object' ||
        Object.keys(fn).some(key => !['name','description','parameters','strict'].includes(key)) ||
        Object.hasOwn(fn,'description') && (typeof fn.description !== 'string' || fn.description.length > 4096) ||
        Object.hasOwn(fn,'strict') && typeof fn.strict !== 'boolean') toolInvalid();
    names.add(fn.name);
  }
  return toolCopy(tools);
}
export function canonicalGatewayFunctionTools(input) {
  return canonicalJson(parseGatewayFunctionTools(input));
}
export function parseGatewayToolProposal(input, approvedTools) {
  const tools = parseGatewayFunctionTools(approvedTools);
  if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== 'content,schemaVersion,toolCalls' ||
      input.schemaVersion !== GATEWAY_TOOL_CONTRACT_VERSION || input.content !== null && typeof input.content !== 'string') toolInvalid();
  const calls = projectDataArray(input.toolCalls, GATEWAY_TOOL_MAX_COUNT);
  if (!calls?.length) toolInvalid();
  const ids = new Set();
  for (const call of calls) {
    if (!isDataRecord(call) || Object.keys(call).sort().join(',') !== 'function,id,type' || call.type !== 'function' ||
        typeof call.id !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(call.id) || ids.has(call.id)) toolInvalid();
    const fn = call.function;
    if (!isDataRecord(fn) || Object.keys(fn).sort().join(',') !== 'arguments,name' ||
        !tools.some(tool => tool.function.name === fn.name) || typeof fn.arguments !== 'string' ||
        new TextEncoder().encode(fn.arguments).byteLength > GATEWAY_TOOL_MAX_BYTES) toolInvalid();
    let args; try { args = JSON.parse(fn.arguments); } catch { toolInvalid(); }
    if (!isDataRecord(args)) toolInvalid();
    toolCopy(args); // Bounded JSON object; capability-specific validation happens before plan creation.
    ids.add(call.id);
  }
  return toolCopy(input); // Retain argument string bytes, including significant whitespace.
}
/** Select immutable persisted data; clients cannot replace proposed arguments. */
export function parseGatewayToolPlanRequest(input) {
  if (!isDataRecord(input) || Object.keys(input).sort().join(',') !== 'artifactId,callId,expectedRevision' ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1 ||
      typeof input.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.artifactId) ||
      typeof input.callId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(input.callId)) toolInvalid();
  return Object.freeze({...input});
}
export function parseGatewayToolResultPlanRequest(input) {
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,resultArtifactId'||
      !Number.isSafeInteger(input.expectedRevision)||input.expectedRevision<1||typeof input.resultArtifactId!=='string'||
      !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input.resultArtifactId))toolInvalid();
  return Object.freeze({...input});
}

/** Ephemeral observation only. A preview never authorizes an effect or replaces its receipt. */
export function parseGatewayRunPreview(input) {
  const invalid=()=>{throw new Error('gateway_preview_invalid');};
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='attemptId,runId,sequence,text,truncated')invalid();
  for(const key of ['attemptId','runId'])if(typeof input[key]!=='string'||!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(input[key]))invalid();
  if(!Number.isSafeInteger(input.sequence)||input.sequence<1||typeof input.text!=='string'||typeof input.truncated!=='boolean')invalid();
  const bytes=new TextEncoder().encode(input.text);
  if(bytes.byteLength>GATEWAY_PREVIEW_MAX_BYTES||new TextDecoder().decode(bytes)!==input.text)invalid();
  return Object.freeze({...input});
}
