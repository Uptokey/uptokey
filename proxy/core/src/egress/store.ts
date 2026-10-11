import { randomUUID } from "node:crypto";
import {
  emptyEgressJournal,
  type EgressJournal,
  type EgressProxyPublic,
  type EgressProxyRecord,
  type EgressReceiptRecord,
  type ProxyBindingRecord,
  type ProxyHealthRecord,
  type ProxyPoolRecord,
  type ProxyTestJobRecord,
} from "./types.ts";
import { cursorKey, resolveEgress, type ResolveMember, type ResolveOk } from "./resolver.ts";
import type { DispatchOptions } from "../types.ts";
import {dispatchFetch} from '../adapters.ts';
import { parseEgressProxy, parseProxyPool, parseProxyBinding, EGRESS_LIMITS } from '@uptokey/sync-contract/egress';

type EgressTestOptions={request?:typeof dispatchFetch; readCredential?: (reference: string) => Promise<string | undefined | null>};

function err(code: string, status = 400, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(code), { code, status, ...extra });
}

function checked<T>(parse: (input: unknown) => T, input: unknown): T {
  try { return parse(input); }
  catch (error) {
    const code = (error as { code?: unknown })?.code;
    throw err(typeof code === 'string' && /^[a-z_]+$/.test(code) ? code : 'egress_configuration_invalid');
  }
}

function assertNoUserinfo(endpointUrl: string) {
  let u: URL;
  try { u = new URL(endpointUrl); } catch { throw err('endpoint_url_invalid'); }
  if (u.username || u.password) throw err("endpoint_url_userinfo_forbidden");
  if (endpointUrl.includes("#")) throw err("endpoint_url_fragment_forbidden");
  return u.href;
}

export function projectProxyPublic(p: EgressProxyRecord): EgressProxyPublic {
  const u = new URL(p.endpointUrl);
  return {
    schemaVersion: 1,
    id: p.id,
    revision: p.revision,
    label: p.label,
    kind: p.kind,
    endpointUrl: `${u.protocol}//${u.host}${u.pathname === "/" ? "" : u.pathname}`,
    enabled: p.enabled,
    hasCredential: Boolean(p.credentialRef),
    operatorLabel: p.operatorLabel,
    retentionEvidence: p.retentionEvidence,
  };
}

export class EgressStore {
  // Explicit fields support --experimental-strip-types without changing constructor semantics.
  public journal: EgressJournal;
  private readonly persist: (j: EgressJournal) => void | Promise<void>;
  private readonly writeJournal: (j: EgressJournal) => void | Promise<void>;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private configurationRevision = 0;
  private readonly selectionAuthority = new WeakMap<ResolveOk, () => boolean>();
  private readonly testRequest:typeof dispatchFetch;
  private readonly readCredential: EgressTestOptions["readCredential"];
  private readonly tests=new Map<string,AbortController>();
  private readonly testWork=new Map<string,Promise<void>>();
  private closed=false;
  private closing: Promise<void> | undefined;
  private receiptCommit: { count: number; done: Promise<void> } | undefined;
  constructor(
    journal: EgressJournal = emptyEgressJournal(),
    persist: (j: EgressJournal) => void | Promise<void> = () => {},
    tests:EgressTestOptions = {},
  ) {
    this.journal = journal;
    this.writeJournal = persist;
    this.persist = journal => this.serializePersistence(async () => { await this.writeJournal(journal); });
    this.testRequest=tests.request??dispatchFetch;
    this.readCredential=tests.readCredential;
    // A process restart never replays a possibly dispatched connectivity check.
    for(const job of Object.values(this.journal.testJobs))if(['queued','running'].includes(job.state))job.state='failed';
  }

