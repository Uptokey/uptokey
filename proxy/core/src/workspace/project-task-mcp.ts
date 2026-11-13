import {McpServer} from '@modelcontextprotocol/sdk/server/mcp.js';
import * as z from 'zod/v4';
import {PACKAGE_VERSION} from '../version.ts';
import {redactForToolResult,assertNoSecretMaterial} from '../mcp-redact.ts';
import {computePlanDigest} from './policy.ts';
import {taskAuthority,taskProjection} from './project-task-authority.ts';
import type {WorkspaceRuntime} from './runtime.ts';

export interface ProjectTaskMcpBinding {
  readonly principalId:string;
  readonly projectId:string;
  readonly taskId:string;
  readonly rootBindingId:string;
  readonly rootRunId:string;
  readonly specDigest:string;
}

/** A transport adapter for already approved, sealed child plans. It cannot
 * create approvals, write files, change argv, or add children to a task grant. */
export function createProjectTaskMcpServer(runtime:WorkspaceRuntime,binding:Readonly<ProjectTaskMcpBinding>,options:{
  authorize:()=>Promise<boolean>;
  now?:()=>Date;
}):{server:McpServer;close:()=>Promise<void>}{
  if(!options||typeof options.authorize!=='function')throw Error('project_task_session_required');
  if(!binding||Object.keys(binding).sort().join(',')!=='principalId,projectId,rootBindingId,rootRunId,specDigest,taskId'
    ||![binding.principalId,binding.projectId,binding.taskId,binding.rootBindingId,binding.rootRunId].every(value=>typeof value==='string'&&/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value))
    ||!/^[a-f0-9]{64}$/.test(binding.specDigest))throw Error('project_task_binding_invalid');
  const scope=Object.freeze({...binding}),now=options.now??(()=>new Date());
  let closed=false;
  const server=new McpServer({name:'uptokey-project-task',version:PACKAGE_VERSION},{maxToolInputElements:64,
    instructions:'Controls one host-authorized Uptokey task containing already sealed child plans. No arbitrary commands, file writes, new approvals or automatic promotion.'});
  const deny=()=>{throw Error('project_task_access_denied');};
  const session=async()=>{
    if(closed)throw Error('project_task_session_denied');
    let allowed=false;try{allowed=await options.authorize();}catch{/* never expose host-session errors */}
    if(closed||!allowed)throw Error('project_task_session_denied');
  };
  const observe=async()=>{
    await session();
    await runtime.projectRoot.ensureRootLoaded(scope.rootBindingId,runtime.store,scope.principalId,scope.projectId);
    await session();
    const bundle=await runtime.store.getBundle(scope.principalId,scope.projectId);
    await session();
    const at=now();
    const task=bundle.projectTasks?.find(item=>item.id===scope.taskId);
    if(!task||bundle.project.ownerPrincipalId!==scope.principalId||task.principalId!==scope.principalId||task.projectId!==scope.projectId
      ||task.rootBindingId!==scope.rootBindingId||task.rootRunId!==scope.rootRunId||task.digest!==scope.specDigest) return deny();
    const root=bundle.projectRoots?.find(item=>item.binding.id===scope.rootBindingId)?.binding;
    const verified=runtime.projectRoot.getVerifiedRoot(scope.rootBindingId).binding;
    if(!root||root.principalId!==scope.principalId||root.projectId!==scope.projectId||root.revokedAt||Date.parse(root.expiresAt)<=at.getTime()
      ||root.revision!==task.rootBindingRevision||root.rootIdentityDigest!==task.rootIdentityDigest||verified.revision!==root.revision||verified.rootIdentityDigest!==root.rootIdentityDigest)return deny();
    if(task.grant.revokedAt||Date.parse(task.grant.expiresAt)<=at.getTime()
      ||bundle.grants.some(grant=>grant.principalId===scope.principalId&&grant.revokedAt!==null&&Date.parse(grant.revokedAt)<=at.getTime()))return deny();
    const parent=bundle.runs.find(item=>item.run.id===scope.rootRunId),plan=bundle.plans.find(item=>item.id===task.rootPlanId);
    if(!parent||parent.run.status!=='succeeded'||parent.run.planId!==task.rootPlanId||!plan||computePlanDigest(plan)!==plan.digest||parent.run.planDigest!==plan.digest)return deny();
    for(const child of task.children){
      const childPlan=bundle.plans.find(item=>item.id===child.planId);
      if(!childPlan||childPlan.digest!==child.digest||computePlanDigest(childPlan)!==child.digest)return deny();
      if(child.runId){const run=bundle.runs.find(item=>item.run.id===child.runId);if(!run||run.run.planId!==child.planId||run.run.requestId!==child.requestId||run.run.planDigest!==child.digest)return deny();}
    }
    // Completed/cancelled/blocked tasks may be inspected or stopped, but only
    // the canonical task authority below can admit a pending child's effect.
    if(!task.stoppedAt&&!task.blockedReason&&!taskAuthority(bundle,task,task.children[0]!.planId,task.children[0]!.requestId,at))return deny();
    return {bundle,task,projection:taskProjection(bundle,task)};
  };
  type Observation=Awaited<ReturnType<typeof observe>>;
  const summary=(value:Observation)=>({status:value.projection.status,children:value.projection.children.map((child,childIndex)=>({childIndex,status:child.status,receiptIds:child.receiptIds,artifactIds:child.artifactIds}))});
  const result=(value:unknown)=>{
    const safe=redactForToolResult(value);assertNoSecretMaterial(safe,'project_task_mcp');
    const text=JSON.stringify(safe);if(Buffer.byteLength(text)>131072)throw Error('project_task_output_limit');
    return {content:[{type:'text' as const,text}]};
  };
  const safe=async(action:()=>Promise<unknown>)=>{
    try{return result(await action());}
    catch(error){const known=['project_task_session_denied','project_task_not_ready','project_task_child_unavailable','project_task_output_limit'];
      const code=error instanceof Error&&known.includes(error.message)?error.message:'project_task_access_denied';
      return {isError:true,content:[{type:'text' as const,text:JSON.stringify({error:code})}]};}
  };
  const empty=z.object({}).strict();
  server.registerTool('task_status',{inputSchema:empty,annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},()=>safe(async()=>{
    await observe();return summary(await observe());
  }));
  server.registerTool('task_resume',{inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},()=>safe(async()=>{
    const before=await observe(),child=before.task.children.find(item=>!item.runId);
    if(before.projection.status!=='ready'||!child)throw Error('project_task_not_ready');
    const authority=await runtime.store.readProjectTaskAuthority(scope.principalId,scope.projectId,child.planId,child.requestId);
    if(!authority||authority.authority.taskId!==scope.taskId||authority.authority.rootRunId!==scope.rootRunId||authority.authority.specDigest!==scope.specDigest)return deny();
    const current=await observe();
    if(current.projection.status!=='ready'||current.task.children.find(item=>!item.runId)?.requestId!==child.requestId)throw Error('project_task_not_ready');
    await runtime.resumeProjectTask(scope.principalId,scope.projectId,scope.taskId);
    return summary(await observe());
  }));
  server.registerTool('task_cancel',{inputSchema:empty,annotations:{readOnlyHint:false,destructiveHint:false,openWorldHint:false}},()=>safe(async()=>{
    await observe();await runtime.cancelProjectTask(scope.principalId,scope.projectId,scope.taskId);
    return summary(await observe());
  }));
  server.registerTool('task_output',{inputSchema:z.object({childIndex:z.number().int().min(0).max(15),after:z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),limit:z.number().int().min(1).max(16).optional()}).strict(),annotations:{readOnlyHint:true,destructiveHint:false,openWorldHint:false}},input=>safe(async()=>{
    const before=await observe(),child=before.task.children[input.childIndex];
    if(!child?.runId)throw Error('project_task_child_unavailable');
    const output=await runtime.readProjectRunOutput(scope.principalId,scope.projectId,child.runId,input.after??0,input.limit??16);
    const after=await observe();
    if(after.task.children[input.childIndex]?.runId!==child.runId)return deny();
    return {...summary(after).children[input.childIndex],output};
  }));
  return {server,close:async()=>{closed=true;await server.close();}};
}
