export type MaterialType =
  | 'news'
  | 'press_release'
  | 'journal_article'
  | 'preprint'
  | 'correction'
  | 'retraction'
  | 'indicator'
  | 'event'
  | 'entity'
  | 'unknown';

export type RightScope =
  | 'obtain'
  | 'store'
  | 'display'
  | 'export'
  | 'model_input'
  | 'train';

export type PermissionValue = boolean | null | 'unknown';

export interface ContentRights {
  termsUrl?: string | null;
  verifiedAt?: string | null;
  holder?: string | null;
  attribution?: string | null;
  permissions?: Record<RightScope, PermissionValue> | Record<string, PermissionValue>;
}

export interface RecordProvenance {
  sourceId: string;
  sourceRecordId?: string | null;
  canonicalUrl?: string | null;
  identifiers?: Record<string, string>;
  retrievedAt: string;
  sourcePublishedAt?: string | null;
  query?: string | null;
  executionId?: string | null;
  adapterVersion?: string | null;
  rawArtifactRef?: string | null;
}

export interface RecordRelation {
  targetId: string;
  type: 'cites' | 'corrects' | 'retracts' | 'repercusses' | 'duplicates' | 'version_of';
  method: 'exact_id' | 'publisher_link' | 'manual' | 'candidate_match';
  evidence?: string | null;
}

export interface DataRecord {
  id: string;
  materialType: MaterialType;
  materialTypeSource?: string | null;
  title?: string | null;
  summary?: string | null;
  authors?: string[];
  publisher?: string | null;
  language?: string | null;
  provenance: RecordProvenance;
  rights?: ContentRights | null;
  relations?: RecordRelation[];
  fields?: Record<string, any>;
}

export interface Completeness {
  requested: number;
  obtained: number;
  truncationReason?: string | null;
  unavailableSources?: string[];
  partial: boolean;
}

export interface Units {
  timezone?: string | null;
  currency?: string | null;
  measureSystem?: string | null;
}

export interface DataEnvelopeWarning {
  code: string;
  message: string;
  sourceId?: string;
}

export interface DataEnvelope {
  schema: 'uptokey.data-envelope.v2';
  version: '2.0.0';
  records: DataRecord[];
  completeness: Completeness;
  units?: Units | null;
  warnings?: DataEnvelopeWarning[];
  createdAt: string;
}

export declare const DATA_ENVELOPE_SCHEMA: 'uptokey.data-envelope.v2';
export declare const DATA_ENVELOPE_VERSION: '2.0.0';

export declare function createEnvelope(overrides?: Partial<DataEnvelope>): DataEnvelope;
export declare function createRecord(data: Partial<DataRecord> & { provenance: RecordProvenance }): DataRecord;
export declare function validateEnvelope(obj: any): string[];
export declare function validateDataEnvelope(obj: any): void;
export declare function isDataEnvelope(obj: any): obj is DataEnvelope;
export declare function isDataRecord(obj: any): obj is DataRecord;
