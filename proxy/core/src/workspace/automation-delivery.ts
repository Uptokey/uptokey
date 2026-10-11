/** Channel delivery uses the canonical W5 journal, consent and SecretStore.
 * API contracts checked 2026-09-20:
 * https://resend.com/docs/api-reference/emails/send-email
 * https://developers.brevo.com/reference/send-transac-email
 * https://docs.slack.dev/reference/methods/chat.postMessage/
 * No implicit retry, arbitrary endpoint, webhook or alternate credential store.
 */
import {createHash,randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {parseCapabilityDescriptor,parseExecutionPlan,canonicalContextSnapshotPayload,validatePlanBindings,type ExecutionPlan} from '@uptokey/sync-contract/workflow';
import type {SecretStore} from '../secret-store.ts';
import type {WorkspaceStore} from './store.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';
import {computePlanDigest} from './planner.ts';
import {AutomationError,isId} from './automation-types.ts';
import type {ChannelKind,ChannelMessage} from './automation-channels.ts';

const channels:ChannelKind[]=['resend','brevo','slack'];
const endpoints={resend:'https://api.resend.com/emails',brevo:'https://api.brevo.com/v3/smtp/email',slack:'https://slack.com/api/chat.postMessage'};
const hash=(text:string)=>createHash('sha256').update(text).digest('hex');
const email=(value:unknown):value is string=>typeof value==='string'&&value.length<=254&&/^[^\s@<>;,]+@[^\s@<>;,]+\.[^\s@<>;,]+$/.test(value);
const limits={maxSteps:1,maxCalls:1,maxOutputTokens:1,maxOutputBytes:16_384,timeoutMs:30_000};
const capabilities=channels.map(channel=>parseCapabilityDescriptor({schemaVersion:1,id:`automation.channel.${channel}`,version:1,createdAt:'2026-09-20T00:00:00.000Z',titleKey:`ws_automation_channel_${channel}`,descriptionKey:'ws_automation_channel_description',tags:['automations','channel'],inputSchemaId:'automation.channel.input.v1',outputSchemaId:'automation.channel.result.v1',effect:'write_external',dataDestination:{kind:'provider',id:channel},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass:'never_automatic',limits}));
type Configuration={version:string;key:string;sender?:string};
type ChannelRequest={channel:ChannelKind;configVersion:string;sender?:string;message:ChannelMessage};
function channelKind(value:unknown):ChannelKind{if(!channels.includes(value as ChannelKind))throw new AutomationError('channel_unknown',404);return value as ChannelKind;}
function parseMessage(channel:ChannelKind,input:unknown):ChannelMessage{
  if(!isDataRecord(input)||Object.keys(input).some(key=>!['to','subject','body','threadKey'].includes(key))||typeof input.to!=='string'||typeof input.body!=='string'||!input.body.trim()||input.body.length>32_768)throw new AutomationError('channel_message_invalid');
  if(channel==='slack'?!/^[CGD][A-Z0-9]{4,79}$/.test(input.to):!email(input.to))throw new AutomationError('channel_recipient_invalid');
  if(input.subject!==undefined&&(typeof input.subject!=='string'||!input.subject.trim()||input.subject.length>320||/[\r\n\0]/.test(input.subject)))throw new AutomationError('channel_subject_invalid');
  if(channel!=='slack'&&typeof input.subject!=='string')throw new AutomationError('channel_subject_required');
  if(input.threadKey!==undefined&&(channel!=='slack'||typeof input.threadKey!=='string'||!/^\d{1,16}\.\d{1,10}$/.test(input.threadKey)))throw new AutomationError('channel_thread_invalid');
  return {to:input.to,body:input.body,...(typeof input.subject==='string'?{subject:input.subject}:{}),...(typeof input.threadKey==='string'?{threadKey:input.threadKey}:{})};
}

export class WorkspaceAutomationDelivery{
  private readonly secrets:SecretStore;
  private readonly fetchFn:typeof fetch;
  constructor(secrets:SecretStore,options:{fetchFn?:typeof fetch}={}){this.secrets=secrets;this.fetchFn=options.fetchFn??fetch;}
  capabilities(){return capabilities.map(value=>structuredClone(value));}
  private account(principal:string,projectId:string,channel:ChannelKind){if(!isId(principal)||!isId(projectId))throw new AutomationError('principal_or_project_invalid');return `automation-channel:${hash(JSON.stringify([principal,projectId,channel]))}`;}
  private async config(principal:string,projectId:string,channel:ChannelKind):Promise<Configuration|undefined>{
    const raw=await this.secrets.get(this.account(principal,projectId,channel));if(!raw)return;
    const value=JSON.parse(raw) as Configuration;if(!value||!isId(value.version)||typeof value.key!=='string'||!value.key)throw new AutomationError('channel_configuration_invalid',503);return value;
  }
  async info(principal:string,projectId:string){return Promise.all(channels.map(async channel=>{const value=await this.config(principal,projectId,channel);return {channel,configured:!!value,...(value?{version:value.version,sender:value.sender}:{})};}));}
  async configure(principal:string,projectId:string,kind:unknown,input:unknown){
    const channel=channelKind(kind);
    if(!isDataRecord(input)||Object.keys(input).some(key=>!['key','sender'].includes(key))||typeof input.key!=='string'||input.key.length<8||input.key.length>8192||/[\s\0]/.test(input.key))throw new AutomationError('channel_key_invalid');
    if(channel!=='slack'&&!email(input.sender))throw new AutomationError('channel_sender_invalid');
    const value:Configuration={version:randomUUID(),key:input.key,...(channel!=='slack'?{sender:input.sender as string}:{})};
    await this.secrets.set(this.account(principal,projectId,channel),JSON.stringify(value));
    return {channel,configured:true,version:value.version,sender:value.sender};
  }
  async disconnect(principal:string,projectId:string,kind:unknown){const channel=channelKind(kind);await this.secrets.delete(this.account(principal,projectId,channel));return {channel,configured:false};}
  async prepare(store:WorkspaceStore,principal:string,projectId:string,input:unknown,signal:AbortSignal):Promise<ExecutionPlan>{
    if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='channel,expectedRevision,message'||!Number.isSafeInteger(input.expectedRevision))throw new AutomationError('channel_plan_invalid');
    const channel=channelKind(input.channel),message=parseMessage(channel,input.message),configuration=await this.config(principal,projectId,channel);
    if(!configuration)throw new AutomationError('channel_not_connected',409);
    const project=await store.getProject(principal,projectId);if(project.revision!==input.expectedRevision)throw new AutomationError('workspace_revision_conflict',409);
    const bundle=await store.getBundle(principal,projectId);if(bundle.runs.some(record=>['running','needs_attention','ready','awaiting_approval'].includes(record.run.status)))throw new AutomationError('project_run_active',409);
    signal.throwIfAborted();const capability=capabilities.find(value=>value.dataDestination.id===channel)!;
    const snapshot=await store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:[],excludedEntryIds:project.entries.map(entry=>entry.id),allowedDestinations:[capability.dataDestination],maxContextBytes:32_000});
    const request:ChannelRequest={channel,configVersion:configuration.version,message,...(configuration.sender?{sender:configuration.sender}:{})};
    const base={schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),projectId,projectRevision:project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:hash(canonicalContextSnapshotPayload(snapshot)),steps:[{id:'send',capabilityId:capability.id,capabilityVersion:1,arguments:{request:{kind:'literal',value:JSON.parse(JSON.stringify(request))}}}],limits,digest:'0'.repeat(64)};
    const plan=parseExecutionPlan({...base,digest:computePlanDigest(parseExecutionPlan(base))});validatePlanBindings(plan,snapshot,[capability]);signal.throwIfAborted();await store.putPlan(principal,plan,snapshot);return plan;
  }
  async dispatch(store:WorkspaceStore,request:EffectRequest):Promise<EffectOutcome>{
    // Re-read W5 durable admission; direct module callers cannot cause sends.
    const bundle=await store.getBundle(request.principalId,request.projectId);
    const run=bundle.runs.find(item=>item.run.id===request.runId&&item.run.principalId===request.principalId);
    const plan=bundle.plans.find(item=>item.id===run?.run.planId&&item.digest===run?.run.planDigest);
    const step=plan?.steps.find(item=>item.id===request.stepId&&item.capabilityId===request.capability.id&&item.capabilityVersion===request.capability.version);
    const receipt=run?.receipts.find(item=>item.attemptId===request.attemptId&&item.stepId===request.stepId&&item.capabilityId===request.capability.id&&item.status==='dispatched');
    if(!plan||!step||run?.run.status!=='running'||!receipt)return {kind:'not_sent',code:'channel_active_admission_required'};
    if(canonicalJson(step.arguments)!==canonicalJson(request.arguments))return {kind:'not_sent',code:'channel_argument_mismatch'};
    let parsed:ChannelRequest,configuration:Configuration|undefined;
    try{
      const binding=request.arguments.request;if(binding?.kind!=='literal'||!isDataRecord(binding.value))throw Error();
      const value=binding.value,channel=channelKind(value.channel);if(request.capability.id!==`automation.channel.${channel}`)throw Error();
      parsed={channel,configVersion:String(value.configVersion),message:parseMessage(channel,value.message),...(typeof value.sender==='string'?{sender:value.sender}:{})};
      configuration=await this.config(request.principalId,request.projectId,channel);
    }catch{return {kind:'not_sent',code:'channel_configuration_unavailable'};}
    if(!configuration||configuration.version!==parsed.configVersion||configuration.sender!==parsed.sender)return {kind:'not_sent',code:'channel_configuration_changed'};
    const remaining=Date.parse(request.deadlineAt)-Date.now();if(request.signal.aborted||!Number.isFinite(remaining)||remaining<=0)return {kind:'not_sent',code:'channel_cancelled'};
    const {channel,message}=parsed;const headers:Record<string,string>={'Content-Type':'application/json'};
    const idempotencyKey=`uptokey-${hash(JSON.stringify([request.principalId,request.projectId,request.runId,request.stepId]))}`;
    let payload:unknown;
    if(channel==='resend'){headers.Authorization=`Bearer ${configuration.key}`;headers['Idempotency-Key']=idempotencyKey;payload={from:configuration.sender,to:[message.to],subject:message.subject,text:message.body};}
    else if(channel==='brevo'){headers['api-key']=configuration.key;payload={sender:{email:configuration.sender},to:[{email:message.to}],subject:message.subject,textContent:message.body,headers:{'Idempotency-Key':idempotencyKey}};}
    else{headers.Authorization=`Bearer ${configuration.key}`;payload={channel:message.to,text:message.body,unfurl_links:false,unfurl_media:false,...(message.threadKey?{thread_ts:message.threadKey}:{})};}
    let sent=false;
    try{
      request.signal.throwIfAborted();sent=true;
      const response=await this.fetchFn(endpoints[channel],{method:'POST',headers,body:JSON.stringify(payload),redirect:'error',credentials:'omit',signal:AbortSignal.any([request.signal,AbortSignal.timeout(Math.min(remaining,30_000))])});
      if(!response.ok){await response.body?.cancel();return {kind:'failed',code:response.status>=500?'channel_provider_uncertain':'channel_provider_rejected',sent:response.status>=500?'unknown':'yes'};}
      if(!response.body)return {kind:'failed',code:'channel_invalid_response',sent:'unknown'};
      const reader=response.body.getReader();let total=0;const chunks:Uint8Array[]=[];
      try{while(true){const item=await reader.read();if(item.done)break;total+=item.value.byteLength;if(total>16_384)throw Error('oversize');chunks.push(item.value);}}finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
      const value=JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string,unknown>;
      if(channel==='slack'&&value.ok!==true)return {kind:'failed',code:'channel_provider_rejected',sent:'yes'};
      const externalId=channel==='slack'?value.ts:channel==='brevo'?value.messageId:value.id;
      if(typeof externalId!=='string'||!externalId||externalId.length>320)return {kind:'failed',code:'channel_invalid_response',sent:'unknown'};
      const artifactId=`channel_${request.attemptId.replace(/-/g,'_')}`;
      const content=JSON.stringify({channel,status:'accepted',providerMessageId:externalId,to:message.to,acceptedAt:new Date().toISOString()});
      return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes:new TextEncoder().encode(content)}],outputArtifactRefs:[artifactId]};
    }catch{return sent?{kind:'failed',code:'channel_delivery_uncertain',sent:'unknown'}:{kind:'not_sent',code:'channel_cancelled'};}
  }
}
