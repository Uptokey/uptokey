const safeCount=(n,max)=>typeof n==="number"&&Number.isSafeInteger(n)&&n>=0&&n<=max;
export const HOSTED_CLIENT_ERRORS=Object.freeze({account_chat_scope_changed:409,hosted_price_changed:409,account_not_configured:503,account_reauthentication_required:401,account_origin_invalid:403,
  hosted_not_configured:503,hosted_execution_disabled:503,hosted_authorization_required:401,hosted_json_required:415,
  hosted_request_invalid:400,hosted_request_too_large:413,hosted_context_limit_exceeded:400,hosted_output_limit_exceeded:400,
  hosted_unauthenticated:401,hosted_model_unavailable:503,hosted_credit_insufficient:402,hosted_operating_budget_exhausted:503,
  hosted_ledger_idempotency_conflict:409,hosted_busy:429,hosted_request_cancelled:408,hosted_admission_invalid_device:400,
  hosted_device_busy:429,hosted_sybil_limit_exceeded:429,hosted_daily_quota_exceeded:429,hosted_sponsorship_inactive:403,
  hosted_sponsorship_daily_exhausted:429,hosted_sponsorship_capacity_exhausted:503,hosted_sponsorship_policy_conflict:409,
  hosted_sponsorship_idempotency_conflict:409,hosted_provider_request_failed:503,hosted_tools_unsupported:400});

const TOOL_NAME=/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/,CALL_ID=/^[A-Za-z0-9_.:-]{1,200}$/;
/** Tool calls proposed by the model; undefined when absent, null when malformed. */
export function parseHostedToolCalls(value) {
  if(value===undefined)return undefined;
  if(!Array.isArray(value)||value.length<1||value.length>8)return null;
  const ids=new Set();
  const calls=[];
  for(const call of value){
    if(!call||typeof call!=="object"||Array.isArray(call)||Object.keys(call).some(key=>!["id","name","arguments"].includes(key))||
      typeof call.id!=="string"||!CALL_ID.test(call.id)||ids.has(call.id)||typeof call.name!=="string"||!TOOL_NAME.test(call.name)||
      typeof call.arguments!=="string"||call.arguments.length>65_536)return null;
    ids.add(call.id);calls.push({id:call.id,name:call.name,arguments:call.arguments});
  }
  return calls;
}

/** Only confirmed, bounded responses may become completed results or known rejections. */
export function parseHostedClientResult(value,httpStatus,requestId) {
  const unknown={status:"outcome_unknown",requestId};
  if(typeof value?.error==="string"&&Object.hasOwn(HOSTED_CLIENT_ERRORS,value.error)&&HOSTED_CLIENT_ERRORS[value.error]===httpStatus)
    return {status:"rejected",requestId,error:value.error};
  if(value?.requestId!==requestId)return unknown;
  if(httpStatus===202&&["outcome_unknown","reconciliation_required"].includes(value.status))return {status:value.status,requestId};
  if(httpStatus===409&&value.status==="already_submitted"&&["reserved","settled"].includes(value.settlement))return {status:value.status,requestId,settlement:value.settlement};
  if(httpStatus!==200||value.status!=="completed"||typeof value.content!=="string"||new TextEncoder().encode(value.content).byteLength>4_000_000||
    value.currency!=="USD"||!safeCount(value.chargedMicros,1e12)||typeof value.priceVersion!=="string"||!/^[A-Za-z0-9._-]{1,80}$/.test(value.priceVersion)||
    !safeCount(value.usage?.inputTokens,1e9)||!safeCount(value.usage?.outputTokens,1e9)||
    (value.usage.cachedInputTokens!==undefined&&!safeCount(value.usage.cachedInputTokens,value.usage.inputTokens))||
    (value.finishReason!==undefined&&!["stop","length","tool_calls"].includes(value.finishReason)))return unknown;
  const toolCalls=parseHostedToolCalls(value.toolCalls);
  if(toolCalls===null||(value.finishReason==="tool_calls")!==(toolCalls!==undefined))return unknown;
  return {status:"completed",requestId,content:value.content,currency:"USD",chargedMicros:value.chargedMicros,priceVersion:value.priceVersion,
    usage:{inputTokens:value.usage.inputTokens,outputTokens:value.usage.outputTokens,...(value.usage.cachedInputTokens!==undefined?{cachedInputTokens:value.usage.cachedInputTokens}:{})},
    ...(value.finishReason!==undefined?{finishReason:value.finishReason}:{}),...(toolCalls?{toolCalls}:{})};
}
