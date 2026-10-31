import {createServer} from 'node:http';
import {createHmac,timingSafeEqual} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {pipeline} from 'node:stream/promises';
import {Entry} from '@napi-rs/keyring';
import {discoverHostedCatalog} from './hosted-catalog-client.mjs';
import {dispatchHosted,hostedReceipt} from './hosted-dispatch.mjs';

export const CORE_BRIDGE_SERVICE='com.uptokey.harness.lab';
export const CORE_BRIDGE_PORT=43193;
const CORE_URL='http://127.0.0.1:21435';
const ADMITTED=new Map([
  ['GET /v1/models',false],
  ['GET /v1/usage',false],
  ['GET /v1/connections',false],
  ['POST /v1/chat/completions',true],
  ['POST /v1/responses',true],
  ['POST /v1/messages',true],
  ['GET /hosted/catalog',false],
  ['POST /hosted/chat',true],
  ['POST /hosted/receipt',true],
]);
const MAX_BODY=4*1024*1024;

export function nativeSecret(account){return new Entry(CORE_BRIDGE_SERVICE,account).getPassword()??undefined}
function equalSecret(header,expected){
  if(typeof header!=='string'||!header.startsWith('Bearer ')||!expected)return false;
  const supplied=Buffer.from(header.slice(7));
  const valid=Buffer.from(expected);
  return supplied.length===valid.length&&timingSafeEqual(supplied,valid);
}
async function bodyWithinLimit(request){
  let size=0;const parts=[];
  for await(const part of request){size+=part.length;if(size>MAX_BODY)throw Error('too_large');parts.push(part)}
  return Buffer.concat(parts);
}
function answer(response,status,type){
  response.writeHead(status,{'content-type':'application/json','cache-control':'no-store'});
  response.end(JSON.stringify({error:{type}}));
}

/** Only the core owns BYOK keys, routing and policy. This process never stores bodies. */
export function createCoreBridge({gate,clientToken,fetcher=fetch}={}){
  if(!gate||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(clientToken??''))throw Error('core_bridge_identity_unavailable');
  return createServer(async(request,response)=>{
    response.setHeader('cache-control','no-store');
    if(request.method==='GET'&&request.url?.startsWith('/health?nonce=')){
      const nonce=request.url.slice('/health?nonce='.length);
      if(!/^[a-f0-9]{32}$/.test(nonce))return answer(response,400,'invalid_request');
      response.setHeader('x-uptokey-bridge-proof',createHmac('sha256',gate).update(nonce).digest('hex'));
      return answer(response,200,'ready');
    }
    if(request.url==='/health'&&request.method==='GET')return answer(response,200,'ready');
    if(request.headers.host!=='127.0.0.1:43194'||!equalSecret(request.headers.authorization,gate))return answer(response,401,'bridge_unauthorized');
    const path=request.url;
    const acceptsBody=ADMITTED.get(`${request.method} ${path}`);
    if(acceptsBody===undefined)return answer(response,404,'route_not_found');
    if(request.headers.origin!==undefined||request.headers['x-uptokey-account-token']!==undefined)return answer(response,400,'header_rejected');
    let body;
    try{
      if(acceptsBody){
        if(request.headers['content-type']!=='application/json')return answer(response,415,'unsupported_media_type');
        body=await bodyWithinLimit(request);
      }else if((request.headers['content-length']??'0')!=='0'||request.headers['transfer-encoding'])return answer(response,400,'body_rejected');
    }catch{return answer(response,413,'request_too_large')}
    const controller=new AbortController();
    const cancel=()=>{if(!response.writableFinished)controller.abort()};
    response.once('close',cancel);
    const deadline=setTimeout(()=>controller.abort(),300_000);deadline.unref();
    if(response.destroyed)controller.abort();
    try{
      if(path.startsWith('/hosted/')){
        let input;
        if(body){try{input=JSON.parse(body.toString('utf8'))}catch{return answer(response,400,'hosted_request_invalid')}}
        const options={token:clientToken,fetcher,signal:controller.signal};
        const result=path==='/hosted/catalog'?await discoverHostedCatalog(options):path==='/hosted/chat'?await dispatchHosted(input,options):await hostedReceipt(input,options);
        response.writeHead(200,{'content-type':'application/json','cache-control':'no-store'});
        response.end(JSON.stringify(result));
        return;
      }
      const upstream=await fetcher(CORE_URL+path,{method:request.method,headers:{authorization:`Bearer ${clientToken}`,accept:request.headers.accept??'application/json',...(body?{'content-type':'application/json'}:{})},body,redirect:'error',signal:controller.signal});
      const headers={'cache-control':'no-store'};
      for(const name of ['content-type','retry-after','x-request-id']){const value=upstream.headers.get(name);if(value)headers[name]=value}
      response.writeHead(upstream.status,headers);
      if(upstream.body)await pipeline(upstream.body,response);
      else response.end();
    }catch(error){if(!response.destroyed){if(!response.headersSent){
      const known=new Set(['account_share_conflict','account_reauthentication_required','account_rate_limited','hosted_execution_disabled','hosted_model_unavailable','hosted_price_changed','hosted_paid_inference_not_authorized','hosted_tools_unsupported','hosted_output_limit_exceeded','hosted_request_invalid','account_request_invalid','hosted_request_too_large','hosted_receipt_unavailable']);
      answer(response,path.startsWith('/hosted/')&&known.has(error?.message)?409:502,path.startsWith('/hosted/')&&known.has(error?.message)?error.message:'core_unavailable');
    }else response.destroy()}}
    finally{clearTimeout(deadline);response.off('close',cancel)}
  });
}

if(process.argv[1]&&import.meta.url===pathToFileURL(process.argv[1]).href){
  const server=createCoreBridge({gate:nativeSecret('bridge-gate'),clientToken:nativeSecret('client-token')});
  server.listen(CORE_BRIDGE_PORT,'127.0.0.1');
}
