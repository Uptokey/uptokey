/**
 * Usage Value Reference Engine (W6)
 * Aligned with docs/FIVE-COMPONENTS-ENGINEERING-PLAN.md Section 13
 * and W0 shared contracts from @uptokey/sync-contract/workflow.
 */

import {
  type ReferenceTariff,
  type UsageValueReceipt,
  type RationalMicros,
  type AccessMode,
  type TokenUsage,
  parseReferenceTariff,
  parseUsageValueReceipt,
} from "@uptokey/sync-contract/workflow";
import { VERIFIED_REFERENCE_TARIFFS, EXPANDED_PRIMARY_SOURCE_TARIFFS } from './reference-tariffs.ts';

export interface UsageValueInput {
  readonly projectId: string;
  readonly runId: string;
  readonly stepId: string;
  readonly attemptId: string;
  readonly provider: string;
  readonly model: string;
  readonly accessMode: AccessMode;
  readonly usage?: TokenUsage;
  readonly cache?: "none" | "provider" | "local";
  readonly tariffVersion?: number;
  readonly checkedAt?: string;
  /** For media operations: number of units consumed (images, seconds, characters, megapixels). */
  readonly mediaUnits?: number;
}

export interface MonthlyUsageSummary {
  readonly period: string;
  readonly totalReferenceValue: RationalMicros;
  readonly totalReferenceMicros: bigint;
  readonly totalConfirmedUptokeyCharge: RationalMicros;
  readonly totalConfirmedUptokeyChargeMicros: bigint;
  readonly totalEstimatedProviderCharge: RationalMicros;
  readonly totalEstimatedProviderChargeMicros: bigint;
  readonly totalObservedCalls: number;
  readonly includedCalls: number;
  readonly missingUsageCalls: number;
  readonly unpricedOrLocalCalls: number;
}

/**
 * Pure integer arithmetic for micro-USD calculation.
 * Returns rational representation { numeratorMicros, denominator: "1000000" }.
 * (inputTokens - cached) * inputRate + cached * cachedRate + outputTokens * outputRate
 */
export function calculateUsageRational(
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens: number = 0,
  inputMicrosPerMillion: string,
  outputMicrosPerMillion: string,
  cachedInputMicrosPerMillion: string | null = null
): RationalMicros {
  const inRate = BigInt(inputMicrosPerMillion);
  const outRate = BigInt(outputMicrosPerMillion);
  const cacheRate = cachedInputMicrosPerMillion !== null ? BigInt(cachedInputMicrosPerMillion) : inRate;

  const uncachedInput = BigInt(inputTokens - cachedInputTokens);
  const cachedBig = BigInt(cachedInputTokens);
  const outBig = BigInt(outputTokens);

  const numerator =
    uncachedInput * inRate +
    cachedBig * cacheRate +
    outBig * outRate;

  return {
    numeratorMicros: numerator.toString(),
    denominator: "1000000",
  };
}

/**
 * Per-unit calculation for media operations (images, seconds, characters, megapixels).
 * Returns rational representation { numeratorMicros, denominator: "1" }.
 * units * priceMicrosPerUnit = total microdollars.
 */
export function calculateMediaUsageRational(
  units: number,
  priceMicrosPerUnit: string,
): RationalMicros {
  const rate = BigInt(priceMicrosPerUnit);
  const count = BigInt(units);
  return {
    numeratorMicros: (count * rate).toString(),
    denominator: "1",
  };
}

/**
 * Official reference tariffs catalog.
 *
 * Current Policy: Only verified, dated primary-source observations are active.
 * See reference-tariffs.ts and docs/handoffs/workflow-tariff-evidence.md.
 * All unverified/missing tariffs produce coverage: "missing_tariff" with referenceValue: null.
 *
 * Historical Research Reference (retained for documentation; inactive until primary verification):
 * - Moonshot Kimi K3 (research from uptokey-architecture/09-BUSINESS/ANEXO-PESQUISA-INSUMO-MAESTRO-2026-08-31.json lines 1188-1215):
 *   Provider: "moonshot", Model: "kimi-k3", AccessMode: "byok"
 *   Input: $3.00/M (3000000 micros), Output: $15.00/M (15000000 micros)
 *   Source: https://platform.kimi.ai/docs/pricing/chat-k3.md
 */
export const OFFICIAL_REFERENCE_TARIFFS: readonly ReferenceTariff[] = VERIFIED_REFERENCE_TARIFFS;
export { EXPANDED_PRIMARY_SOURCE_TARIFFS } from './reference-tariffs.ts';

/**
 * Adds two rational micro-USD amounts exactly without loss of sub-microdollar fractions.
 */
