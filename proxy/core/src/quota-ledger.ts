import { randomUUID } from "node:crypto";
import { ledgerPath } from "./paths.ts";
import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import type { ProviderBudget, ProviderName } from "./types.ts";
import { isProvider, MAX_PROVIDERS } from "./provider-registry.ts";
import { settleReservationEstimate, type ReportedObservation, type ReservationSettlement, type ReservationSettlementStatus } from "./token-estimate.ts";
import { isDataRecord as isRecord } from "@uptokey/sync-contract/plain-data";

interface WindowUsage { key: string; requests: number; tokens: number; }

/**
 * Persisted outcome of one reservation against one provider observation. Numeric and
 * identity fields only; it is the durable owner of "was this reservation settled?" so a
 * replayed callback after a restart cannot liquidate it twice.
 */
export interface ReservationSettlementRecord {
  observationKey: string;
  outcome: "complete" | "interrupted" | "cancelled";
  status: ReservationSettlementStatus;
  reservedTotal: number;
  reportedInput: number | null;
  reportedOutput: number | null;
  cachedInput: number | null;
  reasoningOutput: number | null;
  reconciledInput: number | null;
  reconciledOutput: number | null;
  observedAt: string;
}

interface ProviderUsage { minute: WindowUsage; day: WindowUsage; remainingRequests?: number; remainingTokens?: number; requestResetAt?: number; tokenResetAt?: number; providerResetAt?: number; settlements?: Record<string, ReservationSettlementRecord>; }
type LedgerState = Partial<Record<ProviderName, ProviderUsage>>;
/** Bounded per provider; oldest observations are pruned (cumulative state, no loss of quota truth). */
export const MAX_SETTLEMENTS_PER_PROVIDER = 256;
export interface QuotaStatus {
  provider: ProviderName;
  basis: "provider_headers_plus_local_ledger" | "local_device_estimate";
  minute: { requestsUsed: number; requestsLimit: number; tokensUsed: number; tokensLimit: number };
  day: { requestsUsed: number; requestsLimit?: number; tokensUsed: number; tokensLimit?: number };
  providerRemaining?: { requests?: number; tokens?: number; resetAt?: string };
}

export interface Reservation {
  /** Opaque reservation identity: settlement/reconciliation is keyed by it, never by provider or window. */
  id: string;
  provider: ProviderName; minuteKey: string; dayKey: string; requests: number; tokens: number; providerRequests: number; providerTokens: number;
}
export interface QuotaDecision { allowed: boolean; reason?: "rpm" | "tpm" | "rpd" | "tpd" | "provider_remaining" | "clock_rollback" | "invalid_reservation"; reservation?: Reservation; }
interface PendingReservation {
  provider: ProviderName; budget: ProviderBudget; tokens: number; now: Date;
  resolve: (decision: QuotaDecision) => void; reject: (error: unknown) => void;
}

function minuteKey(date: Date) { return date.toISOString().slice(0, 16); }
function dayKey(date: Date) { return date.toISOString().slice(0, 10); }
function windowUsage(key: string): WindowUsage { return { key, requests: 0, tokens: 0 }; }

export class QuotaLedger {
  private state: LedgerState = {};
  private queue: Promise<unknown> = Promise.resolve();
  private pendingReservations: PendingReservation[] | undefined;
  private readonly compensatedReservations = new WeakSet<Reservation>();
  private readonly path: string;
  constructor(path = ledgerPath()) { this.path = path; }

  async initialize(): Promise<void> {
    this.state = await readJson(this.path, {});
    validateLedgerState(this.state);
    const groq = this.state.groq;
    if (!groq) return;
    const before = JSON.stringify(groq); expireProviderRemaining(groq, Date.now());
    if (groq.remainingRequests !== undefined && groq.requestResetAt === undefined && groq.providerResetAt === undefined) delete groq.remainingRequests;
    if (groq.remainingTokens !== undefined && groq.tokenResetAt === undefined && groq.providerResetAt === undefined) delete groq.remainingTokens;
    if (JSON.stringify(groq) !== before) await writeJsonAtomic(this.path, this.state);
  }

