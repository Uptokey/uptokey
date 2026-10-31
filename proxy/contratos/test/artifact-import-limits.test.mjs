import test from 'node:test';
import assert from 'node:assert/strict';
import {readArtifactImportJson,readBoundedJson,MAX_INFERENCE_REQUEST_BYTES} from '../limits.js';
import {WORKFLOW_LIMITS} from '../workflow.js';
const request=(body,headers={})=>new Request('http://localhost/import',{method:'POST',headers:{'content-type':'application/json',...headers},body,...(typeof body==='string'?{}:{duplex:'half'})});
test('artifact envelope accepts bounded media without enlarging general JSON requests',async()=>{
 const body=JSON.stringify({data:'x'.repeat(MAX_INFERENCE_REQUEST_BYTES+512)});
 assert.equal((await readArtifactImportJson(request(body))).ok,true);
 assert.deepEqual(await readBoundedJson(request(body),MAX_INFERENCE_REQUEST_BYTES),{ok:false,reason:'too_large'});
 const limit=Math.ceil(WORKFLOW_LIMITS.artifactBytes/3)*4+2048;
 assert.deepEqual(await readArtifactImportJson(request('{}',{'content-length':String(limit+1)})),{ok:false,reason:'too_large'});
 let cancelled=false;
 const stream=new ReadableStream({pull(controller){controller.enqueue(new Uint8Array(1_048_576));},cancel(){cancelled=true;}});
 assert.deepEqual(await readArtifactImportJson(request(stream)),{ok:false,reason:'too_large'});assert.equal(cancelled,true);
});
