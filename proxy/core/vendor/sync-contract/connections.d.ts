export const CONNECTIONS_SCHEMA_VERSION: number;

export type ConnectionAccessMode = "byok" | "oauth" | "custom" | "local";
export type ConnectionSupportLevel = "built_in" | "experimental" | "custom" | "research";
export type ConnectionStatus = "healthy" | "degraded" | "unauthenticated" | "disabled" | "unconfigured" | "unknown" | "expired";
export type ConnectionTestMode = "metadata" | "inference";
export type ConnectionTestState = "queued" | "running" | "succeeded" | "partial" | "failed" | "cancelled" | "interrupted";
export type ConnectionTestResultKind = "ok" | "unauthorized" | "rate_limited" | "timeout" | "unreachable" | "skipped" | "failed";
export type ModelInstallRuntime = "ollama" | "vllm";
export type ModelInstallState = "queued" | "downloading" | "verifying" | "ready" | "failed" | "cancelled" | "interrupted";

export interface ConnectionProfile {
  schemaVersion: 1;
  id?: string;
  revision: number;
  providerId: string;
  label: string;
  accessMode: ConnectionAccessMode;
  enabled: boolean;
  endpointUrl: string | null;
  modelIds: string[];
  credentialRef?: string;
  /** User-declared shared billing identity, scoped by provider; never a credential fingerprint. */
  commercialAccountId?: string;
  /** User-declared models accepting image input; enforced by the router, never inferred from names. */
  imageInputModels?: string[];
  /** User-declared models accepting `input_audio` parts on this connection. */
  audioInputModels?: string[];
  /** User-declared models accepting function tools (calls and tool results). */
  toolModels?: string[];
  /** User-declared models honoring `response_format: json_schema`. */
  jsonSchemaModels?: string[];
  proxyPoolId?: string;
  priority: number;
}

export interface ConnectionPatch {
  revision: number;
  label?: string;
  enabled?: boolean;
  endpointUrl?: string | null;
  modelIds?: string[];
  priority?: number;
  proxyPoolId?: string | null;
  commercialAccountId?: string | null;
  imageInputModels?: string[] | null;
  audioInputModels?: string[] | null;
  toolModels?: string[] | null;
  jsonSchemaModels?: string[] | null;
}

export function parseCommercialAccountId(value: unknown): string;
export function parseImageInputModels(value: unknown): string[];
export type RequiredCapability = "image" | "audio" | "tools" | "json_schema";
export const REQUIRED_CAPABILITIES: readonly RequiredCapability[];
export const DECLARED_CAPABILITY_FIELDS: Readonly<Record<RequiredCapability, "imageInputModels" | "audioInputModels" | "toolModels" | "jsonSchemaModels">>;
export function parseDeclaredCapabilityModels(kind: RequiredCapability, value: unknown): string[];
export function parseRequiredCapabilities(value: unknown): RequiredCapability[];
export interface AccountFundingObservationInput {
  expectedRevision: number;
  expectedUsageRevision: number;
  amountMicros: string;
  unit: 'usd_micros';
  source: string;
  observedAt: string;
  validUntil: string;
}
export interface AccountFundingView {
  providerId: string;
  accountId: string;
  revision: number;
  usageRevision: number;
  unit: 'usd_micros';
  amountMicros: string | null;
  source: string | null;
  observedAt: string | null;
  validUntil: string | null;
  status: 'current' | 'expired' | 'missing';
  reservedMicros: string;
  settledMicros: string;
  availableMicros: string | null;
}

export interface ConnectionViewDerived {
  credentialPresent: boolean;
  accountLabel: string;
  supportLevel: ConnectionSupportLevel;
  status: ConnectionStatus;
  observedAt: string;
}

export type ConnectionView = Omit<ConnectionProfile, "credentialRef"> & ConnectionViewDerived;

export interface ConnectionTestSpec {
  connectionIds: string[];
  mode: ConnectionTestMode;
  maxCalls: number;
  maxCostMicros: string;
  operationId?: string;
}

export interface ConnectionTestResult {
  connectionId: string;
  result: ConnectionTestResultKind;
  latencyMs?: number;
  observedAt: string;
  note?: string;
}

export interface ModelInstallSpec {
  runtime: ModelInstallRuntime;
  modelId: string;
  destinationId: string;
  expectedDigest: string | null;
  operationId?: string;
}

export interface OAuthStartSpec {
  providerId: string;
  scopes: string[];
  operationId?: string;
}

export declare const CONNECTION_ACCESS_MODES: ConnectionAccessMode[];
export declare const CONNECTION_SUPPORT_LEVELS: ConnectionSupportLevel[];
export declare const CONNECTION_STATES: ConnectionStatus[];
export declare const CONNECTION_TEST_MODES: ConnectionTestMode[];
export declare const CONNECTION_TEST_STATES: ConnectionTestState[];
export declare const CONNECTION_TEST_RESULTS: ConnectionTestResultKind[];
export declare const MODEL_INSTALL_RUNTIMES: ModelInstallRuntime[];
export declare const MODEL_INSTALL_STATES: ModelInstallState[];
export declare const CONNECTION_LIMITS: {
  maxConnectionsPerDevice: number;
  maxTestConnections: number;
  maxTestCalls: number;
  maxConcurrentTests: number;
  testTimeoutMs: number;
  maxConcurrentInstalls: number;
  maxLabelLength: number;
  maxModelIds: number;
};
export declare const CONNECTION_ERROR_TYPES: string[];

export declare function parseConnectionProfile(input: unknown): ConnectionProfile;
export declare function parseConnectionPatch(input: unknown): ConnectionPatch;
export declare function projectConnectionView(profile: unknown, derived: unknown): ConnectionView;
export declare function parseConnectionTestSpec(input: unknown): ConnectionTestSpec;
export declare function parseConnectionTestResult(input: unknown): ConnectionTestResult;
export declare function parseModelInstallSpec(input: unknown): ModelInstallSpec;
export declare function parseOAuthStart(input: unknown): OAuthStartSpec;
export declare function assertViewHasNoSecrets(payload: unknown): void;
