import {randomUUID} from 'node:crypto';
import type {Context,Hono} from 'hono';
import {readBoundedJson,MAX_LOCAL_CONTROL_REQUEST_BYTES} from '@uptokey/sync-contract/limits';
import {createProviderSetupService,PROVIDER_SETUP_PRESETS,ProviderSetupError,type PreparedProviderSetup} from './tui/provider-setup.ts';
import {PROVIDER_NOTICE_MESSAGES} from './tui/provider-notice-ui.ts';
import {normalizeProviderKey} from './provider-lifecycle.ts';
import {ensureProviderEntry,ensureUserDefinedProviderEntry} from './config.ts';
import {isCoreProvider,isOptionalProvider,isUserDefinedProvider,isNamedExperimentalProvider} from './provider-registry.ts';
import {acceptNamedProviderRisk} from './provider-risk.ts';
import {GEMINI_FREE_PRIVACY_NOTICE_VERSION} from './privacy.ts';
import type {ConnectionProfileService,StoredProfile} from './connection-profiles.ts';
import type {SecretStore} from './secret-store.ts';
import type {ProxyConfig,ProviderName} from './types.ts';
import {COMPAT_RUNTIME_DEFAULTS} from './local-runtime/default.ts';
import {PROVIDER_SETUP_CATALOG_PRESETS} from './provider-setup-catalog.ts';

const BASE='/local/provider/setup';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const TTL=5*60_000,MAX_PENDING=16;
const LOCAL_COMPAT=COMPAT_RUNTIME_DEFAULTS.map(runtime=>({id:'custom-'+runtime.id.replace(/\./g,'-'),label:runtime.id,protocol:'openai' as const,local:true,endpointUrl:runtime.endpoint}));
const SAFE=new Set(['provider_unknown','provider_key_required','provider_key_invalid','provider_key_rejected','provider_endpoint_fixed','provider_endpoint_required','endpoint_url_invalid','endpoint_credentials_forbidden','endpoint_https_required','endpoint_protocol_forbidden','endpoint_provider_forbidden','provider_models_invalid','provider_models_empty','provider_models_too_large','provider_discovery_cancelled','provider_discovery_timeout','provider_discovery_rate_limited','provider_discovery_unsupported','provider_discovery_failed','provider_model_invalid','provider_model_not_discovered','provider_credential_in_metadata','provider_notice_required','provider_setup_expired','provider_setup_busy','provider_endpoint_conflict','provider_model_limit','provider_limit_exceeded','connection_limit_exceeded','multiconta_disabled','connection_invalid_label','provider_setup_capacity','unauthorized','provider_setup_invalid_request']);
SAFE.add('provider_setup_rate_limited');
SAFE.add('provider_runtime_unreachable');
SAFE.add('provider_region_or_key_rejected');
for(const code of ['provider_access_denied','provider_key_restricted','provider_service_disabled','provider_billing_required','provider_setup_required','provider_service_unavailable','provider_network_unreachable'])SAFE.add(code);
class SetupHttpError extends Error {readonly code:string;readonly status:400|401|403|409|410|429|502;constructor(code:string,status:400|401|403|409|410|429|502=400){super(code);this.code=code;this.status=status;}}
const fail=(code:string,status?:ConstructorParameters<typeof SetupHttpError>[1]):never=>{throw new SetupHttpError(code,status);};
const record=(v:unknown):Record<string,unknown>=>v!==null&&typeof v==='object'&&!Array.isArray(v)?v as Record<string,unknown>:fail('provider_setup_invalid_request');
const exact=(v:Record<string,unknown>,required:string[],optional:string[]=[])=>required.every(k=>k in v)&&Object.keys(v).every(k=>required.includes(k)||optional.includes(k));
interface Pending {id:string;owner:string;expires:number;controller:AbortController;prepared?:PreparedProviderSetup;key:string;label?:string;operationId:string;created?:StoredProfile;committing?:boolean;result?:{providerId:string;modelId:string;connectionId:string;accountLabel:string;reloaded:true};timer:ReturnType<typeof setTimeout>}
export interface ProviderSetupHttpDeps {
 secrets:SecretStore;profiles:ConnectionProfileService;getConfig:()=>ProxyConfig;
 persist:(mutator:(next:ProxyConfig)=>void,admit?:()=>Promise<void>)=>Promise<ProxyConfig>;
 /** Current authenticated management credential + policy/registration revision + identity epoch digest. */
 authority:(c:Context)=>Promise<string|null>;
 invalidate:(provider:ProviderName)=>Promise<void>;fetchImpl?:typeof fetch;now?:()=>number;
 checkRate:(key:string,limit:number,windowMs:number)=>{ok:boolean;retryAfter:number};
}

