import {performTypeSafeChoice} from './typesafe-judgment.ts';
import {buildTypeSafeIntentPrompt, selectOperationShortlist} from './progressive-discovery.ts';
import {createHash, randomUUID} from 'node:crypto';
import {parseCapabilityDescriptor, parseExecutionPlan, canonicalContextSnapshotPayload, type ExecutionPlan} from '@uptokey/sync-contract/workflow';
import type {EffectDispatcher, EffectRequest, RunJournal} from "../../../core/src/workspace/executor.ts";
import type {WorkspaceStore} from "../../../core/src/workspace/store.ts";
import {computePlanDigest} from "../../../core/src/workspace/planner.ts";
import {canonicalStringify} from './importer.ts';
import type { CuratedOperation, SemanticProposal } from './types.ts';

export interface TypeSafeAdapterOptions {
  apiKey?: string;
  baseUrl?: string;
  fetchFn?: typeof fetch;
  enabled?: boolean;
  minConfidence?: number;
  model?: string;
}


/** Common country names to ISO alpha-2 code mapping for deterministic candidate extraction */
const COUNTRY_NAME_TO_CODE: Record<string, string> = {
  brasil: 'BR',
  brazil: 'BR',
  eua: 'US',
  usa: 'US',
  estadosunidos: 'US',
  unitedstates: 'US',
  alemanha: 'DE',
  germany: 'DE',
  frança: 'FR',
  franca: 'FR',
  france: 'FR',
  reunido: 'GB',
  uk: 'GB',
  unitedkingdom: 'GB',
  japao: 'JP',
  japão: 'JP',
  japan: 'JP',
  canada: 'CA',
  canadá: 'CA',
  australia: 'AU',
  austrália: 'AU',
  italia: 'IT',
  itália: 'IT',
  italy: 'IT',
  espanha: 'ES',
  spain: 'ES',
  portugal: 'PT',
  mexico: 'MX',
  méxico: 'MX',
};

