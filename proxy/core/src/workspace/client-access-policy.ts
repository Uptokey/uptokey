/**
 * Projeto 10 — Motor unificado de autorização e controle de capabilities por cliente (H2).
 * Aplicação estrita no proxy local (core): deny-by-default, audience-binding,
 * expiração, isolamento de sessão efêmera e restrição efetiva do recurso acessado.
 *
 * Escritas duráveis de sistema de arquivos (`filesystem:apply`) exigem gesto humano
 * verificado no runtime (consentimento W5 por plano); posse de chave não é consentimento.
 */
import { createHash } from "node:crypto";
import { isDataRecord, projectStringArray } from "@uptokey/sync-contract/plain-data";

/** "legacy": clients issued before typed registrations, migrated with read-only grants.
 * "tui" (additive): terminal client admitted by explicit pairing (audience requested and
 * approved) bound to an enrolled key, or by an explicit reversible transition; never by name. */
export type ClientAudience = "pwa" | "tauri" | "vscode" | "browser-extension" | "legacy" | "tui";

export const VALID_AUDIENCES: readonly ClientAudience[] = Object.freeze([
  "pwa",
  "tauri",
  "vscode",
  "browser-extension",
  "legacy",
  "tui",
]);

export const CLIENT_CAPABILITY_SCOPES = Object.freeze([
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "project:read",
  "filesystem:read",
  "filesystem:write-plan",
  "filesystem:apply",
  "terminal:interactive",
  "provider:use",
  "sync:read",
  "sync:write",
] as const);

export type ClientCapabilityScope = typeof CLIENT_CAPABILITY_SCOPES[number];

export interface ClientRegistration {
  readonly clientId: string;
  readonly audience: ClientAudience;
  readonly clientName: string;
  readonly grantedScopes: ReadonlySet<ClientCapabilityScope>;
  readonly policyRevision: number;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly revokedAt: number | null;
  /** Projects the client may touch; "*" (default) = every project of its principal. */
  readonly allowedProjects?: ReadonlySet<string> | "*";
  readonly corporateRestrictions?: CorporatePolicyRestrictions;
}

export interface CorporatePolicyRestrictions {
  readonly allowedAudiences?: readonly ClientAudience[];
  readonly disallowedScopes?: readonly ClientCapabilityScope[];
  readonly disableEphemeralMode?: boolean;
  readonly forceEphemeralMode?: boolean;
}

/**
 * The resource a request actually addresses. Enforced, not a digest-only marker:
 * when a client's project grants are finite, a scope naming a project must be granted.
 * Object-level provenance (a conversation/artifact whose project the middleware cannot
 * read from the path) is enforced at the store layer; `resourceScope` does not widen it.
 */
export interface ResourceScope {
  /** Project owning the addressed resource. */
  readonly projectId?: string;
  /** Addressed object identifier (conversation, artifact, root, sync id…). */
  readonly objectId?: string;
  /** Resource category, used for the audit digest and future object-level policy. */
  readonly objectKind?: string;
}

export interface ClientAccessRequest {
  readonly clientId: string;
  readonly audience: ClientAudience;
  readonly capability: ClientCapabilityScope;
  /** Effective resource addressed by the request; enforced against project grants. */
  readonly resourceScope?: ResourceScope;
  /** Project addressed by the request, when the route names one. */
  readonly resourceProjectId?: string;
  readonly operation: "read" | "write-plan" | "apply" | "execute" | "submit";
  /** Server-verified human gesture (W5). Key possession must never set this flag. */
  readonly userGesture: boolean;
  /**
   * Server-verified recovery of an execution the journal already admitted. Set only by
   * the workspace guard after it matched the exact run (principal, project, request,
   * plan, digest and the pertinent conversation admission). It is NOT a human gesture:
   * the durable effect was already approved, so the runtime returns its run/receipt
   * without repeating it. New executions never carry this field and stay behind W5.
   */
  readonly existingRunRecovery?: { readonly runId: string };
  readonly policyRevision: number;
  readonly now: number;
  readonly isEphemeralProfile?: boolean;
}

export type AccessDenialReason =
  | "client_not_found"
  | "client_revoked"
  | "token_expired"
  | "audience_mismatch"
  | "policy_revision_outdated"
  | "scope_not_granted"
  | "resource_not_granted"
  | "corporate_policy_denied"
  | "user_gesture_required"
  | "ephemeral_mode_persistence_blocked"
  | "invalid_request";

