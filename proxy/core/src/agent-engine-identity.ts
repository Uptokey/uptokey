import {createHash,randomBytes,timingSafeEqual} from 'node:crypto';
import {isVirtualModel} from './auto-route.ts';
import {isLocalModelAlias} from './local-model-aliases.ts';
import {isProvider} from './provider-registry.ts';
import type {ProviderName} from './types.ts';
import {hasForbiddenInferenceCredentialField,projectInferenceRequest} from './inference-request-policy.ts';
import {cancelStream,cancelStreamWithin} from './stream-lifecycle.ts';

export interface AgentEngineHostContext {
  authorization:string;
  headers:Readonly<Record<string,string>>;
}
export interface AgentEngineIdentityOptions {
  /** Bind to the SAME canonical app.request; never dispatch directly to a provider. */
  dispatch:(request:Request)=>Promise<Response>;
  /** Resolve the existing authenticated host context, including live revocation.
   * Return undefined when it is no longer valid. Never derive this from engine input. */
  resolveHostContext:()=>Promise<AgentEngineHostContext|undefined>;
  model:string;
  provider:ProviderName;
  ttlMs:number;
  maxTokens:number;
  maxBodyBytes?:number;
  now?:()=>number;
}

const PATH='/v1/chat/completions';
const CORE_URL=`http://localhost:21435${PATH}`;
const HOST_HEADERS=new Set(['x-uptokey-project-id','x-uptokey-conversation-id','x-uptokey-conversation-request-id','x-uptokey-processing-policy']);
const RESPONSE_HEADERS=['content-type','x-uptokey-provider','x-uptokey-model','x-uptokey-cache','x-uptokey-cost-class','x-uptokey-cost-estimate-micros'];
class BoundaryError extends Error {
  status:number;
  constructor(status=401){super('engine_session_unavailable');this.status=status;}
}
function abortable<T>(operation:Promise<T>,signal:AbortSignal):Promise<T>{
  if(signal.aborted){void operation.catch(()=>undefined);return Promise.reject(new BoundaryError());}
  return new Promise((resolve,reject)=>{
    const abort=()=>{signal.removeEventListener('abort',abort);reject(new BoundaryError());};
    signal.addEventListener('abort',abort,{once:true});
    operation.then(value=>{signal.removeEventListener('abort',abort);resolve(value);},error=>{signal.removeEventListener('abort',abort);reject(error);});
  });
}
function context(value:AgentEngineHostContext|undefined){
  if(!value||typeof value.authorization!=='string'||!/^Bearer [^\s]{1,4096}$/.test(value.authorization)||!value.headers||typeof value.headers!=='object')throw new BoundaryError();
  const headers=new Headers();
  for(const [name,content] of Object.entries(value.headers)){
    if(name!==name.toLowerCase()||!HOST_HEADERS.has(name)||typeof content!=='string'||!content||content.length>200||/[\r\n]/.test(content))throw new BoundaryError();
    headers.set(name,content);
  }
  if(!headers.has('x-uptokey-project-id'))throw new BoundaryError();
  headers.set('authorization',value.authorization);
  return {headers,digest:createHash('sha256').update(JSON.stringify([...headers.entries()].sort())).digest('hex')};
}

/** Memory-only transport capability, not a client key, approval, or new grant.
 * The parent credential stays inside the host. The canonical app still owns
 * authentication, project/conversation policies, routing, budgets, and usage.
 * A dispatcher fixture alone does NOT prove that productive budget binding.
 * The network host must separately bind loopback and validate its exact Host.
 */