/** Deterministically extract candidates for parameters based on operation schemas */
export function extractCandidateArguments(
  phrase: string,
  operation: CuratedOperation
): {
  candidates: Record<string, unknown>;
  missingRequired: string[];
} {
  const clean = phrase.toLowerCase();
  const candidates: Record<string, unknown> = {};

  for (const param of operation.parameters) {
    if (param.name === 'latitude') {
      const matchWithPrefix = /(?:lat|latitude)\s*[:=]?\s*(-?\d{1,2}(?:\.\d+)?)/i.exec(clean);
      if (matchWithPrefix && matchWithPrefix[1]) {
        const val = parseFloat(matchWithPrefix[1]);
        if (val >= -90 && val <= 90) candidates['latitude'] = val;
      } else {
        const pairMatch = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/.exec(clean);
        if (pairMatch && pairMatch[1]) {
          const val = parseFloat(pairMatch[1]);
          if (val >= -90 && val <= 90) candidates['latitude'] = val;
        }
      }
    } else if (param.name === 'longitude') {
      const matchWithPrefix = /(?:lon|longitude|long)\s*[:=]?\s*(-?\d{1,3}(?:\.\d+)?)/i.exec(clean);
      if (matchWithPrefix && matchWithPrefix[1]) {
        const val = parseFloat(matchWithPrefix[1]);
        if (val >= -180 && val <= 180) candidates['longitude'] = val;
      } else {
        const pairMatch = /(-?\d{1,2}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)/.exec(clean);
        if (pairMatch && pairMatch[2]) {
          const val = parseFloat(pairMatch[2]);
          if (val >= -180 && val <= 180) candidates['longitude'] = val;
        }
      }
    } else if (param.name === 'year') {
      // 4-digit year between 1970 and 2100
      const match = /\b(19\d{2}|20\d{2}|2100)\b/.exec(clean);
      if (match && match[1]) {
        candidates['year'] = parseInt(match[1], 10);
      }
    } else if (param.name === 'countryCode') {
      // Look for 2-letter uppercase ISO or common country name
      let foundCode: string | null = null;
      for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
        if (clean.includes(name)) {
          foundCode = code;
          break;
        }
      }
      if (!foundCode) {
        const match = /\b([a-zA-Z]{2})\b/.exec(phrase);
        if (match && match[1]) {
          const upper = match[1].toUpperCase();
          if (param.schema.enum?.includes(upper)) {
            foundCode = upper;
          }
        }
      }
      if (foundCode && param.schema.enum?.includes(foundCode)) {
        candidates['countryCode'] = foundCode;
      }
    } else if (param.name === 'name' && operation.serviceId === 'rest_countries') {
      // Extract country name candidate from phrase
      // Matches "country <name>" or "país <name>" or common country names
      const match = /(?:country|país|pais|sobre o país|sobre)\s+([a-zA-ZÀ-ÿ\s]{3,30})/i.exec(phrase);
      if (match && match[1]) {
        candidates['name'] = match[1].trim();
      } else {
        // Check if any recognized country name appears in phrase
        for (const name of Object.keys(COUNTRY_NAME_TO_CODE)) {
          if (clean.includes(name)) {
            candidates['name'] = name;
            break;
          }
        }
      }
    } else if (param.name === 'countryCode') {
      // Direct 2-letter code
      const codeMatch = /\b([A-Z]{2})\b/.exec(phrase);
      if (codeMatch && codeMatch[1]) {
        candidates['countryCode'] = codeMatch[1];
      } else {
        // Search country names
        for (const [name, code] of Object.entries(COUNTRY_NAME_TO_CODE)) {
          if (clean.includes(name)) {
            candidates['countryCode'] = code;
            break;
          }
        }
      }
    } else if (param.name === 'year') {
      const yearMatch = /\b(19\d\d|20\d\d)\b/.exec(clean);
      if (yearMatch && yearMatch[1]) {
        candidates['year'] = parseInt(yearMatch[1], 10);
      }
    } else if (param.name === 'name') {
      for (const [name] of Object.entries(COUNTRY_NAME_TO_CODE)) {
        if (clean.includes(name)) {
          candidates['name'] = name.charAt(0).toUpperCase() + name.slice(1);
          break;
        }
      }
    } else if (param.name === 'postalcode') {
      const zipMatch = /\b(\d{5}(?:-\d{3,4})?|\d{4}-\d{3})\b/.exec(clean);
      if (zipMatch && zipMatch[1]) {
        candidates['postalcode'] = zipMatch[1];
      }
    } else if (param.name === 'country') {
      const countryMatch = /\b(us|br|de|fr|gb|jp|ca|au|it|es|pt|mx)\b/.exec(clean);
      if (countryMatch && countryMatch[1]) {
        candidates['country'] = countryMatch[1];
      }
    } else if (param.name === 'base') {
      const currMatch = /\b(USD|EUR|BRL|GBP|JPY|CAD|AUD|CHF)\b/i.exec(clean);
      if (currMatch && currMatch[1]) {
        candidates['base'] = currMatch[1].toUpperCase();
      }
    } else if (param.name === 'timeZone') {
      const tzMatch = /(America\/[A-Za-z_]+|Europe\/[A-Za-z_]+|Asia\/[A-Za-z_]+|UTC)/i.exec(phrase);
      if (tzMatch && tzMatch[1]) {
        candidates['timeZone'] = tzMatch[1];
      }
    } else if (param.name === 'date') {
      const dateMatch = /\b(\d{4}-\d{2}-\d{2})\b/.exec(clean);
      if (dateMatch && dateMatch[1]) {
        candidates['date'] = dateMatch[1];
      }
    } else if (param.name === 'region') {
      const regMatch = /\b(Africa|Americas|Asia|Europe|Oceania)\b/i.exec(phrase);
      if (regMatch && regMatch[1]) {
        candidates['region'] = regMatch[1].charAt(0).toUpperCase() + regMatch[1].slice(1).toLowerCase();
      }
    }
  }

  // Check missing required parameters
  const missingRequired = operation.parameters
    .filter(p => p.required && candidates[p.name] === undefined)
    .map(p => p.name);

  return { candidates, missingRequired };
}

