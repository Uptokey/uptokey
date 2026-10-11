import { RSS_CAPABILITY } from './capabilities.ts';
import { fetchAndNormalizeRss } from "../../../integracoes/api-instruments/src/adapters/rss-adapter.ts";
import { createHash } from 'node:crypto';
import { ALL_CURATED_OPERATIONS } from "../../../integracoes/api-instruments/src/index.ts";
import { prepareApiCall, reconstructPreparedArguments,publicHttpsFetch } from "../../../integracoes/api-instruments/src/governed-transport.ts";
import { projectApiOutcome, type StructuredOutcome } from "../../../integracoes/api-instruments/src/projection.ts";
import type { PreparedApiCall, CuratedOperation } from "../../../integracoes/api-instruments/src/types.ts";
import { createApiInstrumentDispatcher, createProvisionalApiInstrumentPlan, createProvisionalComposedApiInstrumentPlan } from "../../../integracoes/api-instruments/src/service-integration.ts";
import {
  ingestOpenApiSource, ingestObservedResponse, parseCurlSource, previewLearnedPlan,
  canExecuteRecipe, buildPromotionPackage, acceptPromotionReview, revokeRecipe,
  parseLearnedApiRecipe, matchRecipeByAlias,
  type LearnedApiRecipe, type LearnedPlanPreview, type PromotionEvidence, type PromotionPackage,
} from "../../../integracoes/api-instruments/src/learned-recipes.ts";
export type { LearnedApiRecipe, LearnedPlanPreview, PromotionPackage };
import { parseApiPlanInput, parseApiInstrumentCatalog, parseApiCompositePlanInput, projectComposedRunCoverage } from "../../../integracoes/api-instruments/src/public-contract.ts";
export { projectComposedRunCoverage };
import {type ProvenanceCacheLimits, type ProvenanceCacheMetrics } from "../../../integracoes/api-instruments/src/provenance-cache.ts";
import {GovernedReadCache} from './read-cache.ts';
import {getActiveEfficiencyPolicy} from './efficiency-pipeline.ts';
import type { EffectRequest, EffectOutcome } from './executor.ts';
import type { WorkspaceStore } from './store.ts';
import {TYPESAFE_INTENT_CAPABILITY,prepareTypeSafeIntentPlan,createTypeSafeIntentDispatcher} from "../../../integracoes/api-instruments/src/typesafe-intent-adapter.ts";
import {createRunJournal} from './journal.ts';
import {canonicalJson} from '@uptokey/sync-contract/canonical';
import {isDataRecord as isRecord} from '@uptokey/sync-contract/plain-data';
import type {TypeSafeProfileOwner} from './classification-service.ts';

/** Cache provenance was not persisted by the executor; null preserves that uncertainty. */
export type ApiArtifactProjection = Omit<StructuredOutcome, 'cached'> & {cached: boolean | null; cacheAgeSeconds?: number | null; sourceUrl: string};

