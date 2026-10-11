import type {WorkspaceRuntime} from './runtime.ts';
import type {AutomationConversation, PipelineHooks} from './automation-conversation.ts';
import type {AutomationPreset} from './automation-presets.ts';
import type {AutomationSchedule, ScheduleOccurrence} from './automation-scheduler.ts';
import {AutomationError} from './automation-types.ts';
import {assertRecipeSelectable} from './community-recipes.ts';

/** Adapts E2-13 to W5. Preparation never grants or bypasses W5 consent. */
export function createWorkspaceAutomationHooks(runtime: WorkspaceRuntime, conversation: (id:string)=>AutomationConversation|undefined): PipelineHooks {
  function owner(id:string) {
    const value=conversation(id);
    if(!value)throw new AutomationError('conversation_missing',404);
    return value;
  }
  return {
    async prepare({conversationId,text}) {
      const {principalId,projectId}=owner(conversationId);
      const current=await runtime.view(principalId,projectId);
      const prepared=await runtime.createPlan(principalId,projectId,{expectedRevision:current.revision,objective:text});
      if(!prepared.plan)throw new AutomationError('automation_plan_missing',502);
      return {planId:prepared.plan.id,requiresApproval:true,preview:text.slice(0,200)};
    },
    async execute({conversationId,planId}) {
      const {principalId,projectId}=owner(conversationId);
      const view=await runtime.viewPlan(principalId,projectId,planId);
      if(view.run?.status!=='succeeded')throw new AutomationError('automation_use_workspace_consent',409);
      const receipts=view.receipts.filter(receipt=>receipt.runId===view.run!.id&&receipt.status==='succeeded');
      if(!receipts.length)throw new AutomationError('automation_receipt_missing',409);
      return {effects:receipts.map(receipt=>receipt.id),summary:'Execução concluída no workspace; recibos verificados.'};
    },
    async cancel({conversationId,planId}) {
      const {principalId,projectId}=owner(conversationId);
      const view=await runtime.viewPlan(principalId,projectId,planId);
      if(!view.run || view.run.status==='cancelled')return;
      if(['succeeded','failed'].includes(view.run.status))throw new AutomationError('task_not_cancellable',409);
      await runtime.cancel(principalId,projectId,view.run.id);
    },
  };
}

export async function prepareScheduledPreset(runtime:WorkspaceRuntime,_occurrence:ScheduleOccurrence,schedule:AutomationSchedule,preset:AutomationPreset):Promise<{planIds:string[]}> {
  // Versioned recipes are the currently supported scheduled unit. Other kinds
  // must receive their own W5 adapter before a schedule can claim preparation.
  if(preset.steps.length!==1||preset.steps[0]?.kind!=='recipe'||preset.edges.length)throw new AutomationError('automation_schedule_kind_unavailable',409);
  const step=preset.steps[0];
  const recipeVersion=Number(step.bindings?.recipeVersion);
  const recipes=await runtime.store.listRecipes(schedule.principalId,schedule.projectId);
  const recipe=recipes.find(recipe=>recipe.id===step.ref&&recipe.version===recipeVersion);
  if(!recipe)throw new AutomationError('recipe_missing',404);
  // Scheduled preparation is an alternative selection path: a revoked version
  // cannot be re-selected here either. The durable tombstone wins over the
  // preset's stored ref/version.
  try{await assertRecipeSelectable(runtime,schedule.principalId,schedule.projectId,recipe);}
  catch(error){
    const code=error&&typeof error==='object'&&'code' in error&&typeof (error as {code:unknown}).code==='string'?(error as {code:string}).code:'recipe_revoked';
    const status=error&&typeof error==='object'&&'status' in error&&typeof (error as {status:unknown}).status==='number'?(error as {status:number}).status:409;
    throw new AutomationError(code,status);
  }
  const current=await runtime.view(schedule.principalId,schedule.projectId);
  const prepared=await runtime.createPlan(schedule.principalId,schedule.projectId,{
    expectedRevision:current.revision,objective:step.bindings?.objective||preset.name,
    // A recurring recipe must not silently absorb new project files or prior
    // outputs. Its immutable arguments are reviewed in the recurring scope.
    selectedEntryIds:[],selectedArtifactIds:[],
  },recipe);
  if(!prepared.plan)throw new AutomationError('automation_plan_missing',502);
  return {planIds:[prepared.plan.id]};
}
