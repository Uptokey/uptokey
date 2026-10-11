import type {WorkspaceRuntime} from './runtime.ts';

/** Journal projection only. Opening history never creates a plan or retries a run. */
export async function listPlanHistory(runtime:WorkspaceRuntime,principal:string,projectId:string,query:{after?:string;limit?:number}={}){
 const limit=query.limit??25;
 if(!Number.isSafeInteger(limit)||limit<1||limit>100||query.after!==undefined&&!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(query.after))throw Object.assign(Error('plan_history_query_invalid'),{status:400,code:'plan_history_query_invalid'});
 const bundle=await runtime.store.getBundle(principal,projectId);
 const ordered=[...bundle.plans].sort((a,b)=>b.createdAt.localeCompare(a.createdAt)||b.id.localeCompare(a.id));
 const index=query.after?ordered.findIndex(plan=>plan.id===query.after):-1;
 if(query.after&&index<0)throw Object.assign(Error('plan_history_cursor_missing'),{status:409,code:'plan_history_cursor_missing'});
 const rows=ordered.slice(index+1,index+1+limit);
 const plans=rows.map(plan=>{const slot=bundle.runs.filter(item=>item.run.planId===plan.id).at(-1);return {id:plan.id,createdAt:plan.createdAt,stepCount:plan.steps.length,capabilities:[...new Set(plan.steps.map(step=>step.capabilityId))],receiptCount:slot?.receipts.length??0,run:slot?{id:slot.run.id,requestId:slot.run.requestId,status:slot.run.status,updatedAt:slot.run.updatedAt}:null};});
 return {projectId,plans,nextCursor:index+1+rows.length<ordered.length?rows.at(-1)?.id??null:null};
}
