import test from 'node:test';
import assert from 'node:assert/strict';
import {createPublicApiReady,apply,PUBLIC_API_READY_PATH,inject} from './public-api-ready.mjs';
import {publicApiConfig} from '../../scripts/public-api-config.mjs';

const hash='a'.repeat(64),input={apiId:'api-fixture',schemaSha256:hash,sessionId:'synthetic-session'};
const path='/home/node/.dsh/attachments/.uptokey-public-apis/'+hash+'.json';
const request=(value=input,options={})=>new Request('http://127.0.0.1:43180'+PUBLIC_API_READY_PATH,{
 method:'POST',headers:{'content-type':'application/json',...options.headers},body:JSON.stringify(value),signal:options.signal,
});
function fixture(){
 const agent={id:input.sessionId},listeners=new Map();
 const config={serverName:input.apiId,transport:'stdio',command:'node',args:['fixture.mjs','--openapi-spec',path]};
 const entry={disabled:false,options:{id:'uptokey-api-'+input.apiId,name:'@deepseek-ai/dsh-mcp-client',config},fiber:{state:2,config:structuredClone(config)}};
 const f={agent,entry,rows:[entry],live:agent,visible:['mcp__api-fixture__get','read'],lookups:0,schemaCalls:0,afterSchemas:undefined,globalDefinitions:new Map(),scopedDefinitions:new Map(),globalMissing:new Set()};
 const ctx={
  agents:{get(id){f.lookups++;return id===input.sessionId?f.live:undefined;}},
  loader:{entries:()=>f.rows},
  tools:{
   schemas(scope){assert.equal(scope,agent);f.schemaCalls++;const tools=f.visible.map(name=>({name}));f.afterSchemas?.();return tools;},
   get(name,scope){
    if(scope!==undefined){assert.equal(scope,agent);if(f.scopedDefinitions.has(name))return f.scopedDefinitions.get(name);}
    if(f.globalMissing.has(name))return undefined;
    if(!f.globalDefinitions.has(name))f.globalDefinitions.set(name,{name});
    return f.globalDefinitions.get(name);
   },
  },
  on(name,listener){const group=listeners.get(name)??new Set();listeners.set(name,group);group.add(listener);return()=>group.delete(listener);},
 };
 f.ctx=ctx;f.events=name=>{for(const fn of [...(listeners.get(name)??[])])fn();};
 f.listenerCount=()=>[...listeners.values()].reduce((n,group)=>n+group.size,0);
 f.ready=createPublicApiReady(ctx,{timeoutMs:40,bodyTimeoutMs:40});
 return f;
}
const body=async response=>({http:response.status,...await response.json()});

test('the exact streaming route delegates owner/trust authentication to HostConnection',async()=>{
 const f=fixture(),effects=[];let route;
 f.ctx.connection={fetch:{register(value){route=value;}}};f.ctx.effect=fn=>effects.push(fn());
 apply(f.ctx);
 assert.deepEqual(inject,['connection','loader','agents','tools']);
 assert.equal(route.path,PUBLIC_API_READY_PATH);assert.deepEqual(route.methods,['POST']);assert.equal(route.requestBody,'streaming');
 assert.deepEqual(await body(await route.fetch(request())),{http:200,status:'ready',toolCount:1});
 await effects[0]();assert.deepEqual(await body(await route.fetch(request())),{http:200,status:'unavailable',toolCount:0,code:'disposed'});
});

