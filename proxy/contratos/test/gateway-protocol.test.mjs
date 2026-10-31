import test from 'node:test';
import assert from 'node:assert/strict';
import {parseGatewayProtocolRequest as parse,GATEWAY_PROTOCOL_CONTRACT_VERSION} from '../gateway.js';

test('protocol envelope preserves exact original bytes and is immutable',()=>{
  assert.equal(GATEWAY_PROTOCOL_CONTRACT_VERSION,1);
  for(const protocol of ['openai-responses','anthropic-messages']){
    const input={schemaVersion:1,protocol,body:'{ "model": "fixture", "input": "café" }'};
    const result=parse(input);input.body='{}';
    assert.equal(result.body,'{ "model": "fixture", "input": "café" }');
    assert.ok(Object.isFrozen(result));
  }
});
test('protocol envelope rejects extra authority, invalid JSON, UTF16 and byte overflow',()=>{
  const base={schemaVersion:1,protocol:'openai-responses',body:'{}'};
  for(const input of [{...base,principalId:'other'},{...base,protocol:'unknown'},{...base,schemaVersion:2},
    ...['null','[]','{','"text"','{"x":"'+ '\ud800' +'"}','{"x":"'+'é'.repeat(6000)+'"}'].map(body=>({...base,body}))])
    assert.throws(()=>parse(input),/gateway_protocol_invalid/);
});
test('protocol envelope rejects accessors without executing them',()=>{
  let calls=0;const input={schemaVersion:1,protocol:'openai-responses'};
  Object.defineProperty(input,'body',{enumerable:true,get(){calls++;return '{}';}});
  assert.throws(()=>parse(input),/gateway_protocol_invalid/);assert.equal(calls,0);
});
