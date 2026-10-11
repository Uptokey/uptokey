/**
 * Valor de Uso V1 — resultado confirmado vira ferramenta reutilizável.
 *
 * A receita nasce de um run cujo journal registra TODAS as etapas como concluídas com recibos.
 * O modelo nunca é tomado como prova: sem recibo concluído por etapa não há selo de origem.
 * Os literais escolhidos pelo usuário viram parâmetros tipados; literais que identificam o autor
 * (e-mail, caminho, identificadores de sessão/grant, URL com credencial) precisam virar parâmetro
 * ou a gravação é recusada para revisão. Etapas cujo argumento carrega a conversa original não
 * são reutilizáveis: uma nova execução não pode reenviar o conteúdo antigo.
 *
 * Nada aqui autoriza execução: usar a receita prepara um plano novo (snapshot, orçamento e
 * consentimento próprios) pelo percurso existente `recipes/exchange/prepare`.
 */
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson } from '@uptokey/sync-contract/canonical';
import { parseRecipe, type ExecutionPlan, type Recipe, type RecipeBinding, type WorkflowCommands } from '@uptokey/sync-contract/workflow';
import { assertNoForbiddenContent, inputShape, summarizeRecipeAuthorization } from './recipes.ts';
import type { CapabilityRegistry } from './capabilities.ts';

export class RecipeDerivationError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 422;
  readonly details?: unknown;
  constructor(code: string, status: 400 | 404 | 409 | 422 = 400, details?: unknown) { super(code); this.code = code; this.status = status; this.details = details; }
}

/** Author-identifying literal shapes; the same family the exchange refuses to publish. */
export const AUTHOR_IDENTIFYING = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|(?:[A-Za-z]:[\\/]|\/(?:Users|home|etc|var|tmp)\/)|(?:root|session|client|grant)_[A-Za-z0-9_-]{6,}|[?&](?:token|key|secret|signature|sig|auth|access_token)=/i;
/** Arguments that embed the original conversation or its prepared wire request. */
const CONVERSATION_ARGUMENTS = new Set(['chat', 'wire', 'messages', 'protocol', 'adaptation', 'provenance', 'response_style']);

interface RunSlot { run: { id: string; planId: string; planDigest: string; status: string; finishedAt: string | null }; receipts: Array<{ id: string; stepId: string; status: string; capabilityId: string; outputArtifactRefs: string[] }> }
interface BundleView { runs: RunSlot[]; artifacts: Array<{ id: string; runId: string; mediaType: string }> }

export interface DerivationCandidate {
  stepId: string;
  argument: string;
  capabilityId: string;
  type: 'string' | 'integer' | 'boolean' | 'structured';
  /** Short excerpt of the author's value for the review screen; never stored in the recipe. */
  preview: string;
  sensitive: boolean;
  parameterizable: boolean;
  suggestedName: string;
  /** Object keys of a structured literal, so the review can pre-mark question-like fields.
   *  Restored from the pre-incident bundle (output/recovery-2026-09-28/compiled-before/cli.js). */
  fields?: Array<{ key: string; type: 'string' | 'integer' | 'boolean' | 'structured'; preview: string; sensitive: boolean }>;
}

const literalType = (value: unknown): DerivationCandidate['type'] =>
  typeof value === 'string' ? 'string' : typeof value === 'boolean' ? 'boolean' : Number.isSafeInteger(value) ? 'integer' : 'structured';
const excerpt = (value: unknown) => { const text = typeof value === 'string' ? value : JSON.stringify(value); return text.length > 120 ? `${text.slice(0, 119)}…` : text; };
const suggested = (stepIndex: number, argument: string) => {
  const base = argument.toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '') || 'valor';
  return /^[a-z]/.test(base) ? (stepIndex === 0 ? base : `${base}_${stepIndex + 1}`) : `p_${base}`;
};

/** The run must exist for this plan, be terminal-succeeded and hold a succeeded receipt per step. */
export function confirmedRun(bundle: BundleView, plan: ExecutionPlan, runId: string): RunSlot {
  const slot = bundle.runs.find(item => item.run.id === runId);
  if (!slot || slot.run.planId !== plan.id) throw new RecipeDerivationError('recipe_source_missing', 404);
  if (slot.run.planDigest !== plan.digest) throw new RecipeDerivationError('recipe_source_not_confirmed', 409, { reason: 'plan_digest_mismatch' });
  if (slot.run.status !== 'succeeded' || !slot.run.finishedAt) throw new RecipeDerivationError('recipe_source_not_confirmed', 409, { reason: 'run_not_succeeded', status: slot.run.status });
  const missing = plan.steps.filter(step => !slot.receipts.some(receipt => receipt.stepId === step.id && receipt.status === 'succeeded')).map(step => step.id);
  if (missing.length) throw new RecipeDerivationError('recipe_source_not_confirmed', 409, { reason: 'receipt_missing', steps: missing });
  return slot;
}

