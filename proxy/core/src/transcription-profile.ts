import {join} from 'node:path';
import {productCodeRoots} from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {validateTranscriptionProfile,type TranscriptionProfile} from "../../../quimera/uptokey/scripts/quimera-transcription-options.mjs";
export {validateTranscriptionProfile,parseTranscriptionCliArguments} from "../../../quimera/uptokey/scripts/quimera-transcription-options.mjs";
export type {TranscriptionProfile} from "../../../quimera/uptokey/scripts/quimera-transcription-options.mjs";
import {assertProxyConfig} from './config.ts';
import {readMediaCredential,guardedMediaFetch,type MediaCredentialIdentity} from './media-credential.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {launchWorkspaceTranscription,type WorkspaceTranscription} from './transcription-service.ts';
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
const invalid=()=>new Error('transcription_profile_invalid');
/** A saved connection (D01 v2) used instead of the legacy provider:custom endpoint: its own vault entry, never copied. */
export type TranscriptionIdentity=MediaCredentialIdentity;
const DEFAULT_TIMEOUT_MS=120_000;
export async function startConfiguredTranscription(profileInput:TranscriptionProfile,options:{config:ProxyConfig;secrets:Pick<SecretStore,'get'>;store:Pick<WorkspaceStore,'readRun'>;identity?:TranscriptionIdentity},dependencies:{launch?:typeof launchWorkspaceTranscription;fetchImpl?:typeof fetch}={}):Promise<{transcription:WorkspaceTranscription;close():Promise<void>}>{
 const profile=validateTranscriptionProfile(profileInput);let closed=false;
 const identity=options.identity;
 const snapshot=()=>{assertProxyConfig(options.config);const c=options.config;
  if(identity){
   if(!identity.current()||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
   if(identity.endpointOrigin&&identity.endpointOrigin!==new URL(profile.endpoint).origin)throw invalid();
   return canonicalJson({credentialRef:identity.credentialRef,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});
  }
  const p=c.providers.custom;
  if(!p?.enabled||!p.configured||!p.endpointUrl||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
  const url=new URL(p.endpointUrl);if(url.username||url.password||url.search||url.hash||url.origin!==new URL(profile.endpoint).origin)throw invalid();
  return canonicalJson({provider:p,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});};
 const frozen=snapshot();let inner:Awaited<ReturnType<typeof launchWorkspaceTranscription>>|undefined;const current=()=>{try{if(closed||snapshot()!==frozen)throw invalid();}catch{closed=true;inner?.dispose();throw invalid();}};
 inner=await(dependencies.launch??launchWorkspaceTranscription)(join(productCodeRoots().INTEGRATIONS,'9router/app'),{model:profile.model,provider:'openai-compatible-quimera-custom',providerUrl:profile.endpoint,driverRevision:revision,store:options.store,
  resolveCredential:()=>readMediaCredential(options.secrets,identity,current),
  fetchImpl:guardedMediaFetch(identity,current,dependencies.fetchImpl??fetch)});
 let closing:Promise<void>|undefined;const close=()=>{closed=true;return closing??=inner!.close();};
 try{current();const transcription:WorkspaceTranscription={model:profile.model,endpoint:profile.endpoint,get available(){try{current();return inner!.available;}catch{return false;}},
  prepare:async(request,signal)=>{current();const wire=await inner!.prepare(request,signal);current();return wire;},
  execute:(request,wire,audio,effect)=>{current();if(effect.capability.dataDestination.id!=='custom')throw invalid();return inner!.execute(request,wire,audio,{...effect,limits:{...effect.limits,timeoutMs:Math.min(effect.limits.timeoutMs,identity?(options.config.providers.custom?.requestTimeoutMs??DEFAULT_TIMEOUT_MS):options.config.providers.custom!.requestTimeoutMs)}});}};return{transcription,close};
 }catch(error){await close();throw error;}
}
