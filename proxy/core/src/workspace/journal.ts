import type { RunJournal } from './executor.ts';
import type { WorkspaceStore, JournalRunRecord } from './store.ts';

/** One authenticated owner's namespace; never derive the owner from a command body. */
export function createRunJournal(store: WorkspaceStore, ownerPrincipalId: string,
  afterCommit?: (projectId: string, runId:string, record:JournalRunRecord) => void|Promise<void>): RunJournal {
  return {
    isTaskRequest:(projectId,requestId)=>store.isProjectTaskRequest(ownerPrincipalId,projectId,requestId),
    readTaskAuthority:(projectId,planId,requestId)=>store.readProjectTaskAuthority(ownerPrincipalId,projectId,planId,requestId),
    createTaskRun:run=>store.createProjectTaskRun(ownerPrincipalId,run),
    findByRequest: (projectId, principalId, requestId) =>
      store.findRunByRequest(ownerPrincipalId, projectId, principalId, requestId),
    readApproval: (projectId, planId) => store.readApprovalOccupancy(ownerPrincipalId, projectId, planId),
    createRun: (run, approvalId) => store.consumeApprovalAndCreateRun(ownerPrincipalId, run, approvalId),
    read: (projectId, runId) => store.readRun(ownerPrincipalId, projectId, runId),
    commitEffectArtifacts: async(projectId,runId,revision,next,artifacts)=>{
      const result=await store.commitEffectArtifacts(ownerPrincipalId,projectId,runId,revision,next,artifacts);
      if(result.kind==='committed')try{void Promise.resolve(afterCommit?.(projectId,runId,structuredClone(result.record))).catch(()=>undefined);}catch{}
      return result;
    },
    commit: async (projectId, runId, revision, next) => {
      const result = await store.commitRun(ownerPrincipalId, projectId, runId, revision, next);
      if (result.kind === 'committed') {
        try {
          // An observer gets the exact committed revision, isolated from the executor.
          void Promise.resolve(afterCommit?.(projectId,runId,structuredClone(result.record))).catch(()=>undefined);
        } catch { /* Observation cannot change the committed effect. */ }
      }
      return result;
    },
    listRecoverable: async () => (await store.listRecoverable())
      .filter(item => item.identityId === ownerPrincipalId)
      .map(({ projectId, runId }) => ({ projectId, runId })),
  };
}
