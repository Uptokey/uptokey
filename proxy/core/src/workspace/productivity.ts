import { GOOGLE_TASKS_OPERATIONS, GOOGLE_TASKS_READ_SCOPE, GOOGLE_TASKS_SCOPE, GOOGLE_TASKS_DOCUMENTATION, prepareGoogleTasks, verifyGoogleTasks } from "../../../integracoes/api-instruments/src/productivity/google-tasks.ts";
import { RESEND_OPERATIONS, RESEND_DOCUMENTATION, prepareResend, verifyResend } from "../../../integracoes/api-instruments/src/productivity/resend.ts";
import { createProvisionalProductivityPlan } from "../../../integracoes/api-instruments/src/productivity/plans.ts";
import { createProductivityDispatcher } from "../../../integracoes/api-instruments/src/productivity/dispatch.ts";
import type { ProductivityOperation, PreparedProductivityCall, EffectPreview } from "../../../integracoes/api-instruments/src/productivity/operations.ts";
import type {WorkspaceStore} from './store.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';
export interface ProductivityAccount {accountId:string;label:string;scopes:string[];state:string}
export interface ProductivityOptions {
  listAccounts(principal:string):Promise<ProductivityAccount[]>;
  acquireCredential(principal:string,accountId:string,requiredScopes:string[],signal:AbortSignal):Promise<string>;
  fetchFn?:typeof fetch;
}

type PreparedProductivityLike = { prepared: PreparedProductivityCall; operation: ProductivityOperation; preview: EffectPreview | null };
type ProductivityService = {
  serviceId: 'google_tasks' | 'resend';
  operations: readonly ProductivityOperation[];
  documentation: string;
  prepare: (operationId: string, input: Record<string, unknown>) => PreparedProductivityLike;
  verify: (prepared: PreparedProductivityCall) => ProductivityOperation;
  scope: (account: ProductivityAccount, write: boolean) => void;
};
const SERVICES: readonly ProductivityService[] = [
  { serviceId: 'google_tasks', operations: GOOGLE_TASKS_OPERATIONS, documentation: GOOGLE_TASKS_DOCUMENTATION, prepare: prepareGoogleTasks as ProductivityService['prepare'], verify: verifyGoogleTasks,
    scope: (account, write) => {
      const granted = account.scopes.includes(GOOGLE_TASKS_SCOPE) ? GOOGLE_TASKS_SCOPE : GOOGLE_TASKS_READ_SCOPE;
      if (write && granted !== GOOGLE_TASKS_SCOPE) throw new Error('productivity_scope_denied');
      if (!account.scopes.includes(granted)) throw new Error('productivity_scope_denied');
    } },
  { serviceId: 'resend', operations: RESEND_OPERATIONS, documentation: RESEND_DOCUMENTATION, prepare: prepareResend as ProductivityService['prepare'], verify: verifyResend,
    scope: () => { /* Resend usa chave de API no cofre; sem escopos OAuth a conferir. */ } },
];
const ALL_OPERATIONS = SERVICES.flatMap(service => service.operations);
const serviceFor = (operationId: string) => SERVICES.find(service => service.operations.some(op => op.operationId === operationId));

export class WorkspaceProductivity {
  private options?:ProductivityOptions;
  constructor(options?:ProductivityOptions){this.options=options;}
  capabilities(){return this.options?ALL_OPERATIONS.map(op=>op.capability):[];}
  async info(principal:string){return {configured:!!this.options,
    services:SERVICES.map(service=>({serviceId:service.serviceId,documentation:service.documentation,operations:service.operations.map(op=>({id:op.operationId,title:op.summary,effect:op.effectClass,idempotency:op.idempotencySupport}))})),
    documentation:GOOGLE_TASKS_DOCUMENTATION,accounts:this.options?await this.options.listAccounts(principal):[],operations:ALL_OPERATIONS.map(op=>({id:op.operationId,title:op.summary,effect:op.effectClass,idempotency:op.idempotencySupport}))};}
  async prepare(store:WorkspaceStore,principal:string,projectId:string,input:unknown){
   if(!this.options)throw new Error('productivity_unavailable');
   if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('productivity_input_invalid');
   const value=input as Record<string,unknown>;if(Object.keys(value).some(key=>!['expectedRevision','operationId','parameters'].includes(key))||typeof value.operationId!=='string'||!value.parameters||typeof value.parameters!=='object'||Array.isArray(value.parameters))throw new Error('productivity_input_invalid');
   const service=serviceFor(value.operationId);if(!service)throw new Error('productivity_operation_invalid');
   const bundle=await store.getBundle(principal,projectId);if(bundle.project.revision!==value.expectedRevision)throw new Error('workspace_revision_conflict');
   const prepared=service.prepare(value.operationId,value.parameters as Record<string,unknown>);
   await this.account(principal,prepared.prepared.accountId,prepared.operation.method==='POST',service);
   return createProvisionalProductivityPlan(store,principal,projectId,prepared.operation,prepared.prepared,prepared.preview);
  }
  private async account(principal:string,id:string,write:boolean,service:ProductivityService){
   const account=(await this.options!.listAccounts(principal)).find(item=>item.accountId===id);
   if(!account||account.state!=='active')throw new Error('productivity_account_unavailable');
   service.scope(account,write);
   return account;
  }
  async dispatch(store:WorkspaceStore,request:EffectRequest):Promise<EffectOutcome>{
   if(!this.options)return {kind:'not_sent',code:'productivity_unavailable'};
   const options=this.options;
   const service=SERVICES.find(item=>item.operations.some(op=>op.id===request.capability.id&&op.capability.version===request.capability.version));
   if(!service)return {kind:'not_sent',code:'productivity_unavailable'};
   const dispatcher=createProductivityDispatcher({operations:[...service.operations],verifyPrepared:service.verify,fetchFn:options.fetchFn,
    getBearer:async(accountId,req,op)=>{const account=await this.account(req.principalId,accountId,op.method==='POST',service);const scopes=service.serviceId==='google_tasks'?(account.scopes.includes(GOOGLE_TASKS_SCOPE)?[GOOGLE_TASKS_SCOPE]:[GOOGLE_TASKS_READ_SCOPE]):[];return {accountId,token:await options.acquireCredential(req.principalId,accountId,scopes,req.signal)};},
    getGrant:async(principal,projectId)=>await store.getGrant(principal,projectId)??null,
    getAdmission:async(principal,projectId,runId,stepId,attemptId)=>{
     const bundle=await store.getBundle(principal,projectId),record=await store.readRun(principal,projectId,runId);
     if(!record)return null;const plan=bundle.plans.find(p=>p.id===record.run.planId&&p.digest===record.run.planDigest),step=plan?.steps.find(s=>s.id===stepId&&s.capabilityId===request.capability.id&&s.capabilityVersion===request.capability.version);
     const dispatched=record.receipts.some(e=>e.status==='dispatched'&&e.stepId===stepId&&e.attemptId===attemptId&&e.capabilityId===request.capability.id&&e.capabilityVersion===request.capability.version);
     if(!plan||!step||!dispatched)return null;
     return {running:record.run.status==='running',planDigest:plan.digest,planMaxOutputBytes:plan.limits.maxOutputBytes,stepArguments:step.arguments};
    }});
   return dispatcher.dispatch(request);
  }
}
