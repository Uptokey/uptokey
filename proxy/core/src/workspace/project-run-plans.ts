import {createHash,randomUUID} from 'node:crypto';
import {canonicalContextSnapshotPayload,parseCapabilityDescriptor,parseExecutionPlan,validatePlanBindings,type ExecutionPlan} from '@uptokey/sync-contract/workflow';
import {parseProjectRunRequest,parseProjectFileManifest,parseProjectVerificationReport,computeProjectChangeSetDigest,isSafeRelativePath,type ProjectChangeOperation} from '@uptokey/sync-contract/project-agent';
import {isProtectedProjectPath} from './project-root-service.ts';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {computePlanDigest} from './planner.ts';
import {WorkspaceError,type WorkspaceRuntime} from './runtime.ts';
import type {EffectRequest,EffectOutcome,EffectArtifact} from './executor.ts';
import {isArtifactCodeAction,artifactCodeSnapshot,type ArtifactCodeInput} from './project-artifact-verification.ts';

export const PROJECT_RUN_CAPABILITY=parseCapabilityDescriptor({schemaVersion:1,id:'workspace.project.run',version:1,createdAt:'2026-09-20T00:00:00.000Z',
 titleKey:'ws_project_run',descriptionKey:'ws_project_run_scope',tags:['project','execution'],inputSchemaId:'workspace.project.run.input.v1',outputSchemaId:'workspace.project.run.output.v1',
 effect:'execute_local',dataDestination:{kind:'local',id:'project_sandbox'},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute','project:process:run'],retryClass:'never_automatic',
 limits:{maxSteps:1,maxCalls:1,maxOutputTokens:4096,timeoutMs:330000,maxOutputBytes:8388608}});

/** Separate destination: dependency download must never be admitted as an exclusively local effect. */
export const PROJECT_DEPENDENCY_RUN_CAPABILITY=parseCapabilityDescriptor({...PROJECT_RUN_CAPABILITY,
 id:'workspace.project.dependency-run',effect:'read_external',dataDestination:{kind:'public_source',id:'project_dependencies'},
 titleKey:'ws_project_dependency_run',descriptionKey:'ws_project_dependency_run_scope'});

/** Snapshot metadata and the observed runtime are inside the signed W5 plan. No executable is started here. */
export async function prepareProjectRun(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown,signal:AbortSignal){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,request,rootBindingId'||!Number.isSafeInteger(input.expectedRevision)||typeof input.rootBindingId!=='string')throw new WorkspaceError('invalid_request');
 const bundle=await runtime.store.getBundle(principal,projectId),project=bundle.project;
 if(project.revision!==input.expectedRevision)throw new WorkspaceError('workspace_revision_conflict',409);
 if(bundle.runs.some(item=>['running','needs_attention','ready','awaiting_approval'].includes(item.run.status)))throw new WorkspaceError('project_run_active',409);
 const request=parseProjectRunRequest(input.request);
 const capability=request.execution?.dependencies?.length?PROJECT_DEPENDENCY_RUN_CAPABILITY:PROJECT_RUN_CAPABILITY;
 if(request.execution?.outputPaths.some(p=>isProtectedProjectPath(p)))throw new WorkspaceError('runtime_output_path_protected',403);
 const artifactAction=isArtifactCodeAction(request.actionId);
 if(request.timeoutMs>300000||request.outputLimitBytes>1048576||(!artifactAction&&request.artifactInputRefs.length))throw new WorkspaceError('runtime_limits_invalid');
 const artifact=artifactAction?bundle.artifacts.find(item=>item.id===request.artifactInputRefs[0]):undefined;
 if(artifactAction&&(request.runtimeProfileId!=='node-app'||request.artifactInputRefs.length!==1||!artifact))throw new WorkspaceError('runtime_artifact_input_invalid');
 let artifactSnapshot;try{artifactSnapshot=artifact&&artifactCodeSnapshot(artifact);}catch(error){throw new WorkspaceError(error instanceof Error?error.message:'runtime_artifact_input_invalid');}
 const manifest=await runtime.getProjectManifest(principal,projectId,input.rootBindingId);
 if(manifest.snapshotDigest!==request.manifestDigest)throw new WorkspaceError('runtime_manifest_conflict',409);
 const profile=(await runtime.projectRunner.getAvailableProfiles()).find(p=>p.id===request.runtimeProfileId);
 if(!profile?.available)throw new WorkspaceError(profile?.diagnostic??'runtime_unavailable',503);
 if(!profile.defaultActions.includes(request.actionId)&&!(profile.id==='static-web'&&request.actionId==='preview'))throw new WorkspaceError('runtime_action_unavailable');
 signal.throwIfAborted();
 const snapshot=await runtime.store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:artifact?[artifact.id]:[],excludedEntryIds:project.entries.map(e=>e.id),allowedDestinations:[capability.dataDestination],maxContextBytes:artifact?Math.max(32000,artifact.byteLength):32000});
 let plan:ExecutionPlan={schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),projectId,projectRevision:project.revision,contextSnapshotId:snapshot.id,
  contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),
  steps:[{id:'execute',capabilityId:capability.id,capabilityVersion:1,arguments:{root_binding_id:{kind:'literal',value:input.rootBindingId},request:{kind:'literal',value:JSON.parse(JSON.stringify(request))},manifest:{kind:'literal',value:JSON.parse(JSON.stringify(manifest))},runtime_fingerprint:{kind:'literal',value:profile.runtime},...(artifactSnapshot?{artifact_snapshot:{kind:'literal' as const,value:JSON.parse(JSON.stringify(artifactSnapshot))}}:{})}}],
  limits:{...PROJECT_RUN_CAPABILITY.limits,timeoutMs:Math.min(330000,request.timeoutMs+30000)},digest:'0'.repeat(64)};
 plan=parseExecutionPlan({...plan,digest:computePlanDigest(plan)});validatePlanBindings(plan,snapshot,runtime.registry().forPlan(plan));
 await runtime.store.putPlan(principal,plan,snapshot);return runtime.viewPlan(principal,projectId,plan.id);
}

