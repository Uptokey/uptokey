/**
 * Local calibration: automatic comparison between locally estimated input tokens and the
 * usage the provider actually reported for the same response.
 *
 * Zero-custody rules:
 * - Records numeric fields only (provider id, model id, counts, state label, tokenizer
 *   identity). It never sees, stores or emits prompts, payloads, headers or credentials —
 *   the sample contract has no place to put them, so none can leak into snapshots or telemetry.
 * - Aggregates only, bounded per model (no raw history), persisted through the canonical
 *   atomic local store with retention/expiry. `ephemeral` dispatches are never persisted.
 * - Basis stays observational: `local_process_observation`. It audits the estimator; it
 *   never replaces provider_reported usage for billing, quotas or receipts.
 */

import { readJson, writeJsonAtomic } from "./atomic-json.ts";
import type { TokenizerStatus } from "./token-catalog.ts";

export interface CalibrationSample {
  readonly provider: string;
  readonly model: string;
  readonly state: TokenizerStatus;
  readonly estimatedInput: number;
  readonly reportedInput: number;
  readonly reportedOutput: number;
  /** Counting artifact identity of the local estimate; a change invalidates the model aggregate. */
  readonly tokenizerId?: string | null;
  readonly catalogVersion?: string | null;
  readonly artifactProfileDigest?: string | null;
  /**
   * `false` marks an ephemeral dispatch: the sample is not aggregated and never persisted,
   * honoring the credential's retention mode (no durable numeric trace of that dispatch).
   */
  readonly persist?: boolean;
}

export interface CalibrationModelSummary {
  readonly provider: string;
  readonly model: string;
  readonly samples: number;
  /** reported / estimated, rounded to 4 decimals; null when any side was zero-estimated. */
  readonly meanInputRatio: number | null;
  /** mean |reported - estimated| input tokens. */
  readonly meanAbsInputError: number | null;
  readonly maxAbsInputError: number | null;
  /** Samples where the local estimate was within ±10% of provider-reported input. */
  readonly within10Percent: number;
  readonly stateCounts: Readonly<Record<TokenizerStatus, number>>;
  readonly tokenizerId: string | null;
  readonly catalogVersion: string | null;
  readonly artifactProfileDigest: string | null;
  readonly lastObservedAt: string;
}

export interface CalibrationPersistence {
  /** Canonical local path (default: paths.ts calibrationPath). */
  readonly path: string;
}

export interface CalibrationPersistenceInfo {
  readonly durable: boolean;
  /** Retention window applied on load; null when persistence is disabled. */
  readonly retainedMs: number | null;
  readonly loaded: number;
  readonly expired: number;
  readonly invalidated: number;
  /** Samples skipped because their dispatch was ephemeral. */
  readonly ephemeralSkipped: number;
  readonly writeFailures: number;
}

export interface CalibrationSnapshot {
  readonly schemaVersion: 1;
  readonly basis: "local_process_observation";
  readonly models: readonly CalibrationModelSummary[];
  readonly dropped: number;
  readonly persistence: CalibrationPersistenceInfo;
}

export interface TokenCalibrationOptions {
  /** Omit (or pass null) for a process-local, never-persisted instance (ephemeral mode). */
  readonly persistence?: CalibrationPersistence | null;
  /** Ages out model aggregates on load; default 14 days. */
  readonly retentionMs?: number;
  readonly now?: () => Date;
}

const MAX_MODELS = 256;
export const CALIBRATION_DEFAULT_RETENTION_MS = 14 * 24 * 60 * 60 * 1_000;

interface Agg {
  provider: string;
  model: string;
  samples: number;
  ratioSum: number;
  ratioCount: number;
  absErrorSum: number;
  maxAbsError: number;
  within: number;
  states: Record<TokenizerStatus, number>;
  tokenizerId: string | null;
  catalogVersion: string | null;
  artifactProfileDigest: string | null;
  lastObservedAt: string;
}

const STATES: readonly TokenizerStatus[] = ["verified", "partial", "heuristic", "unknown", "unavailable"];

function emptyStates(): Record<TokenizerStatus, number> {
  return Object.fromEntries(STATES.map((s) => [s, 0])) as Record<TokenizerStatus, number>;
}

function modelKey(provider: string, model: string): string { return `${provider}\u0000${model}`; }

function boundedString(value: unknown, max: number): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= max ? value : null;
}

function nonnegativeInt(value: unknown, max = Number.MAX_SAFE_INTEGER): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 && value <= max ? value : null;
}

