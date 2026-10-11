/** Image intent and captured request. Pure parsing never authorizes an effect. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';
import {WORKFLOW_LIMITS} from './workflow.js';
import {parseMediaInputRef} from './media-profile.js';

export const IMAGE_CONTRACT_VERSION = 1;
export const IMAGE_PROMPT_MAX_BYTES = 12_000;
export const IMAGE_BATCH_MAX = 10;
/** E2-09: declared operation names. The pinned generation wire only executes 'generate'; the rest stay plan-bounded. */
export const IMAGE_OPERATIONS = Object.freeze(['generate','edit','variation']);
const fail = (kind) => {throw new Error(`image_${kind}_invalid`);};
const option = value => typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(value);
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const inputRefs = (value, role, min, max) => {
  if (!Array.isArray(value) || value.length < min || value.length > max ||
      new Set(value.map(item => item?.artifactId)).size !== value.length) fail('input');
  return Object.freeze(value.map(item => { const ref = parseMediaInputRef(item); if (ref.role !== role) fail('input'); return ref; }));
};

/** Bounds are local syntactic limits, not a provider/model capability assertion. */
export function parseImageRequest(value) {
  if (!keys(value, ['schemaVersion','model','n','size'], ['quality','style','prompt','operation','inputRefs','maskRef']) || value.schemaVersion !== 1) fail('request');
  if (typeof value.model !== 'string' || !/^openai\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,198}$/.test(value.model)) fail('request');
  const operation = Object.hasOwn(value, 'operation') ? value.operation : 'generate';
  if (!IMAGE_OPERATIONS.includes(operation)) fail('operation');
  const promptRequired = operation !== 'variation';
  if (Object.hasOwn(value, 'prompt')) {
    if (typeof value.prompt !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value.prompt)) fail('request');
    const bytes = new TextEncoder().encode(value.prompt);
    if (bytes.length > IMAGE_PROMPT_MAX_BYTES || new TextDecoder().decode(bytes) !== value.prompt) fail('request');
    if (promptRequired && !value.prompt.trim()) fail('request');
  } else if (promptRequired) fail('request');
  if (!Number.isSafeInteger(value.n) || value.n < 1 || value.n > IMAGE_BATCH_MAX) fail('request');
  if (value.size !== 'auto') {
    const dimensions = typeof value.size === 'string' && /^([1-9][0-9]{0,4})x([1-9][0-9]{0,4})$/.exec(value.size);
    if (!dimensions || dimensions.slice(1).some(part => Number(part) > 16384)) fail('request');
  }
  for (const name of ['quality','style']) if (Object.hasOwn(value, name) && !option(value[name])) fail('request');
  const bounds = operation === 'variation' ? [1,1] : operation === 'edit' ? [1,2] : [0,0];
  const refs = Object.hasOwn(value, 'inputRefs') ? inputRefs(value.inputRefs, 'image', bounds[0], bounds[1]) : [];
  if (refs.length < bounds[0] || refs.length > bounds[1]) fail('input');
  let maskRef;
  if (Object.hasOwn(value, 'maskRef')) {
    if (operation !== 'edit') fail('mask');
    maskRef = parseMediaInputRef(value.maskRef);
    if (maskRef.role !== 'mask') fail('mask');
  }
  return Object.freeze({...value, operation, inputRefs: refs, ...(maskRef ? {maskRef} : {})});
}

export function canonicalImagePayload(value) {return canonicalJson(parseImageRequest(value));}

/** Exact body for the pinned OpenAI-compatible image adapter. No guessed optional fields. */
export function imageProviderBody(value) {
  const request = parseImageRequest(value);
  if (request.operation !== 'generate') throw new Error('image_operation_unsupported');
  const gpt=/^openai\/gpt-image-[A-Za-z0-9._-]+$/.test(request.model);
  if(gpt&&request.style!==undefined)throw Error('image_style_unsupported');
  return Object.freeze({model:request.model.slice('openai/'.length),prompt:request.prompt,n:request.n,size:request.size,
    ...(request.quality !== undefined ? {quality:request.quality} : {}),
    ...(request.style !== undefined ? {style:request.style} : {}),...(!gpt?{response_format:'b64_json'}:{})});
}

