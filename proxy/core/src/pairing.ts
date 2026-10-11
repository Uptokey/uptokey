import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";
import { normalizeClientName } from "./client-name.ts";
import { parseWorkspacePublicJwk, type BrowserPublicJwk } from "./workspace/browser-session.ts";
import { recordClientEnrollment, registrationKey, type ClientEnrollmentPath } from "./workspace/client-registration.ts";
import { parsePairingAudience, type PairingAudience } from "@uptokey/sync-contract/client-keys";
import {serialClientAuthority} from "./client-authority-lock.ts";
import {browserEnrollmentKey} from "./workspace/browser-enrollment.ts";

export const PAIRING_TTL_MS = 5 * 60 * 1_000;
export const MAX_PENDING_PAIRINGS = 20;

export interface PairingChallenge {
  id: string;
  userCode: string;
  expiresAt: string;
}

interface PendingPairing extends PairingChallenge {
  purpose?: 'context' | 'account';
  context?: ContextPairing;
  account?: AccountPairing;
  browserOrigin?: string;
  clientName: string;
  audience: PairingAudience | 'pwa';
  approved: boolean;
  deadline: number;
}

/** Context approval carries server-derived authority, never recipient-supplied ownership. */
export interface ContextPairingApproval {
  ownerPrincipalId: string;
  ownerClientId: string | null;
  ownerAdminDigest: string | null;
  ownerPolicyRevision: number | null;
  ownerRegistrationRevision: number | null;
  projectId: string;
  conversationId: string;
}
export interface ContextPairing {
  recipientClientId: string;
  recipientKeyId: string;
  epoch: string;
  expectedBindingRevision: number;
  approval?: ContextPairingApproval;
}

export interface AccountPairingApproval {
  ownerPrincipalId: string;
  ownerAuthorityDigest: string;
  accountRef: string;
}
export interface AccountPairing {
  recipientPrincipalId: string;
  recipientAuthorityDigest: string;
  expectedGrantRevision: number;
  approval?: AccountPairingApproval;
}

export interface PairedClient {
  clientId: string;
  clientName: string;
  scope: "inference";
  token: string;
}

export interface RotatedClientToken {
  clientId: string;
  scope: "inference";
  token: string;
}

export class PairingService {
  private readonly pending = new Map<string, PendingPairing>();
  private operationQueue: Promise<unknown> = Promise.resolve();
  private readonly secrets: SecretStore;
  private readonly now: () => number;
  private readonly wallNow: () => number;

  constructor(secrets: SecretStore, now: () => number = performance.now.bind(performance), wallNow: () => number = Date.now) {
    this.secrets = secrets;
    this.now = now;
    this.wallNow = wallNow;
  }

  create(clientName: string, audience: PairingAudience = "legacy", browserOrigin?: string): PairingChallenge {
    const admittedAudience = parsePairingAudience(audience);
    if (browserOrigin !== undefined && (admittedAudience !== 'browser-extension' || !/^chrome-extension:\/\/[a-p]{32}$/.test(browserOrigin))) throw new Error('pairing_origin_invalid');
    this.pruneExpired();
    if (this.pending.size >= MAX_PENDING_PAIRINGS) throw new Error("pairing_capacity_exceeded");
    const normalizedName = normalizeClientName(clientName);
    if (!normalizedName) throw new Error("pairing_client_name_required");
    const observed = this.now(); const wall = this.wallNow();
    if (!Number.isFinite(observed) || observed < 0 || !Number.isSafeInteger(wall) || wall < 0 || wall + PAIRING_TTL_MS > 8_640_000_000_000_000) throw new Error("pairing_clock_invalid");
    const challenge: PendingPairing = {
      id: randomUUID(),
      userCode: randomBytes(4).toString("hex").toUpperCase(),
      clientName: normalizedName,
      audience: admittedAudience,
      ...(browserOrigin ? { browserOrigin } : {}),
      expiresAt: new Date(wall + PAIRING_TTL_MS).toISOString(),
      approved: false,
      deadline: observed + PAIRING_TTL_MS
    };
    this.pending.set(challenge.id, challenge);
    return this.publicChallenge(challenge);
  }

