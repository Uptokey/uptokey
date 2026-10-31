import test from 'node:test';import assert from 'node:assert/strict';
import {createLocalDiscovery} from './local-discovery.mjs';
function fixture(){
 let revision=1,writes=0,ids=['new:tag'];
 const route={baseURL:'http://127.0.0.1:43192/v1',models:[]};
 const settings={describe:()=>[{ns:'llm-pi-ai',revision,value:{providers:{'ollama-local':structuredClone(route)}}}],update:async(ns,patch,expected)=>{assert.equal(ns,'llm-pi-ai');if(expected!==revision)throw Error('SETTINGS_CONFLICT');assert.deepEqual(Object.keys(patch.providers['ollama-local']),['models']);route.models=patch.providers['ollama-local'].models;revision++;writes++;}};
 const request=async(path)=>path==='/v1/models'?{data:ids.map(id=>({id}))}:path==='/api/ps'?{models:[]}:{capabilities:['completion'],parameters:'num_ctx 8192'};
 return {settings,request,route,get writes(){return writes;},change:()=>{revision++;},setIds:value=>{ids=value;}};
}
test('native revision update only changes models; identical refresh does not write',async()=>{
 const f=fixture(),refresh=createLocalDiscovery(f.settings,f.request);
 assert.equal((await refresh()).state,'updated');assert.equal(f.writes,1);
 assert.equal((await refresh()).state,'unchanged');assert.equal(f.writes,1);
 f.setIds(['second']);await refresh();assert.equal(f.route.models[0].id,'second');
});
test('concurrent UI write rejects stale catalog without retry or overwrite',async()=>{
 const f=fixture();const refresh=createLocalDiscovery(f.settings,async(path)=>{if(path==='/api/show')f.change();return f.request(path);});
 await assert.rejects(refresh(),/SETTINGS_CONFLICT/);assert.equal(f.writes,0);assert.deepEqual(f.route.models,[]);
});
test('simultaneous refresh shares work; offline failure preserves previous catalog',async()=>{
 const f=fixture(),refresh=createLocalDiscovery(f.settings,f.request);
 const a=refresh(),b=refresh();assert.equal(a,b);await a;assert.equal(f.writes,1);
 const fail=createLocalDiscovery(f.settings,async()=>{throw Error('offline');});
 await assert.rejects(fail(),/offline/);assert.equal(f.route.models[0].id,'new:tag');
});
test('foreign endpoint is never queried or overwritten',async()=>{
 const f=fixture();f.route.baseURL='https://remote.invalid/v1';
 assert.equal((await createLocalDiscovery(f.settings,()=>{throw Error('must not call');})()).state,'unconfigured');assert.equal(f.writes,0);
});
