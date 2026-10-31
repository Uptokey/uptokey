import test from 'node:test';
import assert from 'node:assert/strict';
import {runInNewContext} from 'node:vm';
import {patchModelCatalogReset,patchModelCatalogPrefetch} from './model-catalog-patch.mjs';
// Pinned compiled Cordis resolver seats. No alternative catalog implementation.
const fixture=`var ModelDirectoryResolver = class extends _deepseek_ai_cordis.Service {
\t\t\tstatic inject = [
\t\t\t\t"sessions",
\t\t\t\t"remote",
\t\t\t\t"remote.session"
\t\t\t];
\t\t\tlive = { directories: new WeakMapWithValues() };
\t\t\tcatalog;
\t\t\tconstructor(ctx) {
\t\t\t\tsuper(ctx);
\t\t\t\tthis.catalog = ctx.catalog;
\t\t\t\tctx.remote.$on("credentials/reference-updated", () => {
\t\t\t\t\tthis.catalog.refresh();
\t\t\t\t});
\t\t\t}
\t\t\t/**
\t\t\t* Resolve the per-session shared directory (lazy; the scope disposer
\t\t\t* removes and disposes it). Unknown sessions fail loud.
\t\t\t* @param sessionId - the owning session.
\t\t\t* @returns the resident directory both entries share.
\t\t\t*/
\t\t\tdirectoryFor(sessionId) { return sessionId; }
\t\t};
\t\t//#endregion
function display(state,currentChoice,t) {
const waiting = currentChoice === void 0 && state.status === "loading";
const banner = state.status === "loading" && (0, react_jsx_runtime.jsx)("div", {});
return currentChoice?.model.name ?? t("trigger.fallback");
}
function retry(available,directory,models){if (available) directory.load().catch(() => {});}
function orderModelProviders(groups){return groups.toSorted((left,right)=>(left.id === "deepseek-account" ? 0 : 2)-(right.id === "deepseek-account" ? 0 : 2));}`;
function resolver(overrides={}) {
  let state={status:'ready',value:{groups:[{id:'hosted',models:['hosted-free']}]}};
  const listeners=new Set(),effects=[];let requests=0,resets=0;
  const catalog={store:{getSnapshot:()=>state,subscribe:fn=>{listeners.add(fn);return()=>listeners.delete(fn);}},
    load(){return Promise.resolve(state.value);},
    refresh(){requests++;state={...state,status:'loading'};},resetGeneration(){resets++;state={status:'loading',value:null};},...overrides};
  const Resolver=runInNewContext(patchModelCatalogReset(fixture)+'\nModelDirectoryResolver;',{
    _deepseek_ai_cordis:{Service:class{}},WeakMapWithValues:class{},
  });
  const instance=new Resolver({catalog,remote:{$on(){}},effect:fn=>effects.push(fn())});
  return {instance,get state(){return state;},get requests(){return requests;},get resets(){return resets;},
    get subscribers(){return listeners.size;},settle(status='ready'){state={...state,status};for(const fn of [...listeners])fn();},
    dispose(){effects.forEach(fn=>fn());}};
}

test('startup prefetch and dropdown use the exact original catalog promise',async()=>{
  const pending=Promise.withResolvers();let calls=0;
  const catalogLoad=()=>{calls++;return pending.promise;};
  const f=resolver({load:catalogLoad});
  const first=f.instance.prefetchCatalog();
  assert.equal(first,pending.promise);assert.equal(f.instance.prefetchCatalog(),first);
  // The session directory calls the same owner load(), not a separate fetch.
  assert.equal(catalogLoad(),first);assert.equal(f.requests,0);assert.equal(f.resets,0);
  pending.resolve({groups:[{id:'local',models:['existing']} ]});
  assert.equal(await first,await pending.promise);assert.equal(calls,3);
});

test('prefetch rejection remains visible to the caller without an implicit retry',async()=>{
  let loads=0;const f=resolver({load(){loads++;return Promise.reject(Error('catalog unavailable'));}});
  await assert.rejects(f.instance.prefetchCatalog(),/catalog unavailable/);
  assert.equal(loads,1);assert.equal(f.requests,0);assert.equal(f.resets,0);assert.equal(f.subscribers,0);
});

