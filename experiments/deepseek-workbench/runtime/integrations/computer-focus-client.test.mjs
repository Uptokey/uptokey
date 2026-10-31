import test from 'node:test';
import assert from 'node:assert/strict';
import {prepareComputerFocus} from './computer-focus-client.mjs';
const correlation={sessionId:'s',callId:'c',toolName:'mcp__computer__computer_click',fingerprint:'a'.repeat(64)};
const lease={id:'b'.repeat(32),expiresAt:Date.now()+60000};
const ticket={id:'c'.repeat(32),leaseId:lease.id,...correlation,expiresAt:Date.now()+30000};
test('Host validates exact lease/call and sends consume only once',async()=>{
  const calls=[];const request=async(_,input)=>{calls.push(input.operation);return input.operation==='prepare'?{required:true,ticket}:{consumed:true}};
  const focus=await prepareComputerFocus(correlation,undefined,{lease,request});
  assert.deepEqual(focus.ticket,ticket);assert.equal(await focus.consume(),true);assert.equal(await focus.consume(),false);await focus.cancel();
  assert.deepEqual(calls,['prepare','consume']);
});
test('forged correlation/lease, old unsupported handshake and unexpected response shapes fail closed',async()=>{
  for(const response of [{required:true,ticket:{...ticket,expiresAt:'not-a-number'}},{required:true,ticket:{...ticket,callId:'other'}},{required:true,ticket:{...ticket,leaseId:'d'.repeat(32)}},{required:false,ticket},{}]){
    await assert.rejects(prepareComputerFocus(correlation,undefined,{lease,request:async()=>response}));
  }
});
test('abort sends cancellation without signal so the old pending ticket is revoked',async()=>{
  const controller=new AbortController(),calls=[];
  const request=async(_,input,options)=>{calls.push({input,options});return input.operation==='prepare'?{required:true,ticket}:{cancelled:true}};
  const focus=await prepareComputerFocus(correlation,controller.signal,{lease,request});controller.abort();
  assert.equal(await focus.consume(),false);await focus.cancel();assert.deepEqual(calls.map(call=>call.input.operation),['prepare','cancel']);assert.equal(calls[1].options,undefined);
});
test('Linux/macOS no-focus response preserves original approval route',async()=>{
  assert.equal(await prepareComputerFocus(correlation,undefined,{lease,request:async()=>({required:false})}),null);
});