export async function dispatchProjectRun(runtime:WorkspaceRuntime,effect:EffectRequest):Promise<EffectOutcome>{
 const value=(key:string)=>effect.arguments[key]?.kind==='literal'?effect.arguments[key].value:undefined;
 const rootBindingId=value('root_binding_id');if(typeof rootBindingId!=='string')return {kind:'not_sent',code:'runtime_input_invalid'};
 let request,manifest;
 try{request=parseProjectRunRequest(value('request'));manifest=parseProjectFileManifest(value('manifest'));}catch{return {kind:'not_sent',code:'runtime_input_invalid'};}
 if(effect.capability.id!==(request.execution?.dependencies?.length?PROJECT_DEPENDENCY_RUN_CAPABILITY.id:PROJECT_RUN_CAPABILITY.id))return {kind:'not_sent',code:'runtime_destination_mismatch'};
 await runtime.projectRoot.ensureRootLoaded(rootBindingId,runtime.store,effect.principalId,effect.projectId);
 const current=await runtime.getProjectManifest(effect.principalId,effect.projectId,rootBindingId);
 if(current.snapshotDigest!==request.manifestDigest||manifest.snapshotDigest!==current.snapshotDigest||manifest.projectId!==effect.projectId||manifest.rootBindingId!==rootBindingId)return {kind:'not_sent',code:'runtime_manifest_conflict'};
 const profile=(await runtime.projectRunner.getAvailableProfiles()).find(p=>p.id===request.runtimeProfileId);
 if(!profile?.available||profile.runtime!==value('runtime_fingerprint'))return {kind:'not_sent',code:'runtime_profile_changed'};
 let artifact:ArtifactCodeInput|undefined;
 if(isArtifactCodeAction(request.actionId)){
  const bundle=await runtime.store.getBundle(effect.principalId,effect.projectId),stored=bundle.artifacts.find(item=>item.id===request.artifactInputRefs[0]);
  const sealed=value('artifact_snapshot');
  if(!stored||request.artifactInputRefs.length!==1||!isDataRecord(sealed)||sealed.id!==stored.id||sealed.sha256!==stored.sha256||sealed.byteLength!==stored.byteLength||sealed.mediaType!==stored.mediaType)return {kind:'not_sent',code:'runtime_artifact_hash_conflict'};
  artifact={...artifactCodeSnapshot(stored),bytes:await runtime.store.readArtifactRaw(effect.principalId,effect.projectId,stored.id,false)};
 }
 effect.signal.throwIfAborted();
 const outputs:{path:string;artifactId:string;sha256:string;byteLength:number;baseSha256:string|null;bytes:Uint8Array}[]=[];
 const assertAuthority=async()=>{
  effect.signal.throwIfAborted();await runtime.projectRoot.ensureRootLoaded(rootBindingId,runtime.store,effect.principalId,effect.projectId);
  const observed=await runtime.getProjectManifest(effect.principalId,effect.projectId,rootBindingId);
  if(observed.snapshotDigest!==manifest.snapshotDigest)throw new WorkspaceError('runtime_manifest_conflict',409);
  await effect.dispatchGate?.validate(effect.signal);effect.signal.throwIfAborted();
 };
 await assertAuthority();
 const result=request.actionId==='preview'
  ?await runtime.projectPreview.startPreview({taskId:request.taskId,rootBindingId,manifestDigest:manifest.snapshotDigest,runtimeProfileId:request.runtimeProfileId,allowedResourceIds:manifest.entries.filter(e=>e.kind==='file'&&e.sensitivity==='public').map(e=>e.relativePath),manifest,request,runId:effect.runId,signal:effect.signal,ttlSeconds:Math.min(300,Math.ceil(request.timeoutMs/1000))})
  :await runtime.projectRunner.runVerification({runId:effect.runId,rootBindingId,request,manifest,signal:effect.signal,artifact,runtimeFingerprint:profile.runtime,assertAuthority,
    collectOutput:(path,bytes)=>{const artifactId=randomUUID();outputs.push({path,artifactId,sha256:createHash('sha256').update(bytes).digest('hex'),byteLength:bytes.length,baseSha256:manifest.entries.find(e=>e.relativePath===path)?.sha256??null,bytes});return artifactId;}});
 const artifactId=randomUUID();
 if('checks' in result&&result.checks.some(check=>check.status!=='pass'))await runtime.store.blockProjectTaskForRun(effect.principalId,effect.projectId,effect.runId,'verification_not_passed');
 const artifacts:EffectArtifact[]=[{artifactId,mediaType:'application/json',bytes:new TextEncoder().encode(JSON.stringify(result))},...outputs.map(file=>({artifactId:file.artifactId,mediaType:'application/json' as const,bytes:Buffer.from(JSON.stringify({kind:'project-run-file-v1',path:file.path,sha256:file.sha256,byteLength:file.byteLength,contentBase64:Buffer.from(file.bytes).toString('base64')}))}))];
 if(outputs.length){const outputManifestArtifactId=randomUUID();artifacts.push({artifactId:outputManifestArtifactId,mediaType:'application/json',bytes:new TextEncoder().encode(JSON.stringify({kind:'project-run-outputs-v1',projectId:effect.projectId,rootBindingId,runId:effect.runId,taskId:request.taskId,baseManifestDigest:manifest.snapshotDigest,reportArtifactId:artifactId,files:outputs.map(({bytes,...file})=>file)}))});}
 return {kind:'completed',artifacts,outputArtifactRefs:artifacts.map(a=>a.artifactId),sources:[]};
}

