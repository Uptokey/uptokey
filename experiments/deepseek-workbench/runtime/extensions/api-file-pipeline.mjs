// Compose native MCP/write/read calls; keep session policy, cancellation and diffs.
export const API_FILE_MAX_BYTES=2*1024*1024;

// Native read output is deliberately clipped for the model. Capture its original
// target/version instead of turning that display window into an integrity check.
export function createApiFileVerifier(fs,exec){
 const observations=new Map();
 const writeCallId=exec.callId+':api-file:3';
 const readCallId=exec.callId+':api-file:4';
 const fail=()=>{throw Error('api_file_verification_failed');};
 return {
  observe(target,observation,actor){
   if(actor?.parent!==exec.token||actor?.rootCallId!==exec.rootCallId||actor?.agent!==exec.agent||
      (actor?.callId!==writeCallId&&actor?.callId!==readCallId))return;
   // Ambiguous observations cannot authorize a raw read, even for the same call.
   if(observations.has(actor.callId))observations.set(actor.callId,null);
   else observations.set(actor.callId,{target,observation});
  },
  async verify({written,checked,content,writeCallId:writeId,readCallId:readId,signal}){
   signal.throwIfAborted();
   const write=observations.get(writeId),read=observations.get(readId);
   if(writeId!==writeCallId||readId!==readCallId||!write||!read||
      write.observation?.kind!=='present'||read.observation?.kind!=='present'||
      typeof write.observation.version!=='string'||write.observation.version!==read.observation.version||
      !write.target||!read.target||write.target.targetKey!==read.target.targetKey||
      typeof written?.path!=='string'||written.path!==checked?.path||written.after!==content||
      fs.processPath(write.target)!==written.path||fs.processPath(read.target)!==checked.path)fail();
   const expected=Buffer.from(content,'utf8');
   if(expected.length>API_FILE_MAX_BYTES)fail();
   // Reuse the native target, never resolve a caller-supplied verification path.
   const target=read.target,version=read.observation.version;
   const stable=info=>info?.type==='file'&&info.version===version&&
    (info.size===undefined||info.size===expected.length);
   const before=await fs.stat(target,signal);
   signal.throwIfAborted();
   if(!stable(before))fail();
   const bytes=await fs.readBytes(target,signal,API_FILE_MAX_BYTES);
   signal.throwIfAborted();
   const after=await fs.stat(target,signal);
   signal.throwIfAborted();
   if(!stable(after)||!(bytes instanceof Uint8Array)||bytes.byteLength>API_FILE_MAX_BYTES||
      !Buffer.from(bytes.buffer,bytes.byteOffset,bytes.byteLength).equals(expected))fail();
  },
  clear(){observations.clear();},
 };
}

export async function apiToFile(tools,exec,args,prefixes,verifySavedFile){
 if(!prefixes.some(prefix=>args.api_tool.startsWith(prefix)))throw Error('api_file_tool_not_registered');
 if(typeof args.file_path!=='string'||!args.file_path.endsWith('.json'))throw Error('api_file_json_path_required');
 const parameters=args.api_arguments;
 if(!parameters||typeof parameters!=='object'||Array.isArray(parameters))throw Error('api_file_arguments_invalid');
 if(typeof verifySavedFile!=='function')throw Error('api_file_verification_unavailable');
 let n=0;
 const call=async(name,arguments_)=>{
  exec.signal.throwIfAborted();
  const result=await tools.execute({name,arguments:arguments_,agent:exec.agent,signal:exec.signal,parent:exec.token,rootCallId:exec.rootCallId,callId:exec.callId+':api-file:'+(++n)});
  exec.signal.throwIfAborted();
  return result;
 };
 const api=await call(args.api_tool,parameters);
 if(api.isError)throw Error('api_file_api_failed');
 // Only a complete, parseable JSON response may be persisted as JSON.
 const blocks=api.value?.content??api.content;
 const structured=api.value?.structuredContent;
 let value;
 if(structured!==undefined)value=structured;
 else{
  if(!Array.isArray(blocks)||blocks.some(block=>block.type!=='text'))throw Error('api_file_json_response_required');
  value=JSON.parse(blocks.map(block=>block.text).join('\n'));
 }
 const content=JSON.stringify(value);
 if(typeof content!=='string'||Buffer.byteLength(content)>API_FILE_MAX_BYTES)throw Error('api_file_response_too_large');
 // Read establishes the existing version (or absence) for guarded native writes.
 // A denied read does not grant write authority; write still runs its own policy.
 await call('read',{file_path:args.file_path,offset:1,limit:1});
 const written=await call('write',{file_path:args.file_path,content});
 const writeCallId=exec.callId+':api-file:'+n;
 if(written.isError)throw Error('api_file_write_failed');
 const checked=await call('read',{file_path:args.file_path,offset:1,limit:2000});
 const readCallId=exec.callId+':api-file:'+n;
 // The native read remains an authority gate; its clipped text is not bypassed
 // when denied, nor returned as a pretend full-file verification.
 if(checked.isError)throw Error('api_file_verification_failed');
 await verifySavedFile({written:written.value,checked:checked.value,content,writeCallId,readCallId,signal:exec.signal});
 exec.signal.throwIfAborted();
 return written.value.path;
}
