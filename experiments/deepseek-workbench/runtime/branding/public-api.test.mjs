import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {runInNewContext} from 'node:vm';

const source=await readFile(new URL('./public-api.js',import.meta.url),'utf8');
const input=(overrides={})=>({apiId:'api-example-12345678',schemaSha256:'a'.repeat(64),operations:1,requestId:'api_1',...overrides});
const deferred=()=>Promise.withResolvers();
const plain=value=>JSON.parse(JSON.stringify(value));
function api(fetch,extras={}){
 const window=Object.assign(extras.window??{},{setTimeout,clearTimeout,fetch});
 runInNewContext(source,{window,AbortController,Uint8Array,TextDecoder,CustomEvent,...extras,window});
 return window.UptokeyHarnessPublicApiUI;
}
function fixture(request=async()=>({status:'ready',toolCount:1}),options){
 let current={id:'selected-session',scope:{}},changed,stopped=0;
 const calls=[],results=[];
 const bridge=api().connect({selection:()=>current,subscribe:listener=>{changed=listener;return()=>{stopped++;};},
  request:async(body,signal)=>{calls.push({body,signal});return request(body,signal);}},result=>results.push(result),options);
 return {bridge,calls,results,get stopped(){return stopped;},
  select(value){current=value;changed(false);},reset(){changed(true);}};
}

test('uses the selected retained session with no conversation navigation or mutation',async()=>{
 const f=fixture();
 const result=await f.bridge.enqueue(input());
 assert.deepEqual(plain(f.calls[0].body),{apiId:input().apiId,schemaSha256:input().schemaSha256,sessionId:'selected-session'});
 assert.equal(result.status,'ready');assert.equal(result.toolCount,1);
 assert.equal(f.results.length,1);assert.equal(f.results[0].requestId,'api_1');
 f.bridge.dispose();assert.equal(f.stopped,1);
});

test('coalesces identical API generation and deduplicates the native request id',async()=>{
 const wait=deferred(),f=fixture(()=>wait.promise);
 const first=f.bridge.enqueue(input()),duplicate=f.bridge.enqueue(input()),second=f.bridge.enqueue(input({requestId:'api_2'}));
 assert.equal(first,duplicate);
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.calls.length,1);
 wait.resolve({status:'ready',toolCount:2});
 await Promise.all([first,second]);assert.equal(f.results.length,2);
 await f.bridge.enqueue(input());assert.equal(f.calls.length,1);assert.equal(f.results.length,2);
 f.bridge.dispose();
});

test('no retained selection is saved, not ready, and never contacts the host',async()=>{
 const f=fixture();f.select(null);
 const result=await f.bridge.enqueue(input());
 assert.equal(result.status,'pending');assert.equal(result.code,'api_saved_no_session');assert.equal(f.calls.length,0);
 f.bridge.dispose();
});

test('navigation away and back invalidates the old success',async()=>{
 const wait=deferred(),f=fixture(()=>wait.promise);
 const first=f.bridge.enqueue(input());
 await new Promise(resolve=>setImmediate(resolve));
 f.select({id:'other-session',scope:{}});f.select({id:'selected-session',scope:{}});
 assert.equal(f.calls[0].signal.aborted,true);
 await first;wait.resolve({status:'ready',toolCount:1});
 await new Promise(resolve=>setImmediate(resolve));assert.equal(f.results.length,0);
 f.bridge.dispose();
});

test('schema replacement cancels stale readiness for the same namespace',async()=>{
 const old=deferred(),f=fixture(body=>body.schemaSha256==='a'.repeat(64)?old.promise:Promise.resolve({status:'ready',toolCount:3}));
 const first=f.bridge.enqueue(input());await new Promise(resolve=>setImmediate(resolve));
 const latest=f.bridge.enqueue(input({requestId:'api_2',schemaSha256:'b'.repeat(64)}));
 assert.equal(f.calls[0].signal.aborted,true);
 await Promise.all([first,latest]);old.resolve({status:'ready',toolCount:1});
 assert.equal(f.results.length,1);assert.equal(f.results[0].requestId,'api_2');assert.equal(f.results[0].toolCount,3);
 f.bridge.dispose();
});

test('reset and disposal abort work, drop late feedback and unsubscribe once',async()=>{
 for(const kind of ['reset','dispose']){
  const wait=deferred(),f=fixture(()=>wait.promise),run=f.bridge.enqueue(input());
  await new Promise(resolve=>setImmediate(resolve));
  if(kind==='reset')f.reset();else f.bridge.dispose();
  await run;wait.resolve({status:'ready',toolCount:1});
  await new Promise(resolve=>setImmediate(resolve));assert.equal(f.results.length,0);
  assert.equal(f.calls[0].signal.aborted,true);
  f.bridge.dispose();assert.equal(f.stopped,1);
 }
});

test('timeout leaves the registered API saved and does not block the queue',async()=>{
 const f=fixture(()=>new Promise(()=>{}),{timeoutMs:5});
 const answer=await f.bridge.enqueue(input());
 assert.equal(answer.status,'pending');assert.equal(answer.toolCount,0);assert.equal(f.calls[0].signal.aborted,true);
 f.bridge.dispose();
});

