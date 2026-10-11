import {join} from 'node:path';
import {productCodeRoots} from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {validateVideoProfile,type VideoProfile} from "../../../quimera/uptokey/scripts/quimera-video-options.mjs";
export {validateVideoProfile,parseVideoCliArguments} from "../../../quimera/uptokey/scripts/quimera-video-options.mjs";
export type {VideoProfile} from "../../../quimera/uptokey/scripts/quimera-video-options.mjs";
import {assertProxyConfig} from './config.ts';
import {readMediaCredential,guardedMediaFetch,type MediaCredentialIdentity} from './media-credential.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import type {EffectRequest} from './workspace/executor.ts';
import {launchWorkspaceVideo,type WorkspaceVideo} from './video-service.ts';
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
const invalid=()=>new Error('video_profile_invalid');
export async function startConfiguredVideo(profileInput:VideoProfile,options:{config:ProxyConfig;secrets:Pick<SecretStore,'get'>;store:Pick<WorkspaceStore,'readRun'|'readTextArtifact'>;identity?:MediaCredentialIdentity},dependencies:{launch?:typeof launchWorkspaceVideo;fetchImpl?:typeof fetch}={}):Promise<{video:WorkspaceVideo;close():Promise<void>}>{
 const profile=validateVideoProfile(profileInput);let closed=false;
 const identity=options.identity;
 const snapshot=()=>{if(identity){if(!identity.current()||identity.endpointOrigin!==new URL(profile.endpoint).origin||options.config.deviceRevokedAt||options.config.entitlementSuspendedAt)throw invalid();return canonicalJson({credentialRef:identity.credentialRef,endpointOrigin:identity.endpointOrigin});}assertProxyConfig(options.config);const c=options.config,p=c.providers.custom;
  if(!p?.enabled||!p.configured||!p.endpointUrl||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
  const url=new URL(p.endpointUrl);if(url.username||url.password||url.search||url.hash||url.origin!==new URL(profile.endpoint).origin)throw invalid();
  return canonicalJson({provider:p,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});};
 const frozen=snapshot();let inner:Awaited<ReturnType<typeof launchWorkspaceVideo>>|undefined;const current=()=>{try{if(closed||snapshot()!==frozen)throw invalid();}catch{closed=true;inner?.dispose();throw invalid();}};
 inner=await(dependencies.launch??launchWorkspaceVideo)(join(productCodeRoots().INTEGRATIONS,'9router/app'),{model:profile.model,provider:'openai-compatible-quimera-custom',providerUrl:profile.endpoint,imageOrigins:profile.imageOrigins,driverRevision:revision,store:options.store,
  resolveCredential:()=>readMediaCredential(options.secrets,identity,current),
  fetchImpl:guardedMediaFetch(identity,current,dependencies.fetchImpl??fetch)});
 let closing:Promise<void>|undefined;const close=()=>{closed=true;return closing??=inner!.close();};
 const bounded=(effect:EffectRequest)=>{current();if(effect.capability.dataDestination.id!=='custom')throw invalid();return {...effect,limits:{...effect.limits,timeoutMs:Math.min(effect.limits.timeoutMs,options.config.providers?.custom?.requestTimeoutMs??120000)}};};
 try{current();const video:WorkspaceVideo={model:profile.model,get supportedOperations(){return inner!.supportedOperations;},get available(){try{current();return inner!.available;}catch{return false;}},
  prepare:async(request,signal)=>{current();const wire=await inner!.prepare(request,signal);current();return wire;},
  create:(request,wire,effect)=>inner!.create(request,wire,bounded(effect)),
  poll:(job,effect)=>inner!.poll(job,bounded(effect)),
  content:(job,effect)=>inner!.content(job,bounded(effect))};return{video,close};
 }catch(error){await close();throw error;}
}


