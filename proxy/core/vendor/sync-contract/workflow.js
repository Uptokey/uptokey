/** Workflow wire contract v1. Pure ESM; no network, storage, secrets or authorization. */
import { canonicalJson } from './canonical.js';
import { isDataRecord, projectDataArray } from './plain-data.js';

export const WORKFLOW_CONTRACT_VERSION = 1;
export const WORKFLOW_CONTRACT_REVISION = '1.7.0';
export const WORKFLOW_LIMITS = Object.freeze({
  commandBytes: 262_144, steps: 12, entries: 256, sources: 256,
  artifactBytes: 5_242_880, videoArtifactBytes: 67_108_864, projectBytes: 104_857_600,
  activeRunsPerProject: 1, activeRunsPerProcess: 2,
});
export const WORKFLOW_SCOPES = Object.freeze([
  'project:read', 'project:write', 'project:process:run', 'plan:create', 'run:execute', 'run:cancel',
  'artifact:read', 'recipe:write',
]);
export const RUN_STATUSES = Object.freeze([
  'draft', 'awaiting_approval', 'ready', 'running', 'succeeded', 'failed', 'cancelled', 'needs_attention',
]);
export const ATTEMPT_STATUSES = Object.freeze(['prepared', 'dispatched', 'succeeded', 'failed', 'unknown']);

export class WorkflowContractError extends Error {
  constructor(code = 'workflow_invalid') { super(code); this.name = 'WorkflowContractError'; this.code = code; }
}
function fail() { throw new WorkflowContractError(); }
const text = (v, max = 4000, empty = false) => typeof v === 'string' &&
  (empty || v.trim().length > 0) && v.length <= max && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(v);
