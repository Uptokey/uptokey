/**
 * Pacote 03 / H3 — autoridade de sinks ligada ao EphemeralSinkGuard.
 *
 * Este é o consumidor de produção do guard: um registro por principal autenticado
 * com o modo de retenção já decidido pela autoridade de credencial (ClientKeyPolicy).
 * A autoridade apenas NEGA sinks duráveis quando o principal está em modo efêmero;
 * ela não concede permissão a sessões duráveis — esse default pertence ao core.
 *
 * Um principal sem registro segue exatamente o comportamento anterior (roteamento e
 * política já existentes). Quando uma sessão efêmera termina, o principal permanece
 * marcado até que uma nova autenticação o registre explicitamente, impedindo que um
 * callback tardio reabilite persistência sem nova admissão.
 */
import { createHash } from "node:crypto";
import { EphemeralSinkGuard, type EphemeralSink } from "./ephemeral-sink-guard.ts";

/** The guard session TTL is a safety bound only; the authenticated lease governs. */
const SESSION_TTL_MS = 24 * 60 * 60 * 1000;

export type RetentionMode = "standard" | "ephemeral";

export interface RetentionRegistration {
  readonly principalId: string;
  readonly retentionMode: RetentionMode;
  readonly policyRevision: string | number;
  /** Optional hard expiry (epoch ms) of the authenticated retention lease. */
  readonly expiresAt?: number;
  /**
   * Credential end generation observed BEFORE the bearer was resolved. A revoke or
   * rotate committed in between makes the admission stale instead of re-enabling it.
   */
  readonly credentialGeneration?: number;
}

/** Deny-only gate consumed by storage owners before a durable write. */
export interface SinkAccessPolicy {
  assertSinkAllowed(principalId: string, sink: EphemeralSink): void;
}

export type SinkAccessDenialCode =
  | "ephemeral_mode_persistence_blocked"
  | "retention_session_ended"
  | "retention_expired"
  | "ephemeral_session_expired"
  | "sink_authority_invalid"
  | "sink_admission_required";

export class SinkAccessDeniedError extends Error {
  readonly code: SinkAccessDenialCode;
  readonly sink: EphemeralSink;
  constructor(code: SinkAccessDenialCode, sink: EphemeralSink, detail?: string) {
    super(detail ?? `${code}:${sink}`);
    this.code = code;
    this.sink = sink;
    this.name = "SinkAccessDeniedError";
  }
}

const PRINCIPAL_ID = /^[A-Za-z0-9_:.@-]{1,200}$/;
const REVISION = /^[A-Za-z0-9_:.@-]{0,200}$/;

interface ActiveRegistration {
  readonly mode: RetentionMode;
  readonly revision: string;
  readonly expiresAt?: number;
  readonly sessionId: string;
}

export class SinkAuthority implements SinkAccessPolicy {
  private readonly guard = new EphemeralSinkGuard();
  private readonly active = new Map<string, ActiveRegistration>();
  private readonly ended = new Map<string, string>();
  private readonly now: () => number;
  private sessionSequence = 0;
  /** Credential suffixes (clientId/admin) ended by revoke/rotate/policy change. */
  private readonly endedCredentials = new Set<string>();
  /** Private-persistence sinks that require an explicit authenticated admission. */
  private readonly admissionRequired = new Set<EphemeralSink>();
  private readonly endListeners = new Set<(event: SinkEndEvent) => void>();
  private readonly credentialGenerations = new Map<string, number>();

  constructor(now: () => number = Date.now) {
    this.now = now;
  }

