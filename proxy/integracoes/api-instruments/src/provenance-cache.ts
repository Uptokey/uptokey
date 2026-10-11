import { createHash } from 'node:crypto';
import type { GovernedReadOutcome, PreparedApiCall } from './types.ts';

export interface CacheOptions {
  ttlMs?: number;
  maxEntries?: number;
  maxBytes?: number;
}

/** Identity/configuration revision is supplied by the admitted server context, never by a model. */
export interface CacheContext { configurationRevision: string; authorizationContext: string }

/** Closed lookup codes. A hit replays a stored governed read only; it never stands in for an effect or authorization. */
export type ProvenanceLookupStatus = "hit" | "miss" | "expired" | "isolated" | "ineligible";
export type ProvenanceIneligibleReason = "scope_invalid" | "limit_exceeded" | "clock_invalid";
export type ProvenanceLookup =
  | { status: "hit"; ageMs: number; outcome: GovernedReadOutcome }
  | { status: "miss" | "expired" | "isolated"; outcome?: undefined }
  | { status: "ineligible"; reason: ProvenanceIneligibleReason; outcome?: undefined };

export interface ProvenanceCacheMetrics {
  readonly lookups: Readonly<Record<ProvenanceLookupStatus, number>>;
  readonly writes: number;
  readonly writeRejects: number;
  readonly evictions: number;
  readonly invalidations: number;
  readonly lastHitAgeSeconds: number | null;
  readonly size: number;
  readonly bytes: number;
}

export interface ProvenanceCacheLimits {
  readonly ttlMs: number;
  readonly maxEntries: number;
  readonly maxBytes: number;
}

export interface CacheEntry {
  principalId: string;
  projectId: string;
  operationId: string;
  schemaDigest: string;
  parametersDigest: string;
  retrievedAt: string;
  origin: string;
  data: unknown;
  byteLength: number;
  expiresAt: number;
}

function sha256Hex(data: string): string {
  return createHash('sha256').update(data, 'utf8').digest('hex');
}

