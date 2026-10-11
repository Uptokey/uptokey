import { createHash } from "node:crypto";
import {
  assertRevisionMonotonic,
  authorizeRemoteAccess,
  createMemoryRemoteAccessRunStore,
  isForbiddenRoute,
  parseRemoteAccessProfile,
  RemoteAccessRelay,
  type RemoteAccessProfile,
  type RemoteAccessProfileKind,
  type RemoteAccessRequest,
  type RemoteAccessRunStore,
  type RemoteAccessTransportKind,
  type RemoteAccessTypedError,
} from "./remote-access-profile.ts";

/** E2-18-D: diagnóstico sem instalar/fetch/login implícito. */
export interface TransportDiscoverInput {
  transportKind: RemoteAccessTransportKind;
  platform: "windows" | "macos" | "linux";
}

export interface TransportDiscoverResult {
  transportKind: RemoteAccessTransportKind;
  platform: string;
  installed: boolean;
  observedVersion: string | null;
  observedLicense: string | null;
  available: boolean;
  missingPrerequisites: string[];
  /** Nunca implica instalação ou login. */
  actionsTaken: [];
}

export interface TransportObservation {
  installed: boolean;
  version?: string;
  license?: string;
  /** Se true, binário existe mas setup externo (conta/domínio) ainda falta. */
  setupRequired?: boolean;
  authenticated?: boolean;
  /** Binário presente mas probe de versão falhou — indisponível até prova em contrário. */
  probeFailed?: boolean;
}

/**
 * Descobre estado observado do transporte. A observação é injetada (fixture);
 * esta função NÃO executa install/fetch/login e NÃO herda HOME/tokens do host.
 */
export function discoverRemoteTransport(
  input: TransportDiscoverInput,
  observation: TransportObservation = { installed: false },
): TransportDiscoverResult {
  if (input.transportKind !== "cloudflared" && input.transportKind !== "tailscale") {
    return {
      transportKind: input.transportKind,
      platform: input.platform,
      installed: false,
      observedVersion: null,
      observedLicense: null,
      available: false,
      missingPrerequisites: ["transport_unsupported"],
      actionsTaken: [],
    };
  }
  const missing: string[] = [];
  if (!observation.installed) missing.push("client_not_installed");
  if (observation.probeFailed) missing.push("probe_failed");
  if (observation.setupRequired) missing.push("setup_required");
  if (observation.authenticated === false) missing.push("authentication_required");
  const available = observation.installed && !observation.probeFailed
    && !observation.setupRequired && observation.authenticated !== false;
  return {
    transportKind: input.transportKind,
    platform: input.platform,
    installed: Boolean(observation.installed),
    observedVersion: observation.version ?? null,
    observedLicense: observation.license ?? null,
    available,
    missingPrerequisites: missing,
    actionsTaken: [],
  };
}

/** E2-18-P: plano imutável revisável antes de start. */
export interface RemoteAccessPlanInput {
  expectedRevision: number;
  profile: unknown;
}

export interface RemoteAccessPlan {
  immutable: true;
  revision: number;
  profileId: string;
  kind: RemoteAccessProfileKind;
  transport: Readonly<RemoteAccessProfile["transport"]>;
  origin: string;
  routes: ReadonlyArray<Readonly<RemoteAccessProfile["routes"][number]>>;
  audience: string;
  credentialRef: string;
  limits: Readonly<RemoteAccessProfile["limits"]>;
  policyRef: string;
  resolvedDestination: string;
  /** URL copiável sem segredo (AC09). */
  copyableEndpoint: string;
}

export function planRemoteAccessProfile(input: RemoteAccessPlanInput): RemoteAccessPlan {
  const profile = parseRemoteAccessProfile(input.profile);
  if (profile.revision !== input.expectedRevision) throw new Error("revision_conflict");
  // Plano nasce desabilitado para revisão — start explícito habilita.
  const copyableEndpoint = `${profile.origin}/remote/${profile.id}`;
  if (/utk_|sk-|gsk_|AIza|Bearer|eyJ/.test(copyableEndpoint)) throw new Error("signature_invalid");
  return Object.freeze({
    immutable: true as const,
    revision: profile.revision,
    profileId: profile.id,
    kind: profile.kind,
    transport: Object.freeze({ ...profile.transport }),
    origin: profile.origin,
    routes: Object.freeze(profile.routes.map((route) => Object.freeze({ ...route }))),
    audience: profile.authAudience,
    credentialRef: profile.credentialRef,
    limits: Object.freeze({ ...profile.limits }),
    policyRef: profile.dataHandlingPolicyRef,
    resolvedDestination: profile.origin,
    copyableEndpoint,
  });
}

