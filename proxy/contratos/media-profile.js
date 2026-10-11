/** Compatibility descriptor of one configured media profile. Describes configuration, never proves provider support. */
import {isDataRecord} from './plain-data.js';
import {WORKFLOW_LIMITS} from './workflow.js';

export const MEDIA_PROFILE_CONTRACT_VERSION = 1;
export const MANAGED_MEDIA_KINDS = Object.freeze(['image','video','speech','transcription']);
export const MEDIA_MODALITIES = Object.freeze(['speech','image','video','transcription','embeddings']);
export const MEDIA_SUPPORT_LEVELS = Object.freeze(['native','experimental','custom_openai_compatible','research_only']);
/** Declared operation names per modality. A profile may only advertise this subset; the driver still gates execution. */
export const MEDIA_OPERATIONS = Object.freeze({image:Object.freeze(['generate','edit','variation']),video:Object.freeze(['text_to_video','image_to_video'])});
export const MEDIA_INPUT_ROLES = Object.freeze(['image','mask','video','frame']);
const ROLE_MEDIA_TYPES = Object.freeze({image:['image/png','image/jpeg','image/webp'],mask:['image/png'],video:['video/mp4'],frame:['image/png','image/jpeg','image/webp']});
const ENDPOINT_PATHS = Object.freeze({speech:'/v1/audio/speech',image:'/v1/images/generations',video:'/api/v1/videos',
  transcription:'/v1/audio/transcriptions',embeddings:'/v1/embeddings'});
const fail = () => {throw new Error('media_profile_invalid');};
const failInput = () => {throw new Error('media_input_invalid');};
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROVIDER_ID = /^[a-z0-9][a-z0-9._:-]{0,127}$/i;
const keys = (value, required, optional = []) => isDataRecord(value) &&
  required.every(key => Object.hasOwn(value, key)) && Object.keys(value).every(key => required.includes(key) || optional.includes(key));
const count = value => value === null || Number.isSafeInteger(value) && value >= 0;

function configurationProfile(kind, value) {
  const optional = kind === 'image' ? ['editEndpoint'] : kind === 'video' ? ['imageOrigins'] : [];
  const optional2 = kind === 'image' ? ['editEndpoint','providerId'] : kind === 'video' ? ['imageOrigins','providerId'] : ['providerId'];
  if (!MANAGED_MEDIA_KINDS.includes(kind) || !keys(value, ['connectionId','model','endpoint'], optional2) ||
      (value.connectionId !== 'custom' && !UUID.test(value.connectionId)) ||
      (value.connectionId !== 'custom' && (typeof value.providerId !== 'string' || !PROVIDER_ID.test(value.providerId))) ||
      typeof value.model !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.model)) fail();
  const endpoint = (raw, path) => {
    let url; try { url = new URL(raw); } catch { fail(); }
    if (typeof raw !== 'string' || raw !== url.href || url.username || url.password || url.search || url.hash || url.pathname !== path ||
        !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1')) fail();
    return url;
  };
  const url = endpoint(value.endpoint, ENDPOINT_PATHS[kind]);
  if (value.editEndpoint !== undefined && endpoint(value.editEndpoint, '/v1/images/edits').origin !== url.origin) fail();
  if (value.imageOrigins !== undefined && (!Array.isArray(value.imageOrigins) || value.imageOrigins.length > 8 ||
      new Set(value.imageOrigins).size !== value.imageOrigins.length || value.imageOrigins.some(raw => {
        try { const origin = new URL(raw); return typeof raw !== 'string' || origin.protocol !== 'https:' || origin.origin !== raw || origin.username || origin.password; } catch { return true; }
      }))) fail();
  return Object.freeze({...value, ...(value.imageOrigins ? {imageOrigins:Object.freeze([...value.imageOrigins])} : {})});
}

/** Local configuration only: no credentials, grants, project or execution commands. */
export function parseMediaConfigurationRequest(kind, input) {
  const optional = kind === 'image' ? ['editEndpoint'] : kind === 'video' ? ['imageOrigins'] : [];
  const optional2 = kind === 'image' ? ['editEndpoint','providerId'] : kind === 'video' ? ['imageOrigins','providerId'] : ['providerId'];
  if (!keys(input, ['expectedRevision','connectionId','connectionRevision','model','endpoint'], optional2) ||
      !Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0 ||
      typeof input.connectionRevision !== 'string' || !/^[a-f0-9]{64}$/.test(input.connectionRevision) ||
      (input.connectionId !== 'custom' && !UUID.test(input.connectionId)) ||
      (input.connectionId !== 'custom' && (typeof input.providerId !== 'string' || !PROVIDER_ID.test(input.providerId)))) fail();
  const {expectedRevision,connectionRevision,...profile} = input;
  return Object.freeze({expectedRevision,connectionRevision,...configurationProfile(kind, profile)});
}

