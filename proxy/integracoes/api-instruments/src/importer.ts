import { createHash } from 'node:crypto';
import _Ajv from 'ajv';
import _addFormats from 'ajv-formats';
import {
  parseCapabilityDescriptor,
  type CapabilityDescriptor,
  type ExecutionLimits,
} from '@uptokey/sync-contract/workflow';
import type {
  CuratedOperation,
  ParameterDefinition,
  ParameterSchema,
  SupportedHttpMethod,
  CursorPagination,
} from './types.ts';
import type { CuratedServiceMetadata } from './specs/index.ts';

const AjvClass: any = (_Ajv as any).default ?? _Ajv;
const ajvInstance = new AjvClass({ allErrors: true, strict: true, coerceTypes: true, validateFormats: true });
const addFormats = (_addFormats as any).default ?? _addFormats;
addFormats(ajvInstance, { mode: 'full', formats: ['date', 'date-time', 'uuid', 'email', 'uri'] });

export const IMPORTED_SCHEMA_DIALECT = 'OpenAPI 3.0/3.1 scalar and flat-array subset; normalized to JSON Schema draft-07';

export class OpenApiImportError extends Error {
  readonly code: string;
  readonly details?: unknown;
  constructor(code: string, message: string, details?: unknown) {
    super(`${code}: ${message}`);
    this.name = 'OpenApiImportError';
    this.code = code;
    this.details = details;
  }
}

/**
 * Validates a parameter value against its ParameterSchema using Ajv (C06).
 */
export function validateParameterWithAjv(
  paramName: string,
  schema: ParameterSchema,
  value: unknown
): unknown {
  // Validate in an object so Ajv coercion changes the returned value as well.
  // Never coerce null/empty input to zero/false, or mutate the caller's arrays.
  if ((value === null && !schema.nullable) || (value === '' && schema.type !== 'string')) {
    throw new OpenApiImportError('openapi_parameter_validation_failed', `Parameter '${paramName}' has no valid value`);
  }
  if (Array.isArray(value) && schema.items && value.some(item => (item === null && !schema.items!.nullable) || (item === '' && schema.items!.type !== 'string'))) throw new OpenApiImportError('openapi_parameter_validation_failed', `Parameter '${paramName}' contains an invalid empty item`);
  const wrapped = { value: structuredClone(value) };
  const validate = ajvInstance.compile({ type: 'object', properties: { value: schema }, required: ['value'], additionalProperties: false });
  const valid = validate(wrapped);
  if (!valid) {
    const firstErr = validate.errors?.[0];
    throw new OpenApiImportError(
      'openapi_parameter_validation_failed',
      `Parameter '${paramName}' failed schema validation: ${firstErr?.message || 'invalid parameter value'}`,
      validate.errors
    );
  }
  return wrapped.value;
}

const DEFAULT_API_LIMITS: ExecutionLimits = {
  maxSteps: 1,
  maxCalls: 1,
  maxOutputTokens: 4096,
  timeoutMs: 15_000,
  maxOutputBytes: 131_072, // 128 KB
};