export function derivationCandidates(plan: ExecutionPlan): DerivationCandidate[] {
  const byValue = new Map<string, string>();
  return plan.steps.flatMap((step, index) => Object.entries(step.arguments).flatMap(([argument, binding]) => {
    if (binding.kind !== 'literal') return [];
    const type = literalType(binding.value);
    const serialized = typeof binding.value === 'string' ? binding.value : JSON.stringify(binding.value);
    return [{
      stepId: step.id, argument, capabilityId: step.capabilityId, type,
      preview: CONVERSATION_ARGUMENTS.has(argument) ? '(conteúdo da conversa original)' : excerpt(binding.value),
      sensitive: AUTHOR_IDENTIFYING.test(serialized),
      parameterizable: !CONVERSATION_ARGUMENTS.has(argument) && (type !== 'structured' || ['object', 'array'].includes(inputShape(binding.value)?.type ?? '')),
      // Restored pre-incident behavior: structured object literals expose their keys for the
      // reuse review (question-like fields come pre-marked on the PWA side).
      ...type === 'structured' && binding.value && typeof binding.value === 'object' && !Array.isArray(binding.value) && !CONVERSATION_ARGUMENTS.has(argument) ? { fields: Object.entries(binding.value as Record<string, unknown>).filter(([, item]) => item !== null).slice(0, 32).map(([key, item]) => ({
        key,
        type: literalType(item),
        preview: excerpt(item),
        sensitive: AUTHOR_IDENTIFYING.test(typeof item === 'string' ? item : JSON.stringify(item))
      })) } : {},
      suggestedName: (() => {
        const key = `${type}:${serialized}`;
        const name = byValue.get(key) ?? suggested(index, argument);
        byValue.set(key, name);
        return name;
      })(),
    }];
  }));
}

const outputName = (mediaType: string) => mediaType.toLowerCase().replace('/', '.').replace(/[^a-z0-9_.-]/g, '-');
export function derivedOutputs(bundle: BundleView, runId: string): string[] {
  return [...new Set(bundle.artifacts.filter(item => item.runId === runId).map(item => outputName(item.mediaType)))].filter(name => /^[a-z][a-z0-9_.-]{0,127}$/.test(name)).slice(0, 64);
}

export function receiptsDigest(slot: RunSlot): string {
  const receipts = slot.receipts.map(({ id, stepId, status, capabilityId, outputArtifactRefs }) => ({ id, stepId, status, capabilityId, outputArtifactRefs: [...outputArtifactRefs].sort() }))
    .sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return createHash('sha256').update(canonicalJson(receipts)).digest('hex');
}

/** Review data for the "Reutilizar" screen: inputs that can vary, outputs and effects. */
export function previewDerivation(bundle: BundleView, plan: ExecutionPlan, runId: string, registry: CapabilityRegistry) {
  const slot = confirmedRun(bundle, plan, runId);
  const candidates = derivationCandidates(plan);
  const blocked = candidates.filter(item => CONVERSATION_ARGUMENTS.has(item.argument)).map(item => ({ stepId: item.stepId, argument: item.argument, capabilityId: item.capabilityId }));
  const provisional = parseRecipe({ schemaVersion: 1, id: 'preview', createdAt: new Date().toISOString(), version: 1, title: 'preview', description: '', parameters: [],
    steps: plan.steps, limits: plan.limits, expectedOutputs: [] });
  return {
    confirmed: true as const,
    runId: slot.run.id, planId: plan.id, finishedAt: slot.run.finishedAt,
    candidates: candidates.filter(item => !CONVERSATION_ARGUMENTS.has(item.argument)),
    reusable: blocked.length === 0,
    blocked,
    outputs: derivedOutputs(bundle, runId),
    authorization: summarizeRecipeAuthorization(provisional, registry),
  };
}

/**
 * Build the versioned recipe. The chosen literals become typed parameters; every other literal is
 * kept only when it neither identifies the author nor carries the original conversation.
 */
