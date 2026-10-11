import {createHash} from 'node:crypto';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {MANAGED_MEDIA_KINDS,parseMediaConfigurationRequest,parseMediaConfigurationInfo,type ManagedMediaKind,type MediaConfigurationInfo,type MediaConfigurationProfile} from '@uptokey/sync-contract/media-profile';
import {assertProxyConfig} from './config.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import type {EffectRequest} from './workspace/executor.ts';
import {startConfiguredImage,validateImageProfile} from './image-profile.ts';
import {startConfiguredVideo,validateVideoProfile} from './video-profile.ts';
import {startConfiguredSpeech,validateSpeechProfile} from './speech-profile.ts';
import {startConfiguredTranscription,validateTranscriptionProfile} from './transcription-profile.ts';
import {connectionSecretRef, legacySecretRef, type ConnectionStateStorage} from './connection-profiles.ts';
import type {WorkspaceImage} from './image-service.ts';
import type {WorkspaceVideo} from './video-service.ts';
import type {WorkspaceSpeech} from './speech-service.ts';
import type {WorkspaceTranscription} from './transcription-service.ts';
import {mediaConnectionSupport,mediaProviders} from './media-provider-catalog.ts';
import type {MediaCredentialIdentity} from './media-credential.ts';

type Services={image?:WorkspaceImage;video?:WorkspaceVideo;speech?:WorkspaceSpeech;transcription?:WorkspaceTranscription};
type Service=NonNullable<Services[ManagedMediaKind]>;
type Selection={revision:number;connectionRevision:string;profile:MediaConfigurationProfile};
type Handle={service:Service;close():Promise<void>};
type Slot={selection?:Selection;active?:Handle;error?:string;pending:Promise<unknown>;inFlight:number};
export type MediaLaunchDependencies={
 image?:Parameters<typeof startConfiguredImage>[2];video?:Parameters<typeof startConfiguredVideo>[2];
 speech?:Parameters<typeof startConfiguredSpeech>[2];transcription?:Parameters<typeof startConfiguredTranscription>[2];
};
export class MediaConfigurationError extends Error {
 readonly status:400|409|503;
 readonly outcome='not_sent';
 constructor(code:string,status:400|409|503=400){super(code);this.status=status;}
}
const metadataKey=(kind:ManagedMediaKind)=>`media:${kind}:profile:v1`;

/** Lifecycle adapter over the four existing drivers. The legacy custom endpoint
 * remains the fallback credential owner; D01-core v2 additionally resolves the
 * chosen CONNECTION identity (conn:<id> vault) without copying to provider:custom. */
