import {createHash} from 'node:crypto';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {parseRunAuthority,type RunAuthority} from '@uptokey/sync-contract/project-agent';
import {parseProjectGrant,type ProjectGrant} from '@uptokey/sync-contract/workflow';
import {computePlanDigest} from './policy.ts';
import type {WorkspaceBundle} from './store.ts';
/** Exact, bounded child plans. This record is persisted in the existing encrypted project journal. */
export interface ProjectTaskRecord {
 schemaVersion:1;id:string;projectId:string;principalId:string;rootRunId:string;rootPlanId:string;predecessorTaskId:string|null;
 rootBindingId:string;rootBindingRevision:number;rootIdentityDigest:string;objective:string;
 digest:string;grant:ProjectGrant;children:{planId:string;digest:string;requestId:string;runId:string|null}[];
 stoppedAt:string|null;blockedReason:string|null;createdAt:string;
}
export interface ProjectTaskAuthority {authority:Extract<RunAuthority,{kind:'project_task_delegation'}>;grant:ProjectGrant;planId:string;requestId:string;}
const sha=(v:unknown)=>createHash('sha256').update(canonicalJson(v)).digest('hex');
const identifier=(v:unknown):v is string=>typeof v==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(v);
const digest=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
export function parseProjectTaskRecord(value:unknown):ProjectTaskRecord {
 if(!isDataRecord(value)||Object.keys(value).sort().join(',')!=='blockedReason,children,createdAt,digest,grant,id,objective,predecessorTaskId,principalId,projectId,rootBindingId,rootBindingRevision,rootIdentityDigest,rootPlanId,rootRunId,schemaVersion,stoppedAt')throw Error('project_task_invalid');
 const t=value as unknown as ProjectTaskRecord;
 if(t.predecessorTaskId!==null&&!identifier(t.predecessorTaskId))throw Error('project_task_invalid');
 if(t.blockedReason!==null&&(typeof t.blockedReason!=='string'||!/^[a-z0-9_]{1,100}$/.test(t.blockedReason)))throw Error('project_task_invalid');
 if(t.schemaVersion!==1||![t.id,t.projectId,t.principalId,t.rootRunId,t.rootPlanId,t.rootBindingId].every(identifier)||!digest(t.digest)||!digest(t.rootIdentityDigest)||!Number.isSafeInteger(t.rootBindingRevision)||t.rootBindingRevision<1||typeof t.objective!=='string'||!t.objective.trim()||t.objective.length>2000||!Number.isFinite(Date.parse(t.createdAt))||(t.stoppedAt!==null&&!Number.isFinite(Date.parse(t.stoppedAt))))throw Error('project_task_invalid');
 if(!Array.isArray(t.children)||t.children.length<1||t.children.length>16||new Set(t.children.map(c=>c.planId)).size!==t.children.length)throw Error('project_task_invalid');
 for(const c of t.children)if(!isDataRecord(c)||Object.keys(c).sort().join(',')!=='digest,planId,requestId,runId'||![c.planId,c.requestId].every(identifier)||!digest(c.digest)||(c.runId!==null&&!identifier(c.runId)))throw Error('project_task_invalid');
 const grant=parseProjectGrant(t.grant);if(grant.projectId!==t.projectId||grant.principalId!==t.principalId)throw Error('project_task_invalid');
 return structuredClone({...t,grant});
}

/** Every admission and every step re-read the exact authority and live root revocation. */
export function taskAuthority(bundle:WorkspaceBundle,task:ProjectTaskRecord,planId:string,requestId:string,now:Date):ProjectTaskAuthority|undefined {
 const index=task.children.findIndex(c=>c.planId===planId&&c.requestId===requestId),child=task.children[index];
 if(!child||task.stoppedAt||task.blockedReason||Date.parse(task.grant.expiresAt)<=now.getTime())return;
 if(bundle.grants.some(grant=>grant.principalId===task.principalId&&grant.revokedAt!==null&&Date.parse(grant.revokedAt)<=now.getTime()))return;
 const root=bundle.projectRoots?.find(r=>r.binding.id===task.rootBindingId)?.binding;
 if(!root||root.revokedAt||Date.parse(root.expiresAt)<=now.getTime()||root.revision!==task.rootBindingRevision||root.rootIdentityDigest!==task.rootIdentityDigest)return;
 const parent=bundle.runs.find(r=>r.run.id===task.rootRunId);
 if(parent?.run.status!=='succeeded')return;
 if(task.children.slice(0,index).some(c=>!c.runId||bundle.runs.find(r=>r.run.id===c.runId)?.run.status!=='succeeded'))return;
 const plan=bundle.plans.find(p=>p.id===child.planId);
 if(!plan||plan.digest!==child.digest||computePlanDigest(plan)!==child.digest)return;
 return {authority:parseRunAuthority({kind:'project_task_delegation',taskId:task.id,rootRunId:task.rootRunId,specDigest:task.digest,childPlanDigest:child.digest,reservationId:child.requestId,iteration:index+1}) as ProjectTaskAuthority['authority'],grant:task.grant,planId,requestId};
}

export function taskProjection(bundle:WorkspaceBundle,task:ProjectTaskRecord){
 const children=task.children.map(c=>{const record=bundle.runs.find(r=>r.run.id===c.runId);return {...c,status:record?.run.status??'pending',receiptIds:record?.receipts.map(r=>r.id)??[],artifactIds:record?.receipts.flatMap(r=>r.outputArtifactRefs)??[]};});
 const rootStatus=bundle.runs.find(r=>r.run.id===task.rootRunId)?.run.status;
 const status=task.stoppedAt?'cancelled':task.blockedReason?'blocked':rootStatus==='needs_attention'||children.some(c=>c.status==='needs_attention')?'needs_attention':rootStatus==='failed'||rootStatus==='cancelled'||children.some(c=>c.status==='failed'||c.status==='cancelled')?'blocked':children.every(c=>c.status==='succeeded')?'succeeded':Date.parse(task.grant.expiresAt)<=Date.now()?'expired':rootStatus==='running'||children.some(c=>c.status==='running')?'running':'ready';
 return {...task,status,children,limits:task.grant.limits,destinations:task.grant.destinations};
}