const id = v => typeof v === 'string' && /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(v);
const name = v => typeof v === 'string' && /^[a-z][a-z0-9_.-]{0,127}$/.test(v);
const hash = v => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
const integer = (v, max = Number.MAX_SAFE_INTEGER, min = 0) => Number.isSafeInteger(v) && v >= min && v <= max;
const revision = v => integer(v, Number.MAX_SAFE_INTEGER, 1);
const choice = values => v => values.includes(v);
const nullable = check => v => v === null || check(v);
function date(v) {
  if (typeof v !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(v)) return false;
  const time = Date.parse(v); return Number.isFinite(time) && new Date(time).toISOString() === v;
}
function url(v) {
  if (!text(v, 2048)) return false;
  try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && !u.hash; }
  catch { return false; }
}
function matchesFields(v, fields, optional = []) {
  if (!isDataRecord(v)) return false;
  const keys = Object.keys(v);
  return keys.every(k => Object.hasOwn(fields, k)) &&
    Object.entries(fields).every(([k, check]) => Object.hasOwn(v, k) ? check(v[k]) : optional.includes(k));
}
function array(v, check, max = 256, min = 0) {
  const list = projectDataArray(v, max);
  return !!list && list.length >= min && list.every(check);
}
const unique = (v, key = x => x) => new Set(v.map(key)).size === v.length;
const ids = v => array(v, id) && unique(v);
const names = v => array(v, name, 64) && unique(v);
const scopes = v => array(v, choice(WORKFLOW_SCOPES), WORKFLOW_SCOPES.length, 1) && unique(v);
const base = { schemaVersion: v => v === 1, id, createdAt: date };
const accessModes = ['public', 'byok', 'local', 'hosted'];
const destination = v => matchesFields(v, {
  kind: choice(['local', 'public_source', 'provider']), id: name,
});
const destinations = v => array(v, destination, 32, 1) && unique(v, d => `${d.kind}:${d.id}`);
const limits = v => matchesFields(v, {
  maxSteps: n => integer(n, 12, 1), maxCalls: n => integer(n, 24, 1),
  maxOutputTokens: n => integer(n, 1_000_000, 1), timeoutMs: n => integer(n, 600_000, 1000),
  maxOutputBytes: n => integer(n, WORKFLOW_LIMITS.videoArtifactBytes, 1),
});
function capability(v) {
  return matchesFields(v, {
    ...base, id: name, version: revision, titleKey: name, descriptionKey: name, tags: names,
    inputSchemaId: name, outputSchemaId: name,
    effect: choice(['read_external', 'write_external', 'inference', 'produce_artifact', 'execute_local']), dataDestination: destination,
    availability: choice(['executable', 'unavailable', 'catalogued']),
    supportLevel: choice(['catalogued', 'experimental', 'integrated']),
    requiredScopes: scopes, retryClass: choice(['read_only', 'idempotent_local', 'never_automatic']),
    limits,
  }) && (!['write_external','execute_local'].includes(v.effect) || v.retryClass === 'never_automatic') && (v.effect !== 'execute_local' || (v.dataDestination.kind === 'local' && v.requiredScopes.includes('project:process:run')));
}
const source = v => matchesFields(v, {
  id, sourceId: name, externalId: s => text(s, 500), title: s => text(s, 1000), url,
  retrievedAt: date, receiptId: id,
});
const entry = v => matchesFields(v, {
  id, kind: choice(['fact', 'decision', 'hypothesis', 'task']), origin: choice(['user', 'source', 'model']),
  content: s => text(s, 16_000), sourceRefs: ids,
  status: choice(['proposed', 'confirmed', 'superseded', 'done']), createdAt: date, supersedes: nullable(id),
}) && !(v.kind === 'decision' && v.status === 'confirmed' && v.origin !== 'user');
function project(v) {
  return matchesFields(v, {
    ...base, ownerPrincipalId: id, revision, name: s => text(s, 200), goal: s => text(s, 8000, true),
    constraints: a => array(a, s => text(s, 2000), 32), entries: a => array(a, entry, 256),
    sources: a => array(a, source, 256), artifactRefs: ids, updatedAt: date,
  }) && v.updatedAt >= v.createdAt && unique(v.entries, e => e.id) && unique(v.sources, s => s.id) &&
    v.entries.every(e => e.sourceRefs.every(ref => v.sources.some(s => s.id === ref)) &&
      (e.supersedes === null || e.supersedes !== e.id && v.entries.some(old => old.id === e.supersedes)));
}
const selection = v => matchesFields(v, { id, sha256: hash });
function snapshot(v) {
  return matchesFields(v, {
    ...base, projectId: id, projectRevision: revision,
    entries: a => array(a, selection, 256), artifacts: a => array(a, selection, 256),
    sourceRefs: ids, allowedDestinations: destinations,
    maxContextBytes: n => integer(n, WORKFLOW_LIMITS.commandBytes, 1),
    excludedEntryIds: ids,
  }) && unique(v.entries, x => x.id) && unique(v.artifacts, x => x.id) &&
    !v.entries.some(e => v.excludedEntryIds.includes(e.id));
}
// Literals are bounded JSON data; no expressions, JS code, paths or URLs are executed by this contract.
function jsonData(v, depth = 0) {
  if (depth > 8) return false;
  if (v === null || typeof v === 'boolean') return true;
  if (typeof v === 'number') return Number.isFinite(v);
  if (typeof v === 'string') return text(v, 16_000, true);
  if (Array.isArray(v)) return array(v, x => jsonData(x, depth + 1), 256);
  return isDataRecord(v) && Object.keys(v).length <= 64 && Object.keys(v).every(k =>
    /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(k) && !['constructor', 'prototype', '__proto__'].includes(k) && jsonData(v[k], depth + 1));
}
function binding(v, recipe = false) {
  if (!isDataRecord(v)) return false;
  if (v.kind === 'literal') return matchesFields(v, { kind: x => x === 'literal', value: jsonData });
  if (v.kind === 'step_output') return matchesFields(v, { kind: x => x === 'step_output', stepId: id, output: name });
  return recipe && matchesFields(v, { kind: x => x === 'parameter', parameter: name });
}
function args(v, recipe) {
  return isDataRecord(v) && Object.keys(v).length <= 32 && Object.keys(v).every(k =>
    name(k) && !['constructor', 'prototype', '__proto__'].includes(k) && binding(v[k], recipe));
}
function step(v, recipe = false) {
  return matchesFields(v, { id, capabilityId: name, capabilityVersion: revision, arguments: a => args(a, recipe) });
}
function steps(v, recipe = false) {
  return array(v, s => step(s, recipe), 12, 1) && unique(v, s => s.id) && v.every((s, index) =>
    Object.values(s.arguments).every(arg => arg.kind !== 'step_output' || v.slice(0, index).some(previous => previous.id === arg.stepId)));
}
function plan(v) {
  return matchesFields(v, {
    ...base, projectId: id, projectRevision: revision, contextSnapshotId: id, contextSnapshotDigest: hash,
    steps: s => steps(s), limits, digest: hash,
  }) && v.steps.length <= v.limits.maxSteps;
}
function grant(v) {
  return matchesFields(v, {
    ...base, principalId: id, projectId: id, revision, scopes, capabilityIds: names,
    destinations, limits, expiresAt: date, revokedAt: nullable(date),
  }) && v.expiresAt > v.createdAt && (v.revokedAt === null || v.revokedAt >= v.createdAt);
}
const stepState = v => matchesFields(v, {
  stepId: id, status: choice(['pending', ...ATTEMPT_STATUSES]), attemptIds: ids, receiptIds: ids,
});
function run(v) {
  return matchesFields(v, {
    ...base, projectId: id, principalId: id, planId: id, planDigest: hash, policyRevision: revision,
    requestId: id, status: choice(RUN_STATUSES), stepStates: a => array(a, stepState, 12, 1),
    updatedAt: date, finishedAt: nullable(date),
  }) && v.updatedAt >= v.createdAt && unique(v.stepStates, x => x.stepId) &&
    (v.finishedAt === null || v.finishedAt >= v.createdAt && v.finishedAt <= v.updatedAt) &&
    (['succeeded', 'failed', 'cancelled'].includes(v.status) ? v.finishedAt !== null : v.finishedAt === null) &&
    (v.status !== 'succeeded' || v.stepStates.every(s => s.status === 'succeeded'));
}
function usage(v) {
  return matchesFields(v, {
    basis: choice(['provider_reported', 'estimated', 'unknown', 'model_tokenizer', 'heuristic', 'reserved_limit']), inputTokens: nullable(integer),
    outputTokens: nullable(integer), cachedInputTokens: nullable(integer), reasoningTokens: nullable(integer), totalTokens: nullable(integer), source: nullable(s => text(s, 200)), version: nullable(s => text(s, 100)), measuredAt: nullable(date), reason: nullable(s => text(s, 100)),
  }, ['reasoningTokens', 'totalTokens', 'source', 'version', 'measuredAt', 'reason']) && (v.basis === 'unknown' ? v.inputTokens === null && v.outputTokens === null && v.cachedInputTokens === null :
    (v.inputTokens !== null || v.outputTokens !== null) && (v.cachedInputTokens === null || v.inputTokens !== null && v.cachedInputTokens <= v.inputTokens));
}
function receipt(v) {
  return matchesFields(v, {
    ...base, projectId: id, runId: id, stepId: id, attemptId: id, capabilityId: name,
    capabilityVersion: revision, status: choice(ATTEMPT_STATUSES), startedAt: date, finishedAt: nullable(date),
    inputArtifactRefs: ids, outputArtifactRefs: ids, sources: a => array(a, source, 256),
    errorCode: nullable(name), usage,
  }) && v.startedAt >= v.createdAt && (v.finishedAt === null || v.finishedAt >= v.startedAt) &&
    (['succeeded', 'failed', 'unknown'].includes(v.status) ? v.finishedAt !== null : v.finishedAt === null) &&
    (v.status !== 'succeeded' || v.errorCode === null) && unique(v.sources, s => s.id) && v.sources.every(s => s.receiptId === v.id);
}
function artifact(v) {
  return matchesFields(v, {
    ...base, projectId: id, runId: id, version: revision,
    mediaType: choice(['text/markdown', 'text/plain', 'application/json', 'text/csv', 'audio/mpeg', 'audio/wav', 'audio/ogg', 'audio/webm', 'audio/mp4', 'image/png', 'image/jpeg', 'image/webp', 'video/mp4']),
    filename: s => typeof s === 'string' && /^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/.test(s) && !s.includes('..') &&
      !/[. ]$/.test(s) && !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(s),
    byteLength: n => integer(n, v.mediaType==='video/mp4'?WORKFLOW_LIMITS.videoArtifactBytes:WORKFLOW_LIMITS.artifactBytes), sha256: hash, receiptRefs: ids, sourceRefs: ids,
  });
}
/**
 * Structured input shape (types and field names only, never values). Lets a recipe take a
 * structured argument — e.g. an API request object — that the recipient fills with their own data.
 */
