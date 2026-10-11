import { createHash } from 'node:crypto';
import { parseCapabilityDescriptor } from '@uptokey/sync-contract/workflow';
import {
  importOpenApiSpec,
  canonicalStringify,
  OpenApiImportError,
} from './importer.ts';
import { isPrivateOrLoopbackHost, prepareApiCall } from './governed-transport.ts';
import type {
  CuratedOperation,
  ParameterDefinition,
  ParameterSchema,
  ParameterScalar,
  SupportedHttpMethod,
} from './types.ts';
import type { CuratedServiceMetadata } from './specs/index.ts';

/**
 * Stage 18 — safe learning of APIs as versioned local recipes.
 *
 * A user teaches an API from documentation, an OpenAPI document, a `curl`
 * example, an official SDK reference or an approved first call. The product
 * turns it into a LOCAL, versioned, private, auditable recipe that compiles
 * to the same `CuratedOperation`/`PreparedApiCall` machinery as curated
 * reads. Promotion beyond the owner is never a side effect of use: global
 * presets require a secret-free review package, official origin, license and
 * maintainer acceptance.
 *
 * Pure module: zero network, zero secret persistence, zero inference.
 * Semantic judgments (TypeSafe/Jev) may PROPOSE operations or field mappings
 * through `SemanticRecipeProposer`, but code validates schema, host, method,
 * auth, limits and destination. A manual form path always works (#10).
 *
 * This module never touches the global catalog: learned capability ids live
 * under `api.learned_*` and are resolved per owner/project by the workspace
 * layer. `ALL_CURATED_OPERATIONS` is never mutated here.
 */

export type RecipeTrustLevel =
  | 'local_private'
  | 'team_private'
  | 'community_candidate'
  | 'verified_preset'
  | 'revoked_or_stale';

export type RecipeSourceKind = 'openapi' | 'curl' | 'observed_response' | 'doc_url' | 'sdk';

export interface RecipeSourceRef {
  kind: RecipeSourceKind;
  /** sha256 of the canonical source material (never the material itself). */
  digest: string;
  origin?: string;
  note?: string;
}

export interface LearnedRecipeExample {
  name: string;
  parameters: Record<string, unknown>;
  /** Observed values were seen in a real approved response; inferred ones were not. */
  confidence: 'observed' | 'inferred';
  coverage: string;
}

export interface LearnedApiRecipe {
  resourceId?:string;
  schemaVersion: 1;
  id: string;
  revision: number;
  projectId: string;
  ownerPrincipalId: string;
  createdAt: string;
  updatedAt: string;
  trustLevel: RecipeTrustLevel;
  /** Free local label. Never proof of identity (poisoning rule 1). */
  declaredBrand: string;
  /** Official origin, set only with evidence at review time; null until then. */
  verifiedOrigin: string | null;
  sourceRefs: readonly RecipeSourceRef[];
  operations: readonly CuratedOperation[];
  authScheme: 'none' | { kind: 'oauth2-account'; providerHint?: string } | {kind:'bearer'} | {kind:'header-api-key';headerName:string};
  limits: { maxOutputBytes: number; timeoutMs: number };
  dataHandling: string;
  examples: readonly LearnedRecipeExample[];
  /** locale -> aliases. Canonical function stays universal (no single-region center). */
  aliases: Readonly<Record<string, readonly string[]>>;
  functionTags: readonly string[];
  review?: { reviewer: string; acceptedAt: string; evidence: PromotionEvidence };
  revokeReason?: string;
}

/** Marker carried by compiled learned operations (never in the global catalog). */
export interface LearnedOperationMarker {
  recipeId: string;
  revision: number;
}

export interface PromotionEvidence {
  officialOrigin: string;
  license: string;
  termsUrl: string;
  positiveFixtures: number;
  negativeFixtures: number;
}

export interface PromotionPackage {
  schemaVersion: 1;
  recipeId: string;
  revision: number;
  declaredBrand: string;
  verifiedOrigin: string | null;
  origins: readonly string[];
  operations: readonly {
    operationId: string;
    method: string;
    path: string;
    parameters: readonly ParameterDefinition[];
    schemaDigest: string;
  }[];
  sourceRefs: readonly RecipeSourceRef[];
  functionTags: readonly string[];
  review: { required: true };
}

export class LearnedRecipeError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(`${code}: ${message}`);
    this.name = 'LearnedRecipeError';
    this.code = code;
  }
}

const MAX_SOURCE_BYTES = 256 * 1024;
const MAX_OPERATIONS = 8;
const MAX_PARAMS = 32;
const MAX_ALIASES_PER_LOCALE = 12;

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

function fail(code: string, message: string): never {
  throw new LearnedRecipeError(code, message);
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 48);
  if (!slug) fail('learned_invalid_brand', 'Declared brand needs at least one alphanumeric character');
  return slug;
}

function isoNow(): string {
  return new Date().toISOString();
}

function assertId(value: unknown, what: string): string {
  if (typeof value !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) fail('learned_invalid_id', `Invalid ${what}`);
  return value as string;
}

/* ------------------------------------------------------------------ */
/* Credential and secret detection (ingest-time refusal, rule 4 and 6) */
/* ------------------------------------------------------------------ */

const SECRET_QUERY_NAMES = new Set([
  'token', 'access_token', 'secret', 'client_secret', 'api_key', 'apikey', 'key',
  'auth', 'authorization', 'password', 'passwd', 'credential', 'session', 'sessionid',
  'cookie', 'private_key', 'secret_key',
]);

const SECRET_VALUE_PREFIXES = [
  'sk-', 'gsk_', 'utk_', 'xox-', 'ghp_', 'gho_', 'AKIA', 'AIza', 'Bearer ', 'Basic ',
  '-----BEGIN',
];

/** Credential material in pasted sources is refused, never persisted (rules 4, 6, 8). */
export function findCredentialMaterial(text: string): string | undefined {
  if (typeof text !== 'string' || !text) return undefined;
  for (const prefix of SECRET_VALUE_PREFIXES) {
    if (text.includes(prefix)) return `secret-shaped value (${prefix.trim() || 'key block'})`;
  }
  const headerMatch = /(?:^|\s)(authorization|cookie|x-api-key)\s*:/im.exec(text);
  if (headerMatch) return `credential header (${headerMatch[1]!.toLowerCase()})`;
  if (/\b(password|client_secret)\b\s*[:=]/i.test(text)) return 'password/secret assignment';
  return undefined;
}

