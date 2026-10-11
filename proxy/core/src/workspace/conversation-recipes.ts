/**
 * Receitas DC (conversa com APIs) — listagem e preparação de planos W0.
 *
 * Lê a cópia do catálogo em quimera/integrations/conversation-recipes/catalog/
 * (ver PROVENANCE.md), resolve cada capabilityRef pelo CAPABILITY_MAPPINGS do
 * compilador canônico (recipe-compiler.js) contra o CapabilityRegistry vivo e
 * prepara planos provisórios SEM qualquer chamada externa (I01): compilação,
 * snapshot isolado, digest canônico e putPlan. Consentimento e execução seguem
 * o percurso existente (challenge/complete/startRun), sem semântica nova.
 *
 * O recipe-compiler.js é o compilador canônico; seu irmão recipe-compiler.ts é
 * uma revisão antiga divergente. O import dinâmico com especificador computado
 * evita que a resolução NodeNext do TypeScript/esbuild (.js -> .ts) carregue a
 * revisão errada no grafo de tipos ou no bundle.
 */
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { productCodeRoots } from "../../../../quimera/uptokey/scripts/quimera-isolation.mjs";
import {
  canonicalContextSnapshotPayload,
  parseExecutionPlan,
  validatePlanBindings,
  type DataDestination,
  type ExecutionPlan,
} from '@uptokey/sync-contract/workflow';
import {
  parseRecipeCatalog,
  parseRecipeCatalogFile,
  parseRecipePlanInput,
  type RecipeCatalog,
  type RecipeCatalogEntry,
  type RecipeStepStatus,
  type RecipeSummary,
} from "../../../integracoes/conversation-recipes/src/public-contract.ts";
import { computePlanDigest } from './planner.ts';
import type { CapabilityRegistry } from './capabilities.ts';
import type { WorkspaceStore } from './store.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function recipeResource(path: string): string {
  return join(productCodeRoots().INTEGRATIONS, 'conversation-recipes', path);
}

/**
 * Transformações locais com equivalente executável no runtime W5.
 *
 * Apenas `local.document.create` é de fato recomposto em um passo executável
 * (documentSteps em prepareRecipePlan). Os demais nós (dedup, tabela,
 * exportação, citação) NÃO têm executor equivalente no runtime: anunciá-los
 * como executáveis e descartá-los do plano omitiria transformações
 * silenciosamente (F04). Enquanto não houver executor próprio, eles devem
 * aparecer como `unsupported_local_transform`, tornando a receita
 * honestamente indisponível em vez de executar incompleta.
 */
const LOCAL_TRANSFORM_EQUIVALENTS: Record<string, string> = {
  'local.document.create': 'artifacts.markdown.create',
};

interface CapabilityMapping { capabilityId: string; version: number; type: string; status: string; reason?: string; }
interface CompilationResult {
  success: boolean;
  reason: string | null;
  executionPlan: ExecutionPlan | null;
  blockedNodes: Array<{ nodeId: string; capabilityRef: string; reason?: string }>;
}
interface CompilerModule {
  CAPABILITY_MAPPINGS: Record<string, CapabilityMapping>;
  compileRecipe(recipe: unknown, inputs: Record<string, unknown>, contextSnapshot: { id: string; digest: string; projectId: string; projectRevision?: number }): CompilationResult;
}