const SHAPE_KEY = /^[A-Za-z0-9_.-]{1,64}$/;
function inputShape(v, depth = 0) {
  if (!isDataRecord(v) || depth > 4) return false;
  if (v.type === 'object') {
    const props = v.properties;
    return matchesFields(v, {
      type: t => t === 'object',
      properties: p => isDataRecord(p) && Object.keys(p).length >= 1 && Object.keys(p).length <= 32 &&
        Object.entries(p).every(([key, shape]) => SHAPE_KEY.test(key) && !['__proto__', 'constructor', 'prototype'].includes(key) && inputShape(shape, depth + 1)),
      required: a => array(a, key => typeof key === 'string' && isDataRecord(props) && Object.hasOwn(props, key), 32) && unique(a),
    }, ['required']);
  }
  if (v.type === 'array') return matchesFields(v, { type: t => t === 'array', items: s => inputShape(s, depth + 1), maxItems: n => integer(n, 256, 1) }, ['maxItems']);
  return matchesFields(v, { type: choice(['string', 'integer', 'number', 'boolean']) });
}
/** Fixed fields merged under a structured input (configuration kept from the source run). */
const defaultsRecord = d => {
  if (!isDataRecord(d) || !Object.keys(d).length || Object.keys(d).length > 32 || Object.keys(d).some(k => !SHAPE_KEY.test(k))) return false;
  try { return new TextEncoder().encode(JSON.stringify(d)).byteLength <= 4096; } catch { return false; }
};
const parameter = v => matchesFields(v, {
  name, type: choice(['string', 'integer', 'boolean', 'json']), required: v => typeof v === 'boolean', label: s => text(s, 120), schema: s => inputShape(s), defaults: defaultsRecord,
}, ['label', 'schema', 'defaults']) && (v.type === 'json') === (v.schema !== undefined) && (v.type !== 'json' || ['object', 'array'].includes(v.schema.type)) &&
  (v.defaults === undefined || v.type === 'json' && v.schema.type === 'object' && Object.keys(v.defaults).every(k => !Object.hasOwn(v.schema.properties, k)));