/** Produces the existing reviewable writer plan, never promotes bytes by itself. */
export async function prepareProjectRunPromotion(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown,signal:AbortSignal){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,outputManifestArtifactId,paths,rootBindingId'||!Number.isSafeInteger(input.expectedRevision)||typeof input.outputManifestArtifactId!=='string'||typeof input.rootBindingId!=='string'||!Array.isArray(input.paths)||!input.paths.length||input.paths.length>32||input.paths.some(p=>!isSafeRelativePath(p)||isProtectedProjectPath(p))||new Set(input.paths).size!==input.paths.length)throw new WorkspaceError('runtime_promotion_invalid');
 const bundle=await runtime.store.getBundle(principal,projectId);
 if(bundle.project.revision!==input.expectedRevision)throw new WorkspaceError('workspace_revision_conflict',409);
 const descriptor=bundle.artifacts.find(a=>a.id===input.outputManifestArtifactId&&a.mediaType==='application/json'&&a.byteLength<=65536);
 const run=bundle.runs.find(item=>item.run.id===descriptor?.runId);
 const receipt=run?.receipts.find(r=>[PROJECT_RUN_CAPABILITY.id,PROJECT_DEPENDENCY_RUN_CAPABILITY.id].includes(r.capabilityId)&&r.status==='succeeded'&&r.outputArtifactRefs.includes(input.outputManifestArtifactId as string));
 if(!descriptor||!run||run.run.status!=='succeeded'||!receipt)throw new WorkspaceError('runtime_output_receipt_missing',409);
 const output=JSON.parse(Buffer.from(await runtime.store.readArtifactRaw(principal,projectId,descriptor.id,false)).toString());
 if(output.kind!=='project-run-outputs-v1'||output.projectId!==projectId||output.rootBindingId!==input.rootBindingId||output.runId!==run.run.id||!Array.isArray(output.files)||output.files.length>32||!receipt.outputArtifactRefs.includes(output.reportArtifactId))throw new WorkspaceError('runtime_promotion_invalid');
 const report=parseProjectVerificationReport(JSON.parse(Buffer.from(await runtime.store.readArtifactRaw(principal,projectId,output.reportArtifactId,false)).toString()));
 if(report.runId!==output.runId||report.taskId!==output.taskId||report.manifestDigest!==output.baseManifestDigest)throw new WorkspaceError('runtime_promotion_invalid');
 const manifest=await runtime.getProjectManifest(principal,projectId,input.rootBindingId);
 if(manifest.snapshotDigest!==output.baseManifestDigest)throw new WorkspaceError('runtime_manifest_conflict',409);
 const operations:ProjectChangeOperation[]=[];
 for(const requestedPath of input.paths){
  signal.throwIfAborted();
  const file=output.files.find((f:any)=>f.path===requestedPath);
  const stored=bundle.artifacts.find(a=>a.id===file?.artifactId);
  if(!file||!stored||stored.runId!==run.run.id||stored.mediaType!=='application/json'||stored.byteLength>1500000||!receipt.outputArtifactRefs.includes(stored.id)||!report.checks.some(check=>check.artifactRefs.includes(stored.id)))throw new WorkspaceError('runtime_output_artifact_invalid');
  const base=manifest.entries.find(e=>e.relativePath===requestedPath);
  if((base?.sha256??null)!==file.baseSha256||base&&base.kind!=='file')throw new WorkspaceError('runtime_manifest_conflict',409);
  const envelope=JSON.parse(Buffer.from(await runtime.store.readArtifactRaw(principal,projectId,stored.id,false)).toString());
  if(envelope.kind!=='project-run-file-v1'||envelope.path!==file.path||envelope.sha256!==file.sha256||envelope.byteLength!==file.byteLength||typeof envelope.contentBase64!=='string')throw new WorkspaceError('runtime_output_artifact_invalid');
  const bytes=Buffer.from(envelope.contentBase64,'base64');
  if(bytes.length!==file.byteLength||bytes.length>1048576||bytes.toString('base64')!==envelope.contentBase64||createHash('sha256').update(bytes).digest('hex')!==file.sha256)throw new WorkspaceError('runtime_output_artifact_invalid');
  let content:string;try{content=new TextDecoder('utf-8',{fatal:true}).decode(bytes);if(content.includes('\0')||!Buffer.from(content).equals(bytes))throw Error();}catch{throw new WorkspaceError('runtime_binary_output_requires_export');}
  const segments=requestedPath.split('/');for(let i=1;i<segments.length;i++){const parent=segments.slice(0,i).join('/');if(!manifest.entries.some(e=>e.relativePath===parent)&&!operations.some(op=>op.path===parent))operations.push({type:'mkdir',path:parent});}
  operations.push({type:base?'replace':'create',path:requestedPath,...(base?{expectedSha256:base.sha256}:{}),newSha256:file.sha256,content});
 }
 const changeSet={id:randomUUID(),taskId:output.taskId,baseManifestDigest:manifest.snapshotDigest,revision:1,operations,digest:'0'.repeat(64)};
 changeSet.digest=computeProjectChangeSetDigest(changeSet);signal.throwIfAborted();
 return runtime.createProjectTaskPlan(principal,projectId,{expectedRevision:input.expectedRevision,rootBindingId:input.rootBindingId,changeSet,objective:'Aplicar saídas revisadas da execução isolada'},signal);
}
