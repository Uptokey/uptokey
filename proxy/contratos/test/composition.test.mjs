import test from 'node:test';
import assert from 'node:assert/strict';
import {parseCompositionRequest,parseCompositionSpec,canonicalCompositionRequest,parseCompositionResult,parseCompositionGraphSnapshot} from '../composition.js';
const request=()=>({schemaVersion:1,requestId:'request-1',sourceRunId:'run-1',containsText:'Example',next:{schemaVersion:1,url:'http://127.0.0.1:21557/next'}});
test('composition preserves a literal local condition and immutable browser proposal',()=>{
  const input=request(),value=parseCompositionRequest(input);input.next.url='http://127.0.0.1:21557/changed';
  assert.equal(value.next.url,'http://127.0.0.1:21557/next');assert.ok(Object.isFrozen(value)&&Object.isFrozen(value.next));
  assert.equal(canonicalCompositionRequest({...request(),containsText:'Example'}),canonicalCompositionRequest(request()));
  assert.notEqual(canonicalCompositionRequest({...request(),sourceRunId:'another'}),canonicalCompositionRequest(request()));
});
test('composition request rejects authority, executable tools and nonlocal destinations',()=>{
  for(const extra of [{principalId:'owner'},{approved:true},{tool:'browser_click'},{id:'arbitrary'}])assert.throws(()=>parseCompositionRequest({...request(),...extra}));
  for(const change of [{containsText:''},{containsText:' '.repeat(3)},{containsText:'x'.repeat(201)},{sourceRunId:'../run'},
    {next:{schemaVersion:1,url:'https://example.test/'}},{next:{schemaVersion:1,url:'http://127.0.0.1:21557/?secret=value'}}])assert.throws(()=>parseCompositionRequest({...request(),...change}));
});
test('stored spec binds owner and project, refuses normalized invalid dates',()=>{
  const input={...request(),id:'composition-1',createdAt:'2026-09-17T12:00:00.000Z',projectId:'project-1',principalId:'principal-1'};
  assert.deepEqual(parseCompositionSpec(input),input);
  assert.throws(()=>parseCompositionSpec({...input,createdAt:'2026-02-30T12:00:00.000Z'}));
  assert.throws(()=>parseCompositionSpec({...input,principalId:''}));
});
test('checkpoint projection rejects content, malformed states and cross-composition responses',()=>{
  const state={compositionId:'composition-1',observedStatus:'running',status:'review_required',interrupted:true};
  assert.deepEqual(parseCompositionGraphSnapshot(state),state);
  for(const change of [{content:'hidden'},{status:'approved'},{status:'proposal_ready'},{observedStatus:'invented'},{compositionId:'../other'}])
    assert.throws(()=>parseCompositionGraphSnapshot({...state,...change}));
  const spec={...request(),id:'composition-1',createdAt:'2026-09-17T12:00:00.000Z',projectId:'project-1',principalId:'principal-1'};
  const result={spec,state,plan:null};assert.deepEqual(parseCompositionResult(result),result);
  assert.throws(()=>parseCompositionResult({...result,state:{...state,compositionId:'other'}}));
  assert.throws(()=>parseCompositionResult({...result,approved:true}));
});
