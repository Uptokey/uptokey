import { randomUUID } from "node:crypto";
import type { DispatchBudgetAttempt, DispatchBudgetReservation, CandidatePricingEvidence } from './types.ts';
import type { ChatCompletionRequest, DispatchContext, DispatchOptions, ProviderAdapter, ProviderConfig, ProviderName, ProxyConfig, RetentionEvidence, RoutingMode, TariffSnapshotEntry } from "./types.ts";
import type { SecretStore } from "./secret-store.ts";
import { QuotaLedger, type Reservation } from "./quota-ledger.ts";
import type { TelemetrySink } from "./telemetry.ts";
import { hasForbiddenInferenceCredentialField, projectInferenceRequest } from "./inference-request-policy.ts";
import { geminiPrivacyAccepted } from "./privacy.ts";
import { exactCacheEligibility, type ExactMatchCache, type ExactCacheLookup } from "./exact-match-cache.ts";
import { EfficiencyRecorder, type EfficiencyMetrics } from "./efficiency-metrics.ts";
import { liveEfficiencyGuards } from './efficiency-policy.ts';
import { getActiveEfficiencyPolicy } from './workspace/efficiency-pipeline.ts';
import { conservativeTokenEstimate, planAttemptAccounting, type AttemptAccounting, type ReportedObservation } from "./token-estimate.ts";
import { cancelStream, cancelStreamWithin } from "./stream-lifecycle.ts";
import { ContextGuard } from "./context-guard.ts";
import { optionalProviderAllowsKeyless } from "./provider-profile.ts";
import { ALL_PROVIDERS, isNamedExperimentalProvider, isProvider, isOptionalProvider, isUserDefinedProvider } from "./provider-registry.ts";
import { GenericOpenAIAdapter } from "./adapters.ts";
import { chatCompletionToAnthropicRequest } from "./anthropic-messages.ts";
import { isLocalEndpointUrl } from "./endpoint-policy.ts";
import { namedProviderRiskAccepted } from "./provider-risk.ts";
import { UsageMeter, type CacheUsage, type ReportedTokenUsage, type UsageMetrics, type UsageObservation, type UsageObserver } from "./usage-meter.ts";
import { TokenCalibration } from "./token-calibration.ts";
import { describeTokenizerCapabilities, listTokenizerCatalog, measureRequestTokens, tokenMetricsSnapshot, tokenizerArtifactProfile } from "./token-catalog.ts";
import { connectionStatus, quotaEarlyWarning } from "./connection-status.ts";
import { ProviderRejections } from "./provider-rejections.ts";
import { isVirtualModel, resolveAutoProviderOrder } from "./auto-route.ts";
import { localAliasProviderOrder, preferLocalRuntimesOrder, resolveLocalModelAlias } from "./local-model-aliases.ts";
import { classifyDispatchError, classifyHttpStatus } from "./error-classification.ts";
import { CircuitBreakerRegistry } from "./circuit-breaker.ts";
import { ProviderHealthTracker } from "./provider-health.ts";
import { emptyOutcome, resolveResiliencePolicy, type AttemptRecord, type ResilienceOutcome, type ResiliencePolicy } from "./resilience-policy.ts";
import { scrubText } from "./scrub.ts";
import { projectDataArray } from "@uptokey/sync-contract/plain-data";
import { DECLARED_CAPABILITY_FIELDS, REQUIRED_CAPABILITIES, type RequiredCapability } from "@uptokey/sync-contract/connections";
import { resolveRoutingComboDecision, type RoutingCandidate } from "./routing-combo.ts";
import { buildCatalogConnectionProjection } from "./catalog-projection.ts";
import { RoundRobinCursorRegistry } from "./round-robin-cursor.ts";
import { ProviderPerformanceTracker, type ProviderPerformanceSnapshot } from "./provider-performance.ts";
import type { EgressStore } from "./egress/store.ts";
import type { StoredProfile } from "./connection-profiles.ts";

type DispatchAuthorizationReason = "account_revoked" | "credential_revoked" | "account_unavailable";

class DispatchAuthorizationError extends Error {
  readonly reason: DispatchAuthorizationReason;
  readonly explicit: boolean;
  constructor(reason: DispatchAuthorizationReason, explicit: boolean) {
    super(reason);
    this.name = "DispatchAuthorizationError";
    this.reason = reason;
    this.explicit = explicit;
  }
}

type DispatchIdentity =
  | { kind: "profile-key"; profileId: string; explicit: boolean; model: string; endpoint: string }
  | { kind: "profile-keyless"; profileId: string; explicit: boolean; model: string; endpoint: string }
  | { kind: "legacy-key" }
  | { kind: "keyless" };

interface BudgetReservationRef {
  current: Reservation;
  budget?: DispatchBudgetReservation;
  reserveBudget?: (id: string) => Promise<DispatchBudgetReservation | undefined>;
  validatePolicy?: () => void;
}
class DispatchPolicyError extends Error {
  readonly reason: string;
  constructor(reason: string) { super(reason); this.reason = reason; }
}
class BudgetAdmissionError extends Error {
  readonly code: string;
  constructor(code: string) { super(code); this.code = code; }
}
interface FailureState { timestamps: number[]; cooldownUntil: number; }
export interface FailoverMetrics { budgetMs: 500; lastOverheadMs: number | null; maxOverheadMs: number | null; budgetExceededCount: number; }
export interface CacheMetrics { exactHits: number; exactMisses: number; exactWrites: number; estimatedNetworkCallsAvoided: number; }
export const MAX_PROVIDER_RESPONSE_BYTES = 16 * 1024 * 1024;
export const DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS = 60_000;

export class Router {
  private failures = new Map<ProviderName, FailureState>();
  private readonly config: ProxyConfig;
  private readonly adapters: Map<ProviderName, ProviderAdapter>;
  private readonly secrets: SecretStore;
  private readonly ledger: QuotaLedger;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly telemetry?: TelemetrySink;
  private readonly now: () => number;
  private readonly cache?: ExactMatchCache;
  private readonly contextGuard: ContextGuard;
  private lastFailoverOverheadMs: number | null = null;
  private maxFailoverOverheadMs: number | null = null;
  private failoverBudgetExceededCount = 0;
  private exactCacheHits = 0;
  private exactCacheMisses = 0;
  private exactCacheWrites = 0;
  private readonly efficiency = new EfficiencyRecorder();
  private readonly usage = new UsageMeter();
  private readonly tokenCalibration: TokenCalibration;
  private readonly rejections: ProviderRejections;
  private readonly circuits = new CircuitBreakerRegistry(() => this.now());
  private readonly health = new ProviderHealthTracker(() => this.now());
  private readonly rrCursors = new RoundRobinCursorRegistry();
  private readonly performance = new ProviderPerformanceTracker(() => this.now());
  private egressStore: EgressStore | null = null;
  private connectionProfiles: import("./connection-profiles.ts").ConnectionProfileService | null = null;

  constructor(
    config: ProxyConfig,
    adapters: Map<ProviderName, ProviderAdapter>,
    secrets: SecretStore,
    ledger: QuotaLedger,
    sleep: ((ms: number) => Promise<void>) | undefined = undefined,
    telemetry?: TelemetrySink,
    now: (() => number) | undefined = undefined,
    cache: ExactMatchCache | undefined = undefined,
    contextGuard: ContextGuard | undefined = undefined,
    calibration: TokenCalibration | undefined = undefined
  ) {
    this.config = config;
    this.adapters = adapters;
    this.secrets = secrets;
    this.ledger = ledger;
    this.sleep = sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.telemetry = telemetry;
    this.now = now ?? performance.now.bind(performance);
    this.rejections = new ProviderRejections(this.now);
    this.cache = cache;
    this.contextGuard = contextGuard ?? new ContextGuard();
    // Durable calibration is owned by the process entry point (cli/app); tests and ephemeral
    // profiles get a process-local instance that never persists.
    this.tokenCalibration = calibration ?? new TokenCalibration();
  }

  /** E2-19: optional egress selection before BYOK secret load. Does not retry — W5 remains sole retry authority. Never sets HTTP_PROXY. */
  attachEgressStore(store: EgressStore): void {
    this.egressStore = store;
  }

  attachConnectionProfiles(profiles: import("./connection-profiles.ts").ConnectionProfileService): void {
    this.connectionProfiles = profiles;
  }

