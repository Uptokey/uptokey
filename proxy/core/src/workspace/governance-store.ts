import { createCipheriv, createDecipheriv, createHash, createHmac, hkdfSync, randomBytes, randomUUID } from "node:crypto";
import { mkdir, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { mkdirSync, lstatSync, readFileSync, writeFileSync, unlinkSync } from "node:fs";
import { readJson, writeJsonAtomic } from "../atomic-json.ts";
import { dataDir } from "../paths.ts";
import type { SecretStore } from "../secret-store.ts";
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import type { AccountFundingObservationInput, AccountFundingView } from '@uptokey/sync-contract/connections';
import type {
  Workspace,
  Membership,
  WorkspacePolicy,
  WorkspaceBudget,
  GovernanceBundle,
  BudgetWindowState,
  WorkspaceRole,
  AuditEntry,
  AccountFundingObservation,
} from "./governance-types.ts";
import { GOVERNANCE_AUDIT_CAP } from "./governance-types.ts";

const SEALED_SCHEMA = "uptokey-governance-sealed-v1";
const GOVERNANCE_KEY_ACCOUNT = "local:governance-store-key";
const BUNDLE_SCHEMA = "uptokey-governance-bundle-v1";
const PROCESS_LOCKS = new Map<string, string>();
const ACCOUNT_FUNDING_PRINCIPAL = 'provider-funding';

function fundingBudgetId(providerId: string, accountId: string): string {
  for (const value of [providerId, accountId]) {
    if (typeof value !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(value)
      || ['constructor', 'prototype', '__proto__'].includes(value)) throw new Error('account_funding_identity_invalid');
  }
  return 'funding_' + createHash('sha256').update(providerId + '\0' + accountId).digest('hex');
}

function assertFundingObservation(value: AccountFundingObservation): void {
  fundingBudgetId(value.providerId, value.accountId);
  if (value.unit !== 'usd_micros' || typeof value.amountMicros !== 'string'
    || !/^(0|[1-9][0-9]{0,18})$/.test(value.amountMicros)) throw new Error('account_funding_amount_invalid');
  if (typeof value.source !== 'string' || !value.source.trim() || value.source.length > 240
    || /[\u0000-\u001f\u007f-\u009f]/.test(value.source)) throw new Error('account_funding_source_invalid');
  if (typeof value.observedAt !== 'string' || typeof value.validUntil !== 'string'
    || !canonicalUtc(value.observedAt) || !canonicalUtc(value.validUntil)
    || Date.parse(value.validUntil) <= Date.parse(value.observedAt)) throw new Error('account_funding_time_invalid');
}

function fundingView(providerId: string, accountId: string, budget: WorkspaceBudget | undefined, window: BudgetWindowState | undefined, now: Date): AccountFundingView {
  const observation = budget?.accountFunding;
  const reserved = window?.open.reduce((sum, item) => sum + BigInt(item.amountMicros), 0n) ?? 0n;
  const settled = BigInt(window?.settledMicros ?? '0');
  return { providerId, accountId, unit: 'usd_micros', revision: budget?.revision ?? 0, usageRevision: window?.revision ?? 0,
    amountMicros: observation?.amountMicros ?? null, source: observation?.source ?? null,
    observedAt: observation?.observedAt ?? null, validUntil: observation?.validUntil ?? null,
    status: !observation ? 'missing' : Date.parse(observation.observedAt) <= now.getTime() && now.getTime() < Date.parse(observation.validUntil) ? 'current' : 'expired',
    reservedMicros: reserved.toString(), settledMicros: settled.toString(),
    availableMicros: observation && budget ? (parseMoneyToMicros(budget.amount) - reserved - settled).toString() : null };
}

// Reuse helpers from store.ts pattern
function assertWorkflowId(value: string, label = "id"): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error(`${label}_invalid`);
}
function assertPrincipalId(value: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(value)) throw new Error("principal_invalid");
}
function assertWorkspaceName(value: string): void {
  if (typeof value !== "string" || value.length < 1 || value.length > 80 || /[\u0000-\u001f\u007f]/.test(value)) throw new Error("workspace_name_invalid");
}
function assertWorkspaceDescription(value: string): void {
  if (typeof value !== "string" || value.length > 1000 || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value)) throw new Error("workspace_description_invalid");
}
function canonicalUtc(value: string): boolean {
  const t = Date.parse(value);
  return Number.isFinite(t) && new Date(t).toISOString() === value;
}
function assertIsoTime(value: string): void {
  if (!canonicalUtc(value)) throw new Error("workspace_time_invalid");
}
function validateTimezone(tz: string): void {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: tz });
  } catch {
    throw new Error("invalid_timezone");
  }
}

function workspaceKey(id: string): string {
  return `/governance/${id}`;
}

export class GovernanceStore {
  secrets: SecretStore;
  root: string;
  now: () => Date;
  queues = new Map<string, Promise<unknown>>();
  masterKey: Buffer | undefined;
  lockRelease: (() => void) | undefined;
  processUnlock: (() => void) | undefined;
  private readonly ephemeral: boolean;
  private readonly memoryBundles = new Map<string, GovernanceBundle>();

  constructor(secrets: SecretStore, root = join(dataDir(), "governance"), now: () => Date = () => new Date(), options: { ephemeral?: boolean } = {}) {
    this.secrets = secrets;
    this.root = resolve(root);
    this.now = now;
    this.ephemeral = options.ephemeral === true;
  }

  async initialize(): Promise<void> {
    if (this.ephemeral) return;
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    const token = randomUUID();
    const processUnlock = claimProcessRoot(this.root, token);
    try {
      this.lockRelease = claimWriterLock(join(this.root, "writer.lock"), token);
      this.processUnlock = processUnlock;
    } catch (error) {
      processUnlock();
      throw error;
    }
    await this.ensureKey();
  }

  async close(): Promise<void> {
    await Promise.allSettled(this.queues.values());
    this.memoryBundles.clear();
    this.lockRelease?.();
    this.lockRelease = undefined;
    this.processUnlock?.();
    this.processUnlock = undefined;
    this.masterKey?.fill(0);
    this.masterKey = undefined;
  }

