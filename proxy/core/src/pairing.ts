import { createHash, createPublicKey, randomBytes, randomUUID, timingSafeEqual, verify } from "node:crypto";
import type { SecretStore } from "./secret-store.ts";
import { normalizeClientName } from "./client-name.ts";
import { parseWorkspacePublicJwk, type BrowserPublicJwk } from "./workspace/browser-session.ts";
import { recordClientEnrollment, registrationKey, type ClientEnrollmentPath } from "./workspace/client-registration.ts";
import { parsePairingAudience, type PairingAudience } from "@uptokey/sync-contract/client-keys";
import {serialClientAuthority} from "./client-authority-lock.ts";
import {browserEnrollmentKey,isPublicPwaOrigin} from "./workspace/browser-enrollment.ts";

export const PAIRING_TTL_MS = 5 * 60 * 1_000;
export const MAX_PENDING_PAIRINGS = 20;
const SIGNED_APPROVAL_WAIT_MS = 8_000;

export interface PairingChallenge {
  id: string;
  userCode: string;
  expiresAt: string;
  /** Present only for explicit public-PWA pairing; signed by its admitted key. */
  nonce?: string;
}
export type BrowserApprovalChoice = { id: string; userCode: string; origin: string; audience?: 'browser-extension' | 'vscode' };
export type BrowserApprovalOffer = { status: 'none' | 'multiple' } |
  { status: 'pending' } & BrowserApprovalChoice | { status: 'choices'; choices: BrowserApprovalChoice[] };

interface PendingPairing extends PairingChallenge {
  purpose?: 'context' | 'account';
  context?: ContextPairing;
  account?: AccountPairing;
  browserOrigin?: string;
  publicJwk?: BrowserPublicJwk;
  clientName: string;
  audience: PairingAudience | 'pwa';
  approved: boolean;
  deadline: number;
  approvalWaiter?: (approved: boolean) => void;
  resumableBrowserChallenge?: true;
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

  findUnapprovedBrowserChallenge(origin:string, publicJwk:unknown):PairingChallenge|undefined {
    if(!isPublicPwaOrigin(origin))return undefined;
    const key=JSON.stringify(parseWorkspacePublicJwk(publicJwk));
    this.pruneExpired();
    const pending=[...this.pending.values()].find(row=>row.resumableBrowserChallenge&&!row.approved&&
      row.browserOrigin===origin&&JSON.stringify(row.publicJwk)===key);
    return pending?this.publicChallenge(pending):undefined;
  }

  browserApprovalOffer(includeChoices = false, includeExtensions = false, includeEditor = false): BrowserApprovalOffer {
    this.pruneExpired();
    const choices: BrowserApprovalChoice[] = [];
    for (const pending of this.pending.values()) {
      if (pending.approved || pending.purpose) continue;
      const origin = pending.browserOrigin;
      if (pending.audience === 'pwa' && isPublicPwaOrigin(origin)) {
        choices.push({ id: pending.id, userCode: pending.userCode, origin });
      } else if (includeExtensions && pending.audience === 'browser-extension' &&
          origin && /^chrome-extension:\/\/[a-p]{32}$/.test(origin)) {
        choices.push({ id: pending.id, userCode: pending.userCode, origin, audience: 'browser-extension' });
      } else if (includeEditor && pending.audience === 'vscode' && !origin && pending.publicJwk && pending.nonce) {
        choices.push({ id: pending.id, userCode: pending.userCode, origin: 'local-vscode', audience: 'vscode' });
      }
    }
    if (!choices.length) return { status: 'none' };
    if (choices.length === 1) return { status: 'pending', ...choices[0]! };
    if (!includeChoices || new Set(choices.map(choice => choice.userCode)).size !== choices.length) return { status: 'multiple' };
    return { status: 'choices', choices };
  }

