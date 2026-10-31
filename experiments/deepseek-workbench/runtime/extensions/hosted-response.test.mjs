import {test} from 'node:test';
import assert from 'node:assert/strict';
import {HostedRefusal,readHostedBridgeResponse} from './hosted-response.mjs';
test('only known bridge refusal with exact HTTP status is authoritative',async()=>{
 await assert.rejects(readHostedBridgeResponse(Response.json({error:{type:'hosted_price_changed'},private:'secret-canary'},{status:409})),error=>error instanceof HostedRefusal&&error.message==='hosted_price_changed'&&!JSON.stringify(error).includes('secret-canary'));
 for(const [status,type] of [[502,'hosted_price_changed'],[409,'secret-canary']]){
  await assert.rejects(readHostedBridgeResponse(Response.json({error:{type}},{status})),error=>!(error instanceof HostedRefusal)&&!error.message.includes('secret-canary'));
 }
});
test('failure bodies stay bounded and malformed or HTML responses remain uncertain',async()=>{
 for(const response of [new Response('secret-canary',{status:502}),Response.json({error:{type:'hosted_price_changed'},extra:'x'.repeat(17000)},{status:409}),new Response('{',{headers:{'content-type':'application/json'}})]){
  await assert.rejects(readHostedBridgeResponse(response),error=>!(error instanceof HostedRefusal)&&!error.message.includes('secret-canary'));
 }
});
test('successful body is preserved for the canonical result parser',async()=>{
 const value={status:'outcome_unknown',requestId:'synthetic'};
 assert.deepEqual(await readHostedBridgeResponse(Response.json(value),true),value);
});
