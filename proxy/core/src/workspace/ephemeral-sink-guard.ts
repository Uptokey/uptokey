/**
 * Projeto 10 — Guardião de Sinks e Perfil de Execução Efêmero (H3).
 * Bloqueia sinks duráveis quando chamado pelo dono de uma sessão efêmera.
 * Não concede permissões a sessões duráveis; sua política pertence ao core.
 * A existência deste helper não comprova integração nos consumidores.
 */

export interface EphemeralSessionState {
  readonly sessionId: string;
  readonly createdAt: number;
  lastAccessAt: number;
  readonly ttlMs: number;
  isTerminated: boolean;
  readonly memoryBuffers: Map<string, unknown>;
}

export type EphemeralSink =
  | "sqlite:conversations"
  | "sqlite:runs"
  | "sqlite:receipts"
  | "sqlite:changesets"
  | "sqlite:settings"
  | "filesystem:project_write"
  | "filesystem:artifacts"
  | "filesystem:cache"
  | "storage:local_storage"
  | "storage:indexed_db"
  | "storage:cache_storage"
  | "vault:objects"
  | "cloud:sync_upload"
  | "journal:w5_pending"
  | "journal:writable" | "fs:export"
  | "logs:app"
  | "logs:crash_reports"
  | "telemetry:otlp"
  | "clipboard:system"
  | "temp:files"
  | "backup:sqlite";

/** Diagnostic tombstones only; unknown/evicted identities also fail closed. */
const MAX_ENDED_SESSIONS = 4096;
const MAX_ACTIVE_SESSIONS = 4096;

export class EphemeralSinkGuard {
  private readonly activeSessions = new Map<string, EphemeralSessionState>();
  private readonly endedSessions = new Set<string>();
  private readonly defaultTtlMs = 60 * 60 * 1000; // 1 hora de TTL por padrão

  startEphemeralSession(sessionId: string, ttlMs: number = this.defaultTtlMs, now: number = Date.now()): EphemeralSessionState {
    if (typeof sessionId !== "string" || !sessionId.trim() || sessionId.length > 256 ||
      !Number.isSafeInteger(ttlMs) || ttlMs <= 0 || !Number.isSafeInteger(now) || now < 0) {
      throw new Error("ephemeral_session_invalid");
    }
    if (this.activeSessions.has(sessionId)) throw new Error("ephemeral_session_already_registered");
    if (this.endedSessions.has(sessionId)) throw new Error("ephemeral_session_ended");
    if (this.activeSessions.size >= MAX_ACTIVE_SESSIONS) throw new Error("ephemeral_session_capacity");
    const session: EphemeralSessionState = {
      sessionId,
      createdAt: now,
      lastAccessAt: now,
      ttlMs,
      isTerminated: false,
      memoryBuffers: new Map(),
    };
    this.activeSessions.set(sessionId, session);
    // Share the disposable data buffer, never the authorization metadata.
    return { ...session };
  }

  isEphemeral(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    return !session.isTerminated;
  }

  assertSinkAllowed(sessionId: string, sink: EphemeralSink, now: number = Date.now()): void {
    if (!DURABLE_SINKS.includes(sink)) throw new Error("ephemeral_sink_unknown");
    const session = this.activeSessions.get(sessionId);
    // Pacote 03: ending an ephemeral session never re-enables persistence — a late callback of
    // an ended (terminated or expired) session is refused for every durable sink.
    if (!session && this.endedSessions.has(sessionId)) {
      throw new Error("ephemeral_session_ended");
    }
    if (!session) throw new Error("ephemeral_session_unknown");
    if (session.isTerminated) throw new Error("ephemeral_session_ended");
    if (!Number.isSafeInteger(now) || now < session.createdAt || now < session.lastAccessAt) throw new Error("ephemeral_session_invalid_time");

    // Verifica expiração da sessão efêmera
    if (now - session.lastAccessAt >= session.ttlMs) {
      this.terminateSession(sessionId);
      throw new Error("ephemeral_session_expired");
    }

    // A rejected persistence attempt must not extend the session lifetime.
    throw new Error(`ephemeral_mode_persistence_blocked:${sink}`);
  }

  /**
   * The only allowed activity for an active ephemeral session: its disposable
   * in-memory buffers. A successful access extends the TTL (sliding window);
   * expired, ended, unknown or clock-rolled-back accesses are refused and never
   * extend the session.
   */
  accessEphemeralBuffers(sessionId: string, now: number = Date.now()): Map<string, unknown> {
    const session = this.activeSessions.get(sessionId);
    if (!session && this.endedSessions.has(sessionId)) throw new Error("ephemeral_session_ended");
    if (!session) throw new Error("ephemeral_session_unknown");
    if (session.isTerminated) throw new Error("ephemeral_session_ended");
    if (!Number.isSafeInteger(now) || now < session.createdAt || now < session.lastAccessAt) throw new Error("ephemeral_session_invalid_time");
    if (now - session.lastAccessAt >= session.ttlMs) {
      this.terminateSession(sessionId);
      throw new Error("ephemeral_session_expired");
    }
    session.lastAccessAt = now;
    return session.memoryBuffers;
  }

  /** Diagnostic only: false does not authorize an unknown/evicted identity. */
  hasEnded(sessionId: string): boolean {
    return this.endedSessions.has(sessionId);
  }

  terminateSession(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    session.memoryBuffers.clear();
    session.isTerminated = true;
    this.activeSessions.delete(sessionId);
    this.endedSessions.add(sessionId);
    if (this.endedSessions.size > MAX_ENDED_SESSIONS) this.endedSessions.delete(this.endedSessions.values().next().value!);
    return true;
  }

  getActiveSessionsCount(): number {
    return this.activeSessions.size;
  }
}

// Sinks duráveis estritamente proibidos em modo efêmero
const DURABLE_SINKS: readonly EphemeralSink[] = [
  "sqlite:conversations",
  "sqlite:runs",
  "sqlite:receipts",
  "sqlite:changesets",
  "sqlite:settings",
  "filesystem:project_write",
  "filesystem:artifacts",
  "filesystem:cache",
  "storage:local_storage",
  "storage:indexed_db",
  "storage:cache_storage",
  "vault:objects",
  "cloud:sync_upload",
  "journal:w5_pending",
  "journal:writable",
  "logs:app",
  "logs:crash_reports",
  "telemetry:otlp",
  "clipboard:system",
  "temp:files",
  "backup:sqlite",
];