/**
 * Additive provenance (Valor de Uso V1): the recipe was derived from a run whose every step
 * succeeded with receipts. It identifies content and origin; it never authorizes a new run.
 */
const recipeOrigin = v => matchesFields(v, {
  kind: choice(['confirmed_run']), runId: id, planId: id, planDigest: hash, receiptsDigest: hash, sealedAt: date,
});
function recipe(v) {
  return matchesFields(v, {
    ...base, version: revision, title: s => text(s, 200), description: s => text(s, 2000, true),
    parameters: a => array(a, parameter, 32), steps: s => steps(s, true), limits, expectedOutputs: names, origin: recipeOrigin,
  }, ['origin']) && unique(v.parameters, p => p.name) && v.steps.length <= v.limits.maxSteps && v.steps.every(s =>
    Object.values(s.arguments).every(a => a.kind !== 'parameter' || v.parameters.some(p => p.name === a.parameter)));
}
// Decimal integer strings make BigInt wire-safe. Micro-USD rates per million tokens.
const decimal = v => typeof v === 'string' && /^(0|[1-9][0-9]{0,29})$/.test(v);
function tariff(v) {
  return matchesFields(v, {
    ...base, version: revision, provider: name, model: s => text(s, 200), accessMode: choice(accessModes),
    currency: v => v === 'USD', unit: choice(['million_tokens','per_image','per_second','per_character','per_megapixel']),
    inputMicrosPerMillion: decimal, outputMicrosPerMillion: decimal, cachedInputMicrosPerMillion: nullable(decimal), priceMicrosPerUnit: nullable(decimal),
    sourceUrl: url, checkedAt: date, validFrom: date, validUntil: nullable(date),
    comparisonBasis: choice(['same_service', 'explicit_alternative']),
  // Per-unit price is optional so token tariffs stored before media units remain valid; media units need it.
  }, ['priceMicrosPerUnit']) && (v.validUntil === null || v.validUntil > v.validFrom)
    && (v.unit === 'million_tokens' ? (v.priceMicrosPerUnit ?? null) === null : typeof v.priceMicrosPerUnit === 'string');
}
const amount = v => matchesFields(v, { numeratorMicros: decimal, denominator: s => decimal(s) && s !== '0' });
function valueReceipt(v) {
  return matchesFields(v, {
    ...base, projectId: id, runId: id, stepId: id, attemptId: id,
    provider: name, model: s => text(s, 200), accessMode: choice(accessModes),
    cache: choice(['none', 'provider', 'local']), usage,
    tariffId: nullable(id), tariffVersion: nullable(revision), referenceValue: nullable(amount),
    estimatedProviderCharge: nullable(amount), confirmedUptokeyCharge: nullable(amount),
    coverage: choice(['included', 'missing_usage', 'missing_tariff', 'not_comparable', 'local_cache', 'estimated_usage']),
  }) && ((v.tariffId === null) === (v.tariffVersion === null)) &&
    (v.coverage === 'included' ? v.usage.basis === 'provider_reported' && v.usage.inputTokens !== null && v.usage.outputTokens !== null &&
      v.tariffId !== null && v.referenceValue !== null && v.cache !== 'local' : v.referenceValue === null) &&
    ((v.cache === 'local') === (v.coverage === 'local_cache')) &&
    (v.coverage !== 'missing_usage' || v.usage.inputTokens === null || v.usage.outputTokens === null) &&
    (v.coverage !== 'estimated_usage' || ['estimated', 'heuristic', 'reserved_limit'].includes(v.usage.basis)) &&
    (v.coverage !== 'missing_tariff' || v.tariffId === null) &&
    (v.estimatedProviderCharge === null || v.tariffId !== null && v.usage.inputTokens !== null && v.usage.outputTokens !== null && v.cache !== 'local');
}
function parse(v, check) {
  try {
    // Reject getters, cycles, prototypes, sparse arrays and oversized data before traversal.
    const serialized = canonicalJson(v);
    if (new TextEncoder().encode(serialized).byteLength > WORKFLOW_LIMITS.commandBytes) fail();
    const copy = JSON.parse(serialized);
    if (!check(copy)) fail();
    return copy;
  } catch { fail(); }
}
export const parseCapabilityDescriptor = v => parse(v, capability);
export const parseProjectContext = v => parse(v, project);
export const parseContextSnapshot = v => parse(v, snapshot);
export const parseExecutionPlan = v => parse(v, plan);
export const parseProjectGrant = v => parse(v, grant);
export const parsePlanApproval = v => parse(v, value => matchesFields(value, {
  id, projectId: id, planId: id, planDigest: hash, principalId: id,
  destinations, expiresAt: date, consumedByRunId: nullable(id),
}));
export const parseRun = v => parse(v, run);
export const parseExecutionReceipt = v => parse(v, receipt);
export const parseArtifact = v => parse(v, artifact);
export const parseRecipe = v => parse(v, recipe);
export const parseReferenceTariff = v => parse(v, tariff);
export const parseUsageValueReceipt = v => parse(v, valueReceipt);

