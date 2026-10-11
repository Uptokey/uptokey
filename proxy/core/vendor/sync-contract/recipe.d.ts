export type RecipeState =
  | 'draft'
  | 'needs_input'
  | 'prepared'
  | 'awaiting_approval'
  | 'running'
  | 'complete'
  | 'partial'
  | 'stopped'
  | 'review_required';

export interface RecipeNode {
  id: string;
  capabilityRef: string;
  capabilityVersion?: string;
  dependsOn?: string[];
}

export interface RecipeBinding {
  from: string;
  pointer: string;
  to: string;
  transform?: string | null;
}

export interface RecipeBudget {
  maxCalls: number;
  maxBytes: number;
  maxDurationMs: number;
  maxPages: number;
  maxRecords: number;
  maxSemanticSpend?: number | null;
}

export interface EffectManifest {
  reads: string[];
  writes: string[];
  requiresInference: boolean;
  externalDestinations: string[];
}

export interface StopCondition {
  type: 'timeout' | 'budget_exceeded' | 'user_cancel' | 'node_failure' | 'schema_mismatch' | string;
  behavior: 'abort' | 'partial_result' | 'retry_once' | string;
}

export interface TaskRecipeSpec {
  proposalSchema: 'uptokey.task-recipe.v2';
  id: string;
  version: string;
  catalogRevision?: string;
  inputSchema?: any;
  nodes: RecipeNode[];
  bindings: RecipeBinding[];
  outputSchema?: any;
  effectManifest: EffectManifest;
  budgets: RecipeBudget;
  stopConditions?: StopCondition[];
  sourceRequirements?: any;
  revisionDigest?: string;
  state?: RecipeState;
  approvalStrategy?: 'materialize-next-plan' | 'pre-approved-envelope' | string;
}

export declare const RECIPE_SCHEMA: 'uptokey.task-recipe.v2';

export declare function resolvePointer(obj: any, pointer: string): any;
export declare function computeRecipeDigest(recipe: TaskRecipeSpec): string;
export declare function validateRecipe(obj: any): string[];
export declare function isTaskRecipeSpec(obj: any): obj is TaskRecipeSpec;
export declare function topologicalSort(nodes: RecipeNode[]): RecipeNode[];
