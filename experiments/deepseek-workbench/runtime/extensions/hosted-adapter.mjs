import {randomUUID} from 'node:crypto';
import {parseHostedRequest} from '../contracts/hosted-request.js';
import {parseHostedClientResult,HOSTED_CLIENT_ERRORS} from '../contracts/hosted-result.js';
import {projectHostedCatalog} from '../contracts/hosted-catalog.js';
import {HostedRefusal} from './hosted-response.mjs';
import {parseHostedProviderReplay} from '../contracts/hosted-provider-replay.js';
export const HOSTED_PROVIDER='uptokey-hosted';

export function hostedMessages(options){
  const messages=[];
  if(options.system)messages.push({role:'system',content:options.system});
  for(const message of options.messages){
    const role=message.role==='developer'?'system':message.role;
    if(!['system','user','assistant','tool'].includes(role)||!Array.isArray(message.content))throw Error('hosted_content_unsupported');
    const texts=[],calls=[];
    for(const block of message.content){
      if(block.type==='text'&&typeof block.text==='string')texts.push(block.text);
      else if(block.type==='tool-call'&&role==='assistant')calls.push({id:block.id,type:'function',function:{name:block.name,arguments:block.arguments}});
      else if(block.type==='reasoning'&&role==='assistant')continue;
      else throw Error('hosted_content_unsupported');
    }
    const content=texts.join('\n');
    const replay=role==='assistant'&&message.source?.provider===HOSTED_PROVIDER&&message.source?.model===options.model
      ?parseHostedProviderReplay(message.source.replayState?.response?.providerReplay,content,calls.length?calls.map(call=>({id:call.id,name:call.function.name,arguments:call.function.arguments})):undefined):undefined;
    if(replay===null)throw Error('hosted_replay_invalid');
    messages.push({role,content,...(calls.length?{tool_calls:calls}:{}),...(role==='tool'?{tool_call_id:message.toolCallId}:{}),...(replay?{providerReplay:replay}:{})});
  }
  return messages;
}
export function* hostedChunks(result){
  let index=0;
  if(result.content){
    yield {type:'block-start',index,blockType:'text'};
    yield {type:'text-delta',index,text:result.content};
    yield {type:'block-end',index,block:{type:'text',text:result.content}};index++;
  }
  for(const call of result.toolCalls??[]){
    yield {type:'block-start',index,blockType:'tool-call'};
    yield {type:'tool-call-delta',index,id:call.id,name:call.name,argumentsDelta:call.arguments};
    yield {type:'block-end',index,block:{type:'tool-call',...call}};index++;
  }
  const cached=result.usage.cachedInputTokens??0;
  yield {type:'usage',usage:{inputTokens:result.usage.inputTokens-cached,outputTokens:result.usage.outputTokens,totalTokens:result.usage.inputTokens+result.usage.outputTokens,...(result.usage.cachedInputTokens!==undefined?{cacheReadTokens:cached}:{})}};
  yield {type:'finish',reason:{kind:result.finishReason==='tool_calls'?'tool-calls':result.finishReason==='length'?'max-tokens':'stop'},replayState:{response:{requestId:result.requestId,chargedMicros:result.chargedMicros,currency:result.currency,priceVersion:result.priceVersion,...(result.providerReplay?{providerReplay:result.providerReplay}:{})}}};
}