function addRationalMicros(
  acc: { numerator: bigint; denominator: bigint },
  item: RationalMicros
): { numerator: bigint; denominator: bigint } {
  const itemNum = BigInt(item.numeratorMicros);
  const itemDen = BigInt(item.denominator);

  if (acc.denominator === itemDen) {
    return {
      numerator: acc.numerator + itemNum,
      denominator: acc.denominator,
    };
  }

  return {
    numerator: acc.numerator * itemDen + itemNum * acc.denominator,
    denominator: acc.denominator * itemDen,
  };
}

/**
 * Rounds rational micro-USD up to integer microdollars once at the final accumulation stage.
 */
function roundRationalUp(acc: { numerator: bigint; denominator: bigint }): bigint {
  if (acc.numerator === 0n || acc.denominator === 0n) return 0n;
  return (acc.numerator + acc.denominator - 1n) / acc.denominator;
}

export class UsageValueEngine {
  private readonly tariffs = new Map<string, ReferenceTariff>();
  private readonly receipts = new Map<string, UsageValueReceipt>();

  constructor(initialTariffs: readonly ReferenceTariff[] = OFFICIAL_REFERENCE_TARIFFS) {
    for (const t of initialTariffs) {
      this.registerTariff(t);
    }
  }

  registerTariff(tariff: ReferenceTariff): void {
    const parsed = parseReferenceTariff(tariff);
    this.tariffs.set(parsed.id, parsed);
  }

  /**
   * Finds the valid reference tariff respecting provider, model, accessMode, and validity dates.
   */
  findTariff(
    provider: string,
    model: string,
    accessMode: AccessMode,
    atDate: string = new Date().toISOString(),
    version?: number
  ): ReferenceTariff | undefined {
    const candidates = Array.from(this.tariffs.values()).filter((t) => {
      if (t.provider !== provider || t.model !== model || t.accessMode !== accessMode) {
        return false;
      }
      if (version !== undefined && t.version !== version) {
        return false;
      }
      // Validity window check
      if (atDate < t.validFrom) {
        return false;
      }
      if (t.validUntil !== null && atDate > t.validUntil) {
        return false;
      }
      return true;
    });

    if (candidates.length === 0) return undefined;
    // Prefer most recent version
    candidates.sort((a, b) => b.version - a.version);
    return candidates[0];
  }

  recordUsageValue(input: UsageValueInput): UsageValueReceipt {
    const existing = this.receipts.get(input.attemptId);
    if (existing) return existing;

    const createdAt = input.checkedAt ?? new Date().toISOString();
    const cache = input.cache ?? "none";
    const zeroCharge: RationalMicros = { numeratorMicros: "0", denominator: "1" };

    // Case 1: Local cache hit
    if (cache === "local") {
      const receipt = parseUsageValueReceipt({
        schemaVersion: 1,
        id: `val_${input.attemptId}`,
        createdAt,
        projectId: input.projectId,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        provider: input.provider,
        model: input.model,
        accessMode: input.accessMode,
        cache: "local",
        usage: input.usage ?? { basis: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null },
        tariffId: null,
        tariffVersion: null,
        referenceValue: null,
        estimatedProviderCharge: null,
        confirmedUptokeyCharge: zeroCharge,
        coverage: "local_cache",
      });
      this.receipts.set(input.attemptId, receipt);
      return receipt;
    }

    // Case 2: Missing usage
    if (!input.usage || input.usage.basis === "unknown" || input.usage.inputTokens === null || input.usage.outputTokens === null) {
      const receipt = parseUsageValueReceipt({
        schemaVersion: 1,
        id: `val_${input.attemptId}`,
        createdAt,
        projectId: input.projectId,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        provider: input.provider,
        model: input.model,
        accessMode: input.accessMode,
        cache,
        usage: input.usage ?? { basis: "unknown", inputTokens: null, outputTokens: null, cachedInputTokens: null },
        tariffId: null,
        tariffVersion: null,
        referenceValue: null,
        estimatedProviderCharge: null,
        confirmedUptokeyCharge: zeroCharge,
        coverage: "missing_usage",
      });
      this.receipts.set(input.attemptId, receipt);
      return receipt;
    }

    // Case 3: Local hardware runtime (Ollama)
    if (input.accessMode === "local") {
      const receipt = parseUsageValueReceipt({
        schemaVersion: 1,
        id: `val_${input.attemptId}`,
        createdAt,
        projectId: input.projectId,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        provider: input.provider,
        model: input.model,
        accessMode: "local",
        cache,
        usage: input.usage,
        tariffId: null,
        tariffVersion: null,
        referenceValue: null,
        estimatedProviderCharge: null,
        confirmedUptokeyCharge: zeroCharge,
        coverage: "not_comparable",
      });
      this.receipts.set(input.attemptId, receipt);
      return receipt;
    }

    // Case 4: Tariff lookup respecting accessMode, validity window and version
    const tariff = this.findTariff(input.provider, input.model, input.accessMode, createdAt, input.tariffVersion);
    if (!tariff) {
      const receipt = parseUsageValueReceipt({
        schemaVersion: 1,
        id: `val_${input.attemptId}`,
        createdAt,
        projectId: input.projectId,
        runId: input.runId,
        stepId: input.stepId,
        attemptId: input.attemptId,
        provider: input.provider,
        model: input.model,
        accessMode: input.accessMode,
        cache,
        usage: input.usage,
        tariffId: null,
        tariffVersion: null,
        referenceValue: null,
        estimatedProviderCharge: null,
        confirmedUptokeyCharge: zeroCharge,
        coverage: input.accessMode === "public" ? "not_comparable" : "missing_tariff",
      });
      this.receipts.set(input.attemptId, receipt);
      return receipt;
    }

    // Case 5: Fully priced with tariff
    const isMediaTariff = tariff.unit !== 'million_tokens' && tariff.priceMicrosPerUnit !== null;
    let referenceValue: RationalMicros;
    if (isMediaTariff && input.mediaUnits !== undefined && input.mediaUnits > 0) {
      referenceValue = calculateMediaUsageRational(input.mediaUnits, tariff.priceMicrosPerUnit!);
    } else {
      referenceValue = calculateUsageRational(
        input.usage.inputTokens,
        input.usage.outputTokens,
        input.usage.cachedInputTokens ?? 0,
        tariff.inputMicrosPerMillion,
        tariff.outputMicrosPerMillion,
        tariff.cachedInputMicrosPerMillion
      );
    }

    const receipt = parseUsageValueReceipt({
      schemaVersion: 1,
      id: `val_${input.attemptId}`,
      createdAt,
      projectId: input.projectId,
      runId: input.runId,
      stepId: input.stepId,
      attemptId: input.attemptId,
      provider: input.provider,
      model: input.model,
      accessMode: input.accessMode,
      cache,
      usage: input.usage,
      tariffId: tariff.id,
      tariffVersion: tariff.version,
      referenceValue: input.usage.basis === "provider_reported" || isMediaTariff ? referenceValue : null,
      estimatedProviderCharge: input.accessMode === "byok" ? referenceValue : zeroCharge,
      confirmedUptokeyCharge: zeroCharge,
      coverage: input.usage.basis === "provider_reported" || isMediaTariff ? "included" : "estimated_usage",
    });

    this.receipts.set(input.attemptId, receipt);
    return receipt;
  }