  create(clientName: string, audience: PairingAudience = "legacy", browserOrigin?: string, publicJwk?: unknown, resumableBrowserChallenge=false): PairingChallenge {
    const admittedAudience = parsePairingAudience(audience);
    if (admittedAudience === 'pwa' && !isPublicPwaOrigin(browserOrigin) || browserOrigin !== undefined && !(
      admittedAudience === 'browser-extension' && /^chrome-extension:\/\/[a-p]{32}$/.test(browserOrigin) || admittedAudience === 'pwa' && isPublicPwaOrigin(browserOrigin)
    )) throw new Error('pairing_origin_invalid');
    if (publicJwk !== undefined && admittedAudience !== 'pwa' && admittedAudience !== 'vscode' &&
        !(admittedAudience === 'browser-extension' && browserOrigin)) throw Error('pairing_key_invalid');
    if (admittedAudience === 'pwa' && publicJwk === undefined) throw Error('pairing_key_required');
    const key = publicJwk === undefined ? undefined : parseWorkspacePublicJwk(publicJwk);
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
      ...(key ? { publicJwk: key } : {}),
      ...(key&&resumableBrowserChallenge?{resumableBrowserChallenge:true as const}:{}),
      expiresAt: new Date(wall + PAIRING_TTL_MS).toISOString(),
      approved: false,
      deadline: observed + PAIRING_TTL_MS
    };
    if (key) {
      const domain = admittedAudience === 'pwa' ? 'uptokey-public-pwa-pairing-v1' :
        admittedAudience === 'browser-extension' ? 'uptokey-extension-pairing-v1' : 'uptokey-vscode-pairing-v1';
      const binding = createHash('sha256').update(JSON.stringify([admittedAudience, browserOrigin, key])).digest('hex');
      challenge.nonce = `${domain}:${challenge.id}:${binding}:${randomBytes(32).toString('base64url')}`;
    }
    this.pending.set(challenge.id, challenge);
    return this.publicChallenge(challenge);
  }

  approve(id: string, userCode: string, audience: PairingAudience = "legacy"): boolean {
    const approvedAudience = parsePairingAudience(audience);
    const challenge = this.active(id);
    if (!challenge || challenge.purpose || challenge.audience !== approvedAudience || !safeCodeEqual(challenge.userCode, userCode.trim().toUpperCase())) return false;
    challenge.approved = true;
    challenge.approvalWaiter?.(true);
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
  async consume(id: string, publicJwk?: unknown, browserOrigin?: string, signature?: unknown, approvalSignal?: AbortSignal): Promise<PairedClient | undefined> {
    const key = publicJwk === undefined ? undefined : parseWorkspacePublicJwk(publicJwk);
    if (approvalSignal && !await this.waitForBoundApproval(id, key, browserOrigin, signature, approvalSignal, 'pwa')) return undefined;
    return this.exclusive(async () => {
      if (approvalSignal?.aborted) return undefined;
      const challenge = this.active(id);
      if (!challenge?.approved || challenge.purpose || challenge.browserOrigin !== browserOrigin) return undefined;
      if(challenge.publicJwk) {
        this.assertPublicProof(challenge, key, signature);
      }else if(signature!==undefined)throw Error('pairing_proof_invalid');
      const paired = await provisionClient(this.secrets, challenge.clientName, challenge.audience==='pwa'?12*60*60*1000:undefined, "pairing", parsePairingAudience(challenge.audience), key, browserOrigin);
      if(key&&browserOrigin&&(challenge.audience==='browser-extension'||challenge.audience==='pwa')) {
        let enrolled: boolean;
        try {
          const index=browserEnrollmentKey(browserOrigin,key);
          enrolled=await serialClientAuthority(this.secrets,'browser-enrollment:'+index,async()=>{
            if(approvalSignal?.aborted)return false;
            const previous=await this.secrets.get(index);
            if(previous&&await this.secrets.get('local:client:'+previous))throw Error('browser_identity_already_paired');
            await this.secrets.set('local:client:'+paired.clientId+':expires',new Date(Date.now()+12*60*60*1000).toISOString());
            if(approvalSignal?.aborted)return false;
            await this.secrets.set(index,paired.clientId);
            // The enrollment index and challenge commit under the same lock.
            const expired=challenge.audience==='pwa'&&!this.active(id);
            if(expired||approvalSignal?.aborted){
              if(await this.secrets.get(index)===paired.clientId){
                if(previous===undefined)await this.secrets.delete(index);
                else await this.secrets.set(index,previous);
              }
              if(expired)throw Error('pairing_invalid_or_expired');
              return false;
            }
            this.pending.delete(id);
            return true;
          });
        } catch(error) {await revokePairedClientAsAdministrator(this.secrets,paired.clientId);throw error;}
        if(!enrolled){await revokePairedClientAsAdministrator(this.secrets,paired.clientId);return undefined;}
      }else this.pending.delete(id);
      return paired;
    });
  }

  async cancelBrowserPairing(id: string, publicJwk: unknown, origin: string, signature: unknown): Promise<void> {
    const key = parseWorkspacePublicJwk(publicJwk);
    await this.exclusive(async () => {
      const challenge = this.active(id);
      if (!challenge || challenge.purpose || challenge.audience !== 'pwa' || challenge.browserOrigin !== origin) return;
      this.assertPublicProof(challenge, key, signature, `uptokey-public-pwa-cancel-v1:${challenge.nonce}`);
      this.pending.delete(id);
      challenge.approvalWaiter?.(false);
    });
  }

  private assertPublicProof(challenge: PendingPairing, key: BrowserPublicJwk | undefined, signature: unknown, message = challenge.nonce): void {
    if(!key)throw Error('pairing_key_required');
    if(JSON.stringify(key)!==JSON.stringify(challenge.publicJwk)||!challenge.nonce||!message||typeof signature!=='string'||!/^[A-Za-z0-9_-]{86}$/.test(signature))throw Error('pairing_proof_invalid');
    const bytes=Buffer.from(signature,'base64url');
    if(bytes.length!==64||bytes.toString('base64url')!==signature||!verify('sha256',Buffer.from(message),{key:createPublicKey({key:{...key},format:'jwk'}),dsaEncoding:'ieee-p1363'},bytes))throw Error('pairing_proof_invalid');
  }

  waitForEditorApproval(id: string, publicJwk: unknown, signature: unknown, signal: AbortSignal): Promise<boolean> {
    const key = parseWorkspacePublicJwk(publicJwk);
    return this.waitForBoundApproval(id, key, undefined, signature, signal, 'vscode');
  }

  waitForExtensionApproval(id: string, publicJwk: unknown, origin: string, signature: unknown, signal: AbortSignal): Promise<boolean> {
    const key = parseWorkspacePublicJwk(publicJwk);
    return this.waitForBoundApproval(id, key, origin, signature, signal, 'browser-extension');
  }

  private waitForBoundApproval(id: string, key: BrowserPublicJwk | undefined, origin: string | undefined,
    signature: unknown, signal: AbortSignal, audience: 'pwa' | 'vscode' | 'browser-extension'): Promise<boolean> {
    const challenge = this.active(id);
    if (signal.aborted || !challenge?.publicJwk || challenge.purpose || challenge.audience !== audience || challenge.browserOrigin !== origin) return Promise.resolve(false);
    this.assertPublicProof(challenge, key, signature);
    if (challenge.approved) return Promise.resolve(true);
    if (challenge.approvalWaiter) return Promise.resolve(false);
    // One signed request per challenge waits outside the serialization queue.
    // Provisioning still rechecks approval, expiry and the proof under that queue.
    return new Promise(resolve => {
      const finish = (approved: boolean) => {
        clearTimeout(timer);
        signal.removeEventListener('abort', cancel);
        delete challenge.approvalWaiter;
        resolve(approved);
      };
      const cancel = () => finish(false);
      const timer = setTimeout(cancel, Math.min(SIGNED_APPROVAL_WAIT_MS, Math.max(0, challenge.deadline - this.now())));
      challenge.approvalWaiter = finish;
      signal.addEventListener('abort', cancel, { once: true });
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
    return { id: challenge.id, userCode: challenge.userCode, expiresAt: challenge.expiresAt, ...(challenge.nonce?{nonce:challenge.nonce}:{}) };
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
  if (admittedAudience === 'pwa' && (!isPublicPwaOrigin(browserOrigin)||enrolledVia!=='pairing')) throw Error('pairing_origin_invalid');
  if (admittedAudience === 'pwa' && !workspaceKey) throw Error('pairing_key_required');
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
