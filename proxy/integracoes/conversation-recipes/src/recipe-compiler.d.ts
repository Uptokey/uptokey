export type CapabilityType = 'read' | 'local_transform' | 'local_artifact' | 'write' | 'inference';
export type CapabilityStatus = 'available' | 'candidate' | 'requires_oauth' | 'unregistered';

export interface CapabilityMapping {
  capabilityId: string;
  version: number;
  type: CapabilityType;
  status: CapabilityStatus;
  reason?: string;
}

export declare const CAPABILITY_MAPPINGS: Record<string, CapabilityMapping>;

export interface BlockedNode {
  nodeId: string;
  capabilityRef: string;
  reason?: string;
}

export interface CompilationResult {
  success: boolean;
  reason: string | null;
  executionPlan: any;
  blockedNodes: BlockedNode[];
}

export declare function compileRecipe(
  recipeSpec: any,
  userInputs?: Record<string, any>,
  contextSnapshot?: { id: string; digest: string; projectId: string; projectRevision?: number }
): CompilationResult;
