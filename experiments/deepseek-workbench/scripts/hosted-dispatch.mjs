import {parseHostedRequest} from '../runtime/contracts/hosted-request.js';
import {parseHostedClientResult} from '../runtime/contracts/hosted-result.js';
import {projectHostedReceipt} from '../runtime/contracts/hosted-receipt.js';
import {discoverHostedCatalog,currentHostedAccount} from './hosted-catalog-client.mjs';
import {hostedAccountRequest} from './hosted-transport.mjs';

function identity(value){
  if(typeof value?.accountRef!=='string'||!/^acc_[a-f0-9]{64}$/.test(value.accountRef)||!Number.isSafeInteger(value.revision)||value.revision<0)throw Error('account_request_invalid');
  return {accountRef:value.accountRef,revision:value.revision};
}
function sameAccount(left,right){return left?.accountRef===right?.accountRef&&left?.revision===right?.revision;}

/** A single dispatch; uncertain outcomes are returned, never resubmitted. */
export async function dispatchHosted(value,options){
  const target=identity(value);
  if(Object.keys(value).some(key=>!['accountRef','revision','payload'].includes(key)))throw Error('account_request_invalid');
  const payload=parseHostedRequest(value.payload);
  if(!payload.expectedPriceVersion || Buffer.byteLength(JSON.stringify(payload))>256000)throw Error('hosted_request_invalid');
  const catalog=await discoverHostedCatalog(options);
  if(!sameAccount(catalog,target))throw Error('account_share_conflict');
  if(catalog.state!=='available')throw Error('hosted_execution_disabled');
  const model=catalog.models.find(model=>model.id===payload.model);
  if(!model)throw Error('hosted_model_unavailable');
  if(model.price.version!==payload.expectedPriceVersion)throw Error('hosted_price_changed');
  // Current laboratory scope allows only included/free inference, never a paid fallback.
  if(model.price.inputMicrosPerMillion!==0||model.price.outputMicrosPerMillion!==0)throw Error('hosted_paid_inference_not_authorized');
  if(payload.tools?.length && model.toolCalls!==true)throw Error('hosted_tools_unsupported');
  if(!payload.maxOutputTokens||payload.maxOutputTokens>model.limits.outputTokens)throw Error('hosted_output_limit_exceeded');
  options.signal?.throwIfAborted();
  let result={status:'outcome_unknown',requestId:payload.requestId};
  try{
    const response=await hostedAccountRequest('hosted',{...target,operation:'chat',payload},{...options,chat:true});
    if(sameAccount(response.value,target)){
      const parsed=parseHostedClientResult(response.value,response.status,payload.requestId);
      if(parsed.status!=='completed'||(parsed.priceVersion===payload.expectedPriceVersion&&parsed.chargedMicros===0))result=parsed;
    }
  }catch{ /* No response is not proof that dispatch failed. Keep this request ID for receipt lookup. */ }
  return result;
}

export async function hostedReceipt(value,options){
  const target=identity(value);
  if(Object.keys(value).some(key=>!['accountRef','revision','requestId'].includes(key))||typeof value.requestId!=='string'||!/^[A-Za-z0-9:_-]{1,160}$/.test(value.requestId))throw Error('account_request_invalid');
  const available=await hostedAccountRequest('available',undefined,options);
  if(available.status!==200||!sameAccount(currentHostedAccount(available.value),target))throw Error('account_share_conflict');
  const response=await hostedAccountRequest('hosted',{...target,operation:'receipt',payload:{requestId:value.requestId}},options);
  if(response.status!==200||!sameAccount(response.value,target))throw Error('hosted_receipt_unavailable');
  const receipt=projectHostedReceipt(response.value);
  if(receipt.requestId!==value.requestId)throw Error('hosted_receipt_invalid');
  return receipt;
}