  private serializePersistence<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.persistenceQueue.then(operation);
    this.persistenceQueue = next.then(() => undefined, () => undefined);
    return next;
  }

  private mutateConfiguration<T>(operation: (journal: EgressJournal) => T, changesPolicy = true): Promise<T> {
    if (this.closed) return Promise.reject(err('proxy_test_state_closed', 409));
    return this.serializePersistence(async () => {
      // Preserve identities of unchanged records and the single receipt owner.
      // Readers keep seeing the last committed configuration during disk I/O.
      const draft: EgressJournal = { ...this.journal,
        proxies: { ...this.journal.proxies }, pools: { ...this.journal.pools },
        bindings: { ...this.journal.bindings }, cursors: { ...this.journal.cursors },
        health: { ...this.journal.health } };
      const result = operation(draft);
      await this.writeJournal(draft);
      Object.assign(this.journal, { proxies: draft.proxies, pools: draft.pools,
        bindings: draft.bindings, cursors: draft.cursors, health: draft.health });
      if (changesPolicy) this.configurationRevision++;
      return result;
    });
  }

  async restore(journal:EgressJournal){
    if(this.tests.size||this.closed)throw err('proxy_test_state_busy',409);
    this.journal=journal;
    let changed=false;
    for(const job of Object.values(journal.testJobs))if(['queued','running'].includes(job.state)){job.state='failed';changed=true;}
    if(changed)await this.persist(this.journal);
  }

  listProxiesPublic() {
    return Object.values(this.journal.proxies).map(projectProxyPublic);
  }

  async transportOptions(selected: ResolveOk, signal?: AbortSignal): Promise<DispatchOptions> {
    signal?.throwIfAborted();
    const selectionValid = this.selectionAuthority.get(selected) ?? (() => true);
    if (!selectionValid()) throw err('proxy_configuration_changed',409);
    const options: DispatchOptions = { proxyEndpoint: selected.member?.endpointUrl, usedDirect: selected.usedDirect, proxyAuthorityValid: selectionValid };
    if (selected.usedDirect || !selected.member) return options;
    const proxy = this.journal.proxies[selected.member.id];
    if (!proxy?.enabled || proxy.endpointUrl !== selected.member.endpointUrl) throw err("proxy_configuration_changed", 409);
    options.proxyAuthorityValid = () => selectionValid() && this.journal.proxies[proxy.id] === proxy && proxy.enabled;
    if (!proxy.credentialRef) return options;
    if (!proxy.credentialRef.startsWith("egress-proxy:") || !this.readCredential) throw err("proxy_credentials_unavailable", 503);
    let credentials: unknown;
    let onAbort: (() => void) | undefined;
    try {
      const read = this.readCredential(proxy.credentialRef);
      const stored = signal ? await Promise.race([read, new Promise<never>((_, reject) => {
        onAbort = () => reject(new Error("proxy_credential_read_cancelled"));
        if (signal.aborted) onAbort(); else signal.addEventListener("abort", onAbort, { once: true });
      })]) : await read;
      if (!stored) throw new Error();
      credentials = JSON.parse(stored);
    } catch { throw err("proxy_credentials_unavailable", 503); }
    finally { if (onAbort) signal?.removeEventListener("abort", onAbort); }
    if (!options.proxyAuthorityValid()) throw err("proxy_configuration_changed", 409);
    const value = credentials as { username?: unknown; password?: unknown } | null;
    if (!value || typeof value !== "object" || Array.isArray(value) || typeof value.username !== "string" || typeof value.password !== "string"
      || value.username.includes(":") || value.username.length > 1024 || value.password.length > 4096
      || /[\x00-\x1f\x7f]/.test(value.username + value.password)) throw err("proxy_credentials_unavailable", 503);
    return { ...options, proxyAuthorization: `Basic ${Buffer.from(`${value.username}:${value.password}`, "utf8").toString("base64")}` };
  }

  async createProxy(input: {
    id?: string;
    label: string;
    kind: EgressProxyRecord["kind"];
    endpointUrl: string;
    enabled?: boolean;
    credentialRef?: string | null;
    operatorLabel?: string | null;
    retentionEvidence?: string | null;
  }) {
    return this.mutateConfiguration((journal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('egress_configuration_invalid');
    const endpointUrl = assertNoUserinfo(input.endpointUrl);
    const proxy: EgressProxyRecord = {
      schemaVersion: 1,
      id: input.id ?? randomUUID(),
      revision: 1,
      label: input.label,
      kind: input.kind,
      endpointUrl,
      enabled: input.enabled ?? true,
      credentialRef: input.credentialRef ?? null,
      operatorLabel: input.operatorLabel ?? null,
      retentionEvidence: input.retentionEvidence ?? null,
    };
    checked(parseEgressProxy,proxy);
    if (Object.hasOwn(journal.proxies, proxy.id)) throw err('proxy_id_conflict',409);
    if (Object.keys(journal.proxies).length >= EGRESS_LIMITS.maxProxies) throw err('proxy_limit_reached',409);
    journal.proxies[proxy.id] = proxy;
    journal.health[proxy.id] = {
      memberId: proxy.id,
      state: proxy.enabled ? "unknown" : "disabled",
      lastTestAt: null,
      latencyMs: null,
      nextEligibleAt: null,
      reason: null,
    };
    
    return proxy;
  
    });
  }

  async createPool(input: {
    id?: string;
    memberIds: string[];
    strategy: ProxyPoolRecord["strategy"];
    strict: boolean;
    allowDirectFallback: boolean;
    noProxy?: string[];
  }) {
    return this.mutateConfiguration((journal) => {
    if (!input || typeof input !== 'object' || Array.isArray(input)) throw err('egress_configuration_invalid');
    if (input.strict && input.allowDirectFallback) throw err("proxy_pool_strict_fallback_conflict");
    if (!Array.isArray(input.memberIds)) throw err('proxy_pool_members_invalid');
    for (const id of input.memberIds) {
      if (!journal.proxies[id]) throw err("proxy_not_found", 404);
    }
    const pool: ProxyPoolRecord = {
      id: input.id ?? randomUUID(),
      revision: 1,
      memberIds: [...input.memberIds],
      strategy: input.strategy,
      strict: input.strict,
      allowDirectFallback: input.allowDirectFallback,
      healthPolicy: { failuresBeforeCooldown: 3, cooldownMs: 60_000 },
      noProxy: input.noProxy ?? [],
    };
    checked(parseProxyPool,pool);
    if (Object.hasOwn(journal.pools, pool.id)) throw err('pool_id_conflict',409);
    if (Object.keys(journal.pools).length >= EGRESS_LIMITS.maxPools) throw err('pool_limit_reached',409);
    journal.pools[pool.id] = pool;
    
    return pool;
  
    });
  }

  async deleteProxy(id: string) {
    return this.mutateConfiguration((journal) => {
    if (!journal.proxies[id]) throw err("proxy_not_found", 404);
    const impacted = Object.values(journal.pools)
      .filter((p) => p.memberIds.includes(id))
      .map((p) => p.id);
    if (impacted.length) throw err("proxy_in_use", 409, { impactedPoolIds: impacted });
    delete journal.proxies[id];
    delete journal.health[id];
    
  
    });
  }

  async setBinding(input: ProxyBindingRecord) {
    return this.mutateConfiguration((journal) => {
    input = checked(parseProxyBinding,input);
    if (input.poolId) {
      const pool = journal.pools[input.poolId];
      if (!pool) throw err("pool_not_found", 404);
      if (pool.revision !== input.expectedRevision) throw err("pool_revision_conflict", 409);
    }
    journal.bindings[`${input.ownerKind}:${input.ownerId}`] = { ...input };
    
    return journal.bindings[`${input.ownerKind}:${input.ownerId}`]!;
  
    });
  }

  getBinding(ownerKind: string, ownerId: string) {
    return this.journal.bindings[`${ownerKind}:${ownerId}`] ?? null;
  }

  resolvePoolForConnection(connectionId: string, providerId?: string | null, deviceId?: string | null) {
    const order: Array<[string, string | null | undefined]> = [
      ["connection", connectionId],
      ["provider", providerId],
      ["device", deviceId],
    ];
    for (const [kind, id] of order) {
      if (!id) continue;
      const b = this.getBinding(kind, id);
      if (!b) continue;
      if (b.poolId === null && b.inherit === false) return null;
      if (b.poolId) {
        const pool = this.journal.pools[b.poolId];
        if (!pool) throw err('pool_not_found',409);
        return pool;
      }
    }
    return null;
  }

  getCursor(poolId: string, revision: number) {
    const v = this.journal.cursors[cursorKey(poolId, revision)];
    return typeof v === "number" ? v : null;
  }

  async setCursor(poolId: string, revision: number, cursor: number) {
    return this.mutateConfiguration((journal) => {
    journal.cursors[cursorKey(poolId, revision)] = cursor;
    
  
    },false);
  }

  listPools() {
    return Object.values(this.journal.pools);
  }

  async updateProxy(
    id: string,
    patch: Partial<Pick<EgressProxyRecord, "label" | "kind" | "endpointUrl" | "enabled" | "credentialRef" | "operatorLabel" | "retentionEvidence">> & {
      expectedRevision?: number;
    },
  ) {
    return this.mutateConfiguration((journal) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw err('egress_configuration_invalid');
    const cur = journal.proxies[id];
    if (!cur) throw err("proxy_not_found", 404);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== cur.revision) {
      throw err("pool_revision_conflict", 409);
    }
    const endpointUrl = patch.endpointUrl !== undefined ? assertNoUserinfo(patch.endpointUrl) : cur.endpointUrl;
    const next: EgressProxyRecord = {
      ...cur,
      label: patch.label ?? cur.label,
      kind: patch.kind ?? cur.kind,
      endpointUrl,
      enabled: patch.enabled ?? cur.enabled,
      credentialRef: patch.credentialRef !== undefined ? patch.credentialRef : cur.credentialRef,
      operatorLabel: patch.operatorLabel !== undefined ? patch.operatorLabel : cur.operatorLabel,
      retentionEvidence: patch.retentionEvidence !== undefined ? patch.retentionEvidence : cur.retentionEvidence,
      revision: cur.revision + 1,
    };
    checked(parseEgressProxy,next);
    journal.proxies[id] = next;
    if (patch.enabled === false) {
      const h = journal.health[id];
      if (h) journal.health[id] = { ...h, state: "disabled" };
    }
    
    return next;
  
    });
  }

  async updatePool(
    id: string,
    patch: Partial<Pick<ProxyPoolRecord, "memberIds" | "strategy" | "strict" | "allowDirectFallback" | "noProxy" | "healthPolicy">> & {
      expectedRevision?: number;
    },
  ) {
    return this.mutateConfiguration((journal) => {
    if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw err('egress_configuration_invalid');
    const cur = journal.pools[id];
    if (!cur) throw err("pool_not_found", 404);
    if (patch.expectedRevision !== undefined && patch.expectedRevision !== cur.revision) {
      throw err("pool_revision_conflict", 409);
    }
    const strict = patch.strict ?? cur.strict;
    const allowDirectFallback = patch.allowDirectFallback ?? cur.allowDirectFallback;
    if (strict && allowDirectFallback) throw err("proxy_pool_strict_fallback_conflict");
    const memberIds = patch.memberIds ?? cur.memberIds;
    if (!Array.isArray(memberIds)) throw err('proxy_pool_members_invalid');
    for (const mid of memberIds) {
      if (!journal.proxies[mid]) throw err("proxy_not_found", 404);
    }
    const next: ProxyPoolRecord = {
      ...cur,
      memberIds: [...memberIds],
      strategy: patch.strategy ?? cur.strategy,
      strict,
      allowDirectFallback,
      noProxy: patch.noProxy ?? cur.noProxy,
      healthPolicy: patch.healthPolicy ?? cur.healthPolicy,
      revision: cur.revision + 1,
    };
    checked(parseProxyPool,next);
    journal.pools[id] = next;
    
    return next;
  
    });
  }

  async deletePool(id: string) {
    return this.mutateConfiguration((journal) => {
    if (!journal.pools[id]) throw err("pool_not_found", 404);
    const impacted = Object.entries(journal.bindings)
      .filter(([, b]) => b.poolId === id)
      .map(([k]) => k);
    if (impacted.length) throw err("proxy_in_use", 409, { impactedBindingIds: impacted });
    delete journal.pools[id];
    
  
    });
  }

  getTestJob(id: string) {
    return this.journal.testJobs[id] ?? null;
  }

  selectForDestination(opts: {
    connectionId: string;
    providerId?: string | null;
    deviceId?: string | null;
    destinationHost: string;
    random?: () => number;
  }) {
    let pool: ProxyPoolRecord | null;
    try { pool = this.resolvePoolForConnection(opts.connectionId, opts.providerId, opts.deviceId); }
    catch { return { ok: false as const, code: 'resolution_error' as const, reason: 'proxy_binding_invalid', cursor: null }; }
    const members = new Map<string, ResolveMember>();
    if (pool) {
      for (const mid of pool.memberIds) {
        const p = this.journal.proxies[mid];
        const h = this.journal.health[mid];
        if (!p) continue;
        members.set(mid, {
          id: p.id,
          enabled: p.enabled,
          kind: p.kind,
          endpointUrl: p.endpointUrl,
          healthState: h?.state ?? "unknown",
          nextEligibleAt: h?.nextEligibleAt ?? null,
        });
      }
    }
    const revision = this.configurationRevision;
    const selected = resolveEgress({
      pool,
      members,
      destinationHost: opts.destinationHost,
      persistedCursor: pool ? this.getCursor(pool.id, pool.revision) : null,
      random: opts.random,
    });
    if (selected.ok) this.selectionAuthority.set(selected, () => !this.closed && this.configurationRevision === revision);
    return selected;
  }

  async recordReceipt(receipt: EgressReceiptRecord) {
    if (this.closed) throw err('proxy_test_state_closed', 409);
    if (receipt.finalHost.includes("@")) throw err("egress_receipt_credential_leak");
    this.journal.receipts.push({ ...receipt });
    // Snapshot a burst once, rather than serializing the entire accumulated
    // journal per request. Every caller still waits for durable persistence.
    let batch = this.receiptCommit;
    if (!batch || batch.count >= 64) {
      const next = { count: 0, done: Promise.resolve() };
      next.done = new Promise<void>((resolve) => setImmediate(resolve)).then(async () => {
        if (this.receiptCommit === next) this.receiptCommit = undefined;
        await this.persist(this.journal);
      });
      this.receiptCommit = batch = next;
    }
    batch.count++;
    await batch.done;
    return receipt;
  }

  async createTestJob(input: {
    memberIds: string[];
    approvedTargetId: string;
    operationId: string;
  }) {
    if(this.closed)throw err('proxy_test_state_closed',409);
    if (input.approvedTargetId !== 'connectivity:example') {
      throw err("egress_destination_denied", 403);
    }
    if(!Array.isArray(input.memberIds)||!input.memberIds.length||input.memberIds.length>16||new Set(input.memberIds).size!==input.memberIds.length||typeof input.operationId!=='string'||!/^[A-Za-z0-9_-]{1,100}$/.test(input.operationId))throw err('proxy_test_invalid');
    for(const id of input.memberIds){const proxy=this.journal.proxies[id];if(!proxy||!proxy.enabled)throw err('proxy_not_found',404);if(!['http','https'].includes(proxy.kind)||new URL(proxy.endpointUrl).protocol!==`${proxy.kind}:`)throw err('proxy_test_transport_unsupported',422);}
    const prior=Object.values(this.journal.testJobs).find(job=>job.operationId===input.operationId);
    if(prior){if(prior.approvedTargetId!==input.approvedTargetId||JSON.stringify(prior.memberIds)!==JSON.stringify(input.memberIds))throw err('proxy_test_operation_conflict',409);return prior;}
    const job: ProxyTestJobRecord = {
      id: randomUUID(),
      memberIds: [...input.memberIds],
      approvedTargetId: input.approvedTargetId,
      operationId: input.operationId,
      state: "queued",
      cursor: 0,
    };
    this.journal.testJobs[job.id] = job;
    await this.persist(this.journal);
    const controller=new AbortController();this.tests.set(job.id,controller);
    const work=this.runTest(job,controller).catch(async()=>{if(!controller.signal.aborted)job.state='failed';try{await this.persist(this.journal);}catch{/* no replay after a persistence failure */}}).finally(()=>{this.tests.delete(job.id);this.testWork.delete(job.id);});
    this.testWork.set(job.id,work);
    return job;
  }

  private async runTest(job:ProxyTestJobRecord,controller:AbortController){
    let failed=false;job.state='running';await this.persist(this.journal);
    for(const id of job.memberIds){
      if(controller.signal.aborted)break;
      const proxy=this.journal.proxies[id],started=Date.now();let healthy=false;
      try{
        if(!proxy?.enabled||!['http','https'].includes(proxy.kind)||new URL(proxy.endpointUrl).protocol!==`${proxy.kind}:`)throw err('proxy_test_transport_unsupported');
        const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(5000)]);
        const transport=await this.transportOptions({ok:true,usedDirect:false,member:{...proxy,healthState:'unknown',nextEligibleAt:null},cursor:null,reason:'connectivity_test',poolId:null,poolRevision:null},signal);
        signal.throwIfAborted();
        const response=await this.testRequest('https://example.com/',{method:'HEAD',headers:{'user-agent':'Uptokey-Connectivity/1'},signal,redirect:'error'},transport);
        healthy=response.status>=200&&response.status<300;await response.body?.cancel();
      }catch{/* Report only classification; never echo server bodies or credentials. */}
      if(controller.signal.aborted)break;
      failed||=!healthy;job.cursor++;
      await this.markHealth(id,{state:healthy?'healthy':'degraded',lastTestAt:new Date().toISOString(),latencyMs:Date.now()-started,reason:healthy?'connectivity_ok':'connectivity_failed'});
    }
    if(!controller.signal.aborted){job.state=failed?'failed':'succeeded';await this.persist(this.journal);}
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed=true;
    for(const [id,controller] of this.tests){controller.abort();const job=this.journal.testJobs[id];if(job)job.state='cancelled';}
    // A receipt batch may still be waiting for its I/O turn. Closing the
    // persistence owner before that batch acknowledges causes a late write.
    const receipt = this.receiptCommit?.done;
    this.closing = (async () => {
      await Promise.allSettled(this.testWork.values());
      await receipt;
      await this.persist(this.journal);
    })();
    return this.closing;
  }

  async cancelTestJob(id: string) {
    const job = this.journal.testJobs[id];
    if (!job) throw err("proxy_not_found", 404);
    if (job.state === "succeeded" || job.state === "failed" || job.state === "cancelled") {
      throw err("proxy_test_cancelled", 409);
    }
    const next = { ...job, state: "cancelled" as const };
    this.tests.get(id)?.abort();
    this.journal.testJobs[id] = next;
    await this.persist(this.journal);
    return next;
  }

  async markHealth(memberId: string, patch: Partial<ProxyHealthRecord> & { state: ProxyHealthRecord["state"] }) {
    return this.mutateConfiguration((journal) => {
    const cur = journal.health[memberId] ?? {
      memberId,
      state: "unknown" as const,
      lastTestAt: null,
      latencyMs: null,
      nextEligibleAt: null,
      reason: null,
    };
    const next = { ...cur, ...patch, memberId };
    journal.health[memberId] = next;
    
    return next;
  
    },false);
  }
}