  getReceipt(attemptId: string): UsageValueReceipt | undefined {
    return this.receipts.get(attemptId);
  }

  /**
   * Aggregates rational microdollar amounts across the given period (YYYY-MM).
   * Accumulates exact rational sums before final integer rounding to avoid underestimation.
   */
  summarizePeriod(period: string): MonthlyUsageSummary {
    let accReference = { numerator: 0n, denominator: 1n };
    let accUptokey = { numerator: 0n, denominator: 1n };
    let accProvider = { numerator: 0n, denominator: 1n };

    let totalObservedCalls = 0;
    let includedCalls = 0;
    let missingUsageCalls = 0;
    let unpricedOrLocalCalls = 0;

    for (const receipt of this.receipts.values()) {
      if (!receipt.createdAt.startsWith(period)) continue;
      totalObservedCalls++;

      if (receipt.confirmedUptokeyCharge) {
        accUptokey = addRationalMicros(accUptokey, receipt.confirmedUptokeyCharge);
      }

      if (receipt.coverage === "included" && receipt.referenceValue) {
        includedCalls++;
        accReference = addRationalMicros(accReference, receipt.referenceValue);
        if (receipt.estimatedProviderCharge) {
          accProvider = addRationalMicros(accProvider, receipt.estimatedProviderCharge);
        }
      } else if (receipt.coverage === "missing_usage") {
        missingUsageCalls++;
      } else {
        unpricedOrLocalCalls++;
      }
    }

    return {
      period,
      totalReferenceValue: {
        numeratorMicros: accReference.numerator.toString(),
        denominator: accReference.denominator.toString(),
      },
      totalReferenceMicros: roundRationalUp(accReference),
      totalConfirmedUptokeyCharge: {
        numeratorMicros: accUptokey.numerator.toString(),
        denominator: accUptokey.denominator.toString(),
      },
      totalConfirmedUptokeyChargeMicros: roundRationalUp(accUptokey),
      totalEstimatedProviderCharge: {
        numeratorMicros: accProvider.numerator.toString(),
        denominator: accProvider.denominator.toString(),
      },
      totalEstimatedProviderChargeMicros: roundRationalUp(accProvider),
      totalObservedCalls,
      includedCalls,
      missingUsageCalls,
      unpricedOrLocalCalls,
    };
  }
}