export function createManagedMedia(options:{config:ProxyConfig;secrets:SecretStore;store:WorkspaceStore;overrides?:Services;dependencies?:MediaLaunchDependencies;connectionsStorage?:ConnectionStateStorage}) {
 const slots=Object.fromEntries(MANAGED_MEDIA_KINDS.map(kind=>[kind,{pending:Promise.resolve(),inFlight:0}])) as Record<ManagedMediaKind,Slot>;
 let closing=false,initialization:Promise<void>|undefined;
 function connection() {
  try {
   assertProxyConfig(options.config);
   const config=options.config,provider=config.providers.custom;
   if(!provider?.enabled||!provider.configured||!provider.endpointUrl||config.deviceRevokedAt||config.entitlementSuspendedAt)return undefined;
   const url=new URL(provider.endpointUrl);
   if(url.username||url.password||url.search||url.hash||!(url.protocol==='https:'||url.protocol==='http:'&&url.hostname==='127.0.0.1'))return undefined;
   const revision=createHash('sha256').update(canonicalJson({provider,tenant:config.appliedConfigTenantId??null,device:config.appliedConfigDeviceId??null,version:config.appliedConfigVersion??null,entitlement:config.entitlementRevision??null,contactTenant:config.lastControlPlaneContactTenantId??null,contactDevice:config.lastControlPlaneContactDeviceId??null})).digest('hex');
   return {id:'custom' as const,label:'Compatible endpoint',endpointOrigin:url.origin,revision};
  } catch {return undefined;}
 }
 type Identity={id:string;providerId:string;label:string;endpointOrigin:string;revision:string;legacyRevision:string;credentialRef:string;support:NonNullable<ReturnType<typeof mediaConnectionSupport>>};
 const identityRevisions=new Map<string,string>();
 async function connectionIdentities(kind:ManagedMediaKind):Promise<Identity[]>{
  if(!options.connectionsStorage)return [];
  try{
   const file=await options.connectionsStorage.loadProfiles();
   const identities:Identity[]=[];
   for(const profile of file?.profiles??[]){
    if(!profile.enabled||profile.accessMode!=='byok'||profile.providerId.startsWith('service-'))continue;
    const support=mediaConnectionSupport(kind,profile.providerId,profile.endpointUrl);if(!support)continue;
    // A connection migrated from the provider configuration uses that provider's vault entry (the key the person replaces).
    const ref=profile.migratedFromLegacy&&await options.secrets.get(legacySecretRef(profile.providerId))?legacySecretRef(profile.providerId):(profile.credentialRef??connectionSecretRef(profile.id));
    if(!(await options.secrets.get(ref)))continue;
    const revision=createHash('sha256').update(canonicalJson({id:profile.id,providerId:profile.providerId,credentialRef:ref,updatedAt:profile.updatedAt??'',revision:profile.revision,endpointUrl:profile.endpointUrl,enabled:profile.enabled})).digest('hex');
    const legacyRevision=createHash('sha256').update(canonicalJson({id:profile.id,providerId:profile.providerId,credentialRef:ref,updatedAt:profile.updatedAt??''})).digest('hex');
    identities.push({id:profile.id,providerId:profile.providerId,label:profile.label??profile.providerId,endpointOrigin:new URL(support.endpoint).origin,revision,legacyRevision,credentialRef:ref,support});
   }
   // The vault is asynchronous. Do not accept the earlier file snapshot if
   // another surface revoked or changed that account while its key was read.
   const latest=await options.connectionsStorage.loadProfiles();
   const stable=identities.filter(identity=>{const before=file?.profiles.find(profile=>profile.id===identity.id),after=latest?.profiles.find(profile=>profile.id===identity.id);const matches=before&&after&&canonicalJson(before)===canonicalJson(after);if(!matches)identityRevisions.delete(identity.id);return Boolean(matches);});
   for(const identity of stable)identityRevisions.set(identity.id,identity.revision);
   // Invalidating a kind must not retire an unrelated valid selection.
   for(const id of identityRevisions.keys()){const profile=latest?.profiles.find(item=>item.id===id);if(!profile||!profile.enabled||profile.accessMode!=='byok'||profile.providerId.startsWith('service-'))identityRevisions.delete(id);}
   return stable;
  }catch{return [];}
 }
 async function identityFor(kind:ManagedMediaKind,request:{connectionId:string;providerId?:string}):Promise<Identity|undefined>{
  if(request.connectionId==='custom')return undefined;
  return (await connectionIdentities(kind)).find(item=>item.id===request.connectionId&&(!request.providerId||item.providerId===request.providerId));
 }
 function current(kind:ManagedMediaKind,selection:Selection) {
  if(selection.profile.connectionId!=='custom')return !closing&&slots[kind].selection?.revision===selection.revision&&identityRevisions.get(selection.profile.connectionId)===selection.connectionRevision;
  return !closing&&slots[kind].selection?.revision===selection.revision&&connection()?.revision===selection.connectionRevision;
 }
 function validate(kind:ManagedMediaKind,profile:MediaConfigurationProfile) {
  const input={...profile,imageOrigins:profile.imageOrigins?[...profile.imageOrigins]:undefined};
  if(kind==='image')validateImageProfile(input);
  else if(kind==='video')validateVideoProfile(input);
  else if(kind==='speech')validateSpeechProfile(input);
  else validateTranscriptionProfile(input);
 }
 async function launch(kind:ManagedMediaKind,selection:Selection):Promise<Handle> {
  const input={...selection.profile,imageOrigins:selection.profile.imageOrigins?[...selection.profile.imageOrigins]:undefined};
  const identity=selection.profile.connectionId==='custom'?undefined:await identityFor(kind,{connectionId:selection.profile.connectionId,providerId:selection.profile.providerId});
  if(selection.profile.connectionId!=='custom'&&(!identity||identity.revision!==selection.connectionRevision))throw new MediaConfigurationError('media_connection_changed',409);
  const revalidate=async()=>{if(closing)throw new MediaConfigurationError('media_connection_changed',409);if(identity){const live=await identityFor(kind,selection.profile);if(!live||live.revision!==identity.revision||live.credentialRef!==identity.credentialRef){identityRevisions.delete(identity.id);throw new MediaConfigurationError('media_connection_changed',409);}}else if(connection()?.revision!==selection.connectionRevision||!await options.secrets.get('provider:custom'))throw new MediaConfigurationError('media_connection_changed',409);};
  const credentialIdentity:MediaCredentialIdentity|undefined=identity?{credentialRef:identity.credentialRef,endpointOrigin:identity.endpointOrigin,current:()=>!closing&&identityRevisions.get(identity.id)===identity.revision,revalidate}:undefined;
  const launchOptions={...options,...(credentialIdentity?{identity:credentialIdentity}:{})};
  let handle:Handle;
  if(kind==='image'){const result=await startConfiguredImage(input,launchOptions,options.dependencies?.image);handle={service:result.image,close:result.close};}
  else if(kind==='video'){const result=await startConfiguredVideo(input,launchOptions,options.dependencies?.video);handle={service:result.video,close:result.close};}
  else if(kind==='speech'){const result=await startConfiguredSpeech(input,launchOptions,options.dependencies?.speech);handle={service:result.speech,close:result.close};}
  else {
   // A saved connection transcribes with its own vault entry; the worker stops when that connection changes.
   const result=await startConfiguredTranscription(input,launchOptions,options.dependencies?.transcription);handle={service:result.transcription,close:result.close};
  }
  try{await revalidate();}catch(error){await handle.close();throw error;}
  if(closing||(selection.profile.connectionId==='custom'?connection()?.revision!==selection.connectionRevision:!identity||identity.revision!==selection.connectionRevision)){await handle.close();throw new MediaConfigurationError('media_connection_changed',409);}
  let retired=false;
  const slot=slots[kind],methods=new Set(['prepare','execute','create','poll','content']);
  const service=new Proxy(handle.service,{
   get(target,property){
    if(property==='available')return !retired&&current(kind,selection)&&target.available!==false;
    const value=Reflect.get(target,property,target);
    if(typeof property!=='string'||!methods.has(property)||typeof value!=='function')return value;
    return async(...args:unknown[])=>{
     if(retired||!current(kind,selection))throw new MediaConfigurationError('media_profile_changed',409);
     await revalidate();
     if(property!=='prepare'){
      const effect=args.at(-1) as EffectRequest|undefined,binding=effect?.arguments?.media_profile_revision;
      if(binding?.kind!=='literal'||binding.value!==selection.revision)throw new MediaConfigurationError('media_profile_changed',409);
     }
     slot.inFlight++;
     try{const result=await Reflect.apply(value,target,args);await revalidate();if(retired||!current(kind,selection))throw new Error('media_profile_changed_during_operation');return result;}
     finally{slot.inFlight--;}
    };
   },
  });
  return {service,close:()=>{retired=true;return handle.close();}};
 }
 async function stop(kind:ManagedMediaKind) {
  const handle=slots[kind].active;slots[kind].active=undefined;
  if(handle)await handle.close();
 }
 async function initialize() {
  if(initialization)return initialization;
  initialization=(async()=>{
   for(const kind of MANAGED_MEDIA_KINDS){
    if(options.overrides?.[kind])continue;
    const slot=slots[kind];
    try{
     const raw=await options.secrets.get(metadataKey(kind));
     if(!raw)continue;
     const saved:unknown=JSON.parse(raw);
     if(!isDataRecord(saved)||Object.keys(saved).sort().join(',')!=='connectionRevision,profile,revision'||!Number.isSafeInteger(saved.revision)||Number(saved.revision)<1||!isDataRecord(saved.profile))throw Error('media_profile_invalid');
     const parsed=parseMediaConfigurationRequest(kind,{...saved.profile,expectedRevision:Number(saved.revision)-1,connectionRevision:saved.connectionRevision});
     const {expectedRevision,connectionRevision,...profile}=parsed;
     validate(kind,profile);const selection={revision:expectedRevision+1,connectionRevision,profile};slot.selection=selection;
     const savedIdentity=await identityFor(kind,{connectionId:profile.connectionId,providerId:profile.providerId});
     // Upgrade only the previous fingerprint of the same enabled account and
     // exact selected destination. Keep the user's model and profile revision.
     if(savedIdentity&&savedIdentity.revision!==connectionRevision&&savedIdentity.legacyRevision===connectionRevision&&new URL(profile.endpoint).origin===savedIdentity.endpointOrigin){
      const key=metadataKey(kind);selection.connectionRevision=savedIdentity.revision;
      const encoded=JSON.stringify(selection);
      const unchanged=async()=>{const live=await identityFor(kind,profile);if(closing||!live||live.revision!==savedIdentity.revision)throw new MediaConfigurationError('media_connection_changed',409);};
      try{await unchanged();if(await options.secrets.get(key)!==raw)throw new MediaConfigurationError('media_profile_changed',409);await options.secrets.set(key,encoded);await unchanged();}
      catch(error){if(await options.secrets.get(key)===encoded)await options.secrets.set(key,raw);selection.connectionRevision=connectionRevision;throw error;}
     }
     if(profile.connectionId==='custom'?(connection()?.revision!==selection.connectionRevision||!await options.secrets.get('provider:custom')):(!savedIdentity||savedIdentity.revision!==selection.connectionRevision)){slot.error='media_connection_changed';continue;}
     slot.active=await launch(kind,selection);
    }catch{slot.error=slot.selection?'media_profile_start_failed':'media_profile_invalid';}
   }
  })();
  return initialization;
 }
 const configuration={
  initialize,
  revision(kind:ManagedMediaKind):number|undefined{return options.overrides?.[kind]?undefined:slots[kind].selection?.revision;},
  async info(kind:ManagedMediaKind):Promise<MediaConfigurationInfo>{
   await initialize();
   const slot=slots[kind],override=options.overrides?.[kind];
   if(override)return parseMediaConfigurationInfo({kind,mode:'startup',configured:true,available:override.available!==false,profileRevision:0,profile:null,connections:[]});
   const identities=await connectionIdentities(kind);
   const credentialPresent=connection()?Boolean(await options.secrets.get('provider:custom')):false;
   // Snapshot after the asynchronous vault read: a concurrent POST may have
   // replaced both selection and worker while this GET was waiting.
   const eligible=connection(),selected=slot.selection;
   const configured=Boolean(selected&&(selected.profile.connectionId==='custom'?(eligible?.revision===selected.connectionRevision&&credentialPresent):(identities.some(item=>item.id===selected.profile.connectionId&&item.revision===selected.connectionRevision)&&Boolean(slot.active))));
   if(slot.active&&!configured){await stop(kind);if(slot.selection!==selected)return configuration.info(kind);slot.error='media_connection_changed';}
   const choice=(support:Identity['support'])=>({endpoint:support.endpoint,models:support.models,modelSource:support.modelSource,...(support.editEndpoint?{editEndpoint:support.editEndpoint}:{})});
   const legacySupport=eligible?mediaConnectionSupport(kind,'custom',eligible.endpointOrigin):undefined;
   const listed=[...(eligible&&credentialPresent&&legacySupport?[{...eligible,...choice(legacySupport)}]:[]),...identities.map(item=>({id:item.id,providerId:item.providerId,label:item.label,endpointOrigin:item.endpointOrigin,revision:item.revision,...choice(item.support)}))];
   return parseMediaConfigurationInfo({kind,mode:'managed',configured,available:Boolean(configured&&slot.active?.service.available!==false&&slot.active),profileRevision:selected?.revision??0,profile:selected?.profile??null,connections:listed,providers:mediaProviders(kind),...(slot.error?{error:slot.error}:{})});
  },
  configure(kind:ManagedMediaKind,input:unknown):Promise<MediaConfigurationInfo>{
   const slot=slots[kind];
   const pending=slot.pending.catch(()=>undefined).then(async()=>{
    await initialize();
    if(closing)throw new MediaConfigurationError('media_configuration_closed',503);
    if(options.overrides?.[kind])throw new MediaConfigurationError('media_configuration_managed_by_startup',409);
    if(slot.error==='media_profile_invalid')throw new MediaConfigurationError('media_profile_invalid',409);
    let request;try{request=parseMediaConfigurationRequest(kind,input);validate(kind,request);}catch{throw new MediaConfigurationError('media_profile_invalid');}
    if((slot.selection?.revision??0)!==request.expectedRevision)throw new MediaConfigurationError('media_profile_changed',409);
    if(slot.inFlight)throw new MediaConfigurationError('media_operation_active',409);
    const eligible=connection();
    const identity=await identityFor(kind,{connectionId:request.connectionId,providerId:request.providerId});
    if(request.connectionId==='custom'){
     if(!eligible||eligible.revision!==request.connectionRevision||new URL(request.endpoint).origin!==eligible.endpointOrigin||!await options.secrets.get('provider:custom'))throw new MediaConfigurationError('media_connection_changed',409);
    }else{
     if(!identity||identity.revision!==request.connectionRevision)throw new MediaConfigurationError('media_connection_changed',409);
     if(identity.support.modelSource==='catalog'&&(!identity.support.models.some(model=>model.id===request.model)||identity.support.endpoint!==request.endpoint||request.editEndpoint!==undefined&&identity.support.editEndpoint!==request.editEndpoint))throw new MediaConfigurationError('media_model_unsupported');
     if(identity.endpointOrigin&&new URL(request.endpoint).origin!==identity.endpointOrigin)throw new MediaConfigurationError('media_connection_changed',409);
     if(!await options.secrets.get(identity.credentialRef))throw new MediaConfigurationError('media_connection_changed',409);
    }
    const {expectedRevision,connectionRevision,...profile}=request;
    const selection={revision:expectedRevision+1,connectionRevision,profile};
    if(slot.inFlight)throw new MediaConfigurationError('media_operation_active',409);
    let candidate:Handle|undefined;
    const previousHandle=slot.active;
    const key=metadataKey(kind),previous=await options.secrets.get(key),encoded=JSON.stringify(selection);
    const assertSelection=async()=>{if(closing)throw new MediaConfigurationError('media_configuration_closed',503);if(slot.inFlight)throw new MediaConfigurationError('media_operation_active',409);if(request.connectionId==='custom'){if(connection()?.revision!==connectionRevision||!await options.secrets.get('provider:custom'))throw new MediaConfigurationError('media_connection_changed',409);}else{const latest=await identityFor(kind,request);if(!latest||latest.revision!==connectionRevision)throw new MediaConfigurationError('media_connection_changed',409);}if(slot.inFlight)throw new MediaConfigurationError('media_operation_active',409);};
    try{
     candidate=await launch(kind,selection);
     await assertSelection();
     await options.secrets.set(key,encoded);await assertSelection();
     slot.selection=selection;
     if(closing){await candidate.close();candidate=undefined;throw new MediaConfigurationError('media_configuration_closed',503);}
     slot.active=candidate;slot.error=undefined;
    }catch(error){try{await candidate?.close();}finally{if(await options.secrets.get(key)===encoded){if(previous===undefined)await options.secrets.delete(key);else await options.secrets.set(key,previous);}}slot.error=previousHandle?undefined:'media_profile_start_failed';throw error instanceof MediaConfigurationError?error:new MediaConfigurationError('media_profile_start_failed',503);}
    // The previous worker stays usable until the new profile is committed.
    // Its old revision can no longer execute even if cleanup itself fails.
    try{await previousHandle?.close();}catch{slot.error='media_profile_cleanup_failed';throw new MediaConfigurationError('media_profile_cleanup_failed',503);}
    return configuration.info(kind);
   });
   slot.pending=pending;return pending;
  },
  async close(){
   closing=true;await initialization?.catch(()=>undefined);
   await Promise.allSettled(MANAGED_MEDIA_KINDS.map(kind=>slots[kind].pending));
   await Promise.all(MANAGED_MEDIA_KINDS.map(stop));
  },
 };
 const services:Services={
  get image(){return slots.image.active?.service as WorkspaceImage|undefined;},
  get video(){return slots.video.active?.service as WorkspaceVideo|undefined;},
  get speech(){return slots.speech.active?.service as WorkspaceSpeech|undefined;},
  get transcription(){return slots.transcription.active?.service as WorkspaceTranscription|undefined;},
 };
 return {configuration,services};
}