export interface ClientAccessAuditRecord {
  readonly timestamp: number;
  readonly clientId: string;
  readonly audience: ClientAudience | "unknown";
  readonly capability: ClientCapabilityScope | "unknown";
  readonly resourceDigest: string | null;
  readonly allowed: boolean;
  readonly code: AccessDenialReason | "granted";
  /** Allowed because a verified already-admitted run was recovered; never human consent. */
  readonly recovery?: true;
}

export interface ClientAccessDecision {
  readonly allowed: boolean;
  readonly code: AccessDenialReason | "granted";
  readonly status: 200 | 401 | 403 | 409;
  readonly auditRecord: ClientAccessAuditRecord;
}

const textId = (value: unknown): value is string => typeof value === "string" && value.length > 0 && value.length <= 200;
const timestamp = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && Math.abs(value) <= 8_640_000_000_000_000;
const revision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;
const audience = (value: unknown): value is ClientAudience => typeof value === "string" && (VALID_AUDIENCES as readonly string[]).includes(value);
const scope = (value: unknown): value is ClientCapabilityScope => typeof value === "string" && (CLIENT_CAPABILITY_SCOPES as readonly string[]).includes(value);

const RESOURCE_SCOPE_KEYS = ["projectId", "objectId", "objectKind"] as const;
const RESOURCE_OBJECT_KIND_MAX = 80;

/** Validates and normalizes a resource scope; returns undefined for absent or invalid values. */
function cleanResourceScope(value: unknown): ResourceScope | undefined {
  if (value === undefined) return undefined;
  if (!isDataRecord(value)) return undefined;
  if (Object.keys(value).some((key) => !(RESOURCE_SCOPE_KEYS as readonly string[]).includes(key))) return undefined;
  const record = value as Record<string, unknown>;
  const out: { projectId?: string; objectId?: string; objectKind?: string } = {};
  if (record.projectId !== undefined) {
    if (!textId(record.projectId)) return undefined;
    out.projectId = record.projectId;
  }
  if (record.objectId !== undefined) {
    if (typeof record.objectId !== "string" || record.objectId.length < 1 || record.objectId.length > 200) return undefined;
    out.objectId = record.objectId;
  }
  if (record.objectKind !== undefined) {
    if (typeof record.objectKind !== "string" || record.objectKind.length < 1 || record.objectKind.length > RESOURCE_OBJECT_KIND_MAX) return undefined;
    out.objectKind = record.objectKind;
  }
  return out;
}

function snapshotRegistration(value: ClientRegistration): ClientRegistration {
  const fail = (): never => { throw new Error("invalid_client_registration"); };
  if (!isDataRecord(value) || !textId(value.clientId) || typeof value.clientName !== "string" || value.clientName.length > 200 || !audience(value.audience) ||
    !revision(value.policyRevision) || !timestamp(value.createdAt) || !timestamp(value.expiresAt) ||
    !(value.revokedAt === null || timestamp(value.revokedAt)) ||
    !(value.grantedScopes instanceof Set) || ![...value.grantedScopes].every(scope) ||
    (value.allowedProjects !== undefined && value.allowedProjects !== "*" &&
      (!(value.allowedProjects instanceof Set) || value.allowedProjects.size > 256 || ![...value.allowedProjects].every(textId)))) return fail();
  let corporateRestrictions: CorporatePolicyRestrictions | undefined;
  if (value.corporateRestrictions !== undefined) {
    const c = value.corporateRestrictions;
    if (!isDataRecord(c) || Object.keys(c).some(k => !["allowedAudiences","disallowedScopes","disableEphemeralMode","forceEphemeralMode"].includes(k)) ||
      (c.disableEphemeralMode !== undefined && typeof c.disableEphemeralMode !== "boolean") ||
      (c.forceEphemeralMode !== undefined && typeof c.forceEphemeralMode !== "boolean") || (c.disableEphemeralMode && c.forceEphemeralMode)) return fail();
    const allowed = c.allowedAudiences === undefined ? undefined : projectStringArray(c.allowedAudiences, VALID_AUDIENCES.length);
    const disallowed = c.disallowedScopes === undefined ? undefined : projectStringArray(c.disallowedScopes, CLIENT_CAPABILITY_SCOPES.length);
    if ((c.allowedAudiences !== undefined && (!allowed || !allowed.every(audience))) ||
      (c.disallowedScopes !== undefined && (!disallowed || !disallowed.every(scope)))) return fail();
    corporateRestrictions = { ...c, ...(allowed ? {allowedAudiences:[...allowed] as ClientAudience[]} : {}), ...(disallowed ? {disallowedScopes:[...disallowed] as ClientCapabilityScope[]} : {}) };
  }
  return {...value, grantedScopes:new Set(value.grantedScopes),
    ...(value.allowedProjects !== undefined ? {allowedProjects:value.allowedProjects === "*" ? "*" : new Set(value.allowedProjects)} : {}),
    ...(corporateRestrictions ? {corporateRestrictions} : {})};
}

