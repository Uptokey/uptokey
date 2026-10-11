export interface RecipeSchedule {
  scheduleId: string;
  recipeId: string;
  recipeVersion: string;
  recipeDigest: string;
  parameters: Record<string, any>;
  timezone: string;
  cronRule?: string;
  scheduledAt?: string;
  validUntil?: string;
  delayPolicy: 'ignore' | 'prepare_latest' | 'recover';
  maxOccurrences?: number;
}

export interface ProceduralSkill {
  id: string;
  version: string;
  hash: string;
  origin: string;
  license: string;
  triggerDescription: string;
  parameters: Record<string, any>;
  requiredCapabilities: string[];
  recipeRef: string;
  evidenceRef: string;
}

export interface DelegatedTask {
  taskId: string;
  objective: string;
  assigneeId?: string;
  parentTaskId?: string;
  revision: string;
  completionCriteria: string;
  deadlineAt: string;
  selectedInputs: Record<string, any>;
  runId?: string;
  limits: { maxCost?: number; maxCalls?: number; };
}

export interface AlternativeProposal {
  policyRevision: string;
  requiredCapability: string;
  healthSnapshot: { provider: string; status: string; validUntil: string; };
  configuredCandidates: string[];
  estimatedCost: number | 'unknown';
  proposedCandidate?: string;
  reason?: string;
  requestDigest?: string;
}