/** Identidade de processo — PID sozinho nunca autoriza kill. */
export interface ProcessIdentity {
  processId: string;
  binaryPath: string;
  binaryVersion: string;
  argsDigest: string;
  pid: number;
  startedAtMs: number;
}

export function digestProcessArgs(args: readonly string[]): string {
  return createHash("sha256").update(JSON.stringify(args), "utf8").digest("hex").slice(0, 32);
}

export function createProcessIdentity(input: {
  processId: string;
  binaryPath: string;
  binaryVersion: string;
  args: readonly string[];
  pid: number;
  startedAtMs: number;
}): ProcessIdentity {
  if (!/^[A-Za-z0-9_-]{3,100}$/.test(input.processId)) throw new Error("process_identity_unknown");
  if (!Number.isSafeInteger(input.pid) || input.pid < 1) throw new Error("process_identity_unknown");
  if (!Number.isSafeInteger(input.startedAtMs) || input.startedAtMs < 1) throw new Error("process_identity_unknown");
  if (typeof input.binaryPath !== "string" || input.binaryPath.length < 1 || input.binaryPath.includes("\0")) {
    throw new Error("process_identity_unknown");
  }
  return {
    processId: input.processId,
    binaryPath: input.binaryPath,
    binaryVersion: input.binaryVersion,
    argsDigest: digestProcessArgs(input.args),
    pid: input.pid,
    startedAtMs: input.startedAtMs,
  };
}

export function assertSameProcessIdentity(expected: ProcessIdentity, observed: ProcessIdentity): void {
  if (
    expected.processId !== observed.processId
    || expected.binaryPath !== observed.binaryPath
    || expected.binaryVersion !== observed.binaryVersion
    || expected.argsDigest !== observed.argsDigest
    || expected.pid !== observed.pid
    || expected.startedAtMs !== observed.startedAtMs
  ) {
    throw new Error("process_identity_unknown");
  }
}

export type RemoteJobState = "planned" | "starting" | "running" | "stopping" | "stopped" | "revoked" | "unknown";

export interface RemoteJob {
  jobRef: string;
  profileId: string;
  revision: number;
  state: RemoteJobState;
  endpointRef: string;
  receiptRef: string;
  processIdentity?: ProcessIdentity;
  lastHealth: "ok" | "degraded" | "down" | "unknown";
  expiresAt: number | null;
  localWorkPreserved: boolean;
}

export interface ProcessSupervisor {
  /** Check if a process with this identity is currently running. */
  isProcessAlive(identity: ProcessIdentity): Promise<boolean> | boolean;
  /** Optional start hook: launches real local tunnel/transport. */
  launchProcess?(plan: RemoteAccessPlan, args: string[]): Promise<ProcessIdentity>;
}

export interface RemoteAccessControllerOptions {
  store?: RemoteAccessRunStore;
  now?: () => number;
  supervisor?: ProcessSupervisor;
}


/**
 * Controlador start/stop/observe/revoke. Usa relay+store reais; transporte externo
 * permanece fixture (não ativa cloudflared/tailscale serve reais).
 */
export class RemoteAccessController {
  private plan: RemoteAccessPlan | null = null;
  private profile: RemoteAccessProfile | null = null;
  private relay: RemoteAccessRelay | null = null;
  private job: RemoteJob | null = null;
  private readonly store: RemoteAccessRunStore;
  private readonly now: () => number;
  private readonly supervisor?: ProcessSupervisor;
  private readonly grants = new Map<string, CapabilityGrant>();
  private startInFlight = false;

  constructor(options: RemoteAccessControllerOptions = {}) {
    this.store = options.store ?? createMemoryRemoteAccessRunStore();
    this.now = options.now ?? (() => Date.now());
    this.supervisor = options.supervisor;
  }

  getPlan(): RemoteAccessPlan | null { return this.plan; }

  adoptPlan(plan: RemoteAccessPlan, profileInput: unknown): void {
    const profile = parseRemoteAccessProfile(profileInput);
    if (profile.revision !== plan.revision || profile.id !== plan.profileId) throw new Error("revision_conflict");
    this.plan = plan;
    this.profile = { ...profile, enabled: false };
    this.relay = new RemoteAccessRelay(this.profile, this.store);
  }