function checkQuerySecrets(url: URL): void {
  for (const [name, value] of url.searchParams) {
    if (SECRET_QUERY_NAMES.has(name.toLowerCase())) {
      fail('learned_secret_in_query', `Secret-bearing query parameter '${name}' is ineligible`);
    }
    for (const prefix of SECRET_VALUE_PREFIXES) {
      if (value.includes(prefix)) fail('learned_secret_in_query', `Secret-shaped query value for '${name}' is ineligible`);
    }
  }
}

function checkOriginStatic(rawUrl: string): { url: URL; origin: string } {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    fail('learned_invalid_url', `Malformed URL: ${rawUrl.slice(0, 128)}`);
  }
  if (url.protocol !== 'https:') fail('learned_insecure_origin', 'Learned recipes require HTTPS origins');
  if (url.username || url.password) fail('learned_credential_in_source', 'Credentials embedded in URL are refused');
  if (url.hostname.length > 253) fail('learned_invalid_url', 'Hostname too long');
  if (isPrivateOrLoopbackHost(url.hostname)) {
    fail('learned_private_host_denied', `Private, loopback or metadata host '${url.hostname}' is ineligible`);
  }
  checkQuerySecrets(url);
  return { url, origin: url.origin };
}

/* ------------------------------------------------------------------ */
/* Strict recipe validation                                            */
/* ------------------------------------------------------------------ */

const RECIPE_REQUIRED_KEYS = 'aliases,authScheme,createdAt,dataHandling,declaredBrand,examples,functionTags,id,limits,operations,ownerPrincipalId,projectId,revision,schemaVersion,sourceRefs,trustLevel,updatedAt,verifiedOrigin';
const RECIPE_OPTIONAL_KEYS = new Set(['review', 'revokeReason','resourceId']);

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/** Closed-shape validation for persisted learned recipes. */
export function parseLearnedApiRecipe(value: unknown): LearnedApiRecipe {
  if (!isRecord(value)) fail('learned_recipe_invalid', 'Recipe shape mismatch');
  if(value.resourceId!==undefined&&(typeof value.resourceId!=='string'||! /^[a-z][a-z0-9_-]{0,159}$/.test(value.resourceId)))fail('learned_recipe_invalid','Invalid resource reference');
  const keys = Object.keys(value).sort();
  const required = keys.filter(key => !RECIPE_OPTIONAL_KEYS.has(key));
  if (required.join(',') !== RECIPE_REQUIRED_KEYS) {
    fail('learned_recipe_invalid', 'Recipe shape mismatch');
  }
  const recipe = value as Record<string, unknown>;
  if (recipe.schemaVersion !== 1) fail('learned_recipe_invalid', 'Unsupported recipe schema');
  const id = assertId(recipe.id, 'recipe id');
  const projectId = assertId(recipe.projectId, 'project id');
  const ownerPrincipalId = typeof recipe.ownerPrincipalId === 'string' && recipe.ownerPrincipalId
    ? recipe.ownerPrincipalId : fail('learned_recipe_invalid', 'Invalid owner') as never;
  if (!Number.isSafeInteger(recipe.revision) || (recipe.revision as number) < 1) fail('learned_recipe_invalid', 'Invalid revision');
  for (const field of ['createdAt', 'updatedAt'] as const) {
    if (typeof recipe[field] !== 'string' || !Number.isFinite(Date.parse(recipe[field] as string))) {
      fail('learned_recipe_invalid', `Invalid ${field}`);
    }
  }
  const trustLevels: readonly string[] = ['local_private', 'team_private', 'community_candidate', 'verified_preset', 'revoked_or_stale'];
  if (!trustLevels.includes(recipe.trustLevel as string)) fail('learned_recipe_invalid', 'Unknown trust level');
  if (typeof recipe.declaredBrand !== 'string' || !recipe.declaredBrand.trim() || recipe.declaredBrand.length > 120) {
    fail('learned_recipe_invalid', 'Invalid declared brand');
  }
  if (recipe.verifiedOrigin !== null) {
    if (typeof recipe.verifiedOrigin !== 'string') fail('learned_recipe_invalid', 'Invalid verified origin');
    checkOriginStatic(recipe.verifiedOrigin);
  }
  if (!Array.isArray(recipe.sourceRefs) || recipe.sourceRefs.length < 1 || recipe.sourceRefs.length > 16) {
    fail('learned_recipe_invalid', 'sourceRefs must list 1..16 sources');
  }
  for (const source of recipe.sourceRefs as unknown[]) {
    if (!isRecord(source) || !['openapi', 'curl', 'observed_response', 'doc_url', 'sdk'].includes(source.kind as string) ||
        typeof source.digest !== 'string' || !/^[a-f0-9]{64}$/.test(source.digest)) {
      fail('learned_recipe_invalid', 'Invalid source ref');
    }
  }
  if (!Array.isArray(recipe.operations) || recipe.operations.length < 1 || recipe.operations.length > MAX_OPERATIONS) {
    fail('learned_recipe_invalid', 'operations must list 1..8 compiled operations');
  }
  for (const operation of recipe.operations as unknown[]) {
    assertLearnedOperation(operation);
  }
  if (recipe.authScheme !== 'none') {
    const auth=recipe.authScheme;
    if(!isRecord(auth)||!['oauth2-account','bearer','header-api-key'].includes(String(auth.kind)))fail('learned_recipe_invalid','Invalid credential binding');
    if(auth.kind==='bearer'&&Object.keys(auth).join(',')!=='kind')fail('learned_recipe_invalid','Invalid bearer binding');
    if(auth.kind==='header-api-key'&&(Object.keys(auth).sort().join(',')!=='headerName,kind'||!safeCredentialHeader(auth.headerName)))fail('learned_recipe_invalid','Invalid header binding');
  }
  const limits = recipe.limits as Record<string, unknown> | undefined;
  if (!isRecord(limits) || !Number.isSafeInteger(limits.maxOutputBytes) || (limits.maxOutputBytes as number) <= 0 ||
      !Number.isSafeInteger(limits.timeoutMs) || (limits.timeoutMs as number) <= 0) {
    fail('learned_recipe_invalid', 'Invalid recipe limits');
  }
  if (typeof recipe.dataHandling !== 'string' || recipe.dataHandling.length > 2048) fail('learned_recipe_invalid', 'Invalid data handling note');
  if (!Array.isArray(recipe.examples) || recipe.examples.length > 32) fail('learned_recipe_invalid', 'Invalid examples');
  for (const example of recipe.examples as unknown[]) {
    if (!isRecord(example) || typeof example.name !== 'string' || !isRecord(example.parameters) ||
        !['observed', 'inferred'].includes(example.confidence as string) || typeof example.coverage !== 'string') {
      fail('learned_recipe_invalid', 'Invalid example (needs name, parameters, confidence, coverage)');
    }
  }
  if (!isRecord(recipe.aliases) || Object.keys(recipe.aliases).length > 16) fail('learned_recipe_invalid', 'Invalid aliases');
  for (const [locale, aliases] of Object.entries(recipe.aliases)) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) || !Array.isArray(aliases) || aliases.length > MAX_ALIASES_PER_LOCALE ||
        aliases.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 80)) {
      fail('learned_recipe_invalid', `Invalid aliases for ${locale}`);
    }
  }
  if (!Array.isArray(recipe.functionTags) || recipe.functionTags.length > 8 ||
      recipe.functionTags.some(tag => typeof tag !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(tag))) {
    fail('learned_recipe_invalid', 'Invalid function tags');
  }
  if (recipe.trustLevel === 'verified_preset') {
    assertReview(recipe.review);
  }
  return value as unknown as LearnedApiRecipe;
}