/** Metadata only. Source bytes are loaded by the journal-gated executor, never the adapter. */
export function imageEditBody(value) {
  const request=parseImageRequest(value);
  if(request.operation!=='edit'||!/^openai\/gpt-image-[A-Za-z0-9._-]+$/.test(request.model)||request.style!==undefined)throw Error('image_operation_unsupported');
  const refs=[...request.inputRefs,...(request.maskRef?[request.maskRef]:[])];
  if(refs.some(ref=>!['image/png','image/jpeg','image/webp'].includes(ref.mediaType))||request.maskRef&&request.maskRef.mediaType!=='image/png')fail('input');
  return Object.freeze({request,fields:{model:request.model.slice(7),prompt:request.prompt,n:String(request.n),size:request.size,
    ...(request.quality!==undefined?{quality:request.quality}:{})}});
}

/** Optional intent binds every outbound field to the approved request, including omissions. */
export function parseImageWireRequest(value, intent) {
  if (!keys(value, ['schemaVersion','driver','driverRevision','provider','model','url','method','headers','body']) ||
      value.schemaVersion !== 1 || value.driver !== '9router' || typeof value.driverRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.driverRevision) ||
      typeof value.provider !== 'string' || !/^openai-compatible-[a-z0-9-]{1,90}$/.test(value.provider) || value.method !== 'POST') fail('wire');
  if (typeof value.url !== 'string' || value.url.length > 2048) fail('wire');
  let url;try {url = new URL(value.url);} catch {fail('wire');}
  if (url.href !== value.url || url.username || url.password || url.search || url.hash || !['/v1/images/generations','/v1/images/edits'].includes(url.pathname) ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) fail('wire');
  if(url.pathname==='/v1/images/edits'){
    if(!keys(value.headers,['content-type'])||value.headers['content-type']!=='multipart/form-data'||typeof value.body!=='string'||new TextEncoder().encode(value.body).length>WORKFLOW_LIMITS.commandBytes)fail('wire');
    try{const body=JSON.parse(value.body);if(canonicalJson(imageEditBody(body.request))!==value.body||value.model!==body.request.model||intent!==undefined&&canonicalImagePayload(intent)!==canonicalImagePayload(body.request))fail('wire');}catch{fail('wire');}
    return Object.freeze({...value,headers:Object.freeze({...value.headers})});
  }
  if (!keys(value.headers, ['content-type'], ['accept']) || value.headers['content-type'] !== 'application/json' ||
      (Object.hasOwn(value.headers, 'accept') && value.headers.accept !== 'application/json')) fail('wire');
  if (typeof value.body !== 'string' || new TextEncoder().encode(value.body).length > WORKFLOW_LIMITS.commandBytes) fail('wire');
  let body;try {body = JSON.parse(value.body);} catch {fail('wire');}
  if (!keys(body, ['model','prompt','n','size'], ['quality','style','response_format']) || Object.hasOwn(body,'response_format')&&body.response_format !== 'b64_json') fail('wire');
  try {
    const request = parseImageRequest({schemaVersion:1,model:value.model,prompt:body.prompt,n:body.n,size:body.size,
      ...(Object.hasOwn(body,'quality') ? {quality:body.quality} : {}),...(Object.hasOwn(body,'style') ? {style:body.style} : {})});
    if (canonicalJson(imageProviderBody(request)) !== value.body || intent !== undefined && canonicalImagePayload(intent) !== canonicalImagePayload(request)) fail('wire');
  } catch {fail('wire');}
  return Object.freeze({...value,headers:Object.freeze({...value.headers})});
}

export function canonicalImageWirePayload(value, intent) {return canonicalJson(parseImageWireRequest(value, intent));}

/** Signature classification only: not decoding, integrity verification, or decompression. */
export function detectImageMediaType(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 3 || bytes.byteLength > WORKFLOW_LIMITS.artifactBytes) fail('bytes');
  const starts = signature => signature.every((byte, index) => bytes[index] === byte);
  if (bytes.length >= 8 && starts([137,80,78,71,13,10,26,10])) return 'image/png';
  if (starts([255,216,255])) return 'image/jpeg';
  if (bytes.length >= 12 && starts([82,73,70,70]) && bytes[8] === 87 && bytes[9] === 69 && bytes[10] === 66 && bytes[11] === 80) return 'image/webp';
  fail('bytes');
}