  async reserve(provider: ProviderName, budget: ProviderBudget, tokens: number, now = new Date()): Promise<QuotaDecision> {
    // Only adjacent reservations share a durable commit. Compensation and remote
    // reconciliation remain ordering barriers on the same queue.
    let batch = this.pendingReservations;
    if (!batch || batch.length >= 64) {
      batch = [];
      const captured = batch;
      void this.serial(async () => {
        // Collect arrivals in this I/O turn without a timer or relaxed durability.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.pendingReservations === captured) this.pendingReservations = undefined;
        let nextState = this.state;
        const results: QuotaDecision[] = [];
        try {
          for (const item of captured) {
            const planned = this.planReservation(nextState, item.provider, item.budget, item.tokens, item.now);
            nextState = planned.state;
            results.push(planned.decision);
          }
          if (nextState !== this.state) await writeJsonAtomic(this.path, nextState);
          this.state = nextState;
          captured.forEach((item, index) => item.resolve(results[index]!));
        } catch (error) {
          // No reservation is exposed until the entire snapshot is durable.
          // Failed commits leave the prior state and all quota available to retry.
          captured.forEach((item) => item.reject(error));
        }
      });
      this.pendingReservations = batch;
    }
    return new Promise<QuotaDecision>((resolve, reject) => {
      batch.push({ provider, budget: { ...budget }, tokens, now: new Date(now.getTime()), resolve, reject });
    });
  }

  private planReservation(state: LedgerState, provider: ProviderName, budget: ProviderBudget, tokens: number, now: Date): { state: LedgerState; decision: QuotaDecision } {
    const decide = (decision: QuotaDecision) => ({ state, decision });
      if (!isProvider(provider) || !nonnegativeSafeInteger(tokens) || !Number.isFinite(now.getTime())) return decide({ allowed: false, reason: "invalid_reservation" });
      const minute = minuteKey(now), day = dayKey(now);
      const usage = state[provider] ? structuredClone(state[provider]) : { minute: windowUsage(minute), day: windowUsage(day) };
      if (usage.minute.key > minute || usage.day.key > day) return decide({ allowed: false, reason: "clock_rollback" });
      if (usage.minute.key !== minute) usage.minute = windowUsage(minute);
      if (usage.day.key !== day) usage.day = windowUsage(day);
      expireProviderRemaining(usage, now.getTime());
      const checks: Array<[boolean, QuotaDecision["reason"]]> = [
        [usage.minute.requests + 1 <= budget.rpm, "rpm"],
        [usage.minute.tokens + tokens <= budget.tpm, "tpm"],
        [budget.rpd === undefined || usage.day.requests + 1 <= budget.rpd, "rpd"],
        [budget.tpd === undefined || usage.day.tokens + tokens <= budget.tpd, "tpd"],
        [usage.remainingRequests === undefined || usage.remainingRequests > 0, "provider_remaining"],
        [usage.remainingTokens === undefined || usage.remainingTokens >= tokens, "provider_remaining"]
      ];
      const denied = checks.find(([ok]) => !ok);
      if (denied) return decide({ allowed: false, reason: denied[1] });
      const providerRequests = usage.remainingRequests === undefined ? 0 : 1;
      const providerTokens = usage.remainingTokens === undefined ? 0 : tokens;
      usage.minute.requests += 1; usage.minute.tokens += tokens;
      usage.day.requests += 1; usage.day.tokens += tokens;
      if (usage.remainingRequests !== undefined) usage.remainingRequests -= 1;
      if (usage.remainingTokens !== undefined) usage.remainingTokens -= tokens;
      return { state: { ...state, [provider]: usage }, decision: { allowed: true, reservation: { id: randomUUID(), provider, minuteKey: minute, dayKey: day, requests: 1, tokens, providerRequests, providerTokens } } };
  }

