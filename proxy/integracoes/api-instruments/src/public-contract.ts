import type { CuratedOperation, ParameterDefinition, ParameterSchema } from './types.ts';

/** Browser-safe projection. Execution contracts remain W0; no SDK or Node imports. */
export type ApiInstrument = Pick<CuratedOperation, 'id' | 'operationId' | 'serviceId' | 'summary' | 'description' | 'parameters' | 'metadata'>;
export interface ApiInstrumentCatalog {
  schemaVersion: 1;
  available: boolean;
  catalogDigest: string;
  operations: ApiInstrument[];
  semantic: {available:boolean;model:string|null};
}
export interface ApiPlanInput {
  expectedRevision: number;
  operationId: string;
  parameters: Record<string, unknown>;
  catalogDigest: string;
}
export interface ApiCompositePlanInput {
  expectedRevision: number;
  catalogDigest: string;
  steps: Array<{ operationId: string; parameters: Record<string, unknown>; dependencyStepId?: 'step_1' }>;
}
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
const fail = (): never => { throw new Error('api_instruments_invalid'); };
function schema(x: unknown, depth = 0): ParameterSchema {
  if (!object(x) || depth > 2 || !['string','number','integer','boolean','array'].includes(String(x.type))) return fail();
  if (x.enum !== undefined && (!Array.isArray(x.enum) || x.enum.length > 256 || x.enum.some(v => v!==null&&!['string','number','boolean'].includes(typeof v)))) return fail();
  for (const k of ['minimum','maximum','minLength','maxLength','minItems','maxItems']) if (x[k] !== undefined && (typeof x[k] !== 'number' || !Number.isFinite(x[k]))) return fail();
  for (const k of ['format','pattern']) if (x[k] !== undefined && (typeof x[k] !== 'string' || x[k].length > 1024)) return fail();
  if (x.type === 'array') schema(x.items, depth + 1);
  return structuredClone(x) as unknown as ParameterSchema;
}
export function parseApiInstrumentCatalog(input: unknown): ApiInstrumentCatalog {
  if (!object(input) || input.schemaVersion !== 1 || typeof input.available !== 'boolean' || typeof input.catalogDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.catalogDigest) || !Array.isArray(input.operations) || input.operations.length > 64) return fail();
  const seen = new Set<string>();
  const operations = input.operations.map((value): ApiInstrument => {
    if (!object(value)) return fail();
    for (const key of ['id','operationId','serviceId','summary','description']) if (typeof value[key] !== 'string' || (value[key] as string).length > 4096) return fail();
    if (seen.has(value.id as string)) return fail(); seen.add(value.id as string);
    if (!Array.isArray(value.parameters) || value.parameters.length > 32 || !object(value.metadata)) return fail();
    const parameters = value.parameters.map((p): ParameterDefinition => {
      if (!object(p) || typeof p.name !== 'string' || !/^[a-zA-Z][a-zA-Z0-9_]{0,79}$/.test(p.name) || !['path','query'].includes(String(p.in)) || typeof p.required !== 'boolean' || typeof p.description !== 'string') return fail();
      return {...p, schema: schema(p.schema)} as unknown as ParameterDefinition;
    });
    const metadata = value.metadata;
    for (const key of ['serviceId','domain','officialUrl','specUrl','revision','codeLicense','dataLicense','commercialTerms','authentication','attribution','consultedAt']) if (typeof metadata[key] !== 'string' || (metadata[key] as string).length > 8192) return fail();
    for (const key of ['officialUrl','specUrl']) { try { if (new URL(metadata[key] as string).protocol !== 'https:') return fail(); } catch { return fail(); } }
    return {...value, parameters, metadata: structuredClone(metadata)} as unknown as ApiInstrument;
  });
  if (!input.available && operations.length) return fail();
  const semantic=input.semantic??{available:false,model:null};
  if(!object(semantic)||typeof semantic.available!=='boolean'||(semantic.available?typeof semantic.model!=='string'||!semantic.model||semantic.model.length>200:semantic.model!==null))return fail();
  return {schemaVersion:1, available:input.available, catalogDigest:input.catalogDigest, operations,semantic:semantic as {available:boolean;model:string|null}};
}
export function parseApiPlanInput(input: unknown): ApiPlanInput {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'catalogDigest,expectedRevision,operationId,parameters' || !Number.isSafeInteger(input.expectedRevision) || Number(input.expectedRevision) < 1 || typeof input.operationId !== 'string' || !/^[A-Za-z0-9_.-]{1,150}$/.test(input.operationId) || typeof input.catalogDigest !== 'string' || !/^[a-f0-9]{64}$/.test(input.catalogDigest) || !object(input.parameters) || Object.keys(input.parameters).length > 32) return fail();
  return structuredClone(input) as unknown as ApiPlanInput;
}

