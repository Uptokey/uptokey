import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {parseProjectTaskRecord} from './project-task-authority.ts';
export {taskProjection} from './project-task-authority.ts';
const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
import {parseCapabilityDescriptor,parseExecutionPlan,parseProjectGrant,canonicalContextSnapshotPayload,type ExecutionPlan,type ProjectGrant} from '@uptokey/sync-contract/workflow';
import {computePlanDigest} from './policy.ts';
import type {WorkspaceBundle} from './store.ts';
import {WorkspaceError,type WorkspaceRuntime} from './runtime.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';

export const PROJECT_TASK_CAPABILITY=parseCapabilityDescriptor({schemaVersion:1,id:'workspace.project.task',version:1,createdAt:'2026-09-20T00:00:00.000Z',titleKey:'ws_project_task',descriptionKey:'ws_project_task_scope',tags:['project','delegation'],inputSchemaId:'workspace.project.task.input.v1',outputSchemaId:'workspace.project.task.output.v1',effect:'produce_artifact',dataDestination:{kind:'local',id:'project_task'},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass:'never_automatic',limits:{maxSteps:1,maxCalls:1,maxOutputTokens:4096,timeoutMs:60000,maxOutputBytes:1048576}});

export async function prepareProjectTask(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown){
 if(!isDataRecord(input)||Object.keys(input).filter(k=>k!=='predecessorTaskId').sort().join(',')!=='childPlanIds,expectedRevision,objective,rootBindingId'||typeof input.objective!=='string'||!input.objective.trim()||input.objective.length>2000||typeof input.rootBindingId!=='string'||!Array.isArray(input.childPlanIds)||input.childPlanIds.length<1||input.childPlanIds.length>16||new Set(input.childPlanIds).size!==input.childPlanIds.length)throw new WorkspaceError('project_task_invalid');
 const bundle=await runtime.store.getBundle(principal,projectId);if(bundle.project.revision!==input.expectedRevision)throw new WorkspaceError('workspace_revision_conflict',409);
 const {binding}=await runtime.projectRoot.ensureRootLoaded(input.rootBindingId,runtime.store,principal,projectId);
 const predecessor=input.predecessorTaskId===undefined?null:bundle.projectTasks?.find(t=>t.id===input.predecessorTaskId&&t.rootBindingId===binding.id);
 if(input.predecessorTaskId!==undefined&&!predecessor)throw new WorkspaceError('project_task_predecessor_missing',404);
 runtime.projectRoot.getVerifiedRoot(binding.id);
 const plans=input.childPlanIds.map(id=>bundle.plans.find(p=>p.id===id));if(plans.some(p=>!p))throw new WorkspaceError('project_task_plan_missing',404);
 const capabilities=plans.flatMap(p=>p!.steps.map(s=>runtime.registry().get(s.capabilityId,s.capabilityVersion)));
 if(capabilities.some(c=>!c||c.availability!=='executable'||c.id===PROJECT_TASK_CAPABILITY.id))throw new WorkspaceError('project_task_capability_unavailable',409);
 for(const p of plans)for(const s of p!.steps){const rb=s.arguments.root_binding_id;if(rb&&(rb.kind!=='literal'||rb.value!==binding.id))throw new WorkspaceError('project_task_root_mismatch',409);}
 const total={maxSteps:Math.max(...plans.map(p=>p!.limits.maxSteps)),maxCalls:plans.reduce((n,p)=>n+p!.limits.maxCalls,0),maxOutputTokens:plans.reduce((n,p)=>n+p!.limits.maxOutputTokens,0),timeoutMs:plans.reduce((n,p)=>n+p!.limits.timeoutMs,0),maxOutputBytes:plans.reduce((n,p)=>n+p!.limits.maxOutputBytes,0)};
 const now=new Date().toISOString(),id=randomUUID();
 let grant:ProjectGrant;try{grant=parseProjectGrant({schemaVersion:1,id:randomUUID(),createdAt:now,principalId:principal,projectId,revision:1,scopes:[...new Set(['run:execute',...capabilities.flatMap(c=>c!.requiredScopes)])],capabilityIds:[...new Set(capabilities.map(c=>c!.id))],destinations:[...new Map(capabilities.map(c=>[canonicalJson(c!.dataDestination),c!.dataDestination])).values()],limits:total,expiresAt:new Date(Math.min(Date.parse(binding.expiresAt),Date.now()+total.timeoutMs)).toISOString(),revokedAt:null});}catch{throw new WorkspaceError('project_task_aggregate_limit_exceeded');}
 const spec={id,projectId,principalId:principal,predecessorTaskId:predecessor?.id??null,rootBindingId:binding.id,rootBindingRevision:binding.revision,rootIdentityDigest:binding.rootIdentityDigest,objective:input.objective.trim(),grant,children:plans.map(p=>({planId:p!.id,digest:p!.digest,requestId:randomUUID(),runId:null})),createdAt:now};
 const snapshot=await runtime.store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:[],excludedEntryIds:bundle.project.entries.map(e=>e.id),allowedDestinations:[PROJECT_TASK_CAPABILITY.dataDestination],maxContextBytes:32000});
 let plan:ExecutionPlan={schemaVersion:1,id:randomUUID(),createdAt:now,projectId,projectRevision:bundle.project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),steps:[{id:'delegate',capabilityId:PROJECT_TASK_CAPABILITY.id,capabilityVersion:1,arguments:{task:{kind:'literal',value:JSON.parse(JSON.stringify({...spec,digest:sha(spec)}))},child_plans:{kind:'literal',value:plans.map(plan=>({planId:plan!.id,payloadChunks:JSON.stringify(plan).match(/[\\s\\S]{1,8000}/g)!}))}}}],limits:{...PROJECT_TASK_CAPABILITY.limits},digest:'0'.repeat(64)};
 plan=parseExecutionPlan({...plan,digest:computePlanDigest(plan)});await runtime.store.putPlan(principal,plan,snapshot);return runtime.viewPlan(principal,projectId,plan.id);
}

export async function dispatchProjectTask(runtime:WorkspaceRuntime,effect:EffectRequest):Promise<EffectOutcome>{
 const raw=effect.arguments.task;if(raw?.kind!=='literal'||!isDataRecord(raw.value))return {kind:'not_sent',code:'project_task_invalid'};
 const {digest:given,...spec}=raw.value;if(sha(spec)!==given)return {kind:'not_sent',code:'project_task_digest_mismatch'};
 const bundle=await runtime.store.getBundle(effect.principalId,effect.projectId),root=bundle.runs.find(r=>r.run.id===effect.runId);
 if(!root)return {kind:'not_sent',code:'project_task_root_missing'};
 const task=parseProjectTaskRecord({...spec,digest:given,schemaVersion:1,rootRunId:effect.runId,rootPlanId:root.run.planId,stoppedAt:null,blockedReason:null});
 if(task.principalId!==effect.principalId||task.projectId!==effect.projectId)return {kind:'not_sent',code:'project_task_owner_mismatch'};
 await runtime.store.putProjectTask(effect.principalId,task);
 const artifactId=randomUUID();return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes:new TextEncoder().encode(JSON.stringify({taskId:task.id,rootRunId:task.rootRunId,children:task.children}))}],outputArtifactRefs:[artifactId],sources:[]};
}
