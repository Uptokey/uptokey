import {createManagedVoice} from './voice-profile.ts';
import {isAccountMobilityPath,readAccountControlRequest} from './account-login-protocol.ts';
import {createManagedMedia,type MediaLaunchDependencies} from './managed-media.ts';
import {LocalDelegatedKeys} from './delegated-access.ts';
import {delegatedMethod,mountDelegatedRoutes} from './delegated-access-http.ts';
import { mountClientAndManagementRoutes } from "./client-keys-http.ts";
import { isLocalEndpointUrl } from "./endpoint-policy.ts";
import { isLocalModelAlias } from "./local-model-aliases.ts";
import { Hono, type Context } from "hono";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { join } from "node:path";
import { createParser } from "eventsource-parser";
import type { DispatchContext, ProviderName, ProxyConfig } from "./types.ts";
import type { SecretStore } from "./secret-store.ts";
import { guardOffline, type OfflineDecision } from "./offline-policy.ts";
import { Router, buildDispatchBudgetAttempt, buildUnitBudgetAttempt, type MediaBillingUsage } from "./router.ts";
import { conservativeTokenEstimate, planAttemptAccounting } from './token-estimate.ts';
import {dispatchInference} from './inference-service.ts';
import { LocalAuthRateLimiter } from "./auth-rate-limit.ts";
import { isDataRecord as isJsonObject } from "@uptokey/sync-contract/plain-data";
import { PairingService, provisionPairedClient } from "./pairing.ts";
import { PAIRING_AUDIENCES, parsePairingAudience, type PairingAudience } from "@uptokey/sync-contract/client-keys";
import { ControlCapabilityService } from "./control-capability.ts";
import { RELEASE_VERSION } from "./version.ts";
import { MAX_INFERENCE_REQUEST_BYTES, MAX_LOCAL_CONTROL_REQUEST_BYTES, readBoundedBody, readBoundedJson } from "@uptokey/sync-contract/limits";
import { releaseWithResponse, RequestAdmission } from "./request-admission.ts";
import { hasForbiddenInferenceCredentialField, projectInferenceRequest } from "./inference-request-policy.ts";
import { assertProxyConfig, loadConfig, saveConfig } from "./config.ts";
import { GEMINI_FREE_PRIVACY_NOTICE_VERSION, geminiPrivacyAccepted } from "./privacy.ts";
import type { ControlIdentity } from "./control-capability.ts";
import { LocalControlRateLimiter } from "./local-control-rate-limit.ts";
import { normalizeClientName } from "./client-name.ts";
import { configureAndEnableOptionalProvider, configureAndEnableUserDefinedProvider, enableProvider, MAX_PROVIDER_KEY_LENGTH, revokeProvider } from "./provider-lifecycle.ts";
import { localUiHtml } from "./local-ui.ts";
import { parseSourceSearch, searchPublicSource } from "./public-sources.ts";
import {localSetupModel,localSetupProvider,localSetupConnection} from "./local-setup-handoff.ts";
import { createDefaultLocalRuntimeRegistry } from "./local-runtime/default.ts";
import { detectHardwareProfile } from "./local-runtime/hardware-profile.ts";
import { estimateModelFit } from "./local-runtime/fit.ts";
import { LOCAL_MODEL_SUGGESTIONS } from "./local-runtime/catalog.ts";
import { LOCAL_VIRTUAL_ALIAS_IDS } from "./local-model-aliases.ts";
import { installLocalModel, validInstallModel } from "./local-model-install.ts";
import type {DeviceEntitlementObservation} from "./device-poller.ts";
import { ALL_PROVIDERS, isCoreProvider, isOptionalProvider, isProvider, isUserDefinedProvider, OPTIONAL_PROVIDERS } from "./provider-registry.ts";
import { isNamedExperimentalProvider } from "./provider-registry.ts";
import { namedProviderRiskAccepted } from "./provider-risk.ts";
import { DEFAULT_FALLBACK_CONTEXT_LIMIT, MODEL_CONTEXT_LIMITS } from "./context-guard.ts";
import { anthropicMessagesToChatCompletion, chatCompletionToAnthropicMessage, openAiSseToAnthropicSse } from "./anthropic-messages.ts";
import { chatCompletionToResponses, openAiSseToResponsesSse, responsesRequestToChatCompletion } from "./responses-api.ts";
import { WorkspaceRuntime, WorkspaceError } from './workspace/runtime.ts';
import {fileServiceAccessStorage} from './workspace/service-access-store.ts';
import type { WorkspaceStore } from './workspace/store.ts';
import { workspaceMethod, workspaceUsageQuery, mountWorkspaceRoutes } from './workspace/http.ts';
import { createWorkspaceAccessGuard, allowsEphemeralRequest, readRunStartCommand, runStartProjectFromPath, type RunStartRecoveryAuthority, type WorkspaceAccessContext } from './workspace/client-access-enforcement.ts';
import { AutomationService } from './workspace/automation-service.ts';
import { bindAutomationService } from './workspace/automation-runtime-facet.ts';
import { automationMethod } from './workspace/automation-http.ts';
import { createWorkspaceAutomationHooks, prepareScheduledPreset } from './workspace/automation-workspace.ts';
import { createWorkspaceChainEffects } from './workspace/automation-chain-workspace.ts';
import { WorkspaceAutomationDelivery } from './workspace/automation-delivery.ts';
import { resolveAutomationRoot } from './workspace/automation-persistence.ts';
import { bindAgentsCliReady } from './workspace/agents-cli-runtime-facet.ts';
import { agentsCliMethod, agentsCliQueryAllowed } from './workspace/agents-cli-http.ts';
import { usageObservabilityMethod, usageObservabilityQueryAllowed } from './workspace/usage-observability-http.ts';
import { sharedSinkAuthority, SinkAccessDeniedError } from './workspace/sink-authority.ts';
import { MobilityService } from './workspace/mobility-service.ts';
import { hostedSyncClientFromEnvironment } from './workspace/hosted-sync-client.ts';
import { requestHostedAccountToken,revalidateHostedAccountOperation,revalidateHostedAccountBinding } from './workspace/hosted-account-context.ts';
import { bindMobilityService, getBoundMobilityService } from './workspace/mobility-http.ts';
import { resolveLocalPrincipal, localPrincipalId, isLocalPrincipalActive, resolveLocalProjectGrant, isProjectGranted, resolveLocalRetentionMode, resolveLocalCacheAuthority, resolveLocalWorkspaceAuthority, type LocalProjectGrant } from './workspace/principal.ts';
import { GovernanceStore } from './workspace/governance-store.ts';
import { WorkspacePolicyService } from './workspace/governance-service.ts';
import { governanceMethod, governanceQueryAllowed, mountGovernanceRoutes } from './workspace/governance-http.ts';
import { BrowserSessionService } from './workspace/browser-session.ts';
import { ClientContextLinkService, ContextLinkError, authenticateContextCredential, credentialProjectGrant, rawCredentialPrincipal, resolveClientContextLink, guardContextResponse } from './workspace/client-context-link.ts';
import { readClientRegistration, ClientRegistrationError } from './workspace/client-registration.ts';
import { CLIENT_KEY_SCOPES } from '@uptokey/sync-contract/client-keys';
import { mountConversationRoutes, conversationMethod, conversationQueryAllowed } from './workspace/conversations.ts';
import { mountSettingsRoutes, settingsMethod, settingsQueryAllowed, exportPrivacyAuthority, type PrivacyJobAuthority } from './workspace/settings.ts';
import { gatewayWireHasAudio, type WorkspaceGateway } from './gateway-service.ts';
import { DECLARED_CAPABILITY_FIELDS } from "@uptokey/sync-contract/connections";
import type { WorkspaceBrowser } from './browser-service.ts';
import type { WorkspaceTelemetryOutbox } from './workspace/telemetry-outbox.ts';
import {
  resolveBearer, parseClientTokenFormat, requiredScopeFor, checkRouteScope, checkModelScope, checkOutputLimit,
  createClientKey, listClientKeys, updateClientKey, rotateClientKey, revokeClientKey,
  migrateLegacyClient, recordClientUse, ClientKeyGovernor, type ResolvedClient,
} from "./client-keys.ts";
import { OpenRouterManagementService } from "./openrouter-management.ts";
import {
  validateChatBody, validateAnthropicBody, validateResponsesBody,
  parseLegacyCompletions, legacyToChatRequest, chatCompletionToTextCompletion,
  parseCountTokens, estimateTokensFor, sseErrorEnvelope, isTextCompletionUsage,
} from "./protocol-capability.ts";
// E2-02: multicontas, testes em lote, OAuth oficial e instalações locais.
import { ConnectionProfileService, defaultProfileId, fileConnectionStorage, type ConnectionStateStorage } from "./connection-profiles.ts";
import { ConnectionTestService, fileJobsStorage, type JobsStorage } from "./connection-tests.ts";
import { ModelInstallJobService, fileInstallJobsStorage, type InstallJobsStorage, type ModelInstaller } from "./model-install-jobs.ts";
import { OAuthConnectionService } from "./oauth-connection.ts";
import { matchConnectionRoute, registerConnectionRoutes } from "./connection-http.ts";
import { registerProviderSetupRoutes } from './provider-setup-http.ts';
import { registerProviderCreditRoutes } from './provider-credit-http.ts';
import { AccountLoginService } from './account-login.ts';
import { AccountShareService, AccountShareError, ACCOUNT_SHARE_AUDIENCES } from './account-share.ts';
import { matchEfficiencyLocalRoute, registerEfficiencyRoutes, ensureDefaultEfficiencyPolicy } from "./efficiency-http.ts";
import { setActiveEfficiencyPolicy } from './workspace/efficiency-pipeline.ts';
import { registerRemoteAccessRoutes, REMOTE_ACCESS_LOCAL_ROUTES, remoteAccessQueryAllowed } from "./remote-access-http.ts";
import { ManagedRemoteAccess } from './remote-access-supervisor.ts';
import { registerRoutingRoutes } from './routing-http.ts';
import { registerDiagnosticRoutes, DIAGNOSTIC_LOCAL_ROUTES } from "./diagnostic-http.ts";
import { createTransportObserver } from "./remote-access-discover.ts";
import { emptyEgressJournal } from "./egress/types.ts";
import { EgressStore } from "./egress/store.ts";
import { matchEgressLocalRoute, registerEgressRoutes } from "./egress/routes.ts";
import { egressJournalPath, dataDir } from "./paths.ts";
import { projectRunnerSettings } from "./workspace/runner-settings.ts";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import { EgressPersistence } from "./egress/persistence.ts";


export interface ConnectionServicesOptions {
  profiles?: ConnectionStateStorage;
  testJobs?: JobsStorage;
  installJobs?: InstallJobsStorage;
  installer?: ModelInstaller;
  fetchImpl?: typeof fetch;
  realtimeConnect?: import('./voice-realtime-transport.ts').OpenAIRealtimeOptions['connect'];
  now?: () => number;
}

// SPEC-081 T-6 / SPEC-062 §4: daemon local em 127.0.0.1 é alvo de DNS rebinding — uma pagina
// maliciosa faz o DNS de attacker.com resolver para 127.0.0.1 e o browser trata como same-origin
// o suficiente pra disparar a request. Sem checar o header Host, o app confia em quem quer que
// tenha chegado ate a porta. Bind em loopback (cli.ts) nao basta sozinho.
export const EXPECTED_HOST = "127.0.0.1:21435";
export const ALLOWED_HOSTS = new Set(["127.0.0.1:21435", "localhost:21435"]);
export const LOCAL_PROVIDER_MUTATE_LIMIT = 20;
export const LOCAL_PROVIDER_MUTATE_WINDOW_MS = 60_000;
// As duas últimas origens são as origens privilegiadas do shell desktop Tauri v2
// (Windows/Linux: http://tauri.localhost; macOS: tauri://localhost). Somente o WebView
// do pacote assinado carrega essas origens; um navegador comum não as produz sem
// controle de DNS local, cenário já coberto pela checagem estrita de Host acima.
const LOCAL_UI_ORIGINS = new Set(["http://127.0.0.1:21435", "http://localhost:21435", "http://127.0.0.1:5273", "http://localhost:5273", "http://tauri.localhost", "tauri://localhost", "uptokey-tui://local"]);
const isExtensionOrigin = (origin: string | undefined): origin is string => typeof origin === 'string' && /^chrome-extension:\/\/[a-p]{32}$/.test(origin);
const ACCOUNT_ROUTES = new Set(['capability','status','usage','available','requests','login','logout','request','adopt','unlink','approve','consume','control'].map(action=>`/local/account/${action}`));
const extensionPathAllowed = (path: string) => ACCOUNT_ROUTES.has(path) || ['/health', '/local/pair/challenge', '/local/pair/consume', '/local/status', '/local/client/rotate', '/local/client/revoke', '/local/workspace/session/challenge', '/local/workspace/session/complete', '/v1/models', '/v1/chat/completions'].includes(path) || path.startsWith('/v1/workspace/');
const BROWSER_RESPONSE_HEADERS = 'x-uptokey-provider,x-uptokey-model,x-uptokey-fallback,x-uptokey-cache,x-uptokey-failed-provider,x-uptokey-switch-reason,x-uptokey-warnings,x-uptokey-cost-class,x-uptokey-cost-estimate-micros,x-request-id,x-provider-request-id';
const LOCAL_UI_ORIGIN_PATHS = new Set(["/local/efficiency/preview", "/local/efficiency/cache/invalidate", "/local/efficiency/metrics", "/local/efficiency/policy", "/local/provider/save", "/local/provider/configure-optional", "/local/provider/revoke", "/local/client/provision", "/local/client/revoke", "/local/ui/status", "/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/models", "/v1/sources/search", "/v1/usage", "/v1/usage/estimation", "/v1/connections", "/v1/local-models", "/v1/local-models/install", "/local/client-keys", "/local/openrouter/management/keys", "/local/openrouter/management/config", "/local/openrouter/credits", "/local/remote-access/discover", "/local/remote-access/plan", "/local/remote-access/start", "/local/remote-access/stop", "/local/remote-access/observe", "/local/remote-access/revoke", "/local/remote-access/grants", "/v1/completions", "/v1/messages/count_tokens"]);
for(const path of ['/local/provider/setup/presets','/local/provider/setup/prepare','/local/provider/setup/commit','/local/provider/setup/dispose','/local/provider/credits'])LOCAL_UI_ORIGIN_PATHS.add(path);
// E2-03 dynamic local routes (client-keys CRUD + OpenRouter management) share the
// loopback UI origin policy; exact path is checked by matchLocalRoute below.
// E2-02 connection routes (multicontas/testes/OAuth/instalações) usam os mesmos
// prefixos dinâmicos; métodos com :id são resolvidos por matchConnectionRoute.
const LOCAL_DYNAMIC_ORIGIN_PREFIXES = ["/local/client-keys", "/local/openrouter/management/keys", "/local/openrouter/management/config", "/local/connections", "/local/connection-tests", "/local/oauth", "/local/model-installs", "/local/egress"];
export const LOCAL_PAIRING_CHALLENGE_LIMIT = 5;
export const LOCAL_PAIRING_CHALLENGE_WINDOW_MS = 5 * 60_000;
export const LOCAL_PAIRING_ATTEMPT_LIMIT = 60;
export const LOCAL_PAIRING_ATTEMPT_WINDOW_MS = 60_000;
export const LOCAL_PAIRING_CONSUME_LIMIT = 20;
export const LOCAL_PAIRING_CONSUME_WINDOW_MS = 60_000;
const LOCAL_ROUTE_METHODS = new Map<string, "GET" | "POST">([
  ["/", "GET"], ["/v1", "GET"], ["/chat", "GET"],
  ["/v1/sources/search", "POST"], ["/v1/usage", "GET"], ["/v1/usage/estimation", "GET"],
  ["/health", "GET"], ["/v1/connections", "GET"], ["/v1/local-models", "GET"],
  ["/local/pair/challenge", "POST"], ["/local/pair/approve", "POST"], ["/local/pair/consume", "POST"],
  ["/local/control-pair/approve", "POST"], ["/local/control-pair/revoke", "POST"],
  ["/local/config/reload", "POST"], ["/local/update/authorize-stop", "POST"],
  ["/local/cache/invalidate/groq", "POST"], ["/local/cache/invalidate/gemini", "POST"], ["/local/cache/invalidate/ollama", "POST"], ["/local/cache/invalidate/vllm", "POST"], ["/local/cache/invalidate/custom", "POST"], ["/local/cache/invalidate/deepseek", "POST"], ["/local/cache/invalidate/mistral", "POST"], ["/local/cache/invalidate/cerebras", "POST"], ["/local/cache/invalidate/together", "POST"], ["/local/cache/invalidate/anthropic", "POST"], ["/local/cache/invalidate/openrouter", "POST"],
  ["/local/client/provision", "POST"], ["/local/client/revoke", "POST"], ["/local/client/rotate", "POST"], ["/local/status", "GET"], ["/local/ui/status", "GET"],
  ["/local/provider/save", "POST"], ["/local/provider/configure-optional", "POST"], ["/local/provider/revoke", "POST"], ["/ui", "GET"], ["/favicon.ico", "GET"],
  ["/v1/chat/completions", "POST"], ["/v1/messages", "POST"], ["/v1/responses", "POST"],
  ["/v1/models", "GET"], ["/v1/local-models/install", "POST"],
  ["/v1/completions", "POST"], ["/v1/messages/count_tokens", "POST"],
  ["/local/remote-access/discover", "GET"], ["/local/remote-access/plan", "POST"],
  ["/local/remote-access/start", "POST"], ["/local/remote-access/stop", "POST"],
  ["/local/remote-access/observe", "GET"], ["/local/remote-access/revoke", "POST"],
  ["/local/remote-access/grants", "GET"],
  ["/local/openrouter/credits", "GET"]
]);
const LOCAL_JSON_ROUTES = new Set(["/local/efficiency/preview", "/local/efficiency/policy", "/local/efficiency/cache/invalidate", 
  "/local/pair/challenge", "/local/pair/approve", "/local/pair/consume", "/local/control-pair/approve",
  "/local/update/authorize-stop", "/local/client/provision", "/local/client/revoke", "/local/client/rotate", "/local/provider/save", "/local/provider/configure-optional", "/local/provider/revoke", "/v1/chat/completions", "/v1/messages", "/v1/responses", "/v1/sources/search", "/v1/local-models/install",
  "/local/remote-access/plan", "/local/remote-access/start", "/local/remote-access/stop", "/local/remote-access/revoke",
  "/v1/completions", "/v1/messages/count_tokens"
]);
const LOCAL_EMPTY_POST_ROUTES = new Set([
  "/local/control-pair/revoke", "/local/config/reload", "/local/cache/invalidate/groq", "/local/cache/invalidate/gemini", "/local/cache/invalidate/ollama", "/local/cache/invalidate/vllm", "/local/cache/invalidate/custom", "/local/cache/invalidate/deepseek", "/local/cache/invalidate/mistral", "/local/cache/invalidate/cerebras", "/local/cache/invalidate/together", "/local/cache/invalidate/anthropic", "/local/cache/invalidate/openrouter"
]);
const ACCOUNT_POST_ACTIONS = new Set(['login','logout','request','adopt','unlink','approve','consume','control']);
for(const action of ['capability','status','usage','available','requests',...ACCOUNT_POST_ACTIONS]){
  const path=`/local/account/${action}`;LOCAL_UI_ORIGIN_PATHS.add(path);
  LOCAL_ROUTE_METHODS.set(path,ACCOUNT_POST_ACTIONS.has(action)?'POST':'GET');
  if(ACCOUNT_POST_ACTIONS.has(action))LOCAL_JSON_ROUTES.add(path);
}
LOCAL_UI_ORIGIN_PATHS.add('/local/remote-access/config');
LOCAL_JSON_ROUTES.add('/local/remote-access/config');
LOCAL_UI_ORIGIN_PATHS.add('/local/routing');
LOCAL_JSON_ROUTES.add('/local/routing');
LOCAL_UI_ORIGIN_PATHS.add('/local/routing/costs');
LOCAL_ROUTE_METHODS.set('/local/routing/costs','GET');
for (const path of ['/local/workspace/session/challenge','/local/workspace/session/complete']) {
  LOCAL_UI_ORIGIN_PATHS.add(path); LOCAL_ROUTE_METHODS.set(path,'POST'); LOCAL_JSON_ROUTES.add(path);
}
for (const action of ['challenge','approve','consume','revoke']) {
  const path = `/local/workspace/session/context/${action}`;
  LOCAL_UI_ORIGIN_PATHS.add(path); LOCAL_ROUTE_METHODS.set(path,'POST'); LOCAL_JSON_ROUTES.add(path);
}
for (const path of ['/local/workspace/session/context','/local/workspace/session/context/owned']) {
  LOCAL_UI_ORIGIN_PATHS.add(path); LOCAL_ROUTE_METHODS.set(path,'GET');
}
// E2-20 diagnóstico controlado — default OFF (plan/start exigem UPTOKEY_E2_20_DIAGNOSTIC=1).
for (const { path } of DIAGNOSTIC_LOCAL_ROUTES) {
  LOCAL_UI_ORIGIN_PATHS.add(path); LOCAL_ROUTE_METHODS.set(path, "POST"); LOCAL_JSON_ROUTES.add(path);
}

