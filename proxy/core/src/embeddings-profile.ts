import {join} from 'node:path';
import {productCodeRoots} from "../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {validateEmbeddingsProfile,type EmbeddingsProfile} from "../../../quimera/uptokey/scripts/quimera-embeddings-options.mjs";
export {validateEmbeddingsProfile,parseEmbeddingsCliArguments} from "../../../quimera/uptokey/scripts/quimera-embeddings-options.mjs";
export type {EmbeddingsProfile} from "../../../quimera/uptokey/scripts/quimera-embeddings-options.mjs";
import {assertProxyConfig} from './config.ts';
import type {ProxyConfig} from './types.ts';
import type {SecretStore} from './secret-store.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {launchWorkspaceEmbeddings,type WorkspaceEmbeddings} from './embeddings-service.ts';
import {MediaEffectError} from './media-dispatch.ts';
const revision='17c4cc76877bd1755030a8414f8d0083f48dcccf';
const invalid=()=>new Error('embeddings_profile_invalid');
export async function startConfiguredEmbeddings(profileInput:EmbeddingsProfile,options:{config:ProxyConfig;secrets:Pick<SecretStore,'get'>;store:Pick<WorkspaceStore,'readRun'>},dependencies:{launch?:typeof launchWorkspaceEmbeddings;fetchImpl?:typeof fetch}={}):Promise<{embeddings:WorkspaceEmbeddings;close():Promise<void>}>{
 const profile=validateEmbeddingsProfile(profileInput);let closed=false;
 const snapshot=()=>{assertProxyConfig(options.config);const c=options.config,p=c.providers.custom;
  if(!p?.enabled||!p.configured||!p.endpointUrl||c.deviceRevokedAt||c.entitlementSuspendedAt)throw invalid();
  const url=new URL(p.endpointUrl);if(url.username||url.password||url.search||url.hash||url.origin!==new URL(profile.endpoint).origin)throw invalid();
  return canonicalJson({provider:p,tenant:c.appliedConfigTenantId??null,device:c.appliedConfigDeviceId??null,version:c.appliedConfigVersion??null,entitlement:c.entitlementRevision??null,contactTenant:c.lastControlPlaneContactTenantId??null,contactDevice:c.lastControlPlaneContactDeviceId??null});};
 const frozen=snapshot();let inner:Awaited<ReturnType<typeof launchWorkspaceEmbeddings>>|undefined;const current=()=>{try{if(closed||snapshot()!==frozen)throw invalid();}catch{closed=true;inner?.dispose();throw invalid();}};
 inner=await(dependencies.launch??launchWorkspaceEmbeddings)(join(productCodeRoots().INTEGRATIONS,'9router/app'),{model:profile.model,provider:'openai-compatible-quimera-custom',providerUrl:profile.endpoint,driverRevision:revision,store:options.store,
  resolveCredential:async()=>{current();const secret=await options.secrets.get('provider:custom');current();if(!secret)throw invalid();return secret;},
  fetchImpl:(url,init)=>{current();init?.signal?.throwIfAborted();return(dependencies.fetchImpl??fetch)(url,init);}});
 let closing:Promise<void>|undefined;const close=()=>{closed=true;return closing??=inner!.close();};
 try{current();const embeddings:WorkspaceEmbeddings={model:profile.model,endpoint:profile.endpoint,get available(){try{current();return inner!.available;}catch{return false;}},
  prepare:async(request,texts,signal)=>{current();const wire=await inner!.prepare(request,texts,signal);current();return wire;},
  execute:async(request,wire,texts,effect,gate)=>{
   // A changed profile or destination is refused before the executor: certainly not sent.
   try{current();if(effect.capability.dataDestination.id!=='custom')throw invalid();}catch{throw new MediaEffectError('not_sent','policy','embeddings_connection_changed');}
   return inner!.execute(request,wire,texts,{...effect,limits:{...effect.limits,timeoutMs:Math.min(effect.limits.timeoutMs,options.config.providers.custom!.requestTimeoutMs)}},gate);}};return{embeddings,close};
 }catch(error){await close();throw error;}
}


