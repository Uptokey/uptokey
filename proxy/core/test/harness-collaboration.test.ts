import test from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {Hono} from 'hono';
import {MemorySecretStore,NativeSecretStore} from '../src/secret-store.ts';
import {createClientKey,updateClientKey} from '../src/client-keys.ts';
import {registrationKey} from '../src/workspace/client-registration.ts';
import {harnessExtensionIdentity,harnessCollaborationMethod,harnessCollaborationQuery,registerHarnessCollaborationRoutes,HARNESS_CLIENT_ROUTE} from '../src/harness-collaboration.ts';
const origin='chrome-extension://'+'a'.repeat(32);
async function fixture(){
 const secrets=new MemorySecretStore(),client=await createClientKey(secrets,{label:'Synthetic extension',scopes:['inference:chat','models:read'],operationId:randomUUID()});
 await secrets.set(registrationKey(client.policy.id),JSON.stringify({schemaVersion:1,clientId:client.policy.id,audience:'browser-extension',enrolledVia:'pairing',policyRevision:1,projects:'*',createdAt:new Date().toISOString(),browserOrigin:origin}));
 return {secrets,client,authorization:'Bearer '+client.token};
}
test('persistent Harness sharing rejects ephemeral or managed finite model/provider/project policies',async()=>{
 for(const patch of [{retentionMode:'ephemeral' as const},{modelIds:['only-model']},{providerIds:['only-provider']},{projectIds:['only-project']},{scopes:['models:read' as const]},{enabled:false}]){
  const f=await fixture();await harnessExtensionIdentity(f.secrets,f.authorization,origin,undefined);
  await updateClientKey(f.secrets,f.client.policy.id,{expectedRevision:1,operationId:randomUUID(),...patch});
  await assert.rejects(harnessExtensionIdentity(f.secrets,f.authorization,origin,undefined));
 }
});
test('identity follows actual paired bearer and exact current registration, never a caller id or account state',async()=>{
 const f=await fixture(),identity=await harnessExtensionIdentity(f.secrets,f.authorization,origin,undefined);assert.equal(identity.clientId,f.client.policy.id);assert.match(identity.authorityDigest,/^[a-f0-9]{64}$/);
 assert.equal(JSON.stringify(identity).includes(f.client.token),false);await assert.rejects(harnessExtensionIdentity(f.secrets,f.authorization,'chrome-extension://'+'b'.repeat(32),undefined));
 await f.secrets.set(registrationKey(f.client.policy.id),JSON.stringify({schemaVersion:1,clientId:f.client.policy.id,audience:'tauri',enrolledVia:'pairing',policyRevision:2,projects:'*',createdAt:new Date().toISOString()}));await assert.rejects(harnessExtensionIdentity(f.secrets,f.authorization,origin,undefined));
});
test('only exact fixed POST collaboration endpoints and no public queries are admitted',()=>{
 const id=randomUUID();assert.equal(harnessCollaborationMethod('/v1/workspace/harness-collaboration/request'),'POST');assert.equal(harnessCollaborationMethod('/v1/workspace/harness-collaboration/call/../request'),undefined);
 assert.equal(harnessCollaborationMethod('/v1/workspace/harness-collaboration/status'),'POST');assert.equal(harnessCollaborationMethod('/v1/workspace/harness-collaboration/events'),'POST');
 assert.equal(harnessCollaborationQuery(new URL('http://127.0.0.1:21435/v1/workspace/harness-collaboration/events?grantId='+id)),false);
 for(const suffix of ['?grantId='+id+'&grantId='+id,'?grantId='+id+'&url=http://169.254.169.254/','?id='+id])assert.equal(harnessCollaborationQuery(new URL('http://127.0.0.1:21435/v1/workspace/harness-collaboration/events'+suffix)),false);
 assert.equal(harnessCollaborationQuery(new URL('http://127.0.0.1:21435/not-collaboration/status?id='+id)),false);
});
test('browser status and event reads use real-Origin POST JSON and translate only validated ids to internal GET',async()=>{
 const f=await fixture(),id=randomUUID(),calls:Array<{url:string;method:string|undefined;origin:string|null;body:unknown}>=[];
 const app=new Hono();registerHarnessCollaborationRoutes(app,{secrets:f.secrets,fetcher:async(url,options)=>{calls.push({url:String(url),method:options?.method,origin:new Headers(options?.headers).get('origin'),body:options?.body});return new Response('{}',{headers:{'content-type':'application/json'}});}});
 const post=(action:string,body:unknown,requestOrigin:string|undefined=origin)=>app.request('http://127.0.0.1:21435/v1/workspace/harness-collaboration/'+action,{method:'POST',headers:{authorization:f.authorization,'content-type':'application/json',...(requestOrigin?{origin:requestOrigin}:{})},body:JSON.stringify(body)});
  for(const [action,field] of [['status','id'],['events','grantId']] as const){const response=await post(action,{[field]:id});assert.equal(response.status,200);await response.text();assert.deepEqual(calls.at(-1),{url:'http://127.0.0.1:43180/uptokey/collaboration/'+action+'?'+field+'='+id,method:'GET',origin,body:undefined});}
 const before=calls.length;
 for(const bad of [{id:'http://169.254.169.254/'},{id,sessionId:'other'},{id,origin}])assert.notEqual((await post('status',bad)).status,200);
 assert.notEqual((await post('status',{id},'')).status,200);assert.notEqual((await post('status?id='+id,{id})).status,200);assert.equal(calls.length,before);
});
test('active tab transport retains exact paired origin, fixed destination and bounded POST-only authority',async()=>{
 const f=await fixture(),calls:Array<{url:string;method:string|undefined;body:string}>=[];
 const app=new Hono();registerHarnessCollaborationRoutes(app,{secrets:f.secrets,fetcher:async(url,options)=>{calls.push({url:String(url),method:options?.method,body:String(options?.body)});return new Response('{"detached":true}',{headers:{'content-type':'application/json'}});}});
 const path='/v1/workspace/harness-collaboration/browser',body={grantId:randomUUID(),operation:'detach'};
 assert.equal(harnessCollaborationMethod(path),'POST');assert.equal(harnessCollaborationQuery(new URL('http://127.0.0.1:21435'+path+'?grantId='+body.grantId)),false);
 const post=(requestOrigin:string)=>app.request('http://127.0.0.1:21435'+path,{method:'POST',headers:{authorization:f.authorization,origin:requestOrigin,'content-type':'application/json'},body:JSON.stringify(body)});
 const response=await post(origin);assert.equal(response.status,200);assert.deepEqual(await response.json(),{detached:true});assert.deepEqual(calls,[{url:'http://127.0.0.1:43180/uptokey/collaboration/browser',method:'POST',body:JSON.stringify(body)}]);
 assert.notEqual((await post('chrome-extension://'+'b'.repeat(32))).status,200);assert.equal(calls.length,1);
 assert.equal((await app.request('http://127.0.0.1:21435'+path,{headers:{authorization:f.authorization,origin}})).status,404);assert.equal(calls.length,1);
});