  approve(id: string, userCode: string, audience: PairingAudience = "legacy"): boolean {
    const approvedAudience = parsePairingAudience(audience);
    const challenge = this.active(id);
    if (!challenge || challenge.purpose || challenge.audience !== approvedAudience || !safeCodeEqual(challenge.userCode, userCode.trim().toUpperCase())) return false;
    challenge.approved = true;
    return true;
  }

  createContextLink(context: Omit<ContextPairing, 'approval'>): PairingChallenge {
    const publicValue = this.create('Workspace context', 'tauri');
    const pending = this.pending.get(publicValue.id)!;
    pending.purpose = 'context';
    pending.context = { ...context };
    return publicValue;
  }

  approveContextLink(id: string, userCode: string, approval: ContextPairingApproval): boolean {
    const pending = this.active(id);
    if (!pending || pending.purpose !== 'context' || !pending.context || pending.approved ||
      pending.context.recipientClientId === approval.ownerClientId ||
      !safeCodeEqual(pending.userCode, userCode.trim().toUpperCase())) return false;
    pending.context.approval = { ...approval };
    pending.approved = true;
    return true;
  }

  async consumeContextLink<T>(id: string, recipientClientId: string, complete: (context: ContextPairing) => Promise<T>): Promise<T | undefined> {
    return this.exclusive(async () => {
      const pending = this.active(id);
      if (!pending || pending.purpose !== 'context' || !pending.approved ||
        !pending.context?.approval || pending.context.recipientClientId !== recipientClientId) return undefined;
      // A context challenge cannot mint a credential through ordinary pairing, and is one-use even on a failed commit.
      this.pending.delete(id);
      return complete({ ...pending.context, approval: { ...pending.context.approval } });
    });
  }

  createAccountLink(account: Omit<AccountPairing, 'approval'>, clientName: string, audience: PairingAudience | 'pwa'): PairingChallenge {
    const publicValue = this.create(clientName, audience === 'pwa' ? 'tauri' : audience);
    const pending = this.pending.get(publicValue.id)!;
    pending.purpose = 'account';
    pending.audience = audience;
    pending.account = { ...account };
    return publicValue;
  }

  accountRequests(excludePrincipal?: string): Array<PairingChallenge & {clientName: string; audience: PairingAudience | 'pwa'}> {
    this.pruneExpired();
    return [...this.pending.values()].filter(row => row.purpose === 'account' && !row.approved && row.account?.recipientPrincipalId !== excludePrincipal)
      .map(row => ({ ...this.publicChallenge(row), clientName: row.clientName, audience: row.audience }));
  }

  approveAccountLink(id: string, userCode: string, approval: AccountPairingApproval): boolean {
    const pending = this.active(id);
    if (!pending || pending.purpose !== 'account' || !pending.account || pending.approved ||
      pending.account.recipientPrincipalId === approval.ownerPrincipalId ||
      !safeCodeEqual(pending.userCode, userCode.trim().toUpperCase())) return false;
    pending.account.approval = { ...approval };
    pending.approved = true;
    return true;
  }

  async consumeAccountLink<T>(id: string, recipientPrincipalId: string, complete: (account: AccountPairing) => Promise<T>): Promise<T | undefined> {
    return this.exclusive(async () => {
      const pending = this.active(id);
      if (!pending || pending.purpose !== 'account' || !pending.approved ||
        !pending.account?.approval || pending.account.recipientPrincipalId !== recipientPrincipalId) return undefined;
      this.pending.delete(id);
      return complete({ ...pending.account, approval: { ...pending.account.approval } });
    });
  }

