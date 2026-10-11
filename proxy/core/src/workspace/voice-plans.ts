import {createHash,randomUUID} from 'node:crypto';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {parseVoiceSession} from '@uptokey/sync-contract/voice-session';
import {canonicalContextSnapshotPayload,parseCapabilityDescriptor,parseExecutionPlan,validatePlanBindings,type ExecutionPlan} from '@uptokey/sync-contract/workflow';
import {openAIRealtimeSession} from '../voice-realtime-transport.ts';
import {VoiceSessionError} from '../voice-session-service.ts';
import {WorkspaceError,type WorkspaceRuntime} from './runtime.ts';
import {computePlanDigest} from './planner.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';

export const VOICE_CAPABILITY=parseCapabilityDescriptor({schemaVersion:1,id:'inference.voice.openai',version:1,createdAt:'2026-09-21T00:00:00.000Z',titleKey:'voice_realtime',descriptionKey:'voice_realtime_scope',tags:['audio','realtime'],inputSchemaId:'voice.session.v1',outputSchemaId:'voice.session.started.v1',effect:'inference',dataDestination:{kind:'provider',id:'openai'},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass:'never_automatic',limits:{maxSteps:1,maxCalls:1,maxOutputTokens:4096,timeoutMs:20000,maxOutputBytes:64000}});
export async function prepareVoicePlan(runtime:WorkspaceRuntime,principal:string,projectId:string,input:unknown,signal:AbortSignal){
 if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expectedRevision,session'||!Number.isSafeInteger(input.expectedRevision))throw new WorkspaceError('invalid_request');
 const voice=runtime.voiceSupervisor();if(!voice)throw new WorkspaceError('voice_unavailable',503);
 const profile=await voice.profile();if(!profile.configured)throw new WorkspaceError('voice_unavailable',503);
 if(profile.budgetRequired&&!profile.budgetReady)throw new WorkspaceError(profile.budgetReason??'budget_cost_unknown',422);
 const session=parseVoiceSession(input.session);if(session.profileRevision!==profile.profileRevision)throw new WorkspaceError('voice_profile_changed',409);
 openAIRealtimeSession(session,profile.model);
 const bundle=await runtime.store.getBundle(principal,projectId),project=bundle.project;if(project.revision!==input.expectedRevision)throw new WorkspaceError('workspace_revision_conflict',409);
 if(bundle.runs.some(item=>['running','needs_attention','ready','awaiting_approval'].includes(item.run.status)))throw new WorkspaceError('project_run_active',409);
 const snapshot=await runtime.store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:[],excludedEntryIds:project.entries.map(e=>e.id),allowedDestinations:[VOICE_CAPABILITY.dataDestination],maxContextBytes:32000});
 let plan:ExecutionPlan={schemaVersion:1,id:randomUUID(),createdAt:new Date().toISOString(),projectId,projectRevision:project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),steps:[{id:'voice',capabilityId:VOICE_CAPABILITY.id,capabilityVersion:1,arguments:{session:{kind:'literal',value:JSON.parse(JSON.stringify(session))},model:{kind:'literal',value:profile.model}}}],limits:{...VOICE_CAPABILITY.limits},digest:'0'.repeat(64)};
 plan=parseExecutionPlan({...plan,digest:computePlanDigest(plan)});validatePlanBindings(plan,snapshot,runtime.registry().forPlan(plan));signal.throwIfAborted();await runtime.store.putPlan(principal,plan,snapshot);return runtime.viewPlan(principal,projectId,plan.id);
}
export async function dispatchVoicePlan(runtime:WorkspaceRuntime,effect:EffectRequest):Promise<EffectOutcome>{
 const voice=runtime.voiceSupervisor();if(!voice)return {kind:'not_sent',code:'voice_unavailable'};
 const session=parseVoiceSession(effect.arguments.session?.kind==='literal'?effect.arguments.session.value:null),profile=await voice.profile();
 if(!profile.configured||profile.profileRevision!==session.profileRevision||effect.arguments.model?.kind!=='literal'||effect.arguments.model.value!==profile.model)return {kind:'not_sent',code:'voice_profile_changed'};
 effect.signal.throwIfAborted();
 try{const record=await voice.start(effect.principalId,effect.projectId,session,{runId:effect.runId});
  if(effect.signal.aborted){await voice.stop(effect.principalId,effect.projectId,record.sessionId);return {kind:'failed',code:'voice_start_cancelled',sent:'unknown'};}
  const artifactId=randomUUID(),result={sessionId:record.sessionId,runId:record.runId,status:record.status,session:record.session};
  return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes:new TextEncoder().encode(JSON.stringify(result))}],outputArtifactRefs:[artifactId],sources:[]};
 }catch(error){return error instanceof VoiceSessionError&&error.outcome==='not_sent'?{kind:'not_sent',code:error.code}:{kind:'failed',sent:'unknown',code:error instanceof VoiceSessionError?error.code:'voice_start_unknown'};}
}
