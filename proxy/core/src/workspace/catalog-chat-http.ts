import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {publicApiChatSteps} from '../../../integracoes/api-instruments/src/public-chat-intent.ts';
import {ALL_CURATED_OPERATIONS} from '../../../integracoes/api-instruments/src/index.ts';
import type {BrowserPublicJwk} from './browser-session.ts';
import type {PlanConsentService} from './plan-consent.ts';
import {isProjectGranted, type LocalProjectGrant} from './principal.ts';
import type {RunAdmission, WorkspaceRuntime} from './runtime.ts';
import {WorkspaceError} from './workspace-error.ts';

const prefix='/v1/workspace/catalog-chat';
const uuid='[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}';
const existingRoute=new RegExp(`^${prefix}/(${uuid})/(${uuid})(?:/(challenge|complete|cancel))?$`);
const projectPurpose='uptokey:catalog-chat:v1';

export function catalogChatMethod(path:string):'GET'|'POST'|undefined {
  if(path===prefix+'/prepare')return 'POST';
  const match=existingRoute.exec(path);
  return match ? (match[3]?'POST':'GET') : undefined;
}

export function catalogChatProject(path:string):string|undefined {
  return existingRoute.exec(path)?.[1];
}

type Command={requestId:string;planId:string;planDigest:string};
interface Authority {
  runtime:WorkspaceRuntime;
  owner:string;
  projects:LocalProjectGrant;
  consent:PlanConsentService;
  key:BrowserPublicJwk;
  signal:AbortSignal;
  admit:(projectId:string,command:Command)=>RunAdmission|undefined;
  revalidate:(projectId?:string)=>Promise<void>;
}

/** Exposes only standalone, anonymous catalogue reads to chat-capable paired clients. */
export async function handleCatalogChat(path:string, input:unknown, authority:Authority) {
  const {runtime,owner,projects,consent,key,signal,admit,revalidate}=authority;
  signal.throwIfAborted();
  if(path===prefix+'/prepare'){
    const steps=isDataRecord(input)&&Object.keys(input).join(',')==='text'&&typeof input.text==='string'
      ?publicApiChatSteps(input.text):undefined;
    if(!steps)throw new WorkspaceError('api_instruments_invalid',400);
    if(projects!=='*')throw new WorkspaceError('resource_not_granted',403);
    const catalog=await runtime.apiInstrumentsInfo();
    if(!catalog.available||steps.some(step=>!catalog.operations.some(op=>op.id===step.operationId&&op.metadata.authentication==='none')))
      throw new WorkspaceError('api_operation_unavailable',503);
    await revalidate();
    const project=await runtime.store.createProject({identityId:owner,name:'Public API chat',goal:'',constraints:[projectPurpose]});
    const common={expectedRevision:project.revision,catalogDigest:catalog.catalogDigest};
    const view=steps.length===1
      ?await runtime.createApiPlan(owner,project.id,{...common,...steps[0]},signal)
      :await runtime.createApiCompositePlan(owner,project.id,{...common,steps},signal);
    if(!view.plan)throw new WorkspaceError('plan_missing',404);
    return {status:201 as const,body:await projectRead(runtime,owner,project.id,view.plan.id)};
  }

  const match=existingRoute.exec(path);
  if(!match)throw new WorkspaceError('plan_missing',404);
  const projectId=match[1]!,planId=match[2]!,action=match[3];
  if(!isProjectGranted(projects,projectId))throw new WorkspaceError('resource_not_granted',403);
  const project=await runtime.store.getProject(owner,projectId);
  if(project.constraints.length!==1||project.constraints[0]!==projectPurpose)throw new WorkspaceError('plan_missing',404);
  const view=await projectRead(runtime,owner,projectId,planId);
  await revalidate(projectId);
  if(!action)return {status:200 as const,body:view};
  const command={requestId:planId,planId,planDigest:view.planDigest};
  const binding={principalId:owner,projectId,planId,planDigest:view.planDigest};
  if(action==='challenge'){
    if(view.run)throw new WorkspaceError('project_run_active',409);
    return {status:200 as const,body:consent.challenge(binding,key)};
  }
  if(action==='cancel'){
    if(!view.run)throw new WorkspaceError('run_not_found',404);
    await runtime.cancel(owner,projectId,view.run.id);
    return {status:200 as const,body:await projectRead(runtime,owner,projectId,planId)};
  }
  if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='challengeId,signature'||
    typeof input.challengeId!=='string'||typeof input.signature!=='string')throw new WorkspaceError('invalid_request',400);
  const admission=admit(projectId,command);
  if(!admission)throw new WorkspaceError('conversation_admission_required',400);
  try{consent.consume(binding,input.challengeId,input.signature);}catch{throw new WorkspaceError('consent_invalid',403);}
  // Bind the durable run to the existing conversation ledger. Revalidate the
  // route credential during admission and before every outbound effect.
  const admissionRevalidate=admission.revalidate;
  const guardedAdmission=Object.assign(admission,{revalidate:async()=>{
    await revalidate(projectId);
    await admissionRevalidate?.();
  }});
  await runtime.startRun(owner,projectId,command,true,guardedAdmission);
  return {status:202 as const,body:await projectRead(runtime,owner,projectId,planId)};
}

async function projectRead(runtime:WorkspaceRuntime,owner:string,projectId:string,planId:string){
  const view=await runtime.viewPlan(owner,projectId,planId);
  const plan=view.plan;
  if(!plan||plan.steps.length<1||plan.steps.length>2)throw new WorkspaceError('plan_missing',404);
  const steps=plan.steps.map(step=>{
    const call=step.arguments.prepared_call;
    const operation=ALL_CURATED_OPERATIONS.find(op=>op.id===step.capabilityId&&op.capability.version===step.capabilityVersion&&
      op.capability.effect==='read_external'&&op.metadata.authentication==='none'&&!op.pagination);
    if(!operation||Object.keys(step.arguments).length!==1||call?.kind!=='literal'||!isDataRecord(call.value)||
      call.value.method!=='GET'||typeof call.value.url!=='string')throw new WorkspaceError('plan_missing',404);
    const target=new URL(call.value.url);
    if(target.origin!==new URL(operation.serverUrl).origin||target.username||target.password||target.hash)
      throw new WorkspaceError('plan_missing',404);
    return {id:step.id,operationId:step.capabilityId,url:target.href};
  });
  const run=view.run?{id:view.run.id,status:view.run.status}:null;
  const receipts=run?view.receipts.filter(receipt=>receipt.runId===run.id).map(receipt=>({
    id:receipt.id,stepId:receipt.stepId,status:receipt.status,errorCode:receipt.errorCode,
    sources:receipt.sources,artifactIds:receipt.outputArtifactRefs
  })):[];
  const results=await Promise.all(receipts.filter(receipt=>receipt.status==='succeeded').flatMap(receipt=>
    receipt.artifactIds.map(async artifactId=>({stepId:receipt.stepId,
      projection:await runtime.apiArtifactProjection(owner,projectId,artifactId)}))));
  return {projectId,planId,planDigest:plan.digest,steps,run,receipts,results};
}
