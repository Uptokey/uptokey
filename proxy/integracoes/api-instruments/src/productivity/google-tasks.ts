import { createHash } from 'node:crypto';
import { parseCapabilityDescriptor } from '@uptokey/sync-contract/workflow';
import { canonicalStringify } from '../importer.ts';
import type { ProductivityOperation, PreparedProductivityCall, EffectPreview } from './operations.ts';

// Official REST v1, reviewed 2026-09-20. No write retry key is documented by Google Tasks.
export const GOOGLE_TASKS_DOCUMENTATION='https://developers.google.com/workspace/tasks/reference/rest';
export const GOOGLE_TASKS_SCOPE='https://www.googleapis.com/auth/tasks';
export const GOOGLE_TASKS_READ_SCOPE='https://www.googleapis.com/auth/tasks.readonly';
const origin='https://tasks.googleapis.com';
const hash=(value:unknown)=>createHash('sha256').update(canonicalStringify(value)).digest('hex');
const specs=[
 ['list_tasklists','GET','/tasks/v1/users/@me/lists','Listar listas de tarefas'],
 ['list_tasks','GET','/tasks/v1/lists/{tasklist}/tasks','Listar tarefas'],
 ['get_task','GET','/tasks/v1/lists/{tasklist}/tasks/{id}','Consultar tarefa'],
 ['create_task','POST','/tasks/v1/lists/{tasklist}/tasks','Criar tarefa'],
] as const;
export const GOOGLE_TASKS_OPERATIONS:readonly ProductivityOperation[]=specs.map(([operationId,method,path,summary])=>{
 const write=method==='POST',id=`api.google_tasks.${operationId}`;
 const requiredScopes=write?['run:execute','project:write'] as const:['run:execute','project:read'] as const;
 const capability=parseCapabilityDescriptor({schemaVersion:1,id,createdAt:'2026-09-20T00:00:00.000Z',version:1,titleKey:id,descriptionKey:id,
  tags:['productivity','google','tasks'],inputSchemaId:`${id}.input.v1`,outputSchemaId:`${id}.output.v1`,effect:write?'write_external':'read_external',
  dataDestination:{kind:'provider',id:'google-tasks'},availability:'executable',supportLevel:'experimental',requiredScopes,
  retryClass:write?'never_automatic':'read_only',limits:{maxSteps:1,maxCalls:1,maxOutputTokens:512,timeoutMs:15000,maxOutputBytes:131072}});
 return {schemaVersion:1,id,serviceId:'google_tasks',operationId,method,path,serverUrl:origin,summary,schemaDigest:hash({operationId,method,path}),documentDigest:hash(GOOGLE_TASKS_DOCUMENTATION),
  effectClass:write?'escrita_externa':'leitura',idempotencySupport:'none',reconciliationSupport:operationId==='get_task'?'status_query':'none',requiredScopes,authMethod:'bearer_vault',capability};
});
function text(value:unknown,name:string,max=1024){if(typeof value!=='string'||!value||value.length>max||/[\u0000-\u001f]/.test(value))throw new Error(`productivity_${name}_invalid`);return value;}
function resourceId(value:unknown,name:string){const result=text(value,name);if(result==='.'||result==='..'||!/^[@A-Za-z0-9_=:-]+$/.test(result))throw new Error(`productivity_${name}_invalid`);return encodeURIComponent(result);}
export function prepareGoogleTasks(operationId:string,input:Record<string,unknown>):{operation:ProductivityOperation;prepared:PreparedProductivityCall;preview:EffectPreview|null}{
 const operation=GOOGLE_TASKS_OPERATIONS.find(op=>op.operationId===operationId);if(!operation)throw new Error('productivity_operation_invalid');
 const accountId=text(input.accountId,'account',128);if(!/^[A-Za-z0-9_-]+$/.test(accountId))throw new Error('productivity_account_invalid');
 const write=operation.method==='POST';
 const allowed=new Set(['accountId',...(operationId==='list_tasklists'?[]:['tasklist']),...(operationId==='get_task'?['id']:[]),...(write?['title','notes','dueDate']:operationId==='get_task'?[]:['pageToken'])]);
 if(Object.keys(input).some(key=>!allowed.has(key)))throw new Error('productivity_argument_invalid');
 let path=operation.path;
 if(operationId!=='list_tasklists')path=path.replace('{tasklist}',resourceId(input.tasklist,'tasklist'));
 if(operationId==='get_task')path=path.replace('{id}',resourceId(input.id,'id'));
 const query:Record<string,string>={};
 if(operationId.startsWith('list_'))query.maxResults='100';
 if(input.pageToken!==undefined)query.pageToken=text(input.pageToken,'page_token',2048);
 const url=new URL(path,origin);for(const [key,value] of Object.entries(query))url.searchParams.set(key,value);
 let body:Record<string,unknown>|undefined,preview:EffectPreview|null=null;
 if(write){
  body={title:text(input.title,'title',1024)};
  if(input.notes!==undefined){if(typeof input.notes!=='string'||input.notes.length>8192)throw new Error('productivity_notes_invalid');body.notes=input.notes;}
  if(input.dueDate!==undefined){const due=text(input.dueDate,'due_date',10);if(!/^\d{4}-\d{2}-\d{2}$/.test(due)||!Number.isFinite(Date.parse(due))||new Date(due).toISOString().slice(0,10)!==due)throw new Error('productivity_due_date_invalid');body.due=`${due}T00:00:00.000Z`;}
  const fields={tasklist:input.tasklist,...body};const base={schemaVersion:1 as const,serviceId:operation.serviceId,operationId,accountId,action:'create_task',object:String(input.tasklist),fields,irreversibility:'irreversible_no_rollback' as const,cost:'unknown' as const};
  preview={...base,previewDigest:hash(base)};
 }
 const base={schemaVersion:1 as const,operationId,capabilityId:operation.id,serviceId:operation.serviceId,method:operation.method,url:url.href,origin,path,query,...(body?{body}:{}),accountId,previewDigest:preview?.previewDigest??'none_read',limits:{timeoutMs:15000,maxOutputBytes:131072}};
 return {operation,prepared:{...base,callDigest:hash(base)},preview};
}
export function verifyGoogleTasks(prepared:PreparedProductivityCall):ProductivityOperation{
 const match=/^\/tasks\/v1\/lists\/([^/]+)\/tasks(?:\/([^/]+))?$/.exec(prepared.path);
 const params:Record<string,unknown>={accountId:prepared.accountId,...(match?{tasklist:decodeURIComponent(match[1]!)}:{}),...(match?.[2]?{id:decodeURIComponent(match[2])}:{}),...(prepared.query.pageToken?{pageToken:prepared.query.pageToken}:{})};
 if(prepared.body){params.title=prepared.body.title;if(prepared.body.notes!==undefined)params.notes=prepared.body.notes;if(prepared.body.due!==undefined)params.dueDate=String(prepared.body.due).slice(0,10);}
 const expected=prepareGoogleTasks(prepared.operationId,params);
 if(canonicalStringify(prepared)!==canonicalStringify(expected.prepared))throw new Error('productivity_binding_changed');
 return expected.operation;
}
