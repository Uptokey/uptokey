import {LlmAdapter,LlmError,resolveRetryPolicy,attributionHeaders} from '@deepseek-ai/dsh-llm';
import {createHostedAdapter,HOSTED_PROVIDER} from './hosted-adapter.mjs';
import {readHostedBridgeResponse} from './hosted-response.mjs';
export const name='uptokey-hosted';
export const inject=['llm','credentials'];
export function apply(ctx){
  const request=async(path,body,signal)=>{
    const credential=await ctx.credentials.resolve('UPTOKEY_LOCAL_API_KEY');
    if(!credential?.value)throw new LlmError('Connect Uptokey first','MISSING_CREDENTIAL');
    const deadline=AbortSignal.timeout(body?190000:50000);
    const activeSignal=signal?AbortSignal.any([signal,deadline]):deadline;
    const response=await fetch('http://127.0.0.1:43194'+path,{method:body?'POST':'GET',headers:{...attributionHeaders(),authorization:'Bearer '+credential.value,...(body?{'content-type':'application/json'}:{})},...(body?{body:JSON.stringify(body)}:{}),redirect:'error',signal:activeSignal});
    return readHostedBridgeResponse(response,body!==undefined);
  };
  const adapter=createHostedAdapter({LlmAdapter,LlmError,request,retryPolicy:resolveRetryPolicy({mode:'normal',maxRetries:0},'uptokey-hosted')});
  ctx.llm.registerAdapter([HOSTED_PROVIDER],adapter);
}