function timingSafeStringEqual(a: string, b: string): boolean {
  const bufferA = Buffer.from(a);
  const bufferB = Buffer.from(b);
  if (bufferA.length !== bufferB.length) {
    // Comparar contra si mesmo mantem o tempo constante mesmo quando o tamanho ja vaza
    // informacao (nao ha como evitar vazar o tamanho por um buffer de tamanho fixo aqui).
    timingSafeEqual(bufferA, bufferA);
    return false;
  }
  return timingSafeEqual(bufferA, bufferB);
}

const CLIENT_KEY_ID = "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";
const OR_HASH = "[A-Za-z0-9_-]{8,128}";
// E2-03 dynamic routes: exact map above covers static paths; these cover :id/:hash.
function matchLocalRoute(pathname: string): { method: "GET" | "POST" | "PATCH" | "DELETE"; json: boolean } | undefined {
  if (pathname === "/local/client-keys") return { method: "__MULTI__" as never, json: true };
  if (new RegExp(`^/local/client-keys/${CLIENT_KEY_ID}$`, "i").test(pathname)) return { method: "__MULTI__" as never, json: true };
  if (new RegExp(`^/local/client-keys/${CLIENT_KEY_ID}/(rotate|revoke)$`, "i").test(pathname)) return { method: "POST", json: true };
  if (pathname === "/local/openrouter/management/keys") return { method: "__MULTI__" as never, json: true };
  if (new RegExp(`^/local/openrouter/management/keys/${OR_HASH}$`).test(pathname)) return { method: "__MULTI__" as never, json: true };
  if (pathname === "/local/openrouter/management/config") return { method: "__MULTI__" as never, json: true };
  return undefined;
}

function localRouteMethod(pathname: string, method: string): "GET" | "POST" | "PATCH" | "DELETE" | undefined {
  const exact = LOCAL_ROUTE_METHODS.get(pathname);
  if (exact) return exact;
  // E2-02: rotas com :id (conexões, testes, OAuth, instalações).
  const conn = matchConnectionRoute(pathname, method);
  if (conn) return conn.method;
  if (matchEgressLocalRoute(pathname, method) || matchEfficiencyLocalRoute(pathname, method)) {
    return method === "GET" || method === "POST" || method === "PATCH" || method === "DELETE" ? method : undefined;
  }
  const dynamic = matchLocalRoute(pathname);
  if (!dynamic) return undefined;
  if (dynamic.method === ("__MULTI__" as string)) {
    if (pathname === "/local/client-keys" || pathname === "/local/openrouter/management/keys") {
      return method === "GET" ? "GET" : method === "POST" ? "POST" : undefined;
    }
    if (pathname === "/local/openrouter/management/config") {
      return method === "POST" ? "POST" : method === "DELETE" ? "DELETE" : undefined;
    }
    if (/\/rotate$/.test(pathname) || /\/revoke$/.test(pathname)) return method === "POST" ? "POST" : undefined;
    if (pathname.startsWith("/local/client-keys/")) return method === "PATCH" ? "PATCH" : undefined;
    if (pathname.startsWith("/local/openrouter/management/keys/")) {
      return method === "GET" ? "GET" : method === "PATCH" ? "PATCH" : method === "DELETE" ? "DELETE" : undefined;
    }
  }
  return dynamic.method as "GET" | "POST" | "PATCH" | "DELETE";
}

function isLocalJsonRoute(pathname: string, method: string): boolean {
  if(method === "GET") return false;
  if (LOCAL_JSON_ROUTES.has(pathname)) return true;
  // E2-02: POST/PATCH com corpo JSON; cancelamentos usam corpo vazio.
  const conn = matchConnectionRoute(pathname, method);
  if (conn) return method !== "GET" && conn.body === "json";
  if (matchEgressLocalRoute(pathname, method)) return method === "POST" || method === "PATCH";
  const dynamic = matchLocalRoute(pathname);
  if (!dynamic?.json) return false;
  if (method === "GET") return false;
  if (method === "DELETE" && pathname === "/local/openrouter/management/config") return false;
  return true;
}

function originPathAllowedFor(pathname: string): boolean {
  if (LOCAL_UI_ORIGIN_PATHS.has(pathname)) return true;
  return LOCAL_DYNAMIC_ORIGIN_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(prefix + "/"));
}

function localListQueryAllowed(pathname: string, search: URLSearchParams): boolean {
  if(pathname==='/local/provider/credits')return [...search.keys()].every(key=>key==='connectionId')&&search.getAll('connectionId').length===1;
  if (pathname === "/local/client-keys" || pathname.startsWith("/local/openrouter/management/keys")) {
    const keys = [...search.keys()];
    if (pathname === "/local/client-keys") return keys.every((k) => ["limit", "cursor", "operationId"].includes(k));
    return keys.every((k) => ["operationId"].includes(k));
  }
  return false;
}

/** Server-owned allowlist: every fallback remains inside the local destinations. */
function localProcessingProviders(config: ProxyConfig, model: string): ProviderName[] {
  const providers = Object.entries(config.providers).filter(([name, provider]) =>
    isProvider(name) && name !== 'groq' && name !== 'gemini' && provider?.enabled && typeof provider.endpointUrl === 'string' && isLocalEndpointUrl(provider.endpointUrl),
  );
  const dynamic = isLocalModelAlias(model) || model.startsWith('uptokey-auto');
  if (!dynamic && !providers.some(([, provider]) => provider?.models?.includes(model))) return [];
  return providers.map(([name]) => name as ProviderName);
}

