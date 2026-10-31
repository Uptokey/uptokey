import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {parseGatewayChatRequest,canonicalGatewayChatPayload} from '../gateway.js';
const require=createRequire(import.meta.url);
const guard=require("../../integracoes/9router/app/quimera-gateway-context.cjs");
const call=(id='call_1',name='get_file_info',args='{ "relativePath": "café.txt" }')=>({id,type:'function',function:{name,arguments:args}});
const assistant=(calls=[call()])=>({role:'assistant',content:null,tool_calls:calls});
const result=(id='call_1',content='size: 3\r\n')=>({role:'tool',tool_call_id:id,content});
const base=()=>({model:'fixture',stream:false,max_tokens:128,tools:[{type:'function',function:{name:'get_file_info',parameters:{type:'object'}}}],messages:[{role:'user',content:'Inspect'},assistant(),result()]});
test('tool history preserves exact argument/result strings and deep immutable copies',()=>{
  const input=base(),parsed=parseGatewayChatRequest(input);
  assert.equal(parsed.messages[1].tool_calls[0].function.arguments,'{ "relativePath": "café.txt" }');
  assert.equal(parsed.messages[2].content,'size: 3\r\n');
  input.messages[1].tool_calls[0].function.arguments='{}';input.messages[2].content='changed';
  assert.equal(parsed.messages[2].content,'size: 3\r\n');
  assert.throws(()=>{parsed.messages[1].tool_calls[0].function.arguments='{}';},TypeError);
  assert.throws(()=>{parsed.messages[2].content='changed';},TypeError);
  const changed=base();changed.messages[2].content='size: 3\n';
  assert.notEqual(canonicalGatewayChatPayload(base()),canonicalGatewayChatPayload(changed));
  changed.messages[2].content='size: 3\r\n';changed.messages[1].tool_calls[0].function.arguments='{"relativePath":"café.txt"}';
  assert.notEqual(canonicalGatewayChatPayload(base()),canonicalGatewayChatPayload(changed));
});
test('orphan, duplicate, incomplete and interleaved histories fail closed',()=>{
  for(const messages of [
    [result()], [assistant()], [assistant(),result('other')], [assistant(),result(),result()],
    [assistant(),{role:'user',content:'interleaved'},result()], [assistant(),assistant([call('call_2')]),result(),result('call_2')],
    [assistant(),result(),assistant(),result()], [assistant([call(),call()]),result()],
    [assistant([call('call_1','unapproved')]),result()],
  ])assert.throws(()=>parseGatewayChatRequest({...base(),messages}),/gateway_chat_invalid/);
  const without=base();delete without.tools;assert.throws(()=>parseGatewayChatRequest(without));
});
test('multiple contiguous results may arrive in reverse order; all pairs must finish',()=>{
  const messages=[assistant([call(),call('call_2')]),result('call_2'),result(),{role:'assistant',content:'done'}];
  assert.equal(parseGatewayChatRequest({...base(),messages}).messages.length,4);
  assert.throws(()=>parseGatewayChatRequest({...base(),messages:messages.slice(0,2)}));
});
test('getters are rejected without execution at message, array and nested call boundaries',()=>{
  let invoked=0;const getter={get(){invoked++;return 'unexpected';},enumerable:true};
  for(const mutate of [
    input=>Object.defineProperty(input.messages[2],'content',getter),
    input=>Object.defineProperty(input.messages,'1',getter),
    input=>Object.defineProperty(input.messages[1].tool_calls[0].function,'arguments',getter),
  ]){const input=base();mutate(input);assert.throws(()=>parseGatewayChatRequest(input));}
  assert.equal(invoked,0);
});
test('invalid UTF-16, oversized bytes and extra tool-result fields are rejected',()=>{
  for(const content of ['\ud800','é'.repeat(6000)]){const input=base();input.messages[2].content=content;assert.throws(()=>parseGatewayChatRequest(input));}
  const extra=base();extra.messages[2].name='get_file_info';assert.throws(()=>parseGatewayChatRequest(extra));
});
test('child profile admits W0 tool history without translating or expanding it',()=>{
  const body=parseGatewayChatRequest(base()),context={model:'fixture',signal:new AbortController().signal,dispatch(){throw new Error('must_not_dispatch');}};
  assert.equal(guard.run(context,()=>guard.assertTextBody(body)),context);
  assert.throws(()=>guard.assertTextBody(body));
  for(const message of [{role:'tool',content:'result'}, {role:'user',content:'x',tool_calls:[call()]}, {role:'assistant',content:null,function_call:{name:'get_file_info'}}]){
    assert.throws(()=>guard.run(context,()=>guard.assertTextBody({...body,messages:[message]})));
  }
});
