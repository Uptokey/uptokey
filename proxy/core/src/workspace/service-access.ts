import {createHash,randomUUID} from 'node:crypto';
import {AsyncLocalStorage} from 'node:async_hooks';
import {validateServiceInput} from './service-schema-validation.ts';
import {parseServiceMutation,parseServicePlan,parseServiceView,type ServiceView,type ServiceMutation} from '@uptokey/sync-contract/service-access';
import {parseCapabilityDescriptor,parseExecutionPlan,canonicalContextSnapshotPayload,validatePlanBindings,type CapabilityDescriptor,type ExecutionPlan,type JsonData} from '@uptokey/sync-contract/workflow';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {ALL_CURATED_OPERATIONS} from '../../../integracoes/api-instruments/src/index.ts';
import {prepareApiCall,publicHttpsFetch} from '../../../integracoes/api-instruments/src/governed-transport.ts';
import type {ConnectionProfileService} from '../connection-profiles.ts';
import {assertNoSecretMaterial} from '../mcp-redact.ts';
import {computePlanDigest} from './planner.ts';
import type {WorkspaceStore} from './store.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';
import {serviceCatalog,type ServiceDefinition} from './service-catalog.ts';
import {RemoteMcpClient,RemoteMcpError,safeRemoteValue,type RemoteTool} from './remote-mcp.ts';
import type {ServiceAccessStorage,ServiceRecord} from './service-access-store.ts';

export interface ServiceAccessOptions {
 storage:ServiceAccessStorage;profiles:()=>ConnectionProfileService|undefined;active:(principal:string)=>Promise<boolean>;
 /** Injectable transport for isolated tests; production uses DNS-pinned public HTTPS. */
 fetchFn?:typeof fetch;catalog?:()=>ServiceDefinition[];
}
const safeCode=(error:unknown)=>error instanceof Error&&/^service_[a-z_]+$/.test(error.message)?error.message:'service_unavailable';
export class ServiceAccessError extends Error {readonly status:number;constructor(code:string){super(code);this.status=code==='service_not_found'?404:code==='service_revision_conflict'||code==='service_schema_changed'?409:code==='service_auth_invalid'?401:code==='service_permission_denied'||code==='service_disabled'||code==='service_removed'?403:code==='service_rate_limited'?429:code==='service_unavailable'?503:400;}}
const json=(value:unknown)=>JSON.parse(JSON.stringify(value)) as JsonData;
const definitions=(options:ServiceAccessOptions)=>(options.catalog??serviceCatalog)();

