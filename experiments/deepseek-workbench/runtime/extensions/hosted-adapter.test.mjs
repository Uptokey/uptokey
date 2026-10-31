import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHostedAdapter,HOSTED_PROVIDER,hostedMessages} from './hosted-adapter.mjs';
import {HostedRefusal} from './hosted-response.mjs';
const model={id:'synthetic',price:{model:'synthetic',version:'v1',currency:'USD',inputMicrosPerMillion:0,outputMicrosPerMillion:0},limits:{inputTokens:4096,outputTokens:2048,contextTokens:8192},toolCalls:true};
const catalog={state:'available',accountRef:'acc_'+'a'.repeat(64),revision:1,models:[model],transport:'json',admissionRequired:true,billing:{currency:'USD',unit:'micro_usd',rateBasisTokens:1000000,settlement:'provider_reported_usage'}};
const options={provider:HOSTED_PROVIDER,model:'synthetic',messages:[{role:'user',content:[{type:'text',text:'Read demo'}]}],tools:[{name:'read_file',description:'Read file',parameters:{type:'object'}}]};
function fixture(reply){
 const calls=[];
 const adapter=createHostedAdapter({LlmAdapter:class{},LlmError:class extends Error{},retryPolicy:{mode:'normal',maxRetries:0},request:async(path,body)=>{calls.push({path,body});if(!body)return structuredClone(catalog);return reply?reply(body):{status:'completed',requestId:body.payload.requestId,content:'',currency:'USD',chargedMicros:0,priceVersion:'v1',usage:{inputTokens:20,cachedInputTokens:5,outputTokens:8},finishReason:'tool_calls',toolCalls:[{id:'call_1',name:'read_file',arguments:'{}'}]};}});
 return {adapter,calls};
}
async function collect(stream){const result=[];for await(const chunk of stream)result.push(chunk);return result;}
test('native block vocabulary, cache accounting, receipt and tool completion are preserved',async()=>{
 const {adapter,calls}=fixture();const prepared=await adapter.prepareCall(HOSTED_PROVIDER,'synthetic');
 assert.equal(prepared.model.context.contextWindow,8192);assert.deepEqual(prepared.model.inputModalities,['text']);
 const chunks=await collect(prepared.stream(options));
 assert.equal(chunks[0].blockType,'tool-call');assert.equal(chunks[2].block.type,'tool-call');
 assert.deepEqual(chunks[3].usage,{inputTokens:15,cacheReadTokens:5,outputTokens:8,totalTokens:28});
 assert.equal(chunks[4].reason.kind,'tool-calls');assert.match(chunks[4].replayState.response.requestId,/^harness_/);
 assert.equal(calls[1].body.accountRef,catalog.accountRef);assert.equal(calls[1].body.payload.expectedPriceVersion,'v1');
 assert.equal(adapter.providerRetryPolicy().maxRetries,0);
});
test('prepared call sends at most once even after lost reply',async()=>{
 const {adapter,calls}=fixture(()=>{throw Error('lost')});const prepared=await adapter.prepareCall(HOSTED_PROVIDER,'synthetic');
 await assert.rejects(collect(prepared.stream(options)),error=>error.message==='hosted_outcome_unknown'&&/^harness_/.test(error.requestId));
 await assert.rejects(collect(prepared.stream(options)),/already_dispatched/);
 assert.equal(calls.filter(c=>c.body).length,1);
});
test('tool history is translated, unsupported image blocks fail before dispatch',async()=>{
 const history={messages:[{role:'assistant',content:[{type:'text',text:'reading'},{type:'tool-call',id:'a',name:'read_file',arguments:'{}'}]},{role:'tool',toolCallId:'a',content:[{type:'text',text:'contents'}]}]};
 assert.equal(hostedMessages(history)[1].tool_call_id,'a');assert.equal(hostedMessages(history)[0].tool_calls[0].function.name,'read_file');
 const {adapter,calls}=fixture();
 await assert.rejects(collect(adapter.stream({...options,messages:[{role:'user',content:[{type:'image',attachment:{}}]}]})),/unsupported/);
 assert.equal(calls.filter(c=>c.body).length,0);
});
test('signed-out and paid entries never appear as available; changed model fails',async()=>{
 const create=value=>createHostedAdapter({LlmAdapter:class{},LlmError:Error,request:async()=>value});
 assert.deepEqual(await create({state:'signed_out',models:[]}).listModels(),[]);
 assert.deepEqual(await create({...catalog,models:[{...model,price:{...model.price,outputMicrosPerMillion:1}}]}).listModels(),[]);
 const {adapter,calls}=fixture();const prepared=await adapter.prepareCall(HOSTED_PROVIDER,'synthetic');
 await assert.rejects(collect(prepared.stream({...options,model:'other'})),/changed/);assert.equal(calls.length,1);
});
test('unverified results never become tool calls or completed output',async()=>{
 const {adapter}=fixture(body=>({status:'outcome_unknown',requestId:body.payload.requestId}));
 await assert.rejects(collect(adapter.stream(options)),/outcome_unknown/);
});
test('known pre-dispatch refusal stays distinct from an unknown outcome without retry',async()=>{
 const {adapter,calls}=fixture(()=>{throw new HostedRefusal('hosted_price_changed');});
 await assert.rejects(collect(adapter.stream(options)),error=>error.message==='hosted_price_changed'&&/^harness_/.test(error.requestId));
 assert.equal(calls.filter(c=>c.body).length,1);
});

