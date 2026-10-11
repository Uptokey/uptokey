import {join} from 'node:path';
import {productCodeRoots} from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {validateImageProfile,type ImageProfile} from "../../../quimera/uptokey/scripts/quimera-image-options.mjs";
export {validateImageProfile,parseImageCliArguments} from "../../../quimera/uptokey/scripts/quimera-image-options.mjs";
export type {ImageProfile} from "../../../quimera/uptokey/scripts/quimera-image-options.mjs";
import {assertProxyConfig} from './config.ts';
import {readMediaCredential,guardedMediaFetch,type MediaCredentialIdentity} from './media-credential.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {launchWorkspaceImage,type WorkspaceImage} from './image-service.ts';
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
const invalid=()=>new Error('image_profile_invalid');
export async function startConfiguredImage(profileInput:ImageProfile&{connectionId?:string;providerId?:string},options:{config:ProxyConfig;secrets:Pick<SecretStore,'get'>;store:Pick<WorkspaceStore,'readRun'>&Partial<Pick<WorkspaceStore,'readBinaryArtifactMedia'>>;identity?:MediaCredentialIdentity},dependencies:{launch?:typeof launchWorkspaceImage;fetchImpl?:typeof fetch}={}):Promise<{image:WorkspaceImage;close():Promise<void>}>{
 const profile=validateImageProfile(profileInput);let closed=false;
 const identity=options.identity;
 const snapshot=()=>{if(identity){if(!identity.current()||identity.endpointOrigin!==new URL(profile.endpoint).origin||options.config.deviceRevokedAt||options.config.entitlementSuspendedAt)throw invalid();return canonicalJson({credentialRef:identity.credentialRef,endpointOrigin:identity.endpointOrigin});}assertProxyConfig(options.config);const c=options.config,p=c.providers.custom;
  if(!p?.enabled||!p.configured||!p.endpointUrl||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
  const url=new URL(p.endpointUrl);if(url.username||url.password||url.search||url.hash||url.origin!==new URL(profile.endpoint).origin)throw invalid();
  return canonicalJson({provider:p,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});};
 const frozen=snapshot();let inner:Awaited<ReturnType<typeof launchWorkspaceImage>>|undefined;const current=()=>{try{if(closed||snapshot()!==frozen)throw invalid();}catch{closed=true;inner?.dispose();throw invalid();}};
 inner=await(dependencies.launch??launchWorkspaceImage)(join(productCodeRoots().INTEGRATIONS,'9router/app'),{model:profile.model,provider:'openai-compatible-quimera-custom',providerUrl:profile.endpoint,providerEditUrl:profile.editEndpoint,driverRevision:revision,store:options.store,
  resolveCredential:()=>readMediaCredential(options.secrets,identity,current),
  fetchImpl:guardedMediaFetch(identity,current,dependencies.fetchImpl??fetch)});
 let closing:Promise<void>|undefined;const close=()=>{closed=true;return closing??=inner!.close();};
 try{current();const image:WorkspaceImage={model:profile.model,get supportedOperations(){return inner!.supportedOperations;},get available(){try{current();return inner!.available;}catch{return false;}},
  prepare:async(request,signal)=>{current();const wire=await inner!.prepare(request,signal);current();return wire;},
  execute:(request,wire,effect)=>{current();if(effect.capability.dataDestination.id!=='custom')throw invalid();return inner!.execute(request,wire,{...effect,limits:{...effect.limits,timeoutMs:Math.min(effect.limits.timeoutMs,options.config.providers?.custom?.requestTimeoutMs??120000)}});}};return{image,close};
 }catch(error){await close();throw error;}
}
