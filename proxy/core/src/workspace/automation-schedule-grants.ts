/** A bounded recurring permission is itself a signed W5 local plan.
 * This store retains scope and occurrence references, never execution receipts.
 * The existing W5 journal remains the authority for the granting run and effects.
 */
import {createHash,randomUUID} from 'node:crypto';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord} from '@uptokey/sync-contract/plain-data';
import {parseCapabilityDescriptor,parseExecutionPlan,canonicalContextSnapshotPayload,validatePlanBindings,type ExecutionPlan,type DataDestination} from '@uptokey/sync-contract/workflow';
import {computePlanDigest} from './planner.ts';
import {recipeRevocationRecordId} from './recipes.ts';
import type {WorkspaceStore} from './store.ts';
import type {EffectRequest,EffectOutcome} from './executor.ts';
import type {AutomationSchedule} from './automation-scheduler.ts';
import type {AutomationPreset} from './automation-presets.ts';
import {AutomationError,isId,type Clock,SystemClock} from './automation-types.ts';

const hash=(value:unknown)=>createHash('sha256').update(canonicalJson(value)).digest('hex');
const limits={maxSteps:1,maxCalls:1,maxOutputTokens:1,maxOutputBytes:65_536,timeoutMs:30_000};
export const SCHEDULE_GRANT_CAPABILITY=parseCapabilityDescriptor({schemaVersion:1,id:'automation.schedule.authorize',version:1,createdAt:'2026-09-20T00:00:00.000Z',titleKey:'ws_automation_schedule_authorize',descriptionKey:'ws_automation_schedule_scope',tags:['automations','schedule'],inputSchemaId:'automation.schedule.scope.v1',outputSchemaId:'automation.schedule.grant.v1',effect:'produce_artifact',dataDestination:{kind:'local',id:'workspace'},availability:'executable',supportLevel:'experimental',requiredScopes:['run:execute'],retryClass:'idempotent_local',limits});
export type ScheduleScope={id:string;scheduleId:string;presetId:string;presetVersion:number;presetDigest:string;recipeId:string;recipeVersion:number;recipeDigest:string;steps:ExecutionPlan['steps'];limits:ExecutionPlan['limits'];destinations:DataDestination[];maxOccurrences:number;expiresAt:string};
type Claim={occurrenceKey:string;planId:string;planDigest:string;requestId:string;claimedAt:string;runId?:string};
export type ScheduleGrant=ScheduleScope&{principalId:string;projectId:string;createdAt:string;revokedAt:string|null;source:{planId:string;runId:string;attemptId:string;receiptId:string};claims:Claim[]};
export type ScheduleOccurrenceAuthority={grantId:string;requestId:string;planId:string;planDigest:string;principalId:string;projectId:string;occurrenceKey:string};
type Options={clock?:Clock;schedule:(id:string)=>AutomationSchedule|undefined;preset:(principal:string,projectId:string,id:string,version:number)=>AutomationPreset|undefined;persist:()=>void};