const recoveryEvidence = (value: unknown): value is { runId: string } =>
  isDataRecord(value) && Object.keys(value).join(",") === "runId" && textId(value.runId);

function validRequest(value: unknown): value is ClientAccessRequest {
  return isDataRecord(value) && textId(value.clientId) && audience(value.audience) && scope(value.capability) &&
    typeof value.operation === "string" && ["read","write-plan","apply","execute","submit"].includes(value.operation) &&
    typeof value.userGesture === "boolean" &&
    (value.existingRunRecovery === undefined || recoveryEvidence(value.existingRunRecovery)) &&
    revision(value.policyRevision) && timestamp(value.now) &&
    (value.resourceScope === undefined || cleanResourceScope(value.resourceScope) !== undefined) &&
    (value.resourceProjectId === undefined || textId(value.resourceProjectId)) &&
    (value.isEphemeralProfile === undefined || typeof value.isEphemeralProfile === "boolean");
}

export class ClientAccessPolicyEngine {
  private readonly clients = new Map<string, ClientRegistration>();
  private readonly auditLog: ClientAccessAuditRecord[] = [];
  private readonly maxAuditEntries = 1000;

  registerClient(registration: ClientRegistration): void {
    const snapshot = snapshotRegistration(registration);
    this.clients.set(snapshot.clientId, snapshot);
  }

  revokeClient(clientId: string, revokedAt: number = Date.now()): boolean {
    if (!textId(clientId) || !timestamp(revokedAt)) throw new Error("invalid_client_registration");
    const existing = this.clients.get(clientId);
    if (!existing) return false;
    this.clients.set(clientId, {
      ...existing,
      revokedAt,
    });
    return true;
  }

  getClient(clientId: string): ClientRegistration | undefined {
    const record = this.clients.get(clientId);
    return record ? snapshotRegistration(record) : undefined;
  }

