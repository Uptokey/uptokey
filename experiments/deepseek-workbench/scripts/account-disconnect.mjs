import {hostedAccountRequest} from './hosted-transport.mjs';
import {accountState} from './account-client.mjs';
// Detach this client using CAS. Logout would revoke an owned grant shared elsewhere.
export async function disconnectAccount(options){
  const current=await hostedAccountRequest('available',undefined,options);
  if(current.status!==200||!Number.isSafeInteger(current.value?.revision)||current.value.revision<0)throw Error('account_unavailable');
  const expectedRevision=current.value.revision;
  const result=await hostedAccountRequest('unlink',{expectedRevision},options);
  if(result.status!==200)throw Error(result.status===409?'account_share_conflict':'account_unavailable');
  if(!Number.isSafeInteger(result.value?.revision)||result.value.revision<=expectedRevision)throw Error('account_response_invalid');
  const state=accountState(result.value.session);
  if(state.state!=='signed_out')throw Error('account_response_invalid');
  return state;
}
