import {ACCOUNT_ID,ACCOUNT_REF,readAccountAdoptInput,readAccountUnlinkInput,readAccountControlRequest,readAccountPublicSession,readAccountPublicUsage,readAccountAvailable,readAccountAdoption,readAccountShareChallenge,readAccountShareRequests,readAccountShareApproval,projectPersonalSubscription,projectSubscriptionOffer,projectSubscriptionCheckout,projectSubscriptionPortal} from '../runtime/account/protocol.mjs';
import {accountConnection} from './account-client.mjs';
const reads=new Set(['status','usage','available','requests']);
const subscriptionErrors=new Set(['subscription_not_configured','subscription_unavailable','subscription_already_active','subscription_checkout_pending','subscription_checkout_canceled','subscription_checkout_disabled','subscription_not_found','subscription_input_invalid','subscription_rate_limited']);
const paths=new Set([...reads,'login','connection','logout','adopt','unlink','request','approve','consume','control']);
const object=value=>value!==null&&typeof value==='object'&&!Array.isArray(value);
export function accountRequestTimeoutMs(path,input){return path==='control'&&['subscription.checkout','subscription.portal'].includes(input?.operation)?35_000:15_000;}
export function accountInput(path,input){
 if(!paths.has(path)||!object(input)||Buffer.byteLength(JSON.stringify(input))>16384)throw Error('account_request_invalid');
 if(path==='adopt')return readAccountAdoptInput(input);
 if(path==='unlink')return readAccountUnlinkInput(input);
 if(path==='control'){
  const value=readAccountControlRequest(input);
  if(!value.operation.startsWith('subscription.'))throw Error('account_request_invalid');
  return value;
 }
 if(path==='approve'){
  if(Object.keys(input).sort().join(',')!=='accountRef,id,userCode'||!ACCOUNT_ID.test(input.id)||!ACCOUNT_REF.test(input.accountRef)||typeof input.userCode!=='string'||!/^[A-F0-9]{8}$/.test(input.userCode))throw Error('account_request_invalid');
  return {id:input.id,userCode:input.userCode,accountRef:input.accountRef};
 }
 if(path==='consume'){
  if(Object.keys(input).join(',')!=='id'||!ACCOUNT_ID.test(input.id))throw Error('account_request_invalid');
  return {id:input.id};
 }
 if(Object.keys(input).length)throw Error('account_request_invalid');return {};
}
function publicBody(path,value){
 if(path==='connection')return accountConnection(value);
 if(path==='status'||path==='logout')return readAccountPublicSession(value);
 if(path==='usage')return readAccountPublicUsage(value);
 if(path==='available')return readAccountAvailable(value);
 if(path==='adopt'||path==='unlink')return readAccountAdoption(value);
 if(path==='request')return readAccountShareChallenge(value);
 if(path==='requests')return readAccountShareRequests(value);
 if(path==='approve'||path==='consume')return readAccountShareApproval(value);
 if(path==='login'){
  if(value.session)return {session:readAccountPublicSession(value.session)};
  const url=new URL(value.loginUrl);
  if(url.origin!=='https://app.uptokey.com'||url.username||url.password||url.hash||url.pathname!=='/api/account/native/authorize'||[...url.searchParams.keys()].join(',')!=='id'||!ACCOUNT_ID.test(url.searchParams.get('id')??'')||typeof value.userCode!=='string'||!/^[A-F0-9]{8}$/.test(value.userCode)||!Number.isSafeInteger(value.expiresAt)||value.expiresAt<=Date.now()||value.expiresAt>Date.now()+360000)throw Error('account_response_invalid');
  return {loginUrl:url.href,userCode:value.userCode,expiresAt:value.expiresAt};
 }
 throw Error('account_response_invalid');
}
export async function requestCanonicalAccount(path,input,{token,fetcher=fetch}={}){
 const body=accountInput(path,input);
 if(typeof token!=='string'||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token))throw Error('account_pairing_required');
 const response=await fetcher('http://127.0.0.1:21435/local/account/'+(path==='connection'?'login':path),{method:reads.has(path)?'GET':'POST',headers:{authorization:'Bearer '+token,...(!reads.has(path)?{'content-type':'application/json'}:{})},...(!reads.has(path)?{body:JSON.stringify(path==='connection'?{purpose:'hosted-admission'}:body)}:{}),credentials:'omit',cache:'no-store',redirect:'error',signal:AbortSignal.timeout(accountRequestTimeoutMs(path,body))});
 const limit=['available','requests','control'].includes(path)?256*1024:16384;
 if(!response.body)throw Error('account_response_invalid');
 const reader=response.body.getReader();let bytes=0;const chunks=[];
 try{for(;;){const next=await reader.read();if(next.done)break;bytes+=next.value.length;if(bytes>limit)throw Error('account_response_invalid');chunks.push(Buffer.from(next.value));}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
 const value=JSON.parse(Buffer.concat(chunks).toString('utf8'));
 // The local core writes control.body at control.status. Reconstruct the
 // canonical UI control envelope at this transport boundary exactly once.
 // Account authority failures keep their original outer HTTP status below.
 if(path==='control'){
  if(!object(value))throw Error('account_response_invalid');
  const code=typeof value.error==='string'?value.error:value.error?.type;
  if(subscriptionErrors.has(code))return {status:200,body:{status:response.status,body:{error:code}}};
  if(response.ok){
   const project={'subscription.offer':projectSubscriptionOffer,'subscription.status':projectPersonalSubscription,'subscription.checkout':projectSubscriptionCheckout,'subscription.portal':projectSubscriptionPortal}[body.operation];
   if(!project||response.status!==200)throw Error('account_response_invalid');
   return {status:200,body:{status:response.status,body:project(value)}};
  }
 }
 if(!response.ok){const code=typeof value.error==='string'?value.error:value.error?.type;return {status:response.status,body:{error:typeof code==='string'&&/^account_[a-z_]{1,80}$/.test(code)?code:'account_unavailable'}};}
 return {status:response.status,body:publicBody(path,value)};
}
