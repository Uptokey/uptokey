import {createHash,createPrivateKey,createPublicKey,generateKeyPairSync,sign} from 'node:crypto';
import {Entry} from '@napi-rs/keyring';
import {CORE_BRIDGE_SERVICE} from './core-bridge-server.mjs';

const CORE='http://127.0.0.1:21435';
const ACCOUNT='workspace-private-key-v1';
const TOKEN=/^utk_local_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32}$/i;
const B64=/^[A-Za-z0-9_-]{43}$/;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const canonicalPublic=privateKey=>{
  const value=createPublicKey(privateKey).export({format:'jwk'});
  if(value.kty!=='EC'||value.crv!=='P-256'||!B64.test(value.x??'')||!B64.test(value.y??''))throw Error('context_identity_invalid');
  return{kty:'EC',crv:'P-256',x:value.x,y:value.y};
};
const privateKeyFrom=raw=>{
  if(typeof raw!=='string'||raw.length>4096)throw Error('context_identity_invalid');
  let value;try{value=JSON.parse(raw)}catch{throw Error('context_identity_invalid')}
  if(!value||typeof value!=='object'||Array.isArray(value)||value.kty!=='EC'||value.crv!=='P-256'||
    !B64.test(value.x??'')||!B64.test(value.y??'')||!B64.test(value.d??''))throw Error('context_identity_invalid');
  try{return createPrivateKey({key:{kty:'EC',crv:'P-256',x:value.x,y:value.y,d:value.d},format:'jwk'})}
  catch{throw Error('context_identity_invalid')}
};
function workspaceIdentity(entryFactory){
  const entry=entryFactory(CORE_BRIDGE_SERVICE,ACCOUNT),stored=entry.getPassword();
  let privateKey;
  if(stored!==null&&stored!==undefined)privateKey=privateKeyFrom(stored);
  else{
    privateKey=generateKeyPairSync('ec',{namedCurve:'prime256v1'}).privateKey;
    const jwk=privateKey.export({format:'jwk'});
    entry.setPassword(JSON.stringify({kty:'EC',crv:'P-256',x:jwk.x,y:jwk.y,d:jwk.d}));
  }
  return{privateKey,publicJwk:canonicalPublic(privateKey)};
}
export function coreWorkspacePublicKey({entryFactory=(service,account)=>new Entry(service,account)}={}){
  return workspaceIdentity(entryFactory).publicJwk;
}
async function boundedJson(response){
  const reader=response.body?.getReader();if(!reader)throw Error('context_identity_response_invalid');
  const chunks=[];let size=0;
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.byteLength;if(size>4096)throw Error('context_identity_response_invalid');chunks.push(Buffer.from(next.value));}}
  finally{void reader.cancel().catch(()=>{});reader.releaseLock();}
  try{return JSON.parse(Buffer.concat(chunks,size).toString('utf8'))}catch{throw Error('context_identity_response_invalid')}
}

/** Bind one non-exported-by-the-app P-256 identity to the current Tauri client. */
export async function ensureCoreWorkspaceIdentity({token,fetcher=fetch,entryFactory=(service,account)=>new Entry(service,account),signal}={}){
  const match=typeof token==='string'&&TOKEN.exec(token);if(!match)throw Error('context_pairing_required');
  const clientId=match[1].toLowerCase(),{privateKey,publicJwk}=workspaceIdentity(entryFactory);
  const keyId=createHash('sha256').update(JSON.stringify(publicJwk)).digest('hex');
  const payload=`uptokey-context-identity-v1:${clientId}:${keyId}`;
  const signature=sign('sha256',Buffer.from(payload),{key:privateKey,dsaEncoding:'ieee-p1363'}).toString('base64url');
  const lifetime=AbortSignal.any([AbortSignal.timeout(10000),...(signal?[signal]:[])]);
  const response=await fetcher(CORE+'/local/workspace/session/context/key',{method:'POST',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:JSON.stringify({publicJwk,signature}),credentials:'omit',cache:'no-store',redirect:'error',signal:lifetime});
  const value=await boundedJson(response);
  if(!response.ok){const type=value?.error?.type;throw Error(typeof type==='string'?type:'context_identity_unavailable')}
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.keys(value).sort().join(',')!=='clientId,enrolled,existing,keyId'||
    value.enrolled!==true||value.clientId!==clientId||!UUID.test(value.clientId)||value.keyId!==keyId||typeof value.existing!=='boolean')
    throw Error('context_identity_response_invalid');
  return{clientId,keyId,existing:value.existing,stored:'OS credential vault'};
}