/** Uses the existing LLM registry; no second selector, transcript or tool executor. */
export function createHostedAdapter({LlmAdapter,LlmError,retryPolicy,request}){
  // The registry lists models and then resolves each one's display metadata.
  // Those resolutions are not inference admission and must not re-fetch the
  // account catalog once per row. Keep only public metadata from that list.
  let listedMetadata=new Map(),listedCatalog;
  function fail(code,requestId){return Object.assign(new LlmError(code,code.toUpperCase()),requestId?{requestId}:{});}
  function metadata(model){return {provider:HOSTED_PROVIDER,id:model.id,name:model.id,inputModalities:['text'],context:{contextWindow:model.limits.contextTokens},defaultMaxTokens:Math.min(model.limits.outputTokens,4096)};}
  async function catalog(signal){
    const value=await request('/hosted/catalog',undefined,signal);
    if(value?.state==='signed_out')return {models:[]};
    if(!['available','disabled'].includes(value?.state)||typeof value.accountRef!=='string'||!/^acc_[a-f0-9]{64}$/.test(value.accountRef)||!Number.isSafeInteger(value.revision)||value.revision<0)throw fail('hosted_catalog_invalid');
    const projected=projectHostedCatalog(value);
    // This registry serves the Harness agent, whose original loop declares
    // tools. Text-only routes remain in the canonical dashboard/TUI catalog.
    return {...value,...projected,models:value.state==='available'?projected.models.filter(m=>m.price.inputMicrosPerMillion===0&&m.price.outputMicrosPerMillion===0&&m.toolCalls===true):[]};
  }
  return new class extends LlmAdapter {
    providerInfo(){return {id:HOSTED_PROVIDER,name:'Uptokey hosted'};}
    providerRetryPolicy(){return retryPolicy;}
    async listModels(){
      try{const snapshot=await catalog(),models=snapshot.models.map(metadata);listedMetadata=new Map(models.map(model=>[model.id,model]));listedCatalog=snapshot.state==='available'?snapshot:undefined;return models;}
      catch(error){listedMetadata.clear();listedCatalog=undefined;throw error;}
    }
    async resolveModel(provider,id,signal){
      signal?.throwIfAborted();
      if(provider!==HOSTED_PROVIDER)throw fail('hosted_model_unavailable');
      const listed=listedMetadata.get(id);
      if(listed)return structuredClone(listed);
      const model=(await catalog(signal)).models.find(model=>model.id===id);
      if(!model)throw fail('hosted_model_unavailable');
      return metadata(model);
    }
    async prepareCall(provider,id,signal){
      signal?.throwIfAborted();
      if(provider!==HOSTED_PROVIDER)throw fail('hosted_model_unavailable');
      // Preparation uses the public listing only. The host's dispatchHosted
      // still reads fresh account/catalog/price/capability before its single
      // inference dispatch; a cached listing can never authorize a request.
      const snapshot=listedCatalog?.models.some(model=>model.id===id)?structuredClone(listedCatalog):await catalog(signal),model=snapshot.models.find(m=>m.id===id);
      if(!model)throw fail('hosted_model_unavailable');
      const requestId='harness_'+randomUUID();
      let dispatched=false;
      return {model:metadata(model),stream:async function*(options){
        if(dispatched)throw fail('hosted_request_already_dispatched',requestId);
        if(options.provider!==provider||options.model!==id)throw fail('hosted_model_changed');
        if(options.reasoningEffort!==undefined||options.temperature!==undefined||options.stop?.length||options.tools?.some(t=>t.deferLoading))throw fail('hosted_option_unsupported');
        if(options.tools?.length&&model.toolCalls!==true)throw fail('hosted_tools_unsupported');
        const payload=parseHostedRequest({requestId,model:id,expectedPriceVersion:model.price.version,maxOutputTokens:options.maxTokens??Math.min(model.limits.outputTokens,4096),messages:hostedMessages(options),...(options.tools?.length?{tools:options.tools.map(tool=>({type:'function',function:{name:tool.name,description:tool.description,parameters:tool.parameters}}))}:{})});
        options.signal?.throwIfAborted();dispatched=true;
        let raw;
        try{raw=await request('/hosted/chat',{accountRef:snapshot.accountRef,revision:snapshot.revision,payload},options.signal);}
        catch(error){throw fail(error instanceof HostedRefusal?error.message:'hosted_outcome_unknown',requestId);}
        const result=parseHostedClientResult(raw,raw?.status==='completed'?200:raw?.status==='already_submitted'?409:raw?.status==='rejected'&&Object.hasOwn(HOSTED_CLIENT_ERRORS,raw.error)?HOSTED_CLIENT_ERRORS[raw.error]:202,requestId);
        if(result.status!=='completed')throw fail(result.status==='rejected'?result.error:'hosted_outcome_unknown',requestId);
        if(result.priceVersion!==model.price.version||result.chargedMicros!==0)throw fail('hosted_outcome_unknown',requestId);
        options.signal?.throwIfAborted();
        yield* hostedChunks(result);
      }};
    }
    async *stream(options){yield* (await this.prepareCall(options.provider,options.model,options.signal)).stream(options);}
  }();
}
