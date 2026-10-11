import type {Context,Hono} from 'hono';
import {readBoundedJson} from '@uptokey/sync-contract/limits';
import type {ConnectionProfileService,StoredProfile} from './connection-profiles.ts';
import type {ProxyConfig} from './types.ts';

const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const TARGETS={deepseek:{url:'https://api.deepseek.com/user/balance',origin:'https://api.deepseek.com',paths:['','/v1','/chat/completions','/v1/chat/completions']},openrouter:{url:'https://openrouter.ai/api/v1/key',origin:'https://openrouter.ai',paths:['/api/v1','/api/v1/chat/completions']}} as const;
type SupportedProvider=keyof typeof TARGETS;
type CreditErrorCode='provider_credit_unauthorized'|'provider_credit_invalid_request'|'provider_credit_unavailable'|'provider_credit_unsupported'|'provider_credit_identity_changed'|'provider_credit_key_required'|'provider_credit_key_rejected'|'provider_credit_rate_limited'|'provider_credit_timeout'|'provider_credit_upstream_unavailable'|'provider_credit_response_invalid';
class CreditError extends Error {readonly code:CreditErrorCode;readonly status:400|401|403|404|409|429|502|504;constructor(code:CreditErrorCode,status:400|401|403|404|409|429|502|504=409){super(code);this.code=code;this.status=status;}}
const fail=(code:CreditErrorCode,status?:ConstructorParameters<typeof CreditError>[1]):never=>{throw new CreditError(code,status);};
const object=(value:unknown):Record<string,unknown>=>value!==null&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:fail('provider_credit_response_invalid',502);
const numeric=(value:unknown,nullable=false):number|null=>{
 if(nullable&&value===null)return null;
 const n=typeof value==='number'?value:typeof value==='string'&&/^(?:0|[1-9]\d{0,12})(?:\.\d{1,12})?$/.test(value)?Number(value):NaN;
 return Number.isFinite(n)&&n>=0&&n<=Number.MAX_SAFE_INTEGER?n:fail('provider_credit_response_invalid',502);
};
function officialEndpoint(provider:SupportedProvider,value:string|null|undefined){
 if(!value)return true;
 try{const url=new URL(value),target=TARGETS[provider];return url.origin===target.origin&&!url.username&&!url.password&&!url.search&&!url.hash&&target.paths.some(path=>path===url.pathname.replace(/\/$/,''));}catch{return false;}
}
export interface ProviderCreditView {
 connectionId:string;providerId:SupportedProvider;connectionRevision:number;source:'provider_balance'|'api_key_allowance';measuredAt:string;
 balances:Array<{currency:'USD'|'CNY';available:number|null;granted?:number;toppedUp?:number;limit?:number|null;used?:number}>;
}
export function projectProviderCredit(provider:SupportedProvider,raw:unknown,profile:StoredProfile,measuredAt:string):ProviderCreditView{
 const root=object(raw);
 if(provider==='deepseek'){
  if(typeof root.is_available!=='boolean'||!Array.isArray(root.balance_infos)||root.balance_infos.length<1||root.balance_infos.length>2)return fail('provider_credit_response_invalid',502);
  const seen=new Set<string>();const balances=root.balance_infos.map(value=>{const b=object(value);if(b.currency!=='CNY'&&b.currency!=='USD'||seen.has(b.currency as string))return fail('provider_credit_response_invalid',502);seen.add(b.currency as string);return {currency:b.currency as 'CNY'|'USD',available:numeric(b.total_balance),granted:numeric(b.granted_balance)!,toppedUp:numeric(b.topped_up_balance)!};});
  return {connectionId:profile.id,providerId:provider,connectionRevision:profile.revision,source:'provider_balance',measuredAt,balances};
 }
 const data=object(root.data);
 if(data.is_management_key===true)return fail('provider_credit_key_rejected',403);
 return {connectionId:profile.id,providerId:provider,connectionRevision:profile.revision,source:'api_key_allowance',measuredAt,balances:[{currency:'USD',available:numeric(data.limit_remaining,true),limit:numeric(data.limit,true),used:numeric(data.usage)!}]};
}
export interface ProviderCreditDeps {
 profiles:Pick<ConnectionProfileService,'get'|'readCredential'>;getConfig:()=>ProxyConfig;
 authority:(c:Context)=>Promise<string|null>;fetchImpl?:typeof fetch;now?:()=>number;
 checkRate?:(key:string,limit:number,windowMs:number)=>{ok:boolean;retryAfter:number};
}
/** Explicit account-level read. Never inference, provider-key export or a universal balance estimate. */
export function registerProviderCreditRoutes(app:Hono,deps:ProviderCreditDeps):void{
 app.get('/local/provider/credits',async c=>{
  let response:Response|undefined;
  try{
   const owner=await deps.authority(c);if(!owner)return fail('provider_credit_unauthorized',401);
   const query=c.req.queries(),id=c.req.query('connectionId');
   if(!id||!UUID.test(id)||Object.keys(query).length!==1||query.connectionId?.length!==1)return fail('provider_credit_invalid_request',400);
   const decision=deps.checkRate?.('localhost-provider-credit',20,60_000);if(decision&&!decision.ok){c.header('Retry-After',String(decision.retryAfter));return fail('provider_credit_rate_limited',429);}
   const profile=await deps.profiles.get(id);if(!profile)return fail('provider_credit_unavailable',404);
   if(!Object.hasOwn(TARGETS,profile.providerId))return fail('provider_credit_unsupported',409);
   const provider=profile.providerId as SupportedProvider,target=TARGETS[provider];
   const assertCurrent=async()=>{
    if(c.req.raw.signal.aborted||await deps.authority(c)!==owner)return fail('provider_credit_identity_changed',403);
    const current=await deps.profiles.get(id),config=deps.getConfig().providers[provider];
    if(!current||current.revision!==profile.revision||current.providerId!==provider||current.credentialRef!==profile.credentialRef||!current.enabled||!config?.enabled||!['byok','custom'].includes(current.accessMode)||!officialEndpoint(provider,current.endpointUrl)||!officialEndpoint(provider,config.endpointUrl))return fail('provider_credit_identity_changed',403);
    if(c.req.raw.signal.aborted||await deps.authority(c)!==owner)return fail('provider_credit_identity_changed',403);
   };
   await assertCurrent();const key=await deps.profiles.readCredential(profile);await assertCurrent();
   if(!key||key.length>4096||/[\r\n\0]/.test(key))return fail('provider_credit_key_required',409);
   const started=Date.now(),signal=AbortSignal.any([c.req.raw.signal,AbortSignal.timeout(8_000)]);
   try{response=await(deps.fetchImpl??fetch)(target.url,{method:'GET',headers:{Authorization:`Bearer ${key}`,Accept:'application/json'},redirect:'error',credentials:'omit',signal});}
   catch{return fail(c.req.raw.signal.aborted?'provider_credit_identity_changed':signal.aborted?'provider_credit_timeout':'provider_credit_upstream_unavailable',c.req.raw.signal.aborted?403:signal.aborted?504:502);}
   await assertCurrent();
   if(response.status===401||response.status===403)return fail('provider_credit_key_rejected',403);
   if(response.status===429)return fail('provider_credit_rate_limited',429);
   if(!response.ok)return fail('provider_credit_upstream_unavailable',502);
   // The shared bounded parser reads headers/body only; Response has the same
   // stream interface. Both headers and body have a single finite deadline.
   const parsed=await readBoundedJson(response as unknown as Request,32_768,Math.max(1,8_000-(Date.now()-started)));
   await assertCurrent();if(!parsed.ok)return fail(signal.aborted?'provider_credit_timeout':'provider_credit_response_invalid',signal.aborted?504:502);
   return c.json(projectProviderCredit(provider,parsed.value,profile,new Date(deps.now?.()??Date.now()).toISOString()));
  }catch(error){await response?.body?.cancel().catch(()=>undefined);const safe=error instanceof CreditError?error:new CreditError('provider_credit_upstream_unavailable',502);return c.json({error:{type:safe.code}},safe.status);}
 });
}
