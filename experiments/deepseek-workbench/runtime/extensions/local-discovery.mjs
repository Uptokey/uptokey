import {projectOllamaCatalog} from './ollama-catalog.mjs';
export const name='uptokey-local-discovery';
export const inject=['settings'];

export function createLocalDiscovery(settings,request){
 let pending;
 const refresh=async()=>{
  const descriptor=settings.describe().find(item=>item.ns==='llm-pi-ai');
  const route=descriptor?.value?.providers?.['ollama-local'];
  if(!route||route.baseURL!=='http://127.0.0.1:43192/v1')return {state:'unconfigured'};
  const [listing,loaded]=await Promise.all([request('/v1/models'),request('/api/ps')]);
  if(!Array.isArray(listing?.data)||!Array.isArray(loaded?.models))throw Error('local_catalog_invalid');
  const details=new Map();
  for(const row of listing.data){
   if(typeof row?.id!=='string'||!row.id)throw Error('local_model_invalid');
   if(!details.has(row.id))details.set(row.id,await request('/api/show',{model:row.id}));
  }
  const projected=projectOllamaCatalog(listing.data,route.models??[],details,loaded.models);
  if(JSON.stringify(projected.models)===JSON.stringify(route.models))return {state:'unchanged',count:projected.models.length};
  // Native settings own persistence and revision conflicts, just as for the UI.
  await settings.update('llm-pi-ai',{providers:{'ollama-local':{models:projected.models}}},descriptor.revision);
  return {state:'updated',count:projected.models.length};
 };
 return ()=>{
  if(!pending)pending=refresh().finally(()=>{pending=undefined;});
  return pending;
 };
}

export function apply(ctx){
 const stop=new AbortController();
 const request=async(path,body)=>{
  const response=await fetch('http://127.0.0.1:43192'+path,{method:body?'POST':'GET',...(body?{headers:{'content-type':'application/json'},body:JSON.stringify(body)}:{}),redirect:'error',signal:AbortSignal.any([stop.signal,AbortSignal.timeout(5000)])});
  if(!response.ok)throw Error('local_metadata_unavailable');
  let size=0;const chunks=[];
  for await(const chunk of response.body){size+=chunk.byteLength;if(size>2*1024*1024)throw Error('local_metadata_limit');chunks.push(chunk);}
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
 };
 const refresh=createLocalDiscovery(ctx.settings,request);
 const tick=()=>{void refresh().catch(()=>{/* Existing catalog survives disconnects/conflicts; retry on next tick. */});};
 const timer=setInterval(tick,60000);timer.unref();tick();
 ctx.effect(()=>()=>{clearInterval(timer);stop.abort();});
}
