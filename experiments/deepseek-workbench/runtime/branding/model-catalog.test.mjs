import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
const source=readFileSync(new URL('./model-catalog.js',import.meta.url),'utf8');
function harness(initial={state:'connected',authenticated:true}, preload=()=>Promise.resolve()) {
  const window=new EventTarget(),bindings=new Set(),refreshes=new Set(),timers=new Map(),effects=[];
  let revision=0,state=initial,next=0,resets=0,prefetches=0;
  const soft=[];
  window.setTimeout=fn=>{timers.set(++next,fn);return next;};
  window.clearTimeout=id=>timers.delete(id);
  window.UptokeyCanonicalAccount={accountBindingRevision:()=>revision,publicAccountSnapshot:()=>state,
    subscribeAccountBinding:fn=>{bindings.add(fn);return()=>bindings.delete(fn);},
    subscribeAccountCatalogRefresh:fn=>{refreshes.add(fn);return()=>refreshes.delete(fn);}};
  runInNewContext(source,{window});
  window.UptokeyHarnessModelCatalog.apply({inject(_,run){run({modelDirectories:{
    resetCatalog(){resets++;},prefetchCatalog(){prefetches++;return preload();},refreshCatalog(after){soft.push(after);}},effect:run=>effects.push(run())});}});
  return {soft,get prefetches(){return prefetches;},get resets(){return resets;},get pending(){return timers.size;},get subscriptions(){return bindings.size+refreshes.size;},
    flush(){for(const [id,fn]of [...timers]){timers.delete(id);fn();}},
    binding(){revision++;for(const fn of bindings)fn();},focus(){for(const fn of refreshes)fn();},
    state(value){state=value;window.dispatchEvent(new Event('uptokey:account-state'));},
    dispose(){for(const fn of effects)fn();}};
}
test('same-account focus retains catalog and coalesces duplicate signals',()=>{
  const f=harness();f.flush();assert.equal(f.prefetches,1);assert.deepEqual(f.soft,[]);
  for(let i=0;i<30;i++)f.focus();f.flush();assert.deepEqual(f.soft,[false]);assert.equal(f.resets,0);
});
test('account switch or logout clears old-account catalog once and dominates focus',()=>{
  const f=harness();f.flush();f.focus();f.binding();f.focus();f.flush();assert.equal(f.resets,1);assert.equal(f.soft.length,0);
  f.state({state:'signed_out',authenticated:false});f.binding();f.focus();f.flush();assert.equal(f.resets,2);
});
test('first authenticated observation invalidates any pre-login generation once',()=>{
  for(const state of [null,{state:'signed_out',authenticated:false},{state:'connecting',authenticated:false},{state:'unavailable',authenticated:false}]){
    const f=harness(state);f.state({state:'connected',authenticated:true});f.binding();f.flush();assert.deepEqual(f.soft,[]);assert.equal(f.resets,1);
    f.state({state:'connected',authenticated:true});f.flush();assert.equal(f.resets,1);assert.equal(f.prefetches,0);
  }
});

test('opening while authenticated prefetches without a dropdown or refresh',()=>{
  const f=harness();assert.equal(f.prefetches,0);f.flush();
  assert.equal(f.prefetches,1);assert.equal(f.resets,0);assert.deepEqual(f.soft,[]);
  for(let i=0;i<20;i++)f.state({state:'connected',authenticated:true});
  f.flush();assert.equal(f.prefetches,1);assert.equal(f.resets,0);
});

test('metadata failure is contained and does not automatically retry or block local UI',async()=>{
  const f=harness(undefined,()=>Promise.reject(Error('metadata unavailable')));f.flush();
  await Promise.resolve();await Promise.resolve();
  for(let i=0;i<20;i++)f.state({state:'connected',authenticated:true});
  f.flush();assert.equal(f.prefetches,1);assert.equal(f.pending,0);assert.deepEqual(f.soft,[]);assert.equal(f.resets,0);
});

test('logout and later login each invalidate the prior generation even without a binding callback',()=>{
  const f=harness();f.flush();
  f.state({state:'signed_out',authenticated:false});f.flush();assert.equal(f.resets,1);
  f.state({state:'connecting',authenticated:false});f.flush();assert.equal(f.resets,1);
  f.state({state:'connected',authenticated:true});f.flush();assert.equal(f.resets,2);
});
test('signed-out focus does nothing; disposal removes pending work and subscriptions',()=>{
  const f=harness({state:'signed_out',authenticated:false});f.focus();f.flush();assert.equal(f.soft.length,0);
  f.binding();assert.equal(f.pending,1);f.dispose();assert.equal(f.subscriptions,0);assert.equal(f.pending,0);f.flush();assert.equal(f.resets,0);
});
