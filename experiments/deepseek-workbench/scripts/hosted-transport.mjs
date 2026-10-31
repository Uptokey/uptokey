// Host-only transport: the paired token never crosses into the container.
export async function hostedAccountRequest(path, body, {token,fetcher=fetch,signal,chat=false}={}) {
  if(!['available','hosted','unlink'].includes(path) || (path==='available' && body!==undefined) || (path==='hosted' && !body))throw Error('account_action_invalid');
  if(path==='unlink'&&(!body||Object.keys(body).join(',')!=='expectedRevision'||!Number.isSafeInteger(body.expectedRevision)||body.expectedRevision<0))throw Error('account_action_invalid');
  if(typeof token!=='string'||!/^utk_local_[0-9a-f-]{36}\.[A-Za-z0-9_-]{32}$/i.test(token))throw Error('account_pairing_required');
  const deadline=AbortSignal.timeout(chat?140000:15000);
  const activeSignal=signal?AbortSignal.any([signal,deadline]):deadline;
  activeSignal.throwIfAborted();
  const response=await fetcher('http://127.0.0.1:21435/local/account/'+path,{
    method:body?'POST':'GET',headers:{authorization:'Bearer '+token,...(body?{'content-type':'application/json'}:{})},
    ...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:activeSignal,
  });
  if(!/^application\/json(?:\s*;.*)?$/i.test(response.headers.get('content-type')??'')){
    await response.body?.cancel();throw Error('account_response_invalid');
  }
  const reader=response.body?.getReader();if(!reader)throw Error('account_response_invalid');
  let size=0;const chunks=[];
  try{for(;;){const next=await reader.read();if(next.done)break;size+=next.value.length;
    if(size>(chat?24100000:262144))throw Error('account_response_invalid');chunks.push(Buffer.from(next.value));
  }}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  let value;try{value=JSON.parse(Buffer.concat(chunks).toString('utf8'));}catch{throw Error('account_response_invalid');}
  return {status:response.status,value};
}
