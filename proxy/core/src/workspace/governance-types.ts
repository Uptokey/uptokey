/**
 * E2-07 — tipos de governança. Contratos propostos ao W0; sem autor fora do governance-store.
 */

export type WorkspaceRole = "owner" | "admin" | "member" | "viewer";
export type MembershipState = "active" | "invited" | "revoked" | "expired";

export interface Workspace {
  id: string;
  ownerPrincipalId: string;
  name: string;
  description: string;
  revision: number;
  createdAt: string;
  archivedAt: string | null;
  deletedAt?: string | null;
}

export interface Membership {
  workspaceId: string;
  memberId: string;
  role: WorkspaceRole;
  state: MembershipState;
  revision: number;
  createdAt: string;
  updatedAt: string;
  inviteId?: string;
  inviteTokenHash?: string | null;
  emailHash?: string | null;
  expiresAt?: string | null;
  invitedBy?: string | null;
  seatNumber?: number | null;
}

export type PolicyScope = "workspace" | "member" | "key" | "project";

export interface WorkspacePolicy {
  id: string;
  version: number;
  workspaceId: string;
  scope: PolicyScope;
  subjectId?: string | null;
  allowModels?: string[] | null;
  denyModels?: string[] | null;
  allowProviders?: string[] | null;
  denyProviders?: string[] | null;
  allowTools?: string[] | null;
  denyTools?: string[] | null;
  retentionAllowExport?: boolean | null;
  retentionDays?: number | null;
  budgetRefs?: string[] | null;
  preventOverrides?: boolean | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export type BudgetUnit = "request" | "token" | "money";
export type BudgetPeriod = "day" | "week" | "month" | "total";

/** Manual upstream balance observation, owned by the existing governance ledger.
 * It cannot certify later upstream changes or spending outside this proxy. */
export interface AccountFundingObservation {
  providerId: string;
  accountId: string;
  unit: 'usd_micros';
  amountMicros: string;
  source: string;
  observedAt: string;
  validUntil: string;
}

export interface WorkspaceBudget {
  id: string;
  workspaceId: string;
  scope: PolicyScope | "conversation" | "provider_account";
  accountFunding?: AccountFundingObservation;
  enabled?: boolean;
  subjectId?: string | null;
  unit: BudgetUnit;
  currency?: string | null;
  amount: string;
  period: BudgetPeriod;
  timezone: string;
  startsAt?: string | null;
  endsAt?: string | null;
  includeByokUsage: boolean;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface PolicyDecision {
  allowed: boolean;
  reasonCodes: string[];
  policyVersions: Array<{ policyId: string; version: number }>;
  limitsSnapshot: Record<string, unknown> | null;
  admissionId: string | null;
}

export interface GovernanceBundle {
  schema: "uptokey-governance-bundle-v1";
  revision: number;
  workspaces: Workspace[];
  memberships: Membership[];
  policies: WorkspacePolicy[];
  budgets: WorkspaceBudget[];
  projectWorkspaceMap: Record<string, string>;
  budgetWindows: BudgetWindowState[];
  /** Bounded append-only audit trail (last N governance mutations). AC03 "auditado". */
  audit?: AuditEntry[];
  /** Persisted idempotency keys for workspace creation (07-SPECS mutations). */
  workspaceIdempotency?: Record<string, string>;
}

export interface AuditEntry {
  id: string;
  at: string;
  actor: string;
  action: string;
  workspaceId: string | null;
  subject: string | null;
}

export const GOVERNANCE_AUDIT_CAP = 200;

export interface BudgetWindowState {
  budgetId: string;
  windowKey: string;
  windowStart: string;
  windowEnd: string;
  /** Open reservations, one per requestId (TeamBudgetLedger semantics: settle/compensate are per reservation). */
  open: Array<{ requestId: string; principalId: string; amountMicros: string }>;
  settledMicros: string;
  revision: number;
}

export type GovernanceErrorCode =
  | "workspace_forbidden"
  | "membership_revoked"
  | "last_owner"
  | "policy_conflict"
  | "budget_exceeded"
  | "budget_unknown"
  | "invalid_timezone"
  | "workspace_not_found"
  | "workspace_archived"
  | "workspace_revision_conflict"
  | "membership_not_found"
  | "invite_expired"
  | "invite_duplicate"
  | "budget_revision_conflict";

export function isWorkspaceRole(value: unknown): value is WorkspaceRole {
  return value === "owner" || value === "admin" || value === "member" || value === "viewer";
}

export function isBudgetUnit(value: unknown): value is BudgetUnit {
  return value === "request" || value === "token" || value === "money";
}

export function isBudgetPeriod(value: unknown): value is BudgetPeriod {
  return value === "day" || value === "week" || value === "month" || value === "total";
}