  async compensateConnectionFailure(reservation: Reservation): Promise<void> {
    await this.serial(async () => {
      if (this.compensatedReservations.has(reservation)) return;
      const current = this.state[reservation.provider];
      if (!current) { this.compensatedReservations.add(reservation); return; }
      const usage = structuredClone(current);
      if (usage.minute.key === reservation.minuteKey) {
        usage.minute.requests = Math.max(0, usage.minute.requests - reservation.requests);
        usage.minute.tokens = Math.max(0, usage.minute.tokens - reservation.tokens);
      }
      if (usage.day.key === reservation.dayKey) {
        usage.day.requests = Math.max(0, usage.day.requests - reservation.requests);
        usage.day.tokens = Math.max(0, usage.day.tokens - reservation.tokens);
      }
      if (usage.remainingRequests !== undefined && reservation.providerRequests > 0) usage.remainingRequests = Math.min(Number.MAX_SAFE_INTEGER, usage.remainingRequests + reservation.providerRequests);
      if (usage.remainingTokens !== undefined && reservation.providerTokens > 0) usage.remainingTokens = Math.min(Number.MAX_SAFE_INTEGER, usage.remainingTokens + reservation.providerTokens);
      const nextState = { ...this.state, [reservation.provider]: usage };
      await writeJsonAtomic(this.path, nextState);
      this.state = nextState;
      this.compensatedReservations.add(reservation);
    });
  }

  async reconcileGroq(headers: Headers, now = new Date()): Promise<void> {
    return this.reconcileProvider("groq", headers, now);
  }

  /**
   * Reconciles remote quota from any provider's official rate-limit headers.
   * Accepts the OpenAI/Groq family (duration resets) and the Anthropic family
   * (absolute datetime resets). Remaining values only ever decrease (min-merge)
   * so concurrent responses cannot inflate quota. A pair is applied only when
   * both the remaining counter and its reset are present and valid; anything
   * else is ignored — an unparseable header never invents quota.
   */
  async reconcileProvider(provider: ProviderName, headers: Headers, now = new Date()): Promise<void> {
    if (!isProvider(provider) || !Number.isFinite(now.getTime())) return;
    const observed = parseProviderQuotaHeaders(headers, now.getTime());
    if (!observed) return;
    await this.serial(async () => {
      const current = this.state[provider];
      if (!current) return;
      if (current.minute.key > minuteKey(now) || current.day.key > dayKey(now)) return;
      const usage = structuredClone(current);
      expireProviderRemaining(usage, now.getTime());
      if (observed.requests !== undefined) { usage.remainingRequests = Math.min(usage.remainingRequests ?? observed.requests, observed.requests); usage.requestResetAt = observed.requestsResetAt; }
      if (observed.tokens !== undefined) { usage.remainingTokens = Math.min(usage.remainingTokens ?? observed.tokens, observed.tokens); usage.tokenResetAt = observed.tokensResetAt; }
      // Per-dimension observed resets supersede any legacy combined reset.
      delete usage.providerResetAt;
      const nextState = { ...this.state, [provider]: usage };
      await writeJsonAtomic(this.path, nextState);
      this.state = nextState;
    });
  }

  snapshot(): LedgerState { return structuredClone(this.state); }

  /** Persisted settlement of one reservation, if any (audit/tests; never used for decisions). */
  settlementRecord(provider: ProviderName, reservationId: string): ReservationSettlementRecord | undefined {
    const record = this.state[provider]?.settlements?.[reservationId];
    return record ? structuredClone(record) : undefined;
  }

