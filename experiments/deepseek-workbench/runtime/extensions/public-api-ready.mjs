// Readiness only: the original profile watcher owns loading and MCP owns tools.
export const name='uptokey-public-api-ready';
export const inject=['connection','loader','agents','tools'];
export const PUBLIC_API_READY_PATH='/api/uptokey/public-api-ready';
const MAX_BODY=2048,WAIT_MS=18000;
// FiberState.ACTIVE in the pinned Cordis 4.0.5 contract (a TS const enum).
const ACTIVE=2;
const schemaPath=hash=>'/home/node/.dsh/attachments/.uptokey-public-apis/'+hash+'.json';
const result=(status,code,toolCount=0)=>({status,toolCount,...code?{code}:{}});
const response=(value,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json','cache-control':'no-store','x-content-type-options':'nosniff'}});

function validInput(value){
 return value!==null&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===3&&
  Object.hasOwn(value,'apiId')&&Object.hasOwn(value,'schemaSha256')&&Object.hasOwn(value,'sessionId')&&
  typeof value.apiId==='string'&&/^[a-z][a-z0-9-]{0,31}$/.test(value.apiId)&&
  typeof value.schemaSha256==='string'&&/^[a-f0-9]{64}$/.test(value.schemaSha256)&&
  typeof value.sessionId==='string'&&value.sessionId.length>0&&Buffer.byteLength(value.sessionId)<=512&&
  !/[\u0000-\u001f\u007f]/.test(value.sessionId);
}

function hasSchemaArgument(config,path){
 const args=config.args;
 if(!Array.isArray(args)||args.some(arg=>typeof arg!=='string'))return false;
 // Direct stdio arguments are useful to original MCP compositions as well.
 const direct=args.indexOf('--openapi-spec');
 if(direct!==-1)return args.lastIndexOf('--openapi-spec')===direct&&args[direct+1]===path;
 // publicApiConfig's exact SSH command, with a single shell-quoted URL argument.
 if(config.command!=='/usr/bin/ssh'||args.length!==5||args[0]!=='-T'||args[1]!=='-o'||args[2]!=='BatchMode=yes'||args[3]!=='workbench-executor')return false;
 const prefix="HTTPS_PROXY=http://127.0.0.1:43190 '/usr/local/bin/node' '/opt/integrations/openapi.mjs' '--api-base-url' ";
 const suffix=" '--openapi-spec' '"+path+"' '--tools' 'all' '--operation' 'get' '--verbose' 'false'";
 const command=args[4];
 return command.startsWith(prefix)&&command.endsWith(suffix)&&/^'(?:[^']|'\\'')*'$/.test(command.slice(prefix.length,-suffix.length));
}

function descriptor(entry,input){
 if(entry.options?.id!=='uptokey-api-'+input.apiId||entry.options?.name!=='@deepseek-ai/dsh-mcp-client'||entry.disabled)return undefined;
 const raw=entry.options.config,loaded=entry.fiber?.config,path=schemaPath(input.schemaSha256);
 const matches=config=>config?.serverName===input.apiId&&config.transport==='stdio'&&hasSchemaArgument(config,path);
 if(!matches(raw)||!matches(loaded))return undefined;
 // Fixed-position fields avoid object-key-order sensitivity and expose no config.
 return JSON.stringify([raw.serverName,raw.transport,raw.command,raw.args,loaded.serverName,loaded.transport,loaded.command,loaded.args]);
}