test('strict accepted-resolver delta equals the canonical full patch and refuses reapplication',()=>{
  const full=patchModelCatalogReset(fixture);
  const method='\t\t\t// Startup and selectors share the original catalog promise and cache.\n\t\t\tprefetchCatalog() {\n\t\t\t\treturn this.catalog.load();\n\t\t\t}\n';
  const previous=full.replace(method,'');assert.notEqual(previous,full);
  assert.equal(patchModelCatalogPrefetch(previous),full);
  assert.throws(()=>patchModelCatalogPrefetch(full),/already exposes prefetchCatalog/);
  assert.throws(()=>patchModelCatalogPrefetch(previous.replace('invalidate the account catalog','changed reset marker')),/reset seat changed/);
});
test('focus storms share one fetch while the same catalog remains visible',()=>{
  const f=resolver(),resident=f.state.value;f.instance.refreshCatalog();
  for(let i=0;i<50;i++)f.instance.refreshCatalog();
  assert.equal(f.requests,1);assert.equal(f.state.value,resident);assert.equal(f.resets,0);assert.equal(f.subscribers,0);
});
test('confirmed input during load queues exactly one refresh after completion',()=>{
  const f=resolver();f.instance.refreshCatalog();
  for(let i=0;i<50;i++)f.instance.refreshCatalog(true);
  assert.equal(f.requests,1);assert.equal(f.subscribers,1);f.settle();assert.equal(f.requests,2);assert.equal(f.subscribers,0);
  f.settle('error');assert.equal(f.requests,2);
});
test('account reset cancels old pending refresh and clears resident data',()=>{
  const f=resolver();f.instance.refreshCatalog();f.instance.refreshCatalog(true);f.instance.resetCatalog();
  assert.equal(f.subscribers,0);assert.equal(f.state.value,null);assert.equal(f.resets,1);f.settle();assert.equal(f.requests,1);
});
test('scope disposal cancels queued refresh without an extra request',()=>{
  const f=resolver();f.instance.refreshCatalog();f.instance.refreshCatalog(true);f.dispose();f.settle();assert.equal(f.requests,1);
});
test('loading display retains selected model and excludes blocking spinner',()=>{
  const patched=patchModelCatalogReset(fixture);
  const display=runInNewContext(patched+'\ndisplay;',{
    _deepseek_ai_cordis:{Service:class{}},react_jsx_runtime:{jsx(){throw Error('loading banner rendered');}},WeakMapWithValues:class{},
  });
  assert.equal(display({status:'loading',current:{model:'hosted-free'}},undefined,()=> 'Choose model'),'hosted-free');
});
test('pinned-source drift and duplicate application are refused',()=>{
  assert.throws(()=>patchModelCatalogReset(fixture.replace('credentials/reference-updated','credentials/changed')),/seat changed/);
  assert.throws(()=>patchModelCatalogReset(fixture.replace('const waiting =','let waiting =')),/trigger seat changed/);
  assert.throws(()=>patchModelCatalogReset(patchModelCatalogReset(fixture)),/already exposes resetCatalog/);
});
test('retry of a partial catalog starts a real shared refresh and retains usable groups',()=>{
  const retry=runInNewContext(patchModelCatalogReset(fixture)+'\nretry;',{
    _deepseek_ai_cordis:{Service:class{}},WeakMapWithValues:class{},
  });
  let refreshed=0,loads=0;const directory={store:{getSnapshot:()=>({failures:[{id:'hosted'}]})},load(){loads++;return Promise.resolve();}};
  retry(true,directory,{refreshCatalog(){refreshed++;}});assert.equal(refreshed,1);assert.equal(loads,1);
  retry(false,directory,{refreshCatalog(){throw Error('unavailable selector');}});assert.equal(loads,1);
});
test('hosted provider is visible first while other provider order remains stable',()=>{
  const order=runInNewContext(patchModelCatalogReset(fixture)+'\norderModelProviders;',{
    _deepseek_ai_cordis:{Service:class{}},WeakMapWithValues:class{},
  });
  const input=[{id:'local-1'},{id:'local-2'},{id:'uptokey-hosted'}];assert.deepEqual(order(input).map(row=>row.id),['uptokey-hosted','local-1','local-2']);assert.equal(input[0].id,'local-1');
});