/** Digest commits to every plan field except the digest itself, including snapshot digest. */
export function canonicalPlanPayload(value) {
  const { digest: _digest, ...payload } = parseExecutionPlan(value);
  return canonicalJson(payload);
}
export function canonicalContextSnapshotPayload(value) { return canonicalJson(parseContextSnapshot(value)); }

/** Structural binding only. Does NOT authorize, verify hashes, check revocation or reserve quotas. */
export function validatePlanBindings(planValue, snapshotValue, capabilityValues) {
  const p = parseExecutionPlan(planValue), s = parseContextSnapshot(snapshotValue);
  if (!array(capabilityValues, () => true, 64, 1)) fail();
  const capabilities = capabilityValues.map(parseCapabilityDescriptor);
  if (!unique(capabilities, c => `${c.id}@${c.version}`) || p.contextSnapshotId !== s.id ||
    p.projectId !== s.projectId || p.projectRevision !== s.projectRevision) fail();
  for (const step of p.steps) {
    const c = capabilities.find(c => c.id === step.capabilityId && c.version === step.capabilityVersion);
    if (!c || c.availability !== 'executable' || !s.allowedDestinations.some(d =>
      d.kind === c.dataDestination.kind && d.id === c.dataDestination.id)) fail();
  }
  return true;
}