  async dispatch(unsafeRequest: ChatCompletionRequest, context: DispatchContext, signal: AbortSignal = new AbortController().signal): Promise<Response> {
    if (signal.aborted) return cancelledResponse(context.requestId);
    const cachePartition = typeof context.cachePartition === 'string' && /^[a-f0-9]{64}$/.test(context.cachePartition) ? context.cachePartition : undefined;
    const cacheAuthority = context.allowCache;
    const allowCache = async (): Promise<boolean> => {
      try {
        if (signal.aborted) return false;
        const allowed = cacheAuthority === undefined || await cacheAuthority() === true;
        return allowed && !signal.aborted;
      }
      catch { return false; }
    };
    const dispatchStartedAt = this.now();
    // Snapshot the server-owned restriction before any asynchronous work. Never read accessors.
    let allowedProviders: Set<ProviderName> | undefined;
    let disableRetries = false;
    try {
      const restriction = Object.getOwnPropertyDescriptor(context, "allowedProviders");
      if (!restriction && "allowedProviders" in context || restriction && !Object.hasOwn(restriction, "value")) throw new Error("invalid_provider_scope");
      if (restriction?.value !== undefined) {
        const values = projectDataArray(restriction.value, 1024);
        if (!values || !values.every(isProvider)) throw new Error("invalid_provider_scope");
        allowedProviders = new Set(values as ProviderName[]);
      }
      const retries = Object.getOwnPropertyDescriptor(context, "disableRetries");
      if ((!retries && "disableRetries" in context) || (retries && (!Object.hasOwn(retries, "value") || retries.value !== undefined && typeof retries.value !== "boolean"))) throw new Error("invalid_retry_policy");
      disableRetries = retries?.value === true;
    } catch {
      return Response.json({ error: { type: "provider_scope_denied", request_id: context.requestId } }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    let request = projectInferenceRequest(unsafeRequest);
    if (!request) return Response.json({ error: { type: "invalid_request", request_id: context.requestId } }, { status: 400, headers: { "cache-control": "no-store" } });
    const selectedAccount = context.accountRef ?? request.uptokey_account;
    const accountId = typeof selectedAccount === 'string' ? selectedAccount.replace(/^conn:/, '') : undefined;
    let explicitProfile: import('./connection-profiles.ts').StoredProfile | undefined;
    if (selectedAccount !== undefined) {
      if (!accountId || !/^[A-Za-z0-9_-]{1,100}$/.test(accountId) || !this.connectionProfiles ||
          context.accountRef && request.uptokey_account && context.accountRef !== request.uptokey_account) {
        return Response.json({error:{type:'account_scope_denied'}},{status:403});
      }
      try { explicitProfile = await this.connectionProfiles.get(accountId); } catch { return Response.json({error:{type:'account_unavailable'}},{status:503}); }
      if (!explicitProfile?.enabled || !isProvider(explicitProfile.providerId)) return Response.json({error:{type:'account_scope_denied'}},{status:403});
    }
    if (hasForbiddenInferenceCredentialField(request)) return Response.json({ error: { type: "credential_field_forbidden", request_id: context.requestId } }, { status: 400, headers: { "cache-control": "no-store" } });
    if (requestsStructuredOutput(request) && Array.isArray(request.tools) && request.tools.length > 0) return Response.json({ error: { type: "unsupported_capability_combination", capabilities: ["structured_output", "tools"], request_id: context.requestId } }, { status: 400, headers: { "cache-control": "no-store" } });
    const localAlias = resolveLocalModelAlias(request.model, this.config);
    let requireLocalAliasModel = false;
    if (localAlias.kind === "resolved") {
      request = { ...request, model: localAlias.model };
    } else if (localAlias.kind === "unresolved") {
      request = { ...request, model: localAlias.tag };
      requireLocalAliasModel = true;
    }
    const estimate = conservativeTokenEstimate(request);
    if (!estimate) return Response.json({ error: { type: "invalid_request", request_id: context.requestId } }, { status: 400, headers: { "cache-control": "no-store" } });
    // Coherent source for routing decisions: the provider-aware reservation with the chars/4
    // envelope as floor, never a second estimator. The per-attempt accounting narrows this to
    // the resolved model and its exact wire envelope.
    const requestAccounting = planAttemptAccounting(request, estimate);
    const routingEstimate = { input: Math.max(estimate.input, requestAccounting.reservation.total - estimate.output), output: estimate.output };
    const attempts: Array<{ provider: ProviderName; reason: string }> = [];
    let privacyBlocked = false;
    let failoverClassifiedAt: number | undefined;

    // Afinidade de Sessão (Sticky Sessions): se o contexto indicar sessão ou usuário, prioriza o provedor previamente saudável
    const pinnedProvider = typeof request.uptokey_provider === "string" && isProvider(request.uptokey_provider) ? request.uptokey_provider : undefined;
    const virtual = isVirtualModel(request.model);
    const aliasLocalOnly = localAlias.kind !== "none";
    const comboForCursor = this.config.routingCombos?.[typeof request.uptokey_routing_combo === "string" ? request.uptokey_routing_combo : this.config.activeRoutingComboId ?? ""];
    const rrCursor = comboForCursor?.mode === "round_robin"
      ? this.rrCursors.advance(comboForCursor.id, comboForCursor.revision, Object.values(comboForCursor.providerOrderByModel).flat().filter(isProvider).length)
      : undefined;
    const comboDecision = resolveRoutingComboDecision(this.config, request, rrCursor);
    if (comboDecision.error) return Response.json({ error: { type: comboDecision.error, request_id: context.requestId, routing_combo: comboDecision.combo?.id ?? request.uptokey_routing_combo ?? this.config.activeRoutingComboId ?? null } }, { status: 422, headers: { "cache-control": "no-store" } });
    let effectiveFallbackOrder = comboDecision.candidates.length > 0
      ? comboDecision.candidates.map((candidate) => candidate.provider)
      : pinnedProvider
        ? [pinnedProvider]
        : aliasLocalOnly
          ? localAliasProviderOrder(this.config)
        : (virtual ? resolveAutoProviderOrder(this.config, request.model) : [...this.config.fallbackOrder]);
    if (comboDecision.candidates.length === 0 && !pinnedProvider && !aliasLocalOnly) effectiveFallbackOrder = preferLocalRuntimesOrder(effectiveFallbackOrder, this.config);
    let routingCandidates: RoutingCandidate[] = comboDecision.candidates.length > 0
      ? comboDecision.candidates
      : effectiveFallbackOrder.map((provider) => ({ provider }));
    if (pinnedProvider && comboDecision.candidates.length > 0) routingCandidates = routingCandidates.filter((candidate) => candidate.provider === pinnedProvider);
    if (request.uptokey_require_model === true && !virtual && comboDecision.candidates.length > 0) {
      // An explicit model selection is stronger than a combo's model fallback.
      routingCandidates = routingCandidates.filter((candidate) => candidate.model === request.model);
      if (routingCandidates.length === 0) return Response.json({ error: { type: "routing_combo_model_unavailable", request_id: context.requestId } }, { status: 422, headers: { "cache-control": "no-store" } });
    }
    if (comboDecision.candidates.length > 0) effectiveFallbackOrder = routingCandidates.map((candidate) => candidate.provider);
    if (allowedProviders !== undefined) {
      effectiveFallbackOrder = effectiveFallbackOrder.filter(name => allowedProviders.has(name));
      routingCandidates = routingCandidates.filter(candidate => allowedProviders.has(candidate.provider));
      if (effectiveFallbackOrder.length === 0) return Response.json({ error: { type: "provider_scope_denied", request_id: context.requestId } }, { status: 403, headers: { "cache-control": "no-store" } });
    }
    if (explicitProfile) {
      effectiveFallbackOrder = effectiveFallbackOrder.filter(name => name === explicitProfile!.providerId);
      routingCandidates = routingCandidates.filter(candidate => candidate.provider === explicitProfile!.providerId);
      if (!routingCandidates.length) return Response.json({error:{type:'account_provider_mismatch'}},{status:403});
    }
    if (routingCandidates.length === 0) return Response.json({ error: { type: "provider_scope_denied", request_id: context.requestId } }, { status: 403, headers: { "cache-control": "no-store" } });
    const sessionId = context.sessionId;
    const firstProvider = effectiveFallbackOrder[0];
    if (sessionId && firstProvider) {
      const activeSession = this.contextGuard.getOrCreateSession(sessionId, firstProvider, "");
      const stickyProvider = activeSession.lastProvider;
      if (stickyProvider && isProvider(stickyProvider) && effectiveFallbackOrder.includes(stickyProvider) && !this.coolingDown(stickyProvider) && !this.health.shouldSkip(stickyProvider)) {
        const idx = effectiveFallbackOrder.indexOf(stickyProvider);
        if (idx > 0) {
          effectiveFallbackOrder.splice(idx, 1);
          effectiveFallbackOrder.unshift(stickyProvider);
        }
      }
    }

    // Deprioritize degraded/unhealthy providers without dropping them from the chain.
    effectiveFallbackOrder = deprioritizeUnhealthy(effectiveFallbackOrder, (name) => this.health.get(name).state);
    if (comboDecision.candidates.length === 0) routingCandidates = effectiveFallbackOrder.map((provider) => ({ provider }));
    routingCandidates = orderCandidatesByRoutingPolicy(this.config, routingCandidates, request, routingEstimate, comboDecision.combo?.mode ?? this.config.routingPolicy?.mode ?? "fixed", this.performance, this.health);

    const attemptRecords: AttemptRecord[] = [];
    const warnings: string[] = [];
    let lastFailedProvider: ProviderName | null = null;
    let lastSwitchReason: string | null = null;
    let partialContent: string | null = null;
    let attemptCount = 0;
    // F2: capabilities the caller requires from the destination (validated at the boundary).
    const requiredCapabilities = REQUIRED_CAPABILITIES.filter(kind => Array.isArray(request.uptokey_require_input) && request.uptokey_require_input.includes(kind));
    const capabilityRefusals: Array<{ provider: ProviderName; model: string; reason: string; missing: RequiredCapability[]; origin: "declared"; profileId: string | null; profileRevision: number | null }> = [];
    let accumulatedCostMicros = 0n;
    let lastBudgetError: string | undefined;
    const requestCostMode = request.uptokey_cost_mode;
    const requestCostLimit = request.uptokey_cost_limit_micros;
    const maxAttempts = Math.min(this.resiliencePolicy().maxAttemptsPerRequest, comboDecision.maxAttempts ?? this.resiliencePolicy().maxAttemptsPerRequest);
    const attemptBudget = {
      available: () => attemptCount < maxAttempts,
      consume: () => { if (attemptCount >= maxAttempts) return false; attemptCount += 1; return true; },
    };
        for (const candidate of routingCandidates) {
      const name = candidate.provider;
            if (failoverClassifiedAt !== undefined) {
        this.observeFailover(elapsed(this.now(), failoverClassifiedAt));
        failoverClassifiedAt = undefined;
      }
      if (signal.aborted) return cancelledResponse(context.requestId);
      if (attemptCount >= maxAttempts) {
        attemptRecords.push({ provider: name, reason: "attempt_limit_reached" });
        break;
      }
      const provider = this.config.providers[name];
      if (!provider?.enabled) { attemptRecords.push({ provider: name, reason: "disabled" }); attempts.push({ provider: name, reason: "disabled" }); continue; }
      const endpoint = provider.endpointUrl ?? "";
      const breakerOpts = { failureThreshold: provider.allowedFails, cooldownMs: provider.cooldownMs };
      const rejection = this.rejections.get(name, endpoint);
      if (rejection) { attemptRecords.push({ provider: name, reason: rejection.reason }); attempts.push({ provider: name, reason: rejection.reason }); continue; }
      const requestedModel = candidate.model ?? (virtual ? undefined : request.model);
      const exactModelRequired = candidate.model !== undefined || request.uptokey_require_model === true || requireLocalAliasModel;
      const selectedModel = selectModel(provider, requestedModel, exactModelRequired);
      if (selectedModel === undefined) {
                attemptRecords.push({ provider: name, reason: "requested_model_unavailable" }); attempts.push({ provider: name, reason: "requested_model_unavailable" }); continue;
      }
      if (explicitProfile && (explicitProfile.modelIds.length > 0 && !explicitProfile.modelIds.includes(selectedModel) ||
          explicitProfile.endpointUrl && explicitProfile.endpointUrl.replace(/\/$/, '') !== endpoint.replace(/\/$/, ''))) {
        return Response.json({error:{type:'account_scope_denied'}},{status:403});
      }
      const cacheEpoch = this.cache?.providerEpoch(name);
      if (name === "gemini" && !geminiPrivacyAccepted(provider.privacyAcceptedAt, provider.privacyNoticeVersion)) { privacyBlocked = true; attemptRecords.push({ provider: name, reason: "privacy_consent_required" }); attempts.push({ provider: name, reason: "privacy_consent_required" }); continue; }
      if (isNamedExperimentalProvider(name) && !namedProviderRiskAccepted(name, provider)) { attemptRecords.push({ provider: name, reason: "risk_consent_required" }); attempts.push({ provider: name, reason: "risk_consent_required" }); continue; }
      const providerRequest: ChatCompletionRequest & {model: string} = { ...request, model: selectedModel };
      delete providerRequest.uptokey_require_model;
      delete providerRequest.uptokey_provider;
      delete providerRequest.uptokey_routing_combo;
      delete providerRequest.uptokey_account;
      delete providerRequest.uptokey_cost_mode;
      delete providerRequest.uptokey_cost_limit_micros;
      delete providerRequest.uptokey_require_input;
      const adapter = this.providerAdapter(name);
      if (!adapter) { attemptRecords.push({ provider: name, reason: "missing_adapter" }); attempts.push({ provider: name, reason: "missing_adapter" }); continue; }
      // One coherent measurement for this attempt: the resolved model plus, when the adapter
      // transforms the envelope (Anthropic Messages), the exact wire body that will be sent.
      const attemptAccounting = planAttemptAccounting(providerRequest, estimate, this.wireEnvelopeFor(adapter, providerRequest));
      const candidateCostEstimate = { input: Math.max(routingEstimate.input, attemptAccounting.reservation.total - estimate.output), output: estimate.output };
      let routingGate = evaluateRoutingPolicy(this.config, name, selectedModel, candidateCostEstimate, requestCostMode, requestCostLimit, accumulatedCostMicros);
      if (routingGate.allowed === false) { attemptRecords.push({ provider: name, reason: routingGate.reason }); attempts.push({ provider: name, reason: routingGate.reason }); continue; }
      const initialDataCollectionDenied = routingGate.dataCollectionDenied;
      
      let candidateAttemptBudget = attemptBudget;
      if (requestCostMode === "within_limit" && routingGate.costMicros !== undefined && routingGate.costMicros !== null) {
        candidateAttemptBudget = {
          available: () => attemptBudget.available(),
          consume: () => {
            const costToConsume = routingGate.costMicros;
            if (costToConsume === undefined || costToConsume === null) return false;
            if (accumulatedCostMicros + costToConsume > BigInt(requestCostLimit!)) return false;
            const consumed = attemptBudget.consume();
            if (consumed) accumulatedCostMicros += costToConsume;
            return consumed;
          }
        };
      }
      if (routingGate.dataCollectionDenied) providerRequest.data_collection = "deny";
      if (!supportsRequest(name, providerRequest)) {
        const reason = name === "anthropic" && requestsToolUse(providerRequest) ? "capability_tools"
          : requestsJsonOutput(providerRequest) && !hasNonTextMultimodalParts(providerRequest) ? "capability_response_format" : "capability_multimodal";
        attemptRecords.push({ provider: name, reason }); attempts.push({ provider: name, reason }); continue;
      }

      const fitDecision = this.contextGuard.evaluateFit(providerRequest, providerRequest.model, attemptAccounting);
      if (!fitDecision.canFit) {
                const hasAlternative = this.resiliencePolicy().autoFallbackEnabled && effectiveFallbackOrder.some((p) => p !== name && this.config.providers[p]?.enabled);
        if (hasAlternative) {
          attemptRecords.push({ provider: name, reason: "context_window_exceeded", action: "fallback" });
          attempts.push({ provider: name, reason: "context_window_exceeded" });
          continue;
        }
      }

      let selectedProfile: StoredProfile | undefined;
      try {
        selectedProfile = explicitProfile ?? await this.connectionProfiles?.getActiveProfileForProvider(name);
      } catch {
        // A profile-backend failure happens before quota/admission. Keep it local:
        // no provider failure, health, circuit, attempt-budget, or reservation effect.
        attemptRecords.push({ provider: name, reason: "account_unavailable", action: "fallback" });
        attempts.push({ provider: name, reason: "account_unavailable" });
        lastFailedProvider = name;
        lastSwitchReason = "account_unavailable";
        continue;
      }
      if(selectedProfile && (!selectedProfile.enabled || selectedProfile.providerId!==name || selectedProfile.endpointUrl && selectedProfile.endpointUrl!==endpoint)) {
        attempts.push({provider:name,reason:'account_disabled'});continue;
      }
      // V4/F2: when the caller requires capabilities (image/audio input, tools, json_schema), only a
      // destination whose connection declares each of them for this model is eligible. Never inferred
      // from the model name or OpenAI compatibility; every fallback candidate is revalidated the same
      // way. Protocol limits of the adapter (supportsRequest) still apply first. Requests without the
      // requirement keep their existing routing.
      let capabilityDeclaration: string | undefined;
      if (requiredCapabilities.length) {
        const missing = requiredCapabilities.filter(kind => !selectedProfile?.[DECLARED_CAPABILITY_FIELDS[kind]]?.includes(selectedModel));
        if (missing.length) {
          const reason = `capability_${missing[0] === "image" || missing[0] === "audio" ? missing[0] + "_input" : missing[0]}_undeclared`;
          capabilityRefusals.push({ provider: name, model: selectedModel, reason, missing, origin: "declared", profileId: selectedProfile?.id ?? null, profileRevision: selectedProfile?.revision ?? null });
          attemptRecords.push({ provider: name, reason }); attempts.push({ provider: name, reason }); continue;
        }
        capabilityDeclaration = `declared;profile=${selectedProfile!.id};revision=${selectedProfile!.revision};kinds=${requiredCapabilities.join(",")}`;
      }
      if (selectedProfile?.commercialAccountId && !context.reserveBudget) {
        return Response.json({error:{type:'account_funding_unavailable',request_id:context.requestId}},{status:503});
      }
      const efficiencyPolicy=getActiveEfficiencyPolicy();
      const cacheNamespace = exactCacheNamespace(endpoint, candidate.comboId, candidate.comboRevision) + (selectedProfile ? `:account:${selectedProfile.id}:${selectedProfile.revision}` : '')+(efficiencyPolicy.revision>1?`:eff:${efficiencyPolicy.revision}`:'') + (cachePartition ? `:scope:${cachePartition}` : '');
      const cacheEnabled=liveEfficiencyGuards(efficiencyPolicy).allowExactCache;
      if (cacheEnabled && cachePartition && context.tenantId && this.cache && await allowCache()) {
        if (exactCacheEligibility(providerRequest) !== "eligible") this.efficiency.recordLookup("ineligible");
        else {
        const lookup: ExactCacheLookup = await this.cache.lookup(context.tenantId, name, providerRequest, cacheNamespace).catch(() => ({ status: "corrupt" as const }));
        const cached = lookup.status === "hit" ? lookup.response : undefined;
        const usable = await allowCache();
        this.efficiency.recordLookup(cached && !usable ? "miss" : lookup.status);
        if (cached && usable) {
          this.exactCacheHits += 1;
          this.efficiency.recordLatency("exact_cache_hit", elapsed(this.now(), dispatchStartedAt), lookup.status === "hit" ? lookup.ageMs : undefined);
          return routeResponse(cached, name, attempts.length > 0, true, providerRequest.model, { capabilityDeclaration, switchReason: lastSwitchReason, failedProvider: lastFailedProvider, warnings, comboId: candidate.comboId, comboRevision: candidate.comboRevision, cacheAgeMs: lookup.status === "hit" ? lookup.ageMs : undefined, costClass: routingGate.classification, costEstimateMicros: routingGate.costMicros !== null && routingGate.costMicros !== undefined ? String(routingGate.costMicros) : undefined });
        }
        if (cached) cancelStream(cached.body, "exact_cache_read_not_allowed");
        this.exactCacheMisses += 1;
        }
      }
      // Live dispatch gates (cache hits above remain available during cooldown/circuit).
      if (!this.circuits.allow(name, endpoint, breakerOpts)) {
                attemptRecords.push({ provider: name, reason: "circuit_open", action: "skip" });
        attempts.push({ provider: name, reason: "circuit_open" });
        continue;
      }
      if (this.health.shouldSkip(name)) {
                attemptRecords.push({ provider: name, reason: "unhealthy", action: "skip" });
        attempts.push({ provider: name, reason: "unhealthy" });
        continue;
      }
      if (this.coolingDown(name)) { attemptRecords.push({ provider: name, reason: "cooldown" }); attempts.push({ provider: name, reason: "cooldown" }); continue; }
      // Reserve for the resolved model, retaining the full-envelope heuristic as a floor.
      const reserveTokens = attemptAccounting.reservation.total;
      const quota = await this.ledger.reserve(name, provider.budget, reserveTokens);
      if (!quota.allowed || !quota.reservation) { attemptRecords.push({ provider: name, reason: `quota_${quota.reason}` }); attempts.push({ provider: name, reason: `quota_${quota.reason}` }); continue; }
      const quotaStatus = this.ledger.status({ [name]: provider.budget }).find((item) => item.provider === name);
      const warn = quotaEarlyWarning(quotaStatus, this.resiliencePolicy().quotaWarnRatio);
      if (warn && !warnings.includes(warn)) warnings.push(warn);
      if (signal.aborted) { await this.ledger.compensateConnectionFailure(quota.reservation); return cancelledResponse(context.requestId); }
      // E2-19: select egress member before BYOK secret load (fail-closed on strict miss). No process HTTP_PROXY mutation.
      let egressOptions: DispatchOptions | undefined;
      if (this.egressStore) {
        const destHost = (() => {
          try {
            const ep = typeof provider.endpointUrl === "string" ? provider.endpointUrl : "";
            return ep ? new URL(ep).hostname : name;
          } catch { return name; }
        })();
        const selected = this.egressStore.selectForDestination({
          connectionId: String((context as { connectionId?: string }).connectionId ?? name),
          providerId: name,
          destinationHost: destHost,
        });
        if (selected.ok === false) {
          await this.ledger.compensateConnectionFailure(quota.reservation);
          attemptRecords.push({ provider: name, reason: selected.code, action: "fallback" });
          attempts.push({ provider: name, reason: selected.code });
          lastFailedProvider = name; lastSwitchReason = selected.code;
          continue;
        }
        try {
          egressOptions = await this.egressStore.transportOptions(selected, signal);
        } catch (error) {
          await this.ledger.compensateConnectionFailure(quota.reservation);
          signal.throwIfAborted();
          const code = (error as { code?: string })?.code === "proxy_configuration_changed" ? "proxy_configuration_changed" : "proxy_credentials_unavailable";
          return Response.json({ error: { type: "proxy_error", code, message: code } }, { status: code === "proxy_configuration_changed" ? 409 : 503 });
        }
        try {
        if (selected.cursor != null && selected.poolId && selected.poolRevision != null) {
          await this.egressStore.setCursor(selected.poolId, selected.poolRevision, selected.cursor);
        }
        if (this.egressStore && selected.ok) {
          await this.egressStore.recordReceipt({
            attemptId: randomUUID(),
            poolId: selected.poolId,
            poolRevision: selected.poolRevision,
            memberId: selected.member?.id ?? null,
            finalHost: destHost,
            transportKind: selected.member?.kind ?? "direct",
            usedDirect: selected.usedDirect,
            reason: selected.reason,
          });
        }
        } catch {
          // No upstream dispatch occurred. A failed durable egress decision must
          // neither consume quota nor silently switch to another transport.
          await this.ledger.compensateConnectionFailure(quota.reservation);
          return Response.json({ error: { message: "Egress persistence unavailable", type: "proxy_error", code: "egress_persistence_unavailable" } }, { status: 503 });
        }
      }
      let key: string | undefined;
      const allowPromptCache = name === 'anthropic' && context.tenantId ? async () => {
        if (!await allowCache()) return false;
        const policy = getActiveEfficiencyPolicy();
        return policy.enabled && policy.providerPromptCache;
      } : undefined;
      let profileSelected = false;
      let accountDisabled = false;
      try {
        if (selectedProfile) {
          const current = await this.connectionProfiles!.get(selectedProfile.id);
          profileSelected = true;
          if (!current?.enabled || current.revision !== selectedProfile.revision || current.providerId !== name) accountDisabled = true;
          else key = await this.connectionProfiles!.readCredential(current) ?? undefined;
        }
        if (!key && !profileSelected) {
          key = await this.secrets.get(`provider:${name}`);
        }
      } catch {
        await this.ledger.compensateConnectionFailure(quota.reservation);
        attemptRecords.push({ provider: name, reason: "secret_store_unavailable" });
        attempts.push({ provider: name, reason: "secret_store_unavailable" });
        continue;
      }
      if (accountDisabled) {
        await this.ledger.compensateConnectionFailure(quota.reservation);
        attemptRecords.push({ provider: name, reason: "disabled", action: "fallback" });
        attempts.push({ provider: name, reason: "disabled" });
        lastFailedProvider = name;
        lastSwitchReason = "disabled";
        continue;
      }
      if (!key && (!explicitProfile || explicitProfile.accessMode === 'local') && (name === "ollama" || name === "vllm" || (isOptionalProvider(name) && optionalProviderAllowsKeyless(this.config, name))
        || (isUserDefinedProvider(name) && typeof provider.endpointUrl === "string" && isLocalEndpointUrl(provider.endpointUrl)))) key = "";
      else if (!key) { await this.ledger.compensateConnectionFailure(quota.reservation); attemptRecords.push({ provider: name, reason: "missing_key", action: "fallback" }); attempts.push({ provider: name, reason: "missing_key" }); lastFailedProvider = name; lastSwitchReason = "missing_key"; continue; }
      const explicitAccount = explicitProfile !== undefined;
      const dispatchIdentity: DispatchIdentity = selectedProfile
        ? {
          kind: key === "" ? "profile-keyless" : "profile-key",
          profileId: selectedProfile.id,
          explicit: explicitAccount,
          model: selectedModel,
          endpoint
        }
        : key === "" ? { kind: "keyless" } : { kind: "legacy-key" };
      const authorizeDispatch = async (): Promise<string> => {
        if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
        if (dispatchIdentity.kind === "keyless") return "";
        if (dispatchIdentity.kind === "legacy-key") {
          let refreshed: string | undefined;
          try {
            refreshed = await this.secrets.get(`provider:${name}`);
          } catch {
            throw new DispatchAuthorizationError("account_unavailable", false);
          }
          if (!refreshed) throw new DispatchAuthorizationError("credential_revoked", false);
          return refreshed;
        }
        if (!this.connectionProfiles) throw new DispatchAuthorizationError("account_unavailable", dispatchIdentity.explicit);
        let current: StoredProfile | undefined;
        try {
          current = await this.connectionProfiles.get(dispatchIdentity.profileId);
        } catch {
          throw new DispatchAuthorizationError("account_unavailable", dispatchIdentity.explicit);
        }
        if (!current?.enabled || current.providerId !== name || current.revision !== selectedProfile!.revision ||
          (current.endpointUrl && current.endpointUrl !== dispatchIdentity.endpoint) ||
          (dispatchIdentity.explicit && current.modelIds.length > 0 && !current.modelIds.includes(dispatchIdentity.model))) {
          throw new DispatchAuthorizationError("account_revoked", dispatchIdentity.explicit);
        }
        if (dispatchIdentity.kind === "profile-keyless") return "";
        let refreshed: string | undefined;
        try {
          refreshed = await this.connectionProfiles.readCredential(current) ?? undefined;
        } catch {
          throw new DispatchAuthorizationError("account_unavailable", dispatchIdentity.explicit);
        }
        if (!refreshed) throw new DispatchAuthorizationError("account_revoked", dispatchIdentity.explicit);
        // R1: the credential read is the last await before the adapter. The same profile
        // must still own this key after it: a revocation or revision change completed
        // meanwhile denies locally instead of dispatching, switching accounts or falling
        // back to the legacy key. An explicitly chosen profile always refuses (403).
        let confirmed: StoredProfile | undefined;
        try {
          confirmed = await this.connectionProfiles.get(current.id);
        } catch {
          throw new DispatchAuthorizationError("account_unavailable", dispatchIdentity.explicit);
        }
        if (!confirmed?.enabled || confirmed.providerId !== name || confirmed.revision !== current.revision ||
          (confirmed.endpointUrl && confirmed.endpointUrl !== dispatchIdentity.endpoint) ||
          (dispatchIdentity.explicit && confirmed.modelIds.length > 0 && !confirmed.modelIds.includes(dispatchIdentity.model))) {
          throw new DispatchAuthorizationError("account_revoked", dispatchIdentity.explicit);
        }
        return refreshed;
      };
      const started = this.now();
      let transientRetries = 0;
      let admittedRates: string | undefined;
      const currentRates = () => {
        const tariff = findTariff(this.config.tariffSnapshot, name, selectedModel, accessModeFor(this.config, name));
        return JSON.stringify([accessModeFor(this.config, name), tariff?.inputMicrosPerMillion ?? null, tariff?.outputMicrosPerMillion ?? null]);
      };
      const reservationRef: BudgetReservationRef = { current: quota.reservation,
        validatePolicy: () => {
          const current = evaluateRoutingPolicy(this.config, name, selectedModel, candidateCostEstimate, requestCostMode, requestCostLimit, accumulatedCostMicros);
          if (current.allowed === false) throw new DispatchPolicyError(current.reason);
          // A stricter data policy requires the envelope to be prepared and counted again.
          if (current.dataCollectionDenied !== initialDataCollectionDenied) throw new DispatchPolicyError('routing_policy_changed');
          // An asynchronous reservation cannot authorize a different tariff, even when
          // the UI permits paid models. Release it and select another eligible candidate.
          if (admittedRates !== undefined && admittedRates !== currentRates()) throw new DispatchPolicyError('cost_policy_changed');
          routingGate = current;
        },
        ...(context.reserveBudget ? { reserveBudget: async (id: string) => {
          const ratesIdentity = currentRates();
          const admitted = await context.reserveBudget!(buildDispatchBudgetAttempt(this.config, name, selectedModel, id, candidateCostEstimate, selectedProfile?.commercialAccountId));
          admittedRates = admitted ? ratesIdentity : undefined;
          return admitted;
        } } : {}),
      };
      try {
        while (true) {
          if (attemptCount >= maxAttempts) {
            attemptRecords.push({ provider: name, reason: "attempt_limit_reached" });
            break;
          }
          let activeReservation = quota.reservation;
          if (transientRetries > 0) {
            const retryQuota = await this.ledger.reserve(name, provider.budget, reserveTokens);
            if (!retryQuota.allowed || !retryQuota.reservation) {
              attemptRecords.push({ provider: name, reason: `quota_${retryQuota.reason}`, action: "fallback" });
              attempts.push({ provider: name, reason: `quota_${retryQuota.reason}` });
              lastFailedProvider = name; lastSwitchReason = `quota_${retryQuota.reason}`;
              break;
            }
            activeReservation = retryQuota.reservation;
          }
          reservationRef.current = activeReservation;
          const response = transientRetries === 0 && !(disableRetries || requestCostMode === "within_limit")
            ? await this.dispatchWith429Backoff(adapter, provider, providerRequest, key, signal, reserveTokens, activeReservation, egressOptions, candidateAttemptBudget, allowPromptCache, authorizeDispatch, reservationRef)
            : await this.dispatchReserved(adapter, provider, providerRequest, key, signal, activeReservation, egressOptions, candidateAttemptBudget, allowPromptCache, authorizeDispatch, reservationRef);
                    try { await this.ledger.reconcileProvider(name as ProviderName, response.headers); }
          catch { /* a reserva local já persistida permanece conservadora; não duplicar prompt por falha contábil local */ }

          if (response.status >= 400) {
            const classified = classifyHttpStatus(response.status);
            const fallbackDisabled = classified.action === "fallback" && !this.resiliencePolicy().autoFallbackEnabled && classified.kind !== "rate_limit";
            if (classified.action === "fail_fast" || fallbackDisabled) {
              const invalidCredentials = classified.kind === "auth" || classified.kind === "forbidden";
              const hardAuth = invalidCredentials || classified.kind === "billing";
              if (hardAuth) {
                this.rejections.record(name, response.status, endpoint);
              }
              cancelStream(response.body);
              // Client fail-fast must not trip circuit; invalid credentials use sticky rejection only.
              // Disabled-fallback for transient upstream errors still records connection pain.
              if (invalidCredentials) {
                this.health.recordFailure(name, this.now()); this.performance.recordFailure(name);
              } else if (fallbackDisabled || classified.kind === "billing") {
                const failedAt = this.now();
                this.health.recordFailure(name, failedAt); this.performance.recordFailure(name);
                this.circuits.recordFailure(name, endpoint, breakerOpts, failedAt);
              }
              lastFailedProvider = name;
              const finalStatus = invalidCredentials ? "fail_fast" : (fallbackDisabled ? "disabled_fallback" : "fail_fast");
              return providerRequestRejected(response.status, name, attempts.length > 0, context.requestId, this.rejections.get(name, endpoint)?.reason, scrubbedOutcome({
                provider_used: null, provider_failed: name, switch_reason: classified.reason, final_status: finalStatus,
                attempts: [...attemptRecords, { provider: name, reason: classified.reason, action: finalStatus, status: response.status }],
                warnings, partial_content: partialContent,
              }));
            }
            if (!(disableRetries || requestCostMode === "within_limit") && classified.action === "retry" && classified.kind !== "rate_limit" && transientRetries < this.resiliencePolicy().maxTransientRetries) {
              if (!await discardResponse(response)) return providerCleanupTimeout(context.requestId);
              transientRetries += 1;
              attemptRecords.push({ provider: name, reason: classified.reason, action: "retry", status: response.status });
              await sleepWithSignal(this.sleep, Math.min(5_000, provider.baseBackoffMs * 2 ** transientRetries), signal);
              continue;
            }
            // fallback path (401/403/402/5xx after retries, or 429 exhausted)
            const classifiedAt = this.now();
            const invalidCredentials = classified.kind === "auth" || classified.kind === "forbidden";
            const hardAuth = invalidCredentials || classified.kind === "billing";
            if (hardAuth) {
              // 401/403 sticky-invalidate; 402 DeepSeek credit uses TTL — never transient-retry the same key.
              this.rejections.record(name, response.status, endpoint);
            }
            if (!await discardResponse(response)) return providerCleanupTimeout(context.requestId);
            if (invalidCredentials) {
              // Surface invalid key via rejection/admission only — do not feed transient cooldown/circuit.
              this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
            } else {
              this.recordFailure(provider, classifiedAt);
              this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
              this.circuits.recordFailure(name, endpoint, breakerOpts, classifiedAt);
            }
            this.telemetry?.providerFailed({ provider: name, statusCode: response.status, latencyMs: elapsed(classifiedAt, started), requestId: context.requestId, sensitiveValues: [key] });
            attemptRecords.push({ provider: name, reason: classified.reason, action: this.resiliencePolicy().autoFallbackEnabled ? "fallback" : "fail_fast", status: response.status });
            attempts.push({ provider: name, reason: classified.reason });
            lastFailedProvider = name;
            lastSwitchReason = classified.reason;
            failoverClassifiedAt = classifiedAt;
            if (!this.resiliencePolicy().autoFallbackEnabled) {
              return providerRequestRejected(response.status, name, attempts.length > 0, context.requestId, this.rejections.get(name, endpoint)?.reason, scrubbedOutcome({
                provider_used: null, provider_failed: name, switch_reason: classified.reason, final_status: "disabled_fallback",
                attempts: attemptRecords, warnings, partial_content: partialContent,
              }));
            }
            break; // next provider — never continue the same-connection retry loop for hard auth
          }

          if (response.status !== 200) {
            const classified = classifyHttpStatus(response.status);
            const classifiedAt = this.now();
            if (!await discardResponse(response)) return providerCleanupTimeout(context.requestId);
            this.recordFailure(provider, classifiedAt);
            this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
            this.circuits.recordFailure(name, endpoint, breakerOpts, classifiedAt);
            this.telemetry?.providerFailed({ provider: name, statusCode: response.status, latencyMs: elapsed(classifiedAt, started), requestId: context.requestId, sensitiveValues: [key] });
            attemptRecords.push({ provider: name, reason: classified.reason, action: "fallback", status: response.status });
            attempts.push({ provider: name, reason: classified.reason });
            lastFailedProvider = name; lastSwitchReason = classified.reason; failoverClassifiedAt = classifiedAt;
            if (!this.resiliencePolicy().autoFallbackEnabled) {
              return providerRequestRejected(response.status, name, true, context.requestId, undefined, scrubbedOutcome({
                provider_used: null, provider_failed: name, switch_reason: classified.reason, final_status: "disabled_fallback",
                attempts: attemptRecords, warnings, partial_content: partialContent,
              }));
            }
            break;
          }
          if (!validProviderContentType(response.headers.get("content-type"), request.stream === true)) {
            const classifiedAt = this.now();
            if (!await discardResponse(response)) return providerCleanupTimeout(context.requestId);
            this.recordFailure(provider, classifiedAt);
            this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
            this.circuits.recordFailure(name, endpoint, breakerOpts, classifiedAt);
            this.telemetry?.providerFailed({ provider: name, statusCode: response.status, latencyMs: elapsed(classifiedAt, started), requestId: context.requestId, sensitiveValues: [key] });
            attemptRecords.push({ provider: name, reason: "invalid_content_type", action: "fallback" });
            attempts.push({ provider: name, reason: "invalid_content_type" });
            lastFailedProvider = name; lastSwitchReason = "invalid_content_type"; failoverClassifiedAt = classifiedAt;
            if (!this.resiliencePolicy().autoFallbackEnabled) break;
            break;
          }
          const usageHooks = this.usageHooks(name, providerRequest, attemptAccounting, reservationRef, signal, context);
          const boundedResponse = limitProviderResponse(response, MAX_PROVIDER_RESPONSE_BYTES, () => {
            const failedAt = this.now();
            this.recordFailure(provider, failedAt);
            this.health.recordFailure(name, failedAt); this.performance.recordFailure(name);
            this.circuits.recordFailure(name, endpoint, breakerOpts, failedAt);
            this.telemetry?.providerFailed({ provider: name, statusCode: 0, latencyMs: elapsed(failedAt, started), requestId: context.requestId });
          }, request.stream === true && providerContentType(response.headers.get("content-type")) === "text/event-stream" ? 0 : provider.requestTimeoutMs, this.usage.observe(name, request.stream === true, usageHooks.onUsage, usageHooks.onClose), { preservePartial: true, onPartial: (text) => { partialContent = text; } });
          this.clearFailures(name);
          this.health.recordSuccess(name);
          this.circuits.recordSuccess(name, endpoint, breakerOpts);
          this.performance.recordSuccess(name, null, elapsed(this.now(), started), null);
          if (sessionId) {
            this.contextGuard.recordSwitch(sessionId, name, providerRequest.model, true);
          }
          if (cacheEnabled && cachePartition && liveEfficiencyGuards(getActiveEfficiencyPolicy()).allowExactCache && context.tenantId && request.temperature === 0 && this.cache && await allowCache()) {
            try {
              const copy = boundedResponse.clone();
              void this.cache.put(context.tenantId, name, providerRequest, copy, cacheEpoch, cacheNamespace, allowCache).then((stored) => {
                if (stored) this.exactCacheWrites += 1;
              }, () => undefined);
            } catch { /* cache é otimização local; streaming principal permanece autoritativo */ }
          }
          this.efficiency.recordLatency("live_dispatch", elapsed(this.now(), dispatchStartedAt));
          return routeResponse(boundedResponse, name, attempts.length > 0, false, providerRequest.model, { capabilityDeclaration, switchReason: lastSwitchReason, failedProvider: lastFailedProvider, warnings, comboId: candidate.comboId, comboRevision: candidate.comboRevision, costClass: routingGate.classification, costEstimateMicros: routingGate.costMicros !== null && routingGate.costMicros !== undefined ? String(routingGate.costMicros) : undefined });
        }
      } catch (error) { 
        if (signal.aborted) return cancelledResponse(context.requestId);
        if (error instanceof DispatchPolicyError) {
          attempts.push({ provider: name, reason: error.reason });
          attemptRecords.push({ provider: name, reason: error.reason, action: 'fallback' });
          continue;
        }
        if (error instanceof BudgetAdmissionError) {
          if (error.code === 'budget_exceeded' || error.code === 'budget_cost_unknown') {
            lastBudgetError = error.code;
            attempts.push({ provider: name, reason: error.code });
            attemptRecords.push({ provider: name, reason: error.code, action: 'fallback' });
            continue;
          }
          return Response.json({ error: { type: error.code, request_id: context.requestId } },
            { status: error.code === 'workspace_forbidden' ? 403 : error.code === 'workspace_archived' ? 409 : 503, headers: { 'cache-control': 'no-store' } });
        }
        if (error instanceof DispatchAuthorizationError) {
          if (error.explicit) {
            return Response.json({ error: { type: "account_scope_denied", request_id: context.requestId } }, { status: 403, headers: { "cache-control": "no-store" } });
          }
          attemptRecords.push({ provider: name, reason: error.reason, action: this.resiliencePolicy().autoFallbackEnabled ? "fallback" : "fail_fast" });
          attempts.push({ provider: name, reason: error.reason });
          lastFailedProvider = name; lastSwitchReason = error.reason; failoverClassifiedAt = this.now();
          if (!this.resiliencePolicy().autoFallbackEnabled) {
            return Response.json({
              error: {
                type: "no_provider_available",
                message: "Automatic fallback is disabled.",
                request_id: context.requestId,
                attempts,
                provider_used: null,
                provider_failed: name,
                switch_reason: error.reason,
                final_status: "disabled_fallback",
                tokens: { basis: "unknown" },
                cost: null,
                warnings,
                partial_content: partialContent,
              }
            }, { status: 429, headers: { "retry-after": "30", "cache-control": "no-store" } });
          }
          // R3: a local denial of an automatically selected account removes only that
          // candidate. The explicit profile was already answered with 403 above, so this
          // path never turns refusal into a silent account switch or legacy-key escape.
          continue;
        }
        if (error instanceof Error && error.message === "provider_cleanup_timeout") {
          const classifiedAt = this.now(); this.recordFailure(provider, classifiedAt);
          this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
          this.circuits.recordFailure(name, endpoint, breakerOpts, classifiedAt);
          this.telemetry?.providerFailed({ provider: name, statusCode: 0, latencyMs: elapsed(classifiedAt, started), requestId: context.requestId, sensitiveValues: [key] });
          return providerCleanupTimeout(context.requestId);
        }
        const classified = classifyDispatchError(error);
        if (!(disableRetries || requestCostMode === "within_limit") && classified.action === "retry" && transientRetries < this.resiliencePolicy().maxTransientRetries && attemptCount < maxAttempts) {
          transientRetries += 1;
          attemptRecords.push({ provider: name, reason: classified.reason, action: "retry" });
          try {
            await sleepWithSignal(this.sleep, Math.min(5_000, provider.baseBackoffMs * 2 ** transientRetries), signal);
            // Re-enter by continuing the provider loop iteration via nested while — allocate fresh reservation
            const retryQuota = await this.ledger.reserve(name, provider.budget, reserveTokens);
            if (retryQuota.allowed && retryQuota.reservation) {
              try {
                const retryResponse = await this.dispatchReserved(adapter, provider, providerRequest, key!, signal, retryQuota.reservation, egressOptions, attemptBudget, allowPromptCache, authorizeDispatch, reservationRef);
                if (retryResponse.status === 200 && validProviderContentType(retryResponse.headers.get("content-type"), request.stream === true)) {
                  this.clearFailures(name); this.health.recordSuccess(name); this.circuits.recordSuccess(name, endpoint, breakerOpts);
                  const retryUsageHooks = this.usageHooks(name, providerRequest, attemptAccounting, reservationRef, signal, context);
                  return routeResponse(limitProviderResponse(retryResponse, MAX_PROVIDER_RESPONSE_BYTES, () => undefined, request.stream === true && providerContentType(retryResponse.headers.get("content-type")) === "text/event-stream" ? 0 : provider.requestTimeoutMs, this.usage.observe(name, request.stream === true, retryUsageHooks.onUsage, retryUsageHooks.onClose), { preservePartial: true, onPartial: (t) => { partialContent = t; } }), name, attempts.length > 0, false, providerRequest.model, { capabilityDeclaration, switchReason: lastSwitchReason, failedProvider: lastFailedProvider, warnings, comboId: candidate.comboId, comboRevision: candidate.comboRevision, costClass: routingGate.classification, costEstimateMicros: routingGate.costMicros !== null && routingGate.costMicros !== undefined ? String(routingGate.costMicros) : undefined });
                }
                if (!await discardResponse(retryResponse)) return providerCleanupTimeout(context.requestId);
                classified.reason = classifyHttpStatus(retryResponse.status).reason;
              } catch (retryError) {
                if (signal.aborted) return cancelledResponse(context.requestId);
                if (retryError instanceof DispatchPolicyError) {
                  attempts.push({ provider: name, reason: retryError.reason });
                  attemptRecords.push({ provider: name, reason: retryError.reason, action: 'fallback' });
                  continue;
                }
              }
            }
          } catch { /* fall through to fallback */ }
        }
        const classifiedAt = this.now();
        this.recordFailure(provider, classifiedAt);
        this.health.recordFailure(name, classifiedAt); this.performance.recordFailure(name);
        this.circuits.recordFailure(name, endpoint, breakerOpts, classifiedAt);
        this.telemetry?.providerFailed({ provider: name, statusCode: 0, latencyMs: elapsed(classifiedAt, started), requestId: context.requestId, sensitiveValues: [key] });
        attemptRecords.push({ provider: name, reason: classified.reason, action: this.resiliencePolicy().autoFallbackEnabled ? "fallback" : "fail_fast" });
        attempts.push({ provider: name, reason: classified.reason });
        lastFailedProvider = name; lastSwitchReason = classified.reason; failoverClassifiedAt = classifiedAt;
        if (!this.resiliencePolicy().autoFallbackEnabled) {
          return Response.json({
            error: {
              type: "no_provider_available",
              message: "Automatic fallback is disabled.",
              request_id: context.requestId,
              attempts,
              provider_used: null,
              provider_failed: name,
              switch_reason: classified.reason,
              final_status: "disabled_fallback",
              tokens: { basis: "unknown" },
              cost: null,
              warnings,
              partial_content: partialContent,
            }
          }, { status: 429, headers: { "retry-after": "30", "cache-control": "no-store" } });
        }
      }
    }
    if (lastBudgetError) return Response.json({ error: { type: lastBudgetError, request_id: context.requestId } },
      { status: lastBudgetError === 'budget_exceeded' ? 429 : 409, headers: { 'cache-control': 'no-store' } });
    if (privacyBlocked) return Response.json({ error: { type: "gemini_privacy_consent_required", request_id: context.requestId } }, { status: 412, headers: { "cache-control": "no-store" } });

    // V2: when the preference excluded candidates and nothing was dispatched, the answer is the
    // policy itself (never a silent paid route): the client keeps the task and offers another mode.
    const excludedByCost = attemptRecords.filter(r => r.reason.startsWith("cost_policy_"));
    if (requestCostMode !== undefined && requestCostMode !== "any" && attemptCount === 0 && excludedByCost.length > 0) {
      return Response.json({
        error: {
          type: "cost_policy_no_eligible_provider",
          code: "cost_policy_no_eligible_provider",
          message: "cost_policy_no_eligible_provider",
          request_id: context.requestId,
          cost_mode: requestCostMode,
          ...(requestCostLimit !== undefined ? { cost_limit_micros: String(requestCostLimit) } : {}),
          excluded: excludedByCost.map(r => ({ provider: r.provider, reason: r.reason })),
          other_attempts: attemptRecords.filter(r => !r.reason.startsWith("cost_policy_")).map(r => ({ provider: r.provider, reason: r.reason })),
        },
        attempts: attemptRecords
      }, { status: 422, headers: { "x-uptokey-cost-class": "none", "cache-control": "no-store" } });
    }
    // V4/F2: nothing was sent because no destination declares a required capability; the client keeps
    // the task. One missing kind keeps its specific code (input_image_undeclared, input_audio_undeclared,
    // input_tools_undeclared, input_json_schema_undeclared); several give input_capability_undeclared.
    if (attemptCount === 0 && capabilityRefusals.length > 0) {
      const kinds = REQUIRED_CAPABILITIES.filter(kind => capabilityRefusals.some(r => r.missing.includes(kind)));
      const type = kinds.length === 1 ? `input_${kinds[0]}_undeclared` : "input_capability_undeclared";
      return Response.json({
        error: { type, code: type, message: type, request_id: context.requestId, required: requiredCapabilities,
          excluded: capabilityRefusals.map(r => ({ provider: r.provider, model: r.model, reason: r.reason, missing: r.missing,
            origin: r.origin, profileId: r.profileId, profileRevision: r.profileRevision })) },
        attempts: attemptRecords,
      }, { status: 422, headers: { "cache-control": "no-store" } });
    }
    const outcome = scrubbedOutcome({
      provider_used: null,
      provider_failed: lastFailedProvider,
      switch_reason: lastSwitchReason,
      final_status: "exhausted",
      attempts: attemptRecords,
      warnings,
      partial_content: partialContent,
    });
    if (lastFailedProvider && (lastSwitchReason === "http_401" || lastSwitchReason === "http_403")) {
      const status = lastSwitchReason === "http_401" ? 401 : 403;
      return providerRequestRejected(status, lastFailedProvider, attempts.length > 0, context.requestId,
        lastSwitchReason === "http_401" ? "provider_auth_rejected" : "provider_forbidden", outcome);
    }
    return Response.json({
      error: {
        type: "no_provider_available",
        message: "Nenhum provider consentido está disponível.",
        request_id: context.requestId,
        attempts,
        provider_used: outcome.provider_used,
        provider_failed: outcome.provider_failed,
        switch_reason: outcome.switch_reason,
        final_status: outcome.final_status,
        tokens: outcome.tokens,
        cost: outcome.cost,
        warnings: outcome.warnings,
        partial_content: outcome.partial_content,
        ...(excludedByCost.length ? { cost_mode: requestCostMode, cost_excluded: excludedByCost.map(r => ({ provider: r.provider, reason: r.reason })) } : {}),
      }
    }, { status: 429, headers: { "retry-after": "30", "cache-control": "no-store" } });
  }

  private async dispatchWith429Backoff(adapter: ProviderAdapter, provider: ProviderConfig, request: ChatCompletionRequest, key: string, signal: AbortSignal, tokens: number, initialReservation: Reservation, egressOptions: DispatchOptions | undefined, budget: { available(): boolean; consume(): boolean }, allowPromptCache?: () => Promise<boolean>, authorize?: () => Promise<string>, reservationRef?: BudgetReservationRef): Promise<Response> {
    let response = await this.dispatchReserved(adapter, provider, request, key, signal, initialReservation, egressOptions, budget, allowPromptCache, authorize, reservationRef);
    // Budget esgotado: devolve o 429 intacto para a classificação normal (fallback/exaustão), sem novo despacho.
    // A tentativa só é consumida depois da reserva e da espera, imediatamente antes do redespacho:
    // quota negada ou cancelamento não gastam o budget que o fallback ainda pode usar.
    for (let retry = 0; response.status === 429 && retry < provider.max429Retries && budget.available(); retry += 1) {
      const retryAfter = parseRetryAfter(response.headers.get("retry-after"));
      const exponential = provider.baseBackoffMs * 2 ** retry;
      if (!await discardResponse(response)) throw new Error("provider_cleanup_timeout");
      if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      const quota = await this.ledger.reserve(provider.name as ProviderName, provider.budget, tokens);

      if (!quota.allowed || !quota.reservation) return new Response(null, { status: 429 });
      try {
        await sleepWithSignal(this.sleep, Math.min(5_000, Math.max(exponential, retryAfter)), signal);
        if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
      } catch (error) { await this.ledger.compensateConnectionFailure(quota.reservation); throw error; }
      response = await this.dispatchReserved(adapter, provider, request, key, signal, quota.reservation, egressOptions, budget, allowPromptCache, authorize, reservationRef);
    }
    return response;
  }

  private async dispatchReserved(adapter: ProviderAdapter, provider: ProviderConfig, request: ChatCompletionRequest, key: string, signal: AbortSignal, reservation: Reservation, egressOptions: DispatchOptions | undefined, budget: { consume(): boolean }, allowPromptCache?: () => Promise<boolean>, authorize?: () => Promise<string>, reservationRef?: BudgetReservationRef): Promise<Response> {
    let admitted: DispatchBudgetReservation | undefined;
    let dispatched = false;
    try {
      try { admitted = await reservationRef?.reserveBudget?.(reservation.id); }
      catch (error) {
        const code = error instanceof Error && ['budget_exceeded', 'budget_cost_unknown', 'workspace_forbidden', 'workspace_archived', 'account_funding_missing', 'account_funding_expired', 'account_funding_changed'].includes(error.message) ? error.message : 'budget_unavailable';
        throw new BudgetAdmissionError(code);
      }
    if (allowPromptCache && await allowPromptCache()) egressOptions = { ...egressOptions, providerPromptCache: true };
    // Local refusal gate: cancellation and the server-owned egress authority must hold
    // both before preparation and after its last await. A refusal compensates exactly the
    // unused reservation; it never consumes the attempt nor invokes the adapter.
    const localRefusal = async (): Promise<Response | undefined> => {
      if (signal.aborted) { await this.ledger.compensateConnectionFailure(reservation); throw signal.reason ?? new DOMException("aborted", "AbortError"); }
      if (egressOptions?.proxyAuthorityValid && !egressOptions.proxyAuthorityValid()) {
        await this.ledger.compensateConnectionFailure(reservation);
        return Response.json({ error: { type: "proxy_error", code: "proxy_configuration_changed" } }, { status: 409 });
      }
      return undefined;
    };
    const beforeAuthorize = await localRefusal();
    if (beforeAuthorize) { await admitted?.compensate(); return beforeAuthorize; }
    if (authorize) {
      try {
        key = await authorize();
      } catch (error) {
        await this.ledger.compensateConnectionFailure(reservation);
        if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
        throw error;
      }
    }
    // R2/R4: authorization is the final preparation await. Re-examine the same signal and
    // egress binding right before the dispatch boundary; a decision that changed meanwhile
    // refunds the reservation instead of sending directly or debiting quota without HTTP.
    if (admitted?.validate) {
      try { await admitted.validate(); }
      catch (error) {
        const code = error instanceof Error && ['account_funding_missing','account_funding_expired','account_funding_changed'].includes(error.message) ? error.message : 'budget_unavailable';
        throw new BudgetAdmissionError(code);
      }
    }
    const afterAuthorize = await localRefusal();
    if (afterAuthorize) { await admitted?.compensate(); return afterAuthorize; }
    // Synchronous last-mile check: no await between policy validation and dispatch.
    // Covers the initial attempt, 429 backoff and network/transient retries alike.
    reservationRef?.validatePolicy?.();
    // One owner for initial, 429 and transient retries. Preparation, quota denial and
    // cancellation above do not count as an invocation of the provider adapter.
    if (!budget.consume()) { await this.ledger.compensateConnectionFailure(reservation); throw new Error("attempt_limit_reached"); }
    // The response about to be produced belongs to THIS reservation: settlement is keyed by it.
    if (reservationRef) { reservationRef.current = reservation; reservationRef.budget = admitted; }
    dispatched = true;
    return await adapter.dispatch(request, key, signal, provider.requestTimeoutMs, egressOptions);
    } catch (error) {
      if (!dispatched || definitelyNotDispatched(error)) {
        await this.ledger.compensateConnectionFailure(reservation);
        await admitted?.compensate();
      }
      throw error;
    }
  }

  private resiliencePolicy(): ResiliencePolicy { return resolveResiliencePolicy(this.config); }

  failoverMetrics(): FailoverMetrics { return { budgetMs: 500, lastOverheadMs: this.lastFailoverOverheadMs, maxOverheadMs: this.maxFailoverOverheadMs, budgetExceededCount: this.failoverBudgetExceededCount }; }
  contextMetrics() { return this.contextGuard.getContextPreservationMetrics(); }
  cacheMetrics(): CacheMetrics { return { exactHits: this.exactCacheHits, exactMisses: this.exactCacheMisses, exactWrites: this.exactCacheWrites, estimatedNetworkCallsAvoided: this.exactCacheHits }; }
  usageMetrics(): UsageMetrics { return this.usage.snapshot(); }
  /** Auditable local estimation metrics: catalog state counts, digest cache, declared family
   * capabilities, verified artifact profiles and estimate-vs-provider calibration. Numeric and
   * metadata only; basis is observation, never billing. */
  estimationMetrics() {
    const artifacts = listTokenizerCatalog().flatMap((entry) => {
      if (entry.status !== "verified" || !entry.encoding) return [];
      try {
        const profile = tokenizerArtifactProfile(entry.encoding, entry.tokenizerName, entry.version);
        return [{ family: entry.family, tokenizer: `${entry.tokenizerName}@${entry.version}`, encoding: entry.encoding, artifactDigest: profile.digest, profileDigest: profile.profileDigest, materialDigest: profile.materialDigest }];
      } catch { return []; }
    });
    return {
      basis: "local_process_observation" as const,
      tokenizer: tokenMetricsSnapshot(),
      capabilities: describeTokenizerCapabilities(),
      artifacts,
      calibration: this.tokenCalibration.snapshot(),
    };
  }
  /** Exact wire envelope handed to the adapter, when it declares one. Measured only through
   * the selected model's tokenizer; a wireEnvelope failure is not an accounting failure. */
  private wireEnvelopeFor(adapter: ProviderAdapter, request: ChatCompletionRequest): unknown | undefined {
    if (typeof adapter.wireEnvelope !== "function") return undefined;
    try { return adapter.wireEnvelope(request); } catch { return undefined; }
  }
  /** Per-response accounting hooks: calibrate the local estimate (numbers only, with counting
   * identity, skipped for ephemeral dispatches) and settle the exact reservation of the attempt
   * that produced this response — including late/partial usage and absence of usage. */
  private usageHooks(
    provider: ProviderName,
    providerRequest: ChatCompletionRequest,
    accounting: AttemptAccounting,
    reservationRef: BudgetReservationRef,
    signal: AbortSignal,
    context: DispatchContext,
  ): { onUsage: (usage: ReportedTokenUsage & CacheUsage) => void; onClose: (observation: UsageObservation) => void } {
    const persistCalibration = context.retentionMode !== "ephemeral";
    return {
      onUsage: (reported: ReportedTokenUsage & CacheUsage): void => {
        try {
          const measured = measureRequestTokens(providerRequest, { verify: "off" });
          if (!measured || measured.input === null || measured.model.length === 0) return;
          this.tokenCalibration.record({
            provider,
            model: measured.model,
            state: measured.state,
            estimatedInput: measured.input,
            reportedInput: reported.inputTokens,
            reportedOutput: reported.outputTokens,
            tokenizerId: measured.tokenizerId,
            catalogVersion: measured.catalogVersion ?? accounting.catalogVersion,
            artifactProfileDigest: accounting.artifactProfileDigest,
            persist: persistCalibration,
          });
        } catch { /* observability must never break the response path */ }
      },
      onClose: (observation: UsageObservation): void => {
        try {
          const reservation = reservationRef.current;
          const interrupted = observation.interrupted;
          const outcome: ReportedObservation["outcome"] = interrupted ? (signal.aborted ? "cancelled" : "interrupted") : "complete";
          const reported: ReportedObservation = observation.usage
            ? {
              key: `${reservation.id}:usage`,
              outcome,
              reportedInput: observation.usage.inputTokens,
              reportedOutput: observation.usage.outputTokens,
              cachedInput: observation.usage.cachedInputTokens,
              reasoningOutput: observation.usage.reasoningTokens,
            }
            : {
              key: `${reservation.id}:${interrupted ? "interrupted" : "no-usage"}`,
              outcome,
              reportedInput: null,
              reportedOutput: null,
            };
          void this.ledger.settleReportedUsage(reservation, reported).catch(() => undefined);
          if (!interrupted) void reservationRef.budget?.settle(reported.reportedInput ?? null, reported.reportedOutput ?? null).catch(() => undefined);
        } catch { /* settlement is best-effort and never affects the response */ }
      },
    };
  }
  /** Metadata-only projection for stages 04 (selection input) and 06 (presentation); never a routing decision. */
  efficiencyMetrics(): EfficiencyMetrics { return this.efficiency.snapshot(this.cache !== undefined && liveEfficiencyGuards(getActiveEfficiencyPolicy()).allowExactCache, this.exactCacheWrites); }
  providerPromptCacheMetrics(){return this.usage.promptCacheSnapshot();}
  invalidateExactCache(provider?: ProviderName): Promise<void> {
    return Promise.all((provider?[provider]:ALL_PROVIDERS).map(name=>this.cache?.invalidateProvider(name))).then(()=>{});
  }
  connectionMetrics() {
    const ids = Object.keys(this.config.providers).filter(isProvider);
    const quotas = this.ledger.status(Object.fromEntries(ids.map(id => [id, this.config.providers[id]?.budget])));
    const catalogProjection = buildCatalogConnectionProjection(this.config, {
      adapterPresent: (id) => this.providerAdapter(id as ProviderName) !== undefined,
    });
    return {
      observedAt: new Date().toISOString(),
      basis: "local_configuration_and_admission" as const,
      setupHints: ["provider-v1", "connection-v1"],
      routingCapabilities: ["exact-provider-v1"],
      resilience: {
        autoFallbackEnabled: this.resiliencePolicy().autoFallbackEnabled,
        maxAttemptsPerRequest: this.resiliencePolicy().maxAttemptsPerRequest,
        quotaWarnRatio: this.resiliencePolicy().quotaWarnRatio,
      },
      routingCombos: catalogProjection.routingCombos,
      catalog: {
        revision: catalogProjection.catalogRevision,
        basis: catalogProjection.basis,
        entries: catalogProjection.entries,
        searchableNonExecutableCount: catalogProjection.searchableNonExecutableCount,
        connections: catalogProjection.connections,
        observed: catalogProjection.observed,
      },
      providers: ids.flatMap(id => {
        const config = this.config.providers[id];
        if (!config) return [];
        const quota = quotas.find(q => q.provider === id);
        const breakerOpts = { failureThreshold: config.allowedFails, cooldownMs: config.cooldownMs };
        return [connectionStatus(id, config, {
          adapterPresent: this.providerAdapter(id) !== undefined,
          cooldownMs: Math.max(0, Math.ceil((this.failures.get(id)?.cooldownUntil ?? 0) - this.now())),
          quota,
          rejection: this.rejections.get(id, config.endpointUrl),
          health: this.health.get(id).state,
          circuit: this.circuits.state(id, config.endpointUrl ?? "", breakerOpts),
          quotaWarning: quotaEarlyWarning(quota, this.resiliencePolicy().quotaWarnRatio),
        })];
      }),
    };
  }
  invalidateProviderCache(provider: ProviderName): Promise<void> {
    this.rejections.clear(provider);
    this.health.clear(provider);
    this.circuits.reset(provider);
    this.performance.clear(provider);
    return this.cache?.invalidateProvider(provider) ?? Promise.resolve();
  }
  /** Round-robin cursor snapshot for persistence/reload. */
  roundRobinCursorSnapshot(): Record<string, number> { return this.rrCursors.snapshot(); }
  /** Restore round-robin cursors after reload. */
  restoreRoundRobinCursors(snapshot: Record<string, number>): void { this.rrCursors.restore(snapshot); }
  /** Per-provider performance snapshot for projection/UI. */
  performanceMetrics(): ProviderPerformanceSnapshot[] { return this.performance.snapshot(); }
  private providerAdapter(name: ProviderName): ProviderAdapter | undefined {
    const existing = this.adapters.get(name);
    if (existing) return existing;
    if (!isUserDefinedProvider(name) || !this.config.providers[name]?.endpointUrl) return undefined;
    // Read the current endpoint on each request so saved edits do not require a restart.
    const adapter = new GenericOpenAIAdapter(name, () => this.config.providers[name]?.endpointUrl ?? "https://example.invalid/v1/chat/completions");
    this.adapters.set(name, adapter);
    return adapter;
  }

  private observeFailover(overheadMs: number): void {
    const bounded = Math.min(86_400_000, overheadMs);
    this.lastFailoverOverheadMs = bounded;
    this.maxFailoverOverheadMs = Math.max(this.maxFailoverOverheadMs ?? 0, bounded);
    if (overheadMs > 500) this.failoverBudgetExceededCount += 1;
    if (!Number.isSafeInteger(this.failoverBudgetExceededCount)) this.failoverBudgetExceededCount = Number.MAX_SAFE_INTEGER;
  }

  private coolingDown(name: ProviderName): boolean { const until = this.failures.get(name)?.cooldownUntil ?? 0; return until > 0 && until > this.now(); }
  private clearFailures(name: ProviderName) { this.failures.delete(name); }
  private recordFailure(provider: ProviderConfig, now: number) {
    if (!isProvider(provider.name)) return;
    const current = this.failures.get(provider.name) ?? { timestamps: [], cooldownUntil: 0 };
    current.timestamps = current.timestamps.filter((timestamp) => timestamp >= now - provider.failureWindowMs);
    current.timestamps.push(now);
    if (current.timestamps.length >= provider.allowedFails) current.cooldownUntil = now + provider.cooldownMs;
    this.failures.set(provider.name, current);
  }
}


function elapsed(now: number, started: number): number { return Math.max(0, now - started); }

async function discardResponse(response: Response): Promise<boolean> { return cancelStreamWithin(response.body); }

function providerCleanupTimeout(requestId: string): Response {
  return Response.json({ error: { type: "provider_cleanup_timeout", request_id: requestId } }, { status: 502, headers: { "cache-control": "no-store" } });
}

export interface LimitProviderResponseOptions {
  preservePartial?: boolean;
  onPartial?: (text: string) => void;
}

export function limitProviderResponse(response: Response, maximum = MAX_PROVIDER_RESPONSE_BYTES, onStreamFailure: () => void = () => undefined, idleTimeoutMs = DEFAULT_PROVIDER_STREAM_IDLE_TIMEOUT_MS, usage?: UsageObserver, options: LimitProviderResponseOptions = {}): Response {
  if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > MAX_PROVIDER_RESPONSE_BYTES) throw new Error("provider_response_limit_invalid");
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 0 || idleTimeoutMs > 120_000) throw new Error("provider_response_idle_timeout_invalid");
  if (!response.body) { usage?.complete(); return response; }
  const reader = response.body.getReader();
  let observed = 0;
  let settled = false;
  let failureObserved = false;
  const decoder = new TextDecoder();
  let partialText = "";
  const contentType = response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  const isSse = contentType === "text/event-stream";
  const settle = () => { if (!settled) { settled = true; reader.releaseLock(); } };
  const observeFailure = () => {
    if (failureObserved) return;
    failureObserved = true;
    usage?.interrupt();
    if (partialText) options.onPartial?.(partialText);
    try { onStreamFailure(); } catch { /* contenção do body permanece fail-closed mesmo se a observação falhar */ }
  };
  const emitPartialTrailer = (controller: ReadableStreamDefaultController<Uint8Array>, reason: string) => {
    if (!options.preservePartial || observed <= 0) return false;
    if (partialText) options.onPartial?.(partialText);
    if (isSse) {
      const trailer = `\n\ndata: ${JSON.stringify({ uptokey: { status: "partial", reason, bytes: observed } })}\n\n`;
      controller.enqueue(new TextEncoder().encode(trailer));
      settle();
      controller.close();
      return true;
    }
    return false;
  };
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const pending = reader.read();
        const idle = Symbol("provider_stream_idle_timeout");
        let timer: ReturnType<typeof setTimeout> | undefined;
        let chunk: Awaited<ReturnType<typeof reader.read>> | typeof idle;
        // Zero disables only post-header silence expiry for an established SSE
        // inference. Adapter connection deadlines, client cancel and byte limits remain.
        try { chunk = idleTimeoutMs === 0 ? await pending : await Promise.race([pending, new Promise<typeof idle>((resolve) => { timer = setTimeout(() => resolve(idle), idleTimeoutMs); })]); }
        finally { if (timer !== undefined) clearTimeout(timer); }
        if (chunk === idle) {
          observeFailure();
          cancelStream(reader, "provider_response_idle_timeout");
          void pending.then(settle, settle);
          if (emitPartialTrailer(controller, "provider_response_idle_timeout")) return;
          controller.error(new Error("provider_response_idle_timeout"));
          return;
        }
        if (chunk.done) { usage?.complete(); settle(); controller.close(); return; }
        observed += chunk.value.byteLength;
        if (options.preservePartial && partialText.length < 65_536) {
          try { partialText += decoder.decode(chunk.value, { stream: true }); } catch { /* ignore decode errors for partial capture */ }
        }
        if (!Number.isSafeInteger(observed) || observed > maximum) {
          observeFailure();
          cancelStream(reader, "provider_response_too_large");
          settle();
          controller.error(new Error("provider_response_too_large"));
          return;
        }
        usage?.chunk(chunk.value);
        controller.enqueue(chunk.value);
      } catch (error) {
        observeFailure();
        if (emitPartialTrailer(controller, "stream_interrupted")) return;
        settle();
        controller.error(error);
      }
    },
    async cancel(reason) { usage?.interrupt(); if (partialText) options.onPartial?.(partialText); try { await cancelStreamWithin(reader, 250, reason); } finally { settle(); } }
  });
  return new Response(body, { status: response.status, headers: response.headers });
}

