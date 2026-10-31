// Only these exact responses from the local bridge prove a pre-dispatch refusal.
const REJECTIONS=new Set(['account_share_conflict','account_reauthentication_required','account_rate_limited','hosted_execution_disabled','hosted_model_unavailable','hosted_price_changed','hosted_paid_inference_not_authorized','hosted_tools_unsupported','hosted_output_limit_exceeded','hosted_request_invalid','account_request_invalid','hosted_request_too_large','hosted_receipt_unavailable']);
export class HostedRefusal extends Error {
  constructor(code){super(REJECTIONS.has(code)?code:'hosted_request_rejected');this.name='HostedRefusal';}
}
export async function readHostedBridgeResponse(response,chat=false){
  if(!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type')??'')){
    await response.body?.cancel();throw Error('hosted_response_invalid');
  }
  const reader=response.body?.getReader();if(!reader)throw Error('hosted_response_invalid');
  const maximum=response.ok?(chat?24100000:262144):16384;
  let size=0;const parts=[];
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;if(size>maximum)throw Error('hosted_response_invalid');parts.push(Buffer.from(next.value));}}
  finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let value;try{value=JSON.parse(Buffer.concat(parts).toString('utf8'));}catch{throw Error('hosted_response_invalid');}
  if(response.status===409&&REJECTIONS.has(value?.error?.type))throw new HostedRefusal(value.error.type);
  if(!response.ok)throw Error('hosted_unavailable');
  return value;
}
