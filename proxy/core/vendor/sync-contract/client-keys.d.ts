export const CLIENT_KEY_CONTRACT_VERSION = 1;
export const CLIENT_KEY_SCHEMA_VERSION = 1;
export const CLIENT_KEY_MAX_KEYS = 128;
export const CLIENT_KEY_MAX_LIST = 100;
export const CLIENT_KEY_MAX_SCOPED_IDS = 64;
export const CLIENT_KEY_LABEL_MAX = 80;
export declare const CLIENT_KEY_SCOPES: readonly ['inference:chat', 'inference:responses', 'inference:messages', 'models:read', 'usage:read'];
export type ClientKeyScope = typeof CLIENT_KEY_SCOPES[number];
export type ClientRetentionMode = 'standard' | 'ephemeral';
export interface ClientKeyLimits {
  readonly requestsPerMinute?: number;
  readonly maxConcurrent?: number;
  readonly maxOutputTokens?: number;
  readonly maxCostMicros?: string | null;
}
export interface ClientKeyPolicy {
  readonly schemaVersion: 1;
  readonly id: string;
  readonly revision: number;
  readonly label: string;
  readonly principalId: string;
  readonly projectIds: readonly string[];
  readonly providerIds: readonly string[];
  readonly modelIds: readonly string[];
  readonly scopes: readonly ClientKeyScope[];
  readonly expiresAt: string | null;
  readonly enabled: boolean;
  /** Absent on legacy policies; consumers apply the compatible standard default. */
  readonly retentionMode?: ClientRetentionMode;
  readonly limits?: ClientKeyLimits;
}
export function parseClientKeyPolicy(input: unknown): ClientKeyPolicy;
export function canonicalClientKeyPolicy(input: unknown): string;
export interface ClientKeyView extends ClientKeyPolicy {
  readonly prefixMasked: string;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
  readonly revokedAt: string | null;
  readonly usageBasis: string;
}
export function parseClientKeyView(input: unknown): ClientKeyView;
export type KeyMutation =
  | Readonly<{ kind: 'create'; operationId: string; expectedRevision: 1; label: string; scopes: readonly ClientKeyScope[]; limits: ClientKeyLimits | null; retentionMode?: ClientRetentionMode }>
  | Readonly<{ kind: 'update'; operationId: string; expectedRevision: number; label?: string; projectIds?: readonly string[]; providerIds?: readonly string[]; modelIds?: readonly string[]; scopes?: readonly ClientKeyScope[]; expiresAt?: string | null; enabled?: boolean; limits?: ClientKeyLimits | null; retentionMode?: ClientRetentionMode }>
  | Readonly<{ kind: 'rotate' | 'revoke'; operationId: string; expectedRevision: number }>;
export function parseKeyMutation(input: unknown): KeyMutation;
export declare const PROTOCOL_CAPABILITY_PROTOCOLS: readonly ['openai-chat-completions', 'openai-responses', 'anthropic-messages', 'openai-completions-legacy'];
export interface ProtocolCapability {
  readonly protocol: typeof PROTOCOL_CAPABILITY_PROTOCOLS[number];
  readonly version: string;
  readonly stream: boolean;
  readonly toolCalls: boolean;
  readonly structuredOutput: boolean;
  readonly modalities: readonly string[];
  readonly unsupportedFields: readonly string[];
  readonly evidenceAt: string;
}
export function parseProtocolCapability(input: unknown): ProtocolCapability;
export declare const PROTOCOL_CAPABILITY_MATRIX: readonly ProtocolCapability[];
/** Explicit requested/approved surface. Missing field retains legacy minimum scopes. */
export type PairingAudience = 'legacy' | 'vscode' | 'browser-extension' | 'tauri' | 'tui';
export const PAIRING_AUDIENCES: readonly PairingAudience[];
export function parsePairingAudience(value: unknown): PairingAudience;
/** Explicit reversible transition of an existing identity; clientId/data owner never changes. */
export type ClientAudienceTransitionPair = Readonly<{ from: 'pwa'; to: 'tui' }>;
export const CLIENT_AUDIENCE_TRANSITIONS: readonly ClientAudienceTransitionPair[];
export type ClientAudienceTransitionRequest =
  | Readonly<{ kind: 'transition'; clientId: string; from: 'pwa'; to: 'tui'; expectedPolicyRevision: number }>
  | Readonly<{ kind: 'revert'; clientId: string; expectedPolicyRevision: number }>;
export function parseClientAudienceTransition(input: unknown): ClientAudienceTransitionRequest;