  /**
   * Liquida uma reserva contra uma observação do provedor, no dono persistente da quota.
   * A liquidação é idempotente por identidade da reserva (`id`, persistida no ledger):
   * refazer a chamada após reinício retorna `duplicate` e não corrige as janelas duas vezes.
   * - Uso reportado válido reconcilia as janelas locais minuto/dia pelo delta (substitui a
   *   estimativa reservada, sem somar duas vezes); `remaining` remoto continua governado
   *   pelos headers, nunca inflado por esta correção.
   * - Ausência de uso vira `no-usage` com valores nulos (nunca zero).
   * - Cancelamento/ interrupção sem uso ficam `*-unknown` com valores nulos (a reserva
   *   permanece conservadora; nenhuma quantidade é inventada).
   * - Reservas compensadas localmente nunca reconciliam.
   * Uma observação tardia válida pode promover um registro unknown para `reconciled` uma
   * única vez; depois disso qualquer nova observação da mesma reserva é `duplicate`.
   */
  async settleReportedUsage(reservation: Reservation, observation: ReportedObservation | null, now = new Date()): Promise<ReservationSettlement> {
    if (!isProvider(reservation.provider) || !nonnegativeSafeInteger(reservation.tokens) || !validSettlementId(reservation.id)) {
      return settlementResult("", "no-usage", nonnegativeSafeInteger(reservation.tokens) ? reservation.tokens : 0, null, "invalid-reservation-ignored: no ledger effect");
    }
    if (this.compensatedReservations.has(reservation)) {
      return settlementResult(observation?.key ?? "", "no-usage", reservation.tokens, null, "reservation-was-compensated: nothing to reconcile");
    }
    if (!Number.isFinite(now.getTime())) {
      return settlementResult(observation?.key ?? "", "no-usage", reservation.tokens, null, "invalid-observation-time: no ledger effect");
    }
    return this.serial(async () => {
      const current = this.state[reservation.provider];
      const usage = current ? structuredClone(current) : { minute: windowUsage(reservation.minuteKey), day: windowUsage(reservation.dayKey) };
      const settlements = { ...(usage.settlements ?? {}) };
      const existing = settlements[reservation.id];
      if (existing) {
        if (existing.status === "reconciled" || (observation !== null && existing.observationKey === observation.key)) {
          return settlementFromRecord(existing, "duplicate", "duplicate-settlement: reservation already settled; not applied twice");
        }
      }
      const settled = settleReservationEstimate({ total: reservation.tokens }, observation, []);
      const record: ReservationSettlementRecord = {
        observationKey: settled.key.length > 0 ? settled.key : "no-observation",
        outcome: observation?.outcome ?? "complete",
        status: settled.status,
        reservedTotal: reservation.tokens,
        reportedInput: settled.reportedInput,
        reportedOutput: settled.reportedOutput,
        cachedInput: settled.cachedInput,
        reasoningOutput: settled.reasoningOutput,
        reconciledInput: settled.reconciledInput,
        reconciledOutput: settled.reconciledOutput,
        observedAt: now.toISOString(),
      };
      settlements[reservation.id] = record;
      pruneSettlements(settlements);
      // The reserved estimate is replaced by the reported delta exactly once per reservation.
      if (settled.status === "reconciled" && settled.reconciledInput !== null && settled.reconciledOutput !== null) {
        const delta = settled.reconciledInput + settled.reconciledOutput - reservation.tokens;
        if (usage.minute.key === reservation.minuteKey) usage.minute.tokens = Math.max(0, usage.minute.tokens + delta);
        if (usage.day.key === reservation.dayKey) usage.day.tokens = Math.max(0, usage.day.tokens + delta);
      }
      usage.settlements = settlements;
      const nextState = { ...this.state, [reservation.provider]: usage };
      await writeJsonAtomic(this.path, nextState);
      this.state = nextState;
      return settled;
    });
  }

  status(config: Partial<Record<ProviderName, ProviderBudget>>, now = new Date()): QuotaStatus[] {
    const minute = minuteKey(now), day = dayKey(now);
    return Object.keys(config).filter(isProvider).filter((provider) => config[provider] !== undefined).map((provider) => {
      const budget = config[provider]; const usage = this.state[provider];
      if (!budget) throw new Error("quota_status_budget_missing");
      const minuteUsage = usage?.minute.key === minute ? usage.minute : windowUsage(minute);
      const dayUsage = usage?.day.key === day ? usage.day : windowUsage(day);
      /** Basis follows observed remote headers (any provider), not the provider name. */
      const providerView = providerRemainingView(usage, now.getTime());
      return {
        provider, basis: providerView ? "provider_headers_plus_local_ledger" : "local_device_estimate",
        minute: { requestsUsed: minuteUsage.requests, requestsLimit: budget.rpm, tokensUsed: minuteUsage.tokens, tokensLimit: budget.tpm },
        day: { requestsUsed: dayUsage.requests, ...(budget.rpd !== undefined ? { requestsLimit: budget.rpd } : {}), tokensUsed: dayUsage.tokens, ...(budget.tpd !== undefined ? { tokensLimit: budget.tpd } : {}) },
        ...(providerView ? { providerRemaining: providerView } : {})
      };
    });
  }