test('collaboration routes retain typed native capacity during lazy client policy migration',async()=>{
 for(const native of [false,true])for(const failure of ['capacity','aggregate','generic'] as const){
  const f=await fixture(),id=f.client.policy.id;
  // Same post-pairing state as a newly enrolled client: registration and bearer
  // exist, but policy/meta/index have not yet been lazily materialized.
  for(const key of ['local:client-policy:'+id,'local:client-meta:'+id,'local:client-index'])f.secrets.values.delete(key);
  if(native){const registration=JSON.parse(f.secrets.values.get(registrationKey(id))!);registration.audience='tauri';delete registration.browserOrigin;f.secrets.values.set(registrationKey(id),JSON.stringify(registration));}
  let policyWrites=0,upstreamCalls=0;
  const nativeStore=new NativeSecretStore((_service,account)=>({
   getPassword:()=>f.secrets.values.get(account)??null,
   setPassword(value:string){
    if(account==='local:client-policy:'+id){policyWrites++;throw Object.assign(Error(failure==='generic'?'private-policy-canary':'Platform failure: Windows error code 8\n\nCaused by:\n    Windows error code 8'),{code:'GenericFailure'});}
    f.secrets.values.set(account,value);
   },
   deletePassword:()=>f.secrets.values.delete(account),
  }),'win32');
  const secrets={get:nativeStore.get.bind(nativeStore),delete:nativeStore.delete.bind(nativeStore),async set(key:string,value:string){try{await nativeStore.set(key,value);}catch(error){if(failure==='aggregate')throw new AggregateError([error,Error('private-cleanup-canary')],'client_provision_rollback_failed');throw error;}}};
  const app=new Hono();registerHarnessCollaborationRoutes(app,{secrets,fetcher:async()=>{upstreamCalls++;throw Error('unexpected upstream');}});
  const path=native?HARNESS_CLIENT_ROUTE:'/v1/workspace/harness-collaboration/request';
  const body=native?{recipientAuthorization:f.authorization,origin,operation:'request',sessionId:null}:{};
  const send=(requestOrigin:string|undefined)=>app.request('http://127.0.0.1:21435'+path,{method:'POST',headers:{authorization:f.authorization,'content-type':'application/json',...(requestOrigin?{origin:requestOrigin}:{})},body:JSON.stringify(body)});
  const rejected=await send(native?origin:'https://untrusted.invalid');
  assert.equal(rejected.status,native?403:503);assert.equal(policyWrites,0);assert.equal(upstreamCalls,0);
  const response=await send(native?undefined:origin);assert.equal(response.status,failure==='generic'&&native?403:503);
  assert.deepEqual(await response.json(),{error:{type:failure==='generic'?(native?'harness_collaboration_denied':'harness_collaboration_unavailable'):'secure_storage_full'}});
  if(failure!=='generic')assert.equal(response.headers.get('cache-control'),'no-store');
  assert.equal(policyWrites,1,'capacity does not retry or bypass lazy enrollment');assert.equal(upstreamCalls,0);
  assert.equal(f.secrets.values.has('local:client-policy:'+id),false);
 }
});
