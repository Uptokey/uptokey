/**
 * V2 — Aplicação real da política de acesso por cliente (H2) nas rotas workspace.
 *
 * O ClientAccessPolicyEngine existia sem consumidor de produção. Este guard é o
 * consumidor: cada audiência pareada recebe registro com escopos explícitos;
 * escrita durável (filesystem:apply) permanece fora do escopo de todas as
 * audiências e falha fechada até o fluxo de consentimento nativo (V3).
 * Clientes legados passam pelo adaptador de registro e pelos escopos definidos
 * abaixo; credenciais administrativas mantêm seu caminho de autorização próprio.
 */
import { createPublicKey, timingSafeEqual, verify } from "node:crypto";
import { readBoundedJson } from "@uptokey/sync-contract/limits";
import { WORKFLOW_LIMITS, parseWorkflowCommand } from "@uptokey/sync-contract/workflow";
import type { SecretStore } from "../secret-store.ts";
import { resolveBearer } from "../client-keys.ts";
import {
  CLIENT_CAPABILITY_SCOPES,
  ClientAccessPolicyEngine,
  type ClientAudience,
  type ClientCapabilityScope,
  type ClientRegistration,
  type ResourceScope
} from "./client-access-policy.ts";
import { ClientRegistrationError, migrateUnregisteredClient, readClientRegistration } from "./client-registration.ts";