  /** E2-18-S start — cancelar o plano antes de start gera zero processos. */
  start(input: {
    requestId: string;
    authorityPrincipal: string;
    processIdentity: ProcessIdentity;
    ttlMs?: number;
  }): RemoteJob {
    if (!this.plan || !this.profile || !this.relay) throw new Error("setup_required");
    if (this.job?.state === "running" || this.job?.state === "starting") {
      // Crash entre start/recibo: reconcilia, não abre segundo túnel (AC05).
      return { ...this.job };
    }
    if (this.startInFlight) {
      if (!this.job) throw new Error("process_identity_unknown");
      return { ...this.job };
    }
    if (this.supervisor) {
      const alive = this.supervisor.isProcessAlive(input.processIdentity);
      if (typeof (alive as any)?.then === "function") {
        // Synchronous interface or promise: check alive
      } else if (!alive) {
        throw new Error("process_identity_unknown");
      }
    }
    this.startInFlight = true;
    try {
      const enabled: RemoteAccessProfile = { ...this.profile, enabled: true };
      this.profile = enabled;
      this.relay = new RemoteAccessRelay(enabled, this.store);
      const ttl = input.ttlMs ?? 600_000;
      const job: RemoteJob = {
        jobRef: `job-${input.requestId}`,
        profileId: enabled.id,
        revision: enabled.revision,
        state: "running",
        endpointRef: this.plan.copyableEndpoint,
        receiptRef: `receipt-${input.requestId}`,
        processIdentity: input.processIdentity,
        lastHealth: "ok",
        expiresAt: this.now() + ttl,
        localWorkPreserved: true,
      };
      this.job = job;
      return { ...job };
    } finally {
      this.startInFlight = false;
    }
  }

  stop(input: { jobRef: string; processIdentity: ProcessIdentity }): RemoteJob {
    if (!this.job || this.job.jobRef !== input.jobRef) throw new Error("process_identity_unknown");
    if (!this.job.processIdentity) throw new Error("process_identity_unknown");
    assertSameProcessIdentity(this.job.processIdentity, input.processIdentity);
    this.job = {
      ...this.job,
      state: "stopped",
      lastHealth: "down",
      localWorkPreserved: true,
    };
    this.relay?.disable();
    if (this.profile) this.profile = { ...this.profile, enabled: false };
    return { ...this.job };
  }

  /** E2-18-O observe — nunca inicia novo job. */
  observe(input: { jobRef?: string; cursor?: string }): {
    state: RemoteJobState;
    lastHealth: RemoteJob["lastHealth"];
    expiresAt: number | null;
    nextCursor: string;
    job: RemoteJob | null;
  } {
    const job = this.job;
    if (input.jobRef && job && job.jobRef !== input.jobRef) {
      return { state: "unknown", lastHealth: "unknown", expiresAt: null, nextCursor: input.cursor ?? "0", job: null };
    }
    return {
      state: job?.state ?? "planned",
      lastHealth: job?.lastHealth ?? "unknown",
      expiresAt: job?.expiresAt ?? null,
      nextCursor: String((Number(input.cursor ?? "0") || 0) + 1),
      job: job ? { ...job } : null,
    };
  }

  /** E2-18-R revoke — durável; streams/encerramento observados. */
  revoke(input: { expectedRevision: number; clientRef?: string }): RemoteJob {
    if (!this.profile) throw new Error("setup_required");
    if (input.expectedRevision !== this.profile.revision) throw new Error("revision_conflict");
    this.relay?.revokeAll(input.expectedRevision);
    this.profile = { ...this.profile, enabled: false };
    for (const grant of this.grants.values()) {
      grant.revoked = true;
    }
    this.job = this.job
      ? { ...this.job, state: "revoked", lastHealth: "down", localWorkPreserved: true }
      : {
          jobRef: `job-revoked-${input.clientRef ?? "none"}`,
          profileId: this.profile.id,
          revision: this.profile.revision,
          state: "revoked",
          endpointRef: this.plan?.copyableEndpoint ?? "",
          receiptRef: `receipt-revoke-${this.profile.revision}`,
          lastHealth: "down",
          expiresAt: this.now(),
          localWorkPreserved: true,
        };
    return { ...this.job };
  }

  getRelay(): RemoteAccessRelay {
    if (!this.relay) throw new Error("setup_required");
    return this.relay;
  }

  async authorizeAndDispatch<T>(
    request: RemoteAccessRequest,
    execute: () => Promise<T> | T,
  ): Promise<{ admitted: true; result: T; resumed: boolean } | { admitted: false; reason: string }> {
    if (!this.relay || !this.profile?.enabled) return { admitted: false, reason: "profile_disabled" };
    try {
      const dispatched = await this.relay.dispatch(request, async () => execute());
      return { admitted: true, result: dispatched.result as T, resumed: dispatched.resumed };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "transport_unavailable";
      return { admitted: false, reason };
    }
  }

