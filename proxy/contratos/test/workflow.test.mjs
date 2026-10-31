import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {createRequire} from 'node:module';
import * as w from '../workflow.js';
const fixture=JSON.parse(readFileSync(new URL('./fixtures/workflow.json',import.meta.url),'utf8'));
const copy=v=>structuredClone(v);
const sha=s=>createHash('sha256').update(s).digest('hex');
test('image artifact metadata accepts only raster formats and keeps artifact bounds',()=>{
  for(const mediaType of ['image/png','image/jpeg','image/webp']) {
    const artifact={...fixture.artifact,mediaType};
    assert.equal(w.parseArtifact(artifact).mediaType,mediaType);
    assert.throws(()=>w.parseArtifact({...artifact,byteLength:w.WORKFLOW_LIMITS.artifactBytes+1}));
    assert.throws(()=>w.parseArtifact({...artifact,filename:'../image.png'}));
  }
  for(const mediaType of ['image/svg+xml','image/gif','text/html'])
    assert.throws(()=>w.parseArtifact({...fixture.artifact,mediaType}));
});
test('audio artifact metadata retains size and digest limits without admitting arbitrary MIME',()=>{
  const audio={...fixture.artifact,mediaType:'audio/mpeg',filename:'speech.mp3'};
  assert.equal(w.parseArtifact(audio).mediaType,'audio/mpeg');
  for(const mediaType of ['audio/mp3','text/html','application/octet-stream'])assert.throws(()=>w.parseArtifact({...audio,mediaType}));
  assert.throws(()=>w.parseArtifact({...audio,byteLength:w.WORKFLOW_LIMITS.artifactBytes+1}));
});
test('proxy vendored contract equals canonical source and export resolves',()=>{
  for(const file of ['workflow.js','workflow.d.ts'])
    assert.equal(readFileSync(new URL(`../../core/vendor/sync-contract/${file}`,import.meta.url),'utf8'),readFileSync(new URL(`../${file}`,import.meta.url),'utf8'));
  const consumer=createRequire(new URL("../../core/package.json",import.meta.url));
  assert.match(consumer.resolve('@uptokey/sync-contract/workflow'),/workflow\.js$/);
});
const pairs=[
  ['capability',w.parseCapabilityDescriptor,fixture.capabilities[0]],
  ['project',w.parseProjectContext,fixture.project],['snapshot',w.parseContextSnapshot,fixture.snapshot],
  ['plan',w.parseExecutionPlan,fixture.plan],['grant',w.parseProjectGrant,fixture.grant],
  ['run',w.parseRun,fixture.run],['receipt',w.parseExecutionReceipt,fixture.receipts[0]],
  ['artifact',w.parseArtifact,fixture.artifact],['recipe',w.parseRecipe,fixture.recipe],
  ['tariff',w.parseReferenceTariff,fixture.tariff],['value',w.parseUsageValueReceipt,fixture.valueReceipt],
];
test('external writes cannot claim a read-only or local automatic retry policy',()=>{
  const input={...fixture.capabilities[0],effect:'write_external',retryClass:'never_automatic'};
  assert.equal(w.parseCapabilityDescriptor(input).effect,'write_external');
  for(const retryClass of ['read_only','idempotent_local'])assert.throws(()=>w.parseCapabilityDescriptor({...input,retryClass}));
});
for(const [label,parse,value] of pairs){
  test(`${label}: accepts fixture, returns detached copy, rejects foreign fields and versions`,()=>{
    const parsed=parse(value);assert.deepEqual(parsed,value);assert.notEqual(parsed,value);
    for(const bad of [null,[],{...value,privateKey:'must_not_pass'},{...value,schemaVersion:2},{...value,createdAt:'2026-02-30T00:00:00.000Z'}])
      assert.throws(()=>parse(bad),{name:'WorkflowContractError',message:'workflow_invalid'});
  });
}
test('parsers do not invoke getters and reject hostile/oversized JSON shapes',()=>{
  let invoked=false;const getter={...fixture.project};Object.defineProperty(getter,'name',{enumerable:true,get(){invoked=true;return 'secret';}});
  assert.throws(()=>w.parseProjectContext(getter));assert.equal(invoked,false);
  const cycle={...fixture.project};cycle.entries=cycle;
  const sparse={...fixture.project,entries:new Array(1)};
  const symbol={...fixture.project,[Symbol('extra')]:1};
  const prototype=Object.assign(Object.create({secret:true}),fixture.project);
  for(const bad of [cycle,sparse,symbol,prototype,{...fixture.project,goal:'x'.repeat(262145)}]) assert.throws(()=>w.parseProjectContext(bad));
  assert.throws(()=>w.parseExecutionPlan({...fixture.plan,limits:{...fixture.plan.limits,maxCalls:NaN}}));
});
test('confirmed decisions require human origin; unknown references and duplicates are rejected',()=>{
  const p=copy(fixture.project);p.entries[0].origin='model';assert.throws(()=>w.parseProjectContext(p));
  p.entries[0].status='proposed';assert.doesNotThrow(()=>w.parseProjectContext(p));
  p.entries[0].sourceRefs=['missing'];assert.throws(()=>w.parseProjectContext(p));
  const duplicate=copy(fixture.project);duplicate.entries.push(copy(duplicate.entries[0]));assert.throws(()=>w.parseProjectContext(duplicate));
  assert.doesNotThrow(()=>w.parseProjectContext(fixture.updatedProject));
});
test('plan references must point backwards; loops and duplicate IDs are invalid',()=>{
  assert.throws(()=>w.parseExecutionPlan({...fixture.plan,steps:[]}));
  for(const target of ['search_papers','save_report','absent']){
    const p=copy(fixture.plan);p.steps[0].arguments.query={kind:'step_output',stepId:target,output:'records'};
    assert.throws(()=>w.parseExecutionPlan(p));
  }
  const duplicate=copy(fixture.plan);duplicate.steps[1].id=duplicate.steps[0].id;assert.throws(()=>w.parseExecutionPlan(duplicate));
  const tooMany=copy(fixture.plan);tooMany.limits.maxSteps=1;assert.throws(()=>w.parseExecutionPlan(tooMany));
  const param=copy(fixture.plan);param.steps[0].arguments.query={kind:'parameter',parameter:'topic'};assert.throws(()=>w.parseExecutionPlan(param));
});
test('snapshot exclusions describe non-selected project entries, never selected entries',()=>{
  assert.doesNotThrow(()=>w.parseContextSnapshot({...fixture.snapshot,excludedEntryIds:['entry_not_selected']}));
  assert.throws(()=>w.parseContextSnapshot({...fixture.snapshot,excludedEntryIds:['entry_goal']}));
});
test('a draft project goal can be cleared but name and planning objective cannot be blank',()=>{
  assert.deepEqual(w.parseWorkflowCommand('patchProject',{expectedRevision:1,goal:''}),{expectedRevision:1,goal:''});
  assert.throws(()=>w.parseWorkflowCommand('patchProject',{expectedRevision:1,name:'   '}));
  assert.throws(()=>w.parseWorkflowCommand('createPlan',{expectedRevision:1,objective:'',selectedEntryIds:[],selectedArtifactIds:[],sourceIds:['crossref'],limits:fixture.plan.limits}));
});
test('canonical hashes bind plan arguments, selected context digest, limits and destinations',()=>{
  assert.equal(sha(w.canonicalPlanPayload(fixture.plan)),fixture.plan.digest);
  assert.equal(sha(w.canonicalContextSnapshotPayload(fixture.snapshot)),fixture.plan.contextSnapshotDigest);
  assert.equal(sha(w.canonicalPlanPayload(fixture.updatePlan)),fixture.updatePlan.digest);
  const changed=copy(fixture.plan);changed.steps[0].arguments.query.value='changed';
  assert.notEqual(sha(w.canonicalPlanPayload(changed)),fixture.plan.digest);
  const otherDigest={...fixture.plan,digest:'f'.repeat(64)};
  assert.equal(w.canonicalPlanPayload(otherDigest),w.canonicalPlanPayload(fixture.plan));
  const changedContext=copy(fixture.snapshot);changedContext.allowedDestinations.pop();
  assert.notEqual(sha(w.canonicalContextSnapshotPayload(changedContext)),fixture.plan.contextSnapshotDigest);
});
test('cross-bindings reject different projects, revisions, unavailable capabilities and forbidden destinations',()=>{
  assert.equal(w.validatePlanBindings(fixture.plan,fixture.snapshot,fixture.capabilities),true);
  assert.equal(w.validatePlanBindings(fixture.updatePlan,fixture.nextSnapshot,fixture.capabilities),true);
  for(const s of [{...fixture.snapshot,projectId:'other'},{...fixture.snapshot,projectRevision:2},
    {...fixture.snapshot,allowedDestinations:[fixture.snapshot.allowedDestinations[0]]}])
    assert.throws(()=>w.validatePlanBindings(fixture.plan,s,fixture.capabilities));
  const cs=copy(fixture.capabilities);cs[0].availability='catalogued';
  assert.throws(()=>w.validatePlanBindings(fixture.plan,fixture.snapshot,cs));
  assert.throws(()=>w.validatePlanBindings(fixture.plan,fixture.snapshot,[...fixture.capabilities,fixture.capabilities[0]]));
});
test('grants require finite lifetime, known scopes and no duplicate capabilities',()=>{
  for(const patch of [{expiresAt:fixture.grant.createdAt},{scopes:['admin:everything']},{capabilityIds:['same','same']},
    {revokedAt:'2020-01-01T00:00:00.000Z'},{limits:{...fixture.grant.limits,maxCalls:0}}])
    assert.throws(()=>w.parseProjectGrant({...fixture.grant,...patch}));
});
test('terminal runs and receipts cannot claim incomplete success',()=>{
  const run=copy(fixture.run);run.stepStates[0].status='unknown';assert.throws(()=>w.parseRun(run));
  assert.throws(()=>w.parseRun({...fixture.run,finishedAt:null}));
  assert.throws(()=>w.parseRun({...fixture.run,status:'running'}));
  const r=copy(fixture.receipts[0]);r.sources[0].receiptId='foreign';assert.throws(()=>w.parseExecutionReceipt(r));
  assert.throws(()=>w.parseExecutionReceipt({...fixture.receipts[0],errorCode:'upstream_failed'}));
  assert.doesNotThrow(()=>w.parseExecutionReceipt({...fixture.receipts[0],status:'unknown',errorCode:'outcome_unknown'}));
});
test('source URLs cannot carry credentials; filenames cannot traverse directories',()=>{
  for(const url of ['file:///etc/passwd','http://example.org','https://user:password@example.org/a']){
    const r=copy(fixture.receipts[0]);r.sources[0].url=url;assert.throws(()=>w.parseExecutionReceipt(r));
  }
  for(const filename of ['../report.md','sub/report.md','C:\\report.md','..','report:secret','CON','aux.txt','COM1.md','report.','report '])
    assert.throws(()=>w.parseArtifact({...fixture.artifact,filename}));
});
test('recipe must declare parameters; importing it does not create a grant',()=>{
  const r=copy(fixture.recipe);r.parameters=[];assert.throws(()=>w.parseRecipe(r));
  assert.throws(()=>w.parseRecipe({...fixture.recipe,grant:fixture.grant}));
});
test('value records preserve unknown versus zero and exclude cache/estimates from comparable total',()=>{
  const v=fixture.valueReceipt;assert.equal(v.confirmedUptokeyCharge.numeratorMicros,'0');assert.equal(v.estimatedProviderCharge,null);
  assert.equal(Number(BigInt(v.referenceValue.numeratorMicros)/BigInt(v.referenceValue.denominator))/1e6,0.36);
  for(const patch of [{cache:'local'},{tariffId:null},{usage:{basis:'unknown',inputTokens:null,outputTokens:null,cachedInputTokens:null}},
    {referenceValue:{numeratorMicros:'1',denominator:'0'}},{referenceValue:{numeratorMicros:'-1',denominator:'1'}}])
    assert.throws(()=>w.parseUsageValueReceipt({...v,...patch}));
  const unknown={...v,usage:{basis:'unknown',inputTokens:null,outputTokens:null,cachedInputTokens:null},coverage:'missing_usage',referenceValue:null};
  assert.doesNotThrow(()=>w.parseUsageValueReceipt(unknown));
  assert.doesNotThrow(()=>w.parseUsageValueReceipt({...v,cache:'local',coverage:'local_cache',referenceValue:null}));
  assert.throws(()=>w.parseUsageValueReceipt({...v,usage:{...v.usage,cachedInputTokens:1000001}}));
  assert.throws(()=>w.parseReferenceTariff({...fixture.tariff,inputMicrosPerMillion:'0.2'}));
});
test('partial measurement is preserved and contradictory coverage is rejected',()=>{
  const v=fixture.valueReceipt;
  const partial={...v,usage:{...v.usage,outputTokens:null},referenceValue:null,coverage:'missing_usage'};
  assert.doesNotThrow(()=>w.parseUsageValueReceipt(partial));
  assert.throws(()=>w.parseUsageValueReceipt({...v,usage:partial.usage}));
  for(const coverage of ['missing_usage','estimated_usage','local_cache','missing_tariff'])
    assert.throws(()=>w.parseUsageValueReceipt({...v,referenceValue:null,coverage}));
  assert.throws(()=>w.parseUsageValueReceipt({...v,tariffId:null,tariffVersion:null,referenceValue:null,coverage:'missing_tariff',estimatedProviderCharge:{numeratorMicros:'1',denominator:'1'}}));
});
test('token usage contract admits model_tokenizer, heuristic, reserved_limit, reasoning and provenance',()=>{
  const receipt={...fixture.receipts[0],usage:{basis:'model_tokenizer',inputTokens:120,outputTokens:45,cachedInputTokens:10,reasoningTokens:15,totalTokens:165,source:'openai:gpt-4o',version:'o200k_base@1.0.21',measuredAt:'2026-09-23T00:00:00.000Z',reason:null}};
  const parsed=w.parseExecutionReceipt(receipt);
  assert.equal(parsed.usage.basis,'model_tokenizer');
  assert.equal(parsed.usage.reasoningTokens,15);
  assert.equal(parsed.usage.source,'openai:gpt-4o');
  const heuristic={...fixture.valueReceipt,usage:{basis:'heuristic',inputTokens:100,outputTokens:50,cachedInputTokens:null,reason:'chars4_heuristic'},referenceValue:null,coverage:'estimated_usage'};
  assert.doesNotThrow(()=>w.parseUsageValueReceipt(heuristic));
});
test('client commands cannot smuggle ownership, permissions or terminal results',()=>{
  assert.deepEqual(w.parseWorkflowCommand('createProject',{name:'Demo',goal:''}),{name:'Demo',goal:''});
  assert.throws(()=>w.parseWorkflowCommand('createProject',{name:'Demo',goal:'',ownerPrincipalId:'attacker'}));
  assert.throws(()=>w.parseWorkflowCommand('patchProject',{expectedRevision:1}));
  assert.throws(()=>w.parseWorkflowCommand('patchProject',{expectedRevision:1,entries:fixture.project.entries}));
  assert.throws(()=>w.parseWorkflowCommand('startRun',{planId:'p',planDigest:fixture.plan.digest,requestId:'r',status:'succeeded'}));
  assert.deepEqual(w.parseWorkflowCommand('cancelRun',{}),{});
  assert.throws(()=>w.parseWorkflowCommand('cancelRun',{grant:true}));
  assert.throws(()=>w.parseWorkflowCommand('constructor',{}));
});