function assertLearnedOperation(operation: unknown): void {
  if (!isRecord(operation)) fail('learned_recipe_invalid', 'Invalid compiled operation');
  const op = operation as Record<string, unknown>;
  if (typeof op.id !== 'string' || !/^api\.learned_[a-z0-9_]+\.[a-z0-9_]+$/.test(op.id)) {
    fail('learned_recipe_invalid', 'Learned capability ids stay under api.learned_* (never shadow curated ids)');
  }
  if (op.method !== 'GET') fail('learned_recipe_invalid', 'Learned reads are GET-only');
  if (typeof op.serverUrl !== 'string') fail('learned_recipe_invalid', 'Invalid server origin');
  checkOriginStatic(op.serverUrl);
  if (!Array.isArray(op.parameters) || op.parameters.length > MAX_PARAMS) fail('learned_recipe_invalid', 'Too many parameters');
  const marker = op.learnedRecipe as Record<string, unknown> | undefined;
  if (!isRecord(marker) || typeof marker.recipeId !== 'string' || !Number.isSafeInteger(marker.revision)) {
    fail('learned_recipe_invalid', 'Compiled operations carry their recipe revision');
  }
  const capability = op.capability as Record<string, unknown> | undefined;
  if (!isRecord(capability) || capability.effect !== 'read_external' || capability.availability !== 'executable') {
    fail('learned_recipe_invalid', 'Learned capabilities are executable reads only');
  }
}

/* ------------------------------------------------------------------ */
/* Ingestion: OpenAPI                                                  */
/* ------------------------------------------------------------------ */

export interface OpenApiIngestOutcome {
  recipe: LearnedApiRecipe;
  /** Declared operations that are ineligible (never silently dropped). */
  refused: Array<{ operationId: string; code: string }>;
}

function splitOpenApiMethods(doc: Record<string, unknown>): { getPaths: Record<string, unknown>; refused: Array<{ operationId: string; code: string }> } {
  const paths = isRecord(doc.paths) ? doc.paths : fail('learned_openapi_invalid', 'OpenAPI needs a paths object') as never;
  const getPaths: Record<string, unknown> = {};
  const refused: Array<{ operationId: string; code: string }> = [];
  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!isRecord(pathItem)) continue;
    const kept: Record<string, unknown> = {};
    for (const [methodKey, opItem] of Object.entries(pathItem)) {
      if (['summary', 'description', 'parameters'].includes(methodKey) || methodKey.startsWith('x-')) {
        kept[methodKey] = opItem;
        continue;
      }
      const operationId = isRecord(opItem) && typeof opItem.operationId === 'string' ? opItem.operationId : `${methodKey} ${pathStr}`;
      if (methodKey.toUpperCase() !== 'GET') {
        // Hidden destructive methods stay ineligible; reads still import (#9: no silent substitution).
        refused.push({ operationId, code: 'learned_destructive_method' });
        continue;
      }
      kept[methodKey] = opItem;
    }
    if (Object.keys(kept).length > 0) getPaths[pathStr] = kept;
  }
  return { getPaths, refused };
}

function safeCredentialHeader(value:unknown):value is string{return typeof value==='string'&&/^[A-Za-z][A-Za-z0-9-]{0,63}$/.test(value)&&!['host','cookie','set-cookie','origin','referer','connection','content-length','content-type','transfer-encoding','accept','accept-encoding','user-agent','upgrade','te','trailer','forwarded'].includes(value.toLowerCase())&&!value.toLowerCase().startsWith('proxy-')&&!value.toLowerCase().startsWith('sec-');}
function checkDocSecurity(doc: Record<string, unknown>): LearnedApiRecipe['authScheme'] {
  const components = isRecord(doc.components) ? (doc.components as Record<string, unknown>) : undefined;
  const schemes = components && isRecord(components.securitySchemes) ? components.securitySchemes as Record<string, unknown> : {};
  const parse=(security:unknown):LearnedApiRecipe['authScheme']=>{
    if(security===undefined||Array.isArray(security)&&security.length===0)return 'none';
    if(!Array.isArray(security)||security.length!==1||!isRecord(security[0])||Object.keys(security[0]).length!==1)fail('learned_auth_unsupported','Use one explicit authentication scheme');
    const name=Object.keys(security[0])[0]!,scheme=schemes[name];
    if(!isRecord(scheme))fail('learned_auth_unsupported','Missing authentication definition');
    if(scheme.type==='http'&&String(scheme.scheme).toLowerCase()==='bearer')return {kind:'bearer'};
    if(scheme.type==='apiKey'&&scheme.in==='header'&&safeCredentialHeader(scheme.name))return {kind:'header-api-key',headerName:scheme.name};
    if(scheme.type==='apiKey'&&scheme.in==='query')fail('learned_secret_in_query','Credentials cannot be persisted in request URLs');
    fail('learned_auth_unsupported','Use an existing OAuth integration or supported header credential');
  };
  let selected:LearnedApiRecipe['authScheme']|undefined;
  for(const path of Object.values(isRecord(doc.paths)?doc.paths:{})){if(!isRecord(path)||!isRecord(path.get))continue;const auth=parse(path.get.security??doc.security);if(selected!==undefined&&canonicalStringify(auth)!==canonicalStringify(selected))fail('learned_auth_mixed','Split operations with different authentication into separate recipes');selected=auth;}
  return selected??parse(doc.security);
}