/** Existing terminal discovery, separate finite credential-bound preparation, and account-specific vault commit. */
export function registerProviderSetupRoutes(app:Hono,deps:ProviderSetupHttpDeps):void {
 const now=deps.now??Date.now,pending=new Map<string,Pending>();
 function close(item:Pending,remove=true){clearTimeout(item.timer);item.controller.abort();item.prepared?.dispose();item.key='';if(remove)pending.delete(item.id);}
 async function authority(c:Context){const value=await deps.authority(c);if(!value)return fail('unauthorized',401);return value;}
 async function current(c:Context,item:Pending){if(now()>=item.expires){close(item);return fail('provider_setup_expired',410);}if(await authority(c)!==item.owner)return fail('provider_setup_expired',403);if(item.controller.signal.aborted)return fail('provider_setup_expired',410);}
 async function currentCreated(item:Pending){if(!item.created)return;const actual=await deps.profiles.get(item.created.id);if(!actual||actual.revision!==item.created.revision||!actual.enabled||!await deps.profiles.credentialPresent(actual))return fail('provider_setup_expired',410);}
 async function body(c:Context){const parsed=await readBoundedJson(c.req.raw,MAX_LOCAL_CONTROL_REQUEST_BYTES);if(!parsed.ok)return fail('provider_setup_invalid_request');return record(parsed.value);}
 function rate(c:Context){const decision=deps.checkRate('localhost-provider-setup',20,60_000);if(!decision.ok){c.header('Retry-After',String(Math.max(1,Math.min(300,Math.ceil(decision.retryAfter)))));return fail('provider_setup_rate_limited',429);}}
 const route=(fn:(c:Context)=>Promise<Response>)=>async(c:Context)=>{try{await authority(c);return await fn(c);}catch(error){const code=error instanceof SetupHttpError?error.code:error instanceof ProviderSetupError&&SAFE.has(error.code)?error.code:error instanceof Error&&SAFE.has(error.message)?error.message:'provider_setup_failed';const status=error instanceof SetupHttpError?error.status:code==='provider_setup_failed'?502:400;return c.json({error:{type:code}},status);}};
 app.get(BASE+'/presets',route(async c=>c.json({presets:[...PROVIDER_SETUP_PRESETS.map(p=>({id:p.id,label:p.id==='custom'?'Custom endpoint':p.label,protocol:p.protocol,local:p.local,endpointUrl:p.endpointUrl,...(p.discovery?{discovery:p.discovery}:{}),...(p.documentationUrl?{documentationUrl:p.documentationUrl}:{}),...(p.getKeyUrl?{getKeyUrl:p.getKeyUrl}:{}),...(p.endpointRequired?{endpointRequired:true,endpointPlaceholder:p.endpointPlaceholder,endpointHostSuffix:p.endpointHostSuffix}:{}),...(p.modelIds?{modelIds:p.modelIds,modelsReviewedAt:p.modelsReviewedAt}:{})})),...LOCAL_COMPAT]})));
 app.post(BASE+'/prepare',route(async c=>{
  rate(c);const owner=await authority(c),input=await body(c);
  if(!exact(input,['providerId'],['apiKey','customEndpoint','manualModel','label'])||typeof input.providerId!=='string'||input.providerId.length>64||input.apiKey!==undefined&&(typeof input.apiKey!=='string'||input.apiKey.length>512)||input.customEndpoint!==undefined&&(typeof input.customEndpoint!=='string'||input.customEndpoint.length>2048)||input.manualModel!==undefined&&(typeof input.manualModel!=='string'||input.manualModel.length>200)||input.label!==undefined&&(typeof input.label!=='string'||input.label.trim().length>80))return fail('provider_setup_invalid_request');
  const catalog=PROVIDER_SETUP_CATALOG_PRESETS.find(p=>p.id===input.providerId);
  const compatible=LOCAL_COMPAT.find(p=>p.id===input.providerId)??catalog,preset=PROVIDER_SETUP_PRESETS.find(p=>p.id===input.providerId)??compatible;
  if(compatible&&!catalog?.endpointRequired&&input.customEndpoint!==undefined&&input.customEndpoint!==compatible.endpointUrl)return fail('provider_endpoint_fixed');
  if(catalog?.discovery==='manual'&&(!(typeof input.manualModel==='string')||!input.manualModel.trim()))return fail('provider_model_invalid');
  const customEndpoint=catalog?.endpointRequired?input.customEndpoint as string|undefined:compatible?.endpointUrl??input.customEndpoint as string|undefined;
  // New accounts never copy a legacy or another account's saved credential.
  if(!preset?.local&&!(typeof input.apiKey==='string'&&input.apiKey.trim()))return fail('provider_key_required');
  for(const item of pending.values())if(now()>=item.expires)close(item);
  if(pending.size>=MAX_PENDING)return fail('provider_setup_capacity',429);
  const id=randomUUID(),controller=new AbortController(),expires=now()+TTL;
  const item:Pending={id,owner,expires,controller,key:'',label:typeof input.label==='string'?input.label.trim()||undefined:undefined,operationId:randomUUID(),timer:setTimeout(()=>{const item=pending.get(id);if(item)close(item);},TTL)};item.timer.unref?.();pending.set(id,item);
  const aborted=()=>close(item);c.req.raw.signal.addEventListener('abort',aborted,{once:true});
  try{
   item.key=normalizeProviderKey(typeof input.apiKey==='string'?input.apiKey.trim():'',input.providerId as ProviderName,Boolean(preset?.local));
   if(item.key&&item.label?.includes(item.key))return fail('provider_credential_in_metadata');
   const guardedFetch:typeof fetch=async(input,init)=>{
    await current(c,item);
    if(catalog?.id==='custom-siliconflow'&&init?.method==='GET'){
     const url=new URL(String(input));if(url.origin==='https://api.siliconflow.com'&&url.pathname==='/v1/models'){url.searchParams.set('type','text');url.searchParams.set('sub_type','chat');input=url;}
    }
    const response=await (deps.fetchImpl??fetch)(input,init);try{await current(c,item);return response;}catch(error){await response.body?.cancel().catch(()=>undefined);throw error;}
   };
   const discovery=createProviderSetupService({secrets:deps.secrets,loadConfig:async()=>structuredClone(deps.getConfig()),fetch:guardedFetch,reload:async()=>{},updateConfig:async()=>fail('provider_setup_invalid_request')});
   item.prepared=input.manualModel===undefined?await discovery.prepare(input.providerId,item.key,customEndpoint,controller.signal):await discovery.prepareManual(input.providerId,item.key,customEndpoint,input.manualModel as string,controller.signal);
   if(catalog)item.prepared={...item.prepared,label:catalog.label};
   await current(c,item);
   const notices=PROVIDER_NOTICE_MESSAGES[item.prepared.providerId as keyof typeof PROVIDER_NOTICE_MESSAGES];
   return c.json({id,providerId:item.prepared.providerId,label:item.prepared.label,models:item.prepared.models,source:item.prepared.source,notice:notices?.en??null,noticeByLocale:notices??null,expiresAt:new Date(expires).toISOString()});
  }catch(error){try{await current(c,item);}catch(currentError){error=currentError;}close(item);throw error;}finally{c.req.raw.signal.removeEventListener('abort',aborted);}
 }));
 app.post(BASE+'/commit',route(async c=>{
  rate(c);const input=await body(c);if(!exact(input,['id','modelId','acceptNotice'])||typeof input.id!=='string'||!UUID.test(input.id)||typeof input.modelId!=='string'||input.acceptNotice!==true)return fail('provider_setup_invalid_request');
  const item=pending.get(input.id);if(!item)return fail('provider_setup_expired',410);await current(c,item);
  if(item.result){if(item.result.modelId!==input.modelId)return fail('provider_model_not_discovered');await currentCreated(item);await current(c,item);return c.json(item.result);}
  if(item.committing)return fail('provider_setup_busy',409);item.committing=true;
  try {
  const prepared=item.prepared;if(!prepared||!prepared.models.some(m=>m.id===input.modelId))return fail('provider_model_not_discovered');
  if(item.created&&item.created.modelIds[0]!==input.modelId)return fail('provider_model_not_discovered');
  const providerId=prepared.providerId,modelId=input.modelId,endpoint=prepared.endpointUrl,local=(PROVIDER_SETUP_PRESETS.find(p=>p.id===providerId)??LOCAL_COMPAT.find(p=>p.id===providerId)??PROVIDER_SETUP_CATALOG_PRESETS.find(p=>p.id===providerId))?.local===true;
  const patch=(next:ProxyConfig)=>{
   if(isOptionalProvider(providerId))ensureProviderEntry(next,providerId);else if(isUserDefinedProvider(providerId))ensureUserDefinedProviderEntry(next,providerId);else if(!isCoreProvider(providerId))return fail('provider_unknown');
   const entry=next.providers[providerId as ProviderName]!;
   if(entry.configured&&entry.endpointUrl&&entry.endpointUrl!==endpoint)return fail('provider_endpoint_conflict',409);
   const models=[...new Set([...(entry.configured?entry.models:[]),modelId])];if(models.length>256)return fail('provider_model_limit');
   const alreadyConfigured=entry.configured;entry.models=models;if(!alreadyConfigured||!entry.models.includes(entry.defaultModel))entry.defaultModel=modelId;
   if(!isCoreProvider(providerId))entry.endpointUrl=endpoint;entry.enabled=true;entry.configured=true;
   if(isNamedExperimentalProvider(providerId))acceptNamedProviderRisk(entry,providerId);
   if(providerId==='gemini'){entry.privacyAcceptedAt??=new Date(now()).toISOString();entry.privacyNoticeVersion=GEMINI_FREE_PRIVACY_NOTICE_VERSION;}
   // No provider-wide secret/default selection/routing combo is written here.
  };
  patch(structuredClone(deps.getConfig()));await current(c,item);
  item.created??=await deps.profiles.create({schemaVersion:1,providerId,label:item.label??prepared.label,accessMode:local?'local':'byok',enabled:true,...(isCoreProvider(providerId)?{}:{endpointUrl:endpoint}),modelIds:[modelId]},item.key||undefined,item.operationId,()=>current(c,item));
  item.key='';
  await currentCreated(item);await deps.persist(patch,async()=>{await current(c,item);await currentCreated(item);});await deps.invalidate(providerId as ProviderName);await current(c,item);await currentCreated(item);
  item.result={providerId,modelId,connectionId:item.created.id,accountLabel:item.created.label,reloaded:true};prepared.dispose();item.prepared=undefined;return c.json(item.result);
  } finally {item.committing=false;}
 }));
 app.post(BASE+'/dispose',route(async c=>{
  const input=await body(c);if(!exact(input,['id'])||typeof input.id!=='string'||!UUID.test(input.id))return fail('provider_setup_invalid_request');const item=pending.get(input.id);if(item){await current(c,item);close(item);}return c.json({disposed:true});
 }));
}
