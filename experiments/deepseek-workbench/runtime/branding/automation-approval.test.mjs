import test from 'node:test';
import assert from 'node:assert/strict';
import { apply, automationApprovalRequired } from './automation-approval.mjs';

test('read-only browser exploration does not add prompts; page and desktop input use canonical approval', () => {
  for (const operation of ['browser_snapshot', 'browser_take_screenshot', 'browser_navigate'])
    assert.equal(automationApprovalRequired(`mcp__browser__${operation}`), false);
  for (const operation of ['browser_click', 'browser_type', 'browser_fill_form', 'browser_evaluate', 'unknown'])
    assert.equal(automationApprovalRequired(`mcp__browser__${operation}`), true);
  assert.equal(automationApprovalRequired('mcp__computer__click'), true);
  assert.equal(automationApprovalRequired('mcp__computer__computer_screenshot'), false);
  assert.equal(automationApprovalRequired('mcp__computer__computer_snapshot'), false);
  assert.equal(automationApprovalRequired('read'), false);
});

function fixture(outcome) {
  const events = {}, requests = [];
  let guard;
  apply({ on: (event, fn) => { events[event] = fn; }, tools: { guard: fn => { guard = fn; } },
    approval: { request: async request => { requests.push(request); return outcome; } } },{prepareFocus:async()=>null});
  const call = { token: Symbol(), callId: 'one', name: 'mcp__computer__click', arguments: { x: 2, y: 3 }, agent: {}, signal: new AbortController().signal };
  return { events, requests, guard, call };
}

test('approval is exact to registry token and arguments, cannot be upgraded by later allow and expires on result', async () => {
  const { events, requests, guard, call } = fixture('allowed-once');
  assert.ok(guard(call));
  assert.equal((await events['tools/pre-execute'](call, async () => ({ kind: 'allow' }))).kind, 'allow');
  assert.equal(requests[0].requireInteraction, true);
  assert.equal(requests[0].callId, 'one');
  assert.equal(guard(call), undefined);
  assert.ok(guard(call), 'one-shot grant must be consumed by the first dispatch');
  assert.ok(guard({ ...call, token: Symbol() }));
  assert.ok(guard({ ...call, arguments: { x: 3, y: 2 } }));
  events['tools/result'](call);
  assert.ok(guard(call));
});

test('changed arguments cannot reuse approval, including mutation of the same object', async () => {
  const { events, guard, call } = fixture('allowed-once');
  await events['tools/pre-execute'](call, async () => ({ kind: 'allow' }));
  call.arguments.x = 99;
  assert.ok(guard(call));
});

test('arguments are fingerprinted before waiting for approval', async () => {
  const events = {};
  const call = { token: Symbol(), callId: 'pending', name: 'mcp__computer__click', arguments: { x: 2 }, agent: {}, signal: new AbortController().signal };
  apply({ on: (event, fn) => { events[event] = fn; }, tools: { guard: () => {} },
    approval: { request: async () => { call.arguments.x = 9; return 'allowed-once'; } } },{prepareFocus:async()=>null});
  assert.equal((await events['tools/pre-execute'](call, async () => ({ kind: 'allow' }))).kind, 'deny');
});

for (const outcome of ['rejected', 'cancelled', 'unavailable']) test(`${outcome} never dispatches input`, async () => {
  const { events, guard, call } = fixture(outcome);
  assert.equal((await events['tools/pre-execute'](call, async () => ({ kind: 'allow' }))).kind, 'deny');
  assert.ok(guard(call));
});

test('prior denial and cancellation never issue an extra request', async () => {
  const { events, requests, call } = fixture('allowed-once');
  const denied = { kind: 'deny', reason: 'owner denied' };
  assert.equal(await events['tools/pre-execute'](call, async () => denied), denied);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(events['tools/pre-execute']({ ...call, signal: controller.signal }, async () => ({ kind: 'allow' })));
  assert.equal(requests.length, 0);
});

test('Host requires private native consumption, not merely allowed-once from a renderer',async()=>{
  for(const accepted of [true,false]){
    const events={},order=[];let guard,correlation,request;
    const ticket={id:'opaque'};
    apply({on:(name,fn)=>events[name]=fn,tools:{guard:fn=>guard=fn},approval:{request:async value=>{request=value;order.push('approval');return 'allowed-once'}}},
      {prepareFocus:async value=>{correlation=value;order.push('prepare');return {ticket,consume:async()=>{order.push('consume');return accepted},cancel:async()=>order.push('cancel')}}});
    const call={token:Symbol(),callId:'one',name:'mcp__computer__computer_click',arguments:{x:2},agent:{session:{id:'session'}},signal:new AbortController().signal};
    const result=await events['tools/pre-execute'](call,async()=>({kind:'allow'}));
    assert.deepEqual(order,['prepare','approval','consume','cancel']);assert.equal(request.nativeFocus,ticket);
    assert.equal(request.displayReason.en,'Allow this action in the selected desktop window?');
    assert.equal(correlation.sessionId,'session');assert.equal(correlation.callId,'one');assert.match(correlation.fingerprint,/^[a-f0-9]{64}$/);
    assert.equal(result.kind,accepted?'allow':'deny');assert.equal(guard(call)===undefined,accepted);assert.ok(guard(call));
  }
});

test('manual foreground guidance uses the same exact approval and never allows rejected input',async()=>{
  for(const outcome of ['allowed-once','rejected']){
    const {events,requests,guard,call}=fixture(outcome);
    const result=await events['tools/pre-execute'](call,async()=>({kind:'allow'}));
    assert.equal(requests.length,1);
    assert.equal(requests[0].requireInteraction,true);
    assert.equal(requests[0].nativeFocus,undefined);
    assert.match(requests[0].displayReason.en,/selected desktop window.*15 seconds/);
    assert.match(requests[0].displayReason.pt,/janela selecionada.*15 segundos/);
    assert.equal(result.kind,outcome==='allowed-once'?'allow':'deny');
    assert.equal(guard(call)===undefined,outcome==='allowed-once');
    assert.ok(guard(call),'the manual return hint must not authorize a second dispatch');
  }
});

test('rejection cancels native ticket and changed arguments never consume it',async()=>{
  for(const changed of [true,false]){
    const events={},order=[];const call={token:Symbol(),callId:'one',name:'mcp__computer__computer_type',arguments:{text:'synthetic'},agent:{session:{id:'s'}},signal:new AbortController().signal};
    apply({on:(name,fn)=>events[name]=fn,tools:{guard:()=>{}},approval:{request:async()=>{if(changed)call.arguments.text='changed';return changed?'allowed-once':'rejected'}}},
      {prepareFocus:async()=>({ticket:{},consume:async()=>{order.push('consume');return true},cancel:async()=>order.push('cancel')})});
    assert.equal((await events['tools/pre-execute'](call,async()=>({kind:'allow'}))).kind,'deny');assert.deepEqual(order,['cancel']);
  }
});