/**
 * Ingests an OpenAPI 3.0/3.1 document into a `local_private` draft.
 * Pure: no network, no secrets, no inference. Non-GET operations are
 * reported as refused, never imported and never executed.
 */
export function ingestOpenApiSource(
  doc: unknown,
  meta: { ownerPrincipalId: string; projectId: string; declaredBrand: string; recipeId?: string; aliases?: Record<string, string[]>; functionTags?: string[] },
): OpenApiIngestOutcome {
  if (!isRecord(doc)) fail('learned_openapi_invalid', 'OpenAPI source must be an object');
  const raw = JSON.stringify(doc);
  if (raw.length > MAX_SOURCE_BYTES) fail('learned_source_too_large', 'OpenAPI source exceeds 256 KB');
  const credential = findCredentialMaterial(raw);
  if (credential) fail('learned_credential_in_source', `Credential material in source (${credential}); use official account flows`);
  const authScheme=checkDocSecurity(doc);
  // Closed pre-validation of the declared server before importing: HTTPS and
  // public hosts are decided here with learned codes, not importer internals.
  const servers = Array.isArray(doc.servers) ? doc.servers : [];
  const firstServer = servers[0] as Record<string, unknown> | undefined;
  if (!firstServer || typeof firstServer.url !== 'string') {
    fail('learned_openapi_invalid', 'OpenAPI source declares no server URL');
  }
  checkOriginStatic(firstServer.url.trim());
  const { getPaths, refused } = splitOpenApiMethods(doc);
  let imported;
  try {
    const paths=JSON.parse(JSON.stringify(getPaths));for(const path of Object.values(paths))if(isRecord(path)&&isRecord(path.get))delete path.get.security;
    imported = importOpenApiSpec({ ...doc, paths });
  } catch (error) {
    if (error instanceof OpenApiImportError) fail('learned_openapi_invalid', `${error.code}: ${error.message}`);
    throw error;
  }
  if (imported.operations.length > MAX_OPERATIONS) {
    fail('learned_schema_too_broad', `Document declares ${imported.operations.length} operations (max ${MAX_OPERATIONS} per learned recipe)`);
  }
  const totalParams = imported.operations.reduce((count, operation) => count + operation.parameters.length, 0);
  if (totalParams > MAX_PARAMS) {
    fail('learned_schema_too_broad', `Document declares ${totalParams} parameters (max ${MAX_PARAMS} per learned recipe)`);
  }
  return { recipe: parseLearnedApiRecipe({...draftRecipe(meta, imported.operations, 'openapi', raw),authScheme}), refused };
}

/* ------------------------------------------------------------------ */
/* Ingestion: curl                                                     */
/* ------------------------------------------------------------------ */

export interface CurlCandidate {
  method: string;
  url: string;
  query: Record<string, string>;
  publicHeaders: Record<string, string>;
}

const CURL_FLAG_WITH_VALUE = new Set(['-H', '--header', '-X', '--request', '--url', '--data', '--data-raw', '--data-ascii', '--data-binary', '--data-urlencode', '-d', '--user', '-u', '-b', '--cookie', '--max-time', '-m']);

/** Strict, dependency-free curl tokenization (quotes, escapes, continuations). */
function tokenizeCurl(text: string): string[] {
  const flat = text.replace(/\\\r?\n/g, ' ');
  const tokens: string[] = [];
  let current = '';
  let quote: string | undefined;
  let i = 0;
  const push = (): void => {
    if (current !== '' || quote !== undefined) tokens.push(current);
    current = '';
    quote = undefined;
  };
  while (i < flat.length) {
    const char = flat[i]!;
    if (quote) {
      if (char === quote) { quote = undefined; }
      else if (char === '\\' && quote === '"' && i + 1 < flat.length) { current += flat[i + 1]!; i += 1; }
      else current += char;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/\s/.test(char)) {
      push();
    } else if (char === '\\' && i + 1 < flat.length) {
      current += flat[i + 1]!;
      i += 1;
    } else {
      current += char;
    }
    i += 1;
  }
  push();
  return tokens.filter(token => token !== '');
}

/**
 * Parses a pasted `curl` example into a read candidate. Credential flags,
 * bodies, insecure TLS and non-GET methods are refused with closed codes.
 */
