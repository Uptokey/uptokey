import test from 'node:test';
import assert from 'node:assert/strict';
import {projectHostedCatalog} from '../hosted-catalog.js';
import {parseHostedClientResult, HOSTED_CLIENT_ERRORS} from '../hosted-result.js';

const model=()=>({id:'test/model',price:{model:'test/model',version:'test-v1',currency:'USD',inputMicrosPerMillion:100,outputMicrosPerMillion:200,cachedInputMicrosPerMillion:20},limits:{inputTokens:1000,outputTokens:100,contextTokens:1100}});
const catalog=()=>({models:[model()],transport:'json',admissionRequired:true,billing:{currency:'USD',unit:'micro_usd',rateBasisTokens:1_000_000,settlement:'provider_reported_usage'}});
const completed=()=>({status:'completed',requestId:'request-one',content:'Answer',currency:'USD',chargedMicros:7,priceVersion:'test-v1',usage:{inputTokens:3,outputTokens:2,cachedInputTokens:1},finishReason:'stop'});
const unknown={status:'outcome_unknown',requestId:'request-one'};

test('catalogue projection preserves admitted models and strips unknown nested fields',()=>{
  const expected=catalog(),raw=catalog();raw.secret='not-public';raw.billing.secret='not-public';raw.models[0].secret='not-public';raw.models[0].price.secret='not-public';raw.models[0].limits.secret='not-public';
  const actual=projectHostedCatalog(raw);assert.deepEqual(actual,expected);assert.notEqual(actual.models[0].price,raw.models[0].price);
  const full=catalog();Object.assign(full.models[0],{inputReservation:'full_context',contextValidation:'provider'});full.models[0].limits.contextTokens=1000;
  assert.deepEqual(projectHostedCatalog(full),full);
});

test('catalogue refuses duplicate identities, invalid price/limits and untrusted array properties',()=>{
  const cases=[];
  const duplicate=catalog();duplicate.models.push(model());cases.push(duplicate);
  const negative=catalog();negative.models[0].price.inputMicrosPerMillion=-1;cases.push(negative);
  const cache=catalog();cache.models[0].price.cachedInputMicrosPerMillion=101;cases.push(cache);
  const oversized=catalog();oversized.models[0].limits.outputTokens=101;cases.push(oversized);
  const full=catalog();full.models[0].inputReservation='full_context';cases.push(full);
  const foreign=catalog();foreign.billing.currency='EUR';cases.push(foreign);
  const sparse=catalog();sparse.models.length=2;cases.push(sparse);
  const excessive=catalog();excessive.models=Array.from({length:101},model);cases.push(excessive);
  let read=false;const getter=catalog();Object.defineProperty(getter.models[0].price,'inputMicrosPerMillion',{get(){read=true;throw new Error('do not execute');},enumerable:true});cases.push(getter);
  for(const entry of cases)assert.throws(()=>projectHostedCatalog(entry),/hosted_catalog_invalid/);
  assert.equal(read,false);
});

test('result contract returns only confirmed receipt fields and preserves non-replay states',()=>{
  const raw=completed();raw.secret='not-public';raw.usage.secret='not-public';assert.deepEqual(parseHostedClientResult(raw,200,'request-one'),completed());
  for(const status of ['outcome_unknown','reconciliation_required'])assert.deepEqual(parseHostedClientResult({requestId:'request-one',status},202,'request-one'),{requestId:'request-one',status});
  for(const settlement of ['reserved','settled'])assert.deepEqual(parseHostedClientResult({requestId:'request-one',status:'already_submitted',settlement},409,'request-one'),{requestId:'request-one',status:'already_submitted',settlement});
});

test('every public rejection requires its exact status and the allowlist cannot be changed by a consumer',()=>{
  assert.equal(Object.isFrozen(HOSTED_CLIENT_ERRORS),true);
  assert.throws(()=>{HOSTED_CLIENT_ERRORS.injected=200;},TypeError);
  for(const [error,status] of Object.entries(HOSTED_CLIENT_ERRORS)){
    assert.deepEqual(parseHostedClientResult({error,secret:'not-public'},status,'request-one'),{status:'rejected',requestId:'request-one',error});
    assert.deepEqual(parseHostedClientResult({error},200,'request-one'),unknown);
  }
  assert.deepEqual(parseHostedClientResult({error:'upstream_private_error'},503,'request-one'),unknown);
});

test('mismatched, malformed or oversized replies never fabricate completion or confirmed cost',()=>{
  for(const entry of [null,{}, {...completed(),requestId:'other'}, {...completed(),chargedMicros:-1}, {...completed(),priceVersion:'not valid'},
    {...completed(),currency:'EUR'}, {...completed(),usage:{inputTokens:3,outputTokens:2,cachedInputTokens:4}},
    {...completed(),usage:{inputTokens:NaN,outputTokens:2}}, {...completed(),finishReason:'unknown'},
    {...completed(),content:'x'.repeat(4_000_001)}])assert.deepEqual(parseHostedClientResult(entry,200,'request-one'),unknown);
  assert.deepEqual(parseHostedClientResult(completed(),202,'request-one'),unknown);
  assert.deepEqual(parseHostedClientResult({requestId:'other',status:'already_submitted',settlement:'settled'},409,'request-one'),unknown);
});
