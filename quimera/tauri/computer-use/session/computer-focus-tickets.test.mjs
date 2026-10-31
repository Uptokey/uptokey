import test from 'node:test';
import assert from 'node:assert/strict';
import {createFocusTickets,validFocusCorrelation} from './computer-focus-tickets.mjs';
const correlation={sessionId:'s-one',callId:'c-one',toolName:'mcp__computer__computer_click',fingerprint:'a'.repeat(64)};
function fixture(required=true){
  let now=1000,ready=true;const frames=[];
  const owner=createFocusTickets({leaseId:'b'.repeat(32),expiresAt:100000,required,now:()=>now,isReady:()=>ready,notify:frame=>frames.push(frame)});
  const arm=async()=>{const p=owner.request({operation:'prepare',correlation});const frame=frames.at(-1);owner.acknowledge({type:'focus-registered',id:frame.ticket.id});return (await p).ticket};
  return {owner,arm,frames,setNow:value=>now=value,setReady:value=>ready=value};
}
test('registered ticket is exact; only native pipe approval permits a single consume',async()=>{
  const {owner,arm}=fixture();try{const ticket=await arm();assert.equal(owner.size(),1);
    await assert.rejects(owner.request({operation:'consume',ticket:{...ticket,callId:'different'}}));
    owner.acknowledge({type:'focus-approved',id:ticket.id});
    assert.deepEqual(await owner.request({operation:'consume',ticket}),{consumed:true});
    await assert.rejects(owner.request({operation:'consume',ticket}));
  }finally{owner.close()}
});
test('renderer-like approval before native registration cannot authorize a request',async()=>{
  const {owner,frames}=fixture();const p=owner.request({operation:'prepare',correlation});
  assert.throws(()=>owner.acknowledge({type:'focus-approved',id:frames[0].ticket.id}),/order/);
  owner.close();await assert.rejects(p);assert.equal(owner.size(),0);
});
test('cancel, expiry, native denial and connection loss revoke correlation',async()=>{
  for(const mode of ['cancel','expiry','deny','connection','close']){
    const f=fixture(),ticket=await f.arm();
    if(mode==='cancel'){await f.owner.request({operation:'cancel',ticket});await f.owner.request({operation:'cancel',ticket})}
    if(mode==='expiry')f.setNow(ticket.expiresAt);
    if(mode==='deny')f.owner.acknowledge({type:'focus-denied',id:ticket.id});
    if(mode==='connection')f.setReady(false);
    if(mode==='close')f.owner.close();
    await assert.rejects(f.owner.request({operation:'consume',ticket}));f.owner.close();
  }
});
test('capacity, request shape, methods and unknown acknowledgement fields fail closed',async()=>{
  const f=fixture();try{
    for(let i=0;i<8;i++)await f.arm();
    await assert.rejects(f.owner.request({operation:'prepare',correlation}),/capacity/);
    assert.equal(validFocusCorrelation({...correlation,toolName:'mcp__computer__computer_screenshot'}),false);
    assert.equal(validFocusCorrelation({...correlation,pid:123}),false);
    assert.equal(validFocusCorrelation({...correlation,sessionId:'x'.repeat(129)}),false);
    assert.throws(()=>f.owner.acknowledge({type:'focus-approved',id:'a'.repeat(32),allowed:true}));
  }finally{f.owner.close()}
});
test('non-Windows explicitly negotiates no handoff without a native ticket',async()=>{
  const f=fixture(false);assert.deepEqual(await f.owner.request({operation:'prepare',correlation}),{required:false});
  assert.equal(f.frames.length,0);f.owner.close();
});