  private async serial<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingReservations = undefined;
    const next = this.queue.then(operation, operation);
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}

function settlementResult(key: string, status: ReservationSettlementStatus, reservedTotal: number, _reported: null, note: string): ReservationSettlement {
  return { key, status, reservedTotal, reportedInput: null, reportedOutput: null, cachedInput: null, reasoningOutput: null, reconciledInput: null, reconciledOutput: null, note };
}

function settlementFromRecord(record: ReservationSettlementRecord, status: ReservationSettlementStatus, note: string): ReservationSettlement {
  return {
    key: record.observationKey, status, reservedTotal: record.reservedTotal,
    reportedInput: record.reportedInput, reportedOutput: record.reportedOutput,
    cachedInput: record.cachedInput, reasoningOutput: record.reasoningOutput,
    reconciledInput: record.reconciledInput, reconciledOutput: record.reconciledOutput, note,
  };
}

function pruneSettlements(settlements: Record<string, ReservationSettlementRecord>): void {
  const keys = Object.keys(settlements);
  if (keys.length <= MAX_SETTLEMENTS_PER_PROVIDER) return;
  keys.sort((a, b) => {
    const left = Date.parse(settlements[a]!.observedAt); const right = Date.parse(settlements[b]!.observedAt);
    return (Number.isFinite(left) ? left : 0) - (Number.isFinite(right) ? right : 0);
  });
  for (const key of keys.slice(0, keys.length - MAX_SETTLEMENTS_PER_PROVIDER)) delete settlements[key];
}

function validSettlementId(value: unknown): value is string {
  return typeof value === "string" && value.length >= 1 && value.length <= 100 && /^[A-Za-z0-9_-]+$/.test(value);
}

const SETTLEMENT_STATUSES: readonly ReservationSettlementStatus[] = ["reconciled", "no-usage", "duplicate", "cancelled-unknown", "interrupted-unknown"];
const SETTLEMENT_OUTCOMES = ["complete", "interrupted", "cancelled"] as const;

function validSettlementRecord(value: unknown): boolean {
  if (!isRecord(value)) return false;
  const allowed = ["observationKey", "outcome", "status", "reservedTotal", "reportedInput", "reportedOutput", "cachedInput", "reasoningOutput", "reconciledInput", "reconciledOutput", "observedAt"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) return false;
  if (typeof value.observationKey !== "string" || value.observationKey.length < 1 || value.observationKey.length > 200) return false;
  if (typeof value.outcome !== "string" || !SETTLEMENT_OUTCOMES.includes(value.outcome as (typeof SETTLEMENT_OUTCOMES)[number])) return false;
  if (typeof value.status !== "string" || !SETTLEMENT_STATUSES.includes(value.status as ReservationSettlementStatus)) return false;
  if (!nonnegativeSafeInteger(value.reservedTotal)) return false;
  const nullable = (candidate: unknown): boolean => candidate === null || nonnegativeSafeInteger(candidate);
  if (!["reportedInput", "reportedOutput", "cachedInput", "reasoningOutput", "reconciledInput", "reconciledOutput"].every((key) => nullable(value[key]))) return false;
  if (typeof value.observedAt !== "string" || !validSettlementDate(value.observedAt)) return false;
  if (nonnegativeSafeInteger(value.cachedInput) && nonnegativeSafeInteger(value.reportedInput) && value.cachedInput > value.reportedInput) return false;
  if (nonnegativeSafeInteger(value.reasoningOutput) && nonnegativeSafeInteger(value.reportedOutput) && value.reasoningOutput > value.reportedOutput) return false;
  const reconciled = value.status === "reconciled";
  if (reconciled !== (nonnegativeSafeInteger(value.reconciledInput) && nonnegativeSafeInteger(value.reconciledOutput))) return false;
  return true;
}