  /**
   * Concludes an approved pairing. When the client presents `publicJwk` (EC P-256),
   * the key is enrolled as that client's workspace consent key — the same record the
   * browser session flow writes. The pairing approval (userCode on the trusted CLI)
   * is the human gesture that authorizes enrollment; later consents are per-plan
   * signatures bound to principal/project/plan digest.
   */
  async consume(id: string, publicJwk?: unknown, browserOrigin?: string): Promise<PairedClient | undefined> {
    const key = publicJwk === undefined ? undefined : parseWorkspacePublicJwk(publicJwk);
    return this.exclusive(async () => {
      const challenge = this.active(id);
      if (!challenge?.approved || challenge.purpose || challenge.browserOrigin !== browserOrigin) return undefined;
      const paired = await provisionClient(this.secrets, challenge.clientName, undefined, "pairing", parsePairingAudience(challenge.audience), key, browserOrigin);
      if(key&&browserOrigin&&challenge.audience==='browser-extension') {
        try {
          await serialClientAuthority(this.secrets,'browser-enrollment:'+browserEnrollmentKey(browserOrigin,key),async()=>{
            const index=browserEnrollmentKey(browserOrigin,key);
            const previous=await this.secrets.get(index);
            if(previous&&await this.secrets.get('local:client:'+previous))throw Error('browser_identity_already_paired');
            await this.secrets.set('local:client:'+paired.clientId+':expires',new Date(Date.now()+12*60*60*1000).toISOString());
            await this.secrets.set(index,paired.clientId);
          });
        } catch(error) {await revokePairedClientAsAdministrator(this.secrets,paired.clientId);throw error;}
      }
      this.pending.delete(id);
      return paired;
    });
  }

  async revoke(clientId: string, expectedToken: string): Promise<boolean> {
    return this.exclusive(() => serialClientAuthority(this.secrets,`client:${clientId}`,async () => {
      const account = `local:client:${clientId}`; const current = await this.secrets.get(account);
      if (!current || !safeTokenEqual(current, expectedToken)) return false;
      await this.secrets.delete(account);
      await this.secrets.delete(`${account}:expires`);
      await this.secrets.delete(`${account}:name`);
      await this.secrets.delete(`${account}:workspace-key`);
      await this.secrets.delete(registrationKey(clientId));
      return true;
    }));
  }

  async rotate(clientId: string, expectedToken: string): Promise<RotatedClientToken | undefined> {
    return this.exclusive(() => serialClientAuthority(this.secrets,`client:${clientId}`,async () => {
      const account = `local:client:${clientId}`; const current = await this.secrets.get(account);
      if (!current || !safeTokenEqual(current, expectedToken)) return undefined;
      const token = `utk_local_${clientId}.${randomBytes(24).toString("base64url")}`;
      try { await this.secrets.set(account, token); }
      catch (rotationError) {
        try { await this.secrets.set(account, current); }
        catch (rollbackError) { throw new AggregateError([rotationError, rollbackError], "client_rotation_rollback_failed"); }
        throw rotationError;
      }
      return { clientId, scope: "inference", token };
    }));
  }

  private exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.operationQueue.then(operation, operation); this.operationQueue = next.then(() => undefined, () => undefined); return next;
  }

  private active(id: string): PendingPairing | undefined {
    const challenge = this.pending.get(id);
    if (!challenge) return undefined;
    if (challenge.deadline <= this.now()) {
      this.pending.delete(id);
      return undefined;
    }
    return challenge;
  }

  private pruneExpired(): void {
    for (const [id, challenge] of this.pending) {
      if (challenge.deadline <= this.now()) this.pending.delete(id);
    }
  }

  private publicChallenge(challenge: PendingPairing): PairingChallenge {
    return { id: challenge.id, userCode: challenge.userCode, expiresAt: challenge.expiresAt };
  }
}

export async function provisionPairedClient(secrets: SecretStore, clientName: string, ttlMs?: number, enrolledVia: ClientEnrollmentPath = "provision", audience: PairingAudience = "legacy"): Promise<PairedClient> {
  return provisionClient(secrets, clientName, ttlMs, enrolledVia, audience);
}