export function parseCurlSource(text: string): CurlCandidate {
  if (typeof text !== 'string' || !text.trim() || text.length > MAX_SOURCE_BYTES) {
    fail('learned_curl_invalid', 'curl source must be non-empty text within 256 KB');
  }
  const credential = findCredentialMaterial(text);
  if (credential) fail('learned_credential_in_source', `Credential material in curl (${credential}); use official account flows`);
  const tokens = tokenizeCurl(text.trim());
  if (tokens[0] !== 'curl') fail('learned_curl_invalid', 'Source must start with curl');
  let method: string | undefined;
  let rawUrl: string | undefined;
  const publicHeaders: Record<string, string> = {};
  let i = 1;
  while (i < tokens.length) {
    const token = tokens[i]!;
    if (token === '-X' || token === '--request') {
      method = tokens[i + 1]?.toUpperCase();
      i += 2;
      continue;
    }
    if (token === '-H' || token === '--header') {
      const header = tokens[i + 1] ?? '';
      const separator = header.indexOf(':');
      if (separator < 1) fail('learned_curl_invalid', 'Malformed header in curl');
      const name = header.slice(0, separator).trim().toLowerCase();
      const value = header.slice(separator + 1).trim();
      if (['authorization', 'cookie', 'x-api-key', 'api-key'].includes(name) || name.endsWith('-token') || name.endsWith('-secret')) {
        fail('learned_credential_in_source', `Credential header '${name}' is refused; use official account flows`);
      }
      if (Object.keys(publicHeaders).length >= 8) fail('learned_curl_invalid', 'Too many headers');
      publicHeaders[name] = value.slice(0, 512);
      i += 2;
      continue;
    }
    if (token === '--url') {
      if (rawUrl) fail('learned_curl_invalid', 'Multiple URLs in curl');
      rawUrl = tokens[i + 1];
      i += 2;
      continue;
    }
    if (token === '--get' || token === '-G') { method = 'GET'; i += 1; continue; }
    if (token === '-k' || token === '--insecure') fail('learned_insecure_origin', 'curl --insecure is refused');
    if (['-u', '--user', '-b', '--cookie', '--data', '--data-raw', '--data-ascii', '--data-binary', '--data-urlencode', '-d'].includes(token)) {
      fail('learned_credential_in_source', `curl flag '${token}' carries credentials or a body; learned reads are bodyless`);
    }
    if (token.startsWith('-')) {
      if (CURL_FLAG_WITH_VALUE.has(token)) { i += 2; continue; }
      i += 1;
      continue;
    }
    if (rawUrl) fail('learned_curl_invalid', 'Multiple URLs in curl');
    rawUrl = token;
    i += 1;
  }
  if (!rawUrl) fail('learned_curl_invalid', 'curl carries no URL');
  const resolvedMethod = method ?? 'GET';
  if (resolvedMethod !== 'GET') fail('learned_destructive_method', `curl method ${resolvedMethod} is ineligible; writes need authorized account flows`);
  const { url } = checkOriginStatic(rawUrl!);
  const query: Record<string, string> = {};
  for (const [name, value] of url.searchParams) {
    if (Object.hasOwn(query, name)) fail('learned_curl_invalid', 'Duplicate query parameter');
    query[name] = value;
  }
  return { method: 'GET', url: url.origin + url.pathname, query, publicHeaders };
}

/* ------------------------------------------------------------------ */
/* Ingestion: observed response (manual form fallback, #10)            */
/* ------------------------------------------------------------------ */

export interface ObservedResponseInput {
  url: string;
  sample: unknown;
  /** Manually declared parameters (the form path needs no inference). */
  parameters?: Array<{ name: string; type: ParameterSchema['type']; required?: boolean; example?: ParameterScalar }>;
}

/**
 * Builds a draft from an approved first response plus manual fields.
 * Inferred parameters are optional with observed examples and coverage;
 * absent/null values fall back instead of inventing a contract (rule 7).
 */
export function ingestObservedResponse(
  input: ObservedResponseInput,
  meta: { ownerPrincipalId: string; projectId: string; declaredBrand: string; recipeId?: string; operationName?: string; aliases?: Record<string, string[]>; functionTags?: string[] },
): LearnedApiRecipe {
  if (!isRecord(input) || typeof input.url !== 'string') fail('learned_observed_invalid', 'Observed input needs a URL');
  const { url, origin } = checkOriginStatic(input.url);
  if (url.search) fail('learned_observed_invalid', 'Declare query values as parameters, not inside the URL');
  const credential = findCredentialMaterial(JSON.stringify(input.sample ?? null).slice(0, 65536));
  if (credential) fail('learned_credential_in_source', `Credential material in sample (${credential})`);
  const declared = Array.isArray(input.parameters) ? input.parameters : [];
  if (declared.length > MAX_PARAMS) fail('learned_schema_too_broad', 'Too many manual parameters');
  const parameters: ParameterDefinition[] = [];
  for (const param of declared) {
    if (!isRecord(param) || typeof param.name !== 'string' || !/^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(param.name) ||
        !['string', 'number', 'integer', 'boolean'].includes(param.type as string)) {
      fail('learned_observed_invalid', 'Manual parameters need a valid name and scalar type');
    }
    if (parameters.some(item => item.name === param.name)) fail('learned_observed_invalid', 'Duplicate parameter');
    parameters.push({
      name: param.name,
      in: 'query',
      required: param.required === true,
      description: 'Manually declared for a learned read (inferred, optional unless required)',
      schema: { type: param.type as ParameterSchema['type'], ...(param.example !== undefined ? { default: param.example as ParameterScalar } : {}) },
    });
  }
  const serviceSlug = slugify(meta.declaredBrand);
  const operationName = (meta.operationName ?? 'lookup').replace(/[^A-Za-z0-9_]/g, '_').slice(0, 48) || 'lookup';
  const recipeId = meta.recipeId ?? `lr_${serviceSlug}`;
  assertId(recipeId, 'recipe id');
  const operation: CuratedOperation = compileOperation({
    recipeId,
    revision: 1,
    serviceSlug,
    operationId: operationName,
    method: 'GET',
    path: url.pathname.endsWith('/') && url.pathname !== '/' ? url.pathname.slice(0, -1) : url.pathname,
    serverUrl: origin,
    summary: `${meta.declaredBrand} ${operationName} (learned, unverified)`,
    description: `Learned read from an observed response. Declared brand '${meta.declaredBrand}' is a local label; origin ${origin} is unverified.`,
    parameters,
    sourceRevision: 'learned-r1',
    documentDigest: sha256Hex(canonicalStringify({ url: url.origin + url.pathname, sample: input.sample ?? null })),
  });
  const recipe: LearnedApiRecipe = {
    schemaVersion: 1,
    id: recipeId,
    revision: 1,
    projectId: meta.projectId,
    ownerPrincipalId: meta.ownerPrincipalId,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    trustLevel: 'local_private',
    declaredBrand: meta.declaredBrand,
    verifiedOrigin: null,
    sourceRefs: [{ kind: 'observed_response', digest: sha256Hex(canonicalStringify({ url: url.origin + url.pathname })) }],
    operations: [operation],
    authScheme: 'none',
    limits: { maxOutputBytes: 131_072, timeoutMs: 15_000 },
    dataHandling: 'Public read only; responses are data, never instructions.',
    examples: declared.filter(item => isRecord(item) && (item as Record<string, unknown>).example !== undefined).map(item => ({
      name: `example-${(item as { name: string }).name}`,
      parameters: { [(item as { name: string }).name]: (item as { example?: unknown }).example },
      confidence: 'inferred' as const,
      coverage: 'Single declared example; absent values fall back, never invented.',
    })),
    aliases: sanitizeAliases(meta.aliases),
    functionTags: sanitizeTags(meta.functionTags),
  };
  return parseLearnedApiRecipe(recipe);
}

