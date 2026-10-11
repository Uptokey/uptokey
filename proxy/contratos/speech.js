/** Local speech intent. Parsing does not authorize a provider call. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';

export const SPEECH_CONTRACT_VERSION = 1;
export const SPEECH_INPUT_MAX_BYTES = 12_000;

/** Model is the full catalog ID, including voice where the upstream adapter encodes it. */
export function parseSpeechRequest(value) {
  const fail=()=>{throw new Error('speech_request_invalid');};
  if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='input,model,schemaVersion'||value.schemaVersion!==1)fail();
  if(typeof value.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.model))fail();
  if(typeof value.input!=='string'||!value.input.trim()||value.input.includes('\0'))fail();
  const bytes=new TextEncoder().encode(value.input);
  if(bytes.byteLength>SPEECH_INPUT_MAX_BYTES||new TextDecoder().decode(bytes)!==value.input)fail();
  return Object.freeze({schemaVersion:SPEECH_CONTRACT_VERSION,model:value.model,input:value.input});
}

export function canonicalSpeechPayload(value) {return canonicalJson(parseSpeechRequest(value));}

/** Exact outbound request captured from the pinned adapter, before any network effect. */
export function parseSpeechWireRequest(value) {
  const fail=()=>{throw new Error('speech_wire_invalid');};
  if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='body,driver,driverRevision,headers,method,model,provider,schemaVersion,url'||
    value.schemaVersion!==1||value.driver!=='9router'||typeof value.driverRevision!=='string'||!/^[a-f0-9]{40}$/.test(value.driverRevision)||
    typeof value.provider!=='string'||!/^openai-compatible-[a-z0-9-]{1,90}$/.test(value.provider)||value.method!=='POST')fail();
  if(typeof value.url!=='string'||value.url.length>2048)fail();
  let url;try{url=new URL(value.url);}catch{fail();}
  if(url.href!==value.url||url.username||url.password||url.search||url.hash||
    !(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1')||!url.pathname.endsWith('/v1/audio/speech'))fail();
  if(!isDataRecord(value.headers)||Object.keys(value.headers).some(key=>!['content-type','accept'].includes(key))||
    value.headers['content-type']!=='application/json'||![undefined,'audio/mpeg'].includes(value.headers.accept))fail();
  if(typeof value.body!=='string'||new TextEncoder().encode(value.body).byteLength>131072)fail();
  let body;try{body=JSON.parse(value.body);}catch{fail();}
  if(!isDataRecord(body)||Object.keys(body).sort().join(',')!=='input,model,voice'||
    typeof body.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(body.model)||
    typeof body.voice!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(body.voice))fail();
  try{parseSpeechRequest({schemaVersion:1,model:value.model,input:body.input});}catch{fail();}
  // Reject duplicate JSON keys/noncanonical representations in the approval envelope.
  if(canonicalJson(body)!==value.body)fail();
  return Object.freeze({...value,headers:Object.freeze({...value.headers})});
}
export function canonicalSpeechWirePayload(value) {return canonicalJson(parseSpeechWireRequest(value));}