test('registry enumeration of seven hosted models makes one catalog request, not eight',async()=>{
 let requests=0;
 const adapter=createHostedAdapter({LlmAdapter:class{},LlmError:Error,request:async()=>{requests++;return {...catalog,models:Array.from({length:7},(_,i)=>({...model,id:'free-'+i,price:{...model.price,model:'free-'+i}}))};}});
 const listed=await adapter.listModels();
 const resolved=await Promise.all(listed.map(row=>adapter.resolveModel(HOSTED_PROVIDER,row.id)));
 assert.equal(requests,1);assert.deepEqual(resolved.map(row=>row.id),listed.map(row=>row.id));
 resolved[0].context.contextWindow=1;assert.equal((await adapter.resolveModel(HOSTED_PROVIDER,listed[0].id)).context.contextWindow,8192);
});
test('preparation reuses the listed public metadata and dispatches through the host authority once',async()=>{
 const {adapter,calls}=fixture();await adapter.listModels();await adapter.resolveModel(HOSTED_PROVIDER,'synthetic');
 assert.equal(calls.length,1);await collect((await adapter.prepareCall(HOSTED_PROVIDER,'synthetic')).stream(options));
 assert.deepEqual(calls.map(row=>row.path),['/hosted/catalog','/hosted/chat']);
});
test('signed-out and failed list refreshes discard previously listed metadata',async()=>{
 for(const failure of [false,true]){
  let requests=0;
  const adapter=createHostedAdapter({LlmAdapter:class{},LlmError:Error,request:async()=>{if(++requests===1)return catalog;if(failure)throw Error('offline');return {state:'signed_out',models:[]};}});
  await adapter.listModels();if(failure)await assert.rejects(adapter.listModels(),/offline/);else assert.deepEqual(await adapter.listModels(),[]);
  await assert.rejects(adapter.resolveModel(HOSTED_PROVIDER,'synthetic'));assert.equal(requests,3);
 }
});
test('metadata cache refuses other providers and respects cancellation',async()=>{
 const {adapter,calls}=fixture();await adapter.listModels();
 await assert.rejects(adapter.resolveModel('other','synthetic'),/unavailable/);
 const controller=new AbortController();controller.abort();await assert.rejects(adapter.resolveModel(HOSTED_PROVIDER,'synthetic',controller.signal));
 await assert.rejects(adapter.prepareCall(HOSTED_PROVIDER,'synthetic',controller.signal));
 assert.equal(calls.length,1);
});

test('the Harness agent lists only canonical tool-capable routes without altering the shared text catalog',async()=>{
 const source={...catalog,models:[model,{...model,id:'text-only',price:{...model.price,model:'text-only'},toolCalls:undefined}]};
 const adapter=createHostedAdapter({LlmAdapter:class{},LlmError:Error,request:async()=>structuredClone(source)});
 assert.deepEqual((await adapter.listModels()).map(row=>row.id),['synthetic']);
 await assert.rejects(adapter.resolveModel(HOSTED_PROVIDER,'text-only'),/unavailable/);
 await assert.rejects(adapter.prepareCall(HOSTED_PROVIDER,'text-only'),/unavailable/);
 assert.equal(source.models.length,2);
});
test('native replay uses the original encrypted assistant envelope, never executable tool-block fields',async()=>{
 const replay={kind:'vertex-content-v1',parts:[{functionCall:{name:'read_file',args:{}},thoughtSignature:'c2ln'}],callIds:['call_1']};
 const {adapter}=fixture(body=>({status:'completed',requestId:body.payload.requestId,content:'',currency:'USD',chargedMicros:0,priceVersion:'v1',usage:{inputTokens:2,outputTokens:1},finishReason:'tool_calls',toolCalls:[{id:'call_1',name:'read_file',arguments:'{}'}],providerReplay:replay}));
 const chunks=await collect(adapter.stream(options));
 const block=chunks.find(chunk=>chunk.type==='block-end').block;
 assert.equal(Object.hasOwn(block,'providerReplay'),false);
 const finish=chunks.at(-1);assert.deepEqual(finish.replayState.response.providerReplay,replay);
 const message={role:'assistant',source:{kind:'model',provider:HOSTED_PROVIDER,model:'synthetic',replayState:finish.replayState},content:[block]};
 const history=hostedMessages({...options,messages:[message]});assert.deepEqual(history[0].providerReplay,replay);
 assert.equal(Object.hasOwn(hostedMessages({...options,model:'other',messages:[message]})[0],'providerReplay'),false);
});