/** Activate last: native vaults do not provide a transaction across these records. */
async function provisionClient(secrets: SecretStore, clientName: string, ttlMs: number | undefined, enrolledVia: ClientEnrollmentPath, audience: PairingAudience, workspaceKey?: BrowserPublicJwk, browserOrigin?: string): Promise<PairedClient> {
  const admittedAudience = parsePairingAudience(audience);
  // The terminal audience is key-bound: W5 consent needs the enrolled P-256 key, and a bearer
  // alone must not become a TUI identity. Checked before any vault write.
  if (admittedAudience === "tui" && !workspaceKey) throw new Error("pairing_key_required");
  const normalizedName = normalizeClientName(clientName);
  if (!normalizedName) throw new Error("pairing_client_name_required");
  if (ttlMs !== undefined && (!Number.isSafeInteger(ttlMs) || ttlMs < 60_000 || ttlMs > 24 * 60 * 60 * 1_000)) throw new Error("pairing_ttl_invalid");
  const expiresAt = ttlMs === undefined ? undefined : new Date(Date.now() + ttlMs).toISOString();
  const clientId = randomUUID();
  const token = `utk_local_${clientId}.${randomBytes(24).toString("base64url")}`;
  const account = `local:client:${clientId}`;
  const attempted: string[] = [];
  const write = async (key: string, value: string) => {
    // A native store may persist and then reject; include that write in compensation.
    attempted.push(key);
    await secrets.set(key, value);
  };
  try {
    await write(`${account}:name`, normalizedName);
    attempted.push(registrationKey(clientId));
    await recordClientEnrollment(secrets, { clientId, audience: admittedAudience, enrolledVia, ...(browserOrigin ? { browserOrigin } : {}) });
    if (expiresAt) await write(`${account}:expires`, expiresAt);
    if (workspaceKey) await write(`${account}:workspace-key`, JSON.stringify(workspaceKey));
    await write(account, token);
  } catch (error) {
    if (attempted.includes(account)) {
      try { await secrets.delete(account); }
      catch (revocationError) {
        // Retain authorization metadata when removal cannot be confirmed. An expiry
        // fence also denies the token if the vault can still accept a metadata write.
        try { await secrets.set(`${account}:expires`, new Date(0).toISOString()); }
        catch (fenceError) { throw new AggregateError([error, revocationError, fenceError], "client_provision_rollback_failed"); }
        throw new AggregateError([error, revocationError], "client_provision_cleanup_required");
      }
    }
    const cleanup = await Promise.allSettled(attempted.filter((key) => key !== account).map((key) => secrets.delete(key)));
    const failures = cleanup.filter((result): result is PromiseRejectedResult => result.status === "rejected");
    if (failures.length) throw new AggregateError([error, ...failures.map((result) => result.reason)], "client_provision_rollback_failed");
    throw error;
  }
  return { clientId, clientName: normalizedName, scope: "inference", token };
}

/** Binds a workspace consent key to an already-issued client identity. */
export async function enrollWorkspaceKey(secrets: SecretStore, clientId: string, key: BrowserPublicJwk): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) throw new Error("pairing_client_id_invalid");
  await secrets.set(`local:client:${clientId}:workspace-key`, JSON.stringify(key));
}

export async function revokePairedClientAsAdministrator(secrets: SecretStore, clientId: string): Promise<void> {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(clientId)) throw new Error("pairing_client_id_invalid");
  await serialClientAuthority(secrets,`client:${clientId}`,async()=>{
    await secrets.delete(`local:client:${clientId}`);
    await secrets.delete(`local:client:${clientId}:expires`);
    await secrets.delete(`local:client:${clientId}:name`);
    await secrets.delete(`local:client:${clientId}:workspace-key`);
    await secrets.delete(registrationKey(clientId));
  });
}

function safeCodeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  if (left.length !== right.length) {
    timingSafeEqual(left, left);
    return false;
  }
  return timingSafeEqual(left, right);
}

function safeTokenEqual(a: string, b: string): boolean {
  const left = Buffer.from(a); const right = Buffer.from(b);
  if (left.length !== right.length) { timingSafeEqual(left, left); return false; }
  return timingSafeEqual(left, right);
}