  /**
   * Registers the retention decision taken by the authenticated authority. Idempotent
   * for the same tuple; a changed registration ends the previous ephemeral session.
   * A new standard registration is the explicit re-admission that clears an ended mark.
   */
  register(registration: RetentionRegistration): void {
    const principalId = registration?.principalId;
    if (typeof principalId !== "string" || !PRINCIPAL_ID.test(principalId)) throw new SinkAccessDeniedError("sink_authority_invalid", "sqlite:conversations", "principal_id_invalid");
    if (registration.retentionMode !== "standard" && registration.retentionMode !== "ephemeral") throw new SinkAccessDeniedError("sink_authority_invalid", "sqlite:conversations", "retention_mode_invalid");
    const revision = String(registration.policyRevision ?? "");
    if (typeof registration.policyRevision !== "string" && typeof registration.policyRevision !== "number") throw new SinkAccessDeniedError("sink_authority_invalid", "sqlite:conversations", "policy_revision_invalid");
    if (registration.expiresAt !== undefined && (!Number.isSafeInteger(registration.expiresAt) || registration.expiresAt <= 0)) throw new SinkAccessDeniedError("sink_authority_invalid", "sqlite:conversations", "expires_at_invalid");

    const suffix = credentialSuffix(principalId);
    if (registration.credentialGeneration !== undefined && registration.credentialGeneration !== this.credentialGeneration(suffix)) {
      throw new SinkAccessDeniedError("sink_authority_invalid", "sqlite:conversations", "credential_generation_stale");
    }
    this.endedCredentials.delete(suffix);
    const previous = this.active.get(principalId);
    const same = previous && previous.mode === registration.retentionMode && previous.revision === revision
      && previous.expiresAt === registration.expiresAt;
    if (same) {
      this.ended.delete(principalId);
      return;
    }
    if (registration.retentionMode === "ephemeral") {
      if (previous) this.guard.terminateSession(previous.sessionId);
      const now = this.now();
      const ttlMs = registration.expiresAt !== undefined ? Math.max(1, registration.expiresAt - now + 60_000) : SESSION_TTL_MS;
      const sessionId = `sink-session:${digest(principalId)}:${digest(revision)}:${now}:${++this.sessionSequence}`;
      this.guard.startEphemeralSession(sessionId, ttlMs, now);
      this.active.set(principalId, {
        mode: "ephemeral",
        revision,
        ...(registration.expiresAt !== undefined ? { expiresAt: registration.expiresAt } : {}),
        sessionId,
      });
      this.ended.delete(principalId);
      return;
    }
    if (previous) this.guard.terminateSession(previous.sessionId);
    this.active.set(principalId, { mode: "standard", revision, ...(registration.expiresAt !== undefined ? { expiresAt: registration.expiresAt } : {}) , sessionId: "" });
    // An explicit authenticated standard admission clears the ended mark.
    this.ended.delete(principalId);
  }

  /**
   * Ends the authenticated session in either retention mode. In-flight calls and
   * late callbacks stay denied until a new authenticated registration (B9-reparo C).
   */
  end(principalId: string, reason: SinkEndReason = "session_ended"): void {
    const previous = this.active.get(principalId);
    if (previous?.mode === "ephemeral") this.guard.terminateSession(previous.sessionId);
    this.ended.set(principalId, previous?.revision ?? "");
    this.active.delete(principalId);
    this.emit({ principalId, reason });
  }

  /**
   * Ends every principal backed by a local credential (any identity namespace).
   * Called by the credential owner after revoke, rotate or a policy change commits.
   */
  endCredential(credentialId: string, reason: SinkEndReason = "credential_changed"): void {
    if (typeof credentialId !== "string" || !CREDENTIAL_ID.test(credentialId)) return;
    this.endedCredentials.add(credentialId);
    this.credentialGenerations.set(credentialId, this.credentialGeneration(credentialId) + 1);
    for (const principalId of [...this.active.keys()]) {
      if (credentialSuffix(principalId) === credentialId) this.end(principalId, reason);
    }
    this.emit({ credentialId, reason });
  }

  /**
   * Marks sinks whose persistence is private to an authenticated identity: an
   * unregistered principal is denied there instead of inheriting the core default.
   */
  requireAdmission(sinks: readonly EphemeralSink[]): void {
    for (const sink of sinks) this.admissionRequired.add(sink);
  }