export class AutomationScheduleGrants{
  private grants=new Map<string,ScheduleGrant>();
  private readonly options:Options;
  private readonly clock:Clock;
  constructor(options:Options){this.options=options;this.clock=options.clock??new SystemClock();}
  exportState():Array<[string,ScheduleGrant]>{return [...this.grants].map(([id,grant])=>[id,structuredClone(grant)]);}
  restoreState(rows:Array<[string,ScheduleGrant]>){this.grants=new Map(rows.map(([id,grant])=>[id,structuredClone(grant)]));}
  list(principal:string,projectId:string){return [...this.grants.values()].filter(grant=>grant.principalId===principal&&grant.projectId===projectId).map(grant=>structuredClone(grant));}
  private ownedSchedule(principal:string,projectId:string,id:string){const schedule=this.options.schedule(id);if(!schedule||schedule.principalId!==principal||schedule.projectId!==projectId)throw new AutomationError('schedule_missing',404);return schedule;}
  /** Durable tombstone check: a revoked version cannot be re-selected as a schedule scope. */
  private async assertRecipeNotRevoked(store:WorkspaceStore,principal:string,projectId:string,recipe:{id:string;version:number}){
    const recordId=recipeRevocationRecordId(recipe.id);
    const rows=await store.listRecipes(principal,projectId);
    const revoked=rows.reduce((max,item)=>item.id===recordId?Math.max(max,item.version):max,0);
    if(recipe.id.startsWith('revoke_'))throw new AutomationError('recipe_revoked',409);
    if(revoked>=recipe.version)throw new AutomationError('recipe_revoked',409);
  }
  revoke(principal:string,projectId:string,id:string){const grant=this.grants.get(id);if(!grant||grant.principalId!==principal||grant.projectId!==projectId)throw new AutomationError('schedule_grant_missing',404);grant.revokedAt??=this.clock.now().toISOString();this.options.persist();return structuredClone(grant);}
  async prepare(store:WorkspaceStore,principal:string,projectId:string,input:unknown,signal:AbortSignal):Promise<ExecutionPlan>{
    if(!isDataRecord(input)||Object.keys(input).sort().join(',')!=='expiresAt,maxOccurrences,scheduleId,templatePlanId'||!isId(input.scheduleId)||!isId(input.templatePlanId)||!Number.isSafeInteger(input.maxOccurrences)||Number(input.maxOccurrences)<1||Number(input.maxOccurrences)>100||typeof input.expiresAt!=='string')throw new AutomationError('schedule_scope_invalid');
    const expiry=Date.parse(input.expiresAt),now=this.clock.now().getTime();if(!Number.isFinite(expiry)||new Date(expiry).toISOString()!==input.expiresAt||expiry<=now||expiry>now+30*86400_000)throw new AutomationError('schedule_scope_expiry_invalid');
    const schedule=this.ownedSchedule(principal,projectId,input.scheduleId),preset=this.options.preset(principal,projectId,schedule.presetId,schedule.presetVersion);
    if(!preset||preset.steps.length!==1||preset.steps[0]?.kind!=='recipe')throw new AutomationError('automation_schedule_kind_unavailable');
    const step=preset.steps[0],recipe=(await store.listRecipes(principal,projectId)).find(recipe=>recipe.id===step.ref&&recipe.version===Number(step.bindings?.recipeVersion));
    if(!recipe)throw new AutomationError('recipe_missing',404);
    await this.assertRecipeNotRevoked(store,principal,projectId,recipe);
    const template=await store.getPlan(principal,projectId,input.templatePlanId);if(!template)throw new AutomationError('plan_missing',404);
    const source=await store.getSnapshot(principal,projectId,template.contextSnapshotId);if(!source||source.entries.length||source.artifacts.length)throw new AutomationError('schedule_context_requires_review',409);
    if(template.steps.some(step=>step.capabilityId.startsWith('automation.schedule.')))throw new AutomationError('schedule_nested_authorization_denied');
    const scope:ScheduleScope={id:randomUUID(),scheduleId:schedule.id,presetId:preset.id,presetVersion:preset.version,presetDigest:hash(preset),recipeId:recipe.id,recipeVersion:recipe.version,recipeDigest:hash(recipe),steps:template.steps,limits:template.limits,destinations:source.allowedDestinations,maxOccurrences:Number(input.maxOccurrences),expiresAt:input.expiresAt};
    const project=await store.getProject(principal,projectId);signal.throwIfAborted();
    const snapshot=await store.snapshotContext(principal,projectId,{selectedEntryIds:[],selectedArtifactIds:[],excludedEntryIds:project.entries.map(entry=>entry.id),allowedDestinations:[SCHEDULE_GRANT_CAPABILITY.dataDestination],maxContextBytes:32_000});
    const base=parseExecutionPlan({schemaVersion:1,id:randomUUID(),createdAt:this.clock.now().toISOString(),projectId,projectRevision:project.revision,contextSnapshotId:snapshot.id,contextSnapshotDigest:createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),steps:[{id:'authorize_schedule',capabilityId:SCHEDULE_GRANT_CAPABILITY.id,capabilityVersion:1,arguments:{scope:{kind:'literal',value:JSON.parse(JSON.stringify(scope))}}}],limits,digest:'0'.repeat(64)});
    const plan=parseExecutionPlan({...base,digest:computePlanDigest(base)});validatePlanBindings(plan,snapshot,[SCHEDULE_GRANT_CAPABILITY]);signal.throwIfAborted();await store.putPlan(principal,plan,snapshot);return plan;
  }
  async dispatch(store:WorkspaceStore,request:EffectRequest):Promise<EffectOutcome>{
    const bundle=await store.getBundle(request.principalId,request.projectId),run=bundle.runs.find(item=>item.run.id===request.runId&&item.run.principalId===request.principalId);
    const plan=bundle.plans.find(item=>item.id===run?.run.planId&&item.digest===run?.run.planDigest),step=plan?.steps.find(step=>step.id===request.stepId&&step.capabilityId===SCHEDULE_GRANT_CAPABILITY.id);
    const receipt=run?.receipts.find(item=>item.attemptId===request.attemptId&&item.stepId===request.stepId&&item.capabilityId===SCHEDULE_GRANT_CAPABILITY.id&&item.status==='dispatched');
    if(!plan||!step||!receipt||run?.run.status!=='running'||request.capability.id!==SCHEDULE_GRANT_CAPABILITY.id||canonicalJson(step.arguments)!==canonicalJson(request.arguments)||request.signal.aborted)return {kind:'not_sent',code:'schedule_grant_admission_required'};
    const binding=step.arguments.scope;if(binding?.kind!=='literal'||!isDataRecord(binding.value))return {kind:'not_sent',code:'schedule_scope_invalid'};
    const scope=binding.value as unknown as ScheduleScope;
    try{await this.validateScope(store,request.principalId,request.projectId,scope);}
    catch(error){return {kind:'not_sent',code:error instanceof AutomationError?error.code:'schedule_scope_changed'};}
    let grant=this.grants.get(scope.id);
    if(grant&&(grant.revokedAt||grant.source.planId!==plan.id||grant.source.runId!==request.runId||grant.principalId!==request.principalId||grant.projectId!==request.projectId))return {kind:'not_sent',code:'schedule_grant_conflict'};
    if(!grant){grant={...structuredClone(scope),principalId:request.principalId,projectId:request.projectId,createdAt:this.clock.now().toISOString(),revokedAt:null,source:{planId:plan.id,runId:request.runId,attemptId:request.attemptId,receiptId:receipt.id},claims:[]};this.grants.set(grant.id,grant);this.options.persist();}
    else if(grant.source.attemptId!==request.attemptId&&!grant.claims.length){grant.source={planId:plan.id,runId:request.runId,attemptId:request.attemptId,receiptId:receipt.id};this.options.persist();}
    // A consumer must also verify this granting receipt reached succeeded.
    const artifactId=`schedule_grant_${scope.id.replace(/-/g,'_')}`;
    return {kind:'completed',artifacts:[{artifactId,mediaType:'application/json',bytes:new TextEncoder().encode(JSON.stringify({grantId:grant.id,scheduleId:grant.scheduleId,expiresAt:grant.expiresAt,maxOccurrences:grant.maxOccurrences,status:'authorized'}))}],outputArtifactRefs:[artifactId]};
  }
  private async validateScope(store:WorkspaceStore,principal:string,projectId:string,scope:ScheduleScope){
    if(!isId(scope.id)||!isId(scope.scheduleId)||!Number.isSafeInteger(scope.maxOccurrences)||scope.maxOccurrences<1||scope.maxOccurrences>100||!Number.isFinite(Date.parse(scope.expiresAt))||Date.parse(scope.expiresAt)<=this.clock.now().getTime()||Date.parse(scope.expiresAt)>this.clock.now().getTime()+30*86400_000)throw new AutomationError('schedule_grant_expired',403);
    const schedule=this.ownedSchedule(principal,projectId,scope.scheduleId);
    if(!schedule.enabled)throw new AutomationError('schedule_paused',403);
    if(schedule.presetId!==scope.presetId||schedule.presetVersion!==scope.presetVersion)throw new AutomationError('schedule_scope_changed',409);
    const preset=this.options.preset(principal,projectId,scope.presetId,scope.presetVersion);if(!preset||hash(preset)!==scope.presetDigest)throw new AutomationError('schedule_scope_changed',409);
    const recipe=(await store.listRecipes(principal,projectId)).find(item=>item.id===scope.recipeId&&item.version===scope.recipeVersion);if(!recipe||hash(recipe)!==scope.recipeDigest)throw new AutomationError('schedule_recipe_changed',409);
    // A tombstone recorded after the grant was issued revokes the recurring scope.
    await this.assertRecipeNotRevoked(store,principal,projectId,recipe);
  }
  private async assertCommitted(store:WorkspaceStore,grant:ScheduleGrant){
    const record=await store.readRun(grant.principalId,grant.projectId,grant.source.runId);
    const receipt=record?.receipts.find(item=>item.id===grant.source.receiptId&&item.attemptId===grant.source.attemptId&&item.capabilityId===SCHEDULE_GRANT_CAPABILITY.id&&item.status==='succeeded');
    if(record?.run.status!=='succeeded'||record.run.planId!==grant.source.planId||!receipt?.outputArtifactRefs.includes(`schedule_grant_${grant.id.replace(/-/g,'_')}`))throw new AutomationError('schedule_grant_uncommitted',403);
  }
  private async validatePlan(store:WorkspaceStore,grant:ScheduleGrant,plan:ExecutionPlan){
    if(grant.revokedAt)throw new AutomationError('schedule_grant_revoked',403);
    await this.validateScope(store,grant.principalId,grant.projectId,grant);await this.assertCommitted(store,grant);
    if(plan.projectId!==grant.projectId||computePlanDigest(plan)!==plan.digest||canonicalJson(plan.steps)!==canonicalJson(grant.steps)||canonicalJson(plan.limits)!==canonicalJson(grant.limits))throw new AutomationError('schedule_plan_outside_scope',403);
    const snapshot=await store.getSnapshot(grant.principalId,grant.projectId,plan.contextSnapshotId);
    if(!snapshot||snapshot.entries.length||snapshot.artifacts.length||canonicalJson(snapshot.allowedDestinations)!==canonicalJson(grant.destinations))throw new AutomationError('schedule_context_outside_scope',403);
    if(grant.revokedAt||!this.ownedSchedule(grant.principalId,grant.projectId,grant.scheduleId).enabled||Date.parse(grant.expiresAt)<=this.clock.now().getTime())throw new AutomationError('schedule_grant_inactive',403);
  }
  async authorizeOccurrence(store:WorkspaceStore,principal:string,projectId:string,scheduleId:string,occurrenceKey:string,plan:ExecutionPlan):Promise<ScheduleOccurrenceAuthority>{
    if(!occurrenceKey.startsWith(scheduleId+'@')||!Number.isFinite(Date.parse(occurrenceKey.slice(scheduleId.length+1))))throw new AutomationError('occurrence_invalid');
    const candidates=[...this.grants.values()].filter(grant=>grant.principalId===principal&&grant.projectId===projectId&&grant.scheduleId===scheduleId&&!grant.revokedAt).reverse();
    const grant=candidates[0];if(!grant)throw new AutomationError('schedule_grant_missing',403);
    await this.validatePlan(store,grant,plan);
    const existing=grant.claims.find(claim=>claim.occurrenceKey===occurrenceKey);
    if(existing&&(existing.planId!==plan.id||existing.planDigest!==plan.digest))throw new AutomationError('occurrence_already_claimed',409);
    if(!existing&&grant.claims.length>=grant.maxOccurrences)throw new AutomationError('schedule_grant_exhausted',403);
    const claim=existing??{occurrenceKey,planId:plan.id,planDigest:plan.digest,requestId:`schedule_${hash([grant.id,occurrenceKey])}`,claimedAt:this.clock.now().toISOString()};
    if(!existing){grant.claims.push(claim);this.options.persist();}
    return {grantId:grant.id,requestId:claim.requestId,planId:plan.id,planDigest:plan.digest,principalId:principal,projectId,occurrenceKey};
  }
  /** Root checks again at start and before each scheduled effect; no reusable boolean. */
  async assertRun(store:WorkspaceStore,principal:string,projectId:string,requestId:string,plan:ExecutionPlan){
    const grant=[...this.grants.values()].find(grant=>grant.principalId===principal&&grant.projectId===projectId&&grant.claims.some(claim=>claim.requestId===requestId&&claim.planId===plan.id&&claim.planDigest===plan.digest));
    if(!grant)throw new AutomationError('schedule_grant_missing',403);await this.validatePlan(store,grant,plan);return structuredClone(grant);
  }
  linkRun(principal:string,projectId:string,grantId:string,occurrenceKey:string,runId:string){
    const grant=this.grants.get(grantId),claim=grant?.claims.find(claim=>claim.occurrenceKey===occurrenceKey);if(!grant||grant.principalId!==principal||grant.projectId!==projectId||!claim||!isId(runId))throw new AutomationError('schedule_grant_missing',404);
    if(claim.runId&&claim.runId!==runId)throw new AutomationError('occurrence_already_claimed',409);claim.runId=runId;this.options.persist();
  }
}