/** Every saved connection able to serve the kind is listed (D01 v2), not only the legacy custom endpoint. */
const MAX_MEDIA_CONNECTIONS = 64;
function mediaChoice(value, kind) {
  if (!keys(value,['endpoint','models','modelSource'],['editEndpoint']) || !['catalog','manual'].includes(value.modelSource) || !Array.isArray(value.models) || value.models.length>128) fail();
  const endpoint = raw => {let url;try{url=new URL(raw);}catch{fail();}if(url.href!==raw||url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))fail();return url;};
  const url=endpoint(value.endpoint);if(url.pathname!==ENDPOINT_PATHS[kind])fail();
  if(value.editEndpoint!==undefined&&(kind!=='image'||endpoint(value.editEndpoint).origin!==url.origin||endpoint(value.editEndpoint).pathname!=='/v1/images/edits'))fail();
  const models=value.models.map(model=>{if(!keys(model,['id'],['label'])||typeof model.id!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(model.id)||model.label!==undefined&&(typeof model.label!=='string'||model.label.length>120))fail();return Object.freeze({...model});});
  if(new Set(models.map(model=>model.id)).size!==models.length)fail();
  return {...value,models:Object.freeze(models)};
}

export function parseMediaConfigurationInfo(input) {
  if (!keys(input, ['kind','mode','configured','available','profileRevision','profile','connections'], ['error','providers']) ||
      !MANAGED_MEDIA_KINDS.includes(input.kind) || !['managed','startup'].includes(input.mode) ||
      typeof input.configured !== 'boolean' || typeof input.available !== 'boolean' ||
      !Number.isSafeInteger(input.profileRevision) || input.profileRevision < 0 || !Array.isArray(input.connections) || input.connections.length > MAX_MEDIA_CONNECTIONS ||
      input.error !== undefined && (typeof input.error !== 'string' || !/^[a-z][a-z0-9_]{0,99}$/.test(input.error))) fail();
  const connections = input.connections.map(connection => {
    if (!keys(connection, ['id','label','endpointOrigin','revision'], ['providerId','endpoint','models','modelSource','editEndpoint']) || (connection.id !== 'custom' && !UUID.test(connection.id)) || typeof connection.label !== 'string' ||
        connection.label.length > 100 || typeof connection.revision !== 'string' || !/^[a-f0-9]{64}$/.test(connection.revision) ||
        (connection.id !== 'custom' && (typeof connection.providerId !== 'string' || !PROVIDER_ID.test(connection.providerId)))) fail();
    let origin; try { origin = new URL(connection.endpointOrigin); } catch { fail(); }
    if (origin.origin !== connection.endpointOrigin || !(origin.protocol === 'https:' || origin.protocol === 'http:' && origin.hostname === '127.0.0.1')) fail();
    if(connection.endpoint!==undefined){const {endpoint,models,modelSource,editEndpoint}=connection;mediaChoice({endpoint,models,modelSource,...(editEndpoint?{editEndpoint}:{})},input.kind);if(new URL(endpoint).origin!==origin.origin)fail();}
    else if(['models','modelSource','editEndpoint'].some(key=>connection[key]!==undefined))fail();
    return Object.freeze({...connection});
  });
  let providers;
  if(input.providers!==undefined){
    if(!Array.isArray(input.providers)||input.providers.length>64)fail();
    providers=input.providers.map(provider=>{
      if(!keys(provider,['id','label','endpoint','models','modelSource','documentationUrl'],['getKeyUrl','editEndpoint'])||typeof provider.id!=='string'||!PROVIDER_ID.test(provider.id)||typeof provider.label!=='string'||provider.label.length>100)fail();
      for(const key of ['documentationUrl','getKeyUrl'])if(provider[key]!==undefined&&provider[key]!==null){let url;try{url=new URL(provider[key]);}catch{fail();}if(url.protocol!=='https:'||url.username||url.password)fail();}
      const {endpoint,models,modelSource,editEndpoint}=provider;return Object.freeze({...provider,...mediaChoice({endpoint,models,modelSource,...(editEndpoint?{editEndpoint}:{})},input.kind)});
    });
  }
  return Object.freeze({...input, profile:input.profile === null ? null : configurationProfile(input.kind, input.profile), connections:Object.freeze(connections),...(providers?{providers:Object.freeze(providers)}:{})});
}