function validSettlementDate(value: string): boolean {
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function numberHeader(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (value === null || !/^(?:0|[1-9]\d{0,9})$/.test(value)) return undefined;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed <= 1_000_000_000 ? parsed : undefined;
}

function durationHeaderMs(headers: Headers, name: string): number | undefined {
  const value = headers.get(name);
  if (!value) return undefined;
  const match = value.match(/^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+(?:\.\d+)?)s)?$/);
  if (!match) return undefined;
  const hours = Number(match[1] ?? 0), minutes = Number(match[2] ?? 0), seconds = Number(match[3] ?? 0);
  if (minutes >= 60 || seconds >= 60) return undefined;
  const duration = (hours * 3_600 + minutes * 60 + seconds) * 1_000;
  return Number.isSafeInteger(duration) && duration > 0 && duration <= 24 * 60 * 60_000 ? duration : undefined;
}

/** Absolute-datetime reset (e.g. Anthropic HTTP-date/RFC-3339); bounded to 24h like duration resets. */
function absoluteResetAt(headers: Headers, name: string, nowMs: number): number | undefined {
  const value = headers.get(name);
  if (!value) return undefined;
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return undefined;
  const delta = parsed - nowMs;
  return delta > 0 && delta <= 24 * 60 * 60_000 ? parsed : undefined;
}

interface ObservedQuotaHeaders { requests: number | undefined; requestsResetAt: number | undefined; tokens: number | undefined; tokensResetAt: number | undefined; }

const QUOTA_HEADER_FAMILIES: ReadonlyArray<{
  requestsRemaining: string; requestsReset: string; tokensRemaining: string; tokensReset: string; resetKind: "duration" | "absolute";
}> = [
  { requestsRemaining: "x-ratelimit-remaining-requests", requestsReset: "x-ratelimit-reset-requests", tokensRemaining: "x-ratelimit-remaining-tokens", tokensReset: "x-ratelimit-reset-tokens", resetKind: "duration" },
  { requestsRemaining: "anthropic-ratelimit-requests-remaining", requestsReset: "anthropic-ratelimit-requests-reset", tokensRemaining: "anthropic-ratelimit-tokens-remaining", tokensReset: "anthropic-ratelimit-tokens-reset", resetKind: "absolute" },
];

/**
 * Returns the first header family yielding at least one complete
 * (remaining, reset) pair. An incomplete or unparsable pair is never applied.
 */
function parseProviderQuotaHeaders(headers: Headers, nowMs: number): ObservedQuotaHeaders | undefined {
  for (const family of QUOTA_HEADER_FAMILIES) {
    const requests = numberHeader(headers, family.requestsRemaining);
    const tokens = numberHeader(headers, family.tokensRemaining);
    const requestsResetAt = family.resetKind === "duration"
      ? (() => { const ms = durationHeaderMs(headers, family.requestsReset); return ms === undefined ? undefined : nowMs + ms; })()
      : absoluteResetAt(headers, family.requestsReset, nowMs);
    const tokensResetAt = family.resetKind === "duration"
      ? (() => { const ms = durationHeaderMs(headers, family.tokensReset); return ms === undefined ? undefined : nowMs + ms; })()
      : absoluteResetAt(headers, family.tokensReset, nowMs);
    const requestsPair = requests !== undefined && requestsResetAt !== undefined;
    const tokensPair = tokens !== undefined && tokensResetAt !== undefined;
    if (requestsPair || tokensPair) {
      return {
        requests: requestsPair ? requests : undefined,
        requestsResetAt: requestsPair ? requestsResetAt : undefined,
        tokens: tokensPair ? tokens : undefined,
        tokensResetAt: tokensPair ? tokensResetAt : undefined,
      };
    }
  }
  return undefined;
}

function expireProviderRemaining(usage: ProviderUsage, nowMs: number): void {
  if (usage.providerResetAt !== undefined && nowMs >= usage.providerResetAt) { delete usage.remainingRequests; delete usage.remainingTokens; delete usage.providerResetAt; }
  if (usage.requestResetAt !== undefined && nowMs >= usage.requestResetAt) { delete usage.remainingRequests; delete usage.requestResetAt; }
  if (usage.tokenResetAt !== undefined && nowMs >= usage.tokenResetAt) { delete usage.remainingTokens; delete usage.tokenResetAt; }
}