const CLIENT_TOKEN = /^utk_local_([0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.[A-Za-z0-9_-]{32}$/i;

const FAR_FUTURE_MS = 253_402_300_799_999;

/** Escopos concedidos ao cliente VS Code no V1. Escrita durável fica para o V3. */
export const VS_CODE_WORKSPACE_SCOPES: readonly ClientCapabilityScope[] = [
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "project:read",
  "filesystem:read",
  "filesystem:write-plan",
  "provider:use"
];

/** Escopos PWA: leitura + planos + sync E2EE opt-in. Sem escrita durável. */
export const PWA_WORKSPACE_SCOPES: readonly ClientCapabilityScope[] = [
  "terminal:interactive",
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "project:read",
  "filesystem:read",
  "filesystem:write-plan",
  "provider:use",
  "sync:read",
  "sync:write"
];

/** Escopos Tauri: mesmos da PWA — IPC nativo não amplia escrita durável. */
export const TAURI_WORKSPACE_SCOPES: readonly ClientCapabilityScope[] = [
  "terminal:interactive",
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "project:read",
  "filesystem:read",
  "filesystem:write-plan",
  "provider:use",
  "sync:read",
  "sync:write"
];

/** Escopos da extensão de navegador: mínimos — sem filesystem, sem sync:write. */
export const BROWSER_EXTENSION_SCOPES: readonly ClientCapabilityScope[] = [
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "sync:read"
];

/**
 * Escopos TUI (terminal): chat, conversas, projeto e planos de arquivo, sem sync E2EE e sem
 * escrita durável (W5 por plano no runtime). Não concede gestão de credenciais/provedores.
 */
export const TUI_WORKSPACE_SCOPES: readonly ClientCapabilityScope[] = [
  "chat:submit",
  "conversation:read",
  "conversation:write",
  "project:read",
  "filesystem:read",
  "filesystem:write-plan",
  "provider:use"
];

/** Clients issued before typed registrations (or with an unrecognized label): read-only until re-paired. */
export const LEGACY_SCOPES: readonly ClientCapabilityScope[] = [
  "conversation:read",
  "project:read"
];

const SCOPES_BY_AUDIENCE: Record<ClientAudience, readonly ClientCapabilityScope[]> = {
  legacy: LEGACY_SCOPES,
  vscode: VS_CODE_WORKSPACE_SCOPES,
  pwa: PWA_WORKSPACE_SCOPES,
  tauri: TAURI_WORKSPACE_SCOPES,
  "browser-extension": BROWSER_EXTENSION_SCOPES,
  tui: TUI_WORKSPACE_SCOPES,
};

export type WorkspaceAccessDenial = { status: 401 | 403 | 409; type: string };

/** Audited memory-only paths. New routes do not silently inherit ephemeral admission. */
export function allowsEphemeralRequest(method: string, pathname: string): boolean {
  if (method === 'POST' && ['/v1/chat/completions', '/v1/completions', '/v1/responses', '/v1/messages'].includes(pathname)) return true;
  if (method === 'GET' && ['/v1/models', '/v1/usage', '/v1/usage/estimation', '/v1/workspace/conversations'].includes(pathname)) return true;
  if (method === 'POST' && pathname === '/v1/workspace/conversations/create') return true;
  const match = /^\/v1\/workspace\/conversations\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(\/[^/]+)?$/.exec(pathname);
  if (!match) return false;
  return method === 'GET' ? ['', '/messages', '/events', '/outbox', '/runs'].includes(match[1] ?? '')
    : method === 'POST' && ['/update', '/delete', '/messages', '/events'].includes(match[1] ?? '');
}

/**
 * Rotas de declaração/cerimônia do fluxo de plano: criar projeto, registrar raiz
 * (grant de caminho), consentimento por plano e cancelamento de run próprio.
 * Nenhuma delas aplica efeito de arquivo diretamente; a escrita durável continua
 * exigindo assinatura por plano/digest no core e permanece em `filesystem:apply`.
 */
const PLAN_FLOW_SUFFIXES = /(?:^|\/)(?:projects\/create|project-roots\/register|consent\/(?:challenge|complete)|runs\/[^/]+\/cancel)$/;

const DURABLE_WRITE_SUFFIXES = /(?:^|\/)(?:runs\/start|delete|export\/zip)$/;

export function mapWorkspaceCapability(method: string, pathname: string): ClientCapabilityScope {
  const suffix = pathname.replace(/^\/v1\/workspace\//, "");
  if(/^projects\/[^/]+\/learned-recipes\/[^/]+\/access(?:\/|$)/.test(suffix))return method==='GET'?'project:read':'conversation:write';
  if(/^projects\/[^/]+\/learned-recipes\/[^/]+\/service-plans$/.test(suffix))return 'chat:submit';
  if(/^services(?:\/|$)/.test(suffix))return method==='GET'?'project:read':'conversation:write';
  if(/^projects\/[^/]+\/service-plans$/.test(suffix))return 'chat:submit';
  // Direct human terminal input has its own capability. It is never an AI plan or a W5 bypass.
  if (/^projects\/[^/]+\/terminals(?:\/|$)/.test(suffix)) return 'terminal:interactive';
  // Sync E2EE opt-in: leitura e escrita de envelopes cifrados.
  if (/^sync-data(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "sync:read";
    return "sync:write";
  }
  // B9-reparo: mobilidade local-first usa as mesmas capacidades de sync.
  if (/^mobility(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "sync:read";
    return "sync:write";
  }
  if (/^conversations(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "conversation:read";
    if (/(?:^|\/)conversations\/(?:create|import)$/.test(suffix) || /conversations\/[^/]+\/(?:update|delete)$/.test(suffix)) return "conversation:write";
    return "chat:submit";
  }
  // Jev judgments send text to the person's TypeSafe profile like a chat turn; they change nothing.
  if (suffix === "classification/judge") return method === "POST" ? "chat:submit" : "project:read";
  if (/^settings(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "conversation:write";
  }
  // Project metadata, classifications, learned recipes and model plans are
  // control-plane operations. They do not write user files by themselves and
  // must not fall through to the durable filesystem gate merely because they
  // are POST requests. Any actual file effect still uses the explicit
  // filesystem routes below and remains behind W5.
  if (/^projects\/[^/]+\/(?:update|classification-plans(?:\/|$)|usage-classifications(?:\/|$)|learned-recipes(?:\/|$)|multimodel-plans(?:\/|$)|plans(?:\/|$)|recipes(?:\/|$))/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "conversation:write";
  }
  if (/^projects\/[^/]+\/project-agent(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "filesystem:write-plan";
  }
  if (/^projects\/[^/]+\/project-roots\/[^/]+\/restore-file(?:\/|$)/.test(suffix)) {
    return "filesystem:write-plan";
  }
  // Project deletion is a control-plane tombstone; the handler enforces
  // revision/ownership and does not mutate files. Keep filesystem effects
  // behind W5, but do not hide 409 revision conflicts behind the outer guard.
  if (/^projects\/[^/]+\/delete$/.test(suffix)) {
    return "conversation:write";
  }
  if (/^projects\/[^/]+\/multimodel-runs(?:\/|$)/.test(suffix)
    || /^projects\/[^/]+\/classification-results(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "conversation:write";
  }
  if (/^projects\/[^/]+\/runs\/[^/]+\/resolve-attention$/.test(suffix)) {
    return "conversation:write";
  }
  // B9: store-only media imports (CAS artifact, no user file effect) and the
  // governed realtime voice session lifecycle. Without these explicit entries
  // they fell through to `filesystem:apply` and were rejected for every client
  // token with `user_gesture_required`, although the PWA calls them
  // (design-bridge/media.tsx, GatewayChatRun.tsx, design-bridge/voice.tsx).
  // Voice sessions reach a paid realtime provider, hence `chat:submit`.
  if (/^projects\/[^/]+\/(?:audio-import|image-import)$/.test(suffix)) {
    return "conversation:write";
  }
  if (/^projects\/[^/]+\/voice-sessions(?:\/[^/]+\/(?:interrupt|stop|audio|commit))?$/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "chat:submit";
  }
  // B9: usage observability query/detail are pure reads that take a JSON body
  // (usage-observability-http.ts accepts GET or POST); the PWA panel
  // (design-bridge/observability.tsx -> UsageObservabilityPanel) sends POST.
  if (/^usage\/(?:query|detail)$/.test(suffix)) {
    return "project:read";
  }
  if (/^(?:classification-plans|usage-classifications|learned-recipes|multimodel-plans)(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "conversation:write";
  }
  // Configuration and lifecycle endpoints mutate control-plane profiles only;
  // they must reach their own validation (400/409) instead of being mistaken
  // for a durable filesystem effect and rejected by the outer W5 gate.
  if (/(?:^|\/)(?:config|connections|automations|presets|recipes|import|export)(?:\/|$)/.test(suffix)
    || /^(?:image|video|audio|speech|transcription|embedding|tts|stt)(?:\/|$)/.test(suffix)) {
    if (method === "GET") return "project:read";
    return "conversation:write";
  }
  // Citation verification only reads the saved artifact and its receipt and
  // compares digests (web-sources.ts::verifyCitation); it writes nothing, so it
  // is a read and must not fall through to the W5 filesystem:apply gate.
  if (/^projects\/[^/]+\/web-citations$/.test(suffix)) return "project:read";
  // Deriving a result writes a new app-owned artifact into the workspace store
  // under an expectedRevision check (runtime.deriveArtifact); it touches no user
  // file or external effect, so it is a control-plane write, not W5 filesystem:apply.
  if (/^projects\/[^/]+\/artifacts\/[^/]+\/derive$/.test(suffix)) return "conversation:write";
  if (method === "GET") return "project:read";
  if (PLAN_FLOW_SUFFIXES.test(suffix)) return "filesystem:write-plan";
  if (/project-roots\/[^/]+\/revoke$/.test(suffix)) {
    return "filesystem:write-plan";
  }
  if (DURABLE_WRITE_SUFFIXES.test(suffix) || /runs\/[^/]+\/resolve-attention$/.test(suffix)) {
    return "filesystem:apply";
  }
  if (/(?:chat|adapted-chat|audio-chat|tool|browser|web|speech|embeddings|transcription|image|video|filesystem)-plans$/.test(suffix)
    || /(?:api|rss|productivity|recipe|classification|protocol|multimodel)-plans$/.test(suffix)
    || /(?:api-intent|api-composite|api|learned-recipe|multimodel)-plans$/.test(suffix)) {
    return "chat:submit";
  }
  if (/preflight$/.test(suffix) || /plans$/.test(suffix)) return "filesystem:write-plan";
  return "filesystem:apply";
}

export interface WorkspaceAccessGuard {
  (header: string | undefined, method: string, pathname: string, context?: string | WorkspaceAccessContext): Promise<WorkspaceAccessDenial | undefined>;
  audit: () => readonly import("./client-access-policy.ts").ClientAccessAuditRecord[];
}

/** Command identity of a `runs/start` request: the journal projection of the client intention. */
export interface RunStartCommandIdentity {
  readonly requestId: string;
  readonly planId: string;
  readonly planDigest: string;
}

/**
 * Request data the guard may use for classification. Only `runStart` participates in
 * the recovery decision; the legacy positional consent-proof string is accepted for
 * caller compatibility but never authorizes anything (key possession is not consent).
 */
export interface WorkspaceAccessContext {
  readonly runStart?: RunStartCommandIdentity;
  readonly conversationId?: string;
  readonly conversationRequestId?: string;
}

/** Evidence returned by the recovery authority after the journal confirmed the exact run. */
export interface RunRecoveryEvidence {
  readonly runId: string;
}

/** Undefined = no admitted run for this identity/request (a new execution, behind W5). */
export type RunRecoveryClassification =
  | { readonly kind: "recovery"; readonly evidence: RunRecoveryEvidence }
  | { readonly kind: "conflict"; readonly code: string };

export interface RunStartRecoveryRequest {
  readonly authorization: string | undefined;
  readonly projectId: string;
  readonly command: RunStartCommandIdentity;
  readonly conversationId?: string;
  readonly conversationRequestId?: string;
}

/**
 * Server authority that resolves `runs/start` replay from the canonical journal and
 * conversation admissions. It must return a conflict whenever a run exists but any
 * binding diverges (plan, digest, project, identity or conversation reassignment),
 * so an altered replay can never settle as a recovery.
 */
export type RunStartRecoveryAuthority = (request: RunStartRecoveryRequest) => Promise<RunRecoveryClassification | undefined>;

const RUN_START_PATH = /^\/v1\/workspace\/projects\/([^/]+)\/runs\/start$/;

/** Project addressed by an exact `runs/start` path, when the route is that one. */
export function runStartProjectFromPath(pathname: string): string | undefined {
  const match = RUN_START_PATH.exec(pathname);
  return match?.[1] ? decodeURIComponent(match[1]) : undefined;
}

/**
 * Reads the canonical startRun command from a clone of the request body so the guard
 * can classify replays. The original stream is untouched; an invalid body is simply
 * not classified and keeps the route's own validation and W5 gate.
 */
export async function readRunStartCommand(request: Request): Promise<RunStartCommandIdentity | undefined> {
  try {
    const parsed = await readBoundedJson(request.clone(), WORKFLOW_LIMITS.commandBytes);
    if (!parsed.ok) return undefined;
    const command = parseWorkflowCommand("startRun", parsed.value);
    return { requestId: command.requestId, planId: command.planId, planDigest: command.planDigest };
  } catch { return undefined; }
}

export function createWorkspaceAccessGuard(secrets: SecretStore, now: () => number = Date.now, runStartRecovery?: RunStartRecoveryAuthority): WorkspaceAccessGuard {
  const engine = new ClientAccessPolicyEngine();
  const seenConsentNonces = new Map<string, number>();
  const guard = async (header: string | undefined, method: string, pathname: string, context?: string | WorkspaceAccessContext): Promise<WorkspaceAccessDenial | undefined> => {
    const token = /^Bearer (\S+)$/i.exec(header ?? "")?.[1];
    const clientId = token ? CLIENT_TOKEN.exec(token)?.[1] : undefined;
    if (!clientId) return undefined;
    const storedToken = await secrets.get(`local:client:${clientId}`);
    if (!storedToken || !sameToken(storedToken, token!)) {
      return { status: 401, type: "client_not_found" };
    }
    // L1: audience comes from the typed registration written by the enrollment path;
    // the display name never decides it. Unregistered clients get a one-time,
    // non-widening migration (unknown labels become read-only "legacy").
    let stored;
    try { stored = await readClientRegistration(secrets, clientId) ?? await migrateUnregisteredClient(secrets, clientId); }
    catch (error) {
      if (error instanceof ClientRegistrationError) return { status: 403, type: "client_registration_invalid" };
      throw error;
    }
    const audience = stored.audience;
    const clientName = (await secrets.get(`local:client:${clientId}:name`)) ?? audience;
    // First-party template: admitted by the origin-bound, key-signed browser session. It keeps
    // the workspace surface it already had; durable effects remain behind W5 signed consent
    // inside the runtime. Pairing/provision audiences keep their narrower scope sets.
    // Only the PWA audience keeps that surface: an identity explicitly transitioned to a
    // narrower audience (e.g. pwa → tui) keeps its enrolledVia provenance but not the grant.
    const firstParty = stored.enrolledVia === "browser-session" && audience === "pwa";

    const expiresIso = await secrets.get(`local:client:${clientId}:expires`);
    const meta = await readJson(secrets, `local:client-meta:${clientId}`);
    const revokedIso = meta?.revokedAt;
    const registration: ClientRegistration = {
      clientId,
      audience,
      clientName,
      grantedScopes: new Set(firstParty ? CLIENT_CAPABILITY_SCOPES : SCOPES_BY_AUDIENCE[audience]),
      policyRevision: stored.policyRevision,
      allowedProjects: stored.projects === "*" ? "*" : new Set(stored.projects),
      createdAt: Date.parse(meta?.createdAt ?? "") || now(),
      expiresAt: expiresIso ? Date.parse(expiresIso) || now() : FAR_FUTURE_MS,
      revokedAt: revokedIso ? Date.parse(revokedIso) : null
    };
    // Human consent (userGesture) cannot be derived from client Origin, presumed gesture
    // (firstParty browser-session), or cryptographic proof of key possession. The HTTP middleware guard
    // does not assert human consent for durable filesystem modifications (W5 plan consent
    // belongs to the runtime).
    const userGesture = false;
    const authenticated = await resolveBearer(secrets, token!, now());
    if (!authenticated.ok) return {status:401, type:authenticated.error};
    if (authenticated.resolved.kind !== "client" || authenticated.resolved.delegation) return {status:403, type:"scope_not_granted"};
    const ephemeral = authenticated.resolved.policy?.retentionMode === 'ephemeral';
    if (ephemeral && !allowsEphemeralRequest(method, pathname)) return {status:403, type:'ephemeral_mode_persistence_blocked'};
    try {
      const current = await readClientRegistration(secrets, clientId);
      if (!current) return {status:403, type:"client_registration_invalid"};
      if (JSON.stringify(current) !== JSON.stringify(stored)) return {status:409, type:"policy_revision_outdated"};
      engine.registerClient(ephemeral ? { ...registration, corporateRestrictions: { forceEphemeralMode: true } } : registration);
    } catch (error) {
      if (error instanceof ClientRegistrationError || (error instanceof Error && error.message === "invalid_client_registration")) return {status:403, type:"client_registration_invalid"};
      throw error;
    }
    const resourceProjectId = workspaceProjectFromPath(pathname);
    const evaluate = (existingRunRecovery?: RunRecoveryEvidence) => engine.evaluate({
      clientId,
      audience,
      capability: mapWorkspaceCapability(method, pathname),
      operation: method === "GET" ? "read" : "apply",
      userGesture,
      policyRevision: stored.policyRevision,
      now: now(),
      resourceScope: resourceScopeFromPath(pathname),
      isEphemeralProfile: ephemeral,
      resourceProjectId,
      ...(existingRunRecovery ? { existingRunRecovery } : {})
    });
    let decision = evaluate();
    // New executions of durable effects stay denied here: W5 consent is verified only
    // by the runtime on consent/complete. A verified replay of an already-admitted run
    // is a recovery, not a gesture — the effect was approved and must not run again.
    if (!decision.allowed && decision.code === "user_gesture_required"
      && method === "POST" && runStartRecovery && typeof context === "object" && context?.runStart) {
      const projectId = runStartProjectFromPath(pathname);
      if (projectId) {
        let classified: RunRecoveryClassification | undefined;
        try {
          classified = await runStartRecovery({
            authorization: header,
            projectId,
            command: context.runStart,
            ...(context.conversationId !== undefined ? { conversationId: context.conversationId } : {}),
            ...(context.conversationRequestId !== undefined ? { conversationRequestId: context.conversationRequestId } : {})
          });
        } catch { classified = undefined; }
        if (classified?.kind === "conflict") return { status: 409, type: classified.code };
        if (classified?.kind === "recovery") decision = evaluate(classified.evidence);
      }
    }
    if (!decision.allowed) return { status: decision.status as 401 | 403 | 409, type: decision.code };
    return undefined;
  };
  guard.audit = () => engine.getRecentAuditRecords();
  return guard;
}

export const KEY_POSSESSION_PROOF_WINDOW_MS = 60_000;
/** @deprecated Use KEY_POSSESSION_PROOF_WINDOW_MS. Cryptographic key possession is origin proof, not human consent. */
export const CONSENT_PROOF_WINDOW_MS = KEY_POSSESSION_PROOF_WINDOW_MS;

const KEY_POSSESSION_PROOF = /^(\d{13})\.([A-Za-z0-9_-]{22,64})\.([A-Za-z0-9_-]{86})$/;

/**
 * Canonical bytes signed with an enrolled client key to prove origin/possession (`x-uptokey-key-proof`).
 * Cryptographic proof of key possession verifies origin authentication, NOT human consent.
 */
export function keyPossessionProofMessage(clientId: string, method: string, pathname: string, timestamp: number, nonce: string): Buffer {
  return Buffer.from(["uptokey-workspace-key-proof-v1", clientId, method.toUpperCase(), pathname, String(timestamp), nonce].join("\n"), "utf8");
}

/** @deprecated Use keyPossessionProofMessage. Key possession is not human consent. */
export function consentProofMessage(clientId: string, method: string, pathname: string, timestamp: number, nonce: string): Buffer {
  return Buffer.from(["uptokey-workspace-consent-v1", clientId, method.toUpperCase(), pathname, String(timestamp), nonce].join("\n"), "utf8");
}

/**
 * Proof of possession of the client's enrolled workspace key (ECDSA P-256, ieee-p1363) bound to
 * client, method, path and a fresh timestamp, with single-use nonces.
 * Proves origin authentication. This is NOT human consent and must not grant userGesture.
 * Limit: the body is not bound (effects keep their own CAS/plan digest checks).
 */
export async function verifyKeyPossessionProof(secrets: SecretStore, clientId: string, method: string, pathname: string, proof: string | undefined, nowMs: number, seen: Map<string, number>): Promise<boolean> {
  if (!proof) return false;
  const match = KEY_POSSESSION_PROOF.exec(proof);
  if (!match) return false;
  const timestamp = Number(match[1]);
  if (!Number.isSafeInteger(timestamp) || Math.abs(nowMs - timestamp) > KEY_POSSESSION_PROOF_WINDOW_MS) return false;
  for (const [nonce, at] of seen) if (nowMs - at > KEY_POSSESSION_PROOF_WINDOW_MS * 2) seen.delete(nonce);
  const nonceKey = `${clientId}:${match[2]}`;
  if (seen.has(nonceKey) || seen.size >= 4096) return false;
  const stored = await secrets.get(`local:client:${clientId}:workspace-key`);
  if (!stored) return false;
  try {
    const key = createPublicKey({ key: JSON.parse(stored), format: "jwk" });
    const signature = Buffer.from(match[3]!, "base64url");
    if (signature.length !== 64) return false;
    const validKeyProof = verify("sha256", keyPossessionProofMessage(clientId, method, pathname, timestamp, match[2]!), { key, dsaEncoding: "ieee-p1363" }, signature);
    const validLegacy = !validKeyProof && verify("sha256", consentProofMessage(clientId, method, pathname, timestamp, match[2]!), { key, dsaEncoding: "ieee-p1363" }, signature);
    if (!validKeyProof && !validLegacy) return false;
  } catch { return false; }
  // Loading the enrolled key yields: another request may have consumed this
  // nonce meanwhile. Final check and consumption must be synchronous together.
  if (seen.has(nonceKey) || seen.size >= 4096) return false;
  seen.set(nonceKey, nowMs);
  return true;
}

/** @deprecated Use verifyKeyPossessionProof. Key possession is not human consent. */
export const verifyConsentProof = verifyKeyPossessionProof;

/** Project addressed by a workspace route (`/v1/workspace/projects/<id>/...`), when any. */
export function workspaceProjectFromPath(pathname: string): string | undefined {
  const match = /^\/v1\/workspace\/projects\/([^/]+)(?:\/|$)/.exec(pathname);
  const id = match?.[1];
  return id && id !== "create" && id !== "import" ? decodeURIComponent(id) : undefined;
}

/** Derives structured resource identity from a workspace request path. */
export function resourceScopeFromPath(pathname: string): ResourceScope | undefined {
  const projectId = workspaceProjectFromPath(pathname);
  const conversation = /^\/v1\/workspace\/conversations\/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\/|$)/.exec(pathname);
  if (conversation) {
    return { ...(projectId ? { projectId } : {}), objectId: conversation[1], objectKind: "conversation" };
  }
  const sync = /^\/v1\/workspace\/sync-data\/([^/]+)$/.exec(pathname);
  if (sync) {
    return { objectId: sync[1], objectKind: "sync-data" };
  }
  const root = /^\/v1\/workspace\/projects\/[^/]+\/project-roots\/([^/]+)/.exec(pathname);
  if (root) {
    return { ...(projectId ? { projectId } : {}), objectId: root[1], objectKind: "project-root" };
  }
  const artifact = /^\/v1\/workspace\/projects\/[^/]+\/artifacts\/([^/]+)/.exec(pathname);
  if (artifact) {
    return { ...(projectId ? { projectId } : {}), objectId: artifact[1], objectKind: "artifact" };
  }
  if (projectId) {
    return { projectId, objectKind: "project" };
  }
  return undefined;
}

async function readJson(secrets: SecretStore, key: string): Promise<{ createdAt?: string; revokedAt?: string } | undefined> {
  const raw = await secrets.get(key);
  if (!raw) return undefined;
  try { return JSON.parse(raw); } catch { return undefined; }
}

function sameToken(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}