/* ------------------------------------------------------------------ */
/* Draft assembly and compilation                                      */
/* ------------------------------------------------------------------ */

function draftRecipe(
  meta: { ownerPrincipalId: string; projectId: string; declaredBrand: string; recipeId?: string; aliases?: Record<string, string[]>; functionTags?: string[] },
  imported: CuratedOperation[],
  sourceKind: RecipeSourceKind,
  rawSource: string,
): LearnedApiRecipe {
  const serviceSlug = slugify(meta.declaredBrand);
  const recipeId = meta.recipeId ?? `lr_${serviceSlug}`;
  assertId(recipeId, 'recipe id');
  const operations = imported.map(operation => compileOperation({
    recipeId,
    revision: 1,
    serviceSlug,
    operationId: operation.operationId,
    method: 'GET',
    path: operation.path,
    serverUrl: operation.serverUrl,
    summary: `${operation.summary} (learned, unverified)`,
    description: `Learned read. Declared brand '${meta.declaredBrand}' is a local label; origin ${operation.serverUrl} is unverified. ${operation.description}`.slice(0, 2000),
    parameters: [...operation.parameters],
    sourceRevision: operation.metadata.revision,
    documentDigest: operation.documentDigest,
  }));
  const recipe: LearnedApiRecipe = {
    schemaVersion: 1,
    id: recipeId,
    revision: 1,
    projectId: meta.projectId,
    ownerPrincipalId: meta.ownerPrincipalId,
    createdAt: isoNow(),
    updatedAt: isoNow(),
    trustLevel: 'local_private',
    declaredBrand: meta.declaredBrand,
    verifiedOrigin: null,
    sourceRefs: [{ kind: sourceKind, digest: sha256Hex(rawSource) }],
    operations,
    authScheme: 'none',
    limits: { maxOutputBytes: 131_072, timeoutMs: 15_000 },
    dataHandling: 'Public read only; responses are data, never instructions.',
    examples: [],
    aliases: sanitizeAliases(meta.aliases),
    functionTags: sanitizeTags(meta.functionTags),
  };
  return parseLearnedApiRecipe(recipe);
}

function sanitizeAliases(aliases: Record<string, string[]> | undefined): Record<string, string[]> {
  if (aliases === undefined) return {};
  if (!isRecord(aliases) || Object.keys(aliases).length > 16) fail('learned_invalid_aliases', 'Too many alias locales');
  const clean: Record<string, string[]> = {};
  for (const [locale, list] of Object.entries(aliases)) {
    if (!/^[a-z]{2}(-[A-Z]{2})?$/.test(locale) || !Array.isArray(list) || list.length > MAX_ALIASES_PER_LOCALE ||
        list.some(alias => typeof alias !== 'string' || !alias.trim() || alias.length > 80)) {
      fail('learned_invalid_aliases', `Invalid aliases for ${locale}`);
    }
    clean[locale] = [...list];
  }
  return clean;
}

function sanitizeTags(tags: string[] | undefined): string[] {
  if (tags === undefined) return [];
  if (!Array.isArray(tags) || tags.length > 8 || tags.some(tag => typeof tag !== 'string' || !/^[a-z][a-z0-9_]{1,40}$/.test(tag))) {
    fail('learned_invalid_tags', 'Function tags are lowercase function families (e.g. postal_lookup)');
  }
  return [...tags];
}

const LEARNED_LIMITS = { maxSteps: 1, maxCalls: 1, maxOutputTokens: 1024, timeoutMs: 15_000, maxOutputBytes: 131_072 };

function compileOperation(input: {
  recipeId: string; revision: number; serviceSlug: string; operationId: string;
  method: SupportedHttpMethod; path: string; serverUrl: string;
  summary: string; description: string; parameters: readonly ParameterDefinition[];
  sourceRevision: string; documentDigest: string;
}): CuratedOperation {
  const operationId = input.operationId.replace(/[^A-Za-z0-9_]/g, '_').slice(0, 64);
  if (!operationId) fail('learned_invalid_operation', 'Operation needs an identifier');
  const capabilityId = `api.learned_${input.serviceSlug}.${operationId}`;
  const schemaDigest = sha256Hex(canonicalStringify({
    serviceId: `learned_${input.serviceSlug}`,
    operationId,
    method: input.method,
    path: input.path,
    serverUrl: input.serverUrl,
    revision: input.sourceRevision,
    pagination: null,
    statusResult: null,
    parameters: input.parameters,
  }));
  const metadata: CuratedServiceMetadata = {
    serviceId: `learned_${input.serviceSlug}`,
    domain: 'learned',
    officialUrl: '',
    specUrl: '',
    revision: input.sourceRevision,
    codeLicense: 'unknown',
    dataLicense: 'unknown',
    commercialTerms: 'unknown',
    authentication: 'none',
    rateLimit: null,
    attribution: `Learned recipe ${input.recipeId} (unverified origin)`,
    consultedAt: isoNow(),
  };
  const capability = parseCapabilityDescriptor({
    schemaVersion: 1,
    id: capabilityId,
    createdAt: '2026-09-18T00:00:00.000Z',
    version: 1,
    titleKey: `cap_learned_${input.serviceSlug}_${operationId}_title`,
    descriptionKey: `cap_learned_${input.serviceSlug}_${operationId}_desc`,
    tags: ['api_instrument', `learned_${input.serviceSlug}`, 'learned', 'unverified_origin'],
    inputSchemaId: `workspace.learned_${input.serviceSlug}.${operationId}.input.v1`,
    outputSchemaId: `workspace.learned_${input.serviceSlug}.${operationId}.output.v1`,
    effect: 'read_external',
    dataDestination: { kind: 'public_source', id: `learned_${input.serviceSlug}` },
    availability: 'executable',
    supportLevel: 'experimental',
    requiredScopes: ['run:execute'],
    retryClass: 'read_only',
    limits: { ...LEARNED_LIMITS },
  });
  return {
    schemaVersion: 1,
    id: capabilityId,
    serviceId: `learned_${input.serviceSlug}`,
    operationId,
    method: input.method,
    path: input.path,
    serverUrl: input.serverUrl,
    summary: input.summary,
    description: input.description,
    parameters: [...input.parameters],
    schemaDigest,
    documentDigest: input.documentDigest,
    metadata,
    capability,
    learnedRecipe: { recipeId: input.recipeId, revision: input.revision },
  } as CuratedOperation;
}

