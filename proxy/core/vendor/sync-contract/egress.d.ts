/** E2-19 W0 egress / proxy pool types. */

export type EgressProxyKind =
  | "http"
  | "https"
  | "socks5"
  | "vercel_relay"
  | "cloudflare_relay"
  | "deno_relay";

export type ProxyPoolStrategy = "fixed" | "round_robin" | "random";
export type ProxyHealthState = "unknown" | "healthy" | "degraded" | "cooldown" | "disabled";
export type ProxyBindingOwnerKind = "connection" | "provider" | "device";
export type ProxyTestJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface EgressProxy {
  schemaVersion: 1;
  id: string;
  revision: number;
  label: string;
  kind: EgressProxyKind;
  endpointUrl: string;
  enabled: boolean;
  credentialRef?: string | null;
  operatorLabel?: string | null;
  retentionEvidence?: string | null;
}

export interface EgressProxyPublic {
  schemaVersion: 1;
  id: string;
  revision: number;
  label: string;
  kind: EgressProxyKind;
  endpointUrl: string;
  enabled: boolean;
  hasCredential: boolean;
  operatorLabel: string | null;
  retentionEvidence: string | null;
}

export interface ProxyPoolHealthPolicy {
  failuresBeforeCooldown: number;
  cooldownMs: number;
}

export interface ProxyPool {
  id: string;
  revision: number;
  memberIds: string[];
  strategy: ProxyPoolStrategy;
  strict: boolean;
  allowDirectFallback: boolean;
  healthPolicy: ProxyPoolHealthPolicy;
  noProxy: string[];
}

export interface ProxyBinding {
  ownerKind: ProxyBindingOwnerKind;
  ownerId: string;
  poolId: string | null;
  inherit: boolean;
  expectedRevision: number;
}

export interface ProxyHealth {
  memberId: string;
  state: ProxyHealthState;
  lastTestAt: string | null;
  latencyMs: number | null;
  nextEligibleAt: string | null;
  reason: string | null;
}

export interface EgressReceipt {
  attemptId: string;
  poolId: string | null;
  poolRevision: number | null;
  memberId: string | null;
  finalHost: string;
  transportKind: string;
  usedDirect: boolean;
  reason: string;
}

export interface ProxyTestJob {
  id: string;
  memberIds: string[];
  approvedTargetId: string;
  operationId: string;
  state: ProxyTestJobState;
  cursor: number;
}

export declare const EGRESS_LIMITS: {
  readonly maxPools: number;
  readonly maxProxies: number;
  readonly maxMembersPerPool: number;
  readonly maxConcurrentTests: number;
  readonly testTimeoutMs: number;
  readonly failuresBeforeCooldown: number;
  readonly cooldownMs: number;
  readonly maxEndpointUrlLength: number;
  readonly maxNoProxyRules: number;
};

export declare const EGRESS_ERROR_CODES: Readonly<Record<string, number>>;

export declare function isUuid(value: unknown): value is string;
export declare function validateEndpointUrl(kind: EgressProxyKind, endpointUrl: string): string;
export declare function validateNoProxyRules(rules: unknown): string[];
export declare function parseEgressProxy(input: unknown): EgressProxy;
export declare function projectEgressProxyPublic(proxy: unknown): EgressProxyPublic;
export declare function maskEndpointUrl(endpointUrl: string): string;
export declare function parseProxyPool(input: unknown): ProxyPool;
export declare function parseProxyBinding(input: unknown): ProxyBinding;
export declare function parseProxyHealth(input: unknown): ProxyHealth;
export declare function parseEgressReceipt(input: unknown): EgressReceipt;
export declare function parseProxyTestJob(input: unknown): ProxyTestJob;
/** Runtime allow-lists used by the validators above (exported by egress.js). */
export declare const EGRESS_PROXY_KINDS: ReadonlySet<EgressProxyKind>;
export declare const POOL_STRATEGIES: ReadonlySet<ProxyPoolStrategy>;
export declare const HEALTH_STATES: ReadonlySet<ProxyHealthState>;
export declare const BINDING_OWNERS: ReadonlySet<ProxyBindingOwnerKind>;
export declare const TEST_JOB_STATES: ReadonlySet<ProxyTestJobState>;
