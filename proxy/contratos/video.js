/** Video intent, captured creation request and durable job. Parsing grants no authority. */
import {isDataRecord} from './plain-data.js';
import {canonicalJson} from './canonical.js';
import {WORKFLOW_LIMITS} from './workflow.js';
import {parseMediaInputRef} from './media-profile.js';

export const VIDEO_CONTRACT_VERSION = 1;
export const VIDEO_PROMPT_MAX_BYTES = 12_000;
export const VIDEO_POLL_INTERVAL_MS = 30_000;
export const VIDEO_JOB_STATUSES = Object.freeze(['pending','in_progress','completed','failed','cancelled','expired']);
/** Operation derives from a consent-bound public first frame or a local artifact reference. */
export const VIDEO_OPERATIONS = Object.freeze(['text_to_video','image_to_video']);
const fail = kind => {throw new Error(`video_${kind}_invalid`);};
const keys = (v,required,optional=[]) => isDataRecord(v) && required.every(k=>Object.hasOwn(v,k)) && Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
const utf8 = (v,max) => typeof v==='string' && v.trim().length>0 && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v) && new TextEncoder().encode(v).length<=max && new TextDecoder().decode(new TextEncoder().encode(v))===v;
const model = v => typeof v==='string' && /^openrouter\/[A-Za-z0-9][A-Za-z0-9._:/-]{0,198}$/.test(v);
const provider = v => typeof v==='string' && /^openai-compatible-[a-z0-9-]{1,90}$/.test(v);
const hash = v => typeof v==='string' && /^[a-f0-9]{64}$/.test(v);
const jobId = v => utf8(v,512) && !/[\r\n\t]/u.test(v) && v!=='.' && v!=='..';
const date = v => typeof v==='string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v) && Number.isFinite(Date.parse(v)) && new Date(v).toISOString()===v;
/** Public HTTPS reference only. The proxy does not fetch or publish this resource. */
export function parseVideoFrameUrl(value){
 if(typeof value!=='string'||value.length>2048)fail('input');let url;try{url=new URL(value);}catch{fail('input');}
 if(url.href!==value||url.protocol!=='https:'||url.username||url.password||url.hash||url.port||url.hostname.includes(':')||/^[0-9.]+$/.test(url.hostname)||!url.hostname.includes('.')||/(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(url.hostname)||url.hostname.endsWith('.'))fail('input');
 return value;
}

/** Local syntax/size limits do not assert model support or pricing. */
export function parseVideoRequest(v) {
  if(!keys(v,['schemaVersion','model','prompt','duration','aspectRatio','resolution','generateAudio'],['seed','inputRefs','firstFrameUrl']) || v.schemaVersion!==1 || !model(v.model) || !utf8(v.prompt,VIDEO_PROMPT_MAX_BYTES))fail('request');
  if(!Number.isSafeInteger(v.duration)||v.duration<1||v.duration>120||typeof v.generateAudio!=='boolean')fail('request');
  if(typeof v.aspectRatio!=='string'||!/^([1-9][0-9]?):([1-9][0-9]?)$/.test(v.aspectRatio))fail('request');
  if(typeof v.resolution!=='string'||!/^([1-9][0-9]{2,3})p$/.test(v.resolution)||Number(v.resolution.slice(0,-1))<240||Number(v.resolution.slice(0,-1))>4320)fail('request');
  if(Object.hasOwn(v,'seed')&&(!Number.isSafeInteger(v.seed)||v.seed<0||v.seed>0xffffffff))fail('request');
  let inputRefs=[];
  if(Object.hasOwn(v,'inputRefs')){
    if(!Array.isArray(v.inputRefs)||v.inputRefs.length>1||!v.inputRefs.every(item=>{try{const ref=parseMediaInputRef(item);return ref.role==='image';}catch{return false;}}))fail('input');
    inputRefs=Object.freeze(v.inputRefs.map(parseMediaInputRef));
  }
  if(Object.hasOwn(v,'firstFrameUrl')){parseVideoFrameUrl(v.firstFrameUrl);if(inputRefs.length)fail('input');}
  return Object.freeze({...v,inputRefs});
}
export function canonicalVideoPayload(v){return canonicalJson(parseVideoRequest(v));}
/** E2-09: operation is derived from inputRefs; no separate field, no silent default. */
export function videoRequestOperation(v){const r=parseVideoRequest(v);return r.inputRefs.length||r.firstFrameUrl?'image_to_video':'text_to_video';}
export function videoProviderBody(v){const r=parseVideoRequest(v);if(r.inputRefs.length)fail('operation');return Object.freeze({model:r.model.slice('openrouter/'.length),prompt:r.prompt,duration:r.duration,aspect_ratio:r.aspectRatio,resolution:r.resolution,generate_audio:r.generateAudio,...(r.seed===undefined?{}:{seed:r.seed}),...(r.firstFrameUrl?{frame_images:[{type:'image_url',image_url:{url:r.firstFrameUrl},frame_type:'first_frame'}]}:{})});}

export function parseVideoEndpoint(v){
  if(typeof v!=='string'||v.length>2048)fail('endpoint');
  let u;try{u=new URL(v);}catch{fail('endpoint');}
  if(u.href!==v||u.username||u.password||u.search||u.hash||u.pathname!=='/api/v1/videos'||!(u.protocol==='https:'||u.protocol==='http:'&&u.hostname==='127.0.0.1'))fail('endpoint');
  return v;
}
export function parseVideoWireRequest(v,intent){
  if(!keys(v,['schemaVersion','driver','driverRevision','provider','model','url','method','headers','body'])||v.schemaVersion!==1||v.driver!=='9router'||typeof v.driverRevision!=='string'||!/^[a-f0-9]{40}$/.test(v.driverRevision)||!provider(v.provider)||!model(v.model)||v.method!=='POST')fail('wire');
  try{parseVideoEndpoint(v.url);}catch{fail('wire');}
  if(!keys(v.headers,['content-type','accept'])||v.headers['content-type']!=='application/json'||v.headers.accept!=='application/json'||typeof v.body!=='string'||new TextEncoder().encode(v.body).length>WORKFLOW_LIMITS.commandBytes)fail('wire');
  let b,r;try{b=JSON.parse(v.body);}catch{fail('wire');}
  if(!keys(b,['model','prompt','duration','aspect_ratio','resolution','generate_audio'],['seed','frame_images']))fail('wire');
  try{r=parseVideoRequest({schemaVersion:1,model:v.model,prompt:b.prompt,duration:b.duration,aspectRatio:b.aspect_ratio,resolution:b.resolution,generateAudio:b.generate_audio,...(Object.hasOwn(b,'seed')?{seed:b.seed}:{}),...(Object.hasOwn(b,'frame_images')?{firstFrameUrl:b.frame_images?.[0]?.image_url?.url}:{})});}catch{fail('wire');}
  if(canonicalJson(videoProviderBody(r))!==v.body||intent!==undefined&&canonicalVideoPayload(intent)!==canonicalVideoPayload(r))fail('wire');
  return Object.freeze({...v,headers:Object.freeze({...v.headers})});
}
export function canonicalVideoWirePayload(v,intent){return canonicalJson(parseVideoWireRequest(v,intent));}

/** Narrow projection of a provider response; callers must not retain returned URLs or errors. */
export function parseVideoStatus(v){
  if(!keys(v,['jobId','status'])||!jobId(v.jobId)||!VIDEO_JOB_STATUSES.includes(v.status))fail('status');
  return Object.freeze({...v});
}
/** Receipt/run provenance is in Artifact; digests bind this projection to approved intent/wire. */
export function parseVideoJob(v){
  if(!keys(v,['schemaVersion','jobId','status','model','provider','endpoint','requestDigest','wireDigest','observedAt'])||v.schemaVersion!==1||!jobId(v.jobId)||!VIDEO_JOB_STATUSES.includes(v.status)||!model(v.model)||!provider(v.provider)||!hash(v.requestDigest)||!hash(v.wireDigest)||!date(v.observedAt))fail('job');
  try{parseVideoEndpoint(v.endpoint);}catch{fail('job');}
  return Object.freeze({...v});
}
export function canonicalVideoJob(v){return canonicalJson(parseVideoJob(v));}
export function videoJobUrl(endpoint,id,operation){
  parseVideoEndpoint(endpoint);if(!jobId(id)||!['poll','content'].includes(operation))fail('job');
  return `${endpoint}/${encodeURIComponent(id)}${operation==='content'?'/content?index=0':''}`;
}
/**
 * PROPOSED E2-09 VideoDelivery: validated provider ingress event for one durable job.
 * It is state evidence only: it never authorizes a new generation, and a replay or out-of-order
 * event must be rejected by the reconciler through jobId/workspaceId/eventId before it mutates a job.
 */
export function parseVideoDelivery(v){
  if(!keys(v,['schemaVersion','jobId','workspaceId','destinationRef','eventId','status','contentDigest','issuedAt','signature'])||v.schemaVersion!==1||!jobId(v.jobId)||
    !utf8(v.workspaceId,99)||!utf8(v.destinationRef,99)||!utf8(v.eventId,99)||!VIDEO_JOB_STATUSES.includes(v.status)||
    (v.contentDigest!==null&&!hash(v.contentDigest))||!date(v.issuedAt)||typeof v.signature!=='string'||v.signature.length<8||v.signature.length>512||
    !/^[A-Za-z0-9._-]+$/.test(v.signature))fail('delivery');
  return Object.freeze({...v});
}
export function canonicalVideoDelivery(v){return canonicalJson(parseVideoDelivery(v));}
/** ISO BMFF signature classification, not codec/container integrity verification. */
export function detectVideoMediaType(bytes){
  if(!(bytes instanceof Uint8Array)||bytes.length<16||bytes.length>WORKFLOW_LIMITS.videoArtifactBytes)fail('bytes');
  const word=i=>String.fromCharCode(...bytes.subarray(i,i+4));
  const size=new DataView(bytes.buffer,bytes.byteOffset,bytes.byteLength).getUint32(0);
  const brands=new Set(['isom','iso2','iso3','iso4','iso5','iso6','mp41','mp42','avc1','M4V ','dash']);
  if(word(4)!=='ftyp'||size<16||size>bytes.length||size%4!==0)fail('bytes');
  if(!brands.has(word(8))&&!Array.from({length:(size-16)/4},(_,i)=>word(16+i*4)).some(b=>brands.has(b)))fail('bytes');
  return 'video/mp4';
}