export async function createAgentEngineIdentity(options:AgentEngineIdentityOptions):Promise<{
  fetch:(request:Request)=>Promise<Response>;token:string;close:()=>Promise<void>;
}>{
  const {dispatch,resolveHostContext,model,provider,ttlMs,maxTokens}=options;
  const maxBodyBytes=options.maxBodyBytes??1024*1024,now=options.now??Date.now;
  if(typeof dispatch!=='function'||typeof resolveHostContext!=='function'||!isProvider(provider)
    ||typeof model!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,199}$/.test(model)||isVirtualModel(model)||isLocalModelAlias(model)
    ||!Number.isSafeInteger(ttlMs)||ttlMs<1||ttlMs>900_000||!Number.isSafeInteger(maxTokens)||maxTokens<1||maxTokens>131072
    ||!Number.isSafeInteger(maxBodyBytes)||maxBodyBytes<1||maxBodyBytes>1024*1024)throw new Error('engine_session_configuration_invalid');
  let binding:string;
  try{binding=context(await resolveHostContext()).digest;}catch{throw new BoundaryError();}
  const token=randomBytes(32).toString('base64url'),credential=Buffer.from(`Bearer ${token}`),expiresAt=now()+ttlMs;
  const active=new Set<AbortController>();let closed=false;
  const close=async()=>{if(closed)return;closed=true;clearTimeout(expiry);for(const controller of active)controller.abort();active.clear();};
  const expiry=setTimeout(()=>{void close();},ttlMs);expiry.unref();
  const assertOpen=()=>{if(closed||now()>=expiresAt)throw new BoundaryError();};
  const liveContext=async(signal:AbortSignal)=>{
    assertOpen();const current=context(await abortable(Promise.resolve().then(resolveHostContext),signal));assertOpen();
    if(current.digest!==binding||signal.aborted)throw new BoundaryError();return current.headers;
  };
  const error=(status:number)=>Response.json({error:{type:'engine_session_unavailable'}},{status,headers:{'cache-control':'no-store'}});
  const fetch=async(request:Request):Promise<Response>=>{
    let controller:AbortController|undefined,retained=false,cleanup=()=>{};
    try{
      assertOpen();
      const url=new URL(request.url);
      if(request.method!=='POST'||url.pathname!==PATH||url.search||url.hash||url.username||url.password||url.protocol!=='http:'||!['127.0.0.1','[::1]','localhost'].includes(url.hostname))throw new BoundaryError(404);
      const supplied=Buffer.from(request.headers.get('authorization')??'');
      if(supplied.length!==credential.length||!timingSafeEqual(supplied,credential)||request.headers.has('origin'))throw new BoundaryError();
      if(request.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase()!=='application/json')throw new BoundaryError(415);
      if(active.size>=2)throw new BoundaryError(429);
      controller=new AbortController();active.add(controller);const control=controller;
      const abort=()=>control.abort();request.signal.addEventListener('abort',abort,{once:true});
      cleanup=()=>{request.signal.removeEventListener('abort',abort);active.delete(control);};
      if(request.signal.aborted)control.abort();
      await liveContext(control.signal);
      const length=request.headers.get('content-length');
      if(length!==null&&(!/^\d+$/.test(length)||Number(length)>maxBodyBytes))throw new BoundaryError(413);
      if(!request.body)throw new BoundaryError(400);
      const reader=request.body.getReader(),chunks:Uint8Array[]=[];let size=0;
      try{
        for(;;){const part=await abortable(reader.read(),control.signal);if(part.done)break;size+=part.value.byteLength;if(size>maxBodyBytes)throw new BoundaryError(413);chunks.push(part.value);}
      }catch(error){cancelStream(reader);throw error;}finally{reader.releaseLock();}
      let body:Record<string,unknown>;
      try{body=JSON.parse(Buffer.concat(chunks,size).toString('utf8'));}catch{throw new BoundaryError(400);}
      if(!body||typeof body!=='object'||Array.isArray(body)||body.model!==model)throw new BoundaryError(403);
      if(Object.keys(body).some(key=>key.startsWith('uptokey_')||['conversation_id','processing_policy'].includes(key))||hasForbiddenInferenceCredentialField(body))throw new BoundaryError(403);
      if(body.n!==undefined&&body.n!==1)throw new BoundaryError(400);
      for(const field of ['max_tokens','max_completion_tokens'])if(body[field]!==undefined&&(!Number.isSafeInteger(body[field])||Number(body[field])<1||Number(body[field])>maxTokens))throw new BoundaryError(400);
      if(body.max_tokens!==undefined&&body.max_completion_tokens!==undefined)throw new BoundaryError(400);
      if(body.max_tokens===undefined&&body.max_completion_tokens===undefined)body.max_tokens=maxTokens;
      body.uptokey_provider=provider;body.uptokey_require_model=true;
      if(!projectInferenceRequest(body))throw new BoundaryError(400);
      const headers=await liveContext(control.signal);headers.set('host','localhost:21435');headers.set('content-type','application/json');headers.set('accept',body.stream===true?'text/event-stream':'application/json');
      const outbound=new Request(CORE_URL,{method:'POST',headers,body:JSON.stringify(body),signal:control.signal});
      const pending=Promise.resolve().then(()=>{if(control.signal.aborted)throw new BoundaryError();return dispatch(outbound);}).then(response=>{if(control.signal.aborted)cancelStream(response.body);return response;});
      const response=await abortable(pending,control.signal);
      try{await liveContext(control.signal);}catch(error){cancelStream(response.body);throw error;}
      if(!response.ok){cancelStream(response.body);throw new BoundaryError(response.status>=400&&response.status<=599?response.status:502);}
      const type=response.headers.get('content-type')?.split(';',1)[0]?.trim().toLowerCase();
      if(!response.body||!['application/json','text/event-stream'].includes(type??'')){cancelStream(response.body);throw new BoundaryError(502);}
      const outputHeaders=new Headers({'cache-control':'no-store'});
      for(const name of RESPONSE_HEADERS){const value=response.headers.get(name);if(value!==null)outputHeaders.set(name,value);}
      const upstream=response.body.getReader();let finished=false;
      const finish=()=>{if(finished)return;finished=true;control.signal.removeEventListener('abort',stop);cleanup();};
      let outputController:ReadableStreamDefaultController<Uint8Array>;
      const stop=()=>{
        if(finished)return;finish();cancelStream(upstream);
        // A caller that pressed Stop has already cancelled consumption. Close
        // that transport quietly; host revocation/expiry remains an error.
        if(request.signal.aborted)outputController.close();else outputController.error(new BoundaryError());
      };
      const stream=new ReadableStream<Uint8Array>({
        start(value){outputController=value;control.signal.addEventListener('abort',stop,{once:true});if(control.signal.aborted)stop();},
        async pull(value){
          try{
            await liveContext(control.signal);const chunk=await abortable(upstream.read(),control.signal);await liveContext(control.signal);
            if(finished)return;if(chunk.done){finish();value.close();upstream.releaseLock();}else value.enqueue(chunk.value);
          }catch{if(!finished){finish();control.abort();cancelStream(upstream);value.error(new BoundaryError());}}
        },
        async cancel(){finish();control.abort();await cancelStreamWithin(upstream,250);},
      },{highWaterMark:0});
      retained=true;return new Response(stream,{status:response.status,headers:outputHeaders});
    }catch(cause){controller?.abort();return error(cause instanceof BoundaryError?cause.status:502);}
    finally{if(!retained)cleanup();}
  };
  return {fetch,token,close};
}
