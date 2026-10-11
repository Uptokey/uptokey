import {Client} from '@modelcontextprotocol/sdk/client/index.js';
import {StreamableHTTPClientTransport} from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import {createHash} from 'node:crypto';
import {publicHttpsFetch} from '../../../integracoes/api-instruments/src/governed-transport.ts';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {redactForToolResult,assertNoSecretMaterial} from '../mcp-redact.ts';
export interface RemoteTool {name:string;inputSchema:Record<string,unknown>;digest:string;effect:'read_external'|'write_external'}
export class RemoteMcpError extends Error {readonly sent:boolean;constructor(code:string,sent=false){super(code);this.sent=sent;}}
export const remoteToolDigest=(schema:unknown)=>createHash('sha256').update(canonicalJson(schema)).digest('hex');
export function safeRemoteValue(value:unknown,secret:string):unknown {
 if(!secret)throw new RemoteMcpError('service_auth_invalid');
 const redact=(item:unknown,depth=0):unknown=>{
  if(depth>64)throw new RemoteMcpError('service_response_too_large');
  if(typeof item==='string')return item.split(secret).join('[redacted]').replace(/\bsk_(?:live|test)_[A-Za-z0-9_-]+/g,'[redacted]');
  if(Array.isArray(item))return item.map(child=>redact(child,depth+1));
  if(item&&typeof item==='object')return Object.fromEntries(Object.entries(item).map(([key,child])=>[redact(key,depth+1) as string,redact(child,depth+1)]));
  return item;
 };
 const serialized=JSON.stringify(redact(redactForToolResult(value)));
 const parsed=JSON.parse(serialized);assertNoSecretMaterial(parsed);return parsed;
}
/** One bounded, pinned-origin SDK session. Discovery never invokes tools. */
export class RemoteMcpClient {
 private readonly endpoint:string;private readonly fetcher:typeof fetch;
 constructor(endpoint:string,fetcher:typeof fetch=publicHttpsFetch){this.endpoint=endpoint;this.fetcher=fetcher;}
 private async session<T>(secret:string,signal:AbortSignal,guard:()=>Promise<void>,operation:(client:Client)=>Promise<T>):Promise<T>{
  const target=new URL(this.endpoint);if(target.protocol!=='https:'||target.username||target.password||target.search||target.hash)throw new RemoteMcpError('service_destination_denied');
  let sent=false;let transportCode:string|undefined;let cleanupSignal:AbortSignal|undefined;
  const admitted=async()=>{try{await guard();}catch(error){transportCode=error instanceof Error&&/^service_[a-z_]+$/.test(error.message)?error.message:'service_cancelled';throw new RemoteMcpError(transportCode,sent);}};
  const checkedFetch=((async(input:RequestInfo|URL,init:RequestInit={})=>{
   const url=new URL(typeof input==='string'?input:input instanceof URL?input.href:input.url);
   if(url.href!==target.href||!['GET','POST','DELETE'].includes(init.method??'GET'))throw new RemoteMcpError('service_destination_denied');
   signal.throwIfAborted();await admitted();signal.throwIfAborted();
   const headers=new Headers(init.headers);headers.set('authorization',`Bearer ${secret}`);
   // Only tools/call may perform an external effect; initialization/listing is not a dispatched action.
   if(typeof init.body==='string'){try{if(JSON.parse(init.body).method==='tools/call')sent=true;}catch{throw new RemoteMcpError('service_input_invalid');}}
   const response=await this.fetcher(url,{...init,headers,redirect:'error',credentials:'omit',signal:AbortSignal.any([signal,...(init.signal?[init.signal]:[]),...(cleanupSignal?[cleanupSignal]:[])])});
   try{await admitted();signal.throwIfAborted();}catch(error){await response.body?.cancel();throw error;}
   if([401,403,429].includes(response.status)){await response.body?.cancel();transportCode=response.status===401?'service_auth_invalid':response.status===403?'service_permission_denied':'service_rate_limited';throw new RemoteMcpError(transportCode);}
   if(response.status>=300&&response.status<400){await response.body?.cancel();throw new RemoteMcpError('service_destination_denied');}
   const bytes=Number(response.headers.get('content-length'));if(bytes>4*1024*1024){await response.body?.cancel();throw new RemoteMcpError('service_response_too_large');}
   if(!response.body)return response;
   let count=0;return new Response(response.body.pipeThrough(new TransformStream({transform(chunk,controller){count+=chunk.byteLength;if(count>4*1024*1024){controller.error(new RemoteMcpError('service_response_too_large'));return;}controller.enqueue(chunk);}})),{status:response.status,statusText:response.statusText,headers:response.headers});
  }) as typeof fetch);
  const client=new Client({name:'Uptokey',version:'1.0.0'},{capabilities:{}});
  const transport=new StreamableHTTPClientTransport(target,{fetch:checkedFetch,requestInit:{headers:{authorization:`Bearer ${secret}`},redirect:'error'},reconnectionOptions:{maxRetries:0,initialReconnectionDelay:1000,maxReconnectionDelay:1000,reconnectionDelayGrowFactor:1}});
  const abort=()=>{void transport.close();};signal.addEventListener('abort',abort,{once:true});
  try{await admitted();await client.connect(transport);signal.throwIfAborted();const result=await operation(client);await admitted();signal.throwIfAborted();return result;}
  catch(error){if(error instanceof RemoteMcpError)throw new RemoteMcpError(error.message,error.sent||sent);if(transportCode)throw new RemoteMcpError(transportCode,sent);if(signal.aborted)throw new RemoteMcpError('service_cancelled',sent);throw new RemoteMcpError(sent?'service_operation_unconfirmed':'service_discovery_failed',sent);}
  finally{
   try{if(transport.sessionId&&!signal.aborted){await admitted();signal.throwIfAborted();cleanupSignal=AbortSignal.timeout(2000);await transport.terminateSession();}}catch{/* Cleanup cannot relabel a completed effect or send after authority loss. */}
   finally{signal.removeEventListener('abort',abort);await client.close().catch(()=>undefined);await transport.close().catch(()=>undefined);}
  }
 }
 async discover(secret:string,signal:AbortSignal,guard:()=>Promise<void>):Promise<RemoteTool[]>{
  return this.session(secret,signal,guard,async client=>{
   const tools:RemoteTool[]=[],seen=new Set<string>();let cursor:string|undefined;
   for(let page=0;page<20;page++){
    const result=await client.listTools(cursor?{cursor}:{},{signal,timeout:15000});await guard();
    for(const tool of result.tools){if(!/^[A-Za-z0-9_-]{1,128}$/.test(tool.name)||tools.some(row=>row.name===tool.name)||JSON.stringify(tool.inputSchema).length>65536)throw new RemoteMcpError('service_schema_invalid');
     const inputSchema=safeRemoteValue(tool.inputSchema,secret) as Record<string,unknown>;
     // Server annotations/names cannot grant read authority. Only these documented reads are curated;
     // every other discovered operation receives explicit write consent and no automatic retry.
     const read=['list_domains','get_domain','list_emails','get_email','list_templates','get_template','list_contacts','get_contact','list_lists','get_list','list_inboxes','get_inbox'].includes(tool.name);
     tools.push({name:tool.name,inputSchema,digest:remoteToolDigest(inputSchema),effect:read?'read_external':'write_external'});
    }
    if(tools.length>512)throw new RemoteMcpError('service_response_too_large');
    if(!result.nextCursor)return tools;
    if(seen.has(result.nextCursor))throw new RemoteMcpError('service_schema_invalid');seen.add(result.nextCursor);cursor=result.nextCursor;
   }
   throw new RemoteMcpError('service_response_too_large');
  });
 }
 async call(secret:string,tool:RemoteTool,parameters:Record<string,unknown>,signal:AbortSignal,guard:()=>Promise<void>):Promise<unknown>{
  return this.session(secret,signal,guard,async client=>{
   // Revalidate live schema in the same authenticated session before any effect.
   let cursor:string|undefined,found:Record<string,unknown>|undefined;const seen=new Set<string>();
   for(let page=0;page<20;page++){const result=await client.listTools(cursor?{cursor}:{},{signal,timeout:15000});found=result.tools.find(row=>row.name===tool.name)?.inputSchema; if(found||!result.nextCursor)break;if(seen.has(result.nextCursor))break;seen.add(result.nextCursor);cursor=result.nextCursor;}
   if(!found||remoteToolDigest(found)!==tool.digest)throw new RemoteMcpError('service_schema_changed');
   await guard();signal.throwIfAborted();
   let result;try{result=await client.callTool({name:tool.name,arguments:parameters},undefined,{signal,timeout:120000});}catch{throw new RemoteMcpError('service_operation_unconfirmed',true);}
   await guard();signal.throwIfAborted();if(result.isError)throw new RemoteMcpError('service_operation_failed',true);
   return safeRemoteValue(result,secret);
  });
 }
}
