/**
 * E2-19 egress resolver.
 * Ideas from 9Router connectionProxy.js (MIT) with hard fixes:
 * - cursor keyed by poolId@revision (persistable)
 * - never silent-direct on resolution errors
 */
import { isIP } from 'node:net';

export type PoolStrategy = "fixed" | "round_robin" | "random";
export type HealthState = "unknown" | "healthy" | "degraded" | "cooldown" | "disabled";

export interface ResolveMember {
  id: string;
  enabled: boolean;
  kind: string;
  endpointUrl: string;
  healthState: HealthState;
  nextEligibleAt: string | null;
}

export interface ResolvePool {
  id: string;
  revision: number;
  memberIds: string[];
  strategy: PoolStrategy;
  strict: boolean;
  allowDirectFallback: boolean;
  noProxy: string[];
}

export type ResolveOk = {
  ok: true;
  usedDirect: boolean;
  member: ResolveMember | null;
  cursor: number | null;
  reason: string;
  poolId: string | null;
  poolRevision: number | null;
};

export type ResolveErr = {
  ok: false;
  code: "strict_pool_unavailable" | "resolution_error";
  reason: string;
  cursor: number | null;
};

export type ResolveResult = ResolveOk | ResolveErr;

export function cursorKey(poolId: string, revision: number): string {
  return `${poolId}@${revision}`;
}

function ipv4InCidr(ip: string, cidr: string): boolean {
  const parts = cidr.split("/");
  const base = parts[0] ?? "";
  const bitsStr = parts[1];
  if (isIP(ip) !== 4 || isIP(base) !== 4 || bitsStr === undefined || !/^\d{1,2}$/.test(bitsStr)) return false;
  const bits = Number(bitsStr);
  if (!Number.isInteger(bits) || bits < 0 || bits > 32) return false;
  const toInt = (s: string) =>
    s.split(".").reduce((a, o) => ((a << 8) + (Number(o) & 255)) >>> 0, 0);
  const mask = bits === 0 ? 0 : (~0 << (32 - bits)) >>> 0;
  return (toInt(ip) & mask) === (toInt(base) & mask);
}

export function hostMatchesNoProxy(host: string, rules: string[]): boolean {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  for (const rule of rules || []) {
    const r = String(rule).toLowerCase();
    if (r.startsWith('*.')) {
      if (h.endsWith(r.slice(1))) return true;
      continue;
    }
    if (r.startsWith(".")) {
      if (h.endsWith(r) || h === r.slice(1)) return true;
      continue;
    }
    if (r.includes("/")) {
      if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h) && ipv4InCidr(h, r)) return true;
      continue;
    }
    if (h === r) return true;
  }
  return false;
}

function isEligible(member: ResolveMember, nowMs: number): boolean {
  if (!member.enabled) return false;
  if (member.healthState === "disabled") return false;
  if (member.healthState === "cooldown") {
    if (!member.nextEligibleAt) return false;
    if (Date.parse(member.nextEligibleAt) > nowMs) return false;
  }
  return true;
}

export function resolveEgress(input: {
  pool: ResolvePool | null;
  members: Map<string, ResolveMember> | { get(id: string): ResolveMember | undefined };
  destinationHost: string;
  persistedCursor: number | null;
  random?: () => number;
  now?: () => number;
}): ResolveResult {
  const now = (input.now ?? Date.now)();
  const rnd = input.random ?? Math.random;

  try {
    if (!input.pool) {
      return {
        ok: true,
        usedDirect: true,
        member: null,
        cursor: null,
        reason: "no_pool_binding",
        poolId: null,
        poolRevision: null,
      };
    }

    const pool = input.pool;
    if (pool.strict && pool.allowDirectFallback) {
      return {
        ok: false,
        code: "resolution_error",
        reason: "proxy_pool_strict_fallback_conflict",
        cursor: input.persistedCursor,
      };
    }

    if (hostMatchesNoProxy(input.destinationHost, pool.noProxy)) {
      return {
        ok: true,
        usedDirect: true,
        member: null,
        cursor: input.persistedCursor,
        reason: "no_proxy_match",
        poolId: pool.id,
        poolRevision: pool.revision,
      };
    }

    const ordered: ResolveMember[] = [];
    for (const id of pool.memberIds) {
      const m = input.members.get(id);
      if (m && isEligible(m, now)) ordered.push(m);
    }

    if (ordered.length === 0) {
      if (pool.allowDirectFallback && !pool.strict) {
        return {
          ok: true,
          usedDirect: true,
          member: null,
          cursor: input.persistedCursor,
          reason: "fallback_direct_authorized",
          poolId: pool.id,
          poolRevision: pool.revision,
        };
      }
      return {
        ok: false,
        code: "strict_pool_unavailable",
        reason: "no_eligible_members",
        cursor: input.persistedCursor,
      };
    }

    let index = 0;
    let cursor = input.persistedCursor ?? 0;

    if (pool.strategy === "fixed") {
      index = 0;
      cursor = 0;
    } else if (pool.strategy === "random") {
      index = Math.floor(rnd() * ordered.length) % ordered.length;
      cursor = index;
    } else {
      cursor = ((input.persistedCursor ?? -1) + 1) % ordered.length;
      index = cursor;
    }

    return {
      ok: true,
      usedDirect: false,
      member: ordered[index]!,
      cursor,
      reason: `strategy_${pool.strategy}`,
      poolId: pool.id,
      poolRevision: pool.revision,
    };
  } catch (err) {
    return {
      ok: false,
      code: "resolution_error",
      reason: err instanceof Error ? err.message : "resolution_error",
      cursor: input.persistedCursor,
    };
  }
}