/** Wire command validators: separate client-controlled input from persisted server records. */
const commands = {
  importProject: v => matchesFields(v, {legacyId:id,name:s=>text(s,200),goal:s=>text(s,8000,true),
    entries:a=>array(a,item=>matchesFields(item,{id,content:s=>text(s,16000),origin:choice(['user','model'])}),256)&&new Set(a.map(item=>item.id)).size===a.length}),
  createProject: v => matchesFields(v, { name: s => text(s, 200), goal: s => text(s, 8000, true) }),
  patchProject: v => matchesFields(v, {
    expectedRevision: revision, name: s => text(s, 200), goal: s => text(s, 8000, true),
    constraints: a => array(a, s => text(s, 2000), 32),
  }, ['name', 'goal', 'constraints']) && Object.keys(v).length > 1,
  createPlan: v => matchesFields(v, {
    expectedRevision: revision, objective: s => text(s, 8000), selectedEntryIds: ids,
    selectedArtifactIds: ids, sourceIds: names, limits,
  }),
  startRun: v => matchesFields(v, { planId: id, planDigest: hash, requestId: id }),
  cancelRun: v => matchesFields(v, {}),
  // Legacy {planId,title} saves a planned recipe; with runId it derives from a confirmed run and
  // the chosen literal arguments become typed parameters (Valor de Uso V1).
  createRecipe: v => matchesFields(v, {
    planId: id, title: s => text(s, 200), runId: id, description: s => text(s, 2000, true),
    parameters: a => array(a, p => matchesFields(p, {
      name, stepId: id, argument: s => typeof s === 'string' && /^[A-Za-z0-9_.-]{1,64}$/.test(s),
      type: choice(['string', 'integer', 'boolean', 'json']), required: b => typeof b === 'boolean', label: s => text(s, 120),
      // For a structured argument: only these fields vary; the others stay as reviewed defaults.
      fields: a => array(a, k => typeof k === 'string' && SHAPE_KEY.test(k), 32, 1) && unique(a),
    }, ['label', 'fields']) && (p.fields === undefined || p.type === 'json'), 32),
  }, ['runId', 'description', 'parameters']) && (v.runId !== undefined || v.parameters === undefined && v.description === undefined) &&
    // One name may bind several targets (the same value used by several steps) with one type.
    (v.parameters === undefined || unique(v.parameters, p => `${p.stepId}\u0000${p.argument}`) &&
      v.parameters.every(p => v.parameters.every(q => q.name !== p.name || q.type === p.type))),
  recipePlan: v => matchesFields(v, { recipeVersion: revision, expectedRevision: revision,
    parameters: p => isDataRecord(p) && Object.keys(p).length <= 32 && Object.keys(p).every(k =>
      name(k) && !['constructor', 'prototype', '__proto__'].includes(k) &&
      (typeof p[k] === 'boolean' || Number.isSafeInteger(p[k]) || text(p[k], 4000))),
  }),
};
export function parseWorkflowCommand(command, value) {
  if (!Object.hasOwn(commands, command)) fail();
  return parse(value, commands[command]);
}