function computeSha256(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Canonical deterministic stringify for JSON */
export function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(
      k =>
        `${JSON.stringify(k)}:${canonicalStringify(
          (value as Record<string, unknown>)[k]
        )}`
    )
    .join(',')}}`;
}

/** Recursively check for illegal remote $ref */
function checkForForbiddenRefs(obj: unknown, path = '$'): void {
  if (!obj || typeof obj !== 'object') return;
  if (Array.isArray(obj)) {
    obj.forEach((item, index) => checkForForbiddenRefs(item, `${path}[${index}]`));
    return;
  }
  for (const [key, val] of Object.entries(obj as Record<string, unknown>)) {
    if (key === '$ref') {
      if (typeof val === 'string') {
        if (
          val.startsWith('http://') ||
          val.startsWith('https://') ||
          val.startsWith('file://') ||
          !val.startsWith('#/')
        ) {
          throw new OpenApiImportError(
            'openapi_forbidden_remote_ref',
            `Remote or external $ref references are prohibited: ${val}`,
            { path, ref: val }
          );
        }
      }
    } else {
      checkForForbiddenRefs(val, `${path}.${key}`);
    }
  }
}

/** Resolves a local JSON pointer / $ref within the spec document */
export function resolveLocalRef(doc: Record<string, unknown>, ref: string, visited = new Set<string>()): unknown {
  if (typeof ref !== 'string' || !ref.startsWith('#/')) {
    throw new OpenApiImportError('openapi_forbidden_remote_ref', `Remote or invalid $ref: ${ref}`);
  }
  if (visited.has(ref)) {
    throw new OpenApiImportError('openapi_cyclic_ref', `Cyclic local $ref detected: ${ref}`);
  }
  visited.add(ref);
  const segments = ref.slice(2).split('/');
  let current: any = doc;
  for (const seg of segments) {
    const key = seg.replace(/~1/g, '/').replace(/~0/g, '~');
    if (!current || typeof current !== 'object' || !(key in current)) {
      throw new OpenApiImportError('openapi_unresolved_local_ref', `Could not resolve local $ref: ${ref}`);
    }
    current = current[key];
  }
  // Check if the resolved object itself is a $ref
  if (current && typeof current === 'object' && typeof current.$ref === 'string') {
    return resolveLocalRef(doc, current.$ref, visited);
  }
  return current;
}

const schemaKeywords = new Set(['type', 'items', 'nullable', 'enum', 'const', 'default', 'minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength', 'pattern', 'format', 'minItems', 'maxItems', 'uniqueItems']);
const schemaAnnotations = new Set(['title', 'description', 'example', 'examples', 'deprecated']);

/** Fail closed rather than silently erase validation keywords from an imported schema. */
function importParameterSchema(doc: Record<string, unknown>, value: unknown, name: string, oas30: boolean, visiting = new Set<object>()): ParameterSchema {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new OpenApiImportError('openapi_invalid_schema', `Parameter ${name} requires an explicit schema object`);
  }
  let raw = value as Record<string, unknown>;
  if (raw.$ref !== undefined) {
    if (typeof raw.$ref !== 'string' || Object.keys(raw).some(key => key !== '$ref' && !schemaAnnotations.has(key))) {
      throw new OpenApiImportError('openapi_unsupported_ref_siblings', `Parameter ${name} has unsupported $ref siblings`);
    }
    raw = resolveLocalRef(doc, raw.$ref) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new OpenApiImportError('openapi_invalid_schema', `Invalid schema reference for ${name}`);
  }
  if (visiting.has(raw)) throw new OpenApiImportError('openapi_cyclic_ref', `Cyclic schema in ${name}`);
  const nextVisiting = new Set(visiting).add(raw);
  for (const key of Object.keys(raw)) {
    if (['anyOf', 'oneOf', 'allOf'].includes(key)) throw new OpenApiImportError('openapi_unsupported_polymorphism', `Unsupported ${key} in ${name}`);
    if (!schemaKeywords.has(key) && !schemaAnnotations.has(key) && !key.startsWith('x-')) {
      throw new OpenApiImportError('openapi_unsupported_schema_keyword', `Unsupported schema keyword ${key} in ${name}`);
    }
  }
  let type = raw.type;
  let nullable = raw.nullable === true;
  if (!oas30 && Array.isArray(type) && type.length === 2 && type.includes('null')) {
    type = type.find(item => item !== 'null');
    nullable = true;
  }
  if (typeof type !== 'string' || !['string', 'number', 'integer', 'boolean', 'array'].includes(type)) {
    throw new OpenApiImportError('openapi_unsupported_parameter_type', `Unsupported or missing type in ${name}`);
  }
  if (raw.nullable !== undefined && typeof raw.nullable !== 'boolean') throw new OpenApiImportError('openapi_invalid_schema', `Invalid nullable in ${name}`);
  const schema = Object.fromEntries(Object.entries(raw).filter(([key]) => schemaKeywords.has(key))) as unknown as ParameterSchema;
  schema.type = type as ParameterSchema['type'];
  if (nullable) schema.nullable = true;
  if (schema.enum && (!Array.isArray(schema.enum) || schema.enum.some(item => item !== null && !['string', 'number', 'boolean'].includes(typeof item)))) {
    throw new OpenApiImportError('openapi_invalid_schema', `Only scalar enums are supported in ${name}`);
  }
  if (schema.format !== undefined && !['date', 'date-time', 'uuid', 'email', 'uri'].includes(schema.format)) {
    throw new OpenApiImportError('openapi_unsupported_format', `Unsupported format ${schema.format}`);
  }
  if (oas30) {
    for (const [exclusive, bound] of [['exclusiveMinimum', 'minimum'], ['exclusiveMaximum', 'maximum']] as const) {
      if (raw[exclusive] === undefined) continue;
      if (typeof raw[exclusive] !== 'boolean' || (raw[exclusive] && typeof raw[bound] !== 'number')) {
        throw new OpenApiImportError('openapi_invalid_schema', `OpenAPI 3.0 requires boolean ${exclusive} with ${bound}`);
      }
      delete schema[exclusive];
      if (raw[exclusive]) { schema[exclusive] = raw[bound] as number; delete schema[bound]; }
    }
  }
  if (type === 'array') {
    schema.items = importParameterSchema(doc, raw.items, `${name}[]`, oas30, nextVisiting);
    if (schema.items.type === 'array') throw new OpenApiImportError('openapi_unsupported_array_item_type', `Nested arrays are not supported in ${name}`);
  }
  try {
    ajvInstance.compile(schema);
  } catch (err) {
    throw new OpenApiImportError('openapi_invalid_schema', `Invalid schema for ${name}: ${err instanceof Error ? err.message : String(err)}`);
  }
  return schema;
}

/**
 * Parses and imports an OpenAPI 3.0/3.1 document from static data into CuratedOperation list.
 * Pure function: zero network, zero secrets, zero inferences.
 */
export function importOpenApiSpec(
  specData: unknown,
  options?: { allowHttpServerForTesting?: boolean }
): {
  documentDigest: string;
  operations: CuratedOperation[];
} {
  if (!specData || typeof specData !== 'object' || Array.isArray(specData)) {
    throw new OpenApiImportError(
      'openapi_invalid_document',
      'OpenAPI specification must be a non-null object'
    );
  }

  const spec = specData as Record<string, unknown>;

  // Check version
  const openapiVer = String(spec.openapi || '');
  if (!/^3\.[01]\.\d+$/.test(openapiVer)) {
    throw new OpenApiImportError(
      'openapi_unsupported_version',
      `Unsupported OpenAPI version: ${openapiVer}. Only 3.0.x and 3.1.x are admitted.`
    );
  }
  if (spec.jsonSchemaDialect !== undefined && spec.jsonSchemaDialect !== 'https://spec.openapis.org/oas/3.1/dialect/base') {
    throw new OpenApiImportError('openapi_unsupported_dialect', 'Only the declared primitive/flat-array subset of the default OpenAPI dialect is admitted');
  }

  // Check forbidden external refs
  checkForForbiddenRefs(spec);

  // Compute deterministic digest of document
  const canonicalDoc = canonicalStringify(spec);
  const documentDigest = computeSha256(canonicalDoc);

  // Info and Metadata
  const info = spec.info as Record<string, unknown> | undefined;
  if (!info || typeof info.title !== 'string') {
    throw new OpenApiImportError(
      'openapi_missing_info',
      'OpenAPI specification requires info.title'
    );
  }

  const rawMetadata = (info['x-uptokey-metadata'] || {}) as Record<string, unknown>;
  const serviceId = String(rawMetadata.serviceId || 'unknown_service').replace(/[^a-zA-Z0-9_]/g, '_');
  const metadata: CuratedServiceMetadata = {
    serviceId,
    domain: String(rawMetadata.domain || 'general'),
    officialUrl: String(rawMetadata.officialUrl || ''),
    specUrl: String(rawMetadata.specUrl || ''),
    revision: String(rawMetadata.revision || 'unknown'),
    codeLicense: String(rawMetadata.codeLicense || 'unknown'),
    dataLicense: String(rawMetadata.dataLicense || 'unknown'),
    commercialTerms: String(rawMetadata.commercialTerms || 'unknown'),
    authentication: String(rawMetadata.authentication || 'none'),
    rateLimit: rawMetadata.rateLimit !== undefined && rawMetadata.rateLimit !== null ? String(rawMetadata.rateLimit) : null,
    attribution: String(rawMetadata.attribution || 'unknown'),
    consultedAt: String(rawMetadata.consultedAt || new Date().toISOString()),
    ...(rawMetadata.contentRights !== undefined ? { contentRights: importContentRights(rawMetadata.contentRights) } : {}),
  };

  // Servers
  const servers = Array.isArray(spec.servers) ? spec.servers : [];
  if (servers.length === 0 || !servers[0] || typeof servers[0].url !== 'string') {
    throw new OpenApiImportError(
      'openapi_missing_servers',
      'OpenAPI specification must declare at least one server with a valid URL'
    );
  }
  const rawServerUrl = servers[0].url.trim();
  let serverUrl: string;
  try {
    const parsedUrl = new URL(rawServerUrl);
    if (parsedUrl.protocol !== 'https:' && !(options?.allowHttpServerForTesting && parsedUrl.protocol === 'http:')) {
      throw new OpenApiImportError(
        'openapi_unadmitted_server_origin',
        `Server URL must use HTTPS: ${rawServerUrl}`
      );
    }
    if (parsedUrl.username || parsedUrl.password || parsedUrl.search || parsedUrl.hash || (parsedUrl.pathname !== '/' && parsedUrl.pathname !== '')) {
      throw new OpenApiImportError('openapi_unsupported_server_url', 'Server must be an origin; put its base path in operation paths');
    }
    // Normalized origin without trailing slash
    serverUrl = parsedUrl.origin;
  } catch (err) {
    if (err instanceof OpenApiImportError) throw err;
    throw new OpenApiImportError(
      'openapi_invalid_server_url',
      `Server URL is malformed: ${rawServerUrl}`
    );
  }

  // Paths & Operations
  const paths = spec.paths as Record<string, unknown> | undefined;
  if (!paths || typeof paths !== 'object') {
    throw new OpenApiImportError(
      'openapi_missing_paths',
      'OpenAPI specification must declare a paths object'
    );
  }

  const operations: CuratedOperation[] = [];

  for (const [pathStr, pathItem] of Object.entries(paths)) {
    if (!pathStr.startsWith('/') || pathStr.startsWith('//') || /[?#\\]/.test(pathStr) || pathStr.split('/').some(part => part === '.' || part === '..')) {
      throw new OpenApiImportError(
        'openapi_invalid_path',
        `Path must begin with slash: ${pathStr}`
      );
    }
    if (!pathItem || typeof pathItem !== 'object' || Array.isArray(pathItem)) {
      continue;
    }

    for (const [methodKey, opItem] of Object.entries(pathItem as Record<string, unknown>)) {
      if (['summary', 'description', 'parameters'].includes(methodKey) || methodKey.startsWith('x-')) continue;
      const upperMethod = methodKey.toUpperCase();

      // Only GET is supported for safe external read instruments
      if (upperMethod !== 'GET') {
        throw new OpenApiImportError(
          'openapi_unsupported_http_method',
          `Method ${upperMethod} on ${pathStr} is not permitted. Only GET is admitted for read-only instruments.`
        );
      }

      if (!opItem || typeof opItem !== 'object' || Array.isArray(opItem)) {
        continue;
      }

      const operationObj = opItem as Record<string, unknown>;
      const operationId = String(operationObj.operationId || '').trim();
      if (!operationId) {
        throw new OpenApiImportError(
          'openapi_missing_operation_id',
          `Operation at ${upperMethod} ${pathStr} must define a unique operationId`
        );
      }
      if (operations.some(operation => operation.operationId === operationId)) throw new OpenApiImportError('openapi_duplicate_operation_id', `Duplicate operationId ${operationId}`);
      if (operationObj.servers || operationObj.requestBody || operationObj.security) throw new OpenApiImportError('openapi_unsupported_operation_feature', `Operation ${operationId} requires an unsupported server/body/authentication contract`);

      // Check for unadmitted features
      if (operationObj.callbacks) {
        throw new OpenApiImportError(
          'openapi_unsupported_callbacks',
          `Operation ${operationId} declares callbacks which are prohibited in pure read instruments`
        );
      }


      // Parse parameters
      const parameters: ParameterDefinition[] = [];
      const inherited = (pathItem as Record<string, unknown>).parameters;
      const resolveParameter = (parameter: any): any => parameter?.$ref ? resolveLocalRef(spec, parameter.$ref) : parameter;
      const own = (Array.isArray(operationObj.parameters) ? operationObj.parameters : []).map(resolveParameter);
      const rawParams = [...(Array.isArray(inherited) ? inherited.map(resolveParameter) : []).filter(parameter => !own.some(item => item?.name === parameter?.name && item?.in === parameter?.in)), ...own];

      for (let param of rawParams) {
        if (!param || typeof param !== 'object') continue;
        let p = param as Record<string, unknown>;

        // Resolve local parameter $ref if present
        if (typeof p.$ref === 'string') {
          p = resolveLocalRef(spec, p.$ref) as Record<string, unknown>;
        }

        const pName = String(p.name || '').trim();
        const pIn = String(p.in || '').trim();

        if (!['query', 'path'].includes(pIn)) {
          throw new OpenApiImportError(
            'openapi_unsupported_parameter_location',
            `Parameter ${pName} in ${pIn} is not supported. Only query and path parameters are admitted.`
          );
        }

        if (pIn === 'path' && p.required !== true) throw new OpenApiImportError('openapi_invalid_path_parameter', `Path parameter ${pName} must be required`);
        const required = pIn === 'path' ? true : Boolean(p.required);
        if (p.content || p.allowReserved === true || p.allowEmptyValue === true || (p.style !== undefined && p.style !== (pIn === 'query' ? 'form' : 'simple')) || p.explode === true) {
          throw new OpenApiImportError('openapi_unsupported_parameter_serialization', 'Only scalar or comma-separated flat-array parameters are supported');
        }
        const paramSchema = importParameterSchema(spec, p.schema, pName, openapiVer.startsWith('3.0'));
        if (paramSchema.type === 'array' && pIn === 'query' && p.explode !== false) throw new OpenApiImportError('openapi_unsupported_parameter_serialization', 'Query arrays must explicitly declare explode:false for comma-separated serialization');
        if (!pName || parameters.some(parameter => parameter.name === pName)) throw new OpenApiImportError('openapi_duplicate_parameter', 'Parameter names must be nonempty and unique');

        parameters.push({
          name: pName,
          in: pIn as 'query' | 'path',
          required,
          description: String(p.description || ''),
          schema: paramSchema,
        });
      }

      const pathNames = [...pathStr.matchAll(/\{([^{}]+)\}/g)].map(match => match[1]);
      if (pathNames.some(name => !parameters.some(parameter => parameter.in === 'path' && parameter.name === name)) || parameters.some(parameter => parameter.in === 'path' && !pathNames.includes(parameter.name))) {
        throw new OpenApiImportError('openapi_invalid_path_parameter', `Path placeholders and parameters differ for ${operationId}`);
      }
      let pagination: CursorPagination | undefined;
      const rawPagination = operationObj['x-uptokey-pagination'];
      if (rawPagination !== undefined) {
        const value = rawPagination as CursorPagination;
        const cursor = parameters.find(parameter => parameter.name === value?.cursorParameter && parameter.in === 'query');
        if (!value || typeof value !== 'object' || !cursor || !['string', 'integer', 'number'].includes(cursor.schema.type) || !Array.isArray(value.nextCursorPath) || value.nextCursorPath.length === 0 || value.nextCursorPath.some(part => typeof part !== 'string' || !part || ['__proto__', 'prototype', 'constructor'].includes(part)) || (value.initialCursor !== undefined && typeof value.initialCursor !== 'string' && typeof value.initialCursor !== 'number')) {
          throw new OpenApiImportError('openapi_invalid_pagination', `Pagination requires a catalogued cursor parameter and explicit next-cursor path`);
        }
        if (value.initialCursor !== undefined) validateParameterWithAjv(cursor.name, cursor.schema, value.initialCursor);
        pagination = { cursorParameter: value.cursorParameter, nextCursorPath: [...value.nextCursorPath], ...(value.initialCursor !== undefined ? { initialCursor: value.initialCursor } : {}) };
      }

      let statusResult: CuratedOperation['statusResult'];
      const rawStatusResult = operationObj['x-uptokey-status-result'];
      if (rawStatusResult !== undefined) {
        const map = rawStatusResult as Record<string, { isPublicHoliday: boolean }>;
        if (!map || typeof map !== 'object' || Array.isArray(map) || Object.keys(map).length !== 2 || map['200']?.isPublicHoliday !== true || map['204']?.isPublicHoliday !== false || Object.values(map).some(value => !value || Object.keys(value).length !== 1)) {
          throw new OpenApiImportError('openapi_invalid_status_result', 'Only the explicit holiday status contract 200=true/204=false is supported');
        }
        statusResult = structuredClone(map);
      }

      const rawFormat = operationObj['x-uptokey-response-format'];
      if (rawFormat !== undefined && rawFormat !== 'feed') throw new OpenApiImportError('openapi_invalid_response_format', 'Only JSON (default) or the declared feed format are admitted');
      const rawMaterial = operationObj['x-uptokey-feed-material-type'];
      if ((rawFormat === 'feed') !== (rawMaterial !== undefined) || (rawMaterial !== undefined && !['news', 'press_release', 'preprint', 'journal_article'].includes(rawMaterial as string))) {
        throw new OpenApiImportError('openapi_invalid_response_format', 'A feed operation must declare exactly one catalogued material type');
      }
      const feed = rawFormat === 'feed' ? { responseFormat: 'feed' as const, feedMaterialType: rawMaterial as NonNullable<CuratedOperation['feedMaterialType']> } : null;

      // Compute stable schema digest for this operation. Feed fields enter only when present,
      // so digests of previously admitted JSON operations remain byte-identical.
      const opSchemaCanonical = canonicalStringify({
        ...(feed ?? {}),
        serviceId,
        operationId,
        method: upperMethod,
        path: pathStr,
        serverUrl,
        revision: metadata.revision,
        pagination: pagination ?? null,
        statusResult: statusResult ?? null,
        parameters,
      });
      const schemaDigest = computeSha256(opSchemaCanonical);

      // Stable capability ID derived from service and operation
      const capabilityId = `api.${serviceId}.${operationId}`;

      // Construct canonical CapabilityDescriptor
      const rawDescriptor = {
        schemaVersion: 1 as const,
        id: capabilityId,
        createdAt: '2026-09-17T00:00:00.000Z',
        version: 1,
        titleKey: `cap_${serviceId}_${operationId}_title`,
        descriptionKey: `cap_${serviceId}_${operationId}_desc`,
        tags: ['api_instrument', serviceId, metadata.domain],
        inputSchemaId: `workspace.${serviceId}.${operationId}.input.v1`,
        outputSchemaId: `workspace.${serviceId}.${operationId}.output.v1`,
        effect: 'read_external' as const,
        dataDestination: {
          kind: 'public_source' as const,
          id: serviceId,
        },
        availability: 'executable' as const,
        supportLevel: 'integrated' as const,
        requiredScopes: ['run:execute' as const],
        retryClass: 'read_only' as const,
        limits: { ...DEFAULT_API_LIMITS },
      };

      // Strict validation through canonical W0 parser
      const capability = parseCapabilityDescriptor(rawDescriptor);

      operations.push({
        schemaVersion: 1,
        id: capabilityId,
        serviceId,
        operationId,
        method: upperMethod as SupportedHttpMethod,
        path: pathStr,
        serverUrl,
        summary: String(operationObj.summary || operationId),
        description: String(operationObj.description || ''),
        parameters,
        schemaDigest,
        documentDigest,
        metadata,
        capability,
        ...(pagination ? { pagination } : {}),
        ...(statusResult ? { statusResult } : {}),
        ...(feed ?? {}),
      });
    }
  }

  if (operations.length === 0) {
    throw new OpenApiImportError(
      'openapi_no_valid_operations',
      'No valid GET operations were discovered in specification'
    );
  }

  return {
    documentDigest,
    operations,
  };
}

const RIGHT_SCOPES = ['obtain', 'store', 'display', 'export', 'model_input', 'train'] as const;
/** Declared rights must name every scope; anything not verified is written as 'unknown'. */
function importContentRights(raw: unknown): NonNullable<CuratedServiceMetadata['contentRights']> {
  const value = raw as Record<string, any>;
  const permissions = value?.permissions as Record<string, unknown> | undefined;
  if (!value || typeof value !== 'object' || Array.isArray(value) || typeof value.termsUrl !== 'string' || !/^https:\/\//.test(value.termsUrl) ||
    typeof value.verifiedAt !== 'string' || !Number.isFinite(Date.parse(value.verifiedAt)) || !permissions || typeof permissions !== 'object' ||
    Object.keys(permissions).sort().join(',') !== [...RIGHT_SCOPES].sort().join(',') ||
    Object.values(permissions).some(item => item !== true && item !== false && item !== 'unknown')) {
    throw new OpenApiImportError('openapi_invalid_content_rights', 'Content rights require terms, verification time and all six scopes');
  }
  return { termsUrl: value.termsUrl, verifiedAt: value.verifiedAt, permissions: Object.fromEntries(RIGHT_SCOPES.map(scope => [scope, permissions[scope]])) as any };
}

export const importCuratedService = importOpenApiSpec;
