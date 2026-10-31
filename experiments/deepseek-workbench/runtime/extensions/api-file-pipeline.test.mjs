import {test} from 'node:test';
import assert from 'node:assert/strict';
import {apiToFile,createApiFileVerifier,API_FILE_MAX_BYTES} from './api-file-pipeline.mjs';
const args={api_tool:'mcp__weather__forecast',api_arguments:{latitude:0},file_path:'/workspace/demo/test.json'};
const exec={agent:{id:'synthetic'},signal:new AbortController().signal,token:{},rootCallId:'root',callId:'call'};
function fixture(options={}){
 const {apiError=false,writeError=false,readError=false,value={temperature:25.9,source:'synthetic'},execution=exec}=options;
 const calls=[],reads=[],target={targetKey:'opaque-native-target',displayPath:args.file_path};
 let saved,version='native-v1',statCalls=0;
 const fs={
  processPath:()=>args.file_path,
  async stat(t,signal){assert.equal(t,target);assert.equal(signal,execution.signal);statCalls++;
   if(options.staleBefore)version='native-v2';
   return {type:'file',version,size:Buffer.byteLength(saved)};
  },
  async readBytes(t,signal,limit){assert.equal(t,target);assert.equal(signal,execution.signal);reads.push(limit);
   if(options.abortDuringBytes)options.abortDuringBytes.abort();
   if(options.staleDuringBytes)version='native-v2';
   return Buffer.from(options.corrupt?saved.slice(0,-1)+'!':saved);
  },
 };
 const verifier=createApiFileVerifier(fs,execution);
 const tools={calls,reads,verifier,get saved(){return saved;},get statCalls(){return statCalls;},async execute(input){calls.push(input);
  if(input.name===args.api_tool)return {isError:apiError,content:[{type:'text',text:JSON.stringify(value)}]};
  if(input.name==='write'){
   if(writeError)return {isError:true};saved=input.arguments.content;
   verifier.observe(target,{kind:'present',version},options.alienActor?{...input,...options.alienActor}:input);
   if(options.duplicateObservation)verifier.observe(target,{kind:'present',version},input);
   options.afterWrite?.();
   return {isError:false,value:{path:args.file_path,after:saved}};
  }
  if(saved===undefined||readError)return {isError:true};
  verifier.observe(options.otherTarget?{...target,targetKey:'different-native-target'}:target,{kind:'present',version:options.changedReadVersion?'native-v2':version},input);
  // Reproduce the original read renderer: the JSON is one line, clipped at 2000.
  const text=saved.length>2000?saved.slice(0,2000)+'... (line truncated to 2000 chars)':saved;
  return {isError:false,value:{path:options.otherReceipt?'/workspace/other.json':args.file_path,offset:1,lines:[{number:1,text}],totalLines:1}};
 }};
 tools.run=(input=args)=>apiToFile(tools,execution,input,['mcp__weather__'],verifier.verify);
 return tools;
}
test('copies response exactly and preserves native authority for all nested calls',async()=>{
 const tools=fixture();assert.equal(await tools.run(),args.file_path);
 assert.deepEqual(tools.calls.map(c=>c.name),[args.api_tool,'read','write','read']);
 assert.equal(tools.calls[2].arguments.content,'{"temperature":25.9,"source":"synthetic"}');
 for(const call of tools.calls){assert.equal(call.agent,exec.agent);assert.equal(call.signal,exec.signal);assert.equal(call.parent,exec.token);assert.equal(call.rootCallId,exec.rootCallId)}
 assert.deepEqual(tools.reads,[API_FILE_MAX_BYTES]);assert.equal(tools.statCalls,2);
});
test('API failure cannot create a file; denied writes cannot report success',async()=>{
 const failed=fixture({apiError:true});await assert.rejects(failed.run(),/api_failed/);assert.equal(failed.calls.length,1);
 const denied=fixture({writeError:true});await assert.rejects(denied.run(),/write_failed/);assert.equal(denied.reads.length,0);
});
test('verifies complete UTF-8 JSON beyond the native display cap without enlarging read output',async()=>{
 const value={text:'olá 🧭 '.repeat(1500)},tools=fixture({value});
 assert.equal(await tools.run(),args.file_path);assert.equal(tools.saved,JSON.stringify(value));
 assert.equal(tools.calls[3].arguments.limit,2000);assert.deepEqual(tools.reads,[2*1024*1024]);
});
test('detects corruption beyond the clipped display prefix',async()=>{
 const tools=fixture({corrupt:true,value:{text:'x'.repeat(8192)}});
 await assert.rejects(tools.run(),/verification_failed/);assert.equal(tools.reads.length,1);
});
test('a denied post-write native read never authorizes the internal read',async()=>{
 const tools=fixture({readError:true});await assert.rejects(tools.run(),/verification_failed/);
 assert.equal(tools.reads.length,0);assert.equal(tools.statCalls,0);
});
test('canonical receipt, target or observed-version disagreement fails before raw bytes',async()=>{
 for(const options of [{otherReceipt:true},{otherTarget:true},{changedReadVersion:true}]){
  const tools=fixture(options);await assert.rejects(tools.run(),/verification_failed/);assert.equal(tools.reads.length,0);
 }
});
test('another call or duplicate observation cannot supply native read authority',async()=>{
 for(const options of [{alienActor:{parent:{}}},{alienActor:{rootCallId:'other'}},{alienActor:{agent:{id:'other'}}},{alienActor:{callId:'other'}},{duplicateObservation:true}]){
  const tools=fixture(options);await assert.rejects(tools.run(),/verification_failed/);assert.equal(tools.reads.length,0);
 }
});
test('file versions must remain the native write/read version before and after bytes',async()=>{
 const before=fixture({staleBefore:true});await assert.rejects(before.run(),/verification_failed/);assert.equal(before.reads.length,0);
 const during=fixture({staleDuringBytes:true});await assert.rejects(during.run(),/verification_failed/);assert.equal(during.reads.length,1);
});
test('uses the existing inclusive 2 MiB cap and rejects oversized API JSON before writing',async()=>{
 const exact=fixture({value:{text:'x'.repeat(API_FILE_MAX_BYTES-11)}});assert.equal(await exact.run(),args.file_path);
 assert.equal(Buffer.byteLength(exact.saved),API_FILE_MAX_BYTES);
 const large=fixture({value:{text:'x'.repeat(API_FILE_MAX_BYTES-10)}});await assert.rejects(large.run(),/response_too_large/);
 assert.deepEqual(large.calls.map(call=>call.name),[args.api_tool]);
});
test('cancellation after write or during bounded read cannot report verified success',async()=>{
 const controller=new AbortController(),execution={...exec,signal:controller.signal};
 const after=fixture({execution,afterWrite:()=>controller.abort()});await assert.rejects(after.run(),{name:'AbortError'});
 assert.deepEqual(after.calls.map(call=>call.name),[args.api_tool,'read','write']);assert.equal(after.reads.length,0);
 const next=new AbortController(),during=fixture({execution:{...exec,signal:next.signal},abortDuringBytes:next});
 await assert.rejects(during.run(),{name:'AbortError'});assert.equal(during.statCalls,1);
});
test('clearing observation authority prevents reuse after invocation disposal',async()=>{
 const tools=fixture();await tools.run();tools.verifier.clear();
 await assert.rejects(tools.verifier.verify({written:{path:args.file_path,after:tools.saved},checked:{path:args.file_path},content:tools.saved,writeCallId:'call:api-file:3',readCallId:'call:api-file:4',signal:exec.signal}),/verification_failed/);
});
test('rejects arbitrary tools and cancelled invocations before dispatch',async()=>{
 const tools=fixture();await assert.rejects(tools.run({...args,api_tool:'bash'}),/not_registered/);
 await assert.rejects(apiToFile(tools,{...exec,signal:AbortSignal.abort()},args,['mcp__weather__'],tools.verifier.verify));assert.equal(tools.calls.length,0);
 await assert.rejects(apiToFile(tools,exec,args,['mcp__weather__']),/verification_unavailable/);assert.equal(tools.calls.length,0);
});