export function deriveRecipe(input: {
  bundle: BundleView; plan: ExecutionPlan; command: WorkflowCommands['createRecipe'] & { runId: string }; now: Date; registry: CapabilityRegistry;
}): Recipe {
  const { bundle, plan, command, now, registry } = input;
  const slot = confirmedRun(bundle, plan, command.runId);
  const chosen = command.parameters ?? [];
  const byTarget = new Map(chosen.map(item => [`${item.stepId}\u0000${item.argument}`, item]));
  const blocked: Array<{ stepId: string; argument: string }> = [];
  const review: Array<{ stepId: string; argument: string }> = [];
  const shapes = new Map<string, ReturnType<typeof inputShape>>();
  const defaults = new Map<string, Record<string, unknown>>();
  // A shared name over structured targets must describe one shape. With `fields`, only those
  // fields vary and the rest become reviewed defaults (never author-identifying values).
  const bindShape = (name: string, value: unknown, fields?: string[]) => {
    let shape = inputShape(value);
    let fixed: Record<string, unknown> | undefined;
    if (fields) {
      if (!shape || shape.type !== 'object') return false;
      const properties = shape.properties;
      if (fields.some(field => !Object.hasOwn(properties, field))) return false;
      const record = value as Record<string, unknown>;
      shape = { type: 'object', properties: Object.fromEntries(fields.map(field => [field, properties[field]!])), required: fields };
      fixed = Object.fromEntries(Object.entries(record).filter(([key, item]) => !fields.includes(key) && item !== null));
      if (!Object.keys(fixed).length) fixed = undefined;
    }
    if (!shape || (shape.type !== 'object' && shape.type !== 'array')) return false;
    const previous = shapes.get(name);
    if (previous && JSON.stringify(previous) !== JSON.stringify(shape)) return false;
    if (defaults.has(name) && JSON.stringify(defaults.get(name)) !== JSON.stringify(fixed)) return false;
    shapes.set(name, shape);
    if (fixed) defaults.set(name, fixed);
    return true;
  };
  const steps = plan.steps.map(step => ({ ...step, arguments: Object.fromEntries(Object.entries(step.arguments).map(([argument, binding]): [string, RecipeBinding] => {
    const selection = byTarget.get(`${step.id}\u0000${argument}`);
    if (binding.kind !== 'literal') {
      if (selection) throw new RecipeDerivationError('recipe_parameter_invalid', 400, { stepId: step.id, argument, reason: 'not_a_literal' });
      return [argument, binding];
    }
    if (CONVERSATION_ARGUMENTS.has(argument)) { blocked.push({ stepId: step.id, argument }); return [argument, binding]; }
    const type = literalType(binding.value);
    if (selection) {
      // A structured literal varies as a whole, described by its shape (never the author's values).
      if (type === 'structured' ? selection.type !== 'json' || !bindShape(selection.name, binding.value, selection.fields) : selection.type !== type || selection.fields !== undefined)
        throw new RecipeDerivationError('recipe_parameter_invalid', 400, { stepId: step.id, argument, reason: 'type_mismatch', type });
      return [argument, { kind: 'parameter', parameter: selection.name }];
    }
    const serialized = typeof binding.value === 'string' ? binding.value : JSON.stringify(binding.value);
    if (AUTHOR_IDENTIFYING.test(serialized)) review.push({ stepId: step.id, argument });
    return [argument, binding];
  })) }));
  const unknownTargets = chosen.filter(item => !plan.steps.some(step => step.id === item.stepId && Object.hasOwn(step.arguments, item.argument)));
  if (unknownTargets.length) throw new RecipeDerivationError('recipe_parameter_invalid', 400, { targets: unknownTargets.map(({ stepId, argument }) => ({ stepId, argument })), reason: 'unknown_argument' });
  if (blocked.length) throw new RecipeDerivationError('recipe_step_not_reusable', 422, { steps: blocked, reason: 'conversation_content' });
  for (const [name, fixed] of defaults) if (AUTHOR_IDENTIFYING.test(JSON.stringify(fixed))) {
    for (const item of chosen.filter(entry => entry.name === name)) review.push({ stepId: item.stepId, argument: item.argument });
  }
  if (review.length) throw new RecipeDerivationError('recipe_review_required', 409, { fields: review, reason: 'author_identifying_literal' });
  const finished = slot.run.finishedAt ? new Date(slot.run.finishedAt).toISOString().slice(0, 10) : '';
  const recipe = parseRecipe({
    schemaVersion: 1, id: `rec_${randomUUID().replaceAll('-', '')}`, createdAt: now.toISOString(), version: 1,
    title: command.title,
    description: command.description?.trim() || `Derivada de uma execução concluída${finished ? ` em ${finished}` : ''} com ${plan.steps.length} etapa(s).`,
    // Targets sharing a name become one input (e.g. the same query used by several steps).
    parameters: [...new Map(chosen.map(item => [item.name, item])).values()].map(({ name, type, label }) => ({ name, type,
      required: chosen.some(item => item.name === name && item.required), ...(label ? { label } : {}), ...(type === 'json' ? { schema: shapes.get(name) } : {}), ...(defaults.has(name) ? { defaults: defaults.get(name) } : {}) })),
    steps, limits: plan.limits, expectedOutputs: derivedOutputs(bundle, command.runId),
    origin: { kind: 'confirmed_run', runId: slot.run.id, planId: plan.id, planDigest: plan.digest, receiptsDigest: receiptsDigest(slot), sealedAt: now.toISOString() },
  });
  assertNoForbiddenContent(recipe);
  for (const step of recipe.steps) if (!registry.get(step.capabilityId, step.capabilityVersion)) throw new RecipeDerivationError('recipe_capability_missing', 409, { capabilityId: step.capabilityId });
  return recipe;
}