const LOCAL_HEURISTIC_ROUTES: ReadonlyArray<{test: RegExp; operationId: string}> = [
  {test: /tempo|clima|weather|forecast/, operationId: 'get_weather_forecast'},
  {test: /elevação|elevacao|altitude|elevation/, operationId: 'get_ground_elevation'},
  {test: /feriado|holiday/, operationId: 'get_public_holidays'},
  {test: /país|pais|country/, operationId: 'get_country_by_name'},
  {test: /fuso|horário|horario|timezone|clock/, operationId: 'get_current_time_zone'},
  {test: /cep|postal|zipcode/, operationId: 'get_postal_location'},
  {test: /câmbio|cambio|exchange|moeda/, operationId: 'get_latest_exchange_rates'},
];

function proposalFor(phrase: string, operation: CuratedOperation): SemanticProposal {
  const {candidates, missingRequired} = extractCandidateArguments(phrase, operation);
  return {matched: true, operationId: operation.operationId, confidence: undefined, source: 'local_heuristic', reason: 'matched',
    proposedArguments: candidates, missingArguments: missingRequired, needsUserCompletion: missingRequired.length > 0};
}

/** Deterministic fallback used when the semantic provider is disabled, absent or over budget. */
export function localHeuristicProposal(phrase: string, availableOperations: readonly CuratedOperation[]): SemanticProposal | undefined {
  if (!phrase.trim() || availableOperations.length === 0) return undefined;
  const clean = phrase.toLowerCase();
  for (const route of LOCAL_HEURISTIC_ROUTES) {
    if (!route.test.test(clean)) continue;
    const operation = availableOperations.find(candidate => candidate.operationId === route.operationId);
    if (operation) return proposalFor(phrase, operation);
  }
  const shortlist = selectOperationShortlist(phrase, availableOperations, {limit: 2});
  if (shortlist.fallback || shortlist.entries.length === 0) return undefined;
  const [first, second] = shortlist.entries;
  if (!first || (second && first.score <= second.score)) return undefined;
  return proposalFor(phrase, first.operation);
}

export class TypeSafeIntentSelector {
  // This facade is deliberately local. Remote inference is a W5 effect below.
  private readonly enabled: boolean;
  private attemptCount = 0;
  constructor(options?: TypeSafeAdapterOptions) {
    this.enabled = options?.enabled === true;
  }