/** Endpoint and combo revision partition entries: a changed destination or policy never inherits old answers. */
function exactCacheNamespace(endpoint: string, comboId: string | undefined, comboRevision: number | undefined): string {
  return comboId === undefined ? endpoint : JSON.stringify([endpoint, comboId, comboRevision ?? null]);
}

function routeResponse(response: Response, provider: ProviderName, fallbackTriggered: boolean, cacheHit = false, model?: string, meta?: { capabilityDeclaration?: string; switchReason?: string | null; failedProvider?: ProviderName | null; warnings?: string[]; comboId?: string; comboRevision?: number; cacheAgeMs?: number; costClass?: string; costEstimateMicros?: string }): Response {
  const headers = new Headers({ "cache-control": "no-store" });
  const contentType = providerContentType(response.headers.get("content-type")); if (contentType !== undefined) headers.set("content-type", contentType);
  for (const name of ["x-request-id", "x-provider-request-id"]) { const value = providerMetadataHeader(response.headers.get(name)); if (value !== undefined) headers.set(name, value); }

  headers.set("x-uptokey-provider", provider);
  const selectedModel = providerMetadataHeader(model ?? null);
  if (selectedModel !== undefined) headers.set("x-uptokey-model", selectedModel);
  headers.set("x-uptokey-fallback", String(fallbackTriggered));
  headers.set("x-uptokey-cache", cacheHit ? "hit" : "miss");
  // Age of the replayed body (RFC 9111 Age semantics, whole seconds); lets clients label historical output.
  if (cacheHit && meta?.cacheAgeMs !== undefined && Number.isFinite(meta.cacheAgeMs)) headers.set("x-uptokey-cache-age", String(Math.floor(Math.max(0, meta.cacheAgeMs) / 1000)));
  if (meta?.failedProvider) headers.set("x-uptokey-failed-provider", meta.failedProvider);
  if (meta?.switchReason) {
    const reason = providerMetadataHeader(meta.switchReason);
    if (reason) headers.set("x-uptokey-switch-reason", reason);
  }
  if (meta?.warnings?.length) headers.set("x-uptokey-warnings", meta.warnings.join(","));
  if (meta?.comboId) headers.set("x-uptokey-routing-combo", meta.comboId);
  if (meta?.comboRevision !== undefined) headers.set("x-uptokey-routing-revision", String(meta.comboRevision));
  if (meta?.costClass) headers.set("x-uptokey-cost-class", meta.costClass);
  if (meta?.costEstimateMicros) headers.set("x-uptokey-cost-estimate-micros", meta.costEstimateMicros);
  // F2: origin and revision of the declaration that admitted the required capabilities.
  const declaration = providerMetadataHeader(meta?.capabilityDeclaration ?? null);
  if (declaration) headers.set("x-uptokey-capability-declaration", declaration);
  return new Response(response.body, { status: response.status, headers });
}