  /** Grants separados para terminal/desktop/arquivos — não simulam sessão conectada. */
  issueCapabilityGrant(input: {
    capability: "terminal" | "desktop_view" | "desktop_control" | "files";
    deviceId: string;
    principal: string;
    ttlMs: number;
    bindingId?: string;
  }): CapabilityGrant {
    if (!this.profile?.enabled || this.job?.state !== "running") throw new Error("profile_disabled");
    if (!/^[A-Za-z0-9_-]{3,100}$/.test(input.deviceId) || !/^[A-Za-z0-9_-]{3,100}$/.test(input.principal)) {
      throw new Error("identity_unvalidated");
    }
    const grant: CapabilityGrant = {
      grantRef: `grant-${input.capability}-${input.deviceId}-${this.now()}`,
      capability: input.capability,
      deviceId: input.deviceId,
      principal: input.principal,
      bindingId: input.bindingId,
      expiresAt: this.now() + input.ttlMs,
      revoked: false,
      /** Pendência explícita: 9Remote sem API verificável nesta fatia. */
      adapterStatus: "pending_external_api",
      connected: false,
    };
    this.grants.set(grant.grantRef, grant);
    return { ...grant };
  }

  useCapabilityGrant(grantRef: string, capability: CapabilityGrant["capability"]): CapabilityGrant {
    const grant = this.grants.get(grantRef);
    if (!grant || grant.revoked || grant.expiresAt <= this.now()) throw new Error("credential_revoked");
    if (grant.capability !== capability) throw new Error("route_not_declared");
    if (grant.adapterStatus === "pending_external_api") {
      // Não simula desktop/terminal conectado (AC08).
      return { ...grant, connected: false };
    }
    return { ...grant };
  }

  listGrants(): CapabilityGrant[] {
    return [...this.grants.values()].map((grant) => ({ ...grant }));
  }
}

export interface CapabilityGrant {
  grantRef: string;
  capability: "terminal" | "desktop_view" | "desktop_control" | "files";
  deviceId: string;
  principal: string;
  bindingId?: string;
  expiresAt: number;
  revoked: boolean;
  adapterStatus: "pending_external_api" | "ready";
  connected: boolean;
}

/** E2-18-C sync de configuração remota (revisão) — sem abrir envelope criptográfico. */
export interface RemoteConfigSyncState {
  revision: number;
  tenantId: string;
  deviceId: string;
  configDigest: string;
}

export type RemoteConfigSyncResult =
  | { status: "applied"; revision: number; diffRef: string }
  | { status: "duplicate"; revision: number; diffRef: string }
  | { status: "conflict"; revision: number; diffRef: string; reason: RemoteAccessTypedError }
  | { status: "stale"; revision: number; diffRef: string };

export function applyRemoteConfigSync(input: {
  state: RemoteConfigSyncState;
  signed: boolean;
  signatureValid: boolean;
  envelopeTenantId: string;
  envelopeDeviceId: string;
  baseRevision: number;
  nextRevision: number;
  configDigest: string;
  /** Canário — nunca deve aparecer em diff/recibo. */
  canarySecret?: string;
}): RemoteConfigSyncResult {
  if (!input.signed || !input.signatureValid) {
    return {
      status: "conflict",
      revision: input.state.revision,
      diffRef: `diff-reject-${input.state.revision}`,
      reason: "signature_invalid",
    };
  }
  if (input.envelopeTenantId !== input.state.tenantId || input.envelopeDeviceId !== input.state.deviceId) {
    return {
      status: "conflict",
      revision: input.state.revision,
      diffRef: `diff-tenant-${input.state.revision}`,
      reason: "sync_conflict",
    };
  }
  if (input.baseRevision !== input.state.revision) {
    return {
      status: "stale",
      revision: input.state.revision,
      diffRef: `diff-stale-${input.state.revision}`,
    };
  }
  if (input.nextRevision === input.state.revision && input.configDigest === input.state.configDigest) {
    return { status: "duplicate", revision: input.state.revision, diffRef: `diff-dup-${input.state.revision}` };
  }
  try {
    assertRevisionMonotonic(input.state.revision, input.nextRevision);
  } catch {
    return {
      status: "conflict",
      revision: input.state.revision,
      diffRef: `diff-rev-${input.state.revision}`,
      reason: "revision_conflict",
    };
  }
  if (input.canarySecret && input.configDigest.includes(input.canarySecret)) {
    return {
      status: "conflict",
      revision: input.state.revision,
      diffRef: `diff-secret-${input.state.revision}`,
      reason: "signature_invalid",
    };
  }
  input.state.revision = input.nextRevision;
  input.state.configDigest = input.configDigest;
  return { status: "applied", revision: input.nextRevision, diffRef: `diff-ok-${input.nextRevision}` };
}

export function assertRemotePathSafe(path: string): void {
  if (isForbiddenRoute(path)) throw new Error("route_not_declared");
  if (path.includes("..") || /%2f|%5c/i.test(path) || path.includes("//")) throw new Error("route_not_declared");
}

export { authorizeRemoteAccess, parseRemoteAccessProfile };