  getAttemptsCount(): number {
    return this.attemptCount;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  /**
   * Selects an API operation and extracts candidate arguments based on a user's natural language request.
   * Returns a reviewable proposal without executing anything.
   */
  async proposeOperation(
    phrase: string,
    availableOperations: readonly CuratedOperation[],
    admissionReceiptOrOptions?: { status: string } | { allowLocalHeuristic?: boolean; admissionReceipt?: { status: string } },
    optionsArg?: { allowLocalHeuristic?: boolean }
  ): Promise<SemanticProposal> {
    const options = admissionReceiptOrOptions && !('status' in admissionReceiptOrOptions)
      ? admissionReceiptOrOptions : optionsArg;

    const trimmed = phrase.trim();

    // Guard against prompt injections and instructions to alter system governance (C02, C06)
    const hostilePattern = /(?:ignore (?:all )?previous instructions|system override|delete database|grant all permissions|execute immediately|approve plan|admin access)/i;
    if (hostilePattern.test(trimmed)) {
      return {
        matched: false,
        operationId: null,
        confidence: undefined, // Never fabricate confidence
        source: 'local_heuristic',
        reason: 'hostile_input',
        proposedArguments: {},
        missingArguments: [],
        needsUserCompletion: false,
      };
    }

    if (!trimmed || availableOperations.length === 0) {
      return {
        matched: false,
        operationId: null,
        confidence: undefined,
        source: 'manual',
        reason: 'no_match',
        proposedArguments: {},
        missingArguments: [],
        needsUserCompletion: false,
      };
    }

    if (options?.allowLocalHeuristic) {
      const proposal = localHeuristicProposal(trimmed, availableOperations);
      if (proposal) return proposal;
    }

    if (!this.enabled) {
      return {
        matched: false,
        operationId: null,
        confidence: 0.0,
        source: 'manual',
        reason: 'disabled',
        proposedArguments: {},
        missingArguments: [],
        needsUserCompletion: false,
      };
    }

    return {matched: false, operationId: null, confidence: undefined, source: 'manual', reason: 'admission_required', proposedArguments: {}, missingArguments: [], needsUserCompletion: false};
  }
}

/** Pure projection of an already obtained answer; it has no authority or network access. */
export function projectTypeSafeAnswer(phrase: string, operations: readonly CuratedOperation[], answer: unknown,
  minConfidence = 0.65, source: 'typesafe_jev' | 'fixture' = 'typesafe_jev'): SemanticProposal {
  const value = answer as {choice?: unknown; confidence?: unknown} | undefined;
  const confidence = typeof value?.confidence === 'number' && Number.isFinite(value.confidence) && value.confidence >= 0 && value.confidence <= 1 ? value.confidence : undefined;
  const op = operations.find(item => item.operationId === value?.choice);
  const base: SemanticProposal = {matched: false, operationId: null, confidence, source, reason: 'no_match', proposedArguments: {}, missingArguments: [], needsUserCompletion: false};
  if (!op) return {...base, reason: 'no_match'};
  if (confidence === undefined || confidence < minConfidence) return {...base, reason: 'low_confidence'};
  const {candidates, missingRequired} = extractCandidateArguments(phrase, op);
  return {matched: true, operationId: op.operationId, confidence, source, reason: 'matched', proposedArguments: candidates,
    missingArguments: missingRequired, needsUserCompletion: missingRequired.length > 0};
}

export const TYPESAFE_INTENT_CAPABILITY = parseCapabilityDescriptor({
  schemaVersion: 1, id: 'inference.typesafe.intent', version: 1, createdAt: '2026-09-18T00:00:00.000Z',
  titleKey: 'workflow.typesafe.intent.title', descriptionKey: 'workflow.typesafe.intent.description', tags: ['intent'],
  inputSchemaId: 'typesafe.intent.input.v1', outputSchemaId: 'typesafe.intent.output.v1', effect: 'inference',
  dataDestination: {kind: 'provider', id: 'typesafe'}, availability: 'executable', supportLevel: 'experimental',
  requiredScopes: ['run:execute'], retryClass: 'never_automatic',
  limits: {maxSteps: 1, maxCalls: 1, maxOutputTokens: 1024, timeoutMs: 15000, maxOutputBytes: 32768},
});

export function computeTypeSafeCatalogDigest(catalog: readonly CuratedOperation[]): string {
  return createHash('sha256').update(canonicalStringify(catalog.filter(op => op.id.startsWith('api.')).map(op => ({
    id: op.id, version: op.capability.version, operationId: op.operationId, schemaDigest: op.schemaDigest,
    documentDigest: op.documentDigest, summary: op.summary, description: op.description, domain: op.metadata.domain,
  })).sort((a,b) => a.id.localeCompare(b.id)))).digest('hex');
}

export async function prepareTypeSafeIntentPlan(store: WorkspaceStore, principalId: string, projectId: string,
  phrase: string, model: string, catalog: readonly CuratedOperation[], profileRevision?:number) {
  if (!phrase.trim() || phrase.length > 4000 || !model.trim() || model.length > 200) throw new Error('typesafe_invalid_input');
  const {project} = await store.getBundle(principalId, projectId);
  const snapshot = await store.snapshotContext(principalId, projectId, {selectedEntryIds: [], selectedArtifactIds: [],
    excludedEntryIds: project.entries.map(e => e.id), allowedDestinations: [TYPESAFE_INTENT_CAPABILITY.dataDestination], maxContextBytes: 32000});
  const draft = {schemaVersion: 1, id: randomUUID(), createdAt: new Date().toISOString(), projectId, projectRevision: project.revision,
    contextSnapshotId: snapshot.id, contextSnapshotDigest: createHash('sha256').update(canonicalContextSnapshotPayload(snapshot)).digest('hex'),
    steps: [{id: 'select_intent', capabilityId: TYPESAFE_INTENT_CAPABILITY.id, capabilityVersion: 1, arguments: {
      phrase: {kind: 'literal', value: phrase}, model: {kind: 'literal', value: model},
      catalog_digest: {kind: 'literal', value: computeTypeSafeCatalogDigest(catalog)},
      ...(profileRevision===undefined?{}:{profile_revision:{kind:'literal',value:profileRevision}}),
    }}], limits: {...TYPESAFE_INTENT_CAPABILITY.limits}, digest: '0'.repeat(64)} as ExecutionPlan;
  const plan = parseExecutionPlan({...draft, digest: computePlanDigest(draft)});
  await store.putPlan(principalId, plan, snapshot);
  return {plan, snapshot};
}

export interface TypeSafeDispatcherOptions {
  profileRevision?:number;
  validateProfile?:()=>Promise<boolean>;
  catalog: readonly CuratedOperation[];
  journal: Pick<RunJournal, 'read' | 'readApproval'>;
  loadPlan: (projectId: string, planId: string) => Promise<unknown>;
  resolveCredential: (request: EffectRequest) => Promise<string | undefined>;
  model: string;
  fetchFn?: typeof fetch;
  /** Descriptor shortlist sent to the semantic provider; never the whole catalog. */
  shortlistLimit?: number;
}

/** Server-owned W5 dispatcher. The local selector above cannot call the SDK. */
export function createTypeSafeIntentDispatcher(options: TypeSafeDispatcherOptions): EffectDispatcher {
  const claimed = new Set<string>();
  const catalog = structuredClone(options.catalog.filter(op => op.id.startsWith('api.')));
  const digest = computeTypeSafeCatalogDigest(catalog);
  return {async dispatch(request) {
    if (request.capability.id !== TYPESAFE_INTENT_CAPABILITY.id || request.capability.effect !== 'inference' || request.capability.retryClass !== 'never_automatic') return {kind: 'not_sent', code: 'unsupported_capability'};
    if (catalog.length === 0) return {kind: 'not_sent', code: 'typesafe_unavailable'};
    const literal = (name: string) => {const binding = request.arguments[name]; return binding?.kind === 'literal' ? binding.value : undefined;};
    const phrase = literal('phrase'), model = literal('model');
    if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 4000 || model !== options.model || options.profileRevision!==undefined&&literal('profile_revision')!==options.profileRevision || literal('catalog_digest') !== digest) return {kind: 'not_sent', code: 'typesafe_configuration_changed'};
    const record = await options.journal.read(request.projectId, request.runId);
    const receipt = record?.receipts.find(item => item.attemptId === request.attemptId && item.stepId === request.stepId);
    if (!record || record.run.status !== 'running' || record.run.principalId !== request.principalId || receipt?.status !== 'dispatched' || receipt.capabilityId !== TYPESAFE_INTENT_CAPABILITY.id) return {kind: 'not_sent', code: 'typesafe_not_admitted'};
    const approval = await options.journal.readApproval(request.projectId, record.run.planId);
    let plan: ExecutionPlan;
    try {plan = parseExecutionPlan(await options.loadPlan(request.projectId, record.run.planId));} catch {return {kind: 'not_sent', code: 'typesafe_not_admitted'};}
    const step = plan.steps.find(item => item.id === request.stepId);
    if (plan.digest !== record.run.planDigest || computePlanDigest(plan) !== plan.digest || approval?.consumedByRunId !== request.runId || approval.planDigest !== plan.digest || step?.capabilityId !== TYPESAFE_INTENT_CAPABILITY.id || canonicalStringify(step.arguments) !== canonicalStringify(request.arguments)) return {kind: 'not_sent', code: 'typesafe_not_admitted'};
    const timeout = Math.min(request.limits.timeoutMs, TYPESAFE_INTENT_CAPABILITY.limits.timeoutMs, Date.parse(request.deadlineAt) - Date.now());
    const maxBytes = Math.min(request.limits.maxOutputBytes, TYPESAFE_INTENT_CAPABILITY.limits.maxOutputBytes);
    if (!Number.isFinite(timeout) || timeout <= 0 || !Number.isFinite(maxBytes) || maxBytes <= 0 || request.signal.aborted) return {kind: 'not_sent', code: 'typesafe_cancelled'};
    const key = `${request.projectId}:${request.runId}:${request.attemptId}`;
    if (claimed.has(key)) return {kind: 'not_sent', code: 'typesafe_attempt_already_dispatched'};
    claimed.add(key);
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    request.signal.addEventListener('abort', onAbort, {once:true});
    const timer = setTimeout(onAbort, timeout);
    let sent = false;
    try {
      const credential = await Promise.race([
        options.resolveCredential({...request, signal: controller.signal}),
        new Promise<never>((_resolve, reject) => controller.signal.addEventListener('abort', () => reject(new Error('typesafe_cancelled')), {once: true})),
      ]);
      if (controller.signal.aborted) return {kind: 'not_sent', code: 'typesafe_cancelled'};
      if (!credential || !credential.trim()) return {kind: 'not_sent', code: 'typesafe_unavailable'};
      const shortlist = selectOperationShortlist(phrase, catalog, options.shortlistLimit === undefined ? {} : {limit: options.shortlistLimit});
      const prompt = buildTypeSafeIntentPrompt(phrase, shortlist.candidates);
      const response = await performTypeSafeChoice({credential,model:options.model,state:prompt.state,
        questionId:'selectedOperation',instructions:prompt.instructions,criteria:prompt.criteria,
        timeoutMs:timeout,maxBytes,signal:controller.signal,fetchFn:options.fetchFn,onDispatch:()=>{sent=true;}});
      if(options.validateProfile&&!await options.validateProfile())return {kind:'failed',code:'typesafe_configuration_changed',sent:'yes'};
      if (controller.signal.aborted) return {kind: 'failed', code: 'typesafe_cancelled', sent: 'unknown'};
      if (typeof response.model!=='string'||!/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(response.model)||(options.model==='jev-latest'?!/^jev-[A-Za-z0-9._-]+$/.test(response.model):response.model!==options.model)) return {kind: 'failed', code: 'typesafe_model_mismatch', sent: 'yes'};
      const proposal = projectTypeSafeAnswer(phrase, shortlist.candidates, response.answers.selectedOperation);
      const bytes = new TextEncoder().encode(JSON.stringify(proposal));
      if (bytes.length > maxBytes) return {kind: 'failed', code: 'typesafe_output_limit', sent: 'yes'};
      const artifactId = `typesafe_intent_${request.attemptId}`;
      return {kind: 'completed', artifacts: [{artifactId, mediaType: 'application/json', bytes}], outputArtifactRefs: [artifactId],
        usage: response.usage ? {basis:'provider_reported', inputTokens: response.usage.input_tokens, outputTokens: response.usage.output_tokens, cachedInputTokens: null} : undefined};
    } catch {
      if (controller.signal.aborted) return sent ? {kind: 'failed', code: 'typesafe_cancelled', sent: 'unknown'} : {kind: 'not_sent', code: 'typesafe_cancelled'};
      return sent ? {kind: 'failed', code: 'typesafe_inference_failed', sent: 'unknown'} : {kind: 'not_sent', code: 'typesafe_unavailable'};
    } finally {clearTimeout(timer); request.signal.removeEventListener('abort', onAbort); claimed.delete(key);}
  }};
}