/* ------------------------------------------------------------------ */
/* Trust policy, promotion and revocation                              */
/* ------------------------------------------------------------------ */

/** Where a recipe may execute. Team/community execution needs etapa 12 identity; global presets need review. */
export function canExecuteRecipe(
  recipe: LearnedApiRecipe,
  principalId: string,
  projectId: string,
): { executable: true } | { executable: false; code: string } {
  if (recipe.ownerPrincipalId !== principalId) return { executable: false, code: 'recipe_not_owned' };
  if (recipe.projectId !== projectId) return { executable: false, code: 'recipe_project_mismatch' };
  switch (recipe.trustLevel) {
    case 'local_private': return { executable: true };
    case 'verified_preset':
      if (recipe.review && recipe.verifiedOrigin) return { executable: true };
      return { executable: false, code: 'recipe_review_invalid' };
    case 'team_private': return { executable: false, code: 'recipe_trust_not_executable' };
    case 'community_candidate': return { executable: false, code: 'recipe_trust_not_executable' };
    case 'revoked_or_stale': return { executable: false, code: 'recipe_revoked_or_stale' };
  }
}

function assertReview(review: unknown): asserts review is NonNullable<LearnedApiRecipe['review']> {
  if (!isRecord(review) || typeof review.reviewer !== 'string' || !review.reviewer ||
      typeof review.acceptedAt !== 'string' || !Number.isFinite(Date.parse(review.acceptedAt))) {
    fail('learned_review_invalid', 'Review needs a reviewer and acceptance time');
  }
  const evidence = (review as Record<string, unknown>).evidence as Record<string, unknown> | undefined;
  if (!isRecord(evidence) || typeof evidence.officialOrigin !== 'string' || typeof evidence.license !== 'string' ||
      !evidence.license.trim() || typeof evidence.termsUrl !== 'string' || !/^https:\/\//.test(evidence.termsUrl) ||
      !Number.isSafeInteger(evidence.positiveFixtures) || (evidence.positiveFixtures as number) < 1 ||
      !Number.isSafeInteger(evidence.negativeFixtures) || (evidence.negativeFixtures as number) < 1) {
    fail('learned_review_invalid', 'Review needs official origin, license, terms and positive+negative fixtures');
  }
  checkOriginStatic(evidence.officialOrigin);
}

/**
 * Secret-free promotion package. Fails closed if secret-shaped or personal
 * data is found anywhere in the export surface (rule 8).
 */
export function buildPromotionPackage(recipe: LearnedApiRecipe): PromotionPackage {
  const parsed = parseLearnedApiRecipe(recipe);
  if (parsed.trustLevel === 'revoked_or_stale') fail('learned_revoked_or_stale', 'Revoked recipes are not exportable');
  const serialized = canonicalStringify({
    declaredBrand: parsed.declaredBrand,
    operations: parsed.operations,
    examples: parsed.examples,
    aliases: parsed.aliases,
  });
  const credential = findCredentialMaterial(serialized);
  if (credential) fail('learned_export_blocked', `Export surface contains credential material (${credential})`);
  if (/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/.test(serialized) || /\b\d{3}\.\d{3}\.\d{3}-\d{2}\b/.test(serialized)) {
    fail('learned_export_blocked', 'Export surface contains personal identifiers');
  }
  return {
    schemaVersion: 1,
    recipeId: parsed.id,
    revision: parsed.revision,
    declaredBrand: parsed.declaredBrand,
    verifiedOrigin: parsed.verifiedOrigin,
    origins: [...new Set(parsed.operations.map(operation => operation.serverUrl))],
    operations: parsed.operations.map(operation => ({
      operationId: operation.operationId,
      method: operation.method,
      path: operation.path,
      parameters: [...operation.parameters],
      schemaDigest: operation.schemaDigest,
    })),
    sourceRefs: [...parsed.sourceRefs],
    functionTags: [...parsed.functionTags],
    review: { required: true },
  };
}

/**
 * Review of a promotion package. `authority: 'maintainer'` promotes to
 * `verified_preset`; `authority: 'owner'` records the review as a private
 * approval only — content authored by the user never grants maintainer trust
 * (F08), so `verifiedOrigin` stays unverified. Requires the full evidence set;
 * never automatic, never a side effect of use. Does NOT touch the global
 * catalog — the preset stays executable per owner through the same path.
 */
export function acceptPromotionReview(
  recipe: LearnedApiRecipe,
  evidence: PromotionEvidence,
  reviewer: string,
  authority: 'maintainer' | 'owner',
  now = isoNow(),
): LearnedApiRecipe {
  const parsed = parseLearnedApiRecipe(recipe);
  if (parsed.trustLevel === 'revoked_or_stale') fail('learned_revoked_or_stale', 'Revoked recipes cannot be promoted');
  if (typeof reviewer !== 'string' || !reviewer.trim() || reviewer.length > 128) {
    fail('learned_review_invalid', 'Reviewer identity required');
  }
  assertReview({ reviewer, acceptedAt: now, evidence });
  const origins = new Set(parsed.operations.map(operation => operation.serverUrl));
  if (origins.size !== 1 || !origins.has(evidence.officialOrigin)) {
    fail('learned_review_invalid', 'Evidence origin must match the single recipe origin');
  }
  if (authority === 'owner') {
    const ownerApproved: LearnedApiRecipe = {
      ...parsed,
      revision: parsed.revision + 1,
      updatedAt: now,
      verifiedOrigin: null,
      review: { reviewer, acceptedAt: now, evidence },
    };
    return parseLearnedApiRecipe(ownerApproved);
  }
  const next: LearnedApiRecipe = {
    ...parsed,
    revision: parsed.revision + 1,
    updatedAt: now,
    trustLevel: 'verified_preset',
    verifiedOrigin: evidence.officialOrigin,
    review: { reviewer, acceptedAt: now, evidence },
  };
  return parseLearnedApiRecipe(next);
}

