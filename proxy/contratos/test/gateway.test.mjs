import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGatewayWireRequest, canonicalGatewayWirePayload,parseGatewayChatRequest,canonicalGatewayChatPayload,parseGatewayRunPreview } from '../gateway.js';
const wire = () => ({ schemaVersion: 1, driver: '9router', driverRevision: 'a'.repeat(40), provider: 'openai-compatible-fixture',
  model: 'fixture', method: 'POST', url: 'http://127.0.0.1:12345/v1/chat/completions',
  headers: { 'content-type': 'application/json', accept: 'application/json' }, body: '{ "model":"fixture", "stream":false, "messages":[] }' });

test('text chat copy rejects extra effects and preserves approved messages',()=>{
  const input={model:'fixture/test',messages:[{role:'user',content:'hello'}],stream:false,max_tokens:16};
  const frozen=parseGatewayChatRequest(input);
  input.messages[0].content='changed';
  assert.equal(frozen.messages[0].content,'hello');
  assert.ok(Object.isFrozen(frozen.messages[0]));
  assert.notEqual(canonicalGatewayChatPayload(input),canonicalGatewayChatPayload(frozen));
  assert.notEqual(canonicalGatewayChatPayload({...input,stream:true}),canonicalGatewayChatPayload(input));
  for(const change of [{stream:'true'},{tools:[]},{max_tokens:0},{messages:[]},{messages:[{role:'user',content:'x'.repeat(12000)}]},
    {messages:[{role:'user',content:'\ud800'}]},{messages:[{role:'tool',content:'x'}]},{messages:[{role:'user',content:[{text:'x'}]}]}]){
    assert.throws(()=>parseGatewayChatRequest({...input,...change}),/gateway_chat_invalid/);
  }
});

test('sampling controls preserve absence and zero, and change the canonical consent payload',()=>{
  const base={model:'fixture/test',messages:[{role:'user',content:'hello'}],stream:true,max_tokens:16};
  assert.deepEqual(parseGatewayChatRequest(base),base);
  for(const controls of [{temperature:0,top_p:0},{temperature:0.7,top_p:0.9},{temperature:2,top_p:1}]){
    const parsed=parseGatewayChatRequest({...base,...controls});
    assert.deepEqual(parsed,{...base,...controls});
    assert.notEqual(canonicalGatewayChatPayload(parsed),canonicalGatewayChatPayload(base));
    assert.ok(Object.isFrozen(parsed));
  }
  assert.notEqual(canonicalGatewayChatPayload({...base,temperature:0.7}),canonicalGatewayChatPayload({...base,temperature:0.8}));
  for(const key of ['temperature','top_p'])for(const value of [null,undefined,'0.7',NaN,Infinity,-0.1,key==='temperature'?2.01:1.01]){
    assert.throws(()=>parseGatewayChatRequest({...base,[key]:value}),/gateway_chat_invalid/);
  }
  for(const extra of [{stop:[]},{seed:1},{tools:[]}])assert.throws(()=>parseGatewayChatRequest({...base,...extra}),/gateway_chat_invalid/);
});

test('ephemeral preview is bounded, immutable and explicitly tied to an attempt',()=>{
  const input={runId:'run-1',attemptId:'attempt-1',sequence:1,text:'Partial text',truncated:false};
  assert.deepEqual(parseGatewayRunPreview(input),input);
  assert.ok(Object.isFrozen(parseGatewayRunPreview(input)));
  for(const patch of [{runId:'../other'},{attemptId:''},{sequence:0},{sequence:1.5},{text:'x'.repeat(65537)},
    {text:'\ud800'},{truncated:'false'},{principalId:'not-a-preview-field'}]){
    assert.throws(()=>parseGatewayRunPreview({...input,...patch}),/gateway_preview_invalid/);
  }
});
test('preserves bytes and copies immutable header data', () => {
  const input = wire(), parsed = parseGatewayWireRequest(input);
  input.headers.accept = 'text/event-stream';
  assert.equal(parsed.headers.accept, 'application/json');
  assert.equal(parsed.body, input.body);
  assert.ok(Object.isFrozen(parsed));
});
test('binding changes for body bytes, destination, model or driver revision', () => {
  const original = wire(), digestInput = canonicalGatewayWirePayload(original);
  for (const change of [{ body: JSON.stringify(JSON.parse(original.body)) }, { url: 'https://example.com/v1/chat/completions' },
    { model: 'other', body: '{"model":"other","stream":false}' }, { driverRevision: 'b'.repeat(40) }]) {
    assert.notEqual(canonicalGatewayWirePayload({ ...original, ...change }), digestInput);
  }
});
test('rejects credentials, alternate transports and ambiguous input', () => {
  const original = wire();
  for (const change of [{ headers: { ...original.headers, authorization: 'fixture' } }, { url: 'http://example.com/v1/chat/completions' },
    { url: 'https://user:password@example.com/v1/chat/completions' }, { url: original.url + '?key=fixture' },
    { method: 'GET' }, { principalId: 'untrusted' }, { body: '{"model":"other","stream":false}' }, { schemaVersion: 2 }]) {
    assert.throws(() => parseGatewayWireRequest({ ...original, ...change }), /gateway_wire_invalid/);
  }
  let invoked = false;
  assert.throws(() => parseGatewayWireRequest({ ...original, get body() { invoked = true; return original.body; } }));
  assert.equal(invoked, false);
  assert.throws(() => parseGatewayWireRequest({ ...original, driverRevision: { toString() { invoked = true; return 'a'.repeat(40); } } }));
  assert.equal(invoked, false);
  assert.throws(() => parseGatewayWireRequest({ ...original, body: '{"model":"fixture","stream":false,"text":"\ud800"}' }));
});