/** One access owner around existing credentials and the existing W5 executor. */
export class WorkspaceServiceAccess {
 private readonly authorities=new AsyncLocalStorage<{active:boolean;admit:()=>Promise<void>}>();
 private readonly options:ServiceAccessOptions;
 private control:{active:Map<string,Set<AbortController>>;closed:boolean};
 constructor(options:ServiceAccessOptions,control={active:new Map<string,Set<AbortController>>(),closed:false}){this.options=options;this.control=control;}
 fork(definition:ServiceDefinition){return new WorkspaceServiceAccess({...this.options,catalog:()=>[definition]},this.control);}
 private definition(id:string){const result=definitions(this.options).find(item=>item.id===id);if(!result)throw new ServiceAccessError('service_not_found');return result;}
 private key(principal:string,id:string){return `${principal}\0${id}`;}
 private async admit(principal:string){const authority=this.authorities.getStore();if(this.control.closed||authority?.active===false||!await this.options.active(principal))throw new ServiceAccessError('service_cancelled');await authority?.admit();if(authority&&!authority.active)throw new ServiceAccessError('service_cancelled');}
 private cancel(_principal:string,id:string){for(const [key,controllers] of this.control.active)if(key.endsWith('\0'+id))for(const controller of controllers)controller.abort();}
 close(){this.control.closed=true;for(const controllers of this.control.active.values())for(const controller of controllers)controller.abort();}
 private operation(principal:string,id:string,signal?:AbortSignal){
  const key=this.key(principal,id),controller=new AbortController(),controllers=this.control.active.get(key)??new Set<AbortController>();controllers.add(controller);this.control.active.set(key,controllers);
  return {signal:signal?AbortSignal.any([signal,controller.signal]):controller.signal,done:()=>{controllers.delete(controller);if(!controllers.size)this.control.active.delete(key);}};
 }
 async list(principal:string){await this.admit(principal);return {schemaVersion:1 as const,services:await Promise.all(definitions(this.options).map(item=>this.view(principal,item.id)))};}
 private storagePrincipal(principal:string,id:string){const definition=this.definition(id);return definition.scope==='device'&&definition.kind==='api'&&definition.auth==='none'?'device:public-service-access':principal;}
 private async accounts(definition:ServiceDefinition){
  const profiles=this.options.profiles();if(!profiles||definition.auth!=='api-key')return [];
  return (await profiles.list()).filter(profile=>profile.providerId===`service-${definition.id}`&&profile.endpointUrl===definition.endpointUrl&&profile.accessMode==='byok');
 }
 async view(principal:string,id:string):Promise<ServiceView>{
  await this.admit(principal);const definition=this.definition(id),record=await this.options.storage.read(this.storagePrincipal(principal,id),id),profiles=this.options.profiles(),accounts=await this.accounts(definition);
  const profile=record?.connectionId?await profiles?.get(record.connectionId):!record?.removed&&accounts.length===1?accounts[0]:undefined;
  const credentialPresent=!!profile&&profile.providerId===`service-${id}`&&profile.endpointUrl===definition.endpointUrl&&await profiles!.credentialPresent(profile);
  const enabled=(record?.enabled??true)&&profile?.enabled!==false;
  const stale=definition.executable===false||credentialPresent&&record?.connectionId!==undefined&&(profile!.revision!==record.connectionRevision||definition.bindingDigest!==undefined&&record.bindingDigest!==definition.bindingDigest);
  const state=record?.removed?'removed':!enabled?'disabled':stale?'error':(definition.kind==='api'||definition.kind==='tool')&&definition.auth==='none'?'ready':definition.kind==='mcp'&&credentialPresent&&profile?.enabled&&profile.revision===record?.connectionRevision&&record?.tools?.length?'ready':credentialPresent?'configured':'unconfigured';
  const {apiOperations,apiAuth,bindingDigest,revalidate,executable,...publicDefinition}=definition;
  await this.admit(principal);
  return parseServiceView({...publicDefinition,label:record?.label??definition.label,revision:record?.revision??0,state,enabled:enabled&&!record?.removed,connectionId:profile?.id??null,credentialPresent,connections:await Promise.all(accounts.map(async account=>({id:account.id,label:account.label,enabled:account.enabled,credentialPresent:await profiles!.credentialPresent(account)}))),operations:definition.kind==='mcp'?(state==='ready'?record!.tools!.map(tool=>({id:tool.name,label:tool.name,effect:tool.effect,inputSchema:tool.inputSchema})):[]):definition.operations,errorCode:stale?'service_revision_conflict':null});
 }
 private async check(principal:string,id:string,revision:number,signal?:AbortSignal,requireEnabled=true){
  signal?.throwIfAborted();await this.admit(principal);const record=await this.options.storage.read(this.storagePrincipal(principal,id),id);signal?.throwIfAborted();
  if((record?.revision??0)!==revision)throw new ServiceAccessError('service_revision_conflict');
  if(requireEnabled&&record?.removed)throw new ServiceAccessError('service_removed');if(requireEnabled&&record?.enabled===false)throw new ServiceAccessError('service_disabled');return record;
 }
 async mutate(principal:string,id:string,kind:'configure'|'discover'|'update'|'remove',raw:unknown,admission?:()=>Promise<void>):Promise<ServiceView>{
  if(admission){const authority={active:true,admit:admission};return this.authorities.run(authority,async()=>{try{return await this.mutate(principal,id,kind,raw);}finally{authority.active=false;}});}
  try{
   const definition=this.definition(id),input=parseServiceMutation(raw,kind);await this.admit(principal);
   if(definition.kind==='channel'||definition.kind==='productivity'||definition.kind==='tool')throw new ServiceAccessError('service_scope_required');
   if(kind==='configure'||kind==='discover'||kind==='update'&&input.enabled===true)await definition.revalidate?.();
   if(kind==='configure'||kind==='discover')return await this.configure(principal,definition,input,kind==='discover');
   await this.check(principal,id,input.expectedRevision,undefined,false);this.cancel(principal,id);
   await this.options.storage.transaction(this.storagePrincipal(principal,id),id,input.expectedRevision,async(current,commit)=>{
    await this.admit(principal);
    const next:ServiceRecord={...current,revision:input.expectedRevision+1,enabled:kind==='remove'?false:input.enabled??current?.enabled??true,removed:kind==='remove',...(input.label?{label:input.label.trim()}:{})};
    const profiles=this.options.profiles(),accounts=await this.accounts(definition),profile=current?.connectionId?await profiles?.get(current.connectionId):accounts.length===1?accounts[0]:undefined;
    if(profile&&profile.providerId===`service-${id}`){
     await profiles!.commitServiceProfile({id:profile.id,revision:profile.revision,providerId:profile.providerId,endpointUrl:profile.endpointUrl!,label:input.label?.trim()??profile.label,enabled:next.enabled,remove:kind==='remove'},()=>this.admit(principal),async changed=>{
      if(!changed){delete next.connectionId;delete next.connectionRevision;delete next.tools;}else next.connectionRevision=changed.revision;
      await commit(next,()=>this.admit(principal));
     });
    }else await commit(next,()=>this.admit(principal));
   });
   return this.view(principal,id);
  }catch(error){throw new ServiceAccessError(safeCode(error));}
 }
 private async configure(principal:string,definition:ServiceDefinition,input:ServiceMutation,discover:boolean){
  const id=definition.id;await this.check(principal,id,input.expectedRevision,undefined,false);
  if(definition.kind==='api'&&definition.auth==='none'){
   if(input.credential!==undefined)throw new ServiceAccessError('service_input_invalid');
   await this.options.storage.transaction(this.storagePrincipal(principal,id),id,input.expectedRevision,async(current,commit)=>{await commit({...current,revision:input.expectedRevision+1,enabled:true,removed:false,...(input.label?{label:input.label.trim()}:{})},()=>this.admit(principal));});return this.view(principal,id);
  }
  if(!['mcp','api'].includes(definition.kind)||!definition.endpointUrl)throw new ServiceAccessError('service_unavailable');
  const profiles=this.options.profiles();if(!profiles)throw new ServiceAccessError('service_unavailable');
  const current=await this.options.storage.read(this.storagePrincipal(principal,id),id),accounts=await this.accounts(definition);
  const selected=input.connectionId??current?.connectionId??(accounts.length===1?accounts[0]!.id:undefined),profile=selected?await profiles.get(selected):undefined;
  if(input.connectionId&&!accounts.some(account=>account.id===input.connectionId))throw new ServiceAccessError('service_input_invalid');
  if(!selected&&accounts.length>1&&!input.credential)throw new ServiceAccessError('service_account_required');
  if(profile&&(profile.providerId!==`service-${id}`||profile.endpointUrl!==definition.endpointUrl))throw new ServiceAccessError('service_unavailable');
  const credential=input.credential??(profile?await profiles.readCredential(profile):null);if(!credential)throw new ServiceAccessError('service_auth_invalid');
  const operation=this.operation(principal,id);
  try{
   const guard=async()=>{await this.check(principal,id,input.expectedRevision,operation.signal,false);await definition.revalidate?.();if(profile){const latest=await profiles.get(profile.id);if(!latest||latest.revision!==profile.revision)throw new ServiceAccessError('service_revision_conflict');}};
   const tools=definition.kind==='mcp'?await new RemoteMcpClient(definition.endpointUrl,this.options.fetchFn).discover(credential,operation.signal,guard):undefined;
   if(tools&&!tools.length)throw new ServiceAccessError('service_discovery_failed');
   await guard();
   await this.options.storage.transaction(this.storagePrincipal(principal,id),id,input.expectedRevision,async(record,commit)=>{
    await guard();const commitGuard=async()=>{operation.signal.throwIfAborted();await this.admit(principal);await definition.revalidate?.();};
    if(profile&&profile.enabled&&input.credential===undefined&&(!input.label||input.label.trim()===profile.label)){
     // Adopting an already authorized local account does not rotate its revision or copy its secret.
     await guard();await commit({...record,revision:input.expectedRevision+1,enabled:true,removed:false,connectionId:profile.id,connectionRevision:profile.revision,...(definition.bindingDigest?{bindingDigest:definition.bindingDigest}:{}),...(tools?{tools}:{}),label:input.label?.trim()??record?.label??profile.label},commitGuard);return;
    }
    await profiles.commitServiceProfile({...(profile?{id:profile.id,revision:profile.revision}:{}),providerId:`service-${id}`,endpointUrl:definition.endpointUrl!,label:input.label?.trim()??profile?.label??definition.label,enabled:true,credential},commitGuard,async nextProfile=>{
     await commit({...record,revision:input.expectedRevision+1,enabled:true,removed:false,...(input.label||record?.label?{label:input.label?.trim()??record?.label}:{}),connectionId:nextProfile!.id,connectionRevision:nextProfile!.revision,...(tools?{tools}:{}),...(definition.bindingDigest?{bindingDigest:definition.bindingDigest}:{})},commitGuard);
    });
   });
   return this.view(principal,id);
  }finally{operation.done();}
 }
 capabilities():CapabilityDescriptor[]{return definitions(this.options).filter(item=>item.kind==='mcp').flatMap(item=>(['read_external','write_external'] as const).map(effect=>parseCapabilityDescriptor({schemaVersion:1,id:`service.${item.id}.${effect==='read_external'?'read':'write'}`,createdAt:'2026-10-06T00:00:00.000Z',version:1,titleKey:'ws_service',descriptionKey:'ws_service',tags:['service'],inputSchemaId:'workspace.service.request',outputSchemaId:'workspace.service.result',effect,dataDestination:{kind:'provider',id:item.id},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass:'never_automatic',limits:{maxSteps:1,maxCalls:1,maxOutputTokens:1,maxOutputBytes:1048576,timeoutMs:120000}})));}
 private async validate(schema:Record<string,unknown>,parameters:Record<string,unknown>){
  assertNoSecretMaterial(parameters);if(JSON.stringify(parameters).length>65536)throw new ServiceAccessError('service_input_invalid');
  try{await validateServiceInput(schema,parameters);}catch{throw new ServiceAccessError('service_input_invalid');}
 }
 async prepare(store:WorkspaceStore,principal:string,projectId:string,raw:unknown){
  const input=parseServicePlan(raw),definition=this.definition(input.serviceId),view=await this.view(principal,input.serviceId);
  await definition.revalidate?.();
  if(view.revision!==input.serviceRevision)throw new ServiceAccessError('service_revision_conflict');if(view.state!=='ready'&&!(definition.apiAuth&&view.state==='configured'&&view.credentialPresent))throw new ServiceAccessError(view.state==='removed'?'service_removed':view.state==='disabled'?'service_disabled':'service_unavailable');
  const operation=view.operations.find(item=>item.id===input.operationId);if(!operation)throw new ServiceAccessError('service_operation_invalid');await this.validate(operation.inputSchema,input.parameters);
  const project=await store.getProject(principal,projectId);if(project.revision!==input.expectedRevision)throw new Error('workspace_revision_conflict');
  const record=await this.check(principal,input.serviceId,input.serviceRevision);
  const binding={serviceId:input.serviceId,serviceRevision:input.serviceRevision,...(definition.apiAuth?{connectionId:record?.connectionId,connectionRevision:record?.connectionRevision,bindingDigest:definition.bindingDigest}:{})};let capability:CapabilityDescriptor,argumentsValue:ExecutionPlan['steps'][number]['arguments'];
  if(definition.kind==='api'){
   const op=(definition.apiOperations??ALL_CURATED_OPERATIONS.filter(item=>item.serviceId===definition.id)).find(item=>item.id===input.operationId);if(!op)throw new ServiceAccessError('service_operation_invalid');
   if(definition.apiAuth&&record?.bindingDigest!==definition.bindingDigest)throw new ServiceAccessError('service_schema_changed');
   capability=op.capability;argumentsValue={prepared_call:{kind:'literal',value:json(prepareApiCall(op,input.parameters))},service_binding:{kind:'literal',value:binding}};
  }else if(definition.kind==='mcp'){
   const record=await this.check(principal,input.serviceId,input.serviceRevision),tool=record?.tools?.find(item=>item.name===input.operationId);if(!tool)throw new ServiceAccessError('service_operation_invalid');
   capability=this.capabilities().find(item=>item.id===`service.${definition.id}.${tool.effect==='read_external'?'read':'write'}`)!;
   argumentsValue={request:{kind:'literal',value:json({...binding,connectionId:record!.connectionId,connectionRevision:record!.connectionRevision,tool:tool.name,schemaDigest:tool.digest,parameters:input.parameters})}};
  }else throw new ServiceAccessError('service_scope_required');
  const snapshot=await store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:[],excludedEntryIds:project.entries.map(item=>item.id),allowedDestinations:[capability.dataDestination],maxContextBytes:32000});
  let plan:ExecutionPlan={schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),projectId,projectRevision:project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),steps:[{id:'execute_service',capabilityId:capability.id,capabilityVersion:capability.version,arguments:argumentsValue}],limits:{...capability.limits},digest:'0'.repeat(64)};
  plan=parseExecutionPlan({...plan,digest:computePlanDigest(plan)});validatePlanBindings(plan,snapshot,[capability]);await this.check(principal,input.serviceId,input.serviceRevision);await store.putPlan(principal,plan,snapshot);return plan;
 }
 /** Applied also to old API-instrument entry points, so disabling is not a cosmetic card setting. */
 async apiGuard(request:EffectRequest){
  const op=ALL_CURATED_OPERATIONS.find(item=>item.id===request.capability.id);if(!op)return;
  const binding=request.arguments.service_binding;
  if(binding&&binding.kind!=='literal')throw new ServiceAccessError('service_input_invalid');
  const value=binding?.kind==='literal' ? binding.value as {serviceId?:string;serviceRevision?:number} : undefined;
  if(value&&(value.serviceId!==op.serviceId||!Number.isSafeInteger(value.serviceRevision)))throw new ServiceAccessError('service_input_invalid');
  const record=await this.options.storage.read(this.storagePrincipal(request.principalId,op.serviceId),op.serviceId);
  await this.check(request.principalId,op.serviceId,value?.serviceRevision??record?.revision??0,request.signal);
 }
 async dispatchPublic(request:EffectRequest,dispatch:(request:EffectRequest)=>Promise<EffectOutcome>):Promise<EffectOutcome>{
  const op=ALL_CURATED_OPERATIONS.find(item=>item.id===request.capability.id);if(!op)return dispatch(request);
  const operation=this.operation(request.principalId,op.serviceId,request.signal);
  const scoped={...request,signal:operation.signal};
  let dispatched=false;
  try{await this.apiGuard(scoped);dispatched=true;const outcome=await dispatch(scoped);await this.apiGuard(scoped);return outcome;}
  catch(error){return dispatched?{kind:'failed',code:operation.signal.aborted?'service_cancelled':safeCode(error),sent:'unknown'}:{kind:'not_sent',code:safeCode(error)};}
  finally{operation.done();}
 }
 /** The credential is injected only inside the approved read, never into its plan or returned view. */
 async dispatchAuthenticated(request:EffectRequest,dispatch:(request:EffectRequest,fetchFn:typeof fetch,guard:()=>Promise<void>)=>Promise<EffectOutcome>):Promise<EffectOutcome>{
  let sent=false;const definition=definitions(this.options)[0]!;
  const operation=this.operation(request.principalId,definition.id,request.signal),profiles=this.options.profiles();
  try{
   if(!definition.apiAuth||!profiles)throw new ServiceAccessError('service_unavailable');
   const binding=request.arguments.service_binding;
   if(binding?.kind!=='literal'||!binding.value||typeof binding.value!=='object'||Array.isArray(binding.value))throw new ServiceAccessError('service_admission_invalid');
   const value=binding.value as {serviceId:string;serviceRevision:number;connectionId:string;connectionRevision:number;bindingDigest:string};
   if(value.serviceId!==definition.id||value.bindingDigest!==definition.bindingDigest)throw new ServiceAccessError('service_schema_changed');
   const guard=async()=>{
    const record=await this.check(request.principalId,definition.id,value.serviceRevision,operation.signal);await definition.revalidate?.();
    if(record?.connectionId!==value.connectionId||record.connectionRevision!==value.connectionRevision||record.bindingDigest!==definition.bindingDigest)throw new ServiceAccessError('service_revision_conflict');
    const profile=await profiles.get(value.connectionId);if(!profile?.enabled||profile.revision!==value.connectionRevision||profile.providerId!==`service-${definition.id}`||profile.endpointUrl!==definition.endpointUrl)throw new ServiceAccessError('service_revision_conflict');
    await request.dispatchGate?.validate(operation.signal);operation.signal.throwIfAborted();
   };
   await guard();const profile=await profiles.get(value.connectionId),secret=profile?await profiles.readCredential(profile):null;if(!secret)throw new ServiceAccessError('service_auth_invalid');await guard();
   const prepared=request.arguments.prepared_call;
   if(prepared?.kind!=='literal'||!prepared.value||typeof prepared.value!=='object'||Array.isArray(prepared.value))throw new ServiceAccessError('service_admission_invalid');
   const expectedUrl=(prepared.value as {url:string}).url;
   const fetchFn=((async(input:RequestInfo|URL,init:RequestInit={})=>{
    if(String(input)!==expectedUrl||new URL(String(input)).origin!==new URL(definition.endpointUrl!).origin||init.method!=='GET')throw new ServiceAccessError('service_destination_denied');
    await guard();const headers=new Headers(init.headers);headers.set(definition.apiAuth!.kind==='bearer'?'authorization':definition.apiAuth!.headerName,definition.apiAuth!.kind==='bearer'?`Bearer ${secret}`:secret);
    sent=true;const response=await (this.options.fetchFn??publicHttpsFetch)(input,{...init,headers,redirect:'error',credentials:'omit',signal:init.signal?AbortSignal.any([operation.signal,init.signal]):operation.signal});
    try{await guard();}catch(error){await response.body?.cancel();throw error;}return response;
   }) as typeof fetch);
   const outcome=await dispatch({...request,signal:operation.signal},fetchFn,guard);await guard();
   if(outcome.kind==='completed'||outcome.kind==='pending')return {...outcome,artifacts:outcome.artifacts?.map(artifact=>({...artifact,bytes:new TextEncoder().encode(JSON.stringify(safeRemoteValue(JSON.parse(new TextDecoder().decode(artifact.bytes)),secret)))}))};
   return outcome;
  }catch(error){return sent?{kind:'failed',code:operation.signal.aborted?'service_cancelled':safeCode(error),sent:'unknown'}:{kind:'not_sent',code:safeCode(error)};}
  finally{operation.done();}
 }
 async dispatch(store:WorkspaceStore,request:EffectRequest):Promise<EffectOutcome>{
  let sent=false;let operation:ReturnType<WorkspaceServiceAccess['operation']>|undefined;
  try{
   const bundle=await store.getBundle(request.principalId,request.projectId),run=bundle.runs.find(item=>item.run.id===request.runId&&item.run.principalId===request.principalId);
   const plan=bundle.plans.find(item=>item.id===run?.run.planId&&item.digest===run.run.planDigest),step=plan?.steps.find(item=>item.id===request.stepId);
   if(run?.run.status!=='running'||!step||step.capabilityId!==request.capability.id||!run.receipts.some(item=>item.attemptId===request.attemptId&&item.stepId===request.stepId&&item.status==='dispatched')||canonicalJson(step.arguments)!==canonicalJson(request.arguments))throw new ServiceAccessError('service_admission_invalid');
   const data=request.arguments.request;if(data?.kind!=='literal'||!data.value||typeof data.value!=='object'||Array.isArray(data.value))throw new ServiceAccessError('service_input_invalid');
   const value=data.value as unknown as {serviceId:string;serviceRevision:number;connectionId:string;connectionRevision:number;tool:string;schemaDigest:string;parameters:Record<string,unknown>};
   const definition=this.definition(value.serviceId);if(definition.kind!=='mcp'||!definition.endpointUrl)throw new ServiceAccessError('service_input_invalid');
   const record=await this.check(request.principalId,value.serviceId,value.serviceRevision,request.signal),tool=record?.tools?.find(item=>item.name===value.tool&&item.digest===value.schemaDigest);
   if(!tool||record?.connectionId!==value.connectionId||record?.connectionRevision!==value.connectionRevision||request.capability.id!==`service.${value.serviceId}.${tool.effect==='read_external'?'read':'write'}`)throw new ServiceAccessError('service_schema_changed');
   await this.validate(tool.inputSchema,value.parameters);operation=this.operation(request.principalId,value.serviceId,request.signal);
   const profiles=this.options.profiles();if(!profiles)throw new ServiceAccessError('service_unavailable');
   const guard=async()=>{await this.check(request.principalId,value.serviceId,value.serviceRevision,operation!.signal);await request.dispatchGate?.validate(operation!.signal);const current=await profiles.get(value.connectionId);if(!current?.enabled||current.revision!==value.connectionRevision||current.providerId!==`service-${value.serviceId}`||current.endpointUrl!==definition.endpointUrl)throw new ServiceAccessError('service_revision_conflict');if(Date.parse(request.deadlineAt)<=Date.now())throw new ServiceAccessError('service_cancelled');};
   await guard();const profile=await profiles.get(value.connectionId),secret=profile?await profiles.readCredential(profile):null;if(!secret)throw new ServiceAccessError('service_auth_invalid');await guard();
   const result=await new RemoteMcpClient(definition.endpointUrl,this.options.fetchFn).call(secret,tool,value.parameters,operation.signal,guard);sent=true;await guard();
   const bytes=new TextEncoder().encode(JSON.stringify(result));if(bytes.byteLength>request.limits.maxOutputBytes)throw new ServiceAccessError('service_response_too_large');
   const artifactId=randomUUID();return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes}],outputArtifactRefs:[artifactId]};
  }catch(error){const uncertain=sent||error instanceof RemoteMcpError&&error.sent;return uncertain?{kind:'failed',code:safeCode(error),sent:'unknown'}:{kind:'not_sent',code:safeCode(error)};}
  finally{operation?.done();}
 }
}