function providerRemainingView(usage: ProviderUsage | undefined, nowMs: number): QuotaStatus["providerRemaining"] | undefined {
  if (!usage) return undefined;
  const legacyCurrent = usage.providerResetAt !== undefined && usage.providerResetAt > nowMs;
  const requestsCurrent = legacyCurrent || (usage.requestResetAt !== undefined && usage.requestResetAt > nowMs);
  const tokensCurrent = legacyCurrent || (usage.tokenResetAt !== undefined && usage.tokenResetAt > nowMs);
  if ((!requestsCurrent || usage.remainingRequests === undefined) && (!tokensCurrent || usage.remainingTokens === undefined)) return undefined;
  const resetAt = Math.max(requestsCurrent ? usage.requestResetAt ?? usage.providerResetAt ?? 0 : 0, tokensCurrent ? usage.tokenResetAt ?? usage.providerResetAt ?? 0 : 0);
  return { ...(requestsCurrent && usage.remainingRequests !== undefined ? { requests: usage.remainingRequests } : {}), ...(tokensCurrent && usage.remainingTokens !== undefined ? { tokens: usage.remainingTokens } : {}), ...(resetAt > 0 ? { resetAt: new Date(resetAt).toISOString() } : {}) };
}

function validateLedgerState(value: unknown): asserts value is LedgerState {
  if (!isRecord(value) || Object.keys(value).length > MAX_PROVIDERS || Object.keys(value).some((key) => !isProvider(key))) throw new Error("quota_ledger_invalid");
  for (const [provider, raw] of Object.entries(value)) {
    if (!isProvider(provider)) throw new Error("quota_ledger_invalid");
    if (!isRecord(raw) || Object.keys(raw).some((key) => !["minute", "day", "remainingRequests", "remainingTokens", "requestResetAt", "tokenResetAt", "providerResetAt", "settlements"].includes(key))) throw new Error("quota_ledger_invalid");
    if (!validWindow(raw.minute, "minute") || !validWindow(raw.day, "day")) throw new Error("quota_ledger_invalid");
    if (raw.settlements !== undefined) {
      if (!isRecord(raw.settlements) || Object.keys(raw.settlements).length > MAX_SETTLEMENTS_PER_PROVIDER) throw new Error("quota_ledger_invalid");
      for (const [settlementId, record] of Object.entries(raw.settlements)) {
        if (!validSettlementId(settlementId) || !validSettlementRecord(record)) throw new Error("quota_ledger_invalid");
      }
    }
    for (const key of ["remainingRequests", "remainingTokens"] as const) if (raw[key] !== undefined && !nonnegativeSafeInteger(raw[key])) throw new Error("quota_ledger_invalid");
    for (const key of ["requestResetAt", "tokenResetAt", "providerResetAt"] as const) if (raw[key] !== undefined && !validEpochMs(raw[key])) throw new Error("quota_ledger_invalid");
    if (raw.requestResetAt !== undefined && raw.remainingRequests === undefined) throw new Error("quota_ledger_invalid");
    if (raw.tokenResetAt !== undefined && raw.remainingTokens === undefined) throw new Error("quota_ledger_invalid");
    if (raw.providerResetAt !== undefined && raw.remainingRequests === undefined && raw.remainingTokens === undefined) throw new Error("quota_ledger_invalid");
  }
}

function validWindow(value: unknown, kind: "minute" | "day"): boolean { return isRecord(value) && Object.keys(value).sort().join(",") === "key,requests,tokens" && typeof value.key === "string" && validWindowKey(value.key, kind) && nonnegativeSafeInteger(value.requests) && nonnegativeSafeInteger(value.tokens); }
function validWindowKey(value: string, kind: "minute" | "day"): boolean {
  const parsed = Date.parse(kind === "minute" ? `${value}:00.000Z` : `${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed)) return false;
  const canonical = new Date(parsed).toISOString();
  return (kind === "minute" ? canonical.slice(0, 16) : canonical.slice(0, 10)) === value;
}
function validEpochMs(value: unknown): value is number { return nonnegativeSafeInteger(value) && value <= 8_640_000_000_000_000; }
function nonnegativeSafeInteger(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