test('malformed receipts and transport errors never become ready or expose host details',async()=>{
 for(const result of [{status:'ready',toolCount:0},{status:'ready',toolCount:1.5},{status:'cosmetic',toolCount:5},null]){
  const f=fixture(async()=>result),answer=await f.bridge.enqueue(input());
  assert.equal(answer.status,'unavailable');f.bridge.dispose();
 }
 const f=fixture(async()=>{throw Error('/private/synthetic-secret');});
 const answer=await f.bridge.enqueue(input());
 assert.equal(answer.code,'api_start_unavailable');assert.equal(JSON.stringify(f.results).includes('synthetic-secret'),false);
 f.bridge.dispose();
});

test('invalid native requests are ignored and the pending queue is bounded',async()=>{
 const f=fixture(()=>new Promise(()=>{}));
 for(const bad of [{apiId:'a'.repeat(33)},{requestId:'bad\nrequest'},{schemaSha256:'BAD'},{operations:0}]){
  await f.bridge.enqueue(input(bad));
 }
 assert.equal(f.calls.length,0);assert.equal(f.results.length,0);
 const pending=[];
 for(let i=0;i<33;i++)pending.push(f.bridge.enqueue(input({apiId:'api-'+i,requestId:'api_'+i})));
 assert.equal((await pending[32]).status,'pending');
 f.bridge.dispose();await Promise.all(pending);assert.ok(f.calls.length<=1);
});

test('owner request uses the authenticated same-origin route and bounds response bytes',async()=>{
 let sent;
 const client=api(async(path,init)=>{sent={path,init};return new Response(JSON.stringify({status:'ready',toolCount:2}),{headers:{'content-type':'application/json'}});});
 const signal=new AbortController().signal;
 assert.deepEqual(plain(await client.request({apiId:input().apiId,schemaSha256:input().schemaSha256,sessionId:'session'},signal)),{status:'ready',toolCount:2});
 assert.equal(sent.path,'/api/uptokey/public-api-ready');assert.equal(sent.init.credentials,'same-origin');assert.equal(sent.init.redirect,'error');assert.equal(sent.init.signal,signal);
 assert.equal(Object.hasOwn(sent.init.headers,'authorization'),false);
 let cancelled=false;
 const tooLarge=api(async()=>new Response(new ReadableStream({start(controller){controller.enqueue(new Uint8Array(4097));},cancel(){cancelled=true;}}),{headers:{'content-type':'application/json'}}));
 await assert.rejects(tooLarge.request({},signal),/api_response_limit/);assert.equal(cancelled,true);
});

test('mounted hook accepts retained main view while the catalogue loads and tears down',async()=>{
 const window=new EventTarget(),target={dataset:{}},results=[],bodies=[],cleanups=[],subscribers=[];
 const currentScope={};let list={phase:'loading',byId:{one:{id:'one',retainedBy:{mainView:1}}}},entries=[input()];
 window.UptokeyHarnessPublicApis={take(){const value=entries;entries=[];return value;}};
 window.addEventListener('uptokey:public-api-result',event=>results.push(event.detail));
 const slots={inject(_name,run){run();},register(){return()=>{};}};
 const subscribe=listener=>{subscribers.push(listener);return()=>{subscribers.splice(subscribers.indexOf(listener),1);};};
 const scope={slots,locale:{register(){return()=>{};}},
  effect(run){const cleanup=run();if(typeof cleanup==='function')cleanups.push(cleanup);},
  sessions:{list:{getSnapshot:()=>list,subscribe},scope:id=>id==='one'?currentScope:undefined},
  layout:{panelInfo:{getSnapshot:()=>({activePanelId:null}),subscribe}},on(_name,listener){return subscribe(listener);}};
 const client=api(async(_path,init)=>{bodies.push(JSON.parse(init.body));return new Response(JSON.stringify({status:'ready',toolCount:2}),{headers:{'content-type':'application/json'}});},{window,document:{body:target}});
 const require=name=>name==='react/jsx-runtime'?{jsx:()=>null}:name==='@deepseek-ai/dsh-client-ui-primitives'?{Toast:()=>null}:{createSnapshotStore:()=>({set(){}})};
 client.apply({inject(names,run){assert.deepEqual(plain(names),['sessions','layout','locale']);run(scope);}},require);
 for(let i=0;i<10&&!results.length;i++)await new Promise(resolve=>setImmediate(resolve));
 assert.equal(target.dataset.uptokeyPublicApiReady,'true');assert.equal(results.length,1);
 assert.equal(bodies[0].sessionId,'one');assert.equal(results[0].status,'ready');
 list={phase:'ready',byId:{one:{id:'one',retainedBy:{mainView:1}},two:{id:'two',retainedBy:{mainView:1}}}};
 for(const changed of [...subscribers])changed();
 entries=[input({requestId:'api_2'})];window.dispatchEvent(new Event('uptokey:public-api-queued'));
 await new Promise(resolve=>setImmediate(resolve));
 assert.equal(results.at(-1).status,'pending');assert.equal(bodies.length,1);
 for(const cleanup of cleanups.reverse())cleanup();
 assert.equal(target.dataset.uptokeyPublicApiReady,undefined);assert.equal(subscribers.length,0);
 entries=[input({requestId:'api_3'})];window.dispatchEvent(new Event('uptokey:public-api-queued'));
 await new Promise(resolve=>setImmediate(resolve));assert.equal(bodies.length,1);
});
