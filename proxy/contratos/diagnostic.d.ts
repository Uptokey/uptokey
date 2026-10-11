/** E2-20 W0 contract — TypeScript shapes (published additive; default OFF). */

export declare const DIAGNOSTIC_SCHEMA_VERSION: 1;
export declare const DIAGNOSTIC_PACKAGE_ID: "E2-20";
export declare const DIAGNOSTIC_CONTRACT_STATUS: "published_additive";

export declare const DIAGNOSTIC_LIMITS: {
  readonly maxSessionTtlMs: number;
  readonly maxOrigins: number;
  readonly maxConnections: number;
  readonly maxBodyBytes: number;
  readonly maxTotalBytes: number;
  readonly maxRetentionHours: number;
  readonly maxAliasMapEntries: number;
  readonly maxExportCursor: number;
};

export declare const DIAGNOSTIC_ERROR_CODES: Readonly<Record<string, string>>; // includes uncertain_state
export declare const DIAGNOSTIC_COLLECT_POLICIES: readonly ["off", "redacted"];
export declare const DIAGNOSTIC_MODES: readonly ["explicit", "reverse"];
export declare const DIAGNOSTIC_SESSION_STATES: readonly string[];
export declare const DIAGNOSTIC_OPERATIONS: readonly string[];

export type DiagnosticCollectPolicy = "off" | "redacted";
export type DiagnosticMode = "explicit" | "reverse";
export type DiagnosticSessionState =
  | "idle"
  | "active"
  | "stopping"
  | "stopped"
  | "needs_attention";

export type DiagnosticOperationId =
  | "diagnostic.discover"
  | "diagnostic.plan"
  | "diagnostic.start"
  | "diagnostic.certificate.inspect"
  | "diagnostic.route.plan"
  | "diagnostic.observe"
  | "diagnostic.export"
  | "diagnostic.stop";

export interface DiagnosticCapabilityDescriptor {
  schemaVersion: number;
  packageId: string;
  contractStatus: string;
  operationId: DiagnosticOperationId | string;
  version: string;
  handler: string;
  inputModalities: string[];
  outputModalities: string[];
  providerRequirements: string[];
  configurationObserved: {
    defaultEnabled: boolean;
    osCaMutation: boolean;
    dnsMutation: boolean;
    globalProxy: boolean;
  };
  state: string;
  effectsAdmitted: string[];
  policy: {
    collectPolicies: string[];
    modes: string[];
    limits: Record<string, number>;
  };
  integrationOrigin: string;
  integrationRevision: string;
  supportProof: string;
  ui: {
    shellRegion: string;
    i18nKeyPrefix: string;
    icon: string;
    deferredProductUi: boolean;
  };
  summary?: string;
}

export interface DiscoverInput {
  platform: string;
  mode: DiagnosticMode | string;
  localAppRef: string | null;
}

export interface DiscoverOutput {
  support: string;
  version: string;
  license: string;
  configurationRequired: string[];
  capture: false;
  dnsMutation: false;
  globalTrust: false;
}

export interface PlanInput {
  appRef: string;
  ownershipEvidenceRef: string;
  origins: string[];
  mode: DiagnosticMode | string;
  collectPolicy: DiagnosticCollectPolicy;
  collectPolicyRef: string;
  expiresAt: string | null;
  limits: {
    ttlMs: number;
    maxOrigins: number;
    maxConnections: number;
    maxBodyBytes: number;
    maxTotalBytes: number;
  };
}

export interface PlanOutput {
  planRef: string;
  revision: number;
  origins: string[];
  mode: string;
  collectPolicy: DiagnosticCollectPolicy | string;
  confidence: number;
  effectsExplicit: string[];
  destinations: string[];
  expiresAt: string | null;
  limits: Record<string, number>;
  osCaMutation: false;
  dnsMutation: false;
}

export interface StartInput {
  approvedPlanRef: string;
  requestId: string;
}

export interface CertificateInspectInput {
  sessionRef: string;
}

export interface CertificateInspectOutput {
  fingerprint?: string;
  issuer?: string;
  validity?: unknown;
  scope?: string;
  trustState?: string;
  privateKeyExported?: false;
  error?: string;
}

export interface RoutePlanInput {
  sessionRef: string;
  expectedRevision: number;
  aliasMap: Record<string, string>;
  grantedDestinations: string[] | null;
}

export interface ObserveExportInput {
  sessionRef: string;
  cursor: number;
  format: string;
  manifesto: boolean;
}

export interface ObserveExportOutput {
  records: unknown[];
  droppedCount: number;
  collectionState: string;
  nextCursor?: number;
  artifactRef?: string | null;
  error?: string;
  detail?: string | null;
}

export interface StopInput {
  sessionRef: string;
  expectedRevision: number | null;
  reason: string;
}

export declare function isLoopbackHost(host: string): boolean;
export declare function assertExactLoopbackOrigins(origins: unknown): string[];
export declare function assertNoInsecureSkipVerify(payload: unknown): void;
export declare function describeDiagnosticCapability(operationId: string): DiagnosticCapabilityDescriptor;
export declare function listDiagnosticCapabilities(): DiagnosticCapabilityDescriptor[];
export declare function parseDiscoverInput(input?: unknown): DiscoverInput;
export declare function parseDiscoverOutput(output: unknown): DiscoverOutput;
export declare function parsePlanInput(input: unknown): PlanInput;
export declare function parsePlanOutput(output: unknown): PlanOutput;
export declare function parseStartInput(input: unknown): StartInput;
export declare function parseCertificateInspectInput(input: unknown): CertificateInspectInput;
export declare function parseCertificateInspectOutput(output: unknown): CertificateInspectOutput;
export declare function parseRoutePlanInput(input: unknown): RoutePlanInput;
export declare function parseObserveExportInput(input: unknown): ObserveExportInput;
export declare function parseObserveExportOutput(output: unknown): ObserveExportOutput;
export declare function parseStopInput(input: unknown): StopInput;
