/** Paired Chrome transport into the existing Harness. Account sharing grants no session authority. */
import {createHash} from 'node:crypto';
import type {Hono} from 'hono';
import {secretStoreFailureCode,type SecretStore} from './secret-store.ts';
import {authenticateContextCredential,contextEpoch} from './workspace/client-context-link.ts';
import type {IdentityEpoch} from './workspace/principal.ts';
import {readBoundedJson} from '@uptokey/sync-contract/limits';

export const HARNESS_COLLABORATION_PREFIX='/v1/workspace/harness-collaboration';
export const HARNESS_CLIENT_ROUTE='/local/harness-collaboration/client';
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const ORIGIN=/^chrome-extension:\/\/[a-p]{32}$/;
const METHODS=new Map([['request','POST'],['status','POST'],['call','POST'],['events','POST'],['disconnect','POST'],['browser','POST']]);
const actions=new Set(['request','status','history','prompt','stop','events','disconnect','browser']);
export function harnessCollaborationMethod(path:string):'GET'|'POST'|undefined {
 if(path===HARNESS_CLIENT_ROUTE)return 'POST';
 if(!path.startsWith(HARNESS_COLLABORATION_PREFIX+'/'))return;
 return METHODS.get(path.slice(HARNESS_COLLABORATION_PREFIX.length+1)) as 'GET'|'POST'|undefined;
}
// Chrome's privileged GET fetch can omit Origin. Public collaboration reads
// use POST JSON so the browser supplies its real Origin; no claimed fallback.
export function harnessCollaborationQuery(_url:URL):boolean {return false;}
function denied(type='harness_collaboration_denied',status=403):never {throw Object.assign(Error(type),{status});}
function record(value:unknown):Record<string,unknown>{if(!value||typeof value!=='object'||Array.isArray(value))return denied('harness_collaboration_invalid',400);return value as Record<string,unknown>;}
function exact(value:Record<string,unknown>,keys:string[]){if(Object.keys(value).sort().join(',')!==[...keys].sort().join(','))denied('harness_collaboration_invalid',400);}
/** Neither native caller nor a clientId assertion can stand in for recipient bearer possession. */
export async function harnessExtensionIdentity(secrets:SecretStore,authorization:string|undefined,origin:string|undefined,epoch:IdentityEpoch,now=Date.now()) {
 if(!origin||!ORIGIN.test(origin))return denied('origin_rejected');
 const client=await authenticateContextCredential(authorization,secrets,now);
 if(client.kind!=='client'||client.delegation||!client.clientId||!client.policy||client.policy.retentionMode==='ephemeral'||client.registration?.audience!=='browser-extension'||client.registration.enrolledVia!=='pairing'||client.registration.browserOrigin!==origin)return denied();
 // A Harness Session is not a core project/model identity. Never silently
 // translate a managed finite grant into access to an unrelated owner Session.
 if(client.policy.projectIds.length||client.policy.providerIds.length||client.policy.modelIds.length||client.registration.projects!=='*'||!client.policy.scopes.includes('inference:chat'))return denied();
 const authorityDigest=createHash('sha256').update(JSON.stringify([contextEpoch(epoch),client.clientId,client.policy,client.registration])).digest('hex');
 return {clientId:client.clientId,origin,authorityDigest};
}
export function registerHarnessCollaborationRoutes(app:Hono,{secrets,epoch=()=>undefined,fetcher=fetch}:{secrets:SecretStore;epoch?:()=>IdentityEpoch;fetcher?:typeof fetch}) {
 app.post(HARNESS_CLIENT_ROUTE,async c=>{
  try{
   if(c.req.header('origin')!==undefined)return c.json({error:{type:'origin_rejected'}},403);
   if(c.req.header('content-type')!=='application/json')return c.json({error:{type:'unsupported_media_type'}},415);
   const native=await authenticateContextCredential(c.req.header('authorization'),secrets);
   if(native.kind!=='client'||native.delegation||!native.policy||native.policy.retentionMode==='ephemeral'||native.registration?.audience!=='tauri'||native.registration.enrolledVia!=='pairing')return c.json({error:{type:'harness_native_client_required'}},403);
   const input=await readBoundedJson(c.req.raw,4096);if(!input.ok)return c.json({error:{type:'harness_collaboration_invalid'}},400);
   const body=record(input.value);exact(body,['recipientAuthorization','origin','operation','sessionId']);
   if(typeof body.recipientAuthorization!=='string'||body.recipientAuthorization.length>256||typeof body.origin!=='string'||!actions.has(String(body.operation))||!(body.sessionId===null||typeof body.sessionId==='string'&&body.sessionId.length>0&&body.sessionId.length<=256&&!/[\u0000-\u001f\u007f]/.test(body.sessionId)))return c.json({error:{type:'harness_collaboration_invalid'}},400);
   const identity=await harnessExtensionIdentity(secrets,body.recipientAuthorization,body.origin,epoch());
   return c.json({schemaVersion:1,...identity,operation:body.operation,sessionId:body.sessionId});
  }catch(error){const capacity=secretStoreFailureCode(error);if(capacity)return c.json({error:{type:capacity}},503,{'cache-control':'no-store'});return c.json({error:{type:'harness_collaboration_denied'}},403);}
 });
 app.all(HARNESS_COLLABORATION_PREFIX+'/*',async c=>{
  const action=c.req.path.slice(HARNESS_COLLABORATION_PREFIX.length+1),method=METHODS.get(action);
  if(!method||method!==c.req.method)return c.json({error:{type:'route_not_found'}},404);
  try{
   await harnessExtensionIdentity(secrets,c.req.header('authorization'),c.req.header('origin'),epoch());
   const url=new URL(c.req.url);if(url.search)return c.json({error:{type:'query_rejected'}},400);
   let body:string|undefined,upstreamMethod=method,query='';
   if(method==='POST'){
    if(c.req.header('content-type')!=='application/json')return c.json({error:{type:'unsupported_media_type'}},415);
    const input=await readBoundedJson(c.req.raw,24576);if(!input.ok)return c.json({error:{type:'harness_collaboration_invalid'}},400);
    if(action==='status'||action==='events'){
     const field=action==='status'?'id':'grantId',value=record(input.value);exact(value,[field]);
     if(typeof value[field]!=='string'||!UUID.test(value[field]))return c.json({error:{type:'harness_collaboration_invalid'}},400);
     query='?'+field+'='+encodeURIComponent(value[field]);upstreamMethod='GET';
    }else body=JSON.stringify(input.value);
   }
   const signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(action==='events'?300000:30000)]);
   const upstream=await fetcher('http://127.0.0.1:43180/uptokey/collaboration/'+action+query,{method:upstreamMethod,headers:{authorization:c.req.header('authorization')!,origin:c.req.header('origin')!,accept:action==='events'?'text/event-stream':'application/json',...(body?{'content-type':'application/json'}:{})},body,signal,redirect:'error'});
   const type=upstream.headers.get('content-type')?.split(';',1)[0];
   if(type!=='application/json'&&!(action==='events'&&type==='text/event-stream')){await upstream.body?.cancel();return c.json({error:{type:'harness_collaboration_unavailable'}},502);}
   // Retain backpressure and recheck the original paired client on every read,
   // including after an awaited upstream read across a possible revocation.
   const reader=upstream.body?.getReader();let bytes=0;
   const stream=reader?new ReadableStream<Uint8Array>({async pull(controller){try{await harnessExtensionIdentity(secrets,c.req.header('authorization'),c.req.header('origin'),epoch());const item=await reader.read();await harnessExtensionIdentity(secrets,c.req.header('authorization'),c.req.header('origin'),epoch());if(item.done){controller.close();reader.releaseLock();return;}bytes+=item.value.byteLength;if(item.value.byteLength>1024*1024||bytes>16*1024*1024)throw Error();controller.enqueue(item.value);}catch{await reader.cancel().catch(()=>{});controller.error(Error('harness_collaboration_unavailable'));}},async cancel(reason){await reader.cancel(reason);}}, {highWaterMark:0}):null;
   return new Response(stream,{status:upstream.status,headers:{'content-type':upstream.headers.get('content-type')!,'cache-control':'no-store'}});
  }catch(error){const capacity=secretStoreFailureCode(error);if(capacity)return c.json({error:{type:capacity}},503,{'cache-control':'no-store'});return c.json({error:{type:'harness_collaboration_unavailable'}},503);}
 });
}
