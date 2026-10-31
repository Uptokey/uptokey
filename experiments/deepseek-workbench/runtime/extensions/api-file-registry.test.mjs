import test from 'node:test';import assert from 'node:assert/strict';
import {registeredApiPrefixes} from './api-file-registry.mjs';
import {apiToFile} from './api-file-pipeline.mjs';
const entry={id:'uptokey-api-new-api',name:'@deepseek-ai/dsh-mcp-client',config:{serverName:'new-api'}};
const profile=()=>[{insert:[structuredClone(entry)]},{id:'uptokey-api-file',config:{servers:['mcp__new-api__']}}];
test('registered API survives fixed overlay and removal is effective immediately',()=>{
 const doc=profile();assert.deepEqual(registeredApiPrefixes(['mcp__weather__'],doc),['mcp__weather__','mcp__new-api__']);
 doc[0].insert[0].disabled=true;assert.deepEqual(registeredApiPrefixes(['mcp__weather__'],doc),['mcp__weather__']);
});
test('unregistered prefix, wrong plugin and invalid values cannot grant authority',()=>{
 const doc=profile();doc[0].insert[0].name='other-plugin';assert.deepEqual(registeredApiPrefixes([],doc),[]);
 assert.deepEqual(registeredApiPrefixes([],[doc[1]]),[]);
 doc[1].config.servers=['mcp__'];assert.throws(()=>registeredApiPrefixes([],doc));
});

test('registration accepts the original MCP 32-character server boundary and rejects 33',()=>{
 const server='a'.repeat(32),prefix='mcp__'+server+'__';
 const doc=[{insert:[{id:'uptokey-api-'+server,name:'@deepseek-ai/dsh-mcp-client',config:{serverName:server}}]},{id:'uptokey-api-file',config:{servers:[prefix]}}];
 assert.deepEqual(registeredApiPrefixes([],doc),[prefix]);
 doc[1].config.servers=['mcp__'+'a'.repeat(33)+'__'];assert.throws(()=>registeredApiPrefixes([],doc),/registry_invalid/);
 assert.throws(()=>registeredApiPrefixes(['mcp__'+'a'.repeat(33)+'__'],[]),/registry_invalid/);
});
test('newly registered API uses existing exact JSON write and verification pipeline',async()=>{
 let saved;const calls=[];
 const tools={execute:async call=>{calls.push(call.name);if(call.name==='mcp__new-api__items')return {content:[{type:'text',text:'{"items":[1,2]}'}]};if(call.name==='write'){saved=call.arguments.content;return {value:{path:call.arguments.file_path,after:saved}};}return {value:{path:call.arguments.file_path,lines:[{text:saved??''}]}};}};
 let verified=false;
 const path=await apiToFile(tools,{signal:new AbortController().signal,callId:'fixture'}, {api_tool:'mcp__new-api__items',api_arguments:{},file_path:'/workspace/result.json'},registeredApiPrefixes(['mcp__weather__'],profile()),async receipt=>{
  assert.equal(receipt.written.path,receipt.checked.path);assert.equal(receipt.content,saved);verified=true;
 });
 assert.equal(path,'/workspace/result.json');assert.equal(saved,'{"items":[1,2]}');assert.equal(verified,true);assert.deepEqual(calls,['mcp__new-api__items','read','write','read']);
});