/** Identity triple of one aggregate; any change invalidates the previous numbers. */
function identityOf(ids: { tokenizerId?: string | null; catalogVersion?: string | null; artifactProfileDigest?: string | null }): string {
  return JSON.stringify([ids.tokenizerId ?? null, ids.catalogVersion ?? null, ids.artifactProfileDigest ?? null]);
}

export class TokenCalibration {
  private readonly models = new Map<string, Agg>();
  private dropped = 0;
  private expired = 0;
  private invalidated = 0;
  private ephemeralSkipped = 0;
  private writeFailures = 0;
  private loaded = 0;
  private dirty = false;
  private persistLoop: Promise<void> | null = null;
  private initialized = false;
  private readonly path: string | null;
  private readonly retentionMs: number;
  private readonly now: () => Date;

  constructor(options: TokenCalibrationOptions = {}) {
    this.path = options.persistence?.path ?? null;
    this.retentionMs = Number.isSafeInteger(options.retentionMs) && (options.retentionMs as number) > 0
      ? (options.retentionMs as number)
      : CALIBRATION_DEFAULT_RETENTION_MS;
    this.now = options.now ?? (() => new Date());
  }

  /** Loads the durable aggregates once, dropping expired identities. Never throws on bad/absent state. */
  async initialize(): Promise<void> {
    if (!this.path || this.initialized) return;
    this.initialized = true;
    let payload: unknown;
    try { payload = await readJson<unknown>(this.path, null); } catch { return; }
    if (payload === null || typeof payload !== "object") return;
    const value = payload as Record<string, unknown>;
    if (value.schemaVersion !== 1 || !Array.isArray(value.models)) return;
    const cutoff = this.now().getTime() - this.retentionMs;
    for (const raw of value.models.slice(0, MAX_MODELS * 2)) {
      const entry = raw as Record<string, unknown>;
      const provider = boundedString(entry.provider, 64);
      const model = boundedString(entry.model, 200);
      const samples = nonnegativeInt(entry.samples);
      const lastObservedAt = boundedString(entry.lastObservedAt, 40);
      if (!provider || !model || samples === null || samples === 0 || !lastObservedAt) { this.dropped += 1; continue; }
      const observedAt = Date.parse(lastObservedAt);
      if (!Number.isFinite(observedAt) || observedAt < cutoff) { this.expired += 1; continue; }
      if (this.models.size >= MAX_MODELS) { this.dropped += 1; continue; }
      const states = emptyStates();
      if (entry.states && typeof entry.states === "object") {
        for (const state of STATES) {
          const count = nonnegativeInt((entry.states as Record<string, unknown>)[state]);
          if (count !== null) states[state] = count;
        }
      }
      this.models.set(modelKey(provider, model), {
        provider, model, samples,
        ratioSum: Number.isFinite(entry.ratioSum) ? Number(entry.ratioSum) : 0,
        ratioCount: nonnegativeInt(entry.ratioCount) ?? 0,
        absErrorSum: nonnegativeInt(entry.absErrorSum) ?? 0,
        maxAbsError: nonnegativeInt(entry.maxAbsError) ?? 0,
        within: nonnegativeInt(entry.within) ?? 0,
        states,
        tokenizerId: boundedString(entry.tokenizerId, 200),
        catalogVersion: boundedString(entry.catalogVersion, 40),
        artifactProfileDigest: boundedString(entry.artifactProfileDigest, 64),
        lastObservedAt,
      });
      this.loaded += 1;
    }
  }

