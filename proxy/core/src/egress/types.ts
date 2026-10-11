/** E2-19 egress domain types (local journal; credentials via credentialRef only). */

export type EgressProxyKind =
  | "http"
  | "https"
  | "socks5"
  | "vercel_relay"
  | "cloudflare_relay"
  | "deno_relay";

export type PoolStrategy = "fixed" | "round_robin" | "random";
export type HealthState = "unknown" | "healthy" | "degraded" | "cooldown" | "disabled";
export type BindingOwnerKind = "connection" | "provider" | "device";
export type TestJobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface EgressProxyRecord {
  schemaVersion: 1;
  id: string;
  revision: number;
  label: string;
  kind: EgressProxyKind;
  endpointUrl: string;
  enabled: boolean;
  credentialRef: string | null;
  operatorLabel: string | null;
  retentionEvidence: string | null;
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

export interface ProxyPoolRecord {
  id: string;
  revision: number;
  memberIds: string[];
  strategy: PoolStrategy;
  strict: boolean;
  allowDirectFallback: boolean;
  healthPolicy: { failuresBeforeCooldown: number; cooldownMs: number };
  noProxy: string[];
}

export interface ProxyBindingRecord {
  ownerKind: BindingOwnerKind;
  ownerId: string;
  poolId: string | null;
  inherit: boolean;
  expectedRevision: number;
}

export interface ProxyHealthRecord {
  memberId: string;
  state: HealthState;
  lastTestAt: string | null;
  latencyMs: number | null;
  nextEligibleAt: string | null;
  reason: string | null;
}

export interface EgressReceiptRecord {
  attemptId: string;
  poolId: string | null;
  poolRevision: number | null;
  memberId: string | null;
  finalHost: string;
  transportKind: string;
  usedDirect: boolean;
  reason: string;
}

export interface ProxyTestJobRecord {
  id: string;
  memberIds: string[];
  approvedTargetId: string;
  operationId: string;
  state: TestJobState;
  cursor: number;
}

export interface EgressJournal {
  proxies: Record<string, EgressProxyRecord>;
  pools: Record<string, ProxyPoolRecord>;
  bindings: Record<string, ProxyBindingRecord>;
  health: Record<string, ProxyHealthRecord>;
  cursors: Record<string, number>;
  receipts: EgressReceiptRecord[];
  testJobs: Record<string, ProxyTestJobRecord>;
}

export function emptyEgressJournal(): EgressJournal {
  return {
    proxies: {},
    pools: {},
    bindings: {},
    health: {},
    cursors: {},
    receipts: [],
    testJobs: {},
  };
}

/** Optional pointer on ProxyConfig — journal lives beside config, not inside providers. */
export interface EgressConfigPointer {
  journalRelativePath?: string;
  maxPools?: number;
  maxProxies?: number;
}
