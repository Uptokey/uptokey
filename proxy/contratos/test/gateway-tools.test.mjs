import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGatewayFunctionTools,canonicalGatewayFunctionTools,parseGatewayToolProposal,parseGatewayToolPlanRequest,parseGatewayChatRequest,canonicalGatewayChatPayload} from '../gateway.js';
const tools=()=>[{type:'function',function:{name:'get_file_info',description:'Inspect metadata',strict:true,
  parameters:{type:'object',properties:{relativePath:{type:'string'}},required:['relativePath'],additionalProperties:false}}}];
const proposal=()=>({schemaVersion:1,content:null,toolCalls:[{id:'call_1',type:'function',
  function:{name:'get_file_info',arguments:'{ "relativePath" : "sample.txt" }'}}]});

test('tool plan selection contains references only, never caller-supplied arguments or authority',()=>{
  const selection={expectedRevision:1,artifactId:'artifact-1',callId:'call_1'};
  assert.deepEqual(parseGatewayToolPlanRequest(selection),selection);
  assert.ok(Object.isFrozen(parseGatewayToolPlanRequest(selection)));
  for(const change of [{expectedRevision:0},{expectedRevision:1.2},{artifactId:'../private'},{callId:''},
    {arguments:'{}'},{principalId:'owner'},{approved:true}])assert.throws(()=>parseGatewayToolPlanRequest({...selection,...change}),/gateway_tool_invalid/);
});

test('approved schemas are copied immutably and every parameter affects canonical binding',()=>{
  const input=tools(),parsed=parseGatewayFunctionTools(input),canonical=canonicalGatewayFunctionTools(input);
  input[0].function.parameters.properties.relativePath.type='number';
  assert.equal(parsed[0].function.parameters.properties.relativePath.type,'string');
  assert.ok(Object.isFrozen(parsed[0].function.parameters.properties.relativePath));
  assert.notEqual(canonicalGatewayFunctionTools(input),canonical);
  for(const field of ['description','strict','name']){
    const changed=tools();changed[0].function[field]=field==='strict'?false:'different';
    assert.notEqual(canonicalGatewayFunctionTools(changed),canonical);
  }
});

test('proposals preserve exact arguments and do not mutate after source changes',()=>{
  const input=proposal(),parsed=parseGatewayToolProposal(input,tools());
  assert.equal(parsed.toolCalls[0].function.arguments,input.toolCalls[0].function.arguments);
  input.toolCalls[0].function.arguments='{}';
  assert.equal(parsed.toolCalls[0].function.arguments,'{ "relativePath" : "sample.txt" }');
  assert.ok(Object.isFrozen(parsed.toolCalls[0].function));
  assert.deepEqual(parseGatewayToolProposal({...proposal(),content:'Suggested inspection'},tools()).content,'Suggested inspection');
});

test('tool catalogs reject executable/non-JSON data, duplicate names and oversized schemas',()=>{
  let called=false;
  const getter=tools();Object.defineProperty(getter[0].function.parameters,'properties',{get(){called=true;return {};},enumerable:true});
  for(const input of [[],[...tools(),...tools()],Array(17).fill(tools()[0]),
    [{...tools()[0],execute:()=>{}}],getter,
    [{type:'function',function:{name:'get_file_info',parameters:{type:'object',description:'x'.repeat(65536)}}}],
    [{type:'function',function:{name:'get_file_info',parameters:{type:'array'}}}],
    [{type:'function',function:{name:'get_file_info',parameters:{type:'object',description:'\ud800'}}}],
    [{type:'function',function:{name:'get_file_info',parameters:{type:'object'},strict:undefined}}]]){
    assert.throws(()=>parseGatewayFunctionTools(input),/gateway_tool_invalid/);
  }
  assert.equal(called,false);
});

test('proposals reject unknown tools, duplicate call IDs, malformed arguments and hidden authority',()=>{
  const valid=proposal(),call=valid.toolCalls[0];
  for(const input of [{...valid,principalId:'owner'},{...valid,approved:true},{...valid,schemaVersion:2},
    {...valid,toolCalls:[]},{...valid,toolCalls:[call,call]},
    {...valid,toolCalls:[{...call,function:{...call.function,name:'write_file'}}]},
    ...['null','[]','true','{','{"value":"'+ 'x'.repeat(65536)+'"}'].map(argumentsText=>
      ({...valid,toolCalls:[{...call,function:{...call.function,arguments:argumentsText}}]})),
    {...valid,content:'\ud800'}])assert.throws(()=>parseGatewayToolProposal(input,tools()),/gateway_tool_invalid/);
});

test('tool definitions and selection are included in approved chat without enabling tool history',()=>{
  const base={model:'fixture',messages:[{role:'user',content:'inspect'}],stream:false,max_tokens:16};
  const parsed=parseGatewayChatRequest({...base,tools:tools(),tool_choice:'auto',parallel_tool_calls:false});
  assert.deepEqual(parsed.tools,tools());assert.equal(parsed.parallel_tool_calls,false);
  assert.notEqual(canonicalGatewayChatPayload(parsed),canonicalGatewayChatPayload(base));
  assert.notEqual(canonicalGatewayChatPayload(parsed),canonicalGatewayChatPayload({...parsed,tool_choice:'required'}));
  assert.notEqual(canonicalGatewayChatPayload(parsed),canonicalGatewayChatPayload({...parsed,parallel_tool_calls:true}));
  for(const patch of [{tool_choice:'auto'},{parallel_tool_calls:false},{tools:tools(),tool_choice:{type:'function',function:{name:'write_file'}}},
    {tools:tools(),parallel_tool_calls:undefined},{tools:tools(),tool_choice:undefined},
    {messages:[{role:'tool',content:'unapproved result'}]}])assert.throws(()=>parseGatewayChatRequest({...base,...patch}),/gateway_chat_invalid/);
});