  /** Monotonic count of ends for a credential suffix; read before resolving a bearer. */
  credentialGeneration(credentialId: string): number {
    return this.credentialGenerations.get(credentialId) ?? 0;
  }

  /** Lifecycle hook for owners with pending work (mobility, uploads). */
  onEnd(listener: (event: SinkEndEvent) => void): () => void {
    this.endListeners.add(listener);
    return () => { this.endListeners.delete(listener); };
  }

  /** True while the principal holds a live registration that was not ended. */
  isAdmitted(principalId: string): boolean {
    const current = this.active.get(principalId);
    return !!current && (current.expiresAt === undefined || this.now() <= current.expiresAt);
  }

  private emit(event: SinkEndEvent): void {
    for (const listener of [...this.endListeners]) {
      try { listener(event); } catch { /* listener faults never re-enable a sink */ }
    }
  }

  isEphemeral(principalId: string): boolean {
    const current = this.active.get(principalId);
    if (!current || current.mode !== "ephemeral") return false;
    if (current.expiresAt !== undefined && this.now() > current.expiresAt) return false;
    return this.guard.isEphemeral(current.sessionId);
  }

  assertSinkAllowed(principalId: string, sink: EphemeralSink): void {
    const current = this.active.get(principalId);
    if (current) {
      if (current.expiresAt !== undefined && this.now() > current.expiresAt) {
        this.guard.terminateSession(current.sessionId);
        this.active.delete(principalId);
        this.ended.set(principalId, current.revision);
        throw new SinkAccessDeniedError("retention_expired", sink);
      }
      if (current.mode === "standard") return;
      try {
        this.guard.assertSinkAllowed(current.sessionId, sink, this.now());
      } catch (error) {
        throw mapGuardError(error, sink);
      }
      return;
    }
    if (this.ended.has(principalId)) throw new SinkAccessDeniedError("retention_session_ended", sink);
    if (this.endedCredentials.has(credentialSuffix(principalId))) throw new SinkAccessDeniedError("retention_session_ended", sink);
    // Unknown identity/policy never authorizes private persistence.
    if (this.admissionRequired.has(sink)) throw new SinkAccessDeniedError("sink_admission_required", sink);
    // No registration on other sinks: the durable default (background jobs owned by
    // the local process) comes from the core's existing policy, never from here.
  }

  /** Test/diagnostic only; absence of an active registration does not deny. */
  activeRegistrationCount(): number {
    return this.active.size;
  }
}

function mapGuardError(error: unknown, sink: EphemeralSink): SinkAccessDeniedError {
  const message = error instanceof Error ? error.message : "";
  if (message.startsWith("ephemeral_mode_persistence_blocked")) return new SinkAccessDeniedError("ephemeral_mode_persistence_blocked", sink, message);
  if (message.startsWith("ephemeral_session_ended")) return new SinkAccessDeniedError("retention_session_ended", sink, message);
  if (message.startsWith("ephemeral_session_expired")) return new SinkAccessDeniedError("ephemeral_session_expired", sink, message);
  return new SinkAccessDeniedError("sink_authority_invalid", sink, message || "ephemeral_sink_denied");
}

export type SinkEndReason = "session_ended" | "credential_changed" | "credential_revoked" | "logout" | "expired";
export interface SinkEndEvent { readonly principalId?: string; readonly credentialId?: string; readonly reason: SinkEndReason }

const CREDENTIAL_ID = /^[A-Za-z0-9-]{1,100}$/;
/** Principal ids are `<namespace>_<clientId|admin>` (workspace/principal.ts). */
function credentialSuffix(principalId: string): string {
  const index = principalId.lastIndexOf("_");
  return index >= 0 ? principalId.slice(index + 1) : principalId;
}

const shared = new SinkAuthority();

function digest(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

/** Single process-wide authority; composition registers authenticated retention here. */
export function sharedSinkAuthority(): SinkAuthority {
  return shared;
}