function waitForRegistry(ctx,input,signal,timeoutMs){
 const agent=ctx.agents.get(input.sessionId);
 if(!agent)return Promise.resolve(result('unavailable','session_unavailable'));
 return new Promise(resolve=>{
  let settled=false,scheduled=false,selected,last=result('pending','registration_pending'),timer;
  const off=[];
  const finish=value=>{
   if(settled)return;settled=true;clearTimeout(timer);
   signal.removeEventListener('abort',abort);
   for(const remove of off){try{remove();}catch{}}
   resolve(value);
  };
  const abort=()=>finish(result('unavailable',signal.reason==='disposed'?'disposed':'cancelled'));
  const check=()=>{
   scheduled=false;if(settled)return;
   if(signal.aborted){abort();return;}
   try{
    if(ctx.agents.get(input.sessionId)!==agent){finish(result('unavailable','session_changed'));return;}
    const rows=[...ctx.loader.entries()].filter(entry=>entry.options?.id==='uptokey-api-'+input.apiId);
    if(rows.length>1){finish(result('unavailable','registration_changed'));return;}
    const entry=rows[0],stamp=entry&&descriptor(entry,input);
    if(selected&&(entry!==selected.entry||entry.fiber!==selected.fiber||stamp!==selected.stamp)){
     finish(result('unavailable','registration_changed'));return;
    }
    if(!stamp){last=result('pending','registration_pending');return;}
    if(!selected)selected={entry,fiber:entry.fiber,stamp};
    if(entry.fiber?.state!==ACTIVE){last=result('pending','registration_pending');return;}
    const prefix='mcp__'+input.apiId+'__';
    const toolCount=ctx.tools.schemas(agent).filter(tool=>{
     if(typeof tool.name!=='string'||!tool.name.startsWith(prefix))return false;
     // This entry owns a root/global MCP namespace. A same-named Agent-scoped
     // tool can shadow it and must not certify this registration's readiness.
     const global=ctx.tools.get(tool.name);
     return global!==undefined&&ctx.tools.get(tool.name,agent)===global;
    }).length;
    if(!toolCount){last=result('pending','no_visible_tools');return;}
    // The schema projection may consult scoped providers. Recheck ownership and
    // the loaded configuration after it, without any asynchronous gap.
    if(ctx.agents.get(input.sessionId)!==agent||![...ctx.loader.entries()].includes(entry)||entry.fiber!==selected.fiber||entry.fiber.state!==ACTIVE||descriptor(entry,input)!==stamp){
     finish(result('unavailable','registration_changed'));return;
    }
    finish(result('ready',undefined,toolCount));
   }catch{finish(result('unavailable','runtime_unavailable'));}
  };
  const wake=()=>{if(!settled&&!scheduled){scheduled=true;queueMicrotask(check);}};
  try{
   off.push(ctx.on('tools/change',wake));
   off.push(ctx.on('internal/status',wake,{global:true}));
   signal.addEventListener('abort',abort,{once:true});
   timer=setTimeout(()=>{check();if(!settled)finish(last);},timeoutMs);
   check();
  }catch{finish(result('unavailable','runtime_unavailable'));}
 });
}

async function readInput(request,signal){
 const declared=request.headers.get('content-length');
 if(declared!==null&&(!/^\d+$/.test(declared)||Number(declared)>MAX_BODY))throw Error('request_too_large');
 if(!/^application\/json(?:\s*;|$)/i.test(request.headers.get('content-type')??''))throw Error('invalid_request');
 const reader=request.body?.getReader();if(!reader)throw Error('invalid_request');
 const chunks=[];let length=0;
 let rejectAbort;
 const cancelled=new Promise((_,reject)=>{rejectAbort=reject;});
 const abort=()=>{void reader.cancel().catch(()=>{});rejectAbort(signal.reason);};
 signal.addEventListener('abort',abort,{once:true});
 try{
  signal.throwIfAborted();
  while(true){
   const next=await Promise.race([reader.read(),cancelled]);signal.throwIfAborted();
   if(next.done)break;
   length+=next.value.byteLength;if(length>MAX_BODY)throw Error('request_too_large');
   chunks.push(next.value);
  }
  const value=JSON.parse(Buffer.concat(chunks,length).toString('utf8'));
  if(!validInput(value))throw Error('invalid_request');
  return value;
 }finally{
  signal.removeEventListener('abort',abort);
  void reader.cancel().catch(()=>{});
  try{reader.releaseLock();}catch{}
 }
}

// Export the small host boundary so focal tests use the same route handler.
export function createPublicApiReady(ctx,{timeoutMs=WAIT_MS,bodyTimeoutMs=2000}={}){
 const lifetime=new AbortController(),pending=new Set();
 async function handle(request){
  if(lifetime.signal.aborted)return response(result('unavailable','disposed'));
  const controller=new AbortController();
  const cancel=()=>controller.abort('cancelled'),dispose=()=>controller.abort('disposed');
  request.signal.addEventListener('abort',cancel,{once:true});lifetime.signal.addEventListener('abort',dispose,{once:true});
  let bodyTimer=setTimeout(()=>controller.abort('body_timeout'),bodyTimeoutMs);
  try{
   if(request.signal.aborted)cancel();
   const input=await readInput(request,controller.signal);clearTimeout(bodyTimer);bodyTimer=undefined;
   return response(await waitForRegistry(ctx,input,controller.signal,timeoutMs));
  }catch(error){
   if(controller.signal.aborted)return response(result('unavailable',controller.signal.reason==='disposed'?'disposed':controller.signal.reason==='body_timeout'?'invalid_request':'cancelled'));
   const large=error?.message==='request_too_large';
   return response(result('unavailable',large?'request_too_large':'invalid_request'),large?413:400);
  }finally{
   clearTimeout(bodyTimer);request.signal.removeEventListener('abort',cancel);lifetime.signal.removeEventListener('abort',dispose);
  }
 }
 return {
  fetch(request){const task=handle(request).finally(()=>pending.delete(task));pending.add(task);return task;},
  async dispose(){lifetime.abort('disposed');await Promise.allSettled([...pending]);},
 };
}

export function apply(ctx){
 const ready=createPublicApiReady(ctx);
 ctx.connection.fetch.register({path:PUBLIC_API_READY_PATH,methods:['POST'],requestBody:'streaming',fetch:ready.fetch});
 ctx.effect(()=>()=>ready.dispose(),'uptokey-public-api-ready: pending checks');
}
