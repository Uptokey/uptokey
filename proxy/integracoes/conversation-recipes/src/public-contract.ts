/**
 * Public contract for the DC conversation-recipes HTTP surface.
 * Browser-safe parsers and types shared by proxy-local and the PWA.
 * Dependency-free: no Node, SDK or proxy imports. Execution contracts remain W0.
 */

export type RecipeInputType = 'string' | 'number' | 'integer' | 'boolean' | 'array';

export interface RecipeInputSpec {
  name: string;
  type: RecipeInputType;
  required: boolean;
  description?: string;
}

export interface RecipeStepStatus {
  nodeId: string;
  capabilityRef: string;
  capabilityId: string | null;
  availability: string;
  reason?: string;
}

export interface RecipeSummary {
  id: string;
  name: string;
  description: string;
  inputs: RecipeInputSpec[];
  steps: RecipeStepStatus[];
  available: boolean;
  unavailableReason: string | null;
}

export interface RecipeCatalog {
  schemaVersion: 1;
  catalogRevision: string;
  recipes: RecipeSummary[];
}

export interface RecipePlanInput {
  recipeId: string;
  inputs: Record<string, unknown>;
  expectedRevision: number;
}

/** Raw entry of the copied catalog file (schema uptokey.task-recipe.v2). */
export interface RecipeCatalogEntry {
  id: string;
  version: string;
  catalogRevision: string;
  displayName: string;
  description: string;
  inputSchema: {
    required: string[];
    properties: Record<string, { type: RecipeInputType; description?: string }>;
  };
  nodes: Array<{ id: string; capabilityRef: string; dependsOn: string[] }>;
  bindings: Array<{ from: string; pointer?: string | null; to: string }>;
  budgets?: { maxCalls?: number; maxDurationMs?: number };
}

const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const text = (x: unknown, max: number): x is string => typeof x === 'string' && x.length >= 1 && x.length <= max;
const name = (x: unknown): x is string => typeof x === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,99}$/.test(x);
const catalogFail = (): never => { throw new Error('recipe_catalog_invalid'); };
const inputFail = (): never => { throw new Error('recipe_plan_input_invalid'); };
const INPUT_TYPES: readonly string[] = ['string', 'number', 'integer', 'boolean', 'array'];

function inputSpec(value: unknown): RecipeInputSpec {
  if (!object(value) || !name(value.name) || !INPUT_TYPES.includes(String(value.type)) || typeof value.required !== 'boolean') return catalogFail();
  if (value.description !== undefined && !text(value.description, 2000)) return catalogFail();
  return structuredClone(value) as unknown as RecipeInputSpec;
}

function stepStatus(value: unknown): RecipeStepStatus {
  if (!object(value) || !name(value.nodeId) || !text(value.capabilityRef, 200)) return catalogFail();
  if (value.capabilityId !== null && !name(value.capabilityId)) return catalogFail();
  if (!text(value.availability, 64)) return catalogFail();
  if (value.reason !== undefined && !text(value.reason, 2000)) return catalogFail();
  return structuredClone(value) as unknown as RecipeStepStatus;
}

/** Validates the wire shape served by GET /v1/workspace/recipes. */
export function parseRecipeCatalog(input: unknown): RecipeCatalog {
  if (!object(input) || input.schemaVersion !== 1 || !text(input.catalogRevision, 64)) return catalogFail();
  if (!Array.isArray(input.recipes) || input.recipes.length > 64) return catalogFail();
  const seen = new Set<string>();
  const recipes = input.recipes.map((value): RecipeSummary => {
    if (!object(value) || !name(value.id) || seen.has(value.id as string)) return catalogFail();
    seen.add(value.id as string);
    if (!text(value.name, 300) || !text(value.description, 2000)) return catalogFail();
    if (typeof value.available !== 'boolean') return catalogFail();
    if (value.unavailableReason !== null && !text(value.unavailableReason, 2000)) return catalogFail();
    if (value.available && value.unavailableReason !== null) return catalogFail();
    if (!Array.isArray(value.inputs) || value.inputs.length > 32) return catalogFail();
    if (!Array.isArray(value.steps) || value.steps.length < 1 || value.steps.length > 32) return catalogFail();
    const inputs = value.inputs.map(inputSpec);
    if (new Set(inputs.map(item => item.name)).size !== inputs.length) return catalogFail();
    const steps = value.steps.map(stepStatus);
    if (new Set(steps.map(item => item.nodeId)).size !== steps.length) return catalogFail();
    return { id: value.id as string, name: value.name as string, description: value.description as string,
      inputs, steps, available: value.available as boolean, unavailableReason: value.unavailableReason as string | null };
  });
  return { schemaVersion: 1, catalogRevision: input.catalogRevision as string, recipes };
}