export class RecipePlanError extends Error {
  readonly code: string;
  readonly status: 400 | 404 | 409 | 503;
  readonly details?: unknown;
  constructor(code: string, status: 400 | 404 | 409 | 503 = 400, details?: unknown) {
    super(code);
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

export class WorkspaceConversationRecipes {
  private catalogPromise?: Promise<RecipeCatalogEntry[]>;
  private compilerPromise?: Promise<CompilerModule>;

  private loadCatalog(): Promise<RecipeCatalogEntry[]> {
    this.catalogPromise ??= Promise.resolve().then(() => readFile(recipeResource('catalog/recipes-catalog.json'), 'utf8'))
      .then(text => parseRecipeCatalogFile(JSON.parse(text)))
      .catch(error => { throw error instanceof Error && error.message === 'recipe_catalog_invalid' ? error : new RecipePlanError('recipes_unavailable', 503); });
    return this.catalogPromise;
  }

  private loadCompiler(): Promise<CompilerModule> {
    this.compilerPromise ??= Promise.resolve().then(() => import(pathToFileURL(recipeResource('src/recipe-compiler.js')).href) as Promise<CompilerModule>)
      .catch(() => { throw new RecipePlanError('recipes_unavailable', 503); });
    return this.compilerPromise;
  }

  /** Catálogo público com disponibilidade resolvida contra o registry vivo. Todos os passos sempre listados. */
  async catalogInfo(registry: CapabilityRegistry): Promise<RecipeCatalog> {
    const [entries, compiler] = await Promise.all([this.loadCatalog(), this.loadCompiler()]);
    const catalogRevision = entries[0]?.catalogRevision ?? 'unknown';
    const recipes = entries.map(entry => this.summarize(entry, compiler.CAPABILITY_MAPPINGS, registry));
    return parseRecipeCatalog({ schemaVersion: 1, catalogRevision, recipes });
  }

  private summarize(entry: RecipeCatalogEntry, mappings: Record<string, CapabilityMapping>, registry: CapabilityRegistry): RecipeSummary {
    const steps = entry.nodes.map(node => resolveNodeStatus(node.id, node.capabilityRef, mappings, registry));
    const blocked = steps.find(step => step.availability !== 'executable');
    const unavailableReason = blocked
      ? `${blocked.capabilityRef}: ${blocked.reason ?? blocked.availability}`
      : null;
    return {
      id: entry.id,
      name: entry.displayName,
      description: entry.description,
      inputs: Object.entries(entry.inputSchema.properties).map(([name, spec]) => ({
        name, type: spec.type, required: entry.inputSchema.required.includes(name),
        ...(spec.description !== undefined ? { description: spec.description } : {}),
      })),
      steps,
      available: !blocked,
      unavailableReason,
    };
  }

  /**
   * Prepara plano W0 provisório para uma receita. Puro (I01): nenhum fetch,
   * nenhuma inferência; somente snapshot, compilação, digest e persistência.
   */
  async prepareRecipePlan(
    store: WorkspaceStore,
    principal: string,
    projectId: string,
    input: unknown,
    signal: AbortSignal,
    registry: CapabilityRegistry,
  ): Promise<{ plan: ExecutionPlan }> {
    let command;
    try { command = parseRecipePlanInput(input); }
    catch { throw new RecipePlanError('recipe_plan_input_invalid', 400); }
    const [entries, compiler] = await Promise.all([this.loadCatalog(), this.loadCompiler()]);
    const recipe = entries.find(entry => entry.id === command.recipeId);
    if (!recipe) throw new RecipePlanError('recipe_not_found', 404);
    const project = await store.getProject(principal, projectId);
    if (project.revision !== command.expectedRevision) throw new RecipePlanError('workspace_revision_conflict', 409);

    const invalidFields = validateRecipeInputs(recipe, command.inputs);
    if (invalidFields.length) throw new RecipePlanError('recipe_inputs_invalid', 400, { fields: invalidFields });

    const summary = this.summarize(recipe, compiler.CAPABILITY_MAPPINGS, registry);
    if (!summary.available) throw new RecipePlanError('recipe_unavailable', 409, { reason: summary.unavailableReason, steps: summary.steps });

    // Destinos: cada capacidade executável resolvida + equivalentes locais.
    const destinations = new Map<string, DataDestination>();
    for (const step of summary.steps) {
      const equivalent = LOCAL_TRANSFORM_EQUIVALENTS[compiler.CAPABILITY_MAPPINGS[step.capabilityRef]?.capabilityId ?? ''];
      const capabilityId = equivalent ?? step.capabilityId;
      if (!capabilityId) continue;
      const capability = registry.list().find(item => item.id === capabilityId);
      if (capability) destinations.set(`${capability.dataDestination.kind}:${capability.dataDestination.id}`, capability.dataDestination);
    }
    signal.throwIfAborted();
    const snapshot = await store.snapshotContext(principal, projectId, {
      selectedEntryIds: [],
      selectedArtifactIds: [],
      excludedEntryIds: project.entries.map(entry => entry.id),
      allowedDestinations: [...destinations.values()],
      maxContextBytes: 64_000,
    });
    const snapshotDigest = sha(canonicalContextSnapshotPayload(snapshot));
    signal.throwIfAborted();

    const compiled = compiler.compileRecipe(recipe, command.inputs, {
      id: snapshot.id, digest: snapshotDigest, projectId, projectRevision: project.revision,
    });
    if (!compiled.success || !compiled.executionPlan) {
      throw new RecipePlanError('recipe_unavailable', 409, { reason: compiled.reason, blockedNodes: compiled.blockedNodes });
    }

    // Passos de documento para cada nó local.document.create, espelhando o
    // formato do passo final de runtime.createPlan (bindings source* -> records).
    const compiledPlan = compiled.executionPlan;
    const compiledStepIds = new Set(compiledPlan.steps.map(step => step.id));
    const nodeStepIds = new Map<string, string>();
    let counter = 0;
    for (const node of recipe.nodes) {
      const mapping = compiler.CAPABILITY_MAPPINGS[node.capabilityRef];
      if (!mapping || mapping.type === 'local_transform') continue;
      nodeStepIds.set(node.id, `s_${counter++}_${node.id.replace(/[^A-Za-z0-9_]/g, '_')}`);
    }
    if ([...nodeStepIds.values()].some(id => !compiledStepIds.has(id))) throw new RecipePlanError('recipes_unavailable', 503);

    const mainInput = recipe.inputSchema.required.map(name => command.inputs[name]).find(value => value !== undefined);
    const objective = `${recipe.displayName}: ${typeof mainInput === 'string' ? mainInput : recipe.id}`.replace(/\s+/g, ' ').slice(0, 300);
    const documentSteps: ExecutionPlan['steps'] = [];
    for (const node of recipe.nodes) {
      const mapping = compiler.CAPABILITY_MAPPINGS[node.capabilityRef];
      if (mapping?.capabilityId !== 'local.document.create') continue;
      let sources = node.dependsOn.map(dep => nodeStepIds.get(dep)).filter((id): id is string => !!id);
      if (!sources.length) sources = compiledPlan.steps.map(step => step.id);
      documentSteps.push({
        id: `doc_${node.id.replace(/[^A-Za-z0-9_]/g, '_')}`,
        capabilityId: 'artifacts.markdown.create',
        capabilityVersion: 1,
        arguments: {
          ...Object.fromEntries(sources.map((stepId, index) => [`source${index}`, { kind: 'step_output' as const, stepId, output: 'records' }])),
          objective: { kind: 'literal' as const, value: objective },
        },
      });
    }

    const steps = [...compiledPlan.steps, ...documentSteps];
    const limits = {
      ...compiledPlan.limits,
      maxSteps: Math.max(compiledPlan.limits.maxSteps, steps.length),
      maxCalls: Math.max(compiledPlan.limits.maxCalls, steps.length),
      maxOutputBytes: compiledPlan.limits.maxOutputBytes + 131_072 * documentSteps.length,
    };
    let plan: ExecutionPlan = { ...compiledPlan, projectRevision: project.revision, steps, limits, digest: '0'.repeat(64) };
    plan = parseExecutionPlan({ ...plan, digest: computePlanDigest(plan) });
    validatePlanBindings(plan, snapshot, registry.forPlan(plan));
    signal.throwIfAborted();
    try {
      await store.putPlan(principal, plan, snapshot);
    } catch (error) {
      if (error instanceof Error && error.message === 'project_run_active') throw new RecipePlanError('project_run_active', 409);
      throw error;
    }
    return { plan };
  }
}

function resolveNodeStatus(
  nodeId: string,
  capabilityRef: string,
  mappings: Record<string, CapabilityMapping>,
  registry: CapabilityRegistry,
): RecipeStepStatus {
  const base = { nodeId, capabilityRef };
  const mapping = mappings[capabilityRef];
  if (!mapping) return { ...base, capabilityId: null, availability: 'unmapped', reason: 'Capability ref not recognized by the recipe compiler' };
  if (mapping.type === 'local_transform') {
    const equivalent = LOCAL_TRANSFORM_EQUIVALENTS[mapping.capabilityId];
    if (equivalent) {
      const capability = registry.get(equivalent, 1);
      if (capability?.availability === 'executable') return { ...base, capabilityId: equivalent, availability: 'executable' };
      return { ...base, capabilityId: equivalent, availability: 'not_registered', reason: `Runtime equivalent ${equivalent} is not executable in the registry` };
    }
    return { ...base, capabilityId: mapping.capabilityId, availability: 'unsupported_local_transform', reason: `Local transform ${mapping.capabilityId} has no runtime equivalent yet` };
  }
  if (mapping.status === 'requires_oauth') return { ...base, capabilityId: mapping.capabilityId, availability: 'requires_oauth', reason: mapping.reason ?? 'Requires an authenticated OAuth connection' };
  if (mapping.status === 'unregistered') return { ...base, capabilityId: mapping.capabilityId, availability: 'unregistered', reason: mapping.reason ?? 'Provider is not registered in the active product' };
  if (mapping.status === 'candidate') {
    const candidateCap = registry.get(mapping.capabilityId, mapping.version);
    if (candidateCap && candidateCap.availability === 'executable') {
      return { ...base, capabilityId: mapping.capabilityId, availability: 'executable' };
    }
    return { ...base, capabilityId: mapping.capabilityId, availability: 'candidate', reason: 'Connector is a catalog candidate, not admitted for execution' };
  }
  const capability = registry.get(mapping.capabilityId, mapping.version);
  if (!capability || capability.availability !== 'executable') {
    return { ...base, capabilityId: mapping.capabilityId, availability: 'not_registered', reason: `Capability ${mapping.capabilityId} is not executable in the runtime registry` };
  }
  return { ...base, capabilityId: mapping.capabilityId, availability: 'executable' };
}

/** Valida entradas contra o inputSchema da receita; devolve os campos inválidos. */
function validateRecipeInputs(recipe: RecipeCatalogEntry, inputs: Record<string, unknown>): string[] {
  const problems: string[] = [];
  const properties = recipe.inputSchema.properties;
  for (const key of Object.keys(inputs)) if (!(key in properties)) problems.push(`${key}:unknown`);
  for (const name of recipe.inputSchema.required) {
    const value = inputs[name];
    if (value === undefined || value === null || value === '') problems.push(`${name}:required`);
  }
  for (const [name, spec] of Object.entries(properties)) {
    const value = inputs[name];
    if (value === undefined || value === null) continue;
    const valid =
      spec.type === 'string' ? typeof value === 'string' :
      spec.type === 'number' ? typeof value === 'number' && Number.isFinite(value) :
      spec.type === 'integer' ? Number.isSafeInteger(value) :
      spec.type === 'boolean' ? typeof value === 'boolean' :
      Array.isArray(value);
    if (!valid) problems.push(`${name}:type`);
  }
  return problems;
}