/** Revocation blocks new plans but preserves history (receipts stay readable). */
export function revokeRecipe(recipe: LearnedApiRecipe, reason: string, now = isoNow()): LearnedApiRecipe {
  const parsed = parseLearnedApiRecipe(recipe);
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 512) {
    fail('learned_revoke_invalid', 'Revocation needs a reason');
  }
  const next: LearnedApiRecipe = {
    ...parsed,
    revision: parsed.revision + 1,
    updatedAt: now,
    trustLevel: 'revoked_or_stale',
    revokeReason: reason,
  };
  return parseLearnedApiRecipe(next);
}

/* ------------------------------------------------------------------ */
/* Aliases, semantic proposal (TypeSafe plugs in here) and preview     */
/* ------------------------------------------------------------------ */

/** Deterministic alias/keyword matcher. A TypeSafe-backed proposer can replace it; validation stays in code. */
export type SemanticRecipeProposer = (
  phrase: string,
  candidates: readonly { recipe: LearnedApiRecipe; operationId: string }[],
) => { recipeId: string; operationId: string; confidence: number } | null;

export function matchRecipeByAlias(
  phrase: string,
  recipes: readonly LearnedApiRecipe[],
  locale = 'en',
  proposer?: SemanticRecipeProposer,
): { recipe: LearnedApiRecipe; operationId: string; confidence: number; source: 'alias' | 'semantic' } | null {
  if (typeof phrase !== 'string' || !phrase.trim() || phrase.length > 500) return null;
  const lowered = phrase.toLowerCase();
  let best: { recipe: LearnedApiRecipe; operationId: string; confidence: number } | null = null;
  for (const recipe of recipes) {
    if (recipe.trustLevel === 'revoked_or_stale') continue;
    const aliases = [...(recipe.aliases[locale] ?? []), ...(recipe.aliases.en ?? []), recipe.declaredBrand];
    for (const alias of aliases) {
      if (alias.toLowerCase() && lowered.includes(alias.toLowerCase())) {
        const confidence = Math.min(0.9, 0.5 + alias.length / 100);
        if (!best || confidence > best.confidence) {
          best = { recipe, operationId: recipe.operations[0]!.operationId, confidence };
        }
      }
    }
    for (const tag of recipe.functionTags) {
      if (lowered.includes(tag.replace(/_/g, ' '))) {
        if (!best || 0.4 > best.confidence) best = { recipe, operationId: recipe.operations[0]!.operationId, confidence: 0.4 };
      }
    }
  }
  if (best) return { ...best, source: 'alias' };
  if (proposer) {
    const candidates = recipes.flatMap(recipe =>
      recipe.trustLevel === 'revoked_or_stale' ? [] : recipe.operations.map(operation => ({ recipe, operationId: operation.operationId })),
    );
    try {
      const proposed = proposer(phrase, candidates);
      if (proposed) {
        const recipe = recipes.find(item => item.id === proposed.recipeId);
        if (recipe && recipe.operations.some(operation => operation.operationId === proposed.operationId)) {
          return { recipe, operationId: proposed.operationId, confidence: proposed.confidence, source: 'semantic' };
        }
      }
    } catch {
      return null;
    }
  }
  return null;
}

export interface LearnedPlanPreview {
  recipeId: string;
  revision: number;
  trustLevel: RecipeTrustLevel;
  declaredBrand: string;
  verifiedOrigin: string | null;
  unverifiedOrigin: boolean;
  operationId: string;
  method: SupportedHttpMethod;
  url: string;
  origin: string;
  fields: Record<string, string>;
  credential: { kind: 'none' } | { kind: 'oauth2-account-required'; providerHint?: string } | {kind:'bearer'} | {kind:'header-api-key';headerName:string};
  limits: { maxOutputBytes: number; timeoutMs: number };
  /** Reference tariffs never cover learned origins: unknown, never invented. */
  estimatedCost: null;
  expectedParameters: readonly { name: string; required: boolean; type: string }[];
}

/**
 * What the user reviews before approval: host, method, fields, credential,
 * limits. Pure (prepareApiCall performs no network).
 */
export function previewLearnedPlan(
  recipe: LearnedApiRecipe,
  operationId: string,
  parameters: Record<string, unknown>,
): LearnedPlanPreview {
  const parsed = parseLearnedApiRecipe(recipe);
  const operation = parsed.operations.find(item => item.operationId === operationId);
  if (!operation) fail('learned_unknown_operation', `Operation ${operationId} is not in recipe ${parsed.id}`);
  let prepared;
  try {
    prepared = prepareApiCall(operation!, parameters ?? {}, undefined);
  } catch (error) {
    const code = error instanceof Error ? error.message.split(':')[0]! : 'api_invalid_parameter';
    fail('learned_preview_invalid', `Parameters rejected: ${code}`);
  }
  return {
    recipeId: parsed.id,
    revision: parsed.revision,
    trustLevel: parsed.trustLevel,
    declaredBrand: parsed.declaredBrand,
    verifiedOrigin: parsed.verifiedOrigin,
    unverifiedOrigin: parsed.verifiedOrigin === null,
    operationId: operation!.operationId,
    method: operation!.method,
    url: prepared!.url,
    origin: prepared!.origin,
    fields: { ...prepared!.query },
    credential: parsed.authScheme === 'none'
      ? { kind: 'none' }
      : parsed.authScheme.kind==='oauth2-account'?{ kind: 'oauth2-account-required', ...(parsed.authScheme.providerHint ? { providerHint: parsed.authScheme.providerHint } : {}) }:parsed.authScheme,
    limits: { ...parsed.limits },
    estimatedCost: null,
    expectedParameters: operation!.parameters.map(parameter => ({ name: parameter.name, required: parameter.required, type: parameter.schema.type })),
  };
}