/** Canonical deterministic stringify */
function canonicalStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalStringify).join(',')}]`;
  }
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return `{${keys
    .map(k => `${JSON.stringify(k)}:${canonicalStringify((value as Record<string, unknown>)[k])}`)
    .join(',')}}`;
}

/**
 * Exact Provenance Cache for governed read instruments.
 * Requirement 14: Keyed strictly by principal, project, operation, revision, schema, and parameters.
 * Preserves the original retrievedAt timestamp and origin without faking new calls.
 */
export class ProvenanceCache {
  private readonly store = new Map<string, CacheEntry>();
  private readonly defaultTtlMs: number;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private readonly lookups: Record<ProvenanceLookupStatus, number> = { hit: 0, miss: 0, expired: 0, isolated: 0, ineligible: 0 };
  private writes = 0;
  private writeRejects = 0;
  private evictions = 0;
  private invalidations = 0;
  private lastHitAgeMs: number | null = null;

  constructor(options?: CacheOptions) {
    this.defaultTtlMs = options?.ttlMs ?? 300_000; // 5 minutes default
    this.maxEntries = options?.maxEntries ?? 1000;
    this.maxBytes = options?.maxBytes ?? 8 * 1024 * 1024;
    if (![this.defaultTtlMs, this.maxEntries, this.maxBytes].every(value => Number.isSafeInteger(value) && value > 0)) throw new Error('cache_invalid_limits');
  }

  limits(): ProvenanceCacheLimits {
    return Object.freeze({ ttlMs: this.defaultTtlMs, maxEntries: this.maxEntries, maxBytes: this.maxBytes });
  }

  /** Metadata-only projection for stage 06 presentation; never a routing decision. */
  metrics(): ProvenanceCacheMetrics {
    return Object.freeze({
      lookups: Object.freeze({ ...this.lookups }),
      writes: this.writes,
      writeRejects: this.writeRejects,
      evictions: this.evictions,
      invalidations: this.invalidations,
      lastHitAgeSeconds: this.lastHitAgeMs === null ? null : Math.floor(this.lastHitAgeMs / 1000),
      size: this.store.size,
      bytes: [...this.store.values()].reduce((sum, entry) => sum + entry.byteLength, 0),
    });
  }

  /**
   * Operator-driven revocation (credential change, policy change, access exclusion).
   * Key rotation already partitions entries via context/schema digests; this drops
   * everything immediately. Never throws; the journal/store remain the durable source.
   */
  invalidateAll(): void {
    this.store.clear();
    if (this.invalidations < Number.MAX_SAFE_INTEGER) this.invalidations += 1;
  }

  computeKey(
    principalId: string,
    projectId: string,
    prepared: PreparedApiCall,
    context?: CacheContext
  ): string {
    const canonicalParams = canonicalStringify(prepared.query);
    const paramsDigest = sha256Hex(canonicalParams);

    const keyPayload = canonicalStringify({
      principalId,
      projectId,
      serviceId: prepared.serviceId,
      operationId: prepared.operationId,
      capabilityId: prepared.capabilityId,
      method: prepared.method,
      origin: prepared.origin,
      url: prepared.url,
      path: prepared.path,
      schemaDigest: prepared.schemaDigest,
      paramsDigest,
      callDigest: prepared.callDigest,
      limits: prepared.limits,
      context: context ?? null,
    });

    return sha256Hex(keyPayload);
  }

  get(
    principalId: string,
    projectId: string,
    prepared: PreparedApiCall,
    now = Date.now(),
    context?: CacheContext
  ): GovernedReadOutcome | null {
    const result = this.lookup(principalId, projectId, prepared, now, context);
    return result.status === "hit" ? result.outcome : null;
  }

  /** Closed-code lookup: principal/project/schema/policy/credential changes miss; expired entries never leak. */
  lookup(
    principalId: string,
    projectId: string,
    prepared: PreparedApiCall,
    now = Date.now(),
    context?: CacheContext
  ): ProvenanceLookup {
    if (!Number.isFinite(now)) return this.count("ineligible", { status: "ineligible", reason: "clock_invalid" });
    if (!principalId || !projectId) return this.count("ineligible", { status: "ineligible", reason: "scope_invalid" });
    if (!Number.isSafeInteger(prepared.limits.maxOutputBytes)) {
      return this.count("ineligible", { status: "ineligible", reason: "limit_exceeded" });
    }
    const key = this.computeKey(principalId, projectId, prepared, context);
    const entry = this.store.get(key);
    if (!entry) return this.count("miss", { status: "miss" });

    // Strict user/project isolation check
    if (entry.principalId !== principalId || entry.projectId !== projectId) {
      return this.count("isolated", { status: "isolated" });
    }

    // Expiration check
    if (now >= entry.expiresAt) {
      this.store.delete(key);
      return this.count("expired", { status: "expired" });
    }
    if (entry.byteLength > prepared.limits.maxOutputBytes!) {
      return this.count("ineligible", { status: "ineligible", reason: "limit_exceeded" });
    }

    const retrievedMs = Date.parse(entry.retrievedAt);
    const outcome: GovernedReadOutcome = {
      kind: 'completed',
      data: structuredClone(entry.data), // Return deep-cloned immutable copy (C09)
      origin: entry.origin,
      operation: entry.operationId,
      retrievedAt: entry.retrievedAt, // Preserves original retrieval time!
      byteLength: entry.byteLength,
      cached: true,
    };
    if (Number.isFinite(retrievedMs)) this.lastHitAgeMs = Math.max(0, now - retrievedMs);
    return this.count("hit", { status: "hit", ageMs: Number.isFinite(retrievedMs) ? Math.max(0, now - retrievedMs) : 0, outcome });
  }

  put(
    principalId: string,
    projectId: string,
    prepared: PreparedApiCall,
    outcome: Extract<GovernedReadOutcome, { kind: 'completed' }>,
    ttlMs = this.defaultTtlMs,
    now = Date.now(),
    context?: CacheContext
  ): void {
    try {
      this.storePut(principalId, projectId, prepared, outcome, ttlMs, now, context);
      if (this.writes < Number.MAX_SAFE_INTEGER) this.writes += 1;
    } catch (error) {
      if (this.writeRejects < Number.MAX_SAFE_INTEGER) this.writeRejects += 1;
      throw error;
    }
  }

  private count<T extends ProvenanceLookup>(status: ProvenanceLookupStatus, result: T): T {
    if (this.lookups[status] < Number.MAX_SAFE_INTEGER) this.lookups[status] += 1;
    return result;
  }

  private evictOne(): void {
    const firstKey = this.store.keys().next().value;
    if (!firstKey) return;
    this.store.delete(firstKey);
    if (this.evictions < Number.MAX_SAFE_INTEGER) this.evictions += 1;
  }

  private storePut(
    principalId: string,
    projectId: string,
    prepared: PreparedApiCall,
    outcome: Extract<GovernedReadOutcome, { kind: 'completed' }>,
    ttlMs: number,
    now: number,
    context?: CacheContext
  ): void {
    if (!principalId || !projectId || !Number.isFinite(now) || !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(outcome.byteLength) || outcome.byteLength < 0 || outcome.byteLength > this.maxBytes || !Number.isSafeInteger(prepared.limits.maxOutputBytes) || outcome.byteLength > prepared.limits.maxOutputBytes! || outcome.origin !== prepared.origin || outcome.operation !== prepared.operationId || !Number.isFinite(Date.parse(outcome.retrievedAt))) throw new Error('cache_invalid_provenance_or_limits');
    const serialized = JSON.stringify(outcome.data);
    if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > Math.max(outcome.byteLength, 4)) throw new Error('cache_invalid_byte_length');
    const key = this.computeKey(principalId, projectId, prepared, context);
    this.store.delete(key);
    for (const [expiredKey, entry] of this.store) if (now >= entry.expiresAt) { this.store.delete(expiredKey); if (this.evictions < Number.MAX_SAFE_INTEGER) this.evictions += 1; }
    let bytes = [...this.store.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
    while (this.store.size >= this.maxEntries || bytes + outcome.byteLength > this.maxBytes) {
      const before = this.store.size;
      this.evictOne();
      if (this.store.size === before) break;
      bytes = [...this.store.values()].reduce((sum, entry) => sum + entry.byteLength, 0);
    }
    const canonicalParams = canonicalStringify(prepared.query);
    const paramsDigest = sha256Hex(canonicalParams);

    this.store.set(key, {
      principalId,
      projectId,
      operationId: prepared.operationId,
      schemaDigest: prepared.schemaDigest,
      parametersDigest: paramsDigest,
      retrievedAt: outcome.retrievedAt,
      origin: outcome.origin,
      data: structuredClone(outcome.data),
      byteLength: outcome.byteLength,
      expiresAt: now + Math.min(ttlMs, this.defaultTtlMs),
    });
  }

  clear(): void {
    this.store.clear();
  }

  size(): number {
    return this.store.size;
  }
}
