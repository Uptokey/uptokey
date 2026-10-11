export interface InstrumentProfile {
  capabilityId: string;
  capabilityVersion: string;
  catalogRevision: string;
  displayName: string;
  description: string;
  groupIds: string[];
  taskTags: string[];
  locales: string[];
  coverage: {
    entities: string[];
    regions: string[];
    temporalRange?: string | null;
    actions: string[];
    destinations?: string[];
  };
  authMode: 'anonymous' | 'user_key' | 'oauth' | 'local_service' | 'unknown';
  accessEvidence: {
    officialUrl: string;
    checkedAt: string;
    versionOrPlan?: string | null;
    region?: string | null;
    productionAllowed?: boolean | null;
    commercialAllowed?: boolean | null;
    status: 'verified' | 'unknown' | 'restricted';
  };
  rights: {
    metadataAllowed?: boolean | null;
    summaryAllowed?: boolean | null;
    fullTextAllowed?: boolean | null;
    localProcessingAllowed?: boolean | null;
    cacheAllowed?: boolean | null;
    redistributionAllowed?: boolean | null;
    modelInputAllowed?: boolean | null;
    trainingAllowed?: boolean | null;
  };
  freshness?: {
    observedAt: string;
    publishedAt?: string;
    validUntil?: string;
  } | null;
  quotaEvidence?: {
    unit: 'request' | 'credit' | 'token' | 'byte';
    window: 'day' | 'month' | 'minute' | 'second';
    declared?: number | null;
    observed?: number | null;
    value?: number | null;
    scope?: 'account' | 'ip' | 'key' | null;
  } | null;
  connectionState: 'catalogado' | 'candidato' | 'experimental' | 'verificado' | 'indisponivel' | 'cataloged' | 'candidate' | 'verified' | 'unavailable' | 'unknown';
  outputSchemaRef?: string | null;
  provenancePolicy?: string | null;
  termsRevision?: string | null;
}

export interface IntentProposal {
  requestId?: string;
  projectRevision?: string;
  catalogRevision?: string;
  candidateCapabilityRefs?: string[];
  argumentsCandidate?: Record<string, any>;
  missingFields?: string[];
  taskTags?: string[];
  locale?: string;
  requiredActions?: string[];
  destination?: string;
  source?: 'manual' | 'rules' | 'model';
  evidenceRefs?: string[];
  uncertainty?: string;
}

export declare function createInstrumentProfile(data: Partial<InstrumentProfile> & { capabilityId: string; displayName: string }): InstrumentProfile;
export declare function validateInstrumentProfile(obj: any): string[];
export declare function isInstrumentProfile(obj: any): obj is InstrumentProfile;
export declare function rankInstruments(profiles: InstrumentProfile[], intent?: Partial<IntentProposal>, userContext?: any, healthSnapshot?: any[]): InstrumentProfile[];
export declare function rankCandidates(candidates: InstrumentProfile[], intent?: Partial<IntentProposal>, userContext?: any, healthSnapshots?: any[]): InstrumentProfile[];