test('ready comes from the existing session Agent and matching loaded MCP tools only',async()=>{
 const f=fixture();assert.deepEqual(await body(await f.ready.fetch(request())),{http:200,status:'ready',toolCount:1});
 assert.ok(f.lookups>=2);assert.equal(f.schemaCalls,1);assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('scoped shadows cannot certify a global API and the same visible global definition can',async()=>{
 const f=fixture(),name='mcp__api-fixture__get',scopedOnly='mcp__api-fixture__scoped';
 f.scopedDefinitions.set(name,{name,source:'different-scoped-MCP'});
 f.scopedDefinitions.set(scopedOnly,{name:scopedOnly});f.globalMissing.add(scopedOnly);f.visible.push(scopedOnly);
 let settled=false;const pending=f.ready.fetch(request()).then(value=>{settled=true;return value;});
 await new Promise(resolve=>setTimeout(resolve,0));
 assert.equal(settled,false);assert.equal(f.schemaCalls,1);
 f.scopedDefinitions.delete(name);f.events('tools/change');
 assert.deepEqual(await body(await pending),{http:200,status:'ready',toolCount:1});
 assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('original canonical SSH registration arguments match the schema hash',async()=>{
 const f=fixture();
 const plugin=publicApiConfig({id:input.apiId,baseUrl:'https://example.com/api',spec:{openapi:'3.0.0',paths:{'/items':{get:{}}}},specPath:path});
 f.entry.options.config=plugin.config;f.entry.fiber.config=structuredClone(plugin.config);
 assert.equal((await body(await f.ready.fetch(request()))).status,'ready');await f.ready.dispose();
});

test('malformed input and the actual streaming byte cap cannot reach registry checks',async()=>{
 const f=fixture();
 for(const value of [{...input,extra:true},{...input,apiId:'a'.repeat(33)},{...input,schemaSha256:'../secret'},{...input,sessionId:''},[],null]){
  assert.equal((await body(await f.ready.fetch(request(value)))).http,400);
 }
 const large=new Request('http://127.0.0.1'+PUBLIC_API_READY_PATH,{method:'POST',headers:{'content-type':'application/json'},body:' '.repeat(2049)});
 assert.deepEqual(await body(await f.ready.fetch(large)),{http:413,status:'unavailable',toolCount:0,code:'request_too_large'});
 assert.equal(f.lookups,0);assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('a missing live Agent is unavailable without creating or resuming a session',async()=>{
 const f=fixture();f.live=undefined;
 assert.deepEqual(await body(await f.ready.fetch(request())),{http:200,status:'unavailable',toolCount:0,code:'session_unavailable'});
 assert.equal(f.schemaCalls,0);assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('active inventory without visible tools stays pending and releases listeners at deadline',async()=>{
 const f=fixture();f.visible=['read','mcp__different__get'];
 assert.deepEqual(await body(await f.ready.fetch(request())),{http:200,status:'pending',toolCount:0,code:'no_visible_tools'});
 assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('awaits original watcher activation instead of reconciling or restarting',async()=>{
 const f=fixture();f.rows=[];
 const pending=f.ready.fetch(request());
 await new Promise(resolve=>setTimeout(resolve,0));
 f.rows=[f.entry];f.events('internal/status');
 assert.equal((await body(await pending)).status,'ready');assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('wrong namespace, loaded schema hash or module cannot borrow unrelated tools',async()=>{
 for(const change of [
  f=>{f.entry.options.name='other-module';},
  f=>{f.entry.fiber.config.serverName='different';},
  f=>{f.entry.fiber.config.args[2]=path.replace(hash,'b'.repeat(64));},
 ]){
  const f=fixture();change(f);
  assert.deepEqual(await body(await f.ready.fetch(request())),{http:200,status:'pending',toolCount:0,code:'registration_pending'});
  assert.equal(f.schemaCalls,0);await f.ready.dispose();
 }
});

test('Agent, entry, or loaded configuration replacement during wait invalidates the receipt',async()=>{
 for(const change of [
  f=>{f.live={id:input.sessionId};},
  f=>{f.rows=[{...f.entry}];},
  f=>{f.entry.fiber.config.args.push('changed');},
 ]){
  const f=fixture();f.visible=[];const pending=f.ready.fetch(request());
  await new Promise(resolve=>setTimeout(resolve,0));change(f);f.visible=['mcp__api-fixture__get'];f.events('tools/change');
  const receipt=await body(await pending);assert.equal(receipt.status,'unavailable');assert.equal(receipt.toolCount,0);
  assert.equal(f.listenerCount(),0);await f.ready.dispose();
 }
});

test('post-projection identity check rejects a target changed by a scoped provider',async()=>{
 const f=fixture();f.afterSchemas=()=>{f.entry.fiber.config.args.push('changed');};
 assert.deepEqual(await body(await f.ready.fetch(request())),{http:200,status:'unavailable',toolCount:0,code:'registration_changed'});
 assert.equal(f.listenerCount(),0);await f.ready.dispose();
});

test('request cancellation and disposal settle pending waits without leaked subscriptions',async()=>{
 const f=fixture(),abort=new AbortController();f.visible=[];
 const pending=f.ready.fetch(request(input,{signal:abort.signal}));await new Promise(resolve=>setTimeout(resolve,0));abort.abort();
 assert.deepEqual(await body(await pending),{http:200,status:'unavailable',toolCount:0,code:'cancelled'});assert.equal(f.listenerCount(),0);
 const next=f.ready.fetch(request());await new Promise(resolve=>setTimeout(resolve,0));await f.ready.dispose();
 assert.deepEqual(await body(await next),{http:200,status:'unavailable',toolCount:0,code:'disposed'});assert.equal(f.listenerCount(),0);
});

test('a stalled request body cannot hold disposal while stream cancellation stays pending',async()=>{
 const f=fixture();let cancelled=0;
 const stream=new ReadableStream({pull(){},cancel(){cancelled++;return new Promise(()=>{});}});
 const pending=f.ready.fetch(new Request('http://127.0.0.1'+PUBLIC_API_READY_PATH,{method:'POST',headers:{'content-type':'application/json'},body:stream,duplex:'half'}));
 await new Promise(resolve=>setTimeout(resolve,0));await f.ready.dispose();
 assert.equal((await body(await pending)).code,'disposed');assert.ok(cancelled>0);assert.equal(f.listenerCount(),0);
});