export function providerMetadataHeader(value: string | null): string | undefined {
  return value !== null && value.length >= 1 && value.length <= 256 && value.trim() === value && /^[\x20-\x7e]+$/.test(value) ? value : undefined;
}

function validProviderContentType(value: string | null, streaming: boolean): boolean {
  return providerContentType(value) === (streaming ? "text/event-stream" : "application/json");
}

function providerContentType(value: string | null): "application/json" | "text/event-stream" | undefined {
  const mediaType = value?.split(";", 1)[0]?.trim().toLowerCase(); return mediaType === "application/json" || mediaType === "text/event-stream" ? mediaType : undefined;
}

function selectModel(provider: ProviderConfig, requested?: string, exact = false): string | undefined {
  if (requested) {
    if (provider.models.includes(requested)) return requested;
    if (provider.modelAliases && provider.modelAliases[requested]) return provider.modelAliases[requested];
    if (exact) return undefined;
  }
  return provider.defaultModel;
}

function supportsRequest(provider: ProviderName, request: ChatCompletionRequest): boolean {
  if (provider === "anthropic") {
    if (requestsJsonOutput(request) || hasNonTextMultimodalParts(request)) return false;
    // Use the same pure conversion as dispatch, before credentials/quota. Native
    // function tools work; unrepresentable history/arguments must not be dropped.
    try { chatCompletionToAnthropicRequest(request); return true; }
    catch { return false; }
  }
  if (provider !== "groq") return true;
  if (requestsStructuredOutput(request) && request.stream === true) return false;
  return !hasNonTextMultimodalParts(request);
}