export interface ApiInstrumentsOptions {
  authorize?:(request:EffectRequest)=>Promise<void>;
  prepareAuthenticated?:(principal:string,projectId:string,recipe:LearnedApiRecipe,input:{expectedRevision:number;operationId:string;parameters:Record<string,unknown>})=>Promise<{plan:import('@uptokey/sync-contract/workflow').ExecutionPlan}>;
  enabled?: () => boolean;
  fetchFn?: typeof fetch;
  semantic?: {model:string;resolveCredential:(request:EffectRequest)=>Promise<string|undefined>;fetchFn?:typeof fetch};
  semanticProfile?:TypeSafeProfileOwner;
  semanticFetchFn?:typeof fetch;
}
/** Reuses imported schemas and the one W5 executor; never starts an independent run. */
export class WorkspaceApiInstruments {
  private cache = new GovernedReadCache();
  private options: ApiInstrumentsOptions;
  private semanticDispatchers=new Map<string,ReturnType<typeof createTypeSafeIntentDispatcher>>();
  constructor(options: ApiInstrumentsOptions = {}) { this.options=options; }
  private operations() { return this.options.enabled?.() === false ? [] : ALL_CURATED_OPERATIONS.filter(op => op.capability.effect === 'read_external' && op.serviceId !== 'typesafe'); }
  capabilities() { return [...this.operations().map(op => op.capability),...((this.options.semantic||this.options.semanticProfile)&&this.operations().length?[TYPESAFE_INTENT_CAPABILITY]:[])]; }
  private async semanticSettings(principal:string){
    if(this.options.semantic)return this.options.semantic;
    const owner=this.options.semanticProfile,profile=await owner?.info(principal);
    if(!owner||!profile?.configured||!profile.enabled)return undefined;
    return {model:profile.model,profileRevision:profile.revision,fetchFn:this.options.semanticFetchFn,
      resolveCredential:(request:EffectRequest)=>owner.resolveCredential(principal,profile.revision,request.signal),
      validateProfile:async()=>{const current=await owner.info(principal);return current.configured&&current.enabled&&current.revision===profile.revision;}};
  }
  async infoFor(principal:string){const base=this.info(),settings=await this.semanticSettings(principal);return parseApiInstrumentCatalog({...base,semantic:{available:!!settings&&base.available,model:settings&&base.available?settings.model:null}});}
  /**
   * Stage 10 cache projection for stage 06 presentation: hit/age/provenance and
   * limits as metadata only. A hit replays a stored governed read; it never
   * authorizes or repeats a write, job or approval. Consumed by the usage view,
   * never a routing decision.
   */
  cacheMetrics(): { provenance: ProvenanceCacheMetrics; limits: ProvenanceCacheLimits; semantic:ReturnType<GovernedReadCache['semanticMetrics']> } {
    return { provenance: this.cache.metrics(), limits: this.cache.limits(),semantic:this.cache.semanticMetrics() };
  }
  /**
   * Operator-driven revocation (credential/policy change, access exclusion).
   * The journal/store stay intact; only volatile read replays are dropped.
   */
  invalidateProvenance(): number { return this.cache.invalidateAll(); }
  /* ------------------------------------------------------------------ */
  /* Stage 18 learned recipes: owner-bound, never global. Ingest performs */
  /* zero network calls and persists zero secret material.               */
  /* ------------------------------------------------------------------ */
  /** Latest revision per recipe id, owner- and project-bound by the store. */
  async listLearnedRecipes(store: WorkspaceStore, principal: string, projectId: string) {
    return (await store.listLearnedRecipes(principal, projectId)).map(recipe => ({
      id: recipe.id, revision: recipe.revision, declaredBrand: recipe.declaredBrand,
      ...(recipe.resourceId?{resourceId:recipe.resourceId}:{}),authScheme:recipe.authScheme,
      verifiedOrigin: recipe.verifiedOrigin, unverifiedOrigin: recipe.verifiedOrigin === null,
      trustLevel: recipe.trustLevel, origins: [...new Set(recipe.operations.map(op => op.serverUrl))],
      operations: recipe.operations.map(op => op.operationId), updatedAt: recipe.updatedAt,
    }));
  }
  async ingestLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, input: unknown, signal: AbortSignal) {
    const value = this.learnedIngestInput(input);
    const project = await store.getProject(principal, projectId);
    if (project.revision !== value.expectedRevision) throw new Error('workspace_revision_conflict');
    signal.throwIfAborted();
    const base = { ownerPrincipalId: principal, projectId, declaredBrand: value.declaredBrand, ...(value.recipeId ? { recipeId: value.recipeId } : {}), ...(value.aliases ? { aliases: value.aliases } : {}), ...(value.functionTags ? { functionTags: value.functionTags } : {}) };
    let recipe: LearnedApiRecipe;
    let refused: Array<{ operationId: string; code: string }> = [];
    if (value.source.kind === 'openapi') {
      const outcome = ingestOpenApiSource(value.source.document, base);
      recipe = outcome.recipe; refused = outcome.refused;
    } else if (value.source.kind === 'curl') {
      const candidate = parseCurlSource(value.source.text);
      recipe = ingestObservedResponse({ url: candidate.url + this.querySuffix(candidate.query), sample: {}, parameters: Object.keys(candidate.query).map(name => ({ name, type: 'string' as const })) },
        { ...base, operationName: value.source.operation ?? 'lookup' });
    } else {
      recipe = ingestObservedResponse({ url: value.source.url, sample: value.source.sample ?? {}, ...(value.source.parameters ? { parameters: value.source.parameters } : {}), ...(value.source.operation ? { operationName: value.source.operation } : {}) }, base);
    }
    signal.throwIfAborted();
    // Re-ingest of an existing id becomes the next revision; history is preserved.
    const existing = value.recipeId ? await store.getLearnedRecipe(principal, projectId, value.recipeId) : undefined;
    const versioned = existing ? { ...recipe, id: existing.id, revision: existing.revision + 1, createdAt: existing.createdAt } : recipe;
    const saved = await store.putLearnedRecipe(principal, parseLearnedApiRecipe({...versioned,...(value.resourceId?{resourceId:value.resourceId}:existing?.resourceId?{resourceId:existing.resourceId}:{})}));
    return { recipe: saved, refused };
  }
  async previewLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, input: unknown): Promise<LearnedPlanPreview> {
    const value = this.learnedPreviewInput(input);
    const recipe = await this.ownedLearnedRecipe(store, principal, projectId, value.recipeId);
    if (recipe.trustLevel === 'revoked_or_stale') throw new Error('recipe_revoked_or_stale');
    return previewLearnedPlan(recipe, value.operationId, value.parameters);
  }
  async prepareLearnedPlan(store: WorkspaceStore, principal: string, projectId: string, input: unknown, signal: AbortSignal) {
    const value = this.learnedPrepareInput(input);
    const project = await store.getProject(principal, projectId);
    if (project.revision !== value.expectedRevision) throw new Error('workspace_revision_conflict');
    const recipe = await this.ownedLearnedRecipe(store, principal, projectId, value.recipeId);
    const gate = canExecuteRecipe(recipe, principal, projectId);
    if (gate.executable === false) throw new Error(gate.code);
    const operation = recipe.operations.find(op => op.operationId === value.operationId);
    if (!operation) throw new Error('learned_unknown_operation');
    if(recipe.authScheme!=='none'){
      if(!this.options.prepareAuthenticated)throw new Error('service_unavailable');
      const result=await this.options.prepareAuthenticated(principal,projectId,recipe,{...value,operationId:operation.id});return {...result,preview:previewLearnedPlan(recipe,value.operationId,value.parameters)};
    }
    signal.throwIfAborted();
    const prepared = prepareApiCall(operation, value.parameters);
    signal.throwIfAborted();
    const { plan } = await createProvisionalApiInstrumentPlan(store, principal, projectId, operation, prepared);
    return { plan, preview: previewLearnedPlan(recipe, value.operationId, value.parameters) };
  }
  async matchLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, phrase: string, locale?: string) {
    const recipes = await store.listLearnedRecipes(principal, projectId);
    const match = matchRecipeByAlias(phrase, recipes, locale);
    return match ? { recipeId: match.recipe.id, operationId: match.operationId, confidence: match.confidence, source: match.source, trustLevel: match.recipe.trustLevel, verifiedOrigin: match.recipe.verifiedOrigin } : null;
  }
  async exportLearnedPackage(store: WorkspaceStore, principal: string, projectId: string, recipeId: string): Promise<PromotionPackage> {
    const recipe = await this.ownedLearnedRecipe(store, principal, projectId, recipeId);
    return buildPromotionPackage(recipe);
  }
  async reviewLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, recipeId: string, evidence: unknown) {
    const recipe = await this.ownedLearnedRecipe(store, principal, projectId, recipeId);
    // F08: reviewer identity is server-derived (the authenticated principal);
    // client-declared maintainer names carry no authority. An owner review is
    // recorded as a private approval and never grants verified_preset.
    const next = acceptPromotionReview(recipe, evidence as PromotionEvidence, `local:${principal}`, 'owner');
    return store.putLearnedRecipe(principal, next);
  }
  async revokeLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, recipeId: string, reason: unknown) {
    const recipe = await this.ownedLearnedRecipe(store, principal, projectId, recipeId);
    if (typeof reason !== 'string') throw new Error('learned_revoke_invalid');
    return store.putLearnedRecipe(principal, revokeRecipe(recipe, reason));
  }
  /** Latest revision, owner- and project-bound; unknown ids read as unavailable (never cross-user). */
  private async ownedLearnedRecipe(store: WorkspaceStore, principal: string, projectId: string, recipeId: string): Promise<LearnedApiRecipe> {
    if (typeof recipeId !== 'string' || !recipeId) throw new Error('learned_unknown_recipe');
    const recipe = await store.getLearnedRecipe(principal, projectId, recipeId);
    if (!recipe || recipe.ownerPrincipalId !== principal || recipe.projectId !== projectId) throw new Error('learned_unknown_recipe');
    return recipe;
  }
  /** Compiled operations of executable revisions for this owner/project (dispatch catalog). */
  private async dispatchableLearnedOperations(store: WorkspaceStore, principal: string, projectId: string): Promise<CuratedOperation[]> {
    const recipes = await store.listLearnedRecipes(principal, projectId);
    const operations: CuratedOperation[] = [];
    for (const recipe of recipes) {
      if (recipe.ownerPrincipalId !== principal || recipe.projectId !== projectId) continue;
      if (!canExecuteRecipe(recipe, principal, projectId).executable) continue;
      operations.push(...recipe.operations);
    }
    return operations;
  }
  /** Capability descriptors of executable learned operations for this owner/project.
   *  Used by validation boundaries (verifySnapshot) so consent validates against
   *  the same canonical resolution the executor uses (F02), never globally. */
  async learnedCapabilities(store: WorkspaceStore, principal: string, projectId: string): Promise<CuratedOperation['capability'][]> {
    return (await this.dispatchableLearnedOperations(store, principal, projectId)).map(op => op.capability);
  }
  private querySuffix(query: Record<string, string>): string {
    const names = Object.keys(query).sort();
    return names.length === 0 ? '' : '?' + names.map(name => `${encodeURIComponent(name)}=${encodeURIComponent(query[name]!)}`).join('&');
  }
  private learnedIngestInput(input: unknown): { resourceId?:string; expectedRevision: number; recipeId?: string; declaredBrand: string; aliases?: Record<string, string[]>; functionTags?: string[]; source: { kind: 'openapi'; document: unknown } | { kind: 'curl'; text: string; operation?: string } | { kind: 'observed'; url: string; sample?: unknown; parameters?: Array<{ name: string; type: 'string' | 'number' | 'integer' | 'boolean'; required?: boolean; example?: string | number | boolean | null }>; operation?: string } } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('api_instruments_invalid');
    const value = input as Record<string, unknown>;
    if(value.resourceId!==undefined&&(typeof value.resourceId!=='string'||!/^[a-z][a-z0-9_-]{0,159}$/.test(value.resourceId)))throw new Error('api_instruments_invalid');
    const keys = Object.keys(value).filter(key=>key!=='resourceId').sort().join(',');
    if (keys !== 'declaredBrand,expectedRevision,source' && keys !== 'aliases,declaredBrand,expectedRevision,source' && keys !== 'declaredBrand,expectedRevision,functionTags,source' && keys !== 'aliases,declaredBrand,expectedRevision,functionTags,source' && keys !== 'declaredBrand,expectedRevision,recipeId,source' && keys !== 'aliases,declaredBrand,expectedRevision,functionTags,recipeId,source') throw new Error('api_instruments_invalid');
    if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new Error('api_instruments_invalid');
    if (typeof value.declaredBrand !== 'string' || !value.declaredBrand.trim() || value.declaredBrand.length > 120) throw new Error('api_instruments_invalid');
    if (value.recipeId !== undefined && (typeof value.recipeId !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value.recipeId))) throw new Error('api_instruments_invalid');
    const source = value.source as Record<string, unknown>;
    if (!source || typeof source !== 'object' || Array.isArray(source) || typeof source.kind !== 'string') throw new Error('api_instruments_invalid');
    if (source.kind === 'openapi') {
      if (!source.document || typeof source.document !== 'object') throw new Error('api_instruments_invalid');
      return { ...(value.resourceId?{resourceId:value.resourceId as string}:{}), expectedRevision: value.expectedRevision as number, ...(value.recipeId ? { recipeId: value.recipeId as string } : {}), declaredBrand: value.declaredBrand, ...(value.aliases ? { aliases: value.aliases as Record<string, string[]> } : {}), ...(value.functionTags ? { functionTags: value.functionTags as string[] } : {}), source: { kind: 'openapi', document: source.document } };
    }
    if (source.kind === 'curl') {
      if (typeof source.text !== 'string' || !source.text.trim() || source.text.length > 256 * 1024) throw new Error('api_instruments_invalid');
      if (source.operation !== undefined && typeof source.operation !== 'string') throw new Error('api_instruments_invalid');
      return { ...(value.resourceId?{resourceId:value.resourceId as string}:{}), expectedRevision: value.expectedRevision as number, ...(value.recipeId ? { recipeId: value.recipeId as string } : {}), declaredBrand: value.declaredBrand, ...(value.aliases ? { aliases: value.aliases as Record<string, string[]> } : {}), ...(value.functionTags ? { functionTags: value.functionTags as string[] } : {}), source: { kind: 'curl', text: source.text, ...(typeof source.operation === 'string' ? { operation: source.operation } : {}) } };
    }
    if (source.kind === 'observed') {
      if (typeof source.url !== 'string') throw new Error('api_instruments_invalid');
      return { ...(value.resourceId?{resourceId:value.resourceId as string}:{}), expectedRevision: value.expectedRevision as number, ...(value.recipeId ? { recipeId: value.recipeId as string } : {}), declaredBrand: value.declaredBrand, ...(value.aliases ? { aliases: value.aliases as Record<string, string[]> } : {}), ...(value.functionTags ? { functionTags: value.functionTags as string[] } : {}), source: { kind: 'observed', url: source.url, ...(source.sample !== undefined ? { sample: source.sample } : {}), ...(source.parameters !== undefined ? { parameters: source.parameters as Array<{ name: string; type: 'string' | 'number' | 'integer' | 'boolean'; required?: boolean; example?: string | number | boolean | null }> } : {}), ...(typeof source.operation === 'string' ? { operation: source.operation } : {}) } };
    }
    throw new Error('api_instruments_invalid');
  }
  private learnedPreviewInput(input: unknown): { recipeId: string; operationId: string; parameters: Record<string, unknown> } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('api_instruments_invalid');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'operationId,parameters,recipeId' || typeof value.recipeId !== 'string' || typeof value.operationId !== 'string' || !isRecord(value.parameters)) throw new Error('api_instruments_invalid');
    return { recipeId: value.recipeId, operationId: value.operationId, parameters: value.parameters as Record<string, unknown> };
  }
  private learnedPrepareInput(input: unknown): { expectedRevision: number; recipeId: string; operationId: string; parameters: Record<string, unknown> } {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('api_instruments_invalid');
    const value = input as Record<string, unknown>;
    if (Object.keys(value).sort().join(',') !== 'expectedRevision,operationId,parameters,recipeId' || !Number.isSafeInteger(value.expectedRevision) || typeof value.recipeId !== 'string' || typeof value.operationId !== 'string' || !isRecord(value.parameters)) throw new Error('api_instruments_invalid');
    return { expectedRevision: value.expectedRevision as number, recipeId: value.recipeId, operationId: value.operationId, parameters: value.parameters as Record<string, unknown> };
  }
  info() {
    const ops = this.operations();
    const catalogDigest = createHash('sha256').update(JSON.stringify(ops.map(op => [op.id,op.schemaDigest,op.documentDigest]))).digest('hex');
    return parseApiInstrumentCatalog({schemaVersion:1, available:ops.length > 0, catalogDigest,semantic:{available:!!this.options.semantic&&ops.length>0,model:ops.length?this.options.semantic?.model??null:null},
      operations:ops.map(({id,operationId,serviceId,summary,description,parameters,metadata}) => ({id,operationId,serviceId,summary,description,parameters,metadata}))});
  }
  async prepare(store:WorkspaceStore, principal:string, projectId:string, input:unknown, signal:AbortSignal) {
    const command = parseApiPlanInput(input);
    const project = await store.getProject(principal,projectId);
    if (project.revision !== command.expectedRevision) throw new Error('workspace_revision_conflict');
    if (command.catalogDigest !== this.info().catalogDigest) throw new Error('api_catalog_changed');
    const operation = this.operations().find(op => op.id === command.operationId);
    if (!operation) throw new Error('api_operation_unavailable');
    const prepared = prepareApiCall(operation,command.parameters);
    signal.throwIfAborted();
    return createProvisionalApiInstrumentPlan(store,principal,projectId,operation,prepared);
  }
  async projectArtifact(store:WorkspaceStore, principal:string, projectId:string, artifactId:string):Promise<ApiArtifactProjection> {
    const bundle = await store.getBundle(principal,projectId);
    const artifact = bundle.artifacts.find(item => item.id === artifactId && item.projectId === projectId && item.mediaType === 'application/json');
    const record = artifact && bundle.runs.find(item => item.run.id === artifact.runId && item.run.principalId === principal);
    const receipts = record?.receipts.filter(item => item.status === 'succeeded' && item.outputArtifactRefs.includes(artifactId) && artifact!.receiptRefs.includes(item.id));
    if (!artifact || !record || receipts?.length !== 1) throw new Error('api_projection_unavailable');
    const receipt = receipts[0]!;
    const plan = bundle.plans.find(item => item.id === record.run.planId && item.digest === record.run.planDigest);
    const step = plan?.steps.find(item => item.id === receipt.stepId && item.capabilityId === receipt.capabilityId && item.capabilityVersion === receipt.capabilityVersion);
    // Historical artifacts stay readable across trust changes and revocation;
    // owner and project binding still apply. Curated operations resolve
    // globally; learned ones resolve from the owner's project bundle only.
    let operation = ALL_CURATED_OPERATIONS.find(item => item.id === receipt.capabilityId && item.capability.effect === 'read_external' && item.capability.version === receipt.capabilityVersion);
    if (!operation && receipt.capabilityId.startsWith('api.learned_')) {
      const recipes = await store.listLearnedRecipes(principal, projectId);
      for (const recipe of recipes) {
        if (recipe.ownerPrincipalId !== principal || recipe.projectId !== projectId) continue;
        const found = recipe.operations.find(item => item.id === receipt.capabilityId && item.capability.version === receipt.capabilityVersion);
        if (found) { operation = found; break; }
      }
    }
    if (!operation || !step) throw new Error('api_projection_unavailable');
    const binding = step.arguments.prepared_call;
    const sources = receipt.sources.filter(item => item.receiptId === receipt.id && artifact.sourceRefs.includes(item.id) && item.sourceId === operation.serviceId);
    if (binding?.kind !== 'literal' || sources.length !== 1) throw new Error('api_projection_binding_invalid');
    const source = sources[0]!;
    let prepared:PreparedApiCall;
    try {
      const original = binding.value as unknown as PreparedApiCall;
      const validated = prepareApiCall(operation,reconstructPreparedArguments(operation,original));
      if (canonicalJson(validated) !== canonicalJson(original)) throw new Error('prepared_binding');
      const url = new URL(source.url);
      if (url.origin !== original.origin || url.pathname !== original.path || url.username || url.password || url.hash || source.externalId !== source.url || !Number.isFinite(Date.parse(source.retrievedAt))) throw new Error('source_binding');
      const query:Record<string,string> = {};
      for (const [key,value] of url.searchParams) { if (Object.hasOwn(query,key)) throw new Error('duplicate_parameter'); query[key]=value; }
      prepared = prepareApiCall(operation,reconstructPreparedArguments(operation,{...original,query}));
      if (prepared.url !== source.url) throw new Error('source_url');
      const dependent = step.arguments.dependent_input;
      if (!dependent && source.url !== original.url) throw new Error('literal_source');
      if (dependent) {
        const prior = plan!.steps.find(item => item.id === (dependent.kind === 'step_output' ? dependent.stepId : ''));
        if (dependent.kind !== 'step_output' || dependent.output !== 'api_result' || prior?.capabilityId !== 'api.rest_countries.get_country_by_name' || !['get_weather_forecast','get_ground_elevation'].includes(operation.operationId)) throw new Error('dependency_binding');
        const withoutCoordinates = (value:Record<string,string>) => Object.fromEntries(Object.entries(value).filter(([key]) => !['latitude','longitude'].includes(key)));
        if (canonicalJson(withoutCoordinates(original.query)) !== canonicalJson(withoutCoordinates(prepared.query))) throw new Error('resolved_source');
      }
    } catch { throw new Error('api_projection_binding_invalid'); }
    // readTextArtifact verifies the sealed bytes, declared length and SHA before parsing.
    const data:unknown = JSON.parse(await store.readTextArtifact(principal,projectId,artifactId));
    const projected = projectApiOutcome(operation,prepared,{kind:'completed',data,operation:operation.operationId,origin:prepared.origin,retrievedAt:source.retrievedAt,byteLength:artifact.byteLength});
    // Derived only from durable fields: a source retrieved before this attempt started was served by the provenance cache.
    const retrievedMs=Date.parse(source.retrievedAt),startedMs=Date.parse(receipt.startedAt);
    const cached=Number.isFinite(retrievedMs)&&Number.isFinite(startedMs)&&retrievedMs<startedMs?true:null;
    return {...projected,cached,cacheAgeSeconds:cached?Math.floor((startedMs-retrievedMs)/1000):null,sourceUrl:source.url};
  }
  async prepareIntent(store:WorkspaceStore,principal:string,projectId:string,input:unknown,signal:AbortSignal){
    if(!input||typeof input!=='object'||Array.isArray(input))throw new Error('api_instruments_invalid');
    const value=input as Record<string,unknown>;
    if(Object.keys(value).sort().join(',')!=='catalogDigest,expectedRevision,phrase'||typeof value.phrase!=='string'||!value.phrase.trim()||value.phrase.length>4000)throw new Error('api_instruments_invalid');
    const project=await store.getProject(principal,projectId);
    if(project.revision!==value.expectedRevision)throw new Error('workspace_revision_conflict');
    if(value.catalogDigest!==this.info().catalogDigest)throw new Error('api_catalog_changed');
    const settings=await this.semanticSettings(principal);if(!settings||!this.operations().length)throw new Error('api_operation_unavailable');
    signal.throwIfAborted();
    return prepareTypeSafeIntentPlan(store,principal,projectId,value.phrase,settings.model,this.operations(),'profileRevision' in settings?settings.profileRevision:undefined);
  }
  async prepareComposed(store:WorkspaceStore, principal:string, projectId:string, input:unknown, signal:AbortSignal) {
    const command = parseApiCompositePlanInput(input);
    const project = await store.getProject(principal,projectId);
    if (project.revision !== command.expectedRevision) throw new Error('workspace_revision_conflict');
    if (command.catalogDigest !== this.info().catalogDigest) throw new Error('api_catalog_changed');
    const catalog = this.operations();
    const selected = command.steps.map(step => catalog.find(operation => operation.id === step.operationId));
    if (selected.some(operation => !operation)) throw new Error('api_operation_unavailable');
    const dependents = command.steps
      .map((step, index) => ({ step, index, operation: selected[index]! }))
      .filter(item => item.step.dependencyStepId);
    const admittedDependentOps = new Set(['get_weather_forecast', 'get_ground_elevation']);
    if (dependents.length) {
      if (selected[0]!.operationId !== 'get_country_by_name') throw new Error('unadmitted_dependency_binding');
      for (const item of dependents) {
        if (item.step.dependencyStepId !== 'step_1' || !admittedDependentOps.has(item.operation.operationId)) {
          throw new Error('unadmitted_dependency_binding');
        }
      }
      if (new Set(dependents.map(item => item.operation.operationId)).size !== dependents.length) {
        throw new Error('unadmitted_dependency_binding');
      }
    }
    const steps = command.steps.map((step,index) => {
      const parameters = { ...step.parameters };
      if (index === 0 && dependents.length) {
        // Coordinates are explicitly requested in the signed source call.
        if (parameters.fields !== undefined && typeof parameters.fields !== 'string') throw new Error('api_instruments_invalid');
        parameters.fields = [...new Set([...(typeof parameters.fields === 'string' ? parameters.fields.split(',').filter(Boolean) : ['name']), 'capitalInfo'])].join(',');
      }
      if (step.dependencyStepId) {
        if (Object.hasOwn(parameters,'latitude') || Object.hasOwn(parameters,'longitude')) throw new Error('unadmitted_dependency_binding');
        // A mandatory step_output binding replaces these validated placeholders before
        // transport. They are never used when the source is empty, ambiguous or denied.
        parameters.latitude = 0; parameters.longitude = 0;
      }
      return { stepId: `step_${index+1}`, operation:selected[index]!, prepared:prepareApiCall(selected[index]!,parameters), ...(step.dependencyStepId ? {dependencyStepId:step.dependencyStepId} : {}) };
    });
    signal.throwIfAborted();
    return createProvisionalComposedApiInstrumentPlan(store,principal,projectId,steps);
  }
  async dispatch(store:WorkspaceStore, request:EffectRequest,privateAccess?:{fetchFn:typeof fetch;guard:()=>Promise<void>}):Promise<EffectOutcome> {
    await privateAccess?.guard();
    try{await this.options.authorize?.(request);}catch(error){return {kind:'not_sent',code:error instanceof Error&&/^service_[a-z_]+$/.test(error.message)?error.message:'service_unavailable'};}
    const catalog = this.operations();
    if(request.capability.id===TYPESAFE_INTENT_CAPABILITY.id){
      const settings=await this.semanticSettings(request.principalId);
      if(!settings||!catalog.length)return {kind:'not_sent',code:'typesafe_unavailable'};
      const key=JSON.stringify([request.principalId,this.info().catalogDigest,settings.model,'profileRevision' in settings?settings.profileRevision:null]);
      let dispatcher=this.semanticDispatchers.get(key);
      if(!dispatcher){if(this.semanticDispatchers.size>=128)this.semanticDispatchers.delete(this.semanticDispatchers.keys().next().value!);dispatcher=createTypeSafeIntentDispatcher({...settings,catalog,journal:createRunJournal(store,request.principalId),loadPlan:(project,id)=>store.getPlan(request.principalId,project,id)});this.semanticDispatchers.set(key,dispatcher);}
      return dispatcher.dispatch(request);
    }
    if (request.capability.id === 'api.rss.read') {
      const bundle = await store.getBundle(request.principalId, request.projectId);
      const run = bundle.runs.find(record => record.run.id === request.runId && record.run.principalId === request.principalId);
      if (!run) return { kind: 'not_sent', code: 'api_run_not_found' };
      const plan = bundle.plans.find(value => value.id === run.run.planId && value.digest === run.run.planDigest);
      const step = plan?.steps.find(value => value.id === request.stepId && value.capabilityId === request.capability.id && value.capabilityVersion === request.capability.version);
      const admission = run.receipts.find(receipt => receipt.attemptId === request.attemptId && receipt.stepId === request.stepId && receipt.capabilityId === request.capability.id && receipt.capabilityVersion === request.capability.version && receipt.status === 'dispatched');
      if (run.run.status !== 'running' || !step || !admission) return { kind: 'not_sent', code: 'api_active_admission_required' };
      if (request.signal.aborted) return { kind: 'not_sent', code: 'api_cancelled' };
      if (!Number.isFinite(Date.parse(request.deadlineAt)) || Date.parse(request.deadlineAt) <= Date.now()) return { kind: 'not_sent', code: 'api_deadline_exceeded' };

      if(this.options.enabled?.()===false)return {kind:'not_sent',code:'api_operation_unavailable'};
      if(Object.keys(step.arguments).sort().join(',')!==Object.keys(request.arguments).sort().join(',') ||
        Object.entries(step.arguments).some(([key,binding])=>binding.kind!=='literal'||canonicalJson(binding)!==canonicalJson(request.arguments[key])))return {kind:'not_sent',code:'rss_argument_binding_mismatch'};
      let feedUrl: string | null = null;
      if (request.arguments.feed_url?.kind === 'literal' && typeof request.arguments.feed_url.value === 'string') {
        feedUrl = request.arguments.feed_url.value;
      } else if (request.arguments.feedUrls?.kind === 'literal' && Array.isArray(request.arguments.feedUrls.value) && request.arguments.feedUrls.value[0]) {
        feedUrl = String(request.arguments.feedUrls.value[0]);
      }
      if (!feedUrl) return { kind: 'not_sent', code: 'invalid_feed_url' };

      const publishedRefs = new Set(run.receipts.flatMap(receipt => receipt.outputArtifactRefs));
      let publishedBytes = 0;
      for (const id of publishedRefs) {
        const artifact = bundle.artifacts.find(value => value.id === id && value.runId === request.runId);
        if (artifact && Number.isSafeInteger(artifact.byteLength)) publishedBytes += artifact.byteLength;
      }
      const remainingBytes = Math.min(request.limits.maxOutputBytes ?? 512_000, plan!.limits.maxOutputBytes ?? 512_000) - publishedBytes;
      if (!Number.isSafeInteger(remainingBytes) || remainingBytes <= 0) return { kind: 'not_sent', code: 'api_response_too_large' };

      try {
        const envelope = await fetchAndNormalizeRss(feedUrl, {
          signal: request.signal,
          maxOutputBytes: remainingBytes,
          feedUrl, deadlineAt: request.deadlineAt
        }, this.options.fetchFn);

        const compactJson = JSON.stringify(envelope);
        const artifactBytes = new TextEncoder().encode(compactJson);
        const artifactId = `api_result_${request.attemptId}`;
        return {
          kind: 'completed',
          artifacts: [{ artifactId, mediaType: 'application/json', bytes: artifactBytes }],
          outputArtifactRefs: [artifactId],
          sources: [{
            id: `source_${request.attemptId}`,
            sourceId: 'rss',
            externalId: feedUrl,
            title: `RSS: ${feedUrl}`,
            url: feedUrl,
            retrievedAt: new Date().toISOString()
          }]
        };
      } catch (err: any) {
        return err?.sent==='no'?{kind:'not_sent',code:err.code??'rss_fetch_failed'}:{kind:'failed',code:err?.code||err?.message||'rss_fetch_failed',sent:err?.sent==='yes'?'yes':'unknown'};
      }
    }
    // Owner-bound learned operations resolve from the caller's project bundle, never globally.
    // Non-executable trust levels and revoked revisions are excluded here, so a
    // stale approval cannot reach the wire after revocation.
    const learned = request.capability.id.startsWith('api.learned_')
      ? await this.dispatchableLearnedOperations(store, request.principalId, request.projectId)
      : [];
    const combined = [...catalog, ...learned];
    if (!combined.some(op => op.id === request.capability.id)) return {kind:'not_sent',code:'api_operation_unavailable'};
    const bundle = await store.getBundle(request.principalId,request.projectId);
    const run = bundle.runs.find(record => record.run.id === request.runId && record.run.principalId === request.principalId);
    if (!run) return {kind:'not_sent',code:'api_run_not_found'};
    const plan = bundle.plans.find(value => value.id === run.run.planId && value.digest === run.run.planDigest);
    const step = plan?.steps.find(value => value.id === request.stepId && value.capabilityId === request.capability.id && value.capabilityVersion === request.capability.version);
    const admission = run.receipts.find(receipt => receipt.attemptId === request.attemptId && receipt.stepId === request.stepId && receipt.capabilityId === request.capability.id && receipt.capabilityVersion === request.capability.version && receipt.status === 'dispatched');
    if (run.run.status !== 'running' || !step || !admission) return {kind:'not_sent',code:'api_active_admission_required'};
    if (Object.keys(step.arguments).sort().join(',') !== Object.keys(request.arguments).sort().join(',')) return {kind:'not_sent',code:'api_argument_binding_mismatch'};
    for (const [name,binding] of Object.entries(step.arguments)) {
      const resolved = request.arguments[name];
      if (!resolved || resolved.kind !== binding.kind || (binding.kind === 'literal' && canonicalJson(resolved) !== canonicalJson(binding)) || (binding.kind === 'step_output' && (resolved.kind !== 'step_output' || resolved.stepId !== binding.stepId || resolved.output !== binding.output))) return {kind:'not_sent',code:'api_argument_binding_mismatch'};
    }
    const publishedRefs = new Set(run.receipts.flatMap(receipt => receipt.outputArtifactRefs));
    let publishedBytes = 0;
    for (const id of publishedRefs) {
      const artifact = bundle.artifacts.find(value => value.id === id && value.runId === request.runId);
      if (!artifact || !Number.isSafeInteger(artifact.byteLength) || artifact.byteLength < 0) return {kind:'not_sent',code:'api_prior_artifact_unavailable'};
      publishedBytes += artifact.byteLength;
    }
    const remainingBytes = Math.min(request.limits.maxOutputBytes ?? 0,plan!.limits.maxOutputBytes ?? 0) - publishedBytes;
    if (!Number.isSafeInteger(remainingBytes) || remainingBytes <= 0) return {kind:'not_sent',code:'api_response_too_large'};
    request = {...request,limits:{...request.limits,maxOutputBytes:remainingBytes}};
    const efficiencyPolicy=getActiveEfficiencyPolicy();
    // Catalogued pagination runs through the same dispatcher; only the per-page
    // admission is delegated to the server-owned journal executor, bound to this
    // exact run/step/plan digest. Operations without pagination metadata keep the
    // single governed read path unchanged.
    const paginationOperation = combined.find(operation => operation.id === request.capability.id);
    const guardedFetch=((async(input:RequestInfo|URL,init:RequestInit={})=>{await privateAccess?.guard();await this.options.authorize?.(request);const response=await (privateAccess?.fetchFn??this.options.fetchFn??publicHttpsFetch)(input,init);try{await privateAccess?.guard();await this.options.authorize?.(request);return response;}catch(error){await response.body?.cancel();throw error;}}) as typeof fetch);
    const dispatcher = createApiInstrumentDispatcher({catalog:combined,fetchFn:guardedFetch,...(!privateAccess?{cache:this.cache.scoped(efficiencyPolicy)}:{}),
      ...(paginationOperation?.pagination ? {pagination:{
        journal:createRunJournal(store,request.principalId),
        principalId:request.principalId,projectId:request.projectId,
        runId:request.runId,stepId:request.stepId,planDigest:run.run.planDigest,
        fetchFn:guardedFetch,
      }} : {}),
      cacheContext:{configurationRevision:`${this.info().catalogDigest}:${efficiencyPolicy.id}:${efficiencyPolicy.revision}`,authorizationContext:'public_read_v1'},
      principalId:request.principalId,projectId:request.projectId,
      resolveStepOutput:async(stepId,output,bindingArg) => {
        const binding = bindingArg || Object.values(request.arguments).find(b => b.kind === 'step_output' && b.stepId === stepId && (b.output === output || !output));
        if (!binding || binding.kind !== 'step_output' || !binding.artifactRefs?.length) throw new Error('invalid_dependency_output');
        const artifactRef = binding.artifactRefs[0]!;
        const record = await store.readRun(request.principalId,request.projectId,request.runId);
        const receipt = record?.receipts.find(r => r.status === 'succeeded' && r.stepId === stepId && r.outputArtifactRefs.includes(artifactRef));
        if (!receipt) throw new Error('invalid_dependency_output');
        return JSON.parse(await store.readTextArtifact(request.principalId,request.projectId,artifactRef));
      }});
    const outcome=await dispatcher.dispatch(request);
    try{await privateAccess?.guard();await this.options.authorize?.(request);}catch{return {kind:'failed',code:'service_cancelled',sent:'unknown'};}
    return outcome;
  }
}