  record(sample: CalibrationSample): void {
    if (sample.persist === false) { this.ephemeralSkipped += 1; return; }
    if (typeof sample.provider !== "string" || sample.provider.length > 64) { this.bump(); return; }
    if (typeof sample.model !== "string" || sample.model.length === 0 || sample.model.length > 200) { this.bump(); return; }
    if (!Number.isSafeInteger(sample.estimatedInput) || sample.estimatedInput <= 0) { this.bump(); return; }
    if (!Number.isSafeInteger(sample.reportedInput) || sample.reportedInput < 0) { this.bump(); return; }
    if (!Number.isSafeInteger(sample.reportedOutput) || sample.reportedOutput < 0) { this.bump(); return; }
    if (!STATES.includes(sample.state)) { this.bump(); return; }
    const key = modelKey(sample.provider, sample.model);
    const identity = identityOf(sample);
    let agg = this.models.get(key);
    if (agg && identityOf(agg) !== identity) {
      // Tokenizer/model identity changed: old numbers describe a different counter, so they
      // are invalidated instead of being merged with the new identity.
      this.models.delete(key);
      this.invalidated = saturating(this.invalidated);
      agg = undefined;
    }
    if (!agg) {
      if (this.models.size >= MAX_MODELS) { this.bump(); return; }
      agg = {
        provider: sample.provider, model: sample.model, samples: 0, ratioSum: 0, ratioCount: 0,
        absErrorSum: 0, maxAbsError: 0, within: 0, states: emptyStates(),
        tokenizerId: sample.tokenizerId ?? null,
        catalogVersion: sample.catalogVersion ?? null,
        artifactProfileDigest: sample.artifactProfileDigest ?? null,
        lastObservedAt: "",
      };
      this.models.set(key, agg);
    }
    const abs = Math.abs(sample.reportedInput - sample.estimatedInput);
    agg.samples += 1;
    agg.absErrorSum += abs;
    if (abs > agg.maxAbsError) agg.maxAbsError = abs;
    agg.ratioSum += sample.reportedInput / sample.estimatedInput;
    agg.ratioCount += 1;
    if (abs <= sample.estimatedInput * 0.1) agg.within += 1;
    agg.states[sample.state] += 1;
    agg.lastObservedAt = this.now().toISOString();
    this.schedulePersist();
  }

  snapshot(): CalibrationSnapshot {
    const models: CalibrationModelSummary[] = [...this.models.values()].map((agg) => ({
      provider: agg.provider,
      model: agg.model,
      samples: agg.samples,
      meanInputRatio: agg.ratioCount > 0 ? Math.round((agg.ratioSum / agg.ratioCount) * 10_000) / 10_000 : null,
      meanAbsInputError: agg.samples > 0 ? Math.round(agg.absErrorSum / agg.samples) : null,
      maxAbsInputError: agg.samples > 0 ? agg.maxAbsError : null,
      within10Percent: agg.within,
      stateCounts: { ...agg.states },
      tokenizerId: agg.tokenizerId,
      catalogVersion: agg.catalogVersion,
      artifactProfileDigest: agg.artifactProfileDigest,
      lastObservedAt: agg.lastObservedAt,
    }));
    return {
      schemaVersion: 1,
      basis: "local_process_observation",
      models,
      dropped: this.dropped,
      persistence: {
        durable: this.path !== null,
        retainedMs: this.path !== null ? this.retentionMs : null,
        loaded: this.loaded,
        expired: this.expired,
        invalidated: this.invalidated,
        ephemeralSkipped: this.ephemeralSkipped,
        writeFailures: this.writeFailures,
      },
    };
  }

  /** Waits for the pending durable write (tests/shutdown). No-op when persistence is disabled
   * or when nothing persistable was ever aggregated (an all-ephemeral instance creates no file). */
  async flush(): Promise<void> {
    if (!this.path) return;
    if (!this.dirty && this.models.size === 0) return;
    this.dirty = true;
    this.startPersistLoop();
    await this.persistLoop;
  }

  private persistedPayload(): Record<string, unknown> {
    return {
      schemaVersion: 1,
      basis: "local_process_observation",
      updatedAt: this.now().toISOString(),
      models: [...this.models.values()].map((agg) => ({
        provider: agg.provider, model: agg.model, samples: agg.samples,
        ratioSum: agg.ratioSum, ratioCount: agg.ratioCount,
        absErrorSum: agg.absErrorSum, maxAbsError: agg.maxAbsError, within: agg.within,
        states: { ...agg.states },
        tokenizerId: agg.tokenizerId, catalogVersion: agg.catalogVersion,
        artifactProfileDigest: agg.artifactProfileDigest,
        lastObservedAt: agg.lastObservedAt,
      })),
    };
  }

  private startPersistLoop(): void {
    if (!this.path || this.persistLoop) return;
    this.persistLoop = (async () => {
      while (this.dirty) {
        this.dirty = false;
        try { await writeJsonAtomic(this.path!, this.persistedPayload()); }
        catch {
          // The payload is a complete cumulative snapshot: dropping this write loses nothing
          // that the next scheduled write cannot recover, and avoids a hot retry loop.
          this.writeFailures = saturating(this.writeFailures);
        }
      }
    })().finally(() => { this.persistLoop = null; });
  }

  private schedulePersist(): void {
    if (!this.path) return;
    this.dirty = true;
    this.startPersistLoop();
  }

  private bump(): void { this.dropped = saturating(this.dropped); }
}

function saturating(value: number): number { return value >= Number.MAX_SAFE_INTEGER ? value : value + 1; }
