import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {createHash} from 'node:crypto';
import type {SecretStore} from './secret-store.ts';
import type {ConnectionProfileService,StoredProfile} from './connection-profiles.ts';
import type {WorkspaceStore} from './workspace/store.ts';
import {VoiceSessionSupervisor,VoiceSessionError,type VoiceTransport,type VoiceAuthority} from './voice-session-service.ts';
import {createOpenAIRealtimeFactory,REALTIME_VOICES,type OpenAIRealtimeOptions} from './voice-realtime-transport.ts';
import {parseVoiceBudgetLimits,realtimeTariff,realtimeReservation,realtimeUsageCost,type VoiceBudgetLimits} from './voice-budget.ts';
import type {ProxyConfig} from './types.ts';
import type {WorkspacePolicyService} from './workspace/governance-service.ts';

const PROFILE_KEY='voice:realtime:profile:v1';
type Selection={revision:number;connectionId:string;connectionRevision:number;model:string;budgetLimits?:VoiceBudgetLimits};
// The OpenAI account, whether its connection points at the API base or at one of its endpoints (/v1/chat/completions).
const eligible=(p:StoredProfile)=>p.enabled&&['byok','custom'].includes(p.accessMode)&&/^https:\/\/api\.openai\.com\/v1(?:\/(?:chat\/completions|responses))?\/?$/.test(p.endpointUrl??'');
/** One reference into the existing connection vault; no second key or content store. */
export function createManagedVoice(store:WorkspaceStore,secrets:SecretStore,profiles:()=>ConnectionProfileService|undefined,options:{
 config?:()=>ProxyConfig;governance?:()=>WorkspacePolicyService|undefined;assertAuthority?:(authority:VoiceAuthority)=>Promise<void>;connect?:OpenAIRealtimeOptions['connect'];
}={}){
 let writes:Promise<unknown>=Promise.resolve();
 async function selection():Promise<Selection|undefined>{
  const raw=await secrets.get(PROFILE_KEY);if(!raw)return undefined;
  const value:unknown=JSON.parse(raw);
  if(!isDataRecord(value)||Object.keys(value).some(key=>!['connectionId','connectionRevision','model','revision','budgetLimits'].includes(key))||!Number.isSafeInteger(value.revision)||Number(value.revision)<1||!Number.isSafeInteger(value.connectionRevision)||typeof value.connectionId!=='string'||typeof value.model!=='string'||!modelValid(value.model))throw new VoiceSessionError('voice_profile_invalid');
  if(value.budgetLimits!==undefined)parseVoiceBudgetLimits(value.budgetLimits);
  return value as Selection;
 }
 async function resolve(){const selected=await selection(),service=profiles(),connection=selected?await service?.get(selected.connectionId):undefined;
  return {selected,service,connection,configured:Boolean(selected&&service&&connection&&eligible(connection)&&connection.revision===selected.connectionRevision&&await service.credentialPresent(connection))};}
 async function info(){const state=await resolve();const required=Boolean(state.connection?.commercialAccountId);let budgetReason:string|undefined,reservationMicros:string|undefined;
  if(required)try{
   if(!state.selected?.budgetLimits)throw new VoiceSessionError('voice_budget_limits_required');
   if(!options.config||!options.governance?.()||!options.assertAuthority)throw new VoiceSessionError('account_funding_unavailable');
   reservationMicros=realtimeReservation(realtimeTariff(options.config(),state.connection!.providerId,state.selected.model),state.selected.budgetLimits).costMicros;
   const funding=await options.governance()!.getAccountFunding(state.connection!.providerId,state.connection!.commercialAccountId!);
   if(funding.status!=='current')throw new VoiceSessionError(`account_funding_${funding.status}`);
  }catch(error){budgetReason=error instanceof Error?error.message:'budget_cost_unknown';}
  return {model:state.selected?.model??'',connectionId:state.selected?.connectionId,profileRevision:state.selected?.revision??0,provider:'openai' as const,configured:state.configured,voices:REALTIME_VOICES,
   budgetRequired:required,budgetReady:!required||!budgetReason,...(budgetReason?{budgetReason}:{}),...(state.selected?.budgetLimits?{budgetLimits:state.selected.budgetLimits}:{}),...(reservationMicros?{reservationMicros}:{})};}
 const supervisor=new VoiceSessionSupervisor({store:{save:record=>store.putVoiceSession(record),get:(principal,project,id)=>store.getVoiceSession(principal,project,id)},profile:info,
  transports:{create(revision,authority){let active:VoiceTransport|undefined;let closed=false;let credentialDigest:string|undefined;
   const digest=(value:string)=>createHash('sha256').update(value).digest('hex');
   async function check(){const fresh=await resolve();if(closed||!fresh.configured||fresh.selected?.revision!==revision){await active?.close();throw new VoiceSessionError('voice_profile_changed');}
    if(authority&&options.assertAuthority)await options.assertAuthority(authority);
    const credential=await fresh.service!.readCredential(fresh.connection!);
    if(closed||!credential||credentialDigest&&digest(credential)!==credentialDigest){await active?.close();throw new VoiceSessionError('voice_credential_changed');}
    // A vault read may yield to revocation. Recheck the profile and principal
    // after it, before admitting any frame or paid response.
    const selectedNow=await selection(),connectionNow=await fresh.service!.get(fresh.connection!.id);
    if(closed||selectedNow?.revision!==revision||!connectionNow||connectionNow.revision!==fresh.connection!.revision||!eligible(connectionNow)){await active?.close();throw new VoiceSessionError('voice_profile_changed');}
    if(authority&&options.assertAuthority)await options.assertAuthority(authority);
    const config=options.config?.();if(config?.deviceRevokedAt||config?.entitlementSuspendedAt)throw new VoiceSessionError('voice_authority_revoked');
    return fresh;
   }
   return {
   async open(session,handlers){const state=await resolve();if(closed)throw new VoiceSessionError('voice_session_closed');if(!state.configured||state.selected?.revision!==revision)throw new VoiceSessionError('voice_profile_changed');
    let funding:OpenAIRealtimeOptions['funding'];
    if(state.connection?.commercialAccountId){
     const budgetInfo=await info();if(!budgetInfo.budgetReady)throw new VoiceSessionError(budgetInfo.budgetReason??'budget_cost_unknown');
     if(!state.selected.budgetLimits)throw new VoiceSessionError('voice_budget_limits_required');
     if(!options.config||!options.governance?.()||!options.assertAuthority||!authority)throw new VoiceSessionError('account_funding_unavailable');
     const selected=state.selected,connection=state.connection,limits=selected.budgetLimits!;
     const initial=realtimeTariff(options.config(),connection.providerId,selected.model);realtimeReservation(initial,limits,session.instructions);
     await options.assertAuthority(authority);
     funding={limits,reserve:async turnId=>{
      await check();const tariff=realtimeTariff(options.config!(),connection.providerId,selected.model),estimated=realtimeReservation(tariff,limits,session.instructions);
      const reservation=await options.governance!()!.reserveAccountFunding(JSON.stringify(['realtime',authority.principalId,authority.projectId,authority.sessionId,authority.runId]),{
       id:turnId,provider:connection.providerId,model:selected.model,...estimated,accessMode:'byok',commercialAccount:{providerId:connection.providerId,accountId:connection.commercialAccountId!},priceUsage:()=>null,
      });
      if(!reservation?.settleCost)throw new VoiceSessionError('account_funding_unavailable');
      return {compensate:()=>reservation.compensate(),validate:async()=>{
       await check();await reservation.validate?.();
       if(JSON.stringify(realtimeTariff(options.config!(),connection.providerId,selected.model))!==JSON.stringify(tariff))throw new VoiceSessionError('account_funding_changed');
      },settleUsage:async usage=>{await reservation.settleCost!(realtimeUsageCost(usage,tariff,estimated));}};
     }};
    }
    active=createOpenAIRealtimeFactory({model:state.selected.model,profileRevision:revision,...(funding?{funding}:{}),...(options.connect?{connect:options.connect}:{}),resolveCredential:async()=>{const fresh=await check();const credential=await fresh.service!.readCredential(fresh.connection!);if(credential)credentialDigest=digest(credential);return credential??undefined;}}).create(revision,authority);
    return active.open(session,handlers);},
   async sendAudio(frame){await check();if(!active)throw new VoiceSessionError('voice_session_missing');await active.sendAudio(frame);},
   async commitInput(){await check();if(!active)throw new VoiceSessionError('voice_session_missing');await active.commitInput();},
   async interrupt(playback){await active?.interrupt(playback);},async close(){closed=true;await active?.close();}
  };}}
 });
 return {supervisor,configuration:{
  async options(){const service=profiles(),result=[];for(const p of await service?.list()??[])if(eligible(p)&&await service!.credentialPresent(p))result.push({id:p.id,label:p.label,modelIds:p.modelIds,accountBound:Boolean(p.commercialAccountId)});return result;},
  configure(input:unknown){const next=writes.catch(()=>undefined).then(async()=>{
   if(!isDataRecord(input)||Object.keys(input).some(key=>!['connectionId','expectedRevision','model','budgetLimits'].includes(key))||!Number.isSafeInteger(input.expectedRevision)||typeof input.connectionId!=='string'||typeof input.model!=='string'||!modelValid(input.model))throw new VoiceSessionError('voice_profile_invalid');
   const current=await selection();if((current?.revision??0)!==input.expectedRevision)throw new VoiceSessionError('voice_profile_changed');
   const service=profiles(),connection=await service?.get(input.connectionId);if(!service||!connection||!eligible(connection)||!await service.credentialPresent(connection))throw new VoiceSessionError('voice_connection_unavailable');
   const budgetLimits=input.budgetLimits!==undefined?parseVoiceBudgetLimits(input.budgetLimits):current?.budgetLimits;
   // A new profile invalidates existing live sessions as well as prepared plans.
   await supervisor.close();
   await secrets.set(PROFILE_KEY,JSON.stringify({revision:(current?.revision??0)+1,connectionId:connection.id,connectionRevision:connection.revision,model:input.model,...(budgetLimits?{budgetLimits}:{})}));return info();
  });writes=next;return next;}
 }};
}
function modelValid(value:string){return /^[A-Za-z0-9][A-Za-z0-9._:-]{0,99}$/.test(value);}
