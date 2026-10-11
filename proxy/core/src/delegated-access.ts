import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";

/** Proposed canonical model from etapa 12 — promote without inventing a second vault. */
export interface DelegatedAccess {
  id: string;
  principalId: string;
  projectIds: string[];
  scopes: string[];
  credentialRef: `delegated:${string}`;
  policyRevision: number;
  expiresAt: string;
  revokedAt: string | null;
  /** Opaque membership/tenant binding; never a BYOK key. */
  membershipId: string;
  tenantId: string;
  label: string;
}

export type DelegatedAccessError =
  | "membership_inactive"
  | "scope_denied"
  | "delegated_access_revoked"
  | "delegated_access_expired"
  | "delegated_access_not_found"
  | "policy_revision_conflict"
  | "project_denied"
  | "credential_invalid"
  | "reveal_unavailable"
  | "reveal_expired";

export interface MembershipView {
  membershipId: string;
  tenantId: string;
  principalId: string;
  active: boolean;
  role: "owner" | "admin" | "member";
}

export interface IssueDelegatedAccessInput {
  principalId: string;
  membershipId: string;
  tenantId: string;
  projectIds: string[];
  scopes: string[];
  policyRevision: number;
  ttlMs: number;
  label: string;
}

export interface AuthorizeDelegatedInput {
  credentialToken: string;
  projectId: string;
  scope: string;
  expectedPolicyRevision?: number;
  now?: Date;
}

export type AuthorizeDelegatedResult =
  | { ok: true; access: DelegatedAccess }
  | { ok: false; code: DelegatedAccessError; status: 403 | 404 | 409 };

export interface RevealHandle {
  accessId: string;
  token: string;
  expiresAt: string;
}

const TOKEN_PREFIX = "utk_virt_";
const REVEAL_TTL_MS = 60_000;
const ID = /^[A-Za-z0-9_-]{3,100}$/;
const SCOPE = /^[a-z][a-z0-9_:-]{0,63}$/;