  evaluate(request: ClientAccessRequest): ClientAccessDecision {
    const auditInput: Record<string, unknown> = isDataRecord(request) ? request : {};
const auditRecord = (allowed: boolean, code: AccessDenialReason | "granted"): ClientAccessAuditRecord => {
      const cleanedScope = cleanResourceScope(auditInput.resourceScope);
      const resourceDigest = cleanedScope === undefined
        ? null
        : createHash("sha256").update(JSON.stringify(cleanedScope)).digest("hex").slice(0, 16);
      return {
        timestamp: timestamp(auditInput.now) ? auditInput.now : Date.now(),
        clientId: textId(auditInput.clientId) ? auditInput.clientId : "unknown",
        audience: audience(auditInput.audience) ? auditInput.audience : "unknown",
        capability: scope(auditInput.capability) ? auditInput.capability : "unknown",
        resourceDigest,
        allowed,
        code,
        ...(allowed && recoveryEvidence(auditInput.existingRunRecovery) ? { recovery: true as const } : {})
      };
    };

    const recordDecision = (decision: ClientAccessDecision): ClientAccessDecision => {
      this.auditLog.push({...decision.auditRecord});
      if (this.auditLog.length > this.maxAuditEntries) {
        this.auditLog.shift();
      }
      return decision;
    };

    // 1. Basic validation
    if (!validRequest(request)) {
      return recordDecision({
        allowed: false,
        code: "invalid_request",
        status: 403,
        auditRecord: auditRecord(false, "invalid_request"),
      });
    }

    // 2. Client registration lookup
    const client = this.clients.get(request.clientId);
    if (!client) {
      return recordDecision({
        allowed: false,
        code: "client_not_found",
        status: 401,
        auditRecord: auditRecord(false, "client_not_found"),
      });
    }

    // 3. Revocation check
    if (client.revokedAt !== null && request.now >= client.revokedAt) {
      return recordDecision({
        allowed: false,
        code: "client_revoked",
        status: 403,
        auditRecord: auditRecord(false, "client_revoked"),
      });
    }

    // 4. Token expiration check
    if (request.now >= client.expiresAt) {
      return recordDecision({
        allowed: false,
        code: "token_expired",
        status: 401,
        auditRecord: auditRecord(false, "token_expired"),
      });
    }

    // 5. Audience binding check (prevent cross-client token reuse)
    if (client.audience !== request.audience) {
      return recordDecision({
        allowed: false,
        code: "audience_mismatch",
        status: 403,
        auditRecord: auditRecord(false, "audience_mismatch"),
      });
    }

    // 6. Policy revision check (prevent stale grants)
    if (request.policyRevision !== client.policyRevision) {
      return recordDecision({
        allowed: false,
        code: "policy_revision_outdated",
        status: 409,
        auditRecord: auditRecord(false, "policy_revision_outdated"),
      });
    }

    // 7. Ephemeral profile check: durable persistence sinks are strictly blocked
    if (request.isEphemeralProfile) {
      if (
        request.capability === "filesystem:apply" ||
        request.capability === "sync:write" ||
        (request.capability === "project:read" && request.operation === "apply")
      ) {
        return recordDecision({
          allowed: false,
          code: "ephemeral_mode_persistence_blocked",
          status: 403,
          auditRecord: auditRecord(false, "ephemeral_mode_persistence_blocked"),
        });
      }
    }

    // 8. Scope permission check
    if (!client.grantedScopes.has(request.capability)) {
      return recordDecision({
        allowed: false,
        code: "scope_not_granted",
        status: 403,
        auditRecord: auditRecord(false, "scope_not_granted"),
      });
    }

    // 8b. Resource binding: a client limited to some projects cannot address another
    // one, whether the project is named directly or inside the effective resource scope.
    const resourceProject = request.resourceProjectId ?? request.resourceScope?.projectId;
    if (resourceProject !== undefined && client.allowedProjects !== undefined && client.allowedProjects !== "*" && !client.allowedProjects.has(resourceProject)) {
      return recordDecision({
        allowed: false,
        code: "resource_not_granted",
        status: 403,
        auditRecord: auditRecord(false, "resource_not_granted"),
      });
    }

    // 9. Corporate restrictions (interseção estrita: corporate policy always wins)
    if (client.corporateRestrictions) {
      const { allowedAudiences, disallowedScopes, disableEphemeralMode, forceEphemeralMode } = client.corporateRestrictions;
      if (allowedAudiences && !allowedAudiences.includes(request.audience)) {
        return recordDecision({
          allowed: false,
          code: "corporate_policy_denied",
          status: 403,
          auditRecord: auditRecord(false, "corporate_policy_denied"),
        });
      }
      if (disallowedScopes && disallowedScopes.includes(request.capability)) {
        return recordDecision({
          allowed: false,
          code: "corporate_policy_denied",
          status: 403,
          auditRecord: auditRecord(false, "corporate_policy_denied"),
        });
      }
      if ((disableEphemeralMode && request.isEphemeralProfile) || (forceEphemeralMode && !request.isEphemeralProfile)) {
        return recordDecision({
          allowed: false,
          code: "corporate_policy_denied",
          status: 403,
          auditRecord: auditRecord(false, "corporate_policy_denied"),
        });
      }
    }

    // 10. Human gesture enforcement: durable filesystem effects require a verified
    // human gesture (W5 consent in the runtime). Key possession must never satisfy
    // this gate. `sync:write` is NOT a filesystem effect: it stores an E2EE
    // ciphertext envelope under its own scope and full-principal grant, so it is
    // not gated on a gesture here. A server-verified `existingRunRecovery` is the
    // only other way through: the journal already admitted that exact run and the
    // runtime returns its receipt without a new effect — it is not consent and
    // never grants a new execution.
    if (
      request.capability === "filesystem:apply" &&
      !request.userGesture &&
      request.existingRunRecovery === undefined
    ) {
      return recordDecision({
        allowed: false,
        code: "user_gesture_required",
        status: 403,
        auditRecord: auditRecord(false, "user_gesture_required"),
      });
    }

    // All gates pass
    return recordDecision({
      allowed: true,
      code: "granted",
      status: 200,
      auditRecord: auditRecord(true, "granted"),
    });
  }

  getRecentAuditRecords(limit: number = 50): readonly ClientAccessAuditRecord[] {
    if (!Number.isSafeInteger(limit) || limit <= 0) return [];
    return this.auditLog.slice(-Math.min(limit,this.maxAuditEntries)).map(record=>({...record}));
  }
}
