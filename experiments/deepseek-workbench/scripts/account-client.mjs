import {readAccountConnectionResponse,readAccountLoginResponse,readAccountRetryAfter} from '../../../proxy/contratos/account-native.js';
import {readAccountPublicSession} from '../runtime/account/protocol.mjs';
const ORIGIN='https://app.uptokey.com';
export function accountState(value){
 const session=readAccountPublicSession(value);
 return {state:session.state,authenticated:session.authenticated,configured:session.configured,loginAvailable:session.loginAvailable};
}
export function accountLogin(value,now=Date.now()){
 const answer=readAccountLoginResponse(value,{now,expectedOrigin:ORIGIN});
 if('session' in answer)return accountState(answer.session);
 return {state:'connecting',loginUrl:answer.loginUrl,expiresAt:answer.expiresAt,confirmationCode:answer.userCode};
}
export function accountConnection(value,now=Date.now()){
 return readAccountConnectionResponse(value,{now,expectedOrigin:ORIGIN});
}
export function accountRetryAfter(value,now=Date.now()){
 return readAccountRetryAfter(value,now);
}
export async function requestAccount(action,{token,fetcher=fetch}={}){
 if(!['status','login','connect-hosted'].includes(action))throw Error('account_action_invalid');
 if(typeof token!=='string'||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token))throw Error('account_pairing_required');
 const post=action!=='status';
 let response;
 try{response=await fetcher('http://127.0.0.1:21435/local/account/'+(post?'login':'status'),{method:post?'POST':'GET',headers:{authorization:'Bearer '+token,...(post?{'content-type':'application/json'}:{})},...(post?{body:action==='connect-hosted'?JSON.stringify({purpose:'hosted-admission'}):'{}'}:{}),redirect:'error',signal:AbortSignal.timeout(12000)});}
 catch(error){
  if(!post&&['TypeError','TimeoutError'].includes(error?.name))return {state:'retrying',authenticated:false,retryAfterMs:4000};
  throw Error('account_unavailable');
 }
 if(!post&&[429,502,503,504].includes(response.status)){
  const retryAfterMs=accountRetryAfter(response.headers.get('retry-after'));
  await response.body?.cancel();
  return {state:'retrying',authenticated:false,retryAfterMs};
 }
 if(!response.ok){await response.body?.cancel();throw Error(response.status===429?'account_rate_limited':'account_unavailable')}
 const reader=response.body?.getReader();if(!reader)throw Error('account_response_invalid');
 let size=0;const chunks=[];
 try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>16384)throw Error('account_response_invalid');chunks.push(Buffer.from(next.value))}}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock()}
 let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'))}catch{throw Error('account_response_invalid')}
 return action==='connect-hosted'?accountConnection(value):action==='login'?accountLogin(value):accountState(value);
}