function digest(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function same(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function safeId(value: unknown): value is string {
  return typeof value === "string" && ID.test(value);
}

function utcMs(value: string): number | undefined {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

/**
 * Issues virtual inference credentials bound to membership ∩ project ∩ scope.
 * Token plaintext is revealed at most once via reveal(); never logged or exported.
 */
export class DelegatedAccessService {
  private readonly records = new Map<string, DelegatedAccess>();
  private readonly reveal = new Map<string, { token: string; expiresAt: number }>();
  private readonly secrets: SecretStore;
  private readonly resolveMembership: (membershipId: string, tenantId: string) => Promise<MembershipView | undefined>;
  private readonly now: () => number;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(
    secrets: SecretStore,
    resolveMembership: (membershipId: string, tenantId: string) => Promise<MembershipView | undefined>,
    now: () => number = Date.now,
  ) {
    this.secrets = secrets;
    this.resolveMembership = resolveMembership;
    this.now = now;
  }

  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.then(() => undefined, () => undefined);
    return run;
  }

  listForPrincipal(principalId: string): DelegatedAccess[] {
    return [...this.records.values()]
      .filter((item) => item.principalId === principalId)
      .map((item) => ({ ...item, projectIds: [...item.projectIds], scopes: [...item.scopes] }));
  }

  get(id: string): DelegatedAccess | undefined {
    const item = this.records.get(id);
    return item ? { ...item, projectIds: [...item.projectIds], scopes: [...item.scopes] } : undefined;
  }

  /** Metadata export — never includes token plaintext. */
  exportAudit(): Array<Omit<DelegatedAccess, never> & { credentialPresent: boolean }> {
    return [...this.records.values()].map((item) => ({
      ...item,
      projectIds: [...item.projectIds],
      scopes: [...item.scopes],
      credentialPresent: true,
    }));
  }

  async issue(input: IssueDelegatedAccessInput): Promise<{ access: DelegatedAccess; reveal: RevealHandle }> {
    return this.exclusive(async () => {
      if (!safeId(input.principalId) || !safeId(input.membershipId) || !safeId(input.tenantId)) {
        throw new Error("delegated_access_identity_invalid");
      }
      if (!Array.isArray(input.projectIds) || input.projectIds.length < 1 || input.projectIds.length > 32 || !input.projectIds.every(safeId)) {
        throw new Error("delegated_access_projects_invalid");
      }
      if (!Array.isArray(input.scopes) || input.scopes.length < 1 || input.scopes.length > 16 || !input.scopes.every((s) => typeof s === "string" && SCOPE.test(s))) {
        throw new Error("delegated_access_scopes_invalid");
      }
      // Inference credential must never include admin scopes.
      if (input.scopes.some((s) => s.startsWith("admin:") || s === "workspace:approve")) {
        throw new Error("delegated_access_scope_forbidden");
      }
      if (!Number.isSafeInteger(input.policyRevision) || input.policyRevision < 1) throw new Error("delegated_access_policy_invalid");
      if (!Number.isSafeInteger(input.ttlMs) || input.ttlMs < 60_000 || input.ttlMs > 30 * 24 * 60 * 60_000) throw new Error("delegated_access_ttl_invalid");
      if (typeof input.label !== "string" || input.label.length < 1 || input.label.length > 80) throw new Error("delegated_access_label_invalid");

      const membership = await this.resolveMembership(input.membershipId, input.tenantId);
      if (!membership || !membership.active || membership.principalId !== input.principalId || membership.tenantId !== input.tenantId) {
        throw Object.assign(new Error("membership_inactive"), { code: "membership_inactive" as const, status: 403 });
      }

      const id = `da_${randomBytes(12).toString("base64url")}`;
      const token = `${TOKEN_PREFIX}${randomBytes(24).toString("base64url")}`;
      const credentialRef = `delegated:${id}` as const;
      const created = this.now();
      const access: DelegatedAccess = {
        id,
        principalId: input.principalId,
        projectIds: [...new Set(input.projectIds)],
        scopes: [...new Set(input.scopes)],
        credentialRef,
        policyRevision: input.policyRevision,
        expiresAt: new Date(created + input.ttlMs).toISOString(),
        revokedAt: null,
        membershipId: input.membershipId,
        tenantId: input.tenantId,
        label: input.label,
      };
      await this.secrets.set(credentialRef, digest(token));
      this.records.set(id, access);
      const revealExpires = created + REVEAL_TTL_MS;
      this.reveal.set(id, { token, expiresAt: revealExpires });
      return {
        access: { ...access, projectIds: [...access.projectIds], scopes: [...access.scopes] },
        reveal: { accessId: id, token, expiresAt: new Date(revealExpires).toISOString() },
      };
    });
  }

  /**
   * One-shot reveal for the issuing user. Closing/expiry clears plaintext from memory.
   * Reloading after clear cannot recover the token.
   */
  takeReveal(accessId: string, now = this.now()): RevealHandle | { error: DelegatedAccessError } {
    const pending = this.reveal.get(accessId);
    if (!pending) return { error: "reveal_unavailable" };
    if (pending.expiresAt <= now) {
      this.reveal.delete(accessId);
      return { error: "reveal_expired" };
    }
    this.reveal.delete(accessId);
    return { accessId, token: pending.token, expiresAt: new Date(pending.expiresAt).toISOString() };
  }

  clearReveal(accessId: string): void {
    this.reveal.delete(accessId);
  }

  hasPendingReveal(accessId: string): boolean {
    return this.reveal.has(accessId);
  }

  async revoke(accessId: string, expectedRevision: number): Promise<{ outcome: "revoked" | "already_revoked"; access: DelegatedAccess } | { error: DelegatedAccessError; status: 404 | 409 }> {
    return this.exclusive(async () => {
      const current = this.records.get(accessId);
      if (!current) return { error: "delegated_access_not_found", status: 404 };
      if (current.policyRevision !== expectedRevision) return { error: "policy_revision_conflict", status: 409 };
      if (current.revokedAt) {
        return { outcome: "already_revoked", access: { ...current, projectIds: [...current.projectIds], scopes: [...current.scopes] } };
      }
      const next: DelegatedAccess = {
        ...current,
        policyRevision: current.policyRevision + 1,
        revokedAt: new Date(this.now()).toISOString(),
      };
      this.records.set(accessId, next);
      this.reveal.delete(accessId);
      // Keep digest so authorize can classify as revoked (not opaque credential_invalid).
      // Plaintext was never stored; BYOK never touched.
      return { outcome: "revoked", access: { ...next, projectIds: [...next.projectIds], scopes: [...next.scopes] } };
    });
  }

  async authorize(input: AuthorizeDelegatedInput): Promise<AuthorizeDelegatedResult> {
    const token = input.credentialToken;
    if (typeof token !== "string" || !token.startsWith(TOKEN_PREFIX) || token.length > 200) {
      return { ok: false, code: "credential_invalid", status: 403 };
    }
    const now = (input.now ?? new Date()).getTime();
    for (const access of this.records.values()) {
      const hash = await this.secrets.get(access.credentialRef);
      if (!hash || !same(hash, digest(token))) continue;

      if (access.revokedAt) return { ok: false, code: "delegated_access_revoked", status: 403 };
      const expires = utcMs(access.expiresAt);
      if (expires === undefined || expires <= now) return { ok: false, code: "delegated_access_expired", status: 403 };

      const membership = await this.resolveMembership(access.membershipId, access.tenantId);
      if (!membership || !membership.active || membership.principalId !== access.principalId) {
        return { ok: false, code: "membership_inactive", status: 403 };
      }
      if (!access.projectIds.includes(input.projectId)) return { ok: false, code: "project_denied", status: 403 };
      if (!access.scopes.includes(input.scope)) return { ok: false, code: "scope_denied", status: 403 };
      if (input.expectedPolicyRevision !== undefined && input.expectedPolicyRevision !== access.policyRevision) {
        return { ok: false, code: "policy_revision_conflict", status: 409 };
      }
      // Re-check revocation after async membership (etapa 12: revoke between prepare and dispatch).
      const fresh = this.records.get(access.id);
      if (!fresh || fresh.revokedAt) return { ok: false, code: "delegated_access_revoked", status: 403 };
      if (fresh.policyRevision !== access.policyRevision) return { ok: false, code: "policy_revision_conflict", status: 409 };

      return {
        ok: true,
        access: { ...fresh, projectIds: [...fresh.projectIds], scopes: [...fresh.scopes] },
      };
    }
    return { ok: false, code: "credential_invalid", status: 403 };
  }

  /** Canaries for accidental plaintext leakage in metadata/export payloads. */
  static assertNoTokenLeak(payload: unknown): void {
    const text = JSON.stringify(payload);
    if (text.includes(TOKEN_PREFIX)) throw new Error("delegated_token_leaked");
  }
}

/** Production adapter: inference credentials reuse the canonical client-key owner. */
export class LocalDelegatedKeys {
 private queue:Promise<unknown>=Promise.resolve();
 constructor(privateStore: SecretStore, governance: import('./workspace/governance-store.ts').GovernanceStore, projectExists:(owner:string,id:string)=>Promise<void>,listProjects:(owner:string)=>Promise<Array<{id:string;name:string}>>) {this.listProjects=listProjects;this.secrets=privateStore;this.governance=governance;this.projectExists=projectExists;}
 private listProjects:(owner:string)=>Promise<Array<{id:string;name:string}>>;
 async catalog(owner:string){const {workspaces}=await this.governance.listWorkspaces(owner);const entries=[];for(const ws of workspaces){if(ws.ownerPrincipalId!==owner||ws.archivedAt)continue;const projects=[];for(const p of await this.listProjects(owner)){if(await this.governance.getProjectWorkspace(p.id)===ws.id)projects.push(p);}entries.push({id:ws.id,name:ws.name,members:(await this.governance.listMembers(owner,ws.id)).filter(m=>m.role!=="viewer").map(m=>({id:m.memberId,role:m.role})),projects});}return entries;}
 private secrets:SecretStore;
 private governance:import('./workspace/governance-store.ts').GovernanceStore;
 private projectExists:(owner:string,id:string)=>Promise<void>;
 async list(owner:string){const {listClientKeys,loadClientPolicy}=await import('./client-keys.ts');const result=[];let cursor:string|undefined;do{const page=await listClientKeys(this.secrets,100,cursor);for(const view of page.keys){const loaded=await loadClientPolicy(this.secrets,view.id);if(loaded?.meta.delegation?.ownerPrincipalId===owner)result.push({...view,delegation:loaded.meta.delegation});}cursor=page.nextCursor??undefined;}while(cursor);return result;}
 async issue(owner:string,input:{workspaceId:string;memberId:string;projectIds:string[];scopes:import('@uptokey/sync-contract/client-keys').ClientKeyScope[];label:string;expiresAt:string;operationId:string}){
 const run=this.queue.then(async()=>{
 if(!input||!safeId(input.workspaceId)||!safeId(input.memberId)||!Array.isArray(input.projectIds)||input.projectIds.length<1||input.projectIds.length>32||!input.projectIds.every(safeId)||!Array.isArray(input.scopes)||!input.scopes.length||input.scopes.some(s=>!['inference:chat','inference:responses','inference:messages'].includes(s))||!/^[0-9a-f-]{36}$/i.test(input.operationId)||typeof input.expiresAt!=='string'||!Number.isFinite(Date.parse(input.expiresAt))||Date.parse(input.expiresAt)<=Date.now()||Date.parse(input.expiresAt)>Date.now()+30*86400000)throw Error('delegated_input_invalid');
 const workspace=await this.governance.getWorkspace(owner,input.workspaceId);if(workspace.ownerPrincipalId!==owner||workspace.archivedAt)throw Error('workspace_forbidden');
 const member=(await this.governance.listMembers(owner,input.workspaceId)).find(m=>m.memberId===input.memberId&&m.state==='active');if(!member||member.role==='viewer')throw Error('membership_inactive');
 for(const id of input.projectIds){await this.projectExists(owner,id);if(await this.governance.getProjectWorkspace(id)!==input.workspaceId)throw Error('project_denied');}
 const {createClientKey}=await import('./client-keys.ts');return createClientKey(this.secrets,{...input,principalId:input.memberId,delegation:{ownerPrincipalId:owner,workspaceId:input.workspaceId,memberId:input.memberId,projectIds:input.projectIds,scopes:input.scopes,expiresAt:input.expiresAt}});
 });this.queue=run.catch(()=>undefined);return run;
 }
 async revoke(owner:string,id:string,revision:number,operationId:string){const keys=await this.list(owner);if(!keys.some(k=>k.id===id))throw Error('delegated_access_not_found');const {revokeClientKey}=await import('./client-keys.ts');return revokeClientKey(this.secrets,id,revision,operationId);}
 async authorize(client:import('./client-keys.ts').ResolvedClient,projectId:string|undefined,model?:string,providers?:string[]):Promise<string[]|undefined>{
 const d=client.delegation,p=client.policy;if(!d)return undefined;
 if(!p||p.principalId!==d.memberId||!projectId||!d.projectIds.includes(projectId)||!p.projectIds.includes(projectId)||p.scopes.some(s=>!d.scopes.includes(s))||Date.parse(d.expiresAt)<=Date.now())throw Error('project_denied');
 const ws=await this.governance.getWorkspace(d.ownerPrincipalId,d.workspaceId);if(ws.archivedAt||ws.ownerPrincipalId!==d.ownerPrincipalId)throw Error('workspace_forbidden');
 const member=(await this.governance.listMembers(d.ownerPrincipalId,d.workspaceId)).find(m=>m.memberId===d.memberId&&m.state==='active');if(!member||member.role==='viewer')throw Error('membership_inactive');
 await this.projectExists(d.ownerPrincipalId,projectId);if(await this.governance.getProjectWorkspace(projectId)!==d.workspaceId)throw Error('project_denied');
 const decision=await this.governance.getEffectivePolicy(d.memberId,d.workspaceId,{memberId:d.memberId,keyId:p.id,projectId,model});if(!decision.allowed)throw Error('scope_denied');
 if(!providers)return undefined;const allowed=[];for(const provider of providers){if(p.providerIds.length&&!p.providerIds.includes(provider))continue;const check=await this.governance.getEffectivePolicy(d.memberId,d.workspaceId,{memberId:d.memberId,keyId:p.id,projectId,model,provider});if(check.allowed)allowed.push(provider);}return allowed;
 }
}