/** Body of POST /v1/workspace/projects/{projectId}/recipe-plans. */
export function parseRecipePlanInput(input: unknown): RecipePlanInput {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'expectedRevision,inputs,recipeId') return inputFail();
  if (!name(input.recipeId) || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1) return inputFail();
  if (!object(input.inputs) || Object.keys(input.inputs).length > 32) return inputFail();
  for (const [key, value] of Object.entries(input.inputs)) {
    if (!name(key) || ['constructor', 'prototype', '__proto__'].includes(key)) return inputFail();
    const scalar = (item: unknown) => (typeof item === 'string' && item.length <= 4000) ||
      (typeof item === 'number' && Number.isFinite(item)) || typeof item === 'boolean';
    if (Array.isArray(value)) { if (value.length > 64 || !value.every(scalar)) return inputFail(); }
    else if (!scalar(value)) return inputFail();
  }
  return structuredClone(input) as unknown as RecipePlanInput;
}

/** Validates the copied source catalog (array of uptokey.task-recipe.v2 entries). */
export function parseRecipeCatalogFile(input: unknown): RecipeCatalogEntry[] {
  if (!Array.isArray(input) || input.length < 1 || input.length > 64) return catalogFail();
  const seen = new Set<string>();
  return input.map((value): RecipeCatalogEntry => {
    if (!object(value) || value.proposalSchema !== 'uptokey.task-recipe.v2') return catalogFail();
    if (!name(value.id) || seen.has(value.id as string)) return catalogFail();
    seen.add(value.id as string);
    if (!text(value.version, 32) || !text(value.catalogRevision, 64) || !text(value.displayName, 300) || !text(value.description, 2000)) return catalogFail();
    const schema = value.inputSchema;
    if (!object(schema) || !Array.isArray(schema.required) || schema.required.length > 32 || !schema.required.every(name)) return catalogFail();
    if (!object(schema.properties) || Object.keys(schema.properties).length > 32) return catalogFail();
    const properties: RecipeCatalogEntry['inputSchema']['properties'] = {};
    for (const [key, property] of Object.entries(schema.properties)) {
      if (!name(key) || !object(property) || !INPUT_TYPES.includes(String(property.type))) return catalogFail();
      if (property.description !== undefined && !text(property.description, 2000)) return catalogFail();
      properties[key] = { type: property.type as RecipeInputType, ...(property.description !== undefined ? { description: property.description as string } : {}) };
    }
    if (!(schema.required as string[]).every(key => key in properties)) return catalogFail();
    if (!Array.isArray(value.nodes) || value.nodes.length < 1 || value.nodes.length > 32) return catalogFail();
    const nodes = value.nodes.map(node => {
      if (!object(node) || !name(node.id) || !text(node.capabilityRef, 200)) return catalogFail();
      if (!Array.isArray(node.dependsOn) || node.dependsOn.length > 32 || !node.dependsOn.every(name)) return catalogFail();
      return { id: node.id as string, capabilityRef: node.capabilityRef as string, dependsOn: structuredClone(node.dependsOn) as string[] };
    });
    if (new Set(nodes.map(node => node.id)).size !== nodes.length) return catalogFail();
    const nodeIds = new Set(nodes.map(node => node.id));
    if (nodes.some(node => node.dependsOn.some(dep => !nodeIds.has(dep)))) return catalogFail();
    const bindings = (Array.isArray(value.bindings) ? value.bindings : []).map(binding => {
      if (!object(binding) || !text(binding.from, 200) || !text(binding.to, 200)) return catalogFail();
      if (binding.pointer !== undefined && binding.pointer !== null && !text(binding.pointer, 500)) return catalogFail();
      return { from: binding.from as string, ...(binding.pointer != null ? { pointer: binding.pointer as string } : {}), to: binding.to as string };
    });
    if (bindings.length > 128) return catalogFail();
    let budgets: RecipeCatalogEntry['budgets'];
    if (value.budgets !== undefined) {
      if (!object(value.budgets)) return catalogFail();
      const positive = (item: unknown) => item === undefined || (Number.isSafeInteger(item) && Number(item) > 0);
      if (!positive(value.budgets.maxCalls) || !positive(value.budgets.maxDurationMs)) return catalogFail();
      budgets = { ...(value.budgets.maxCalls !== undefined ? { maxCalls: value.budgets.maxCalls as number } : {}),
        ...(value.budgets.maxDurationMs !== undefined ? { maxDurationMs: value.budgets.maxDurationMs as number } : {}) };
    }
    return { id: value.id as string, version: value.version as string, catalogRevision: value.catalogRevision as string,
      displayName: value.displayName as string, description: value.description as string,
      inputSchema: { required: structuredClone(schema.required) as string[], properties }, nodes, bindings, ...(budgets ? { budgets } : {}) };
  });
}