function hasNonTextMultimodalParts(request: ChatCompletionRequest): boolean {
  return request.messages.some((message) => Array.isArray(message.content) && message.content.some((part) => {
    if (typeof part !== "object" || part === null || Array.isArray(part)) return true;
    const type = (part as Record<string, unknown>).type;
    return type !== "text" && type !== "input_text";
  }));
}

function requestsStructuredOutput(request: ChatCompletionRequest): boolean {
  return typeof request.response_format === "object" && request.response_format !== null && !Array.isArray(request.response_format)
    && (request.response_format as Record<string, unknown>).type === "json_schema";
}

function requestsJsonOutput(request: ChatCompletionRequest): boolean {
  return requestsStructuredOutput(request) || typeof request.response_format === "object" && request.response_format !== null
    && !Array.isArray(request.response_format) && (request.response_format as Record<string, unknown>).type === "json_object";
}

function requestsToolUse(request: ChatCompletionRequest): boolean {
  if (["tools", "tool_choice", "parallel_tool_calls", "functions", "function_call"].some(field => request[field] !== undefined)) return true;
  return request.messages.some(message => message.role === "tool" || message.role === "function" ||
    "tool_calls" in message && message.tool_calls !== undefined || "function_call" in message && message.function_call !== undefined);
}

function parseRetryAfter(value: string | null): number {
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function isConnectionError(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ENOTFOUND", "ECONNREFUSED", "ECONNRESET", "EAI_AGAIN", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

function definitelyNotDispatched(error: unknown): boolean {
  const code = (error as { cause?: { code?: string }; code?: string })?.cause?.code ?? (error as { code?: string })?.code;
  return ["ENOTFOUND", "ECONNREFUSED", "EAI_AGAIN", "CERT_HAS_EXPIRED"].includes(code ?? "");
}

function cancelledResponse(requestId: string): Response {
  return Response.json({ error: { type: "request_cancelled", request_id: requestId } }, { status: 499 });
}

function providerRequestRejected(status: number, provider: ProviderName, fallbackTriggered: boolean, requestId: string, observedReason?: string, outcome?: ResilienceOutcome): Response {
  const providerAuthRejected = status === 401 || status === 403;
  const type = observedReason ?? (providerAuthRejected ? "provider_auth_rejected" : status === 402 ? "provider_credit_exhausted" : "provider_request_rejected");
  const error: Record<string, unknown> = {
    type,
    provider,
    upstream_status: status,
    request_id: requestId,
    provider_used: outcome?.provider_used ?? null,
    provider_failed: outcome?.provider_failed ?? provider,
    switch_reason: outcome?.switch_reason ?? null,
    final_status: outcome?.final_status ?? "fail_fast",
    tokens: outcome?.tokens ?? { basis: "unknown" },
    cost: null,
    warnings: outcome?.warnings ?? [],
    partial_content: outcome?.partial_content ?? null,
    attempts: outcome?.attempts ?? [],
  };
  return Response.json({ error }, { status: providerAuthRejected ? 502 : providerRequestStatus(status), headers: { "cache-control": "no-store", "x-uptokey-provider": provider, "x-uptokey-fallback": String(fallbackTriggered) } });
}

export function providerRequestStatus(status: number): 400 | 404 | 409 | 413 | 422 | 502 {
  return status === 400 || status === 404 || status === 409 || status === 413 || status === 422 ? status : 502;
}

interface RoutingGateAllowed { allowed: true; dataCollectionDenied: boolean; }
interface RoutingGateDenied { allowed: false; reason: string; }
export type CandidateCostClass = "local" | "free_documented" | "priced" | "unknown";

/** Read-only explanation from the same tariff selection used at admission and dispatch. */
export function candidatePricingEvidence(config: ProxyConfig, provider: ProviderName, model: string): CandidatePricingEvidence {
  const accessMode = accessModeFor(config, provider);
  const tariff = findTariff(config.tariffSnapshot, provider, model, accessMode);
  const observed = tariff ?? (config.tariffSnapshot ?? [])
    .filter(entry => entry.provider === provider && entry.model === model && entry.accessMode === accessMode)
    .sort((a,b) => b.version-a.version)[0];
  return {
    provider, model, accessMode,
    classification: classifyCandidateCost(config, provider, model, { input: 0, output: 0 }).classification,
    observationStatus: accessMode === 'local' ? 'local' : tariff ? 'current' : !observed ? 'missing'
      : Date.parse(observed.validFrom) > Date.now() ? 'not_yet_valid' : 'expired',
    // Configuration observations are not live balances or proof of a provider's account plan.
    tariff: observed ? { id: observed.id, version: observed.version, currency: observed.currency, unit: observed.unit,
      inputMicrosPerMillion: observed.inputMicrosPerMillion, outputMicrosPerMillion: observed.outputMicrosPerMillion,
      cachedInputMicrosPerMillion: observed.cachedInputMicrosPerMillion, sourceUrl: observed.sourceUrl,
      checkedAt: observed.checkedAt, validFrom: observed.validFrom, validUntil: observed.validUntil } : null,
  };
}

export function classifyCandidateCost(config: ProxyConfig, provider: ProviderName, model: string, estimate: { input: number; output: number }): { classification: CandidateCostClass; costMicros: bigint | null } {
  const mode = accessModeFor(config, provider);
  if (mode === "local") return { classification: "local", costMicros: 0n };
  const cost = estimateCostMicros(config, provider, model, estimate);
  if (cost === null) return { classification: "unknown", costMicros: null };
  const tariff = findTariff(config.tariffSnapshot, provider, model, mode);
  if (tariff && BigInt(tariff.inputMicrosPerMillion) === 0n && BigInt(tariff.outputMicrosPerMillion) === 0n) return { classification: "free_documented", costMicros: 0n };
  return { classification: "priced", costMicros: cost };
}

type RoutingGateDecision = RoutingGateAllowed | RoutingGateDenied;

function evaluateRoutingPolicy(config: ProxyConfig, provider: ProviderName, model: string, estimate: { input: number; output: number }, requestMode?: "any" | "no_api_charge" | "economic" | "within_limit", requestLimitMicros?: number, accumulatedCostMicros: bigint = 0n): RoutingGateDecision & { classification?: CandidateCostClass; costMicros?: bigint | null } {
  const retention = config.routingPolicy?.retention;
  if (retention?.requireZdr || retention?.denyDataCollection) {
    const evidence = findRetentionEvidence(config.retentionEvidence, provider, model);
    if (!evidence) return { allowed: false, reason: "retention_evidence_missing" };
    if (retention.requireZdr && evidence.zdr !== "yes") return { allowed: false, reason: "zdr_requirement_unmet" };
    if (retention.denyDataCollection && (evidence.dataCollection !== "denied" || evidence.supportsDataCollectionParam !== true)) return { allowed: false, reason: "data_collection_deny_unrepresentable" };
  }
  
  const { classification, costMicros } = classifyCandidateCost(config, provider, model, estimate);
  
  if (requestMode === "no_api_charge") {
    if (classification !== "local" && classification !== "free_documented") {
      return { allowed: false, reason: "cost_policy_blocked" };
    }
  } else if (requestMode === "within_limit" && requestLimitMicros !== undefined) {
    if (classification === "unknown") {
      return { allowed: false, reason: "cost_policy_unknown_cost" };
    }
    if (costMicros !== null && (accumulatedCostMicros + costMicros) > BigInt(requestLimitMicros)) {
      return { allowed: false, reason: "cost_policy_limit_exceeded" };
    }
  }
  
  if (config.routingPolicy?.costCeilingMicros !== undefined && costMicros !== null && costMicros > BigInt(config.routingPolicy.costCeilingMicros)) {
    return { allowed: false, reason: "cost_ceiling_exceeded" };
  }
  return { allowed: true, dataCollectionDenied: retention?.denyDataCollection === true, classification, costMicros };
}

function orderCandidatesByRoutingPolicy(config: ProxyConfig, candidates: RoutingCandidate[], request: ChatCompletionRequest, estimate: { input: number; output: number }, mode: RoutingMode, performance?: ProviderPerformanceTracker, health?: ProviderHealthTracker): RoutingCandidate[] {
  const requestMode = request.uptokey_cost_mode;
  if (requestMode === "economic") {
    return [...candidates].sort((a, b) => {
      const aClass = classifyCandidateCost(config, a.provider, candidateModel(config, a, request), estimate);
      const bClass = classifyCandidateCost(config, b.provider, candidateModel(config, b, request), estimate);
      if (aClass.classification === "unknown" && bClass.classification !== "unknown") return 1;
      if (aClass.classification !== "unknown" && bClass.classification === "unknown") return -1;
      const aCost = aClass.costMicros;
      const bCost = bClass.costMicros;
      if (aCost !== null && bCost !== null && aCost !== bCost) return aCost < bCost ? -1 : 1;
      if (aCost !== null && bCost === null) return -1;
      if (aCost === null && bCost !== null) return 1;
      return 0;
    });
  }
  if (mode === "round_robin") return candidates;
  if (mode === "cost" || mode === "balanced") {
    return [...candidates].sort((a, b) => compareCandidateCost(config, a, b, request, estimate));
  }
  if (mode === "latency" || mode === "throughput" || mode === "quality") {
    const minSamples = config.routingPolicy?.latency?.minSamples ?? 5;
    const sorted = [...candidates].sort((a, b) => compareCandidateByEvidence(config, a, b, request, mode, performance, health, minSamples));
        return sorted;
  }
  if (mode === "auto") {
    return [...candidates].sort((a, b) => {
      const costDiff = compareCandidateCost(config, a, b, request, estimate);
      if (costDiff !== 0) return costDiff;
      return compareCandidateByEvidence(config, a, b, request, "latency", performance, health, 3);
    });
  }
  return candidates;
}

function compareCandidateByEvidence(config: ProxyConfig, a: RoutingCandidate, b: RoutingCandidate, request: ChatCompletionRequest, mode: RoutingMode, performance?: ProviderPerformanceTracker, health?: ProviderHealthTracker, minSamples = 5): number {
  const aPerf = performance?.get(a.provider);
  const bPerf = performance?.get(b.provider);
  const aHasData = aPerf !== undefined && aPerf.sampleCount >= minSamples;
  const bHasData = bPerf !== undefined && bPerf.sampleCount >= minSamples;

  if (mode === "latency") {
    const aLatency = aPerf?.ttftMsEwma ?? aPerf?.totalLatencyMsEwma ?? null;
    const bLatency = bPerf?.ttftMsEwma ?? bPerf?.totalLatencyMsEwma ?? null;
    if (aHasData && bHasData && aLatency !== null && bLatency !== null) {
      return aLatency - bLatency;
    }
    if (aHasData && aLatency !== null) return -1;
    if (bHasData && bLatency !== null) return 1;
  }
  if (mode === "throughput") {
    if (aHasData && bHasData && aPerf!.tokensPerSecondEwma !== null && bPerf!.tokensPerSecondEwma !== null) {
      return bPerf!.tokensPerSecondEwma - aPerf!.tokensPerSecondEwma;
    }
    if (aHasData && aPerf!.tokensPerSecondEwma !== null) return -1;
    if (bHasData && bPerf!.tokensPerSecondEwma !== null) return 1;
  }
  if (mode === "quality") {
    const aHealth = health?.get(a.provider);
    const bHealth = health?.get(b.provider);
    const aScore = computeQualityScore(aPerf, aHealth, minSamples);
    const bScore = computeQualityScore(bPerf, bHealth, minSamples);
    if (aScore !== null && bScore !== null) return bScore - aScore;
    if (aScore !== null) return -1;
    if (bScore !== null) return 1;
  }
  return 0;
}

function computeQualityScore(perf: ProviderPerformanceSnapshot | undefined, health: { state: string; consecutiveSuccesses: number } | undefined, minSamples: number): number | null {
  if (!perf || perf.sampleCount < minSamples) {
    if (health && health.state === "healthy") return 0.5;
    return null;
  }
  const successRate = perf.successRate ?? 0.5;
  const healthBoost = health?.state === "healthy" ? 0.2 : health?.state === "degraded" ? -0.1 : -0.3;
  return Math.max(0, Math.min(1, successRate + healthBoost));
}

function compareCandidateCost(config: ProxyConfig, a: RoutingCandidate, b: RoutingCandidate, request: ChatCompletionRequest, estimate: { input: number; output: number }): number {
  const aCost = estimateCostMicros(config, a.provider, candidateModel(config, a, request), estimate);
  const bCost = estimateCostMicros(config, b.provider, candidateModel(config, b, request), estimate);
  if (aCost !== null && bCost !== null && aCost !== bCost) return aCost < bCost ? -1 : 1;
  if (aCost !== null && bCost === null) return -1;
  if (aCost === null && bCost !== null) return 1;
  return 0;
}

function candidateModel(config: ProxyConfig, candidate: RoutingCandidate, request: ChatCompletionRequest): string {
  if (candidate.model) return candidate.model;
  if (typeof request.model === "string" && !isVirtualModel(request.model)) return request.model;
  return config.providers[candidate.provider]?.defaultModel ?? "";
}

function findRetentionEvidence(entries: RetentionEvidence[] | undefined, provider: ProviderName, model: string): RetentionEvidence | undefined {
  const now = Date.now();
  const candidates = (entries ?? []).filter((entry) => entry.provider === provider && (entry.model === undefined || entry.model === model) && evidenceStillValid(entry.validUntil, now));
  return candidates.sort((a, b) => {
    if ((a.model === model) !== (b.model === model)) return a.model === model ? -1 : 1;
    return b.version - a.version;
  })[0];
}

function evidenceStillValid(validUntil: string | undefined, now: number): boolean {
  if (validUntil === undefined) return true;
  const expires = Date.parse(validUntil);
  return Number.isFinite(expires) && expires > now;
}

function estimateCostMicros(config: ProxyConfig, provider: ProviderName, model: string, estimate: { input: number; output: number }): bigint | null {
  const tariff = findTariff(config.tariffSnapshot, provider, model, accessModeFor(config, provider));
  if (!tariff) return null;
  return divRoundUp(BigInt(estimate.input) * BigInt(tariff.inputMicrosPerMillion) + BigInt(estimate.output) * BigInt(tariff.outputMicrosPerMillion), 1_000_000n);
}

/** One admission tariff snapshot for Router and the governed IPC gateway. */
export function buildDispatchBudgetAttempt(config: ProxyConfig, provider: ProviderName, model: string, id: string,
  estimate: {input: number; output: number}, accountId?: string): DispatchBudgetAttempt {
  const tariff = findTariff(config.tariffSnapshot, provider, model, accessModeFor(config, provider));
  const rates = tariff ? {input:tariff.inputMicrosPerMillion, output:tariff.outputMicrosPerMillion} : null;
  const local = accessModeFor(config, provider) === 'local';
  const priceUsage = (input: number, output: number) => local ? '0' : rates
    ? divRoundUp(BigInt(input) * BigInt(rates.input) + BigInt(output) * BigInt(rates.output), 1_000_000n).toString() : null;
  return {id, provider, model, inputTokens:estimate.input, outputTokens:estimate.output,
    costMicros:priceUsage(estimate.input, estimate.output), accessMode:local ? 'local' : 'byok', priceUsage,
    ...(accountId ? {commercialAccount:{providerId:provider, accountId}} : {})};
}

function findTariff(entries: TariffSnapshotEntry[] | undefined, provider: ProviderName, model: string, accessMode: TariffSnapshotEntry["accessMode"]): TariffSnapshotEntry | undefined {
  const now = Date.now();
  // Only token tariffs price tokens; a per-image/second/character entry never does.
  return (entries ?? [])
    .filter((entry) => entry.provider === provider && entry.model === model && entry.accessMode === accessMode && entry.unit === "million_tokens" && tariffStillValid(entry, now))
    .sort((a, b) => b.version - a.version)[0];
}

/** F1: the current per-unit tariff for this billing dimension; an exact variant wins over a generic one. */
function findUnitTariff(entries: TariffSnapshotEntry[] | undefined, provider: ProviderName, model: string, accessMode: TariffSnapshotEntry["accessMode"], unit: Exclude<TariffSnapshotEntry["unit"], "million_tokens">, variant?: string): TariffSnapshotEntry | undefined {
  const now = Date.now();
  const current = (entries ?? []).filter((entry) => entry.provider === provider && entry.model === model && entry.accessMode === accessMode && entry.unit === unit
    && typeof entry.unitMicros === "string" && tariffStillValid(entry, now)).sort((a, b) => b.version - a.version);
  return current.find((entry) => variant !== undefined && entry.variant === variant) ?? current.find((entry) => entry.variant === undefined);
}

export type MediaBillingUsage = { unit: Exclude<TariffSnapshotEntry["unit"], "million_tokens">; quantity: number; variant?: string };
/**
 * F1: one admission for media executors in the same ledger as tokens. quantity is the reserved
 * amount (images, seconds, characters); settlement prices the actual quantity through priceUsage(q, 0).
 * No current tariff means an unknown price (null), never zero.
 */
export function buildUnitBudgetAttempt(config: ProxyConfig, provider: ProviderName, model: string, id: string, usage: MediaBillingUsage, accountId?: string): DispatchBudgetAttempt & { tariff?: { id: string; version: number } } {
  if (!Number.isSafeInteger(usage.quantity) || usage.quantity < 1) throw new Error("budget_usage_invalid");
  const local = accessModeFor(config, provider) === "local";
  const tariff = local ? undefined : findUnitTariff(config.tariffSnapshot, provider, model, accessModeFor(config, provider), usage.unit, usage.variant);
  const rate = tariff?.unitMicros;
  const priceUsage = (quantity: number, _unused: number) => local ? "0" : rate !== undefined && Number.isSafeInteger(quantity) && quantity >= 0
    ? (BigInt(quantity) * BigInt(rate)).toString() : null;
  return { id, provider, model, inputTokens: usage.quantity, outputTokens: 0, costMicros: priceUsage(usage.quantity, 0), accessMode: local ? "local" : "byok", priceUsage,
    ...(tariff ? { tariff: { id: tariff.id, version: tariff.version } } : {}), ...(accountId ? { commercialAccount: { providerId: provider, accountId } } : {}) };
}

/** F1: per-unit tariffs for the costs view: rate, dimension, source and validity; no balances. */
export function unitTariffEvidence(config: ProxyConfig, provider: ProviderName, model: string) {
  const accessMode = accessModeFor(config, provider), now = Date.now();
  return (config.tariffSnapshot ?? []).filter((entry) => entry.provider === provider && entry.model === model && entry.accessMode === accessMode && entry.unit !== "million_tokens")
    .map((entry) => ({ id: entry.id, version: entry.version, unit: entry.unit, unitMicros: entry.unitMicros ?? null, variant: entry.variant ?? null, currency: entry.currency,
      sourceUrl: entry.sourceUrl, checkedAt: entry.checkedAt, validFrom: entry.validFrom, validUntil: entry.validUntil,
      status: tariffStillValid(entry, now) ? "current" as const : Date.parse(entry.validFrom) > now ? "not_yet_valid" as const : "expired" as const }));
}

function tariffStillValid(entry: TariffSnapshotEntry, now: number): boolean {
  const from = Date.parse(entry.validFrom);
  if (!Number.isFinite(from) || from > now) return false;
  // Open-ended tariff (validUntil null): valid indefinitely from validFrom.
  if (entry.validUntil === null) return true;
  const until = Date.parse(entry.validUntil);
  return Number.isFinite(until) && now < until;
}

function accessModeFor(config: ProxyConfig, provider: ProviderName): TariffSnapshotEntry["accessMode"] {
  const endpoint = config.providers[provider]?.endpointUrl;
  return endpoint && isLocalEndpointUrl(endpoint) ? "local" : "byok";
}

function divRoundUp(numerator: bigint, denominator: bigint): bigint {
  return numerator <= 0n ? 0n : (numerator + denominator - 1n) / denominator;
}


function deprioritizeUnhealthy(order: ProviderName[], healthOf: (name: ProviderName) => string): ProviderName[] {
  const ready: ProviderName[] = [];
  const delayed: ProviderName[] = [];
  for (const name of order) {
    // Only hard-unhealthy providers are deferred; degraded stays in configured order.
    if (healthOf(name) === "unhealthy") delayed.push(name);
    else ready.push(name);
  }
  return [...ready, ...delayed];
}

function scrubbedOutcome(partial: Partial<ResilienceOutcome> & { error?: unknown }): ResilienceOutcome {
  const base = emptyOutcome(partial);
  if (base.partial_content) base.partial_content = scrubText(base.partial_content);
  for (const attempt of base.attempts) {
    attempt.reason = scrubText(attempt.reason);
    if (attempt.action) attempt.action = scrubText(attempt.action);
  }
  for (let i = 0; i < base.warnings.length; i += 1) base.warnings[i] = scrubText(base.warnings[i]!);
  return base;
}

async function sleepWithSignal(sleep: (ms: number) => Promise<void>, ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason ?? new DOMException("aborted", "AbortError");
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_resolve, reject) => {
    onAbort = () => reject(signal.reason ?? new DOMException("aborted", "AbortError"));
    signal.addEventListener("abort", onAbort, { once: true });
  });
  try { await Promise.race([sleep(ms), aborted]); }
  finally { if (onAbort) signal.removeEventListener("abort", onAbort); }
}