export function createApp(
  config: ProxyConfig,
  router: Router,
  secrets: SecretStore,
  offlineGuard: (now?: Date) => Promise<OfflineDecision> = guardOffline,
  authRateLimiter = new LocalAuthRateLimiter(),
  pairing = new PairingService(secrets),
  controlCapabilities = new ControlCapabilityService(),
  inferenceAdmission = new RequestAdmission(),
  configLoader: () => Promise<ProxyConfig> = loadConfig,
  identityEpoch?: () => Pick<ControlIdentity, "tenantId" | "deviceId"> | undefined,
  pairingRateLimiter = new LocalControlRateLimiter(),
  requestUpdateShutdown: () => void = () => { if(process.platform==='win32')process.emit('SIGTERM');else process.kill(process.pid,'SIGTERM'); },
  deviceEntitlement: () => DeviceEntitlementObservation | undefined = () => undefined,
  workspaceStore?: WorkspaceStore,
  workspaceSource: typeof searchPublicSource = searchPublicSource,
  workspaceGateway?: WorkspaceGateway,
  workspaceBrowser?: WorkspaceBrowser,
  workspaceTelemetry?: WorkspaceTelemetryOutbox,
  workspaceComposition?: ConstructorParameters<typeof WorkspaceRuntime>[1]['composition'],
  workspaceFilesystem?: ConstructorParameters<typeof WorkspaceRuntime>[1]['filesystem'],
  workspaceSpeech?: ConstructorParameters<typeof WorkspaceRuntime>[1]['speech'],
  workspaceImage?: ConstructorParameters<typeof WorkspaceRuntime>[1]['image'],
  workspaceVideo?: ConstructorParameters<typeof WorkspaceRuntime>[1]['video'],
  workspaceApiInstruments?: ConstructorParameters<typeof WorkspaceRuntime>[1]['apiInstruments'],
  clientKeyGovernor?: ClientKeyGovernor,
  openRouterFetch?: typeof fetch,
  connectionServices?: ConnectionServicesOptions,
  workspaceTranscription?: ConstructorParameters<typeof WorkspaceRuntime>[1]['transcription'],
  workspaceVoice?: ConstructorParameters<typeof WorkspaceRuntime>[1]['voice'],
  workspaceClassification?: ConstructorParameters<typeof WorkspaceRuntime>[1]['classification'],
  workspaceEmbeddings?: ConstructorParameters<typeof WorkspaceRuntime>[1]['embeddings'],
  workspaceWebSources?: ConstructorParameters<typeof WorkspaceRuntime>[1]['webSources'],
  workspaceProjectRunner?: ConstructorParameters<typeof WorkspaceRuntime>[1]['projectRunner'],
  workspaceMediaLaunch?: MediaLaunchDependencies
) {
  const app = new Hono();
  const startedAt = new Date().toISOString();
  const sourceAdmission = new RequestAdmission(2);
  const browserSessions = new BrowserSessionService(secrets);
  let connectionProfiles: ConnectionProfileService | undefined;
  let connectionOAuth: OAuthConnectionService | undefined;
  const connectionProfilesStorage = connectionServices?.profiles ?? fileConnectionStorage();
  let automationService: AutomationService;
  const automationDelivery = new WorkspaceAutomationDelivery(secrets);
  const keyGovernor = clientKeyGovernor ?? new ClientKeyGovernor();
  const openRouterManagement = new OpenRouterManagementService(secrets, openRouterFetch ?? fetch);
  const managedVoice=workspaceStore&&!workspaceVoice?createManagedVoice(workspaceStore,secrets,()=>connectionProfiles,{
    config:()=>config,governance:()=>governanceService,connect:connectionServices?.realtimeConnect,
    assertAuthority:async authority=>{
      await combinedReady;
      // An expired control-plane grace period does not revoke a BYOK voice session (same rule as chat and
      // /v1/connections); revocation, suspension and an invalid clock still do.
      const access=await offlineGuard();
      if(!await isLocalPrincipalActive(authority.principalId,secrets,identityEpoch?.())||(!access.allowed&&access.code!=='offline_grace_expired'))throw new Error('voice_authority_revoked');
      await workspaceStore.getProject(authority.principalId,authority.projectId);
      const run=await workspaceStore.readRun(authority.principalId,authority.projectId,authority.runId);
      if(!run||!['running','succeeded'].includes(run.run.status)||!run.receipts.some(receipt=>receipt.capabilityId==='inference.voice.openai'&&['dispatched','succeeded'].includes(receipt.status)))throw new Error('voice_authority_revoked');
    },
  }):undefined;
  const managedMedia=workspaceStore?createManagedMedia({config,secrets,store:workspaceStore,overrides:{image:workspaceImage,video:workspaceVideo,speech:workspaceSpeech,transcription:workspaceTranscription},dependencies:workspaceMediaLaunch,connectionsStorage:connectionProfilesStorage}):undefined;
  // Late-bound by mountConversationRoutes; descendant runs reuse the conversation ledger.
  let conversationBudgetOwner: ((principalId:string,projectId:string,runRequestId:string)=>Promise<{id:string;temporary:boolean}|undefined>)|undefined;
  const workspace = workspaceStore ? new WorkspaceRuntime(workspaceStore, {
    serviceAccess:{profiles:()=>connectionProfiles,fetchFn:connectionServices?.fetchImpl,storage:fileServiceAccessStorage(join((workspaceStore as unknown as {root:string}).root,'service-access'))},
    projectRunner:workspaceProjectRunner??projectRunnerSettings(process.env,dataDir()),
    previewFrameOrigins:[...LOCAL_UI_ORIGINS],
    productivity:{
      fetchFn:connectionServices?.fetchImpl,
      async listAccounts(principal){
        if(!await isLocalPrincipalActive(principal,secrets,identityEpoch?.()))throw new Error('principal_revoked');
        await connectionOAuth?.ready;
        const result=[];
        for(const profile of await connectionProfiles?.list()??[]){
          if(profile.enabled&&profile.accessMode==='byok'&&profile.providerId==='resend'){
            result.push({accountId:profile.id,label:profile.label,scopes:[],state:'active'});
            continue;
          }
          if(!profile.enabled||profile.accessMode!=='oauth'||profile.providerId!=='oauth-google')continue;
          const binding=await connectionProfiles!.oauthBinding(profile.id),meta=binding?connectionOAuth?.getConnection(binding):undefined;
          if(!meta||meta.principalId!=='local-device'||meta.providerId!=='oauth-google'||!['active','refreshing'].includes(meta.state))continue;
          result.push({accountId:profile.id,label:profile.label,scopes:[...meta.scopes],state:'active'});
        }
        return result;
      },
      async acquireCredential(principal,accountId,requiredScopes,signal){
        if(!await isLocalPrincipalActive(principal,secrets,identityEpoch?.()))throw new Error('principal_revoked');
        await connectionOAuth?.ready;
        const profile=await connectionProfiles?.get(accountId);
        if(profile?.enabled&&profile.accessMode==='byok'&&profile.providerId==='resend'){
          const value=await connectionProfiles!.readCredential(profile);
          if(typeof value!=='string'||value.length===0)throw new Error('productivity_account_unavailable');
          return value;
        }
        const binding=profile?await connectionProfiles?.oauthBinding(profile.id):undefined,meta=binding?connectionOAuth?.getConnection(binding):undefined;
        if(!profile?.enabled||profile.accessMode!=='oauth'||profile.providerId!=='oauth-google'||!binding||!meta||meta.providerId!=='oauth-google'||meta.principalId!=='local-device'||!['active','refreshing'].includes(meta.state)||!connectionOAuth)throw new Error('productivity_account_unavailable');
        const credential=await connectionOAuth.acquireCredential(binding,requiredScopes,signal);
        signal.throwIfAborted();
        if(!(await connectionProfiles?.get(accountId))?.enabled||await connectionProfiles?.oauthBinding(accountId)!==binding)throw new Error('productivity_account_unavailable');
        return credential.accessToken;
      }
    },
    automationDelivery,
    scheduleGrants:()=>automationService?.grants,
    config,
    gateway: workspaceGateway,
    // Direct media/embeddings executors read provider:custom: the same account admission as the gateway.
    accountFunding: async ({destinationId,model,effect,tokens,units}) => {
      if (destinationId !== 'custom') return undefined;
      return customAccountAdmission(model, effect, units ?? tokens, undefined, effect.signal);
    },
    // F2: the gateway destination is provider:custom's default connection; its declarations are read, never inferred.
    gatewayDeclaration: async (kind, model, signal) => {
      await combinedReady; signal.throwIfAborted();
      const profile = await connectionProfiles?.get(defaultProfileId('custom'));
      signal.throwIfAborted();
      const declared = Boolean(profile?.enabled && profile[DECLARED_CAPABILITY_FIELDS[kind]]?.includes(model));
      return { declared, origin: 'declared' as const, profileId: profile?.id ?? null, profileRevision: profile?.revision ?? null };
    },
    browser: workspaceBrowser,
    telemetry: workspaceTelemetry,
    composition: workspaceComposition,
    filesystem: workspaceFilesystem,
    get speech(){return workspaceSpeech??managedMedia?.services.speech;},
    get transcription(){return workspaceTranscription??managedMedia?.services.transcription;},
    mediaConfiguration:managedMedia?.configuration,
    embeddings: workspaceEmbeddings,
    webSources: workspaceWebSources ?? {secrets},
    voice: workspaceVoice??managedVoice?.supervisor,
    voiceConfiguration:managedVoice?.configuration,
    get image(){return workspaceImage??managedMedia?.services.image;},
    get video(){return workspaceVideo??managedMedia?.services.video;},
    apiInstruments: workspaceApiInstruments,
    classification: workspaceClassification ?? {secrets},
    runsEnabled:()=>process.env.UPTOKEY_WORKSPACE_RUNS_DISABLED!=='1',
    conversationScopeForRun:(principalId,projectId,runRequestId)=>conversationBudgetOwner?.(principalId,projectId,runRequestId)??Promise.resolve(undefined),
    active: principal => isLocalPrincipalActive(principal, secrets, identityEpoch?.()),
    gate: async () => {
      if (identityEpochMismatch(config, identityEpoch?.())) return {allowed:false,code:'config_epoch_pending'};
      const decision=await offlineGuard(new Date());
      // Local workspace work uses the same BYOK access rule as chat inference.
      // Expired synchronization grace is not revocation; retain all other gates.
      return decision.allowed||decision.code==='offline_grace_expired'?{allowed:true}:{allowed:false,code:decision.code??'offline_grace_expired'};
    },
    source: async (input,signal) => {
      if(!pairingRateLimiter.take('public-source-search',20,60_000).ok || !pairingRateLimiter.take('public-source-'+input.source,1,1_000).ok) throw new WorkspaceError('source_rate_limited',429);
      const release=sourceAdmission.tryAcquire();if(!release)throw new WorkspaceError('local_capacity_exceeded',429);
      try{return await workspaceSource(input,signal);}finally{release();}
    },
    inference: async (request,provider,requestId,signal) => {
      const release=inferenceAdmission.tryAcquire();
      if(!release) return Response.json({error:{type:'local_capacity_exceeded'}},{status:429});
      try {
        const tenantId=identityEpoch?.()?.tenantId??config.appliedConfigTenantId;
        const response=await dispatchInference(router,request,{requestId,allowedProviders:[provider],disableRetries:true,...(tenantId?{tenantId}:{}),
          ...(governanceService ? {reserveBudget:async(attempt:import('./types.ts').DispatchBudgetAttempt)=>{await combinedReady;return governanceService.reserveAccountFunding(requestId,attempt);}} : {}),
        },signal);
        return releaseWithResponse(response,release,signal);
      } catch(error){release();throw error;}
    },
    resolveConnection: async (id: string) => {
      const profile = await connectionProfiles?.get(id);
      if (profile && isProvider(profile.providerId)) return {provider:profile.providerId,modelIds:profile.modelIds,enabled:profile.enabled,credentialPresent:await connectionProfiles!.credentialPresent(profile),kind:'profile' as 'profile'|'provider'};
      // A provider configured directly (config file + vault entry `provider:<id>`), the destination /v1/connections lists
      // under `providers` when no connection profile exists: the clients address it by its provider id. It is resolved
      // as that provider (no account binding), with the models the configuration declares.
      const configured = isProvider(id) ? config.providers[id] : undefined;
      if (!configured || !configured.enabled) throw new Error('connection_unavailable');
      const models = [...(configured.models ?? []), ...(configured.defaultModel ? [configured.defaultModel] : [])];
      return {provider:id as ProviderName,modelIds:[...new Set(models)],enabled:configured.enabled,credentialPresent:(await secrets.get(`provider:${id}`))!==undefined,kind:'provider' as 'profile'|'provider'};
    },
  }) : undefined;
  const egressJournalFile = egressJournalPath();
  const egressPersistence = new EgressPersistence(egressJournalFile);
  const egressStore = new EgressStore(emptyEgressJournal(), (journal) => egressPersistence.save(journal), { readCredential: reference => secrets.get(reference) });
  const egressReady = egressPersistence.load().then(async (loaded) => {
    await egressStore.restore(loaded);
  });
  const workspaceReady=workspace?.initialize()??Promise.resolve();
  // E2-07 — governança: workspace pessoal/equipes, políticas e orçamentos isolados por principal
  // Isolar por workspaceStore.root quando teste usa tmp dir, senão usar global dataDir
  const governanceRoot = workspaceStore ? join((workspaceStore as unknown as { root: string }).root, "governance") : undefined;
  const governanceStore = workspaceStore ? new GovernanceStore(secrets, governanceRoot, () => new Date()) : undefined;
  const governanceService = governanceStore ? new WorkspacePolicyService(governanceStore) : undefined;
  const delegatedKeys = governanceStore && workspaceStore ? new LocalDelegatedKeys(secrets,governanceStore,async(owner,id)=>{await workspaceStore.getBundle(owner,id);},owner=>workspaceStore.listProjects(owner)) : undefined;
  const governanceReady = governanceStore ? governanceStore.initialize() : Promise.resolve();
  void governanceReady.catch(()=>undefined);
  const combinedReady = Promise.all([workspaceReady, governanceReady, egressReady]).then(()=>undefined);
  // The CLI awaits readiness before listening; this catch also prevents an unhandled rejection in embedded callers.
  void combinedReady.catch(()=>undefined);
  let configWrites: Promise<unknown> = Promise.resolve();
  const persistRuntimeConfig = (mutator: (next: ProxyConfig) => void, admit?: () => Promise<void>): Promise<ProxyConfig> => {
    const saved = configWrites.catch(() => undefined).then(async () => {
    const next = structuredClone(config);
    await admit?.();
    mutator(next);
    await saveConfig(next);
    for (const key of Object.keys(config)) if (!(key in next)) delete (config as unknown as Record<string,unknown>)[key];
    Object.assign(config, next);
    return structuredClone(next);
    });
    configWrites = saved;
    return saved;
  };
  app.onError((error, c) => {
    c.header("Cache-Control", "no-store");
    if (error instanceof ContextLinkError) return c.json({error:{type:error.code}},error.status);
    // Authority snapshot validation precedes the workspace guard. A malformed
    // registration remains denied, with the same public classification as that
    // guard; unrelated I/O failures must not be reclassified as client faults.
    if (error instanceof ClientRegistrationError) return c.json({ error: { type: "client_registration_invalid" } }, 403);
    if (error instanceof SinkAccessDeniedError)
      return c.json({ error: { type: error.code } }, 403);
    return c.json({ error: { type: "proxy_unavailable" } }, 503);
  });

  app.use("*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const host = c.req.header("host");
    if (!host || !ALLOWED_HOSTS.has(host)) return c.json({ error: { type: "host_rejected" } }, 421);
    
    if (process.env['UPTOKEY_IPC_SECRET'] && c.req.method !== 'OPTIONS' && c.req.header("origin") === undefined) {
      const authHeader = c.req.header("authorization");
      const ipcSecret = process.env['UPTOKEY_IPC_SECRET'];
      const isIpcSupervisor = (c.req.header("x-uptokey-ipc-secret") === ipcSecret) || (authHeader === `Bearer ${ipcSecret}`);
      if (!isIpcSupervisor) {
        const path = new URL(c.req.url).pathname;
        // B9 D2: native clients (VS Code, Chrome MV3, TUI) have no Origin and no IPC
        // secret. Liveness and the human-approved pairing ceremony stay reachable;
        // they are rate-limited, capped (MAX_PENDING_PAIRINGS) and need an approved
        // userCode (approve itself still requires the admin token).
        const isIpcPublicRoute = (c.req.method === "GET" && path === "/health") || (c.req.method === "POST" && (path === "/local/pair/challenge" || path === "/local/pair/consume"));
        const isProtectedClientRoute = isIpcPublicRoute || (path.startsWith("/v1/") || path.startsWith("/workspace/") || path.startsWith("/conversations/") || path.startsWith("/local/")) && (authHeader?.startsWith("Bearer ") ?? false);
        if (!isProtectedClientRoute) {
          return c.json({ error: { type: "unauthorized_ipc" } }, 401);
        }
      }
    }
    // SPEC-081 T-6 / SPEC-062 §4: browsers sao rejeitados por padrao contra DNS rebinding.
    // Host loopback permitido: 127.0.0.1:21435 e localhost:21435. Bind permanece 127.0.0.1.
    // Origin estrangeira: 403. Mini-UI em LOCAL_UI_ORIGINS pode mutar save/revoke de provider.
    // Origin ausente nessas rotas mutantes falha fechado (401) salvo token admin utk_local_.
    const url = new URL(c.req.url);
    const isPreflight = c.req.method === 'OPTIONS';
    const effectiveMethod = isPreflight ? c.req.header('access-control-request-method') : c.req.method;
    if (!effectiveMethod || !['GET', 'POST', 'PATCH', 'DELETE'].includes(effectiveMethod)) {
      return c.json({ error: { type: 'method_not_allowed' } }, 405);
    }
    const workspaceRouteMethod = workspaceMethod(url.pathname,effectiveMethod);
    const governanceRouteMethod = governanceMethod(url.pathname);
    const conversationRouteMethod = conversationMethod(url.pathname, effectiveMethod);
    const automationRouteMethod = automationMethod(url.pathname, effectiveMethod);
    const settingsRouteMethod = settingsMethod(url.pathname, effectiveMethod);
    const agentsCliRouteMethod = agentsCliMethod(url.pathname);
    const usageObservabilityRouteMethod = usageObservabilityMethod(url.pathname, effectiveMethod);
    const combinedWorkspaceMethod = delegatedMethod(url.pathname) ?? workspaceRouteMethod ?? governanceRouteMethod ?? conversationRouteMethod ?? automationRouteMethod ?? settingsRouteMethod ?? agentsCliRouteMethod ?? usageObservabilityRouteMethod;
    const remoteConfigMethod = ['/local/remote-access/config','/local/routing'].includes(url.pathname) && ['GET', 'POST'].includes(effectiveMethod) ? effectiveMethod : undefined;
    const expectedMethod = remoteConfigMethod ?? LOCAL_ROUTE_METHODS.get(url.pathname) ?? localRouteMethod(url.pathname, effectiveMethod) ?? combinedWorkspaceMethod;
    const originPathAllowed = originPathAllowedFor(url.pathname) || combinedWorkspaceMethod !== undefined || governanceQueryAllowed(url);
    const origin = c.req.header("origin");
    if (c.req.header('x-uptokey-account-token') !== undefined && !url.pathname.startsWith('/v1/workspace/mobility/')) return c.json({ error: { type: 'account_credential_boundary' } }, 400);
    const linkedAccountHeaders=['x-uptokey-account-source','x-uptokey-account-ref','x-uptokey-account-revision'];
    if(linkedAccountHeaders.some(name=>c.req.header(name)!==undefined)&&
      (c.req.header('x-uptokey-account-source')!=='linked'||linkedAccountHeaders.some(name=>c.req.header(name)===undefined)||
        c.req.header('x-uptokey-account-token')!==undefined||effectiveMethod!=='POST'||!isAccountMobilityPath(url.pathname)))
      return c.json({error:{type:'account_credential_boundary'}},400);
    const extensionOrigin = isExtensionOrigin(origin) && extensionPathAllowed(url.pathname);
    const acceptedOrigin = origin !== undefined && (LOCAL_UI_ORIGINS.has(origin) && originPathAllowed || extensionOrigin);
    if (isPreflight) {
      if (!origin || !acceptedOrigin) return c.json({ error: { type: "origin_rejected" } }, 403);
      if (!expectedMethod) return c.json({ error: { type: 'route_not_found' } }, 404);
      if (effectiveMethod !== expectedMethod) {
        c.header('Allow', expectedMethod);
        return c.json({ error: { type: 'method_not_allowed' } }, 405);
      }
      c.header("Access-Control-Allow-Origin", origin);
      c.header("Access-Control-Allow-Credentials", "false");
      c.header("Access-Control-Allow-Methods", `${expectedMethod},OPTIONS`);
      // x-uptokey-processing-policy: política de processamento da conversa
      // (local_only bloqueia provedores externos no backend); precisa estar
      // na allowlist do preflight para os clientes de navegador.
      c.header("Access-Control-Allow-Headers", workspaceRouteMethod==='GET'&&url.pathname.endsWith('/protocol-events')
        ? "authorization,content-type,last-event-id,x-uptokey-processing-policy,x-uptokey-conversation-id,x-uptokey-conversation-request-id,x-uptokey-project-id" : "authorization,content-type,x-uptokey-processing-policy,x-uptokey-conversation-id,x-uptokey-conversation-request-id,x-uptokey-project-id");
      c.header("Vary", "Origin");
      if (url.pathname.startsWith('/v1/workspace/mobility/')) c.header('Access-Control-Allow-Headers', 'authorization,content-type,x-uptokey-account-token,x-uptokey-account-source,x-uptokey-account-ref,x-uptokey-account-revision');
      return c.body(null, 204);
    }
    if (origin !== undefined && !acceptedOrigin) return c.json({ error: { type: "origin_rejected" } }, 403);
    // A syntactically valid extension origin grants only pairing and key-proof renewal.
    // All private requests require a live credential whose approved origin matches.
    if (extensionOrigin && !['/health', '/local/pair/challenge', '/local/pair/consume', '/local/workspace/session/challenge', '/local/workspace/session/complete'].includes(url.pathname)) {
      const supplied = parseLocalBearer(c.req.header('authorization'));
      const resolved = supplied ? await resolveBearer(secrets, supplied) : undefined;
      if (!resolved?.ok || resolved.resolved.kind !== 'client') return c.json({ error: { type: 'unauthorized' } }, 401);
      const registration = resolved.resolved.registration;
      if (registration?.audience !== 'browser-extension' || registration.enrolledVia !== 'pairing' || registration.browserOrigin !== origin) return c.json({ error: { type: 'origin_rejected' } }, 403);
    }
    if (origin !== undefined && acceptedOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header('Access-Control-Expose-Headers', BROWSER_RESPONSE_HEADERS+',retry-after');
      c.header("Vary", "Origin");
    }
    // E2-02: retorno OAuth loopback carrega ?code&state do provedor oficial.
    const oauthReturnQuery = c.req.method === "GET" && url.pathname.startsWith("/local/oauth/return/");
    const canonicalChatQuery = c.req.method === "GET" && url.pathname === "/chat" && [...url.searchParams.keys()].join(',') === 'lang' && /^[a-z]{2}(?:-[A-Za-z]{2,4})?$/.test(url.searchParams.get('lang') ?? '');
    if (url.search !== "" && !(c.req.method === "GET" && (workspaceUsageQuery(url) || governanceQueryAllowed(url) || conversationQueryAllowed(url) || settingsQueryAllowed(url) || localListQueryAllowed(url.pathname, url.searchParams) || remoteAccessQueryAllowed(url) || oauthReturnQuery || canonicalChatQuery || agentsCliQueryAllowed(url) || usageObservabilityQueryAllowed(url) || url.pathname === "/ui" && (localSetupModel(url.searchParams) !== undefined || localSetupProvider(url.searchParams) !== undefined || localSetupConnection(url.searchParams) !== undefined)))) return c.json({ error: { type: "query_rejected" } }, 400);
    if (!expectedMethod) return c.json({ error: { type: "route_not_found" } }, 404);
    if (c.req.method !== expectedMethod) { c.header("Allow", expectedMethod); return c.json({ error: { type: "method_not_allowed" } }, 405); }
    if ((isLocalJsonRoute(url.pathname, c.req.method) || combinedWorkspaceMethod === 'POST') && c.req.header("content-type") !== "application/json") return c.json({ error: { type: "unsupported_media_type" } }, 415);
    if (LOCAL_EMPTY_POST_ROUTES.has(url.pathname) || matchConnectionRoute(url.pathname, c.req.method)?.body === "empty") {
      if (c.req.header("content-type") !== undefined) return c.json({ error: { type: "invalid_request" } }, 400);
      // Node's HTTP adapter supplies a stream for every POST, including an empty
      // one. Validate bytes, not stream presence; Content-Length is no authority.
      if (c.req.raw.body !== null) {
        const body = await readBoundedBody(c.req.raw, 1, 1_000);
        if (!body.ok || body.value.byteLength !== 0) return c.json({ error: { type: "invalid_request" } }, 400);
      }
    }
    await egressReady;
    await next();
    // Match Hono streamSSE: explicit chunking prevents the Node transport from
    // speculatively reading later events before flushing the first SSE frame.
    if (c.res.body && c.res.headers.get('content-type')?.split(';', 1)[0]?.trim().toLowerCase() === 'text/event-stream') {
      c.header('Content-Length', undefined);
      c.header('Transfer-Encoding', 'chunked');
    }
    // Router responses bypass c.json(), so apply browser headers to the final
    // response too. Only the already-validated local origin is reflected.
    if (origin !== undefined && acceptedOrigin) {
      c.header("Access-Control-Allow-Origin", origin);
      c.header('Access-Control-Expose-Headers', BROWSER_RESPONSE_HEADERS+',retry-after');
      const vary=c.res.headers.get('Vary');
      if(!vary?.split(',').some(value=>value.trim().toLowerCase()==='origin'))c.header('Vary',vary?`${vary}, Origin`:'Origin');
    }
  });

  app.get("/health", (c) => c.json({ status: "ok", data_plane: "local", version: RELEASE_VERSION, started_at: startedAt }));
  for(const action of ['challenge','complete'] as const) app.post(`/local/workspace/session/${action}`,async c=>{
    const origin=c.req.header('origin');
    if(!origin||!LOCAL_UI_ORIGINS.has(origin)&&!isExtensionOrigin(origin))return c.json({error:{type:'origin_rejected'}},403);
    const rate=pairingRateLimiter.take('workspace-browser-session',20,60_000);
    if(!rate.ok)return c.json({error:{type:'local_auth_rate_limited'}},429);
    const parsed=await readBoundedJson(c.req.raw,MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if(!parsed.ok)return c.json({error:{type:'invalid_request'}},400);
    try {
      if(action==='challenge') {
        if(!hasExactKeys(parsed.value,['publicJwk']))return c.json({error:{type:'invalid_request'}},400);
        return c.json(isExtensionOrigin(origin)?await browserSessions.challengeExtension(parsed.value.publicJwk,origin):browserSessions.challenge(parsed.value.publicJwk));
      }
      if(!hasExactKeys(parsed.value,['challengeId','signature']))return c.json({error:{type:'invalid_request'}},400);
      return c.json(await browserSessions.complete(parsed.value.challengeId,parsed.value.signature,origin));
    }catch{return c.json({error:{type:'workspace_session_rejected'}},403);}
  });
  app.get("/", (c) => c.redirect("/ui"));
  app.get("/v1", (c) => c.redirect("/ui"));
  app.get("/ui", (c) => {
    const incoming = new URL(c.req.url);
    if ((c.req.header("accept") ?? "").includes("text/html")) {
      const target = new URL("http://127.0.0.1:5273/design/#connections");
      for (const key of ["lang", "provider", "connection", "model"]) {
        const value = incoming.searchParams.get(key);
        if (value) target.searchParams.set(key, value);
      }
      c.header("Cache-Control", "no-store");
      c.header("Referrer-Policy", "no-referrer");
      return c.redirect(target.toString(), 307);
    }
    const nonce = randomBytes(16).toString("base64url");
    c.header("Content-Security-Policy", "default-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'none'; script-src 'nonce-" + nonce + "'; style-src 'nonce-" + nonce + "'; connect-src 'self'");
    c.header("X-Content-Type-Options", "nosniff"); c.header("X-Frame-Options", "DENY"); c.header("Referrer-Policy", "no-referrer"); c.header("Cache-Control", "no-store");
    const connection=localSetupConnection(incoming.searchParams);
    if(connection&&!Object.hasOwn(config.providers,connection))return c.json({error:{type:"connection_not_found"}},404);
    return c.html(localUiHtml(config, nonce, incoming.searchParams));
  });
  app.get("/favicon.ico", (c) => c.body(null, 204));
  app.get("/chat", (c) => {
    const target = new URL("http://127.0.0.1:5273/design/#work");
    const lang = new URL(c.req.url).searchParams.get("lang");
    if (lang && /^[a-zA-Z-]{2,12}$/.test(lang)) target.searchParams.set("lang", lang);
    c.header("Cache-Control", "no-store");
    c.header("Referrer-Policy", "no-referrer");
    return c.redirect(target.href);
  });
  app.get("/local/ui/status", (c) => c.json(localStatusProjection(config, router, identityEpoch?.())));
  // E2-18 Acesso Remoto — diagnóstico/plan/start/stop/observe/revoke (sem túnel real implícito).
  void REMOTE_ACCESS_LOCAL_ROUTES;
  const remoteAccessObserver = createTransportObserver({ projectBinDir: join(dataDir(), "bin") });
  const managedRemoteAccess = new ManagedRemoteAccess({
    directory: join(dataDir(), 'remote-access'), secrets,
    dispatch: async (path, request) => {
      const headers = new Headers(request.headers);
      headers.set('host', EXPECTED_HOST);
      headers.set('authorization', `Bearer ${await ensureLocalToken(secrets)}`);
      return app.fetch(new Request(`http://${EXPECTED_HOST}${path}`, {
        method: request.method, headers, signal: request.signal,
        ...(request.method === 'POST' ? { body: await request.arrayBuffer() } : {}),
      }));
    },
  });
  registerRemoteAccessRoutes(app, {
    managed: managedRemoteAccess,
    authorize: async (header) => {
      const supplied = parseLocalBearer(header);
      return Boolean(supplied && await hasValidLocalToken(supplied, secrets));
    },
    observeTransport: (kind) => remoteAccessObserver.observe(kind, process.platform === "darwin" ? "macos" : process.platform === "linux" ? "linux" : "windows"),
  });
  registerRoutingRoutes(app, { read: () => config, persist: persistRuntimeConfig, resolveModels: async (providerId,snapshot) => {
    const entry=snapshot.providers[providerId];
    if(!entry?.enabled)return [];
    const models=[...new Set([...entry.models,...(entry.defaultModel?[entry.defaultModel]:[])])];
    // The same primary policy and vault owner as Router; a disabled/missing
    // primary cannot silently select another account or the legacy key.
    const primary=await connectionProfiles?.getActiveProfileForProvider(providerId);
    if(primary){
      if(!primary.enabled||primary.endpointUrl&&primary.endpointUrl!==(entry.endpointUrl??'')||
        primary.accessMode!=='local'&&!await connectionProfiles!.credentialPresent(primary))return [];
      return primary.modelIds.length?models.filter(model=>primary.modelIds.includes(model)):models;
    }
    return entry.configured?models:[];
  }, authorize: async header => {
    const supplied = parseLocalBearer(header);
    return Boolean(supplied && await hasValidLocalToken(supplied, secrets));
  }});

  // E2-20 diagnóstico controlado — loopback apenas; CA efêmera por sessão; default OFF.
  registerDiagnosticRoutes(app, {
    authorize: async (header) => {
      const supplied = parseLocalBearer(header);
      return Boolean(supplied && await hasValidLocalToken(supplied, secrets));
    },
  });

  // E2-19 egress — journal beside other local state; routes under /local/egress/*
  if (typeof (router as unknown as { attachEgressStore?: (store: EgressStore) => void }).attachEgressStore === "function") {
    (router as unknown as { attachEgressStore: (store: EgressStore) => void }).attachEgressStore(egressStore);
  }
  registerEgressRoutes(app, {
    store: egressStore,
    requireLocalAuth: async (c, next) => {
      const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
      if (!auth.allowed) {
        if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
        return c.json({ error: { type: "unauthorized" } }, 401);
      }
      await next();
    },
  });

  app.use("/local/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    await next();
  });

  app.post("/local/pair/challenge", async (c) => {
    const attemptRate = pairingRateLimiter.take("localhost-pairing-attempt", LOCAL_PAIRING_ATTEMPT_LIMIT, LOCAL_PAIRING_ATTEMPT_WINDOW_MS);
    if (!attemptRate.ok) { c.header("Retry-After", String(attemptRate.retryAfter)); return c.json({ error: { type: "local_pairing_rate_limited" } }, 429); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if ((!hasExactKeys(body, ["clientName"]) && !hasExactKeys(body, ["clientName", "audience"])) || ("audience" in body && !PAIRING_AUDIENCES.includes(body.audience as PairingAudience))) return c.json({ error: { type: "invalid_request" } }, 400);
    const clientName = normalizeClientName(body.clientName);
    if (!clientName) return c.json({ error: { type: "invalid_request" } }, 400);
    const pairingOrigin = c.req.header('origin');
    if (isExtensionOrigin(pairingOrigin) && (!('audience' in body) || body.audience !== 'browser-extension')) return c.json({ error: { type: 'pairing_audience_invalid' } }, 400);
    const creationRate = pairingRateLimiter.take("localhost-pairing-creation", LOCAL_PAIRING_CHALLENGE_LIMIT, LOCAL_PAIRING_CHALLENGE_WINDOW_MS);
    if (!creationRate.ok) { c.header("Retry-After", String(creationRate.retryAfter)); return c.json({ error: { type: "local_pairing_rate_limited" } }, 429); }
    try {
      return c.json(pairing.create(clientName, parsePairingAudience("audience" in body ? body.audience : undefined), isExtensionOrigin(pairingOrigin) ? pairingOrigin : undefined), 201);
    } catch (error) {
      if (error instanceof Error && error.message === "pairing_capacity_exceeded") {
        c.header("Retry-After", "300");
        return c.json({ error: { type: "pairing_capacity_exceeded" } }, 429);
      }
      throw error;
    }
  });

  app.post("/local/pair/approve", async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if ((!hasExactKeys(body, ["id", "userCode"]) && !hasExactKeys(body, ["id", "userCode", "audience"])) || ("audience" in body && !PAIRING_AUDIENCES.includes(body.audience as PairingAudience)) || !isUuidV4(body.id) || typeof body.userCode !== "string" || !/^[A-Fa-f0-9]{8}$/.test(body.userCode)) return c.json({ error: { type: "invalid_request" } }, 400);
    if (!pairing.approve(body.id, body.userCode, parsePairingAudience("audience" in body ? body.audience : undefined))) {
      return c.json({ error: { type: "pairing_invalid_or_expired" } }, 404);
    }
    return c.json({ approved: true });
  });

  app.post("/local/pair/consume", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value as Record<string, unknown>;
    if (!isUuidV4(body.id)) return c.json({ error: { type: "invalid_request" } }, 400);
    const extraKeys = Object.keys(body).filter((key) => key !== "id" && key !== "publicJwk");
    if (extraKeys.length > 0) return c.json({ error: { type: "invalid_request" } }, 400);
    // Optional native-client consent key enrollment, bound to the approved pairing.
    let client;
    try {
      const origin = c.req.header('origin');
      client = await pairing.consume(body.id, body.publicJwk, isExtensionOrigin(origin) ? origin : undefined);
    } catch (enrollmentError) {
      if (enrollmentError instanceof Error && enrollmentError.message === "browser_key_invalid") return c.json({ error: { type: "invalid_request" } }, 400);
      // The approved challenge is kept: the client may retry consume with its public key.
      if (enrollmentError instanceof Error && enrollmentError.message === "pairing_key_required") return c.json({ error: { type: "pairing_key_required" } }, 400);
      throw enrollmentError;
    }
    if (client) return c.json(client);
    const rate = pairingRateLimiter.take("localhost-pairing-consume-invalid", LOCAL_PAIRING_CONSUME_LIMIT, LOCAL_PAIRING_CONSUME_WINDOW_MS);
    if (!rate.ok) { c.header("Retry-After", String(rate.retryAfter)); return c.json({ error: { type: "local_pairing_rate_limited" } }, 429); }
    return c.json({ error: { type: "pairing_pending_or_expired" } }, 409);
  });

  app.post("/local/client/provision", async (c) => {
    const rate = pairingRateLimiter.take("localhost-client-provision", 10, 60_000);
    if (!rate.ok) { c.header("Retry-After", String(rate.retryAfter)); return c.json({ error: { type: "local_client_provision_rate_limited" } }, 429); }
    // Issuing credentials is administrative. Origin selects the browser boundary,
    // never the authority to mint a less restrictive client policy.
    const mutationAuth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!mutationAuth.allowed) { if (mutationAuth.rateLimited) { c.header("Retry-After", String(mutationAuth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    if (!hasExactKeys(parsed.value, ["clientName"]) && !hasExactKeys(parsed.value, ["clientName", "ttlMs"])) return c.json({ error: { type: "invalid_request" } }, 400);
    const clientName = normalizeClientName(parsed.value.clientName);
    if (!clientName) return c.json({ error: { type: "invalid_request" } }, 400);
    const ttlMs = "ttlMs" in parsed.value ? parsed.value.ttlMs : undefined;
    try {
      const paired = await provisionPairedClient(secrets, clientName, ttlMs as number | undefined);
      // E2-03 migração: converte metadata legada em policy default delimitada ao
      // comportamento anterior (sem ampliar escopo, nunca admin).
      await migrateLegacyClient(secrets, paired.clientId);
      return c.json(paired, 201);
    }
    catch { return c.json({ error: { type: "local_client_provision_failed" } }, 503); }
  });

  app.post("/local/control-pair/approve", async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["id", "userCode"]) || !isUuidV4(body.id) || typeof body.userCode !== "string" || !/^[A-Fa-f0-9]{6}$/.test(body.userCode)) return c.json({ error: { type: "invalid_request" } }, 400);
    if (!controlCapabilities.approve(body.id, body.userCode)) return c.json({ error: { type: "pairing_invalid_or_expired" } }, 404);
    return c.json({ approved: true });
  });

  app.post("/local/control-pair/revoke", async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    await controlCapabilities.revokeAll();
    return c.body(null, 204);
  });

  app.post("/local/config/reload", async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    // The shared empty-POST gate already validated the actual stream bytes.
    let next: ProxyConfig;
    try { next = await configLoader(); assertProxyConfig(next); }
    catch { return c.json({ error: { type: "config_reload_failed" } }, 503); }
    // A reload also follows credential replacement. Invalidate every affected
    // provider, including custom endpoints, before accepting a new cached result.
    const affected = [...new Set([...Object.keys(config.providers), ...Object.keys(next.providers)])].filter(isProvider);
    Object.assign(config, next);
    try { for (const provider of affected) await router.invalidateProviderCache(provider); return c.body(null, 204); }
    catch { return c.json({ error: { type: "cache_invalidation_failed" } }, 503); }
  });

  app.post("/local/provider/save", async (c) => {
    const mutateRate = pairingRateLimiter.take("localhost-provider-mutate", LOCAL_PROVIDER_MUTATE_LIMIT, LOCAL_PROVIDER_MUTATE_WINDOW_MS);
    if (!mutateRate.ok) { c.header("Retry-After", String(mutateRate.retryAfter)); return c.json({ error: { type: "local_provider_rate_limited" } }, 429); }
    const mutationAuth = await authorizeProviderMutation(c.req.header("origin"), c.req.header("authorization"), secrets, authRateLimiter);
    if (!mutationAuth.allowed) { if (mutationAuth.rateLimited) { c.header("Retry-After", String(mutationAuth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["provider", "key", "acceptGeminiPrivacy"]) || !isCoreProvider(body.provider) || typeof body.key !== "string" || body.key.length > MAX_PROVIDER_KEY_LENGTH || typeof body.acceptGeminiPrivacy !== "boolean") return c.json({ error: { type: "invalid_request" } }, 400);
    if (body.provider === "gemini" && body.acceptGeminiPrivacy !== true) return c.json({ error: { type: "gemini_privacy_consent_required" } }, 412);
    try {
      await enableProvider(body.provider, body.key, secrets, async (mutator) => {
        const privacyAcceptedAt = new Date().toISOString();
        return persistRuntimeConfig((next) => {
          mutator(next);
          if (body.provider === "gemini") {
            next.providers.gemini.privacyAcceptedAt = privacyAcceptedAt;
            next.providers.gemini.privacyNoticeVersion = GEMINI_FREE_PRIVACY_NOTICE_VERSION;
          }
        });
      }, { invalidateProvider: (provider) => router.invalidateProviderCache(provider) });
      return c.json({ status: "ok", provider: body.provider });
    } catch (error) {
      const type = error instanceof Error && error.message === "provider_key_invalid" ? "provider_key_invalid" : "provider_save_failed";
      return c.json({ error: { type } }, 400);
    }
  });

  app.post("/local/provider/configure-optional", async (c) => {
    const mutateRate = pairingRateLimiter.take("localhost-provider-mutate", LOCAL_PROVIDER_MUTATE_LIMIT, LOCAL_PROVIDER_MUTATE_WINDOW_MS);
    if (!mutateRate.ok) { c.header("Retry-After", String(mutateRate.retryAfter)); return c.json({ error: { type: "local_provider_rate_limited" } }, 429); }
    const mutationAuth = await authorizeProviderMutation(c.req.header("origin"), c.req.header("authorization"), secrets, authRateLimiter);
    if (!mutationAuth.allowed) { if (mutationAuth.rateLimited) { c.header("Retry-After", String(mutationAuth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["provider", "endpointUrl", "model", "key", "acceptProviderRisk"]) || typeof body.provider !== "string" || typeof body.endpointUrl !== "string" || body.endpointUrl.length > 2_048 || typeof body.model !== "string" || body.model.length > 200 || typeof body.key !== "string" || body.key.length > MAX_PROVIDER_KEY_LENGTH || typeof body.acceptProviderRisk !== "boolean") return c.json({ error: { type: "invalid_request" } }, 400);
    if (!isOptionalProvider(body.provider) && !isUserDefinedProvider(body.provider)) return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      if (isUserDefinedProvider(body.provider)) {
        await configureAndEnableUserDefinedProvider(body.provider, body.endpointUrl, body.model, body.key, secrets, (mutator) => persistRuntimeConfig(mutator), { invalidateProvider: (provider) => router.invalidateProviderCache(provider) });
      } else {
        await configureAndEnableOptionalProvider(body.provider, body.endpointUrl, body.model, body.key, secrets, (mutator) => persistRuntimeConfig(mutator), { invalidateProvider: (provider) => router.invalidateProviderCache(provider) }, body.acceptProviderRisk);
      }
      return c.json({ status: "ok", provider: body.provider });
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const type = ["endpoint_url_invalid", "endpoint_protocol_forbidden", "endpoint_credentials_forbidden", "endpoint_ollama_remote_forbidden", "endpoint_vllm_remote_forbidden", "endpoint_https_required", "endpoint_provider_forbidden", "endpoint_named_profile_mismatch", "provider_model_invalid", "provider_key_invalid", "provider_risk_consent_required", "provider_name_invalid", "provider_limit_exceeded"].includes(message) ? message : "provider_save_failed";
      return c.json({ error: { type } }, 400);
    }
  });

  app.post("/local/provider/revoke", async (c) => {
    const mutateRate = pairingRateLimiter.take("localhost-provider-mutate", LOCAL_PROVIDER_MUTATE_LIMIT, LOCAL_PROVIDER_MUTATE_WINDOW_MS);
    if (!mutateRate.ok) { c.header("Retry-After", String(mutateRate.retryAfter)); return c.json({ error: { type: "local_provider_rate_limited" } }, 429); }
    const mutationAuth = await authorizeProviderMutation(c.req.header("origin"), c.req.header("authorization"), secrets, authRateLimiter);
    if (!mutationAuth.allowed) { if (mutationAuth.rateLimited) { c.header("Retry-After", String(mutationAuth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["provider", "confirmation"]) || typeof body.provider !== "string" || !(isProvider(body.provider) || isUserDefinedProvider(body.provider)) || body.confirmation !== "REVOGAR") return c.json({ error: { type: "invalid_request" } }, 400);
    try {
      await revokeProvider(body.provider, secrets, (mutator) => persistRuntimeConfig(mutator), { invalidateProvider: (provider) => router.invalidateProviderCache(provider) });
      return c.json({ status: "ok", provider: body.provider });
    } catch {
      return c.json({ error: { type: "provider_revoke_failed" } }, 400);
    }
  });

  app.post("/local/update/authorize-stop", async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok || !hasExactKeys(parsed.value, ["pid"]) || !Number.isSafeInteger(parsed.value.pid) || parsed.value.pid !== process.pid) return c.json({ error: { type: "daemon_pid_mismatch" } }, 409);
    setTimeout(requestUpdateShutdown, 250);
    return c.body(null, 204);
  });

  for (const provider of ALL_PROVIDERS) app.post(`/local/cache/invalidate/${provider}`, async (c) => {
    const auth = await administrativeAuth(c.req.header("authorization"), secrets, authRateLimiter);
    if (!auth.allowed) { if (auth.rateLimited) { c.header("Retry-After", String(auth.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); } return c.json({ error: { type: "unauthorized" } }, 401); }
    // The shared empty-POST gate already validated the actual stream bytes.
    try { await router.invalidateProviderCache(provider); return c.body(null, 204); }
    catch { return c.json({ error: { type: "cache_invalidation_failed" } }, 503); }
  });

  app.post("/local/client/revoke", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["clientId"]) || !isUuidV4(body.clientId)) return c.json({ error: { type: "invalid_request" } }, 400);
    const supplied = parseLocalBearer(c.req.header("authorization"));
    if (!supplied || !await pairing.revoke(body.clientId, supplied)) {
      const rate = authRateLimiter.recordFailure();
      if (!rate.allowed) { c.header("Retry-After", String(rate.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    return c.body(null, 204);
  });

  app.post("/local/client/rotate", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    if (!parsed.ok) return c.json({ error: { type: parsed.reason === "too_large" ? "request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400);
    const body = parsed.value;
    if (!hasExactKeys(body, ["clientId"]) || !isUuidV4(body.clientId)) return c.json({ error: { type: "invalid_request" } }, 400);
    const supplied = parseLocalBearer(c.req.header("authorization"));
    const rotated = supplied ? await pairing.rotate(body.clientId, supplied) : undefined;
    if (rotated) return c.json(rotated);
    const rate = authRateLimiter.recordFailure();
    if (!rate.allowed) { c.header("Retry-After", String(rate.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
    return c.json({ error: { type: "unauthorized" } }, 401);
  });

  app.get("/local/status", async (c) => {
    const supplied = parseLocalBearer(c.req.header("authorization"));
    if (!supplied || !await hasValidLocalToken(supplied, secrets)) {
      const rate = authRateLimiter.recordFailure();
      if (!rate.allowed) { c.header("Retry-After", String(rate.retryAfterSeconds)); return c.json({ error: { type: "local_auth_rate_limited" } }, 429); }
      return c.json({ error: { type: "unauthorized" } }, 401);
    }
    return c.json(localStatusProjection(config, router, identityEpoch?.()));
  });

  // B9-reparo C: the authenticated middleware is the productive owner of sink admission.
  // Private persistence (vault objects, sync upload) needs a live admission; other
  // sinks keep the core default for local background owners.
  const sinkAuthority = sharedSinkAuthority();
  sinkAuthority.requireAdmission(['vault:objects', 'cloud:sync_upload']);
  // B9-reparo B: consumidor produtivo do VaultService (mobilidade local-first).
  // Transporte remoto B8 só quando UPTOKEY_HOSTED_SYNC_ORIGIN e uma fonte de token
  // de conta existem; sem isso a disponibilidade informa a ausência real.
  getBoundMobilityService()?.dispose();
  const hostedSync = hostedSyncClientFromEnvironment(process.env, requestHostedAccountToken,revalidateHostedAccountOperation);
  bindMobilityService(new MobilityService(secrets, { sinkAuthority,revalidate:revalidateHostedAccountBinding, ...(hostedSync ? { hosted: hostedSync } : {}) }));
  app.use("/v1/*", async (c, next) => {
    c.header("Cache-Control", "no-store");
    const supplied = parseLocalBearer(c.req.header("authorization"));
    const credentialHint = supplied ? (parseClientTokenFormat(supplied) ?? 'admin') : undefined;
    const credentialGeneration = credentialHint ? sinkAuthority.credentialGeneration(credentialHint) : 0;
    // E2-03: authenticate against admin token or scoped client policy before any
    // provider/secret/quota work. Zero provider calls on 401/403/422 paths.
    const resolved = await resolveBearer(secrets, supplied ?? undefined);
    if (!resolved.ok) {
      const rate = authRateLimiter.recordFailure();
      if (!rate.allowed) {
        c.header("Retry-After", String(rate.retryAfterSeconds));
        return c.json({ error: { type: "local_auth_rate_limited" } }, 429);
      }
      // token_invalid/token_expired/token_revoked map to 401 with typed body.
      if (resolved.error === "token_invalid") return c.json({ error: { type: "token_invalid" } }, 401);
      if (resolved.error === "token_expired") return c.json({ error: { type: "token_expired" } }, 401);
      return c.json({ error: { type: "token_revoked" } }, 401);
    }
    if(resolved.resolved.delegation){
      const path=new URL(c.req.url).pathname;
      if(!['/v1/chat/completions','/v1/completions','/v1/responses','/v1/messages'].includes(path))return c.json({error:{type:'scope_denied'}},403);
      try {await combinedReady;if(!delegatedKeys)throw Error('unavailable');await delegatedKeys.authorize(resolved.resolved,c.req.header('x-uptokey-project-id'));}
      catch {return c.json({error:{type:'delegated_access_denied'}},403);}
    }
    const scopeError = checkRouteScope(resolved.resolved, new URL(c.req.url).pathname);
    if (scopeError) return c.json({ error: { type: "scope_denied" } }, 403);
    const contextLink = !resolved.resolved.delegation ? await resolveClientContextLink(secrets,resolved.resolved,identityEpoch?.()) : undefined;
    if (!resolved.resolved.delegation) {
      if (contextLink && c.req.path.startsWith('/v1/workspace')) {
        // Owner-wide settings, governance, sync and catalogs do not carry a finite
        // project filter. A context grant cannot expose or manage those resources.
        const projectRoute = c.req.path === '/v1/workspace/projects' || c.req.path.startsWith('/v1/workspace/projects/');
        const conversationRoute = c.req.path === '/v1/workspace/conversations' || c.req.path.startsWith('/v1/workspace/conversations/');
        const sharedMetadata = c.req.method === 'GET' && ['/v1/workspace/capabilities','/v1/workspace/project-agent/capabilities'].includes(c.req.path);
        if (!projectRoute && !conversationRoute && !sharedMetadata) return c.json({error:{type:'context_scope_denied'}},403);
      }
    }
    if (resolved.resolved.policy?.retentionMode === 'ephemeral' && !allowsEphemeralRequest(c.req.method, c.req.path)) {
      return c.json({error:{type:'ephemeral_mode_persistence_blocked'}},403);
    }
    if (resolved.resolved.kind === "client" && resolved.resolved.policy) {
      if (!keyGovernor.checkRpm(resolved.resolved.policy)) {
        c.header("Retry-After", "60");
        return c.json({ error: { type: "key_limit_exceeded" } }, 429);
      }
      const keySlot = keyGovernor.tryAcquireConcurrent(resolved.resolved.policy);
      if (!keySlot) {
        c.header("Retry-After", "1");
        return c.json({ error: { type: "key_limit_exceeded" } }, 429);
      }
      c.set("keyRelease" as never, keySlot as never);
      if (resolved.resolved.clientId) await recordClientUse(secrets, resolved.resolved.clientId);
    }
    if (!resolved.resolved.delegation && (resolved.resolved.kind === 'admin' || resolved.resolved.policy)) {
      const client = resolved.resolved;
      const lease = client.kind === 'client' && client.clientId ? await secrets.get(`local:client:${client.clientId}:expires`) : undefined;
      const bounds = [lease, client.policy?.expiresAt ?? undefined].map(value => value ? Date.parse(value) : NaN).filter(value => Number.isSafeInteger(value) && value > 0);
      try {
        sinkAuthority.register({
          principalId: localPrincipalId(identityEpoch?.(), client),
          retentionMode: client.policy?.retentionMode ?? 'standard',
          policyRevision: client.kind === 'admin' ? 'admin' : client.policy!.revision,
          ...(bounds.length ? { expiresAt: Math.min(...bounds) } : {}),
          ...(credentialHint ? { credentialGeneration } : {}),
        });
      } catch {
        // Revoke/rotate committed while this request authenticated: never re-admit it.
        return c.json({ error: { type: 'credential_changed' } }, 409);
      }
    }
    c.set("client" as never, resolved.resolved as never);
    if (!resolved.resolved.delegation) c.set('workspaceAuthority' as never,{
      principal:contextLink?.ownerPrincipalId ?? localPrincipalId(identityEpoch?.(),resolved.resolved),
      projects:contextLink ? Object.freeze([contextLink.projectId]) : credentialProjectGrant(resolved.resolved),
    } as never);
    if (contextLink) c.set('workspaceContextRevision' as never,contextLink.revision as never);
    try {
      await next();
      if (contextLink) {
        const assertCurrent = async () => {
          const currentClient = await authenticateContextCredential(c.req.header('authorization'),secrets);
          const currentLink = await resolveClientContextLink(secrets,currentClient,identityEpoch?.());
          if (!currentLink || currentLink.revision !== contextLink.revision) throw new ContextLinkError('context_link_invalid');
        };
        await assertCurrent();
        c.res = guardContextResponse(c.res,assertCurrent);
      }
    } finally {
      (c.get("keyRelease" as never) as (() => void) | undefined)?.();
    }
    c.header("Cache-Control", "no-store");
  });

  /** Read the E2-03 principal resolved by the /v1/* middleware. */
  function requestClient(c: { get: (key: never) => unknown }): ResolvedClient {
    return (c.get("client" as never) as ResolvedClient | undefined) ?? { kind: "admin" };
  }

  // This is shared by protocol adapters before their provider dispatch. An explicit
  // conversation id binds the request to its owner's stored policy; request headers
  // may tighten it, but cannot grant permission revoked in the repository.
  async function processingScope(c: Context, body: unknown, externalOperation = false, governedOperation = false): Promise<Pick<DispatchContext, 'allowedProviders' | 'cachePartition' | 'allowCache' | 'tenantId' | 'retentionMode' | 'reserveBudget'> | Response> {
    const raw = isJsonObject(body) ? body : {};
    const headerPolicy = c.req.header('x-uptokey-processing-policy');
    const bodyPolicy = raw.processing_policy;
    for (const policy of [headerPolicy, bodyPolicy]) {
      if (policy !== undefined && policy !== 'local_only' && policy !== 'external_allowed') {
        return c.json({ error: { type: 'processing_policy_invalid' } }, 400);
      }
    }
    if (headerPolicy !== undefined && bodyPolicy !== undefined && headerPolicy !== bodyPolicy) {
      return c.json({ error: { type: 'processing_policy_conflict' } }, 409);
    }
    let localOnly = headerPolicy === 'local_only' || bodyPolicy === 'local_only';
    const currentRetention = await resolveLocalRetentionMode(c.req.header('authorization'), secrets);
    // Delegation has a separate inference authority and never gains workspace access.
    if (currentRetention === undefined && !requestClient(c).delegation) return c.json({error:{type:'unauthorized'}},401);
    const ephemeral = currentRetention === 'ephemeral' || requestClient(c).policy?.retentionMode === 'ephemeral';
    const retentionModeScope = ephemeral ? 'ephemeral' as const : 'standard' as const;
    let temporary = ephemeral;
    const headerConversation = c.req.header('x-uptokey-conversation-id');
    const bodyConversation = raw.conversation_id;
    if (headerConversation !== undefined && bodyConversation !== undefined && headerConversation !== bodyConversation) {
      return c.json({ error: { type: 'conversation_invalid' } }, 400);
    }
    const conversationId = headerConversation ?? bodyConversation;
    if (conversationId !== undefined) {
      if (typeof conversationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(conversationId)) {
        return c.json({ error: { type: 'conversation_invalid' } }, 400);
      }
      await combinedReady;
      // Initial request authority is immutable and was already authenticated by
      // /v1 middleware. Storage awaits still require the fresh guard below.
      const admitted = c.get('workspaceAuthority' as never) as {principal:string;projects:LocalProjectGrant}|undefined;
      if (!admitted) return c.json({ error: { type: 'unauthorized' } }, 401);
      try {
        const conversation = await conversations.store.getConversation(admitted.principal, conversationId);
        const current = await resolveLocalWorkspaceAuthority(c.req.header('authorization'),secrets,identityEpoch?.());
        if (!current || current.principal !== admitted.principal) throw new ContextLinkError('context_link_invalid');
        if (!isProjectGranted(current.projects, conversation.projectId)) return c.json({error:{type:'resource_not_granted'}},403);
        if (ephemeral && conversation.storagePolicy !== 'temporary') return c.json({error:{type:'ephemeral_mode_persistence_blocked'}},403);
        temporary = ephemeral || conversation.storagePolicy === 'temporary';
        if (conversation.processingPolicy === 'local_only') {
          if (headerPolicy === 'external_allowed' || bodyPolicy === 'external_allowed') {
            return c.json({ error: { type: 'processing_policy_conflict' } }, 403);
          }
          localOnly = true;
        }
      } catch (error) {
        if (error instanceof WorkspaceError) return c.json({ error: { type: error.code } }, error.status);
        throw error;
      }
    }
    if (governedOperation && (temporary || localOnly)) {
      return c.json({ error: { type: 'conversation_policy_unsupported_for_workflow' } }, 403);
    }
    // A tenant is not an owner. Bind every cache entry to authenticated authority,
    // project/conversation and policy; re-read after awaits and before publication.
    // Old tenant-only entries are intentionally never promoted into this namespace.
    const readCachePartition = async (): Promise<string | undefined> => {
      if (temporary) return;
      const authority = await resolveLocalCacheAuthority(c.req.header('authorization'), secrets, identityEpoch?.());
      if (!authority) return;
      const conversation = typeof conversationId === 'string' ? await conversations.store.getConversation(authority.principal, conversationId) : undefined;
      if (conversation && (conversation.storagePolicy === 'temporary' || !isProjectGranted(authority.projects, conversation.projectId))) return;
      const explicitProject = c.req.header('x-uptokey-project-id');
      if (explicitProject !== undefined && (!isProjectGranted(authority.projects, explicitProject) || conversation && conversation.projectId !== explicitProject)) return;
      const projectId = conversation?.projectId ?? explicitProject;
      const project = projectId && workspaceStore ? await workspaceStore.getProject(authority.principal, projectId) : undefined;
      if (projectId && !project) return;
      // Policy may have narrowed while reading the repository. Never authorize
      // an old scope using a credential snapshot taken before those awaits.
      const currentAuthority = await resolveLocalCacheAuthority(c.req.header('authorization'), secrets, identityEpoch?.());
      if (currentAuthority?.partition !== authority.partition) return;
      return createHash('sha256').update(JSON.stringify({version: 1, authority: authority.partition,
        project: project ? {id: project.id, revision: project.revision} : null,
        conversation: conversation ? {id: conversation.id, storagePolicy: conversation.storagePolicy, processingPolicy: conversation.processingPolicy} : null,
        localOnly, headerPolicy: headerPolicy ?? null, bodyPolicy: bodyPolicy ?? null})).digest('hex');
    };
    const cachePartition = await readCachePartition().catch(() => undefined);
    const cacheScope = cachePartition ? {
      cachePartition,
      tenantId: identityEpoch?.()?.tenantId ?? config.appliedConfigTenantId ?? 'local',
      allowCache: async () => await readCachePartition() === cachePartition,
    } : {tenantId: undefined, allowCache: async () => false};
    let delegatedProviders: ProviderName[]|undefined;
    if(requestClient(c).delegation){try{delegatedProviders=await delegatedKeys!.authorize(requestClient(c),c.req.header('x-uptokey-project-id'),typeof raw.model==='string'?raw.model:undefined,Object.entries(config.providers).filter(([,p])=>p.enabled).map(([id])=>id)) as ProviderName[];if(!delegatedProviders?.length)throw Error('scope_denied');}catch{return c.json({error:{type:'delegated_access_denied'}},403);}}
    const budgetRequestId = randomUUID();
    const budgetScope: Pick<DispatchContext, 'reserveBudget'> = governanceService && !governedOperation && !externalOperation ? {
      reserveBudget: async attempt => {
        await combinedReady;
        // A delegated bearer acts inside the owner's project that delegatedKeys.authorize already bound to this
        // request; its budget is the owner's, and it never reaches a conversation. The credential is re-read
        // before returning so a revocation during the await refuses the send.
        const delegation = requestClient(c).delegation;
        const currentDelegation = async () => {
          const current = await resolveBearer(secrets, /^Bearer (\S+)$/i.exec(c.req.header('authorization') ?? '')?.[1]);
          return current.ok ? current.resolved.delegation : undefined;
        };
        const authority = delegation ? undefined : await resolveLocalWorkspaceAuthority(c.req.header('authorization'),secrets,identityEpoch?.());
        const principal = delegation ? delegation.ownerPrincipalId : authority?.principal;
        const grants = delegation ? Object.freeze([...delegation.projectIds]) : authority?.projects;
        if (!principal || grants === undefined || delegation && typeof conversationId === 'string') throw new Error('workspace_forbidden');
        const conversation = typeof conversationId === 'string' ? await conversations.store.getConversation(principal, conversationId) : undefined;
        const explicitProject = c.req.header('x-uptokey-project-id');
        if (conversation && explicitProject !== undefined && conversation.projectId !== explicitProject) throw new Error('workspace_forbidden');
        const projectId = conversation?.projectId ?? explicitProject;
        if (!isProjectGranted(grants, projectId) || delegation && !projectId) throw new Error('workspace_forbidden');
        if (projectId) {
          if (!workspaceStore) throw new Error('workspace_forbidden');
          await workspaceStore.getProject(principal, projectId);
        }
        if (delegation) { if ((await currentDelegation())?.ownerPrincipalId !== principal) throw new Error('workspace_forbidden'); }
        else if (await resolveLocalPrincipal(c.req.header('authorization'), secrets, identityEpoch?.()) !== principal) throw new Error('workspace_forbidden');
        return governanceService.reserveInferenceBudgets(principal, projectId ?? undefined, budgetRequestId, attempt, requestClient(c).clientId,
          conversation ? { id: conversation.id, temporary: conversation.storagePolicy === 'temporary' } : undefined);
      },
    } : {};
    if (!localOnly) return {...cacheScope,...budgetScope,...(delegatedProviders?{allowedProviders:delegatedProviders}:{}),retentionMode:retentionModeScope};
    const allowedProviders = externalOperation ? [] : localProcessingProviders(config, String(raw.model ?? 'uptokey-auto')).filter(p=>!delegatedProviders||delegatedProviders.includes(p));
    if (!allowedProviders.length) return c.json({ error: { type: 'local_processing_denied' } }, 403);
    return { allowedProviders, ...cacheScope, ...budgetScope, retentionMode: retentionModeScope };
  }

  app.post("/v1/chat/completions", async (c) => {
    const currentIdentity = identityEpoch?.();
    if (identityEpochMismatch(config, currentIdentity)) return c.json({ error: { type: "config_epoch_pending", message: "Aguardando aplicar a configuração autenticada deste device. As chaves locais foram preservadas." } }, 503);
    const now = new Date();
    const offline = await offlineGuard(now);
    if (!offline.allowed && offline.code !== "offline_grace_expired") return c.json({ error: { type: offline.code, message: offline.code === "device_revoked" ? "Este device foi revogado no control plane. As chaves locais foram preservadas." : offline.code === "entitlement_suspended" ? "O acesso Uptokey está suspenso. As chaves locais foram preservadas." : "Reconecte o proxy ao control plane para revalidar o acesso." } }, 503);
    const release = inferenceAdmission.tryAcquire();
    if (!release) {
      c.header("Retry-After", "1");
      return c.json({ error: { type: "local_capacity_exceeded" } }, 429);
    }
    try {
    const parsed = await readBoundedJson(c.req.raw, MAX_INFERENCE_REQUEST_BYTES);
    if (!parsed.ok) { release(); return c.json({ error: { type: parsed.reason === "too_large" ? "inference_request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400); }
      const privacyScope = await processingScope(c, parsed.value);
      if (privacyScope instanceof Response) { release(); return privacyScope; }
    const fieldCheck = validateChatBody(parsed.value);
    if (!fieldCheck.ok) { release(); return c.json({ error: { type: "protocol_field_unsupported", field: fieldCheck.field } }, 422); }
    const request = projectInferenceRequest(parsed.value);
    if (!request) { release(); return c.json({ error: { type: "invalid_request", message: "schema de Chat Completions inválido" } }, 400); }
    if (hasForbiddenInferenceCredentialField(request)) { release(); return c.json({ error: { type: "credential_field_forbidden" } }, 400); }
    const client = requestClient(c);
    const modelDenied = checkModelScope(client, request.model);
    if (modelDenied) { release(); return c.json({ error: { type: "model_scope_denied" } }, 403); }
    const limitDenied = checkOutputLimit(client, request.max_tokens ?? request.max_completion_tokens);
    if (limitDenied) { release(); return c.json({ error: { type: "key_limit_exceeded" } }, 429); }
    const cacheTenantId = currentIdentity?.tenantId ?? config.appliedConfigTenantId;
    let response = await dispatchInference(router, request, { requestId: randomUUID(), ...(cacheTenantId ? { tenantId: cacheTenantId } : {}), ...privacyScope }, c.req.raw.signal);
    if (response.status === 429 && !offline.allowed && offline.code === "offline_grace_expired") {
      const cloned = response.clone();
      const body = await cloned.json().catch(() => null);
      if (body?.error?.type === "no_provider_available") {
        response = Response.json({ error: { type: "offline_grace_expired", message: "Reconecte o proxy ao control plane para revalidar o acesso." } }, { status: 503, headers: { "content-type": "application/json" } });
      }
    }
    return releaseWithResponse(response, release, c.req.raw.signal);
    } catch (error) { release(); throw error; }
  });


  app.post("/v1/messages", async (c) => {
    const currentIdentity = identityEpoch?.();
    if (identityEpochMismatch(config, currentIdentity)) return c.json({ error: { type: "config_epoch_pending", message: "Aguardando aplicar a configuração autenticada deste device. As chaves locais foram preservadas." } }, 503);
    const now = new Date();
    const offline = await offlineGuard(now);
    if (!offline.allowed && offline.code !== "offline_grace_expired") return c.json({ error: { type: offline.code, message: offline.code === "device_revoked" ? "Este device foi revogado no control plane. As chaves locais foram preservadas." : offline.code === "entitlement_suspended" ? "O acesso Uptokey está suspenso. As chaves locais foram preservadas." : "Reconecte o proxy ao control plane para revalidar o acesso." } }, 503);
    const release = inferenceAdmission.tryAcquire();
    if (!release) {
      c.header("Retry-After", "1");
      return c.json({ error: { type: "local_capacity_exceeded" } }, 429);
    }
    try {
      const parsed = await readBoundedJson(c.req.raw, MAX_INFERENCE_REQUEST_BYTES);
      if (!parsed.ok) { release(); return c.json({ error: { type: parsed.reason === "too_large" ? "inference_request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400); }
      const privacyScope = await processingScope(c, parsed.value);
      if (privacyScope instanceof Response) { release(); return privacyScope; }
      const protocolCheck = validateAnthropicBody(parsed.value);
      if (!protocolCheck.ok) { release(); return c.json({ error: { type: "protocol_field_unsupported", field: protocolCheck.field } }, 422); }
      const converted = anthropicMessagesToChatCompletion(parsed.value);
      if ("error" in converted) {
        release();
        return c.json({ error: { type: "invalid_request", message: "schema de Anthropic Messages inválido" } }, 400);
      }
      if (hasForbiddenInferenceCredentialField(converted as Record<string, unknown>)) { release(); return c.json({ error: { type: "credential_field_forbidden" } }, 400); }
      const request = projectInferenceRequest(converted);
      if (!request) { release(); return c.json({ error: { type: "invalid_request", message: "schema de Anthropic Messages inválido" } }, 400); }
      const client = requestClient(c);
      const modelDenied = checkModelScope(client, request.model ?? (typeof parsed.value === "object" && parsed.value !== null ? String((parsed.value as Record<string, unknown>).model ?? "") || undefined : undefined));
      if (modelDenied) { release(); return c.json({ error: { type: "model_scope_denied" } }, 403); }
      const limitDenied = checkOutputLimit(client, request.max_tokens ?? request.max_completion_tokens);
      if (limitDenied) { release(); return c.json({ error: { type: "key_limit_exceeded" } }, 429); }
      const cacheTenantId = currentIdentity?.tenantId ?? config.appliedConfigTenantId;
      let response = await dispatchInference(router, request, { requestId: randomUUID(), ...(cacheTenantId ? { tenantId: cacheTenantId } : {}), ...privacyScope }, c.req.raw.signal);
      if (response.status === 429 && !offline.allowed && offline.code === "offline_grace_expired") {
        const cloned = response.clone();
        const body = await cloned.json().catch(() => null);
        if (body?.error?.type === "no_provider_available") {
          response = Response.json({ error: { type: "offline_grace_expired", message: "Reconecte o proxy ao control plane para revalidar o acesso." } }, { status: 503, headers: { "content-type": "application/json" } });
        }
      }
      if (response.status !== 200) return releaseWithResponse(response, release, c.req.raw.signal);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (request.stream === true && contentType === "text/event-stream") {
        if (!response.body) { release(); return c.json({ error: { type: "provider_response_invalid" } }, 502); }
        const headers = new Headers({ "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        const out = new Response(openAiSseToAnthropicSse(response.body), { status: 200, headers });
        return releaseWithResponse(out, release, c.req.raw.signal);
      }
      if (contentType !== "application/json") return releaseWithResponse(response, release, c.req.raw.signal);
      const openaiBody = await response.json();
      const anthropicBody = chatCompletionToAnthropicMessage(openaiBody, request.model);
      if (!anthropicBody) {
        release();
        return c.json({ error: { type: "provider_response_invalid" } }, 502);
      }
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      const out = new Response(JSON.stringify(anthropicBody), { status: 200, headers });
      return releaseWithResponse(out, release, c.req.raw.signal);
    } catch (error) { release(); throw error; }
  });

  app.post("/v1/responses", async (c) => {
    const currentIdentity = identityEpoch?.();
    if (identityEpochMismatch(config, currentIdentity)) return c.json({ error: { type: "config_epoch_pending", message: "Aguardando aplicar a configuração autenticada deste device. As chaves locais foram preservadas." } }, 503);
    const now = new Date();
    const offline = await offlineGuard(now);
    if (!offline.allowed && offline.code !== "offline_grace_expired") return c.json({ error: { type: offline.code, message: offline.code === "device_revoked" ? "Este device foi revogado no control plane. As chaves locais foram preservadas." : offline.code === "entitlement_suspended" ? "O acesso Uptokey está suspenso. As chaves locais foram preservadas." : "Reconecte o proxy ao control plane para revalidar o acesso." } }, 503);
    const release = inferenceAdmission.tryAcquire();
    if (!release) {
      c.header("Retry-After", "1");
      return c.json({ error: { type: "local_capacity_exceeded" } }, 429);
    }
    try {
      const parsed = await readBoundedJson(c.req.raw, MAX_INFERENCE_REQUEST_BYTES);
      if (!parsed.ok) { release(); return c.json({ error: { type: parsed.reason === "too_large" ? "inference_request_too_large" : "invalid_request" } }, parsed.reason === "too_large" ? 413 : 400); }
      const privacyScope = await processingScope(c, parsed.value);
      if (privacyScope instanceof Response) { release(); return privacyScope; }
      const protocolCheck = validateResponsesBody(parsed.value);
      if (!protocolCheck.ok) { release(); return c.json({ error: { type: "protocol_field_unsupported", field: protocolCheck.field } }, 422); }
      const converted = responsesRequestToChatCompletion(parsed.value);
      if ("error" in converted) {
        release();
        if (converted.error === "unsupported_tool_type" || converted.error === "unsupported_tool_choice") return c.json({ error: { type: "protocol_field_unsupported", field: converted.error === "unsupported_tool_type" ? "tools" : "tool_choice" } }, 422);
        if (converted.error === "unsupported_input_item") return c.json({ error: { type: "protocol_field_unsupported", field: "input" } }, 422);
        return c.json({ error: { type: "invalid_request", message: "schema de Responses inválido" } }, 400);
      }
      if (hasForbiddenInferenceCredentialField(converted as Record<string, unknown>)) { release(); return c.json({ error: { type: "credential_field_forbidden" } }, 400); }
      const request = projectInferenceRequest(converted);
      if (!request) { release(); return c.json({ error: { type: "invalid_request", message: "schema de Responses inválido" } }, 400); }
      const client = requestClient(c);
      const modelDenied = checkModelScope(client, request.model ?? (typeof parsed.value === "object" && parsed.value !== null ? String((parsed.value as Record<string, unknown>).model ?? "") || undefined : undefined));
      if (modelDenied) { release(); return c.json({ error: { type: "model_scope_denied" } }, 403); }
      const limitDenied = checkOutputLimit(client, request.max_tokens ?? request.max_completion_tokens);
      if (limitDenied) { release(); return c.json({ error: { type: "key_limit_exceeded" } }, 429); }
      const cacheTenantId = currentIdentity?.tenantId ?? config.appliedConfigTenantId;
      let response = await dispatchInference(router, request, { requestId: randomUUID(), ...(cacheTenantId ? { tenantId: cacheTenantId } : {}), ...privacyScope }, c.req.raw.signal);
      if (response.status === 429 && !offline.allowed && offline.code === "offline_grace_expired") {
        const cloned = response.clone();
        const body = await cloned.json().catch(() => null);
        if (body?.error?.type === "no_provider_available") {
          response = Response.json({ error: { type: "offline_grace_expired", message: "Reconecte o proxy ao control plane para revalidar o acesso." } }, { status: 503, headers: { "content-type": "application/json" } });
        }
      }
      if (response.status !== 200) return releaseWithResponse(response, release, c.req.raw.signal);
      const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
      if (request.stream === true && contentType === "text/event-stream") {
        if (!response.body) { release(); return c.json({ error: { type: "provider_response_invalid" } }, 502); }
        const headers = new Headers({ "content-type": "text/event-stream", "cache-control": "no-store" });
        for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
          const value = response.headers.get(name);
          if (value) headers.set(name, value);
        }
        const out = new Response(openAiSseToResponsesSse(response.body, request.model), { status: 200, headers });
        return releaseWithResponse(out, release, c.req.raw.signal);
      }
      if (contentType !== "application/json") return releaseWithResponse(response, release, c.req.raw.signal);
      const openaiBody = await response.json();
      const responsesBody = chatCompletionToResponses(openaiBody, request.model);
      if (!responsesBody) {
        release();
        return c.json({ error: { type: "provider_response_invalid" } }, 502);
      }
      const headers = new Headers({ "content-type": "application/json", "cache-control": "no-store" });
      for (const name of ["x-uptokey-provider", "x-uptokey-model", "x-uptokey-fallback", "x-uptokey-cache", "x-request-id", "x-provider-request-id"]) {
        const value = response.headers.get(name);
        if (value) headers.set(name, value);
      }
      const out = new Response(JSON.stringify(responsesBody), { status: 200, headers });
      return releaseWithResponse(out, release, c.req.raw.signal);
    } catch (error) { release(); throw error; }
  });

  mountClientAndManagementRoutes(app, {
    config, secrets, identityEpoch, offlineGuard, inferenceAdmission, authRateLimiter,
    pairingRateLimiter, openRouterManagement, router, identityEpochMismatch,
    administrativeAuth, authorizeClientKeyManagement, projectInferenceRequest,
    requestClient, checkModelScope, checkOutputLimit, dispatchInference, processingScope,
    openAiChatSseToTextCompletionSse
  });

  app.get("/v1/models", (c) => {
    return c.json(localModelsProjection(config));
  });

  app.get("/v1/usage", (c) => c.json(router.usageMetrics()));
  // Auditable estimation subsystem: catalog state counts, digest-cache stats and local
  // calibration vs provider-reported usage. Numeric/metadata only (usage:read scope).
  app.get("/v1/usage/estimation", (c) => c.json(typeof router.estimationMetrics === "function" ? router.estimationMetrics() : { basis: "local_process_observation", available: false }));
  let legacyConnectionsMigratedFor: string | undefined;
  app.get("/v1/connections", async (c) => {
    const inventory = {...router.connectionMetrics(),deviceEntitlement:deviceEntitlement() ?? null,efficiency:typeof router.efficiencyMetrics === "function" ? router.efficiencyMetrics() : null};
    const epochPending = identityEpochMismatch(config, identityEpoch?.());
    const access = epochPending ? {allowed:false,code:"config_epoch_pending"} : await offlineGuard(new Date());
    const deviceAccess = {allowed:access.allowed,reason:access.allowed ? null : access.code ?? "offline_grace_expired"};
    // An expired control-plane grace period does not disable user-owned BYOK
    // providers. Revocation and entitlement suspension still block inference;
    // the device status remains visible for synchronization diagnostics.
    const projectedProviders = inventory.providers?.map((p: any) => {
      // supportLevel classifies adapters (built_in/custom/experimental), not
      // credential ownership. Match the chat/workspace admission rule instead
      // of requiring a nonexistent "user-managed" catalog value.
      const byokExempt = deviceAccess.reason === "offline_grace_expired";
      const blocked = !deviceAccess.allowed && !byokExempt;
      return {
        ...p,
        providerAdmission: p.admission,
        admission: blocked ? { eligible: false, reason: deviceAccess.reason } : p.admission
      };
    }) ?? [];
    let exposedConnections: Array<{ id: string; providerId: string; label: string; models: string[]; enabled: boolean; eligible: boolean }> = [];
    if (connectionProfiles) {
      try {
        // Providers configured through the CLI/TUI become connections (voice, transcription and media use those),
        // once per change of the configured providers; profiles born that way follow later changes, others are never touched.
        const legacyKey = JSON.stringify(Object.entries(config.providers ?? {}).map(([id, item]) => [id, (item as { configured?: unknown })?.configured === true, (item as { enabled?: unknown })?.enabled === true, (item as { endpointUrl?: unknown })?.endpointUrl ?? null, (item as { models?: unknown })?.models ?? null]));
        if (legacyKey !== legacyConnectionsMigratedFor) {
          await connectionProfiles.migrateFromLegacy(config).then(() => { legacyConnectionsMigratedFor = legacyKey; }, () => undefined);
        }
        const profilesList = await connectionProfiles.list();
        exposedConnections = await Promise.all(profilesList.filter(p=>!p.providerId.startsWith('service-')).map(async (p) => {
          const provider = projectedProviders.find((pr: any) => pr.id === p.providerId);
          const hasCred = await connectionProfiles!.credentialPresent(p);
          const eligible = p.enabled && hasCred && (provider?.admission?.eligible !== false);
          return {
            id: p.id,
            providerId: p.providerId,
            label: p.label || p.providerId,
            models: [...p.modelIds],
            enabled: p.enabled,
            eligible,
          };
        }));
      } catch {
        exposedConnections = [];
      }
    }
    return c.json({...inventory, providers: projectedProviders, connections: exposedConnections, deviceAccess});
  });
  app.get("/v1/local-models", async (c) => {
    const release = inferenceAdmission.tryAcquire();
    if (!release) {c.header("Retry-After", "1"); return c.json({error: {type: "local_capacity"}}, 429);}
    try {
      const runtimes = createDefaultLocalRuntimeRegistry({
        ollamaEndpoint: config.providers.ollama?.endpointUrl,
        vllmEndpoint: config.providers.vllm?.endpointUrl,
      });
      // Totalidade de runtimes locais (visão do Autor 30/09): loopback conhecido apenas;
      // cada runtime tem caminho configurável pela conexão local e detecção fail-closed.
      const runtimeIds = ["ollama", "vllm", "lm-studio", "jan", "llama.cpp"] as const;
      const statuses = await Promise.all(runtimeIds.map(async (id) => {
        const adapter = runtimes.get(id);
        if (!adapter) return { id, status: "unreachable" as const, endpoint: null as string | null, models: [] as Array<{ id: string; sizeBytes: number | null }>, installSupported: false };
        const probe = await adapter.detect(c.req.raw.signal);
        const models = probe.available ? await adapter.listModels(c.req.raw.signal) : [];
        return { id, status: probe.available ? ("available" as const) : ("unreachable" as const), endpoint: adapter.endpointUrl, models: models.map(m => ({ id: m.id, sizeBytes: m.sizeBytes ?? null })), installSupported: id === "ollama" };
      }));
      const byId = new Map(statuses.map(entry => [entry.id, entry]));
      const hardware = detectHardwareProfile();
      const runtimeView = (id: (typeof runtimeIds)[number], nameField: "name" | "id") => {
        const entry = byId.get(id)!;
        return {
        status: entry.status,
        endpoint: entry.endpoint,
        models: entry.models.map((m) => ({ [nameField]: m.id, sizeBytes: m.sizeBytes, capacityNote: id === "ollama" ? ("estimate" as const) : ("estimate_unavailable" as const), fit: estimateModelFit(hardware, m.sizeBytes === null ? {} : { sizeBytes: m.sizeBytes }) })),
        installSupported: entry.installSupported,
        ...(id === "ollama" ? { suggestions: LOCAL_MODEL_SUGGESTIONS.map(model=>({...model,fit:estimateModelFit(hardware,model)})) } : {}),
        };
      };
      const ollama = runtimeView("ollama", "name");
      return c.json({
        installer: "uptokey-models-v1",
        // Backward-compatible ollama projection at top level
        status: ollama.status,
        models: ollama.models,
        runtimes: {
          ollama,
          vllm: runtimeView("vllm", "id"),
          "lm-studio": runtimeView("lm-studio", "id"),
          jan: runtimeView("jan", "id"),
          "llama.cpp": runtimeView("llama.cpp", "id"),
        },
        // Totalidade de modelos (visão do Autor 30/09): catálogo ordenado por
        // popularidade entre desenvolvedores; instalação só por ação explícita.
        hardware,
        popularModels: LOCAL_MODEL_SUGGESTIONS.map(model=>({...model,fit:estimateModelFit(hardware,model)})),
      });
    }
    finally {release();}
  });
  app.post("/v1/local-models/install", async (c) => {
    const parsed = await readBoundedJson(c.req.raw, 8_192);
    const value = parsed.ok && parsed.value && typeof parsed.value === "object" && !Array.isArray(parsed.value) ? parsed.value as Record<string, unknown> : null;
    if (value && typeof value.runtime === "string" && value.runtime.toLowerCase() !== "ollama") return c.json({error: {type: "install_runtime_unsupported"}}, 400);
    const keys = value ? Object.keys(value).filter((k) => k !== "runtime").sort().join(",") : "";
    if (!value || (keys !== "confirmed,model") || value.confirmed !== true || !validInstallModel(value.model)) return c.json({error: {type: "invalid_install_request"}}, 400);
    const encoder = new TextEncoder();
    const stream = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (value: unknown) => controller.enqueue(encoder.encode(JSON.stringify(value) + "\n"));
        try {
          send({stage: "starting"});
          await installLocalModel(value.model as string, {confirmed: true, signal: c.req.raw.signal, endpointUrl: config.providers.ollama?.endpointUrl, onProgress: progress => send(progress)});
          send({stage: "complete", model: value.model}); controller.close();
        } catch (error) { send({error: error instanceof Error ? error.message : "install_failed"}); controller.close(); }
      },
    });
    return new Response(stream, {headers: {"content-type": "application/x-ndjson", "cache-control": "no-store", "x-content-type-options": "nosniff"}});
  });

  app.post("/v1/sources/search", async (c) => {
    const rate = pairingRateLimiter.take("public-source-search", 20, 60_000);
    if (!rate.ok) { c.header("Retry-After", String(rate.retryAfter)); return c.json({ error: { type: "source_rate_limited" } }, 429); }
    const parsed = await readBoundedJson(c.req.raw, MAX_LOCAL_CONTROL_REQUEST_BYTES);
    const privacyScope = await processingScope(c, parsed.ok ? parsed.value : {}, true);
    if (privacyScope instanceof Response) return privacyScope;
    const input = parsed.ok ? parseSourceSearch(parsed.value) : undefined;
    if (!input) return c.json({ error: { type: "invalid_request" } }, 400);
    const sourceRate = pairingRateLimiter.take("public-source-" + input.source, 1, 1_000);
    if (!sourceRate.ok) { c.header("Retry-After", String(sourceRate.retryAfter)); return c.json({ error: { type: "source_rate_limited" } }, 429); }
    const release = sourceAdmission.tryAcquire();
    if (!release) return c.json({ error: { type: "local_capacity_exceeded" } }, 429);
    try { return c.json(await searchPublicSource(input, c.req.raw.signal)); }
    catch (error) {
      const type = error instanceof Error && error.message === "source_rate_limited" ? "source_rate_limited" : "source_unavailable";
      return c.json({ error: { type } }, type === "source_rate_limited" ? 429 : 502);
    } finally { release(); }
  });

  // W5 does not yet carry a conversation policy in its canonical commands.
  // A linked restricted chat must fail closed before plans, journals or effects.
  app.use('/v1/workspace/*', async (c, next) => {
    if (c.req.method !== 'GET' && !c.req.path.startsWith('/v1/workspace/conversations')
      && (requestClient(c).policy?.retentionMode === 'ephemeral' || c.req.header('x-uptokey-conversation-id') !== undefined || c.req.header('x-uptokey-processing-policy') !== undefined)) {
      const scope = await processingScope(c, {}, false, true);
      if (scope instanceof Response) return scope;
    }
    await next();
  });

  // E2-01: conversas persistentes compartilhadas (chat central e mini chats).
  // Módulo próprio; não altera o runtime W5 nem o WorkspaceStore. Registrado
  // antes das rotas /v1/workspace/* para que o prefixo mais específico vença.
  // V1: policy por cliente (H2) aplicada às rotas workspace antes dos mounts.
  // Audiência e escopos vêm do pareamento; clientes sem registro de nome
  // (legado) e o admin seguem pelo caminho anterior. Registrado antes das
  // rotas de conversas E de workspace para cobrir ambas as superfícies.
  // G1: replay vs new execution. A new `runs/start` has no journal run for this
  // principal/project/request and stays behind W5 consent/complete; a replay must
  // resolve to the exact run the journal already admitted (plan, digest and the
  // pertinent conversation admission), so its receipt is returned without a new
  // effect. Key possession, Origin, headers or a stale client state never count
  // as approval, and an altered replay is refused instead of re-classified.
  const runStartRecovery: RunStartRecoveryAuthority = async input => {
    if (!workspaceStore) return undefined;
    const owner = await resolveLocalPrincipal(input.authorization, secrets, identityEpoch?.());
    if (!owner) return undefined;
    const existing = await workspaceStore.findRunByRequest(owner, input.projectId, owner, input.command.requestId);
    if (!existing) return undefined;
    if (existing.run.principalId !== owner || existing.run.projectId !== input.projectId
      || existing.run.planId !== input.command.planId || existing.run.planDigest !== input.command.planDigest) {
      return { kind: 'conflict', code: 'request_id_reused' };
    }
    if (input.conversationId !== undefined || input.conversationRequestId !== undefined) {
      if (!input.conversationId || !input.conversationRequestId) return { kind: 'conflict', code: 'conversation_admission_required' };
      const admission = await conversations.store.readRunAdmission(owner, input.conversationId, input.conversationRequestId);
      if (!admission || admission.projectId !== input.projectId || admission.runRequestId !== input.command.requestId
        || admission.planId !== input.command.planId || admission.planDigest !== input.command.planDigest) {
        return { kind: 'conflict', code: 'run_link_mismatch' };
      }
    }
    return { kind: 'recovery', evidence: { runId: existing.run.id } };
  };
  const workspaceAccessGuard = createWorkspaceAccessGuard(secrets, Date.now, runStartRecovery);
  app.use('/v1/workspace/*', async (c, next) => {
    const pathname = new URL(c.req.url).pathname;
    let context: WorkspaceAccessContext | undefined;
    if (c.req.method === 'POST' && runStartProjectFromPath(pathname) !== undefined) {
      const runStart = await readRunStartCommand(c.req.raw);
      if (runStart) context = {
        runStart,
        conversationId: c.req.header('x-uptokey-conversation-id'),
        conversationRequestId: c.req.header('x-uptokey-conversation-request-id')
      };
    }
    const denial = await workspaceAccessGuard(c.req.header('authorization'), c.req.method, pathname, context);
    if (denial) return c.json({ error: { type: denial.type } }, denial.status);
    await next();
  });
  const conversations = mountConversationRoutes(app, {
    secrets,
    budgets: governanceService,
    principal: (header) => resolveLocalPrincipal(header, secrets, identityEpoch?.()),
    projectGrant: header => resolveLocalProjectGrant(header, secrets, identityEpoch?.()),
    retentionMode: header => resolveLocalRetentionMode(header, secrets),
    ready: combinedReady,
    // C28: run links and terminal states are verified against the workspace journal.
    ...(workspace ? {
      runAuthority: async (principalId: string, projectId: string, runId: string) => {
        const record=await workspace.store.readRun(principalId,projectId,runId);
        return record?{...record.run,receipts:record.receipts}:null;
      },
      runRequestAuthority: async (principalId: string, projectId: string, requestId: string) => (await workspace.store.findRunByRequest(principalId, projectId, principalId, requestId))?.run ?? null,
    } : {}),
  });
  conversationBudgetOwner=(principalId,projectId,runRequestId)=>conversations.store.conversationScopeForRunRequest(principalId,projectId,runRequestId);
  // Account sharing has its own explicit approval. It neither forwards a broker
  // credential nor grants access to the approving client's projects or folders.
  const accountOrigin=process.env.UPTOKEY_ACCOUNT_SERVICE_ORIGIN;
  let accountLogin:AccountLoginService|undefined;
  let accountShare:AccountShareService|undefined;
  const accountService=():AccountLoginService=>accountLogin??=new AccountLoginService({secrets,origin:accountOrigin,
    production:process.env.NODE_ENV==='production',fetcher:connectionServices?.fetchImpl,now:connectionServices?.now,
    sourceAuthorizer:(recipient,owner,ref):Promise<boolean>=>accountSharing().authorizes(recipient,owner,ref)});
  const accountSharing=():AccountShareService=>accountShare??=new AccountShareService(secrets,pairing,()=>identityEpoch?.(),
    (principal,signal,admit)=>accountService().available(principal,signal,admit),connectionServices?.now);
  const accountAdmission=async(authorization:string|undefined,signal:AbortSignal)=>{
    const authenticate=async()=>{
      if(identityEpochMismatch(config,identityEpoch?.()))throw new ContextLinkError('context_scope_denied',403);
      const client=await authenticateContextCredential(authorization,secrets);
      if(client.kind==='client'&&(!client.registration||!ACCOUNT_SHARE_AUDIENCES.has(client.registration.audience)||client.policy?.retentionMode==='ephemeral'))
        throw new ContextLinkError('context_scope_denied',403);
      const epoch=identityEpoch?.(),principal=rawCredentialPrincipal(epoch,client);
      return {principal,stamp:createHash('sha256').update(JSON.stringify([authorization,principal,client.policy??null,client.registration??null,epoch??null])).digest('hex')};
    };
    const admitted=await authenticate(),admit=async()=>{
      if(signal.aborted)throw Error('account_cancelled');
      if((await authenticate()).stamp!==admitted.stamp)throw new ContextLinkError('context_scope_denied',403);
    };
    return {...admitted,admit};
  };
  for(const action of ['capability','status','usage','available','requests','login','logout','request','adopt','unlink','approve','consume','control'] as const){
    const handler=async(c:Context)=>{
      await combinedReady;
      const admitted=await accountAdmission(c.req.header('authorization'),c.req.raw.signal),admit=admitted.admit;
      if(!pairingRateLimiter.take(`account-${action}:${admitted.principal}`,20,60_000).ok)return c.json({error:{type:'local_auth_rate_limited'}},429);
      let input:Record<string,unknown>={};
      if(ACCOUNT_POST_ACTIONS.has(action)){
        const parsed=await readBoundedJson(c.req.raw,MAX_LOCAL_CONTROL_REQUEST_BYTES);
        const keys=action==='adopt'?['accountRef','expectedRevision']:action==='unlink'?['expectedRevision']:action==='approve'?['id','userCode','accountRef']:action==='consume'?['id']:[];
        if(!parsed.ok||action!=='control'&&!hasExactKeys(parsed.value,keys))return c.json({error:{type:'account_request_invalid'}},400);
        input=parsed.value as Record<string,unknown>;
        if(action==='control')try{const request=readAccountControlRequest(input);input={operation:request.operation,payload:request.payload};}catch{return c.json({error:{type:'account_request_invalid'}},400);}
        if(('expectedRevision' in input&&(!Number.isSafeInteger(input.expectedRevision)||(input.expectedRevision as number)<0))||
          ('accountRef' in input&&(typeof input.accountRef!=='string'||!/^acc_[a-f0-9]{64}$/.test(input.accountRef)))||
          ('id' in input&&(typeof input.id!=='string'||!/^[a-f0-9-]{36}$/i.test(input.id)))||
          ('userCode' in input&&(typeof input.userCode!=='string'||!/^[A-F0-9]{8}$/.test(input.userCode))))return c.json({error:{type:'account_request_invalid'}},400);
      }
      try{
        await admit();const service=accountService();
        const value=action==='capability'?service.capability():
          action==='control'?await service.control(admitted.principal,input as never,c.req.raw.signal,admit):
          action==='adopt'?await service.adopt(admitted.principal,input as {accountRef:string;expectedRevision:number},c.req.raw.signal,admit):
          action==='unlink'?await service.unlink(admitted.principal,input as {expectedRevision:number},admit):
          action==='request'?await accountSharing().request(c.req.header('authorization')):
          action==='requests'?await accountSharing().requests(c.req.header('authorization'),c.req.raw.signal,admit):
          action==='approve'?await accountSharing().approve(c.req.header('authorization'),input as {id:string;userCode:string;accountRef:string},c.req.raw.signal,admit):
          action==='consume'?await accountSharing().consume(c.req.header('authorization'),input.id as string,c.req.raw.signal,admit):
          await service[action](admitted.principal,c.req.raw.signal,admit);
        await admit();if(action==='control'){const result=value as {status:number;body:unknown};return c.json(result.body,result.status as never);}return c.json(value);
      }catch(error){
        if(error instanceof ContextLinkError||error instanceof ClientRegistrationError)throw error;
        if(error instanceof AccountShareError)return c.json({error:{type:error.code}},error.status);
        const code=error instanceof Error?error.message:'';
        if(['account_service_not_configured','account_service_unavailable','account_session_expiry_unavailable'].includes(code))return c.json({error:{type:code}},503);
        if(code==='account_cancelled')return c.json({error:{type:code}},409);
        if(['account_proof_invalid','account_proof_replayed','account_device_session_required'].includes(code))return c.json({error:{type:code}},403);
        if(code==='account_reauthentication_required')return c.json({error:{type:code}},401);
        if(['account_challenge_consumed','account_challenge_pending','account_share_pending'].includes(code))return c.json({error:{type:code}},409);
        if(code==='account_share_conflict')return c.json({error:{type:code}},409);
        if(code==='account_share_denied')return c.json({error:{type:code}},403);
        if(['account_broker_busy','account_broker_capacity','account_store_full','pairing_capacity_exceeded'].includes(code))return c.json({error:{type:code}},429);
        if(['account_client_invalid','account_request_invalid','account_response_invalid','account_store_invalid','account_service_origin_invalid'].includes(code))return c.json({error:{type:code}},400);
        return c.json({error:{type:'account_service_unavailable'}},503);
      }
    };
    if(ACCOUNT_POST_ACTIONS.has(action))app.post(`/local/account/${action}`,handler);else app.get(`/local/account/${action}`,handler);
  }
  const contextLinks = new ClientContextLinkService(secrets,pairing,()=>identityEpoch?.(),
    (owner,id)=>conversations.store.getConversation(owner,id),
    async(owner,id)=>{
      if (!workspaceStore) throw new ContextLinkError('context_not_owned',404);
      await workspaceStore.getProject(owner,id);
    });
  app.get('/local/workspace/session/context',async c=>c.json(await contextLinks.status(c.req.header('authorization'))));
  app.get('/local/workspace/session/context/owned',async c=>{
    await combinedReady;
    const client = await authenticateContextCredential(c.req.header('authorization'),secrets);
    if (client.kind === 'client' && (!client.registration || !['pwa','tauri','tui'].includes(client.registration.audience) || client.policy?.retentionMode === 'ephemeral'))
      return c.json({error:{type:'context_scope_denied'}},403);
    const owner = rawCredentialPrincipal(identityEpoch?.(),client);
    const page = await conversations.store.listConversations(owner,{limit:50},credentialProjectGrant(client));
    const contexts = page.conversations.filter(item=>item.projectId !== null).map(({id,title,revision,projectId})=>({id,title,revision,projectId}));
    // Revalidate the approving credential after storage awaits, without mapping a
    // linked recipient to another owner's context or forwarding its authority.
    const current = await authenticateContextCredential(c.req.header('authorization'),secrets);
    if (rawCredentialPrincipal(identityEpoch?.(),current) !== owner || current.policy?.revision !== client.policy?.revision ||
      current.registration?.policyRevision !== client.registration?.policyRevision) throw new ContextLinkError('context_link_invalid');
    return c.json({contexts});
  });
  for (const action of ['challenge','approve','consume','revoke'] as const) app.post(`/local/workspace/session/context/${action}`,async c=>{
    await combinedReady;
    await authenticateContextCredential(c.req.header('authorization'),secrets);
    if (!pairingRateLimiter.take(`workspace-context-${action}`,20,60_000).ok) return c.json({error:{type:'local_auth_rate_limited'}},429);
    const parsed = await readBoundedJson(c.req.raw,MAX_LOCAL_CONTROL_REQUEST_BYTES);
    const invalid = ()=>c.json({error:{type:'context_link_invalid_request'}},400);
    if (!parsed.ok) return invalid();
    const body = parsed.value, header = c.req.header('authorization');
    if (action === 'challenge') {
      if (!hasExactKeys(body,[])) return invalid();
      try { return c.json(await contextLinks.challenge(header)); }
      catch(error) {if(error instanceof Error && error.message === 'pairing_capacity_exceeded')return c.json({error:{type:'local_auth_rate_limited'}},429);throw error;}
    }
    if (action === 'approve') {
      if (!hasExactKeys(body,['id','userCode','conversationId','expectedRevision']) || !isUuidV4(body.id) ||
        typeof body.conversationId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.conversationId) ||
        typeof body.userCode !== 'string' || !/^[A-Fa-f0-9]{8}$/.test(body.userCode) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<1) return invalid();
      return c.json(await contextLinks.approve(header,body as {id:string;userCode:string;conversationId:string;expectedRevision:number}));
    }
    if (action === 'consume') {
      if (!hasExactKeys(body,['id']) || !isUuidV4(body.id)) return invalid();
      return c.json(await contextLinks.consume(header,body.id));
    }
    if (!hasExactKeys(body,['expectedRevision']) || !Number.isSafeInteger(body.expectedRevision) || Number(body.expectedRevision)<1) return invalid();
    return c.json(await contextLinks.revoke(header,body.expectedRevision as number));
  });
  // E2-23: settings/preferences/privacy jobs (module-owned; does not alter W5 runtime).
  const settings = mountSettingsRoutes(app, {
    secrets,
    principal: (header: string | undefined) => resolveLocalPrincipal(header, secrets, identityEpoch?.()),
    ready: combinedReady,
    authorizePrivacy: async (header:string|undefined, owner:string, kind:string, request:{kind?:string;conversationId?:string;targetClass?:string;targetId?:string},job?:{id?:string;result?:{artifact?:{items?:unknown[]}}|null},authority?:PrivacyJobAuthority):Promise<PrivacyJobAuthority|undefined> => {
      const retention=await resolveLocalRetentionMode(header,secrets);
      if(retention===undefined)throw new WorkspaceError('settings_unauthorized',403);
      if(retention==='ephemeral')throw new WorkspaceError('ephemeral_mode_persistence_blocked',403);
      const provenance=async (operation:string,value:typeof request,depth=0,stored=job):Promise<PrivacyJobAuthority|undefined>=>{
        if(depth>1)throw new WorkspaceError('resource_not_granted',403);
        if(stored?.id){
          const saved=settings.store.getJobAuthority(owner,stored.id);
          if(saved)return saved;
        }
        if(operation==='export'){
          const derived=exportPrivacyAuthority(value,stored?.result);
          if(derived)return derived;
          if(value.kind==='receipts')return undefined;
          // An old expired job with no provenance is not authorized by a newly
          // chosen project. Unrestricted owners can still remove that old job.
          if(stored)return undefined;
        }
        if(operation==='export'&&value.kind==='conversations'||operation==='purge'&&value.targetClass==='conversation'){
          const conversation=await conversations.store.getConversation(owner,(operation==='export'?value.conversationId:value.targetId)!);
          return {version:1,projectIds:[conversation.projectId]};
        }else if(operation==='purge'&&['artifact','local_receipts'].includes(value.targetClass??'')){
          const projectId=value.targetId?.split('/')[0];
          if(projectId)return {version:1,projectIds:[projectId]};
        }else if(operation==='purge'&&value.targetClass==='export_bundle'){
          const exported=settings.store.getJob(owner,value.targetId);
          if(exported.kind==='export')return provenance(exported.kind,exported.request,depth+1,exported);
        }
        throw new WorkspaceError('resource_not_granted',403);
      };
      const scope=authority??await provenance(kind,request);
      // Resolve again after all storage awaits, including from the owner's
      // serialized mutation callback; the entry-route grant is not a lease.
      const projects=await resolveLocalProjectGrant(header,secrets,identityEpoch?.());
      if(projects===undefined)throw new WorkspaceError('settings_unauthorized',403);
      const pendingReceipts=kind==='export'&&request.kind==='receipts'&&job===undefined&&authority===undefined;
      if(projects!=='*'&&!pendingReceipts&&(!scope||!scope.projectIds.every(id=>isProjectGranted(projects,id))))throw new WorkspaceError('resource_not_granted',403);
      return scope;
    },
    conversationExporter: async (principalId: string, conversationId: string) => {
      try { return await conversations.store.exportConversation(principalId, conversationId); }
      catch { return null; }
    },
    ...(workspaceStore?{resourceLister:async(principal:string,header:string|undefined)=>{
      const projects=await resolveLocalProjectGrant(header,secrets,identityEpoch?.());
      if(projects===undefined)throw new WorkspaceError('settings_unauthorized',403);
      return workspaceStore.listPrivacyResources(principal,projects);
    },receiptsExporter:async(principal:string,includeContent:boolean,header:string|undefined)=>{
      const projects=await resolveLocalProjectGrant(header,secrets,identityEpoch?.());
      if(projects===undefined)throw new WorkspaceError('settings_unauthorized',403);
      return workspaceStore.exportPrivacyReceipts(principal,includeContent,projects);
    },artifactDeleter:(principal:string,id:string,revalidate:()=>Promise<void>)=>workspaceStore.purgePrivacyResource(principal,'artifact',id,revalidate),receiptDeleter:(principal:string,id:string,revalidate:()=>Promise<void>)=>workspaceStore.purgePrivacyResource(principal,'local_receipts',id,revalidate)}:{}),
    conversationDeleter: async (principalId: string, conversationId: string,revalidate:()=>Promise<void>) => {
      try {
        const doc = await conversations.store.getConversation(principalId, conversationId);
        if (!doc) return false;
        const result = await conversations.store.deleteConversation(principalId, conversationId, doc.revision,revalidate);
        return result.deleted === true;
      } catch(error) { if(error instanceof WorkspaceError)throw error;return false; }
    },
  });
  // E2-13: automações com persistência durável e hooks de plano/execução governados
  automationService = new AutomationService({
    root: resolveAutomationRoot(),
    delivery: automationDelivery,
    ...(workspace ? {
      hooks: createWorkspaceAutomationHooks(workspace, id => automationService.conversations.getConversation(id)),
      // Cadeias usam o executor W5 existente: cada passo revalida principal,
      // projeto, revogação e autorização recorrente antes de qualquer efeito.
      chainEffects: createWorkspaceChainEffects(workspace, {
        grants: () => automationService?.grants,
        active: principal => isLocalPrincipalActive(principal, secrets, identityEpoch?.()),
        scheduleEnabled: scheduleId => automationService?.scheduler.getSchedule(scheduleId)?.enabled === true,
      }),
      prepareChannel: (principal,projectId,input) => workspace.prepareAutomationChannelPlan(principal,projectId,input),
      prepareScheduleGrant:async(principal,projectId,input)=>{
        if(!input||typeof input!=='object'||Object.keys(input).sort().join(',')!=='expiresAt,maxOccurrences,scheduleId')throw Error('schedule_scope_invalid');
        const values=input as {scheduleId:string;maxOccurrences:number;expiresAt:string};
        const schedule=automationService.scheduler.getSchedule(values.scheduleId);
        if(!schedule||schedule.principalId!==principal||schedule.projectId!==projectId)throw Error('schedule_missing');
        const preset=automationService.presets.get(principal,projectId,schedule.presetId,schedule.presetVersion);
        if(!preset)throw Error('preset_missing');
        const prepared=await prepareScheduledPreset(workspace,{id:'authorization_template',scheduleId:schedule.id,occurrenceKey:'',scheduledAt:new Date().toISOString(),status:'scheduled'},schedule,preset);
        const plan=await automationService.grants.prepare(workspace.store,principal,projectId,{...values,templatePlanId:prepared.planIds[0]},new AbortController().signal);
        return workspace.viewPlan(principal,projectId,plan.id);
      },
      prepareScheduled:async(occurrence,schedule,preset)=>{
        const prepared=await prepareScheduledPreset(workspace,occurrence,schedule,preset);
        if(!automationService.grants.list(schedule.principalId,schedule.projectId).some(grant=>grant.scheduleId===schedule.id&&!grant.revokedAt))return prepared;
        const plan=await workspace.store.getPlan(schedule.principalId,schedule.projectId,prepared.planIds[0]!);if(!plan)throw Error('plan_missing');
        const authority=await automationService.grants.authorizeOccurrence(workspace.store,schedule.principalId,schedule.projectId,schedule.id,occurrence.occurrenceKey,plan);
        const executed=await workspace.startScheduledRun(authority);if(!executed.run)throw Error('schedule_run_missing');
        automationService.grants.linkRun(schedule.principalId,schedule.projectId,authority.grantId,occurrence.occurrenceKey,executed.run.id);
        return {...prepared,runRefs:[{planId:plan.id,runId:executed.run.id,grantId:authority.grantId,requestId:authority.requestId}]};
      },
    } : {}),
  });
  let schedulerRunning:Promise<unknown>|null = null;
  const automationTimer = workspace ? setInterval(() => {
    if (schedulerRunning) return;
    // Boot/periodic recovery of chains resumes only pending/compensating work;
    // dispatched/unknown steps stay needs_attention and are never replayed here.
    schedulerRunning = combinedReady
      .then(async () => { await automationService.recoverChains().catch(() => undefined); await automationService.runScheduler(); })
      .catch(() => undefined).finally(() => { schedulerRunning = null; });
  }, 30_000) : undefined;
  automationTimer?.unref();
  if (workspace) void combinedReady.then(() => automationService.recoverChains()).catch(() => undefined);
  bindAutomationService(automationService);
  bindAgentsCliReady();
  mountDelegatedRoutes(app,delegatedKeys,combinedReady,header=>resolveLocalPrincipal(header,secrets,identityEpoch?.()));
  // Consent key resolution: browser origins keep the Origin gate; native clients
  // (e.g. VS Code) present no Origin and resolve the key enrolled at pairing time.
  // In both cases consent additionally requires the per-plan signature; a stolen
  // bearer without the enrolled private key cannot consent.
  mountWorkspaceRoutes(app, workspace, combinedReady, header=>resolveLocalPrincipal(header,secrets,identityEpoch?.()),(header,origin)=>origin!==undefined?(LOCAL_UI_ORIGINS.has(origin)||isExtensionOrigin(origin)?browserSessions.enrolledKey(header):Promise.resolve(undefined)):browserSessions.enrolledKey(header),automationService,secrets,
    (principalId,projectId,command,conversationId,requestId,authorization,contextRevision)=>{
      if(conversationId===undefined&&requestId===undefined&&contextRevision===undefined)return undefined;
      if((conversationId!==undefined||requestId!==undefined)&&(!conversationId||!requestId))throw new WorkspaceError('conversation_admission_required',400);
      const assertContext = async () => {
        if (contextRevision === undefined) return;
        const client = await authenticateContextCredential(authorization,secrets);
        const link = await resolveClientContextLink(secrets,client,identityEpoch?.());
        if (!link || link.revision !== contextRevision || link.ownerPrincipalId !== principalId || link.projectId !== projectId) throw new ContextLinkError('context_link_invalid');
      };
      const admission = async <T>(start:()=>Promise<T>):Promise<T> => {
        await assertContext();
        if (!conversationId || !requestId) return start();
        return conversations.store.withRunAdmission(principalId,conversationId,requestId,projectId,command,async()=>{
        const conversation = await conversations.store.getConversation(principalId,conversationId);
        if (conversation.storagePolicy === 'temporary' || conversation.processingPolicy === 'local_only') throw new WorkspaceError('conversation_policy_unsupported_for_workflow',403);
        const plan = await workspace!.store.getPlan(principalId,projectId,command.planId);
        if (!plan) throw new WorkspaceError('plan_missing',404);
        await governanceService?.reserveExecutionBudgets(principalId,projectId,command.requestId,plan,workspace!.registry().list(),
          {id:conversationId,temporary:false});
        // HTTP policy middleware ran before W5 verification and the runtime's
        // asynchronous preparation. Authority is re-read after those awaits
        // and budget reservation, immediately before admitting this run.
        const current = await conversations.store.getConversation(principalId,conversationId);
        if (current.storagePolicy === 'temporary' || current.processingPolicy === 'local_only') throw new WorkspaceError('conversation_policy_unsupported_for_workflow',403);
        if (current.activeBranchId !== conversation.activeBranchId || current.revision !== conversation.revision) throw new WorkspaceError('conversation_conflict',409);
        await assertContext();
        return start();
      });
      };
      return Object.assign(admission,{revalidate:assertContext});
    }, header=>resolveLocalProjectGrant(header,secrets,identityEpoch?.()),async(authorization,request,signal,operation)=>{
      try{
        const admitted=await accountAdmission(authorization,signal);
        if(!pairingRateLimiter.take(`account-mobility:${admitted.principal}`,20,60_000).ok)throw new WorkspaceError('local_auth_rate_limited',429);
        return await accountService().withMobilityCredential(admitted.principal,request,signal,operation,admitted.admit);
      }catch(error){
        if(error instanceof WorkspaceError)throw error;
        if(error instanceof ContextLinkError)throw error;
        if(error instanceof ClientRegistrationError)throw new WorkspaceError(error.message,403);
        const code=error instanceof Error?error.message:'';
        if(code==='account_reauthentication_required')throw Object.assign(Error(code),{status:401});
        if(['account_share_conflict','account_cancelled','account_share_pending'].includes(code))throw new WorkspaceError(code,409);
        if(['account_share_denied','account_proof_invalid','account_proof_replayed'].includes(code))throw new WorkspaceError(code,403);
        if(['account_broker_busy','account_broker_capacity'].includes(code))throw new WorkspaceError(code,429);
        throw new WorkspaceError(code==='account_service_not_configured'?code:'account_service_unavailable',503);
      }
    });
  mountGovernanceRoutes(app, governanceService, combinedReady, header=>resolveLocalPrincipal(header,secrets,identityEpoch?.()));
  if (workspace && governanceService) workspace.attachGovernanceService(governanceService);
  /**
   * V2: every executor consuming provider:custom (gateway, media, embeddings) admits through the
   * account ledger when the stored default profile declares a commercial account. The association
   * is read, never migrated or written, on the dispatch path. Without a token estimate the price is
   * unknown and a bound account refuses. Identity, tariff and observation are revalidated before sending.
   */
  async function customAccountAdmission(model:string, effect:{principalId:string;projectId:string;runId:string;attemptId:string;capability:{id:string}},
    usage:{input:number;output:number}|MediaBillingUsage|undefined, endpointUrl:string|undefined, signal:AbortSignal) {
    await combinedReady; signal.throwIfAborted();
    const profiles = connectionProfiles;
    if (!profiles) throw new Error('account_funding_unavailable');
    // This path consumes provider:custom, not the active multiconta profile.
    const profile = await profiles.get(defaultProfileId('custom'));
    signal.throwIfAborted();
    if (!profile?.commercialAccountId) return undefined;
    if (!governanceService) throw new Error('account_funding_unavailable');
    if (!usage) throw new Error('budget_cost_unknown');
    // F1: tokens and media units share one admission path and one ledger; only the price basis differs.
    const attemptFor = () => 'unit' in usage ? buildUnitBudgetAttempt(config,'custom',model,effect.attemptId,usage,accountId)
      : buildDispatchBudgetAttempt(config,'custom',model,effect.attemptId,usage,accountId);
    const accountId = profile.commercialAccountId;
    const assertProfile = async () => {
      const current = await profiles.get(profile.id);
      if (!current?.enabled || current.revision !== profile.revision || current.commercialAccountId !== accountId ||
        current.providerId !== 'custom' || endpointUrl && current.endpointUrl && current.endpointUrl !== endpointUrl) throw new Error('account_funding_changed');
      const legacy = await secrets.get('provider:custom');
      if (!legacy || await profiles.readCredential(current) !== legacy) throw new Error('account_funding_identity_invalid');
      signal.throwIfAborted();
    };
    await assertProfile();
    const attempt = attemptFor();
    const reservation = await governanceService.reserveAccountFunding(JSON.stringify([effect.capability.id,effect.principalId,effect.projectId,effect.runId]),attempt);
    if (!reservation) throw new Error('account_funding_unavailable');
    return {...reservation, validate:async()=>{
      await reservation.validate?.(); await assertProfile();
      const current=attemptFor();
      if (current.priceUsage(1000000,0)!==attempt.priceUsage(1000000,0) || current.priceUsage(0,1000000)!==attempt.priceUsage(0,1000000)) throw new Error('account_funding_changed');
    }};
  }
  // E2-02: conexões multicontas, testes em lote, OAuth oficial e instalações locais.
  {
    const profileService = new ConnectionProfileService(
      secrets,
      connectionProfilesStorage,
      {
        ...(connectionServices?.now ? { now: connectionServices.now } : {}),
        onDefaultRevoked: async (providerId) => {
          // Revogar o perfil default migrado desliga a credencial legada do roteador.
          await persistRuntimeConfig((next) => {
            const entry = (next.providers as Record<string, typeof next.providers.groq>)[providerId];
            if (entry) { entry.enabled = false; entry.configured = false; }
          });
          try { await secrets.delete(`provider:${providerId}`); } catch { /* revogação local primeiro */ }
          try { await router.invalidateProviderCache(providerId as ProviderName); } catch { /* cache ausente */ }
        },
      },
    );
    connectionProfiles = profileService;
    router.attachConnectionProfiles?.(profileService);
    workspaceGateway?.attachDispatchAuthority?.(async (wire, signal) => {
      await combinedReady; signal.throwIfAborted();
      if (!gatewayWireHasAudio(wire.body)) return;
      const profile = await profileService.get(defaultProfileId('custom'));
      signal.throwIfAborted();
      if (!(profile?.enabled && profile.audioInputModels?.includes(wire.model))) throw new Error('input_audio_undeclared');
      // Recheck binding here too: a newly bound account cannot bypass funding
      // while credential acquisition is awaiting the local vault.
      if (profile.commercialAccountId) throw new Error('budget_cost_unknown');
    });
    workspaceGateway?.attachAccountFunding?.(async (_chat, wire, effect, signal) => {
      await combinedReady; signal.throwIfAborted();
      // Association is read from the stored profile first: an unbound gateway never needs a token estimate.
      const profile = await profileService.get(defaultProfileId('custom'));
      signal.throwIfAborted();
      // Audio is a separately declared capability. Revalidate it on the
      // funding seam as well as the dispatch seam so withdrawing a declaration
      // after approval cannot be bypassed by a direct funding callback.
      if (gatewayWireHasAudio(wire.body)) {
        if (!(profile?.enabled && profile.audioInputModels?.includes(wire.model))) throw new Error('input_audio_undeclared');
        // Native audio token/cache usage has a different tariff basis; text/base64
        // estimates cannot authorize spending from a bound commercial account.
        if (profile.commercialAccountId) throw new Error('budget_cost_unknown');
        return;
      }
      if (!profile?.commercialAccountId) return;
      const request = JSON.parse(wire.body);
      const estimate = conservativeTokenEstimate(request);
      if (!estimate) throw new Error('budget_cost_unknown');
      const accounting = planAttemptAccounting(request, estimate);
      const measured = {input:Math.max(estimate.input, accounting.reservation.total-estimate.output), output:estimate.output};
      return customAccountAdmission(wire.model, effect, measured, wire.url, signal);
    });
    const oauthService = new OAuthConnectionService(secrets, [], connectionServices?.fetchImpl ?? fetch);
    connectionOAuth=oauthService;
    const testService = new ConnectionTestService(
      profileService,
      connectionServices?.testJobs ?? fileJobsStorage(),
      { ...(connectionServices?.fetchImpl ? { fetchImpl: connectionServices.fetchImpl } : {}), ...(connectionServices?.now ? { now: connectionServices.now } : {}) },
    );
    const installService = new ModelInstallJobService(
      connectionServices?.installJobs ?? fileInstallJobsStorage(),
      {
        ...(connectionServices?.now ? { now: connectionServices.now } : {}),
        ...(connectionServices?.installer ? { installer: connectionServices.installer } : {}),
        ...(config.providers.ollama?.endpointUrl ? { ollamaEndpointUrl: config.providers.ollama.endpointUrl } : {}),
      },
    );
    // Refresh explícito precisa do provedor mesmo após reinício (tentativas são efêmeras);
    // a reidratação a partir do registro persistido acontece no handler de refresh.
    registerConnectionRoutes(app, {
      profiles: profileService,
      ...(governanceService ? {funding:{
        get:async(providerId:string,accountId:string)=>{await combinedReady;return governanceService.getAccountFunding(providerId,accountId);},
        put:async(providerId:string,accountId:string,input:import('@uptokey/sync-contract/connections').AccountFundingObservationInput)=>{await combinedReady;return governanceService.putAccountFunding(providerId,accountId,input);},
      }} : {}),
      tests: testService,
      installs: installService,
      oauth: oauthService,
      secrets,
      getConfig: () => config,
      getAdmission: () => {
        try {
          const metrics = router.connectionMetrics() as { providers?: Array<{ id?: unknown; admission?: { eligible?: unknown; reason?: unknown } }> };
          const map = new Map<string, { eligible: boolean; reason: string | null }>();
          for (const provider of metrics.providers ?? []) {
            if (typeof provider?.id !== "string") continue;
            map.set(provider.id, {
              eligible: provider.admission?.eligible === true,
              reason: typeof provider.admission?.reason === "string" ? provider.admission.reason : null,
            });
          }
          return map;
        } catch {
          return null;
        }
      },
      auth: {
        canRead: async (c) => {
          const supplied = parseLocalBearer(c.req.header("authorization"));
          return Boolean(supplied && await hasValidLocalToken(supplied, secrets));
        },
        canMutate: async (c) => {
          const origin = c.req.header("origin");
          if (origin !== undefined && LOCAL_UI_ORIGINS.has(origin)) return true;
          const supplied = parseLocalBearer(c.req.header("authorization"));
          return Boolean(supplied && await hasValidLocalToken(supplied, secrets));
        },
      },
      checkRate: (key, limit, windowMs) => {
        const decision = pairingRateLimiter.take(key, limit, windowMs);
        return decision.ok ? { ok: true as const, retryAfter: 0 } : { ok: false as const, retryAfter: decision.retryAfter };
      },
      ...(connectionServices?.now ? { now: connectionServices.now } : {}),
    })

    const providerManagementAuthority = async (c: Context): Promise<string|null> => {
        if(identityEpochMismatch(config,identityEpoch?.()))return null;
        const header=c.req.header('authorization');
        if(!(await authorizeClientKeyManagement(c.req.header('origin'),header,secrets,authRateLimiter)).allowed)return null;
        const token=parseLocalBearer(header),resolved=await resolveBearer(secrets,token);
        if(!resolved.ok||resolved.resolved.delegation)return null;
        return createHash('sha256').update(JSON.stringify([token,resolved.resolved.policy??null,resolved.resolved.registration??null,identityEpoch?.()??null])).digest('hex');
    };
    const providerManagementRate = (key:string,limit:number,windowMs:number) => {const decision=pairingRateLimiter.take(key,limit,windowMs);return decision.ok?{ok:true,retryAfter:0}:decision;};
    registerProviderSetupRoutes(app, {
      secrets,profiles:profileService,getConfig:()=>config,persist:persistRuntimeConfig,
      invalidate:provider=>router.invalidateProviderCache(provider),fetchImpl:connectionServices?.fetchImpl,
      ...(connectionServices?.now?{now:connectionServices.now}:{}),
      checkRate:providerManagementRate,authority:providerManagementAuthority,
    });
    registerProviderCreditRoutes(app,{profiles:profileService,getConfig:()=>config,authority:providerManagementAuthority,checkRate:providerManagementRate,fetchImpl:connectionServices?.fetchImpl});
    if(config.efficiencyPolicy)setActiveEfficiencyPolicy(config.efficiencyPolicy);else ensureDefaultEfficiencyPolicy();
    registerEfficiencyRoutes(app, {
      requireLocalAuth: async (c, next) => {
        const header=c.req.header('authorization'),principal=await resolveLocalPrincipal(header,secrets,identityEpoch?.());
        if(!principal)return c.json({error:{type:'unauthorized'}},401);
        if(c.req.method!=='GET'&&!principal.endsWith('_admin')&&!await browserSessions.enrolledKey(header))return c.json({error:{type:'control_session_required'}},403);
        await next();
      },
      cacheSupport:{provenance:true,semantic:false,providerPrompt:true},
      getReadCacheMetrics:()=>workspace!.provenanceCacheInfo(),
      getProviderPromptMetrics:()=>router.providerPromptCacheMetrics(),
      persistPolicy:async policy=>{await router.invalidateExactCache();workspace!.invalidateProvenanceCache();await persistRuntimeConfig(next=>{next.efficiencyPolicy=policy;});},
      invalidateScoped:async scope=>{
        if(scope.tenantId!==undefined||scope.provider!==undefined&&!isProvider(scope.provider))return {ok:false,code:'cache_scope_denied',status:422};
        if(scope.kind==='provider')return {ok:false,code:'provider_cache_managed_externally',status:422};
        if(scope.kind==='semantic'||scope.kind==='provenance'){
          if(scope.provider!==undefined)return {ok:false,code:'cache_scope_denied',status:422};
          return {ok:true,invalidated:workspace!.invalidateProvenanceCache()};
        }
        await router.invalidateExactCache(scope.provider as ProviderName|undefined);
        return {ok:true,invalidated:null};
      },
      getMetrics: () => {
        const r = router as unknown as { efficiencyMetrics?: () => unknown; cacheMetrics?: () => unknown };
        if (typeof r.efficiencyMetrics === "function") return r.efficiencyMetrics();
        if (typeof r.cacheMetrics === "function") return { schemaVersion: 1, basis: "cacheMetrics", cache: r.cacheMetrics() };
        return { schemaVersion: 1, basis: "unavailable" };
      },
    });
;
  }
  let workspaceClosing: Promise<void> | undefined;
  const closeWorkspace = () => workspaceClosing ??= (async () => {
    if (automationTimer) clearInterval(automationTimer);
    await schedulerRunning;
    await managedRemoteAccess.close();
    await egressReady.catch(()=>undefined);
    try {
      try { await egressStore.close(); } finally { await egressPersistence.close(); }
    } finally {
      try {
        await workspace?.close();
      } finally {
        await governanceService?.close();
        await governanceStore?.close();
        conversations.close();
        settings.close();
        automationService.close();
      }
    }
  })();
  return Object.assign(app,{workspaceReady: combinedReady, closeWorkspace, governanceStore, governanceService, conversationStore: conversations.store});
}

/** E2-03: OpenAI chat chunk SSE -> legacy text_completion chunk SSE, com IDs e uso preservados. */
function openAiChatSseToTextCompletionSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  const MAX_BYTES = 16 * 1024 * 1024;
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let finished = false;
  let sawText = false;
  let metadata: { id: string; model: string; created: number } | undefined;
  let totalBytes = 0;
  const failClosed = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (closed) return;
    closed = true;
    try { controller.error(new Error("completions_sse_transform_failed")); } catch { /* already closed */ }
    void reader?.cancel().catch(() => undefined);
  };
  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      const parser = createParser({
        onEvent: ({ data }) => {
          if (closed) return;
          if (data === "[DONE]") {
            if (!finished) { failClosed(controller); return; }
            controller.enqueue(encoder.encode("data: [DONE]\n\n"));
            closed = true;
            try { controller.close(); } catch { /* already closed */ }
            void reader?.cancel().catch(() => undefined);
            return;
          }
          let parsed: Record<string, unknown>;
          try {
            const value: unknown = JSON.parse(data);
            if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("bad");
            parsed = value as Record<string, unknown>;
          } catch {
            failClosed(controller);
            return;
          }
          if (typeof parsed.id !== 'string' || !parsed.id || typeof parsed.model !== 'string' || !parsed.model ||
              !Number.isSafeInteger(parsed.created) || Number(parsed.created) < 0 || !Array.isArray(parsed.choices) ||
              (parsed.system_fingerprint != null && typeof parsed.system_fingerprint !== 'string')) {
            failClosed(controller); return;
          }
          if (parsed.usage != null && !isTextCompletionUsage(parsed.usage)) { failClosed(controller); return; }
          const observed = { id: parsed.id, model: parsed.model, created: parsed.created as number };
          if (metadata && (metadata.id !== observed.id || metadata.model !== observed.model || metadata.created !== observed.created)) {
            failClosed(controller); return;
          }
          metadata ??= observed;
          const choices = parsed.choices;
          const usageOnly = choices.length === 0 && finished && parsed.usage && typeof parsed.usage === 'object' && !Array.isArray(parsed.usage);
          if (!usageOnly && (finished || choices.length !== 1)) { failClosed(controller); return; }
          const first = (choices[0] && typeof choices[0] === "object" ? choices[0] : undefined) as Record<string, unknown> | undefined;
          const delta = (first?.delta && typeof first.delta === "object" ? first.delta : undefined) as Record<string, unknown> | undefined;
          if (!usageOnly && (!first || Array.isArray(first) || (first.index !== undefined && first.index !== 0) || !delta || Array.isArray(delta) ||
              (delta.content != null && typeof delta.content !== 'string') || (delta.role !== undefined && delta.role !== 'assistant') ||
              delta.function_call != null || (delta.tool_calls != null && (!Array.isArray(delta.tool_calls) || delta.tool_calls.length > 0)) ||
              (delta.refusal != null && delta.refusal !== '') ||
              (first.finish_reason != null && !['stop', 'length', 'content_filter'].includes(first.finish_reason as string)))) {
            failClosed(controller); return;
          }
          const text = typeof delta?.content === "string" ? delta.content : "";
          const finish = typeof first?.finish_reason === "string" ? first.finish_reason : null;
          if (typeof delta?.content === 'string') sawText = true;
          if (finish && !sawText) { failClosed(controller); return; }
          const chunk: Record<string, unknown> = {
            id: metadata.id.replace(/^chatcmpl[-_]?/, "cmpl-"),
            object: "text_completion",
            created: metadata.created,
            model: metadata.model,
            ...(parsed.system_fingerprint !== undefined ? { system_fingerprint: parsed.system_fingerprint } : {}),
            choices: usageOnly ? [] : [{ text, index: 0, finish_reason: finish }],
          };
          if (parsed.usage !== undefined && parsed.usage !== null) chunk.usage = parsed.usage;
          totalBytes += JSON.stringify(chunk).length;
          if (totalBytes > MAX_BYTES) {
            failClosed(controller);
            return;
          }
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
          if (finish) {
            finished = true;
          }
        },
        onError: () => failClosed(controller),
      });
      const pump = async () => {
        try {
          for (;;) {
            if (closed) return;
            const part = await reader!.read();
            if (part.done) {
              failClosed(controller);
              return;
            }
            if (!part.value?.byteLength) continue;
            totalBytes += part.value.byteLength;
            if (totalBytes > MAX_BYTES) {
              failClosed(controller);
              return;
            }
            parser.feed(decoder.decode(part.value, { stream: true }));
          }
        } catch {
          failClosed(controller);
        }
      };
      void pump();
    },
    cancel(reason) {
      closed = true;
      void reader?.cancel(reason).catch(() => undefined);
    },
  });
}

function localModelsProjection(config: ProxyConfig) {  const models = [
    {
      id: "auto",
      object: "model" as const,
      created: 1700000000,
      owned_by: "uptokey",
      permission: [],
      root: "uptokey-auto",
      parent: null,
      context_window: 128_000
    },
    {
      id: "uptokey-auto",
      object: "model" as const,
      created: 1700000000,
      owned_by: "uptokey",
      permission: [],
      root: "uptokey-auto",
      parent: null,
      context_window: 128_000
    },
    {
      id: "uptokey-fast",
      object: "model" as const,
      created: 1700000000,
      owned_by: "uptokey",
      permission: [],
      root: "uptokey-fast",
      parent: null,
      context_window: 128_000
    },
    {
      id: "uptokey-coder",
      object: "model" as const,
      created: 1700000000,
      owned_by: "uptokey",
      permission: [],
      root: "uptokey-coder",
      parent: null,
      context_window: 128_000
    }
  ];

  for (const provider of Object.keys(config.providers).filter(isProvider)) {
    const item = config.providers[provider];
    if (item?.enabled && item.configured && item.models) {
      for (const modelId of item.models) {
        if (!models.some((existing) => existing.id === modelId)) {
          models.push({
            id: modelId,
            object: "model" as const,
            created: 1700000000,
            owned_by: item.name,
            permission: [],
            root: modelId,
            parent: null,
            context_window: MODEL_CONTEXT_LIMITS[modelId] ?? DEFAULT_FALLBACK_CONTEXT_LIMIT
          });
        }
      }
    }
  }

  for (const aliasId of LOCAL_VIRTUAL_ALIAS_IDS.filter((id) => id.startsWith("@"))) {
    if (!models.some((existing) => existing.id === aliasId)) {
      models.push({
        id: aliasId,
        object: "model" as const,
        created: 1700000000,
        owned_by: "uptokey-local",
        permission: [],
        root: aliasId,
        parent: null,
        context_window: DEFAULT_FALLBACK_CONTEXT_LIMIT
      });
    }
  }

  return {
    object: "list" as const,
    data: models
  };
}

function localStatusProjection(config: ProxyConfig, router: Router, identity: Pick<ControlIdentity, "tenantId" | "deviceId"> | undefined) {
  const configEpochPending = identityEpochMismatch(config, identity);
  const geminiPrivacyNoticePending = !configEpochPending && config.providers.gemini.enabled && config.providers.gemini.configured && !geminiPrivacyAccepted(config.providers.gemini.privacyAcceptedAt, config.providers.gemini.privacyNoticeVersion);
  const admission = typeof router.connectionMetrics === "function"
    ? new Map(router.connectionMetrics().providers.map(provider => [provider.id, provider.admission.eligible])) : null;
  const available = config.fallbackOrder.map((provider) => {
    const item = config.providers[provider];
    return !configEpochPending && item?.enabled === true && item.configured === true && (provider !== "gemini" || !geminiPrivacyNoticePending) && (!isNamedExperimentalProvider(provider) || namedProviderRiskAccepted(provider, item)) && (admission === null || admission.get(provider) === true);
  });

  const failover = typeof router.failoverMetrics === "function" ? router.failoverMetrics() : { budgetMs: 500 as const, lastOverheadMs: null, maxOverheadMs: null, budgetExceededCount: 0 };
  const cache = typeof router.cacheMetrics === "function" ? router.cacheMetrics() : { exactHits: 0, exactMisses: 0, exactWrites: 0, estimatedNetworkCallsAvoided: 0 };
  const context = typeof router.contextMetrics === "function" ? router.contextMetrics() : { cpiPercent: 100, totalSwitches: 0, activeSessions: 0 };
  return {
    status: "ok" as const,
    version: RELEASE_VERSION,
    nextProvider: config.fallbackOrder.find((_provider, index) => available[index]) ?? null,
    routing: configEpochPending ? [] : [...config.fallbackOrder],
    geminiPrivacyNoticePending,
    configEpochPending,
    failover,
    cache,
    context,
    autoRouting: true
  };
}

function identityEpochMismatch(config: ProxyConfig, identity: Pick<ControlIdentity, "tenantId" | "deviceId"> | undefined): boolean {
  return Boolean(identity && (
    config.appliedConfigTenantId !== undefined && (config.appliedConfigTenantId !== identity.tenantId || config.appliedConfigDeviceId !== identity.deviceId)
    || config.lastControlPlaneContactTenantId !== undefined && (config.lastControlPlaneContactTenantId !== identity.tenantId || config.lastControlPlaneContactDeviceId !== identity.deviceId)
  ));
}

async function hasAdministrativeToken(header: string | undefined, secrets: SecretStore): Promise<boolean> {
  const supplied = parseLocalBearer(header);
  if (!supplied || !isAdministrativeToken(supplied)) return false;
  const expected = await secrets.get("local:api-token");
  return Boolean(expected && isAdministrativeToken(expected) && timingSafeStringEqual(supplied, expected));
}

async function administrativeAuth(header: string | undefined, secrets: SecretStore, limiter: LocalAuthRateLimiter): Promise<{ allowed: true } | { allowed: false; rateLimited: boolean; retryAfterSeconds: number }> {
  if (await hasAdministrativeToken(header, secrets)) return { allowed: true };
  const rate = limiter.recordFailure(); return { allowed: false, rateLimited: !rate.allowed, retryAfterSeconds: rate.retryAfterSeconds ?? 1 };
}

async function authorizeProviderMutation(origin: string | undefined, authorization: string | undefined, secrets: SecretStore, limiter: LocalAuthRateLimiter): Promise<{ allowed: true } | { allowed: false; rateLimited: boolean; retryAfterSeconds: number }> {
  return authorizeClientKeyManagement(origin, authorization, secrets, limiter);
}

async function hasValidLocalToken(supplied: string, secrets: SecretStore): Promise<boolean> {
  const result = await resolveBearer(secrets, supplied);
  return result.ok && !result.resolved.delegation;
}

/** Preserve the existing local PWA management surface using its actual enrollment.
 * Origin alone is never authority. Scoped/public-device clients cannot turn their
 * own policy into an administrator or mint an unrestricted credential here.
 * Provider configuration and OpenRouter management use this same authority;
 * standalone, delegated, ephemeral and narrowed clients do not inherit it.
 */
async function authorizeClientKeyManagement(origin: string | undefined, authorization: string | undefined, secrets: SecretStore, limiter: LocalAuthRateLimiter): Promise<{ allowed: true } | { allowed: false; rateLimited: boolean; retryAfterSeconds: number }> {
  if (await hasAdministrativeToken(authorization, secrets)) return {allowed:true};
  if (origin !== undefined && LOCAL_UI_ORIGINS.has(origin)) {
    const token=parseLocalBearer(authorization);
    const clientId=token ? /^utk_local_([0-9a-f-]{36})\./i.exec(token)?.[1] : undefined;
    if (clientId) {
      try {
        const registration=await readClientRegistration(secrets,clientId);
        const authenticated=await resolveBearer(secrets,token);
        if (authenticated.ok && authenticated.resolved.kind==='client' && !authenticated.resolved.delegation) {
          const policy=authenticated.resolved.policy;
          if (registration?.audience==='pwa' && registration.enrolledVia==='browser-session' && registration.projects==='*'
            && policy && policy.retentionMode!=='ephemeral' && policy.expiresAt===null
            && policy.projectIds.length===0 && policy.providerIds.length===0 && policy.modelIds.length===0
            && (!policy.limits || Object.keys(policy.limits).length===0)
            && CLIENT_KEY_SCOPES.every(scope=>policy.scopes.includes(scope))) return {allowed:true};
        }
      } catch { /* Invalid enrollment/policy never grants local management. */ }
    }
  }
  return administrativeAuth(authorization,secrets,limiter);
}

async function hasClientToken(clientId: string, supplied: string, secrets: SecretStore): Promise<boolean> {
  if (!isUuidV4(clientId)) return false;
  const result = await resolveBearer(secrets, supplied);
  return result.ok && result.resolved.kind === 'client' && result.resolved.clientId === clientId && !result.resolved.delegation;
}

export async function ensureLocalToken(secrets: SecretStore): Promise<string> {
  const existing = await secrets.get("local:api-token");
  if (existing) {
    if (!isAdministrativeToken(existing)) throw new Error("local_admin_token_invalid");
    return existing;
  }
  const token = `utk_local_${randomBytes(24).toString("base64url")}`;
  await secrets.set("local:api-token", token);
  return token;
}

function hasExactKeys<K extends string>(value: unknown, expected: readonly K[]): value is Record<K, unknown> {
  if (!isJsonObject(value)) return false;
  const keys = Object.keys(value);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}
function isUuidV4(value: unknown): value is string { return typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value); }
function isAdministrativeToken(value: string): boolean { return /^utk_local_[A-Za-z0-9_-]{32}$/.test(value); }
function parseLocalBearer(header: string | undefined): string | undefined {
  const match = typeof header === "string" ? /^Bearer (utk_local_[A-Za-z0-9_.-]+)$/i.exec(header) : undefined;
  if (!match?.[1]) return undefined;
  const token = match[1];
  return isAdministrativeToken(token) || /^utk_local_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\.[A-Za-z0-9_-]{32}$/i.test(token) ? token : undefined;
}
