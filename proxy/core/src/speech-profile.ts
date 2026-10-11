import {join} from 'node:path';
import {productCodeRoots} from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {validateSpeechProfile,type SpeechProfile} from "../../../quimera/uptokey/scripts/quimera-speech-options.mjs";
export {parseSpeechCliArguments,validateSpeechProfile} from "../../../quimera/uptokey/scripts/quimera-speech-options.mjs";
import {assertProxyConfig} from './config.ts';
import {readMediaCredential,guardedMediaFetch,type MediaCredentialIdentity} from './media-credential.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {launchWorkspaceSpeech} from './speech-launch.ts';
import type {WorkspaceSpeech} from './speech-service.ts';
export type {SpeechProfile} from "../../../quimera/uptokey/scripts/quimera-speech-options.mjs";
const invalid=()=>new Error('speech_profile_invalid');
export async function startConfiguredSpeech(profileInput:SpeechProfile,options:{config:ProxyConfig;secrets:Pick<SecretStore,'get'>;store:Pick<WorkspaceStore,'readRun'>;identity?:MediaCredentialIdentity},dependencies:{launch?:typeof launchWorkspaceSpeech;fetchImpl?:typeof fetch}={}):Promise<{speech:WorkspaceSpeech;close():Promise<void>}>{
 const profile=validateSpeechProfile(profileInput);let closed=false;
 const identity=options.identity;
 const snapshot=()=>{if(identity){if(!identity.current()||identity.endpointOrigin!==new URL(profile.endpoint).origin||options.config.deviceRevokedAt||options.config.entitlementSuspendedAt)throw invalid();return canonicalJson({credentialRef:identity.credentialRef,endpointOrigin:identity.endpointOrigin});}assertProxyConfig(options.config);const c=options.config,p=c.providers.custom;
  if(!p?.enabled||!p.configured||!p.endpointUrl||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
  const url=new URL(p.endpointUrl);if(url.username||url.password||url.search||url.hash||url.origin!==new URL(profile.endpoint).origin)throw invalid();
  return canonicalJson({provider:p,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});};
 const frozen=snapshot();let inner:Awaited<ReturnType<typeof launchWorkspaceSpeech>>|undefined;const current=()=>{try{if(closed||snapshot()!==frozen)throw invalid();}catch{closed=true;inner?.dispose();throw invalid();}};
 inner=await(dependencies.launch??launchWorkspaceSpeech)(join(productCodeRoots().INTEGRATIONS,'9router/app'),{model:profile.model,provider:'openai-compatible-quimera-custom',providerUrl:profile.endpoint,driverRevision:'17c4cc76877bd1755030a8414f8d0083f48dcccf',store:options.store,
  resolveCredential:()=>readMediaCredential(options.secrets,identity,current),
  fetchImpl:guardedMediaFetch(identity,current,dependencies.fetchImpl??fetch)});
 let closing:Promise<void>|undefined;const close=()=>{closed=true;return closing??=inner!.close();};
 try{current();const speech:WorkspaceSpeech={model:profile.model,get available(){try{current();return inner!.available;}catch{return false;}},
  prepare:async(request,signal)=>{current();const wire=await inner!.prepare(request,signal);current();return wire;},
  execute:(request,wire,effect)=>{current();if(effect.capability.dataDestination.id!=='custom')throw invalid();return inner!.execute(request,wire,{...effect,limits:{...effect.limits,timeoutMs:Math.min(effect.limits.timeoutMs,options.config.providers?.custom?.requestTimeoutMs??120000)}});}};return{speech,close};
 }catch(error){await close();throw error;}
}



