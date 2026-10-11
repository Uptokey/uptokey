import type { CapabilityDescriptor, ExecutionLimits } from '@uptokey/sync-contract/workflow';
import type { CuratedServiceMetadata } from './specs/index.ts';

/** GET remains the only method the OpenAPI importer admits; POST exists for governed productivity writes. */
export type SupportedHttpMethod = 'GET' | 'POST';
export type ParameterScalar = string | number | boolean | null;

export interface ParameterSchema {
  type: 'string' | 'number' | 'integer' | 'boolean' | 'array';
  items?: ParameterSchema;
  nullable?: boolean;
  enum?: readonly ParameterScalar[];
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  exclusiveMaximum?: number;
  multipleOf?: number;
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  format?: string;
  minItems?: number;
  maxItems?: number;
  uniqueItems?: boolean;
  default?: ParameterScalar;
  const?: ParameterScalar;
}

/** Only catalogued cursor pagination is executable; ordinary arrays are not pages. */
export interface CursorPagination {
  cursorParameter: string;
  nextCursorPath: readonly string[];
  initialCursor?: string | number;
}

export interface ParameterDefinition {
  name: string;
  in: 'query' | 'path';
  required: boolean;
  description: string;
  schema: ParameterSchema;
}

export interface CuratedOperation {
  schemaVersion: 1;
  id: string; // capability ID e.g. api.open_meteo.get_weather_forecast
  serviceId: string;
  operationId: string;
  method: SupportedHttpMethod;
  path: string;
  serverUrl: string;
  summary: string;
  description: string;
  parameters: readonly ParameterDefinition[];
  schemaDigest: string;
  documentDigest: string;
  metadata: CuratedServiceMetadata;
  capability: CapabilityDescriptor;
  pagination?: CursorPagination;
  statusResult?: Readonly<Record<number, { isPublicHoliday: boolean }>>;
  /** Absent means JSON. 'feed' admits RSS/Atom bytes, parsed only after the bounded read. */
  responseFormat?: 'feed';
  /** Material type declared by the catalog for feed records; never inferred from titles. */
  feedMaterialType?: 'news' | 'press_release' | 'preprint' | 'journal_article';
  /**
   * Present only on operations compiled from a user-learned recipe (stage 18).
   * Never set by the curated importer; never part of the global catalog.
   * The dispatcher admits the operation's own origin for this recipe only.
   */
  learnedRecipe?: { recipeId: string; revision: number };
}

export interface PreparedApiCall {
  schemaVersion: 1;
  operationId: string;
  capabilityId: string;
  serviceId: string;
  method: SupportedHttpMethod;
  url: string;
  origin: string;
  path: string;
  query: Record<string, string>;
  schemaDigest: string;
  callDigest: string;
  limits: ExecutionLimits;
}

export type GovernedReadOutcome =
  | {
      kind: 'completed';
      data: unknown;
      origin: string;
      operation: string;
      retrievedAt: string;
      byteLength: number;
      cached?: boolean;
    }
  | {
      kind: 'failed';
      code: string;
      sent: 'yes' | 'no' | 'unknown';
      httpStatus?: number;
      error?: string;
    };

export interface SemanticProposal {
  matched: boolean;
  operationId: string | null;
  confidence?: number;
  source: 'model' | 'local_heuristic' | 'fixture' | 'manual' | 'typesafe_jev';
  reason: 'matched' | 'no_match' | 'low_confidence' | 'disabled' | 'admission_required' | 'error' | 'hostile_input';
  proposedArguments: Record<string, unknown>;
  missingArguments: string[];
  needsUserCompletion: boolean;
  candidateOperations?: CuratedOperation[];
}
