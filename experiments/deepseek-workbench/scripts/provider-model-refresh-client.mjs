import {createProviderSetupProtocolClient,refreshProviderConnection} from '../runtime/account/provider-setup.mjs';

const CORE_URL='http://127.0.0.1:21435';
const TOKEN=/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i;
const PROVIDER=/^[a-z][a-z0-9.-]{0,63}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MODEL=/^[^\u0000-\u001f\u007f]{1,200}$/;
const MAX_RESPONSE=256*1024;

function record(value){return value!==null&&typeof value==='object'&&!Array.isArray(value)?value:null}
function fail(code){throw Error(code)}
async function boundedJson(response){
 if(!response.body)fail('provider_model_refresh_failed');
 const reader=response.body.getReader();let bytes=0;const chunks=[];
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>MAX_RESPONSE)fail('provider_model_refresh_failed');chunks.push(Buffer.from(next.value));}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 try{return JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{fail('provider_model_refresh_failed')}
}
function errorType(value){
 const code=record(value)?.error&&record(record(value).error)?.type;
 return typeof code==='string'&&/^provider_[a-z_]{1,80}$/.test(code)?code:'provider_model_refresh_failed';
}
async function request(path,{token,fetcher,body,signal}){
 const deadline=AbortSignal.timeout(30_000);
 const response=await fetcher(CORE_URL+path,{method:body===undefined?'GET':'POST',headers:{authorization:'Bearer '+token,accept:'application/json',...(body===undefined?{}:{'content-type':'application/json'})},...(body===undefined?{}:{body:JSON.stringify(body)}),credentials:'omit',cache:'no-store',redirect:'error',signal:signal?AbortSignal.any([signal,deadline]):deadline});
 const value=await boundedJson(response);if(!response.ok)fail(errorType(value));return value;
}
function connection(value){
 const item=record(value);if(!item||!UUID.test(item.id)||!Number.isSafeInteger(item.revision)||item.revision<1||!PROVIDER.test(item.providerId)||!['byok','local','oauth'].includes(item.accessMode)||typeof item.enabled!=='boolean'||!Array.isArray(item.models)||item.models.length>256||item.models.some(model=>typeof model!=='string'||!MODEL.test(model)))fail('provider_model_refresh_failed');
 return{id:item.id,revision:item.revision,providerId:item.providerId,accessMode:item.accessMode,enabled:item.enabled,models:[...new Set(item.models)]};
}
/** The Harness supplies only transport; refresh semantics are the Tauri contract. */
export async function refreshProviderModels(providerId,{token,fetcher=fetch}={}){
 if(!PROVIDER.test(providerId??'')||!TOKEN.test(token??''))fail('provider_model_refresh_failed');
 const inventory=record(await request('/v1/connections',{token,fetcher}));
 if(!inventory||!Array.isArray(inventory.connections)||inventory.connections.length>128)fail('provider_model_refresh_failed');
 const matches=inventory.connections.map(connection).filter(item=>item.providerId===providerId&&item.accessMode==='byok'&&item.enabled);
 if(matches.length===0)fail('provider_connection_missing');if(matches.length!==1)fail('provider_connection_ambiguous');
 const target=matches[0];
 const client=createProviderSetupProtocolClient((path,body,signal)=>request('/local/provider/setup'+path,{token,fetcher,body,...(signal?{signal}:{})}));
 const result=await refreshProviderConnection(client,{providerId,connectionId:target.id,expectedRevision:target.revision,currentModels:target.models});
 return{providerId,selectedModel:result.modelId,models:result.models,changed:result.changed,reloaded:true};
}
