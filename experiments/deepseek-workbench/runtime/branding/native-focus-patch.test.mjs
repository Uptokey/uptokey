import test from 'node:test';
import assert from 'node:assert/strict';
import {answerNativeFocusApproval,patchNativeFocusApproval} from './native-focus-patch.mjs';
import {readFileSync} from 'node:fs';
function fixture(){const answers=[];const pending={answerable:true,sessionId:'s',callId:'c',toolName:'mcp__computer__computer_click',nativeFocus:{sessionId:'s',callId:'c',toolName:'mcp__computer__computer_click'},answer:async value=>{answers.push(value);pending.answerable=false}};return {answers,pending}}
test('native correlated handoff finishes before original Allow once resolves',async()=>{
  const f=fixture(),events=[];const original=f.pending.answer;f.pending.answer=async value=>{events.push('answer');return original(value)};
  await answerNativeFocusApproval(f.pending,'allowed-once',{approveComputerFocus:async ticket=>{assert.equal(ticket,f.pending.nativeFocus);events.push('native')}});
  assert.deepEqual(events,['native','answer']);assert.deepEqual(f.answers,['allowed-once']);
});
test('native denial/missing owner/mismatched pending scope settle rejection without retry',async()=>{
  for(const mode of ['denied','missing','session','call','tool']){
    const f=fixture();let calls=0;
    if(mode==='session')f.pending.nativeFocus.sessionId='other';if(mode==='call')f.pending.nativeFocus.callId='other';if(mode==='tool')f.pending.nativeFocus.toolName='other';
    await answerNativeFocusApproval(f.pending,'allowed-once',mode==='missing'?{}:{approveComputerFocus:async()=>{calls++;throw Error('os_refused_target_focus')}});
    assert.deepEqual(f.answers,['rejected']);assert.equal(calls,mode==='denied'?1:0);
  }
});
test('Reject/non-Windows ordinary approval do not request native focus; abort cannot resurrect approval',async()=>{
  let calls=0;const native={approveComputerFocus:async()=>{calls++}};
  const rejected=fixture();await answerNativeFocusApproval(rejected.pending,'rejected',native);assert.deepEqual(rejected.answers,['rejected']);
  const ordinary=fixture();delete ordinary.pending.nativeFocus;await answerNativeFocusApproval(ordinary.pending,'allowed-once',native);assert.deepEqual(ordinary.answers,['allowed-once']);assert.equal(calls,0);
  const withdrawn=fixture();await answerNativeFocusApproval(withdrawn.pending,'allowed-once',{approveComputerFocus:async()=>{withdrawn.pending.answerable=false}});assert.deepEqual(withdrawn.answers,[]);
});
test('pinned build patch preserves projection, original waterfall and exact settlement; drift fails',()=>{
  const source='this.displayReason = request.displayReason;\n...request.displayReason === void 0 ? {} : { displayReason: request.displayReason },\npending.answer(outcome).catch(';
  const patched=patchNativeFocusApproval(source);assert.match(patched,/this.nativeFocus = request.nativeFocus/);assert.match(patched,/nativeFocus: request.nativeFocus/);
  assert.equal(patchNativeFocusApproval(patched),patched);assert.throws(()=>patchNativeFocusApproval(source.replace('pending.answer','other.answer')));
});

test('both native products grant only the correlated command to the exact workbench origin',()=>{
  for(const root of [new URL('../../desktop/',import.meta.url),new URL('../../../../quimera/tauri/',import.meta.url)]){
    const capability=JSON.parse(readFileSync(new URL('capabilities/computer-focus.json',root)));
    assert.deepEqual(capability.windows,['workbench']);assert.equal(capability.local,false);
    assert.deepEqual(capability.remote.urls,['http://127.0.0.1:43180/*']);assert.deepEqual(capability.permissions,['harness-computer-focus']);
    const permission=readFileSync(new URL('permissions/computer-focus.toml',root),'utf8');
    assert.match(permission,/commands.allow = \["harness_computer_approve_focus"\]/);
    const config=JSON.parse(readFileSync(new URL(root.href.includes('/quimera/')?'tauri.harness.conf.json':'tauri.conf.json',root)));
    assert.ok(config.app.security.capabilities.includes('harness-computer-focus'));
  }
});