/**
 * PROPOSED E2-09: reference to an authorized project artifact used as media input.
 * Identity is artifactId + digest + byte count: never an absolute path or signed URL.
 */
export function parseMediaInputRef(value) {
  if (!keys(value, ['artifactId','bytes','mediaType','role','sha256']) ||
      typeof value.artifactId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.artifactId) ||
      typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sha256) ||
      !MEDIA_INPUT_ROLES.includes(value.role) || !ROLE_MEDIA_TYPES[value.role].includes(value.mediaType) ||
      !Number.isSafeInteger(value.bytes) || value.bytes < 1 || value.bytes > WORKFLOW_LIMITS.videoArtifactBytes) failInput();
  if ((value.role === 'image' || value.role === 'mask' || value.role === 'frame') && value.bytes > WORKFLOW_LIMITS.artifactBytes) failInput();
  return Object.freeze({...value});
}

/**
 * cancellation: 'local_abort_only' means aborting stops local observation/transfer; it does not prove
 * the provider stopped work or did not bill. 'none' means no cancel operation is offered.
 */
export function parseMediaProfileDescriptor(value) {
  if (!keys(value, ['schemaVersion','modality','supportLevel','driver','driverRevision','endpoint','destination','models','mode','cancellation',
    'input','output','credential','commercialVerification','termsCheckedAt'], ['operations']) || value.schemaVersion !== 1) fail();
  if (!MEDIA_MODALITIES.includes(value.modality) || !MEDIA_SUPPORT_LEVELS.includes(value.supportLevel) || value.driver !== '9router' ||
      typeof value.driverRevision !== 'string' || !/^[a-f0-9]{40}$/.test(value.driverRevision) ||
      (value.destination !== 'custom' && (typeof value.destination !== 'string' || !PROVIDER_ID.test(value.destination)))) fail();
  let url;try {url = new URL(value.endpoint);} catch {fail();}
  if (url.href !== value.endpoint || url.username || url.password || url.search || url.hash ||
      !(url.protocol === 'https:' || url.protocol === 'http:' && url.hostname === '127.0.0.1') || url.pathname !== ENDPOINT_PATHS[value.modality]) fail();
  if (!Array.isArray(value.models) || value.models.length !== 1 || typeof value.models[0] !== 'string' || value.models[0].length > 200) fail();
  if (!['sync','job'].includes(value.mode) || value.mode === 'job' !== (value.modality === 'video') || !['local_abort_only','none'].includes(value.cancellation)) fail();
  if (!keys(value.input, ['mediaTypes','maxBytes','maxItems']) || !Array.isArray(value.input.mediaTypes) || !value.input.mediaTypes.every(item => typeof item === 'string') ||
      !count(value.input.maxBytes) || !count(value.input.maxItems)) fail();
  if (!keys(value.output, ['mediaTypes','maxBytes','maxItems']) || !Array.isArray(value.output.mediaTypes) || !value.output.mediaTypes.every(item => typeof item === 'string') ||
      !count(value.output.maxBytes) || !count(value.output.maxItems)) fail();
  if ((value.credential !== 'local_vault:provider:custom' && value.credential !== `local_vault:provider:${value.destination}`) || !['not_verified','verified'].includes(value.commercialVerification) ||
      value.termsCheckedAt !== null && (typeof value.termsCheckedAt !== 'string' || Number.isNaN(Date.parse(value.termsCheckedAt)))) fail();
  // A profile configured through a custom OpenAI-compatible endpoint is never promoted to native by a fixture.
  if (value.supportLevel === 'native' && value.commercialVerification !== 'verified') fail();
  const allowedOperations=MEDIA_OPERATIONS[value.modality];
  let operations;
  if(Object.hasOwn(value,'operations')){
    if(!allowedOperations||!Array.isArray(value.operations)||value.operations.length<1||new Set(value.operations).size!==value.operations.length||
      value.operations.some(item=>!allowedOperations.includes(item)))fail();
    operations=Object.freeze([...value.operations]);
  }else if(allowedOperations){
    operations=Object.freeze([allowedOperations[0]]);
  }
  return Object.freeze({...value,...(operations?{operations}:{}), models:Object.freeze([...value.models]), input:Object.freeze({...value.input, mediaTypes:Object.freeze([...value.input.mediaTypes])}),
    output:Object.freeze({...value.output, mediaTypes:Object.freeze([...value.output.mediaTypes])})});
}