/** Two or three explicit reads; stable step IDs are assigned by the server, never accepted from clients.
 * Fan-out (etapa 02): step_1 root + up to two dependents both bound to step_1 (no arbitrary DAG). */
export function parseApiCompositePlanInput(input: unknown): ApiCompositePlanInput {
  if (!object(input) || Object.keys(input).sort().join(',') !== 'catalogDigest,expectedRevision,steps' || !Array.isArray(input.steps) || input.steps.length < 2 || input.steps.length > 3) return fail();
  const rawSteps = input.steps as unknown[];
  const steps = rawSteps.map((step, index) => {
    if (!object(step) || Object.keys(step).some(key => !['operationId', 'parameters', 'dependencyStepId'].includes(key))) return fail();
    if (index === 0 && step.dependencyStepId !== undefined) return fail();
    if (index > 0 && step.dependencyStepId !== undefined && step.dependencyStepId !== 'step_1') return fail();
    if (index > 0 && rawSteps.length === 3 && step.dependencyStepId !== 'step_1') return fail();
    const command = parseApiPlanInput({ expectedRevision: input.expectedRevision, catalogDigest: input.catalogDigest, operationId: step.operationId, parameters: step.parameters });
    return { operationId: command.operationId, parameters: command.parameters, ...(step.dependencyStepId !== undefined ? { dependencyStepId: 'step_1' as const } : {}) };
  });
  if (new Set(steps.map(s => s.operationId)).size !== steps.length) return fail();
  return { expectedRevision: input.expectedRevision as number, catalogDigest: input.catalogDigest as string, steps };
}

/** Local join / coverage projection for composed runs (no HTTP). */
export type ComposedStepCoverageStatus = 'succeeded' | 'failed' | 'not_executed';
export interface ComposedRunCoverage {
  schemaVersion: 1;
  planId: string;
  runId: string;
  steps: Array<{ stepId: string; status: ComposedStepCoverageStatus; receiptId?: string }>;
  summary: { succeeded: number; failed: number; not_executed: number };
  joined: Record<string, unknown> | null;
}
export function projectComposedRunCoverage(input: {
  planId: string;
  runId: string;
  stepIds: string[];
  receipts: Array<{ id: string; stepId: string; status: string }>;
  branchPayloads?: Record<string, unknown>;
}): ComposedRunCoverage {
  const byStep = new Map<string, { id: string; status: string }>();
  for (const receipt of input.receipts) {
    if (!input.stepIds.includes(receipt.stepId)) continue;
    const prior = byStep.get(receipt.stepId);
    if (!prior || prior.status !== 'succeeded') byStep.set(receipt.stepId, { id: receipt.id, status: receipt.status });
  }
  const steps = input.stepIds.map(stepId => {
    const receipt = byStep.get(stepId);
    if (!receipt) return { stepId, status: 'not_executed' as const };
    if (receipt.status === 'succeeded') return { stepId, status: 'succeeded' as const, receiptId: receipt.id };
    if (receipt.status === 'failed' || receipt.status === 'cancelled') return { stepId, status: 'failed' as const, receiptId: receipt.id };
    return { stepId, status: 'not_executed' as const, receiptId: receipt.id };
  });
  const summary = {
    succeeded: steps.filter(s => s.status === 'succeeded').length,
    failed: steps.filter(s => s.status === 'failed').length,
    not_executed: steps.filter(s => s.status === 'not_executed').length,
  };
  let joined: Record<string, unknown> | null = null;
  if (input.branchPayloads && summary.failed === 0 && summary.not_executed === 0 && Object.keys(input.branchPayloads).length > 0) {
    joined = { kind: 'local_join', schemaVersion: 1, branches: structuredClone(input.branchPayloads) };
  }
  return { schemaVersion: 1, planId: input.planId, runId: input.runId, steps, summary, joined };
}