test('legacy import only accepts bounded selected text without ownership, status or filesystem authority',()=>{
  const command={legacyId:'legacy_1',name:'Selected history',goal:'Review selected material',entries:[{id:'message_1',content:'User text\nunchanged',origin:'user'},{id:'message_2',content:'Model hypothesis',origin:'model'}]};
  const parsed=w.parseWorkflowCommand('importProject',command);
  assert.deepEqual(parsed,command);
  parsed.entries[0].content='changed';
  assert.equal(command.entries[0].content,'User text\nunchanged');
  for(const extra of [{ownerPrincipalId:'other'},{folderName:'private'},{path:'C:\\private'},{grant:fixture.grant}])
    assert.throws(()=>w.parseWorkflowCommand('importProject',{...command,...extra}));
  for(const entry of [{...command.entries[0],status:'confirmed'},{...command.entries[0],origin:'system'},{...command.entries[0],content:'x'.repeat(16001)}])
    assert.throws(()=>w.parseWorkflowCommand('importProject',{...command,entries:[entry]}));
  assert.throws(()=>w.parseWorkflowCommand('importProject',{...command,entries:[command.entries[0],command.entries[0]]}));
  assert.throws(()=>w.parseWorkflowCommand('importProject',{...command,entries:Array.from({length:257},(_,i)=>({...command.entries[0],id:`message_${i}`}))}));
});

test('local execution requires local destination, explicit process scope and never automatic retry',()=>{
 const cap={...fixture.capabilities[0],effect:'execute_local',dataDestination:{kind:'local',id:'workspace'},requiredScopes:['run:execute','project:process:run'],retryClass:'never_automatic'};
 assert.equal(w.parseCapabilityDescriptor(cap).effect,'execute_local');
 for(const patch of [{retryClass:'read_only'},{retryClass:'idempotent_local'},{requiredScopes:['run:execute']},{dataDestination:{kind:'provider',id:'remote'}}])assert.throws(()=>w.parseCapabilityDescriptor({...cap,...patch}));
});