  // Personal workspace lazy creation
  async findPersonalWorkspace(principalId: string): Promise<Workspace | undefined> {
    assertPrincipalId(principalId);
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      return bundle.workspaces.find(w => w.ownerPrincipalId === principalId && w.deletedAt == null && isPersonalWorkspaceId(w.id, principalId));
    });
  }

  async ensurePersonalWorkspace(principalId: string): Promise<Workspace> {
    assertPrincipalId(principalId);
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      const existing = bundle.workspaces.find((w) => w.ownerPrincipalId === principalId && w.deletedAt == null && w.archivedAt == null && isPersonalWorkspaceId(w.id, principalId));
      if (existing) return existing;
      // also look for any personal already (archived considered not active but still exists)
      const anyPersonal = bundle.workspaces.find((w) => w.ownerPrincipalId === principalId && isPersonalWorkspaceId(w.id, principalId));
      if (anyPersonal) return anyPersonal;

      const now = this.isoNow();
      const ws: Workspace = {
        id: personalWorkspaceId(principalId),
        ownerPrincipalId: principalId,
        name: "Personal",
        description: "",
        revision: 1,
        createdAt: now,
        archivedAt: null,
      };
      const membership: Membership = {
        workspaceId: ws.id,
        memberId: principalId,
        role: "owner",
        state: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        inviteTokenHash: null,
        emailHash: null,
        expiresAt: null,
        invitedBy: principalId,
        seatNumber: 1,
      };
      const next = this.withAudit({ ...bundle, revision: bundle.revision + 1, workspaces: [...bundle.workspaces, ws], memberships: [...bundle.memberships, membership] }, { actor: principalId, action: "workspace.personal.ensure", workspaceId: ws.id, subject: null });
      await this.writeBundle(principalId, next);
      return ws;
    });
  }

  async createWorkspace(principalId: string, input: { name: string; description?: string; idempotencyKey?: string }): Promise<Workspace> {
    assertPrincipalId(principalId);
    assertWorkspaceName(input.name);
    if (input.description !== undefined) assertWorkspaceDescription(input.description);
    if (input.idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{3,100}$/.test(input.idempotencyKey)) throw new Error("workspace_idempotency_invalid");
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      // Persisted idempotency (07-SPECS: mutations carry expectedRevision e idempotencyKey).
      if (input.idempotencyKey) {
        const map = bundle.workspaceIdempotency ?? {};
        const replayId = map[input.idempotencyKey];
        if (replayId) {
          const replay = bundle.workspaces.find((w) => w.id === replayId);
          if (replay) return replay;
        }
      }
      const now = this.isoNow();
      const ws: Workspace = {
        id: `ws_${randomUUID().replace(/-/g, "").slice(0, 16)}`,
        ownerPrincipalId: principalId,
        name: input.name,
        description: input.description ?? "",
        revision: 1,
        createdAt: now,
        archivedAt: null,
      };
      const membership: Membership = {
        workspaceId: ws.id,
        memberId: principalId,
        role: "owner",
        state: "active",
        revision: 1,
        createdAt: now,
        updatedAt: now,
        inviteTokenHash: null,
        emailHash: null,
        expiresAt: null,
        invitedBy: principalId,
        seatNumber: 1,
      };
      const idempotency = input.idempotencyKey ? { ...(bundle.workspaceIdempotency ?? {}), [input.idempotencyKey]: ws.id } : bundle.workspaceIdempotency;
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        workspaces: [...bundle.workspaces, ws],
        memberships: [...bundle.memberships, membership],
        ...(input.idempotencyKey ? { workspaceIdempotency: idempotency } : {}),
      }, { actor: principalId, action: "workspace.create", workspaceId: ws.id, subject: input.name });
      await this.writeBundle(principalId, next);
      return ws;
    });
  }

  async listWorkspaces(principalId: string, after = "", limit = 100): Promise<{ workspaces: Workspace[]; nextCursor: string | null }> {
    assertPrincipalId(principalId);
    if (after) assertWorkflowId(after, "workspace_cursor");
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error("workspace_page_limit");
    const bundle = await this.readBundle(principalId);
    // Cursor paginates over one deterministic key (id asc); no mixed sort orders.
    const all = bundle.workspaces.filter((w) => !w.deletedAt).sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const filtered = all.filter((w) => w.id > after);
    const selected = filtered.slice(0, limit);
    return { workspaces: selected, nextCursor: filtered.length > limit ? selected.at(-1)!.id : null };
  }

  async getWorkspace(principalId: string, workspaceId: string): Promise<Workspace> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    const bundle = await this.serial(principalId, () => this.readBundle(principalId));
    const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
    if (!ws) throw new Error("workspace_not_found");
    const membership = bundle.memberships.find((m) => m.workspaceId === workspaceId && m.memberId === principalId && m.state === "active");
    const isOwner = ws.ownerPrincipalId === principalId;
    if (!membership && !isOwner) throw new Error("workspace_forbidden");
    return ws;
  }

  async updateWorkspace(principalId: string, workspaceId: string, input: { name?: string; description?: string; expectedRevision: number }): Promise<Workspace> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 1) throw new Error("workspace_revision_invalid");
    if (input.name !== undefined) assertWorkspaceName(input.name);
    if (input.description !== undefined) assertWorkspaceDescription(input.description);
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      const idx = bundle.workspaces.findIndex((w) => w.id === workspaceId && !w.deletedAt);
      if (idx < 0) throw new Error("workspace_not_found");
      const ws = bundle.workspaces[idx]!;
      if (ws.revision !== input.expectedRevision) throw new Error("workspace_revision_conflict");
      // check permission: owner or admin
      const role = this.effectiveRole(bundle, workspaceId, principalId);
      if (role !== "owner" && role !== "admin") throw new Error("workspace_forbidden");
      if (ws.archivedAt) throw new Error("workspace_archived");
      const updated: Workspace = {
        ...ws,
        name: input.name ?? ws.name,
        description: input.description ?? ws.description,
        revision: ws.revision + 1,
      };
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        workspaces: bundle.workspaces.map((w, i) => (i === idx ? updated : w)),
        memberships: bundle.memberships,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.update", workspaceId, subject: null });
      await this.writeBundle(principalId, next);
      return updated;
    });
  }

  async archiveWorkspace(principalId: string, workspaceId: string, expectedRevision: number): Promise<Workspace> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      const idx = bundle.workspaces.findIndex((w) => w.id === workspaceId && !w.deletedAt);
      if (idx < 0) throw new Error("workspace_not_found");
      const ws = bundle.workspaces[idx]!;
      if (ws.revision !== expectedRevision) throw new Error("workspace_revision_conflict");
      const role = this.effectiveRole(bundle, workspaceId, principalId);
      if (role !== "owner") throw new Error("workspace_forbidden");
      if (ws.archivedAt) return ws; // idempotent
      const archived: Workspace = {
        ...ws,
        archivedAt: this.isoNow(),
        revision: ws.revision + 1,
      };
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        workspaces: bundle.workspaces.map((w, i) => (i === idx ? archived : w)),
        memberships: bundle.memberships,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.archive", workspaceId, subject: null });
      await this.writeBundle(principalId, next);
      return archived;
    });
  }

  async deleteWorkspace(principalId: string, workspaceId: string, expectedRevision: number): Promise<void> {
    assertPrincipalId(principalId);
    return this.serial(principalId, async () => {
      const bundle = await this.readBundle(principalId);
      const idx = bundle.workspaces.findIndex((w) => w.id === workspaceId && !w.deletedAt);
      if (idx < 0) throw new Error("workspace_not_found");
      const ws = bundle.workspaces[idx]!;
      if (ws.revision !== expectedRevision) throw new Error("workspace_revision_conflict");
      if (ws.ownerPrincipalId !== principalId) throw new Error("workspace_forbidden");
      // cannot delete if has active members other than owner? Allow but tombstone
      const tombstoned: Workspace = {
        ...ws,
        deletedAt: this.isoNow(),
        revision: ws.revision + 1,
      };
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        workspaces: bundle.workspaces.map((w, i) => (i === idx ? tombstoned : w)),
        memberships: bundle.memberships,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.delete", workspaceId, subject: null });
      await this.writeBundle(principalId, next);
    });
  }

  // Membership
  async inviteMember(principalId: string, workspaceId: string, input: { email: string; role: Exclude<WorkspaceRole, "owner">; requestId: string }): Promise<{ inviteId: string; inviteToken: string; expiresAt: string; revision: number; seatNumber: number }> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    if (!isDataRecord(input)) throw new Error("team_invite_input_invalid");
    const normalized = normalizeIdentity(input.email);
    if (input.role !== "admin" && input.role !== "member" && input.role !== "viewer") throw new Error("team_invite_input_invalid");
    if (!/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(input.requestId)) throw new Error("team_invite_input_invalid");

    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId, async () => {
      const bundle = await this.readBundle(ownerId);
      const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
      if (!ws) throw new Error("workspace_not_found");
      const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (role !== "owner" && role !== "admin") throw new Error("workspace_forbidden");
      if (ws.archivedAt) throw new Error("workspace_archived");

      // duplicate check by requestId via idempotency hash
      const nowMs = this.now().getTime();
      const requestHash = this.hashForInvite(workspaceId, input.requestId);
      const existing = bundle.memberships.find((m) => m.workspaceId === workspaceId && (m as unknown as Record<string, unknown>).idempotencyHash === requestHash);
      if (existing) {
        // Deterministic token: same requestId re-derives the same token; only the hash is persisted.
        const token = this.deriveInviteToken(workspaceId, input.requestId);
        const result = {
          inviteId: existing.inviteId ?? existing.memberId,
          inviteToken: token,
          expiresAt: existing.expiresAt ?? new Date(nowMs + 7 * 24 * 60 * 60_000).toISOString(),
          revision: existing.revision,
          seatNumber: existing.seatNumber ?? 2,
        };
        await this.writeBundle(ownerId, this.withAudit(bundle, { actor: principalId, action: "workspace.invite.replay", workspaceId, subject: result.inviteId }));
        return result;
      }

      const now = nowMs;
      const createdAt = new Date(now).toISOString();
      const expiresAt = new Date(now + 7 * 24 * 60 * 60_000).toISOString();
      // Token derives from secret + workspace + requestId (control-plane team-membership pattern):
      // replay-safe without ever persisting the raw token.
      const inviteToken = this.deriveInviteToken(workspaceId, input.requestId);
      const inviteTokenHash = this.hashForInviteToken(inviteToken);
      const emailHash = this.hashForInvite("email", workspaceId, normalized);
      const seatNumber = this.nextSeatNumber(bundle, workspaceId);
      if (seatNumber > 10) throw new Error("team_seat_limit");
      const inviteId = `inv_${randomBytes(16).toString("base64url")}`;
      const membership: Membership = {
        workspaceId,
        memberId: `pending_${inviteId}`,
        role: input.role as WorkspaceRole,
        state: "invited",
        revision: 1,
        createdAt,
        updatedAt: createdAt,
        inviteId,
        inviteTokenHash,
        emailHash,
        expiresAt,
        invitedBy: principalId,
        seatNumber,
      };
      (membership as unknown as Record<string, unknown>).idempotencyHash = requestHash;
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        workspaces: bundle.workspaces,
        memberships: [...bundle.memberships, membership],
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.invite.create", workspaceId, subject: inviteId });
      await this.writeBundle(ownerId, next);
      return { inviteId, inviteToken, expiresAt, revision: 1, seatNumber };
    });
  }

  async acceptInvite(principalId: string, input: { email: string; inviteToken: string }): Promise<{ workspaceId: string; memberId: string; role: WorkspaceRole; revision: number }> {
    assertPrincipalId(principalId);
    const normalized = normalizeIdentity(input.email);
    const token = input.inviteToken;
    if (!token.startsWith("utk_ws_invite_")) throw new Error("team_invite_accept_input_invalid");
    const tokenHash = this.hashForInviteToken(token);
    // Scan all governance bundles to find the matching invite (lock-free reads; the
    // mutation below re-validates state inside the owner's serial queue).
    const allPrincipals = await this.listPrincipals();
    for (const ownerId of allPrincipals) {
      const bundle = await this.readBundle(ownerId);
      const invite = bundle.memberships.find((m) => m.state === "invited" && m.inviteTokenHash === tokenHash);
      if (!invite) continue;
      // verify email hash (stored per workspace; recompute with the invite's workspace)
      const expectedEmailHash = this.hashForInvite("email", invite.workspaceId, normalized);
      if (invite.emailHash !== expectedEmailHash) continue;
      // check expiry: mark expired, release the seat, and audit the transition
      if (invite.expiresAt && Date.parse(invite.expiresAt) <= this.now().getTime()) {
        await this.serial(ownerId, async () => {
          const b = await this.readBundle(ownerId);
          const idx = b.memberships.findIndex((m) => m.inviteId === invite.inviteId);
          if (idx >= 0 && b.memberships[idx]!.state === "invited") {
            const updated = { ...b.memberships[idx]!, state: "expired" as const, updatedAt: this.isoNow(), revision: b.memberships[idx]!.revision + 1, seatNumber: null };
            const next = this.withAudit({ ...b, revision: b.revision + 1, memberships: b.memberships.map((m, i) => (i === idx ? updated : m)), workspaces: b.workspaces, policies: b.policies, budgets: b.budgets, projectWorkspaceMap: b.projectWorkspaceMap, budgetWindows: b.budgetWindows }, { actor: principalId, action: "workspace.invite.expired", workspaceId: invite.workspaceId, subject: invite.inviteId ?? null });
            await this.writeBundle(ownerId, next);
          }
        });
        throw new Error("invite_expired");
      }
      // accept: convert pending to active, set memberId = principalId
      const result = await this.serial(ownerId, async () => {
        const b = await this.readBundle(ownerId);
        const idx = b.memberships.findIndex((m) => m.inviteId === invite.inviteId);
        if (idx < 0) throw new Error("invite_not_found");
        const inv = b.memberships[idx]!;
        if (inv.state !== "invited") throw new Error("invite_not_found");
        // check if principal already member
        const already = b.memberships.find((m) => m.workspaceId === inv.workspaceId && m.memberId === principalId && m.state === "active");
        if (already) return { workspaceId: inv.workspaceId, memberId: already.memberId, role: already.role, revision: already.revision };
        const now = this.isoNow();
        const active: Membership = {
          workspaceId: inv.workspaceId,
          memberId: principalId,
          role: inv.role,
          state: "active",
          revision: 1,
          createdAt: now,
          updatedAt: now,
          inviteId: inv.inviteId,
          inviteTokenHash: null,
          emailHash: inv.emailHash,
          expiresAt: null,
          invitedBy: inv.invitedBy,
          seatNumber: inv.seatNumber,
        };
        // Pending invite is closed (revoked) and an active membership is appended;
        // both records remain for audit.
        const pendingUpdated: Membership = { ...inv, state: "revoked" as const, updatedAt: now, revision: inv.revision + 1, inviteTokenHash: null };
        const next = this.withAudit({
          ...b,
          revision: b.revision + 1,
          workspaces: b.workspaces,
          memberships: [...b.memberships.slice(0, idx), pendingUpdated, ...b.memberships.slice(idx + 1), active],
          policies: b.policies,
          budgets: b.budgets,
          projectWorkspaceMap: b.projectWorkspaceMap,
          budgetWindows: b.budgetWindows,
        }, { actor: principalId, action: "workspace.member.accept", workspaceId: active.workspaceId, subject: principalId });
        await this.writeBundle(ownerId, next);
        return { workspaceId: active.workspaceId, memberId: active.memberId, role: active.role, revision: active.revision };
      });
      return result;
    }
    throw new Error("invite_not_found");
  }

  async revokeMember(principalId: string, workspaceId: string, memberId: string, expectedRevision: number): Promise<void> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(memberId)) throw new Error("member_invalid");
    const ownerKey = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerKey, async () => {
      const ownerId = ownerKey;
      const bundle = await this.readBundle(ownerId);
      const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
      if (!ws) throw new Error("workspace_not_found");
      const actorRole = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (!actorRole || (actorRole !== "owner" && actorRole !== "admin")) throw new Error("workspace_forbidden");
      const idx = bundle.memberships.findIndex((m) => m.workspaceId === workspaceId && m.memberId === memberId && m.state === "active");
      if (idx < 0) throw new Error("membership_not_found");
      const target = bundle.memberships[idx]!;
      if (target.revision !== expectedRevision) throw new Error("workspace_revision_conflict");
      if (target.role === "owner") {
        const ownerCount = bundle.memberships.filter((m) => m.workspaceId === workspaceId && m.role === "owner" && m.state === "active").length;
        // also count ws owner if not in membership table? Owner always member via implicit; but we also have explicit membership for owner
        if (ownerCount <= 1 && ws.ownerPrincipalId === memberId) throw new Error("last_owner");
        if (ownerCount <= 1) throw new Error("last_owner");
      }
      if (actorRole !== "owner" && target.role === "owner") throw new Error("workspace_forbidden");
      const updated: Membership = { ...target, state: "revoked" as const, updatedAt: this.isoNow(), revision: target.revision + 1 };
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        memberships: bundle.memberships.map((m, i) => (i === idx ? updated : m)),
        workspaces: bundle.workspaces,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.member.revoke", workspaceId, subject: memberId });
      await this.writeBundle(ownerId, next);
    });
  }

  async updateMemberRole(principalId: string, workspaceId: string, memberId: string, input: { role: WorkspaceRole; expectedRevision: number }): Promise<Membership> {
    assertPrincipalId(principalId);
    const ownerKey = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerKey, async () => {
      const ownerId = ownerKey;
      const bundle = await this.readBundle(ownerId);
      const idx = bundle.memberships.findIndex((m) => m.workspaceId === workspaceId && m.memberId === memberId && m.state === "active");
      if (idx < 0) throw new Error("membership_not_found");
      const target = bundle.memberships[idx]!;
      if (target.revision !== input.expectedRevision) throw new Error("workspace_revision_conflict");
      const actorRole = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (actorRole !== "owner") throw new Error("workspace_forbidden");
      if (target.role === "owner" && input.role !== "owner") {
        const ownerCount = bundle.memberships.filter((m) => m.workspaceId === workspaceId && m.role === "owner" && m.state === "active").length;
        if (ownerCount <= 1) throw new Error("last_owner");
      }
      const updated: Membership = { ...target, role: input.role, updatedAt: this.isoNow(), revision: target.revision + 1 };
      const next = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        memberships: bundle.memberships.map((m, i) => (i === idx ? updated : m)),
        workspaces: bundle.workspaces,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
        budgetWindows: bundle.budgetWindows,
      }, { actor: principalId, action: "workspace.member.role", workspaceId, subject: `${memberId}:${input.role}` });
      await this.writeBundle(ownerId, next);
      return updated;
    });
  }

  async listMembers(principalId: string, workspaceId: string): Promise<Membership[]> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    const bundle = await this.serial(ownerId, () => this.readBundle(ownerId));
    const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
    if (!ws) throw new Error("workspace_not_found");
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    return bundle.memberships.filter((m) => m.workspaceId === workspaceId && m.state === "active").map((m) => ({ ...m }));
  }

  // Policies
  async putPolicy(principalId: string, workspaceId: string, policy: Omit<WorkspacePolicy, "revision" | "createdAt" | "updatedAt"> & { expectedRevision?: number }): Promise<WorkspacePolicy> {
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    // validate policy fields
    if (policy.allowModels && !Array.isArray(policy.allowModels)) throw new Error("policy_invalid");
    if (policy.denyModels && !Array.isArray(policy.denyModels)) throw new Error("policy_invalid");
    if (policy.budgetRefs && !Array.isArray(policy.budgetRefs)) throw new Error("policy_invalid");
    // check timezone not needed for policy
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId, async () => {
      const bundle = await this.readBundle(ownerId);
      const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (role !== "owner" && role !== "admin") throw new Error("workspace_forbidden");
      const existingIdx = bundle.policies.findIndex((p) => p.id === policy.id);
      const now = this.isoNow();
      if (existingIdx >= 0) {
        const existing = bundle.policies[existingIdx]!;
        if (policy.expectedRevision !== undefined && existing.revision !== policy.expectedRevision) throw new Error("policy_conflict");
        if (existing.workspaceId !== workspaceId) throw new Error("policy_conflict");
        const updated: WorkspacePolicy = {
          ...existing,
          ...policy,
          version: existing.version + 1,
          revision: existing.revision + 1,
          updatedAt: now,
        };
        const next = this.withAudit({
          ...bundle,
          revision: bundle.revision + 1,
          policies: bundle.policies.map((p, i) => (i === existingIdx ? updated : p)),
          workspaces: bundle.workspaces,
          memberships: bundle.memberships,
          budgets: bundle.budgets,
          projectWorkspaceMap: bundle.projectWorkspaceMap,
          budgetWindows: bundle.budgetWindows,
        }, { actor: principalId, action: "policy.update", workspaceId, subject: policy.id });
        await this.writeBundle(ownerId, next);
        return updated;
      } else {
        const created: WorkspacePolicy = {
          id: policy.id || `pol_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          version: 1,
          workspaceId,
          scope: policy.scope,
          subjectId: policy.subjectId ?? null,
          allowModels: policy.allowModels ?? null,
          denyModels: policy.denyModels ?? null,
          allowProviders: policy.allowProviders ?? null,
          denyProviders: policy.denyProviders ?? null,
          allowTools: policy.allowTools ?? null,
          denyTools: policy.denyTools ?? null,
          retentionAllowExport: policy.retentionAllowExport ?? null,
          retentionDays: policy.retentionDays ?? null,
          budgetRefs: policy.budgetRefs ?? null,
          preventOverrides: policy.preventOverrides ?? null,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const next = this.withAudit({
          ...bundle,
          revision: bundle.revision + 1,
          policies: [...bundle.policies, created],
          workspaces: bundle.workspaces,
          memberships: bundle.memberships,
          budgets: bundle.budgets,
          projectWorkspaceMap: bundle.projectWorkspaceMap,
          budgetWindows: bundle.budgetWindows,
        }, { actor: principalId, action: "policy.create", workspaceId, subject: created.id });
        await this.writeBundle(ownerId, next);
        return created;
      }
    });
  }

  async getPolicies(principalId: string, workspaceId: string): Promise<WorkspacePolicy[]> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    const bundle = await this.serial(ownerId, () => this.readBundle(ownerId));
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    return bundle.policies.filter((p) => p.workspaceId === workspaceId);
  }

  async getEffectivePolicy(principalId: string, workspaceId: string, subject: { memberId?: string; keyId?: string; projectId?: string; model?: string; provider?: string; tool?: string }): Promise<{ allowed: boolean; reasonCodes: string[]; policyVersions: Array<{ policyId: string; version: number }>; limitsSnapshot: unknown }> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    const bundle = await this.readBundle(ownerId);
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
    if (!ws) throw new Error("workspace_not_found");
    const applicable = bundle.policies.filter((p) => {
      if (p.workspaceId !== workspaceId) return false;
      if (p.scope === "workspace") return true;
      if (p.scope === "member" && subject.memberId && p.subjectId === subject.memberId) return true;
      if (p.scope === "key" && subject.keyId && p.subjectId === subject.keyId) return true;
      if (p.scope === "project" && subject.projectId && p.subjectId === subject.projectId) return true;
      return false;
    });
    const reasonCodes: string[] = [];
    // 07-ARCHITECTURE: combinação conservadora — negar prevalece; allowlists por
    // interseção; espaço arquivado bloqueia novos efeitos.
    if (ws.archivedAt) reasonCodes.push("workspace_archived");
    for (const p of applicable) {
      if (p.denyModels?.includes(subject.model ?? "\u0000")) reasonCodes.push(`policy:${p.id}:deny_model`);
      if (p.denyProviders?.includes(subject.provider ?? "\u0000")) reasonCodes.push(`policy:${p.id}:deny_provider`);
      if (p.denyTools?.includes(subject.tool ?? "\u0000")) reasonCodes.push(`policy:${p.id}:deny_tool`);
      if (subject.model && p.allowModels && !p.allowModels.includes(subject.model)) reasonCodes.push(`policy:${p.id}:model_not_allowed`);
      if (subject.provider && p.allowProviders && !p.allowProviders.includes(subject.provider)) reasonCodes.push(`policy:${p.id}:provider_not_allowed`);
      if (subject.tool && p.allowTools && !p.allowTools.includes(subject.tool)) reasonCodes.push(`policy:${p.id}:tool_not_allowed`);
    }
    // Effective allowlists: intersection across policies that constrain the field.
    const intersect = (lists: Array<string[] | null | undefined>): string[] | null => {
      const defined = lists.filter((l): l is string[] => Array.isArray(l));
      if (defined.length === 0) return null;
      return defined.reduce((acc, next) => acc.filter((v) => next.includes(v)));
    };
    const limitsSnapshot = {
      allowModels: intersect(applicable.map((p) => p.allowModels)),
      allowProviders: intersect(applicable.map((p) => p.allowProviders)),
      allowTools: intersect(applicable.map((p) => p.allowTools)),
      preventOverrides: applicable.some((p) => p.preventOverrides === true),
    };
    return {
      allowed: reasonCodes.length === 0,
      reasonCodes,
      policyVersions: applicable.map((p) => ({ policyId: p.id, version: p.version })),
      limitsSnapshot,
    };
  }

  // Budgets
  async putBudget(principalId: string, workspaceId: string, budget: Omit<WorkspaceBudget, "revision" | "createdAt" | "updatedAt"> & { expectedRevision?: number }, revalidate?: () => Promise<void>): Promise<WorkspaceBudget> {
    if (budget.accountFunding !== undefined) throw new Error('budget_invalid');
    assertPrincipalId(principalId);
    assertWorkflowId(workspaceId, "workspace_id");
    if (!['workspace', 'member', 'key', 'project', 'conversation'].includes(budget.scope)) throw new Error('budget_invalid');
    if (budget.enabled !== undefined && typeof budget.enabled !== 'boolean') throw new Error('budget_invalid');
    if (!["request", "token", "money"].includes(budget.unit)) throw new Error("budget_invalid");
    if (budget.unit === "money" && !budget.currency) throw new Error("budget_currency_required");
    if (budget.currency && !/^[A-Z]{3}$/.test(budget.currency)) throw new Error("budget_currency_invalid");
    validateTimezone(budget.timezone);
    if (!["day", "week", "month", "total"].includes(budget.period)) throw new Error("budget_invalid");
    // amount validation: integer or decimal string exact
    if (budget.unit === "money") {
      if (!/^(0|[1-9][0-9]{0,12})(\.[0-9]{1,6})?$/.test(budget.amount)) throw new Error("budget_amount_invalid");
    } else {
      if (!/^(0|[1-9][0-9]{0,12})$/.test(budget.amount)) throw new Error("budget_amount_invalid");
    }
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId, async () => {
      const bundle = await this.readBundle(ownerId);
      const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (role !== "owner" && role !== "admin") throw new Error("workspace_forbidden");
      const existingIdx = bundle.budgets.findIndex((b) => b.id === budget.id);
      const now = this.isoNow();
      if (existingIdx >= 0) {
        const existing = bundle.budgets[existingIdx]!;
        if (existing.workspaceId !== workspaceId) throw new Error('workspace_forbidden');
        if (existing.scope === 'conversation' && ['workspaceId','scope','subjectId','unit','currency','period','timezone','includeByokUsage','startsAt','endsAt'].some(k =>
          ((budget as unknown as Record<string,unknown>)[k] ?? null) !== ((existing as unknown as Record<string,unknown>)[k] ?? null))) throw new Error('budget_definition_conflict');
        if (budget.expectedRevision !== undefined && existing.revision !== budget.expectedRevision) throw new Error("budget_revision_conflict");
        const updated: WorkspaceBudget = {
          ...existing,
          ...budget,
          revision: existing.revision + 1,
          updatedAt: now,
        };
        const next = this.withAudit({
          ...bundle,
          revision: bundle.revision + 1,
          budgets: bundle.budgets.map((b, i) => (i === existingIdx ? updated : b)),
          workspaces: bundle.workspaces,
          memberships: bundle.memberships,
          policies: bundle.policies,
          projectWorkspaceMap: bundle.projectWorkspaceMap,
          budgetWindows: bundle.budgetWindows,
        }, { actor: principalId, action: "budget.update", workspaceId, subject: budget.id });
        await revalidate?.();
        await this.writeBundle(ownerId, next);
        return updated;
      } else {
        if (budget.expectedRevision !== undefined && budget.expectedRevision !== 0) throw new Error('budget_revision_conflict');
        const created: WorkspaceBudget = {
          id: budget.id || `bud_${randomUUID().replace(/-/g, "").slice(0, 12)}`,
          workspaceId,
          scope: budget.scope,
          ...(budget.enabled !== undefined ? { enabled: budget.enabled } : {}),
          subjectId: budget.subjectId ?? null,
          unit: budget.unit as WorkspaceBudget["unit"],
          currency: budget.currency ?? null,
          amount: budget.amount,
          period: budget.period as WorkspaceBudget["period"],
          timezone: budget.timezone,
          startsAt: budget.startsAt ?? null,
          endsAt: budget.endsAt ?? null,
          includeByokUsage: budget.includeByokUsage,
          revision: 1,
          createdAt: now,
          updatedAt: now,
        };
        const next = this.withAudit({
          ...bundle,
          revision: bundle.revision + 1,
          budgets: [...bundle.budgets, created],
          workspaces: bundle.workspaces,
          memberships: bundle.memberships,
          policies: bundle.policies,
          projectWorkspaceMap: bundle.projectWorkspaceMap,
          budgetWindows: bundle.budgetWindows,
        }, { actor: principalId, action: "budget.create", workspaceId, subject: created.id });
        await revalidate?.();
        await this.writeBundle(ownerId, next);
        return created;
      }
    });
  }

  async listBudgets(principalId: string, workspaceId: string): Promise<WorkspaceBudget[]> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    const bundle = await this.serial(ownerId, () => this.readBundle(ownerId));
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    return bundle.budgets.filter((b) => b.workspaceId === workspaceId);
  }

  async getAccountFunding(providerId: string, accountId: string): Promise<AccountFundingView> {
    const budgetId = fundingBudgetId(providerId, accountId);
    return this.serial(ACCOUNT_FUNDING_PRINCIPAL, async () => {
      const bundle = await this.readBundle(ACCOUNT_FUNDING_PRINCIPAL);
      return fundingView(providerId, accountId, bundle.budgets.find(b => b.id === budgetId),
        bundle.budgetWindows.find(w => w.budgetId === budgetId && w.windowKey === 'total'), this.now());
    });
  }

  /** Replace a manually observed upstream balance, never reset local open usage.
   * The source is a user's assertion, not proof that the upstream balance is live. */
  async putAccountFunding(providerId: string, accountId: string, input: AccountFundingObservationInput): Promise<AccountFundingView> {
    const budgetId = fundingBudgetId(providerId, accountId);
    if (!isDataRecord(input) || Object.keys(input).some(k => !['expectedRevision', 'expectedUsageRevision', 'amountMicros', 'unit', 'source', 'observedAt', 'validUntil'].includes(k))) throw new Error('account_funding_invalid');
    const observation: AccountFundingObservation = { providerId, accountId, amountMicros: input.amountMicros,
      unit: input.unit, source: input.source, observedAt: input.observedAt, validUntil: input.validUntil };
    assertFundingObservation(observation);
    if (!Number.isSafeInteger(input.expectedRevision) || input.expectedRevision < 0
      || !Number.isSafeInteger(input.expectedUsageRevision) || input.expectedUsageRevision < 0) throw new Error('account_funding_revision_conflict');
    const workspace = await this.ensurePersonalWorkspace(ACCOUNT_FUNDING_PRINCIPAL);
    return this.serial(ACCOUNT_FUNDING_PRINCIPAL, async () => {
      const now = this.now();
      if (Date.parse(observation.observedAt) > now.getTime() || Date.parse(observation.validUntil) <= now.getTime()) throw new Error('account_funding_time_invalid');
      const bundle = await this.readBundle(ACCOUNT_FUNDING_PRINCIPAL);
      const existing = bundle.budgets.find(b => b.id === budgetId);
      const window = bundle.budgetWindows.find(w => w.budgetId === budgetId && w.windowKey === 'total');
      if (input.expectedRevision !== (existing?.revision ?? 0)
        || input.expectedUsageRevision !== (window?.revision ?? 0)) throw new Error('account_funding_revision_conflict');
      // Including all historical settled usage keeps the same total window while
      // interpreting the new amount as a balance observed now. Open debits survive.
      const ceiling = BigInt(observation.amountMicros) + BigInt(window?.settledMicros ?? '0');
      const budget: WorkspaceBudget = { id: budgetId, workspaceId: workspace.id, scope: 'provider_account',
        subjectId: accountId, accountFunding: observation, enabled: true, unit: 'money', currency: 'USD',
        amount: `${ceiling / 1_000_000n}.${(ceiling % 1_000_000n).toString().padStart(6, '0')}`,
        period: 'total', timezone: 'UTC', includeByokUsage: true, revision: (existing?.revision ?? 0) + 1,
        createdAt: existing?.createdAt ?? now.toISOString(), updatedAt: now.toISOString() };
      const next = this.withAudit({ ...bundle, revision: bundle.revision + 1,
        budgets: [...bundle.budgets.filter(b => b.id !== budgetId), budget] },
      { actor: ACCOUNT_FUNDING_PRINCIPAL, action: 'account_funding.observe', workspaceId: workspace.id, subject: budgetId });
      await this.writeBundle(ACCOUNT_FUNDING_PRINCIPAL, next);
      return fundingView(providerId, accountId, budget, window, now);
    });
  }

  async validateAccountFunding(providerId: string, accountId: string, expectedRevision: number): Promise<void> {
    const view = await this.getAccountFunding(providerId, accountId);
    if (view.status !== 'current') throw new Error(`account_funding_${view.status}`);
    if (view.revision !== expectedRevision) throw new Error('account_funding_changed');
  }

  async reserveAccountFunding(providerId: string, accountId: string, input: { requestId: string; amountMicros: string }) {
    const budgetId = fundingBudgetId(providerId, accountId);
    const view = await this.getAccountFunding(providerId, accountId);
    if (view.status !== 'current') throw new Error(`account_funding_${view.status}`);
    const workspaceId = personalWorkspaceId(ACCOUNT_FUNDING_PRINCIPAL);
    const result = await this.reserveBudget(ACCOUNT_FUNDING_PRINCIPAL, workspaceId,
      { ...input, budgetId, expectedFundingRevision: view.revision });
    return { ...result, budgetId, workspaceId, principalId: ACCOUNT_FUNDING_PRINCIPAL, observationRevision: view.revision };
  }

  async forgetTemporaryBudget(principalId: string, budgetId: string): Promise<void> {
    if (!this.ephemeral) throw new Error('ephemeral_mode_required');
    await this.serial(principalId,async()=>{
      const bundle=this.memoryBundles.get(principalId);
      if (!bundle) return;
      const next={...bundle,revision:bundle.revision+1,budgets:bundle.budgets.filter(b=>b.id!==budgetId),budgetWindows:bundle.budgetWindows.filter(w=>w.budgetId!==budgetId),audit:bundle.audit?.filter(a=>a.subject!==budgetId)};
      this.memoryBundles.set(principalId,structuredClone(next));
    });
  }

  async listBudgetUsage(principalId:string,workspaceId:string){
    assertPrincipalId(principalId);const ownerId=await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId,async()=>{const bundle=await this.readBundle(ownerId);if(ownerId!==principalId&&!this.effectiveRole(bundle,workspaceId,principalId))throw new Error('workspace_forbidden');
      const budgets=new Set(bundle.budgets.filter(b=>b.workspaceId===workspaceId).map(b=>b.id));
      return bundle.budgetWindows.filter(w=>budgets.has(w.budgetId)).map(w=>({budgetId:w.budgetId,windowKey:w.windowKey,windowStart:w.windowStart,windowEnd:w.windowEnd,reserved:w.open.reduce((total,r)=>total+BigInt(r.amountMicros),0n).toString(),settled:w.settledMicros,openReservations:w.open.length}));});
  }

  // Project -> workspace mapping
  async mapProjectToWorkspace(principalId: string, projectId: string, workspaceId: string): Promise<void> {
    assertPrincipalId(principalId);
    assertWorkflowId(projectId, "project_id");
    assertWorkflowId(workspaceId, "workspace_id");
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    // mapping is stored per owner principal, but we need to ensure principal has access to workspace
    const bundle = await this.serial(ownerId, () => this.readBundle(ownerId));
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    await this.serial(ownerId, async () => {
      const b = await this.readBundle(ownerId);
      const next = this.withAudit({
        ...b,
        revision: b.revision + 1,
        projectWorkspaceMap: { ...b.projectWorkspaceMap, [projectId]: workspaceId },
        workspaces: b.workspaces,
        memberships: b.memberships,
        policies: b.policies,
        budgets: b.budgets,
        budgetWindows: b.budgetWindows,
      }, { actor: principalId, action: "project.map", workspaceId, subject: projectId });
      await this.writeBundle(ownerId, next);
    });
  }

  async getProjectWorkspace(projectId: string): Promise<string | null> {
    // search across all principals
    const principals = await this.listPrincipals();
    for (const pid of principals) {
      const bundle = await this.serial(pid, () => this.readBundle(pid));
      if (bundle.projectWorkspaceMap[projectId]) return bundle.projectWorkspaceMap[projectId]!;
    }
    return null;
  }

  async migrateLegacyProjects(principalId: string, projectIds: string[]): Promise<{ migrated: number; workspaceId: string }> {
    const ws = await this.ensurePersonalWorkspace(principalId);
    let count = 0;
    for (const pid of projectIds) {
      const existing = await this.getProjectWorkspace(pid);
      if (existing) continue;
      await this.mapProjectToWorkspace(principalId, pid, ws.id);
      count += 1;
    }
    return { migrated: count, workspaceId: ws.id };
  }

  async overview(principalId: string, workspaceId: string): Promise<{ workspace: Workspace; members: number; budgets: number; policies: number; projects: number }> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    const bundle = await this.serial(ownerId, () => this.readBundle(ownerId));
    const ws = bundle.workspaces.find((w) => w.id === workspaceId && !w.deletedAt);
    if (!ws) throw new Error("workspace_not_found");
    const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
    if (!role) throw new Error("workspace_forbidden");
    const members = bundle.memberships.filter((m) => m.workspaceId === workspaceId && m.state === "active").length;
    const budgets = bundle.budgets.filter((b) => b.workspaceId === workspaceId).length;
    const policies = bundle.policies.filter((p) => p.workspaceId === workspaceId).length;
    const projects = Object.values(bundle.projectWorkspaceMap).filter((id) => id === workspaceId).length;
    return { workspace: ws, members, budgets, policies, projects };
  }

  // Budget reservation with atomic queue per budget
  async listRequestBudgetReservations(principalId:string,workspaceId:string,requestId:string){
    assertPrincipalId(principalId);const ownerId=await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId,async()=>{
      const bundle=await this.readBundle(ownerId);
      if(ownerId!==principalId&&!this.effectiveRole(bundle,workspaceId,principalId))throw new Error('workspace_forbidden');
      return bundle.budgetWindows.flatMap(window=>window.open.filter(entry=>entry.principalId===principalId&&entry.requestId===requestId).flatMap(entry=>{
        const budget=bundle.budgets.find(b=>b.id===window.budgetId&&b.workspaceId===workspaceId);
        return budget?[{budget,windowKey:window.windowKey,...entry}]:[];
      }));
    });
  }
  async reserveBudget(principalId: string, workspaceId: string, input: { budgetId: string; requestId: string; amountMicros: string; expectedRevision?: number; expectedFundingRevision?: number }): Promise<{ ok: boolean; code?: string; windowKey?: string; requestId?: string; amountMicros?: string }> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    return this.serial(ownerId, async () => {
      const bundle = await this.readBundle(ownerId);
      const budget = bundle.budgets.find((b) => b.id === input.budgetId && b.workspaceId === workspaceId);
      if (!budget) throw new Error("budget_not_found");
      const role = ownerId === principalId ? "owner" : this.effectiveRole(bundle, workspaceId, principalId);
      if (!role) throw new Error("workspace_forbidden");
      const ws = bundle.workspaces.find((w) => w.id === workspaceId);
      if (ws?.archivedAt) throw new Error("workspace_archived");
      if (budget.scope === 'provider_account') {
        const observation = budget.accountFunding;
        if (!observation) throw new Error('account_funding_missing');
        const now = this.now().getTime();
        if (Date.parse(observation.observedAt) > now || now >= Date.parse(observation.validUntil)) throw new Error('account_funding_expired');
        if (input.expectedFundingRevision !== budget.revision) throw new Error('account_funding_changed');
        if (typeof input.amountMicros !== 'string' || !/^(0|[1-9][0-9]{0,29})$/.test(input.amountMicros)) throw new Error('budget_cost_unknown');
      }

      // A restart or period boundary must not reserve the same admitted request twice.
      const earlier=bundle.budgetWindows.find(w=>w.budgetId===budget.id&&w.open.some(r=>r.principalId===principalId&&r.requestId===input.requestId));
      if(earlier){const entry=earlier.open.find(r=>r.principalId===principalId&&r.requestId===input.requestId)!;return {ok:entry.amountMicros===input.amountMicros,code:entry.amountMicros===input.amountMicros?undefined:'budget_request_conflict',windowKey:earlier.windowKey,requestId:input.requestId,amountMicros:entry.amountMicros};}
      const window = this.currentWindow(budget);
      const windowKey = window.key;
      let windowState = bundle.budgetWindows.find((w) => w.budgetId === budget.id && w.windowKey === windowKey);
      if (!windowState) {
        windowState = {
          budgetId: budget.id,
          windowKey,
          windowStart: window.start,
          windowEnd: window.end,
          open: [],
          settledMicros: "0",
          revision: 1,
        };
      }
      // Per-request idempotency inside the window (TeamBudgetLedger semantics).
      const existingEntry = windowState.open.find((r) => r.requestId === input.requestId);
      if (existingEntry) {
        if (existingEntry.principalId!==principalId||existingEntry.amountMicros !== input.amountMicros) {
          return { ok: false, code: "budget_request_conflict", windowKey };
        }
        return { ok: true, windowKey, requestId: input.requestId, amountMicros: existingEntry.amountMicros };
      }
      if (input.expectedRevision !== undefined && input.expectedRevision !== windowState.revision) {
        return { ok: false, code: "budget_revision_conflict", windowKey };
      }
      const amount = BigInt(input.amountMicros);
      if (amount < 0n) throw new Error("budget_amount_invalid");
      const budgetAmount = budget.unit === "money" ? parseMoneyToMicros(budget.amount) : BigInt(budget.amount);
      const reserved = windowState.open.reduce((acc, r) => acc + BigInt(r.amountMicros), 0n);
      const settled = BigInt(windowState.settledMicros);
      const available = budgetAmount - reserved - settled;
      if (amount > available) {
        return { ok: false, code: "budget_exceeded", windowKey };
      }
      const nextWindow: BudgetWindowState = {
        ...windowState,
        open: [...windowState.open, { requestId: input.requestId, principalId, amountMicros: input.amountMicros }],
        revision: windowState.revision + 1,
      };
      const nextWindows = bundle.budgetWindows.filter((w) => !(w.budgetId === budget.id && w.windowKey === windowKey));
      nextWindows.push(nextWindow);
      const nextBundle = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        budgetWindows: nextWindows,
        workspaces: bundle.workspaces,
        memberships: bundle.memberships,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
      }, { actor: principalId, action: "budget.reserve", workspaceId, subject: `${budget.id}:${input.requestId}` });
      await this.writeBundle(ownerId, nextBundle);
      return { ok: true, windowKey, requestId: input.requestId, amountMicros: input.amountMicros };
    });
  }

  /**
   * Settles ONE reservation by requestId: removes it from open and adds the used
   * amount to settled (never more than was reserved for that request). Unknown
   * outcomes after dispatch retain the reservation; only unsent attempts compensate.
   */
  async settleBudget(principalId: string, workspaceId: string, input: { budgetId: string; windowKey: string; requestId: string; usedMicros: string; compensate?: boolean }): Promise<void> {
    assertPrincipalId(principalId);
    const ownerId = await this.findWorkspaceOwner(workspaceId, principalId);
    await this.serial(ownerId, async () => {
      const bundle = await this.readBundle(ownerId);
      const budget=bundle.budgets.find(b=>b.id===input.budgetId&&b.workspaceId===workspaceId);
      if(!budget||ownerId!==principalId&&!this.effectiveRole(bundle,workspaceId,principalId))throw new Error('workspace_forbidden');
      const idx = bundle.budgetWindows.findIndex((w) => w.budgetId === input.budgetId && w.windowKey === input.windowKey);
      if (idx < 0) throw new Error("budget_settle_invalid");
      const ws = bundle.budgetWindows[idx]!;
      const entryIdx = ws.open.findIndex((r) => r.requestId === input.requestId);
      if (entryIdx < 0) throw new Error("budget_settle_invalid");
        const entry = ws.open[entryIdx]!;
        if(entry.principalId!==principalId)throw new Error('workspace_forbidden');
      const used = BigInt(input.usedMicros);
      const reserved = BigInt(entry.amountMicros);
      if (used < 0n || used > reserved) throw new Error("budget_settle_invalid");
      const settled = BigInt(ws.settledMicros);
      const updated: BudgetWindowState = {
        ...ws,
        open: input.compensate ? ws.open.filter((_, i) => i !== entryIdx) : [...ws.open.slice(0, entryIdx), ...ws.open.slice(entryIdx + 1)],
        settledMicros: input.compensate ? settled.toString() : (settled + used).toString(),
        revision: ws.revision + 1,
      };
      const nextWindows = bundle.budgetWindows.map((w, i) => (i === idx ? updated : w));
      const nextBundle = this.withAudit({
        ...bundle,
        revision: bundle.revision + 1,
        budgetWindows: nextWindows,
        workspaces: bundle.workspaces,
        memberships: bundle.memberships,
        policies: bundle.policies,
        budgets: bundle.budgets,
        projectWorkspaceMap: bundle.projectWorkspaceMap,
      }, { actor: principalId, action: input.compensate ? "budget.compensate" : "budget.settle", workspaceId, subject: `${input.budgetId}:${input.requestId}` });
      await this.writeBundle(ownerId, nextBundle);
    });
  }

  async compensateBudget(principalId: string, workspaceId: string, input: { budgetId: string; windowKey: string; requestId: string }): Promise<void> {
    return this.settleBudget(principalId, workspaceId, { budgetId: input.budgetId, windowKey: input.windowKey, requestId: input.requestId, usedMicros: "0", compensate: true });
  }

  // helpers
  effectiveRole(bundle: GovernanceBundle, workspaceId: string, principalId: string): WorkspaceRole | undefined {
    const m = bundle.memberships.find((mem) => mem.workspaceId === workspaceId && mem.memberId === principalId && mem.state === "active");
    if (m) return m.role;
    // implicit owner check
    const ws = bundle.workspaces.find((w) => w.id === workspaceId);
    if (ws?.ownerPrincipalId === principalId) return "owner";
    return undefined;
  }

  nextSeatNumber(bundle: GovernanceBundle, workspaceId: string): number {
    const seats = bundle.memberships.filter((m) => m.workspaceId === workspaceId && m.state !== "revoked" && m.state !== "expired").map((m) => m.seatNumber ?? 0);
    const max = seats.length ? Math.max(...seats) : 1;
    return max + 1;
  }

  currentWindow(budget: WorkspaceBudget): { key: string; start: string; end: string } {
    const now = this.now();
    const tz = budget.timezone;
    if (budget.period === "total") {
      return { key: "total", start: budget.startsAt ?? new Date(0).toISOString(), end: budget.endsAt ?? new Date(8640000000000000).toISOString() };
    }
    if (budget.period === "day") {
      const start = zonedStartOfDay(now, tz);
      const end = new Date(start.getTime() + 24 * 60 * 60_000);
      return { key: formatZonedDate(start, tz), start: start.toISOString(), end: end.toISOString() };
    }
    if (budget.period === "month") {
      const start = zonedStartOfMonth(now, tz);
      const end = zonedStartOfNextMonth(start, tz);
      return { key: formatZonedMonth(start, tz), start: start.toISOString(), end: end.toISOString() };
    }
    if (budget.period === "week") {
      const start = zonedStartOfWeek(now, tz);
      const end = new Date(start.getTime() + 7 * 24 * 60 * 60_000);
      return { key: formatZonedDate(start, tz), start: start.toISOString(), end: end.toISOString() };
    }
    throw new Error("budget_invalid");
  }

  async findWorkspaceOwner(workspaceId: string, principalId?: string): Promise<string> {
    assertWorkflowId(workspaceId, "workspace_id");
    // Old personal IDs encoded only the first nine principal bytes. Keep their
    // stored IDs and data, but resolve ownership from the authenticated owner,
    // never from the shared prefix or directory enumeration order.
    if (principalId !== undefined) {
      assertPrincipalId(principalId);
      const own = await this.readBundle(principalId);
      if (own.workspaces.some(w => w.id === workspaceId && w.ownerPrincipalId === principalId && !w.deletedAt)) return principalId;
    }
    const principals = await this.listPrincipals();
    const owners: string[] = [];
    let present = false;
    for (const pid of principals) {
      const bundle = await this.readBundle(pid);
      if (bundle.workspaces.some(w => w.id === workspaceId && w.ownerPrincipalId === pid && !w.deletedAt)) {
        present = true;
        if (principalId === undefined || this.effectiveRole(bundle, workspaceId, principalId)) owners.push(pid);
      }
    }
    if (owners.length === 1) return owners[0]!;
    if (owners.length > 1) throw new Error(principalId === undefined ? "workspace_ambiguous" : "workspace_forbidden");
    if (present && principalId !== undefined) throw new Error("workspace_forbidden");
    throw new Error("workspace_not_found");
  }

  async listPrincipals(): Promise<string[]> {
    if (this.ephemeral) return [...this.memoryBundles.keys()];
    let entries: string[] = [];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    return entries.filter((name) => /^[A-Za-z0-9][A-Za-z0-9_-]{0,99}$/.test(name));
  }

  hashForInvite(domain: string, ...parts: string[]): string {
    const secret = this.masterKey ?? Buffer.alloc(0);
    return createHmac("sha256", secret).update([`uptokey-governance-v1:${domain}`, ...parts].join("\0"), "utf8").digest("base64url");
  }

  hashForInviteToken(token: string): string {
    return this.hashForInvite("invite-token", token);
  }

  /**
   * Deterministic invite token (control-plane team-membership pattern): derived
   * from secret + workspace + requestId, so an idempotent replay re-derives the
   * same token without the raw token ever being persisted.
   */
  deriveInviteToken(workspaceId: string, requestId: string): string {
    return `utk_ws_invite_${this.hashForInvite("invite-token-derive", workspaceId, requestId)}`;
  }

  /** Bounded append-only audit trail; caps at GOVERNANCE_AUDIT_CAP (drops oldest). */
  withAudit(bundle: GovernanceBundle, entry: { actor: string; action: string; workspaceId: string | null; subject: string | null }): GovernanceBundle {
    const audit: AuditEntry[] = [...(bundle.audit ?? []), {
      id: randomUUID(),
      at: this.isoNow(),
      actor: entry.actor,
      action: entry.action,
      workspaceId: entry.workspaceId,
      subject: entry.subject,
    }];
    const capped = audit.length > GOVERNANCE_AUDIT_CAP ? audit.slice(audit.length - GOVERNANCE_AUDIT_CAP) : audit;
    return { ...bundle, audit: capped };
  }

  serial<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const next = previous.then(operation, operation);
    this.queues.set(key, next.then(() => undefined, () => undefined));
    return next as Promise<T>;
  }

  async readBundle(principalId: string): Promise<GovernanceBundle> {
    if (this.ephemeral) return structuredClone(this.memoryBundles.get(principalId) ?? emptyBundle());
    const path = this.bundlePath(principalId);
    let sealed: unknown;
    try {
      sealed = await readJson(path, null, 1_048_576);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT" || error instanceof Error && error.message === "json_state_path_invalid") {
        return emptyBundle();
      }
      throw new Error("governance_snapshot_corrupt");
    }
    if (sealed === null) return emptyBundle();
    const envelope = assertSealedEnvelope(sealed as unknown);
    if (envelope.principalId !== principalId) throw new Error("governance_snapshot_corrupt");
    let bytes: Uint8Array;
    try {
      bytes = await this.openSealed(envelope, principalId);
    } catch {
      throw new Error("governance_snapshot_corrupt");
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    } catch {
      throw new Error("governance_snapshot_corrupt");
    }
    const bundle = assertBundle(parsed);
    // Envelope revision must match the plaintext bundle revision (integrity binding,
    // mirroring the WorkspaceStore snapshot pattern).
    if (bundle.revision !== envelope.revision) throw new Error("governance_snapshot_corrupt");
    return bundle;
  }

  async writeBundle(principalId: string, bundle: GovernanceBundle): Promise<void> {
    const valid = assertBundle(bundle);
    const encoded = Buffer.from(JSON.stringify(valid), "utf8");
    if (this.ephemeral) {
      if (encoded.length > 1_048_576 || (!this.memoryBundles.has(principalId) && this.memoryBundles.size >= 256)) throw new Error('governance_capacity_exceeded');
      this.memoryBundles.set(principalId, structuredClone(valid));
      return;
    }
    await mkdir(join(this.root, principalId), { recursive: true, mode: 0o700 });
    await this.writeSealed(this.bundlePath(principalId), encoded, principalId, valid.revision);
  }

  bundlePath(principalId: string): string {
    return join(this.root, principalId, "bundle.json");
  }

  async ensureKey(): Promise<Buffer> {
    if (this.masterKey) return this.masterKey;
    if (this.ephemeral) return this.masterKey = randomBytes(32);
    let encoded: string | undefined;
    try {
      encoded = await this.secrets.get(GOVERNANCE_KEY_ACCOUNT);
    } catch (error) {
      if (error instanceof Error && error.message === "secret_store_read_unavailable") throw error;
      throw new Error("governance_key_unavailable");
    }
    if (!encoded) {
      encoded = randomBytes(32).toString("base64url");
      try {
        await this.secrets.set(GOVERNANCE_KEY_ACCOUNT, encoded);
      } catch {
        throw new Error("governance_key_unavailable");
      }
    }
    const key = Buffer.from(encoded, "base64url");
    if (key.length !== 32 || key.toString("base64url") !== encoded) throw new Error("governance_key_invalid");
    this.masterKey = key;
    return key;
  }

  async projectKey(principalId: string): Promise<Buffer> {
    const master = await this.ensureKey();
    return Buffer.from(hkdfSync("sha256", master, principalId, `uptokey-governance-bundle-v1|${principalId}`, 32));
  }

  async writeSealed(path: string, plaintext: Uint8Array, principalId: string, revision: number): Promise<void> {
    const key = await this.projectKey(principalId);
    const nonce = randomBytes(12);
    try {
      const cipher = createCipheriv("aes-256-gcm", key, nonce);
      cipher.setAAD(Buffer.from(`1|${principalId}|governance|bundle`));
      const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
      const tag = cipher.getAuthTag();
      const sealed = {
        schema: SEALED_SCHEMA,
        alg: "aes-256-gcm",
        kdf: "hkdf-sha256",
        principalId,
        revision,
        nonce: nonce.toString("base64url"),
        ciphertext: ciphertext.toString("base64url"),
        tag: tag.toString("base64url"),
      };
      await writeJsonAtomic(path, sealed, { maximum: 1_048_576 });
    } finally {
      key.fill(0);
      nonce.fill(0);
    }
  }

  async openSealed(envelope: ReturnType<typeof assertSealedEnvelope>, principalId: string): Promise<Uint8Array> {
    const key = await this.projectKey(principalId);
    try {
      const nonce = Buffer.from(envelope.nonce, "base64url");
      const decipher = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: 16 });
      decipher.setAAD(Buffer.from(`1|${principalId}|governance|bundle`));
      decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
      return Buffer.concat([decipher.update(Buffer.from(envelope.ciphertext, "base64url")), decipher.final()]);
    } finally {
      key.fill(0);
    }
  }

  isoNow(): string {
    const value = this.now().toISOString();
    if (!canonicalUtc(value)) throw new Error("workspace_clock_invalid");
    return value;
  }
}

// Helpers
function emptyBundle(): GovernanceBundle {
  return {
    schema: BUNDLE_SCHEMA,
    revision: 0,
    workspaces: [],
    memberships: [],
    policies: [],
    budgets: [],
    projectWorkspaceMap: {},
    budgetWindows: [],
  };
}

function personalWorkspaceId(principalId: string): string {
  const hash = createHash("sha256").update("uptokey-personal-workspace-v2\0").update(principalId).digest("hex");
  return `ws_personal_${hash}`;
}

function isPersonalWorkspaceId(workspaceId: string, principalId: string): boolean {
  const legacy = `ws_personal_${Buffer.from(principalId).toString("base64url").slice(0, 12)}`;
  return workspaceId === personalWorkspaceId(principalId) || workspaceId === legacy;
}

function normalizeIdentity(value: string): string {
  if (typeof value !== "string") throw new Error("team_invite_identity_invalid");
  const candidate = value.trim().normalize("NFKC");
  if (candidate.length < 3 || candidate.length > 254) throw new Error("team_invite_identity_invalid");
  const at = candidate.lastIndexOf("@");
  if (at < 1 || at !== candidate.indexOf("@")) throw new Error("team_invite_identity_invalid");
  const local = candidate.slice(0, at).toLocaleLowerCase("en-US");
  const domain = candidate.slice(at + 1).toLocaleLowerCase("en-US");
  if (!/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+$/.test(local) || !domain.includes(".")) throw new Error("team_invite_identity_invalid");
  return `${local}@${domain}`;
}

function parseMoneyToMicros(amount: string): bigint {
  const [intPart, fracPart = ""] = amount.split(".");
  const fracPadded = (fracPart + "000000").slice(0, 6);
  return BigInt(intPart!) * 1_000_000n + BigInt(fracPadded);
}

/**
 * UTC instant of local midnight (day `d` of month `m`) in `timeZone`, robust at
 * DST edges: guess with the offset computed at the guess itself, then re-check
 * with the offset at the resulting instant (standard two-pass algorithm).
 */
function zonedMidnightUtc(year: number, month1Based: number, day: number, timeZone: string): Date {
  const guess = Date.UTC(year, month1Based - 1, day, 0, 0, 0, 0);
  const offset1 = tzOffsetMinutes(timeZone, new Date(guess));
  const first = guess - offset1 * 60_000;
  const offset2 = tzOffsetMinutes(timeZone, new Date(first));
  return new Date(guess - offset2 * 60_000);
}

function zonedStartOfDay(date: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour12: false,
  }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  const d = Number(parts.find((p) => p.type === "day")!.value);
  return zonedMidnightUtc(y, m, d, timeZone);
}

function zonedStartOfMonth(date: Date, timeZone: string): Date {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(date);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  return zonedMidnightUtc(y, m, 1, timeZone);
}

function zonedStartOfNextMonth(start: Date, timeZone: string): Date {
  // Advance the zoned calendar month: read month/year of start+32d in the zone,
  // then compute midnight of the following month's 1st (clamps overflow safely).
  const probe = new Date(start.getTime() + 32 * 24 * 60 * 60_000);
  const parts = new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "numeric" }).formatToParts(probe);
  const y = Number(parts.find((p) => p.type === "year")!.value);
  const m = Number(parts.find((p) => p.type === "month")!.value);
  return zonedMidnightUtc(y, m, 1, timeZone);
}

function zonedStartOfWeek(date: Date, timeZone: string): Date {
  const dayStart = zonedStartOfDay(date, timeZone);
  // ISO week: Monday-start, weekday read in the target zone at that day start.
  const zonedWeekday = new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(dayStart);
  const offsetDays: Record<string, number> = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };
  return new Date(dayStart.getTime() - (offsetDays[zonedWeekday] ?? 0) * 24 * 60 * 60_000);
}

function formatZonedDate(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  const d = parts.find((p) => p.type === "day")!.value;
  return `${y}-${m}-${d}`;
}

function formatZonedMonth(date: Date, timeZone: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit" }).formatToParts(date);
  const y = parts.find((p) => p.type === "year")!.value;
  const m = parts.find((p) => p.type === "month")!.value;
  return `${y}-${m}`;
}

/**
 * Offset of `timeZone` at the exact instant, computed from formatToParts wall
 * fields (never from locale-string Date.parse, which is platform-fragile and
 * breaks across DST boundaries). Exported for DST regression tests.
 */
export function tzOffsetMinutes(timeZone: string, instant: Date): number {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone, hour12: false, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit",
  }).formatToParts(instant);
  const field = (type: string) => Number(parts.find((p) => p.type === type)!.value);
  const asUtc = Date.UTC(field("year"), field("month") - 1, field("day"), field("hour") % 24, field("minute"), field("second"));
  return Math.round((asUtc - instant.getTime()) / 60_000);
}

function assertBundle(value: unknown): GovernanceBundle {
  const item = isDataRecord(value) ? value : null;
  const keys = item ? Object.keys(item).sort().join(",") : "";
  const required = ["budgetWindows", "budgets", "memberships", "policies", "projectWorkspaceMap", "revision", "schema", "workspaces"];
  const validKeys = keys === required.join(",")
    || keys === [...required, "audit"].sort().join(",")
    || keys === [...required, "workspaceIdempotency"].sort().join(",")
    || keys === [...required, "audit", "workspaceIdempotency"].sort().join(",");
  if (!item || !validKeys || item.schema !== BUNDLE_SCHEMA || !Array.isArray(item.workspaces) || !Array.isArray(item.memberships)
    || !Array.isArray(item.policies) || !Array.isArray(item.budgets) || !Array.isArray(item.budgetWindows)
    || !isDataRecord(item.projectWorkspaceMap) || typeof item.revision !== "number" || !Number.isSafeInteger(item.revision) || item.revision < 0) {
    throw new Error("governance_snapshot_corrupt");
  }
  // Referential integrity: memberships/policies/budgets must reference known workspaces.
  const ids = new Set((item.workspaces as Workspace[]).map((w) => w.id));
  if ((item.memberships as Membership[]).some((m) => !ids.has(m.workspaceId))
    || (item.policies as WorkspacePolicy[]).some((p) => !ids.has(p.workspaceId))
    || (item.budgets as WorkspaceBudget[]).some((b) => !ids.has(b.workspaceId))) {
    throw new Error("governance_snapshot_corrupt");
  }
  for (const budget of item.budgets as WorkspaceBudget[]) {
    if (budget.scope !== 'provider_account' && budget.accountFunding === undefined) continue;
    try {
      const observation = budget.accountFunding;
      if (!observation || budget.scope !== 'provider_account') throw new Error('invalid');
      assertFundingObservation(observation);
      if (budget.id !== fundingBudgetId(observation.providerId, observation.accountId)
        || budget.workspaceId !== personalWorkspaceId(ACCOUNT_FUNDING_PRINCIPAL)
        || budget.subjectId !== observation.accountId || budget.unit !== 'money' || budget.currency !== 'USD'
        || budget.period !== 'total' || budget.timezone !== 'UTC' || budget.includeByokUsage !== true
        || budget.enabled !== true || !Number.isSafeInteger(budget.revision) || budget.revision < 1
        || !/^(0|[1-9][0-9]{0,29})(\.[0-9]{1,6})?$/.test(budget.amount)) throw new Error('invalid');
    } catch { throw new Error('governance_snapshot_corrupt'); }
  }
  // Budget windows: must reference known budgets; open reservations unique per request.
  const budgetIds = new Set((item.budgets as WorkspaceBudget[]).map((b) => b.id));
  for (const w of item.budgetWindows as BudgetWindowState[]) {
    if (!budgetIds.has(w.budgetId) || !Array.isArray(w.open)) throw new Error("governance_snapshot_corrupt");
    if (new Set(w.open.map((r) => r.requestId)).size !== w.open.length) throw new Error("governance_snapshot_corrupt");
    if (w.open.some((r) => !/^(0|[1-9][0-9]{0,29})$/.test(r.amountMicros))) throw new Error("governance_snapshot_corrupt");
    if ((item.budgets as WorkspaceBudget[]).some(b => b.id === w.budgetId && b.scope === 'provider_account')
      && (w.windowKey !== 'total' || !/^(0|[1-9][0-9]{0,29})$/.test(w.settledMicros)
        || !Number.isSafeInteger(w.revision) || w.revision < 1)) throw new Error('governance_snapshot_corrupt');
  }
  return value as GovernanceBundle;
}

function assertSealedEnvelope(value: unknown): { principalId: string; revision: number; nonce: string; ciphertext: string; tag: string } {
  const item = isDataRecord(value) ? value : null;
  if (!item || item.schema !== SEALED_SCHEMA || typeof item.principalId !== "string" || typeof item.nonce !== "string") throw new Error("governance_snapshot_corrupt");
  return item as ReturnType<typeof assertSealedEnvelope>;
}

function claimProcessRoot(root: string, token: string): () => void {
  const current = PROCESS_LOCKS.get(root);
  if (current && current !== token) throw new Error("governance_writer_lock_held");
  PROCESS_LOCKS.set(root, token);
  return () => {
    if (PROCESS_LOCKS.get(root) === token) PROCESS_LOCKS.delete(root);
  };
}

function claimWriterLock(path: string, token: string, pid = process.pid): () => void {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error("governance_lock_invalid");
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 50; attempt += 1) {
    try {
      writeFileSync(path, `${pid}\n${token}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
      return () => {
        try {
          if (readLockState(path)?.token === token) unlinkSync(path);
        } catch {}
      };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const previous = readLockState(path);
      if (!previous) {
        try {
          unlinkSync(path);
        } catch {}
        continue;
      }
      if (previous.token === token)
        return () => {
          try {
            if (readLockState(path)?.token === token) unlinkSync(path);
          } catch {}
        };
      if (processAlive(previous.pid)) throw new Error("governance_writer_lock_held");
      try {
        unlinkSync(path);
      } catch {}
    }
  }
  throw new Error("governance_writer_lock_timeout");
}

function readLockState(path: string): { pid: number; token: string | undefined } | undefined {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink()) throw new Error("governance_lock_path_invalid");
    const lines = readFileSync(path, "utf8").split(/\r?\n/).filter((line) => line.length > 0);
    if (!/^[1-9]\d{0,9}$/.test(lines[0] ?? "")) return undefined;
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || pid <= 1) return undefined;
    const token = lines[1] && /^[A-Za-z0-9_-]{8,128}$/.test(lines[1]) ? lines[1] : undefined;
    return { pid, token };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}
