import {
  ALL_PROVIDERS,
  CORE_PROVIDERS,
  isLocalExperimentalProvider,
  isNamedExperimentalProvider,
  isResearchOnlyProvider,
  isUserDefinedProvider,
  NAMED_EXPERIMENTAL_DEFAULTS,
  type ProviderName,
} from "./provider-registry.ts";
import type { ProxyConfig, RoutingCombo } from "./types.ts";

/** Provenance of a catalog entry — never implies execution. */
export type CatalogOrigin = "declared" | "discovered" | "configured";

/** Support level shown in UI; experimental ≠ official. */
export type CatalogSupportLevel = "built_in" | "experimental" | "custom" | "research_only" | "catalog_only";

/**
 * Documented data-policy claim. A parameter like data_collection:deny or a
 * "no training" marketing line does NOT prove ZDR or retention=0.
 */
export interface DataPolicyEvidence {
  id: string;
  revision: number;
  sourceUrl: string;
  observedAt: string;
  validUntil: string | null;
  providerId: string;
  endpointScope: string | null;
  modelScope: string | null;
  modalityScope: string | null;
  accountConditions: string | null;
  /** Provider-declared retention text; null = unknown. */
  retentionPolicy: string | null;
  /** true = provider claims no training use; never rewritten as ZDR. */
  trainingUse: "none_declared" | "possible" | "unknown";
  collectionControls: string | null;
  exceptions: string | null;
  /** Explicit: no-training ≠ zero data retention. */
  zeroDataRetention: "unknown" | "not_claimed";
}

export interface CatalogEntry {
  id: string;
  revision: number;
  origin: CatalogOrigin;
  displayName: string;
  models: string[];
  capabilities: string[];
  officialUrl: string | null;
  helpUrl: string | null;
  supportLevel: CatalogSupportLevel;
  /** Cataloged without a runtime adapter — searchable, not executable. */
  executable: boolean;
  termsSource: string | null;
  termsObservedAt: string | null;
  dataPolicy: DataPolicyEvidence | null;
  disabled: boolean;
}

export interface UserConnectionView {
  providerId: string;
  configured: boolean;
  enabled: boolean;
  endpointConfigured: boolean;
  models: string[];
  defaultModel: string | null;
  credentialRef: `provider:${string}` | null;
}

export interface ObservedConnectionState {
  providerId: string;
  available: boolean;
  reason: string | null;
  observedAt: string;
  supportLevel: CatalogSupportLevel;
  effectiveModels: string[];
  /** Never invent balances. */
  quotaOrigin: "none" | "local_admission" | "provider_reported";
}

export interface CatalogSearchQuery {
  text?: string;
  localOnly?: boolean;
  byokOnly?: boolean;
  availableOnly?: boolean;
  capability?: string;
  /** Mandatory user preference; unknown evidence makes entry ineligible, not hidden. */
  requireNoTraining?: boolean;
}

export interface CatalogSearchHit {
  entry: CatalogEntry;
  connection: UserConnectionView | null;
  observed: ObservedConnectionState | null;
  eligibleForRequirement: boolean;
  ineligibilityReason: string | null;
}

export interface RoutingComboView {
  id: string;
  revision: number;
  name: string;
  mode: RoutingCombo["mode"];
  modelOrder: string[];
  providerOrderByModel: Record<string, string[]>;
  allowProviderFallback: boolean;
  allowModelFallback: boolean;
  maxAttempts: number;
  /** True when this combo is the active selection; catalog never reorders approved policy. */
  active: boolean;
}

export interface CatalogStoreSnapshot {
  revision: number;
  updatedAt: string;
  source: string;
  entries: CatalogEntry[];
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch {
    return false;
  }
}

function hasCredentialInUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Boolean(url.username || url.password);
  } catch {
    return true;
  }
}

export function createDataPolicyEvidence(input: Omit<DataPolicyEvidence, "zeroDataRetention"> & { zeroDataRetention?: DataPolicyEvidence["zeroDataRetention"] }): DataPolicyEvidence {
  if (!input.id || input.revision < 1) throw new Error("data_policy_invalid");
  if (!isHttpUrl(input.sourceUrl) || hasCredentialInUrl(input.sourceUrl)) throw new Error("data_policy_source_invalid");
  // Never promote no-training into ZDR.
  const zeroDataRetention = input.zeroDataRetention ?? "not_claimed";
  if (input.trainingUse === "none_declared" && zeroDataRetention === "unknown") {
    // Allowed: we still do not claim ZDR.
  }
  return {
    ...input,
    zeroDataRetention: zeroDataRetention === "unknown" ? "unknown" : "not_claimed",
  };
}

export function supportLevelForProvider(id: string): CatalogSupportLevel {
  if (isResearchOnlyProvider(id)) return "research_only";
  if (isUserDefinedProvider(id) || id === "custom") return "custom";
  if (isLocalExperimentalProvider(id) || isNamedExperimentalProvider(id)) return "experimental";
  if ((CORE_PROVIDERS as readonly string[]).includes(id)) return "built_in";
  return "catalog_only";
}

/** Build searchable catalog entries from the live registry + optional overlays. Does not enable execution. */
export function projectCatalogEntries(config: ProxyConfig, overlays: CatalogEntry[] = []): CatalogEntry[] {
  const now = new Date().toISOString();
  const fromRegistry: CatalogEntry[] = [...ALL_PROVIDERS].map((id) => {
    const entry = config.providers[id as ProviderName];
    const named = isNamedExperimentalProvider(id) ? NAMED_EXPERIMENTAL_DEFAULTS[id] : undefined;
    const executable = Boolean(entry?.configured && entry.enabled);
    return {
      id,
      revision: 1,
      origin: entry?.configured ? "configured" : "declared",
      displayName: id,
      models: entry?.models?.length ? [...entry.models] : named ? [...named.models] : [],
      // F2: the catalog never infers media, tools or schema support from a provider name. What a model
      // accepts is declared per model on its connection (Contas) and enforced by the router.
      capabilities: ["chat"],
      officialUrl: named?.endpointUrl ? new URL(named.endpointUrl).origin : null,
      helpUrl: null,
      supportLevel: supportLevelForProvider(id),
      executable,
      termsSource: null,
      termsObservedAt: null,
      dataPolicy: null,
      disabled: entry ? entry.enabled === false && entry.configured === false : false,
    };
  });

  const byId = new Map<string, CatalogEntry>();
  for (const item of fromRegistry) byId.set(item.id, item);
  for (const overlay of overlays) {
    if (byId.has(overlay.id) && overlay.origin === "declared") continue;
    byId.set(overlay.id, { ...overlay, executable: false }); // overlays never auto-enable execution
  }
  // Stamp observation time for declared-only rows without inventing terms.
  return [...byId.values()].map((item) => ({
    ...item,
    termsObservedAt: item.termsSource ? item.termsObservedAt ?? now : null,
  }));
}

export function projectUserConnection(config: ProxyConfig, providerId: string): UserConnectionView | null {
  const entry = config.providers[providerId as ProviderName];
  if (!entry) return null;
  return {
    providerId,
    configured: entry.configured,
    enabled: entry.enabled,
    endpointConfigured: Boolean(entry.endpointUrl),
    models: [...entry.models],
    defaultModel: entry.defaultModel || null,
    credentialRef: entry.configured ? `provider:${providerId}` : null,
  };
}

export function projectObservedState(input: {
  providerId: string;
  available: boolean;
  reason: string | null;
  supportLevel: CatalogSupportLevel;
  models: string[];
  observedAt?: string;
}): ObservedConnectionState {
  return {
    providerId: input.providerId,
    available: input.available,
    reason: input.reason,
    observedAt: input.observedAt ?? new Date().toISOString(),
    supportLevel: input.supportLevel,
    effectiveModels: [...input.models],
    quotaOrigin: "none",
  };
}

export function projectRoutingCombos(config: ProxyConfig): RoutingComboView[] {
  if (!config.routingCombos) return [];
  return Object.values(config.routingCombos).map((combo) => ({
    id: combo.id,
    revision: combo.revision,
    name: combo.name,
    mode: combo.mode,
    modelOrder: [...combo.modelOrder],
    providerOrderByModel: Object.fromEntries(
      Object.entries(combo.providerOrderByModel).map(([model, providers]) => [model, [...providers]]),
    ),
    allowProviderFallback: combo.allowProviderFallback,
    allowModelFallback: combo.allowModelFallback,
    maxAttempts: combo.maxAttempts,
    active: config.activeRoutingComboId === combo.id,
  }));
}

function matchesText(entry: CatalogEntry, text: string): boolean {
  const needle = text.trim().toLowerCase();
  if (!needle) return true;
  const hay = [entry.id, entry.displayName, ...entry.models, ...entry.capabilities].join("\n").toLowerCase();
  return hay.includes(needle);
}

/** Deterministic search — no popularity ranking, no invented free tiers. */
export function searchCatalog(
  entries: CatalogEntry[],
  connections: Map<string, UserConnectionView | null>,
  observed: Map<string, ObservedConnectionState | null>,
  query: CatalogSearchQuery = {},
): CatalogSearchHit[] {
  const hits: CatalogSearchHit[] = [];
  for (const entry of entries) {
    if (query.text && !matchesText(entry, query.text)) continue;
    if (query.localOnly && !isLocalExperimentalProvider(entry.id)) continue;
    if (query.byokOnly && (isLocalExperimentalProvider(entry.id) || entry.supportLevel === "research_only")) continue;
    if (query.capability && !entry.capabilities.includes(query.capability)) continue;

    const connection = connections.get(entry.id) ?? null;
    const state = observed.get(entry.id) ?? null;
    if (query.availableOnly && !(state?.available || entry.executable)) continue;

    let eligibleForRequirement = true;
    let ineligibilityReason: string | null = null;
    if (query.requireNoTraining) {
      const policy = entry.dataPolicy;
      if (!policy || policy.trainingUse !== "none_declared") {
        eligibleForRequirement = false;
        ineligibilityReason = "training_policy_unknown_or_possible";
      } else if (policy.validUntil && Date.parse(policy.validUntil) < Date.now()) {
        eligibleForRequirement = false;
        ineligibilityReason = "training_policy_expired";
      }
      // Still visible with explanation — do not hide.
    }

    hits.push({ entry, connection, observed: state, eligibleForRequirement, ineligibilityReason });
  }
  // Stable sort by id then displayName.
  hits.sort((a, b) => a.entry.id.localeCompare(b.entry.id) || a.entry.displayName.localeCompare(b.entry.displayName));
  return hits;
}

/**
 * In-memory catalog store with atomic replace + rollback to last valid revision.
 * Invalid payloads never wipe the previous catalog.
 */
export class CatalogMetadataStore {
  private current: CatalogStoreSnapshot;
  constructor(initial: CatalogStoreSnapshot) {
    this.current = structuredClone(initial);
  }
  getSnapshot(): CatalogStoreSnapshot {
    return structuredClone(this.current);
  }
  /** Preview/diff then commit; on validation failure keep previous. */
  replaceAtomic(next: CatalogStoreSnapshot): { ok: true; snapshot: CatalogStoreSnapshot } | { ok: false; code: string; snapshot: CatalogStoreSnapshot } {
    try {
      validateCatalogSnapshot(next);
    } catch (error) {
      return { ok: false, code: error instanceof Error ? error.message : "catalog_invalid", snapshot: this.getSnapshot() };
    }
    if (next.revision <= this.current.revision) {
      return { ok: false, code: "catalog_revision_not_newer", snapshot: this.getSnapshot() };
    }
    const previous = this.current;
    this.current = structuredClone(next);
    // Ensure we did not drop secrets/endpoints — store only metadata entries.
    for (const entry of this.current.entries) {
      if (entry.executable && entry.origin !== "configured") {
        this.current = previous;
        return { ok: false, code: "catalog_cannot_enable_execution", snapshot: this.getSnapshot() };
      }
    }
    return { ok: true, snapshot: this.getSnapshot() };
  }
  rollbackTo(revision: number): CatalogStoreSnapshot | null {
    if (this.current.revision === revision) return this.getSnapshot();
    return null; // single-slot store; caller keeps prior snapshot for rollback
  }
}

export function validateCatalogSnapshot(snapshot: CatalogStoreSnapshot): void {
  if (!Number.isSafeInteger(snapshot.revision) || snapshot.revision < 1) throw new Error("catalog_revision_invalid");
  if (typeof snapshot.source !== "string" || snapshot.source.length < 1 || snapshot.source.length > 200) throw new Error("catalog_source_invalid");
  if (!Array.isArray(snapshot.entries) || snapshot.entries.length > 10_000) throw new Error("catalog_entries_invalid");
  const seen = new Set<string>();
  for (const entry of snapshot.entries) {
    if (!entry.id || seen.has(entry.id)) throw new Error("catalog_duplicate_or_empty_id");
    seen.add(entry.id);
    if (entry.officialUrl && (hasCredentialInUrl(entry.officialUrl) || !isHttpUrl(entry.officialUrl))) {
      throw new Error("catalog_url_invalid");
    }
    if (entry.helpUrl && (hasCredentialInUrl(entry.helpUrl) || !isHttpUrl(entry.helpUrl))) {
      throw new Error("catalog_url_invalid");
    }
    if (entry.dataPolicy) createDataPolicyEvidence(entry.dataPolicy);
  }
}

/** Redact private values before export/log/HTML. */
export function redactCatalogForExport(snapshot: CatalogStoreSnapshot): CatalogStoreSnapshot {
  return {
    ...snapshot,
    entries: snapshot.entries.map((entry) => ({
      ...entry,
      // never export credential-bearing URLs (already rejected) or endpoint secrets
      officialUrl: entry.officialUrl,
      helpUrl: entry.helpUrl,
      dataPolicy: entry.dataPolicy
        ? { ...entry.dataPolicy, accountConditions: entry.dataPolicy.accountConditions ? "[redacted_condition]" : null }
        : null,
    })),
  };
}

/** Unified non-executable catalog + connection + observed + combo projection for UI/metrics. */
export function buildCatalogConnectionProjection(config: ProxyConfig, options: {
  overlays?: CatalogEntry[];
  observed?: Map<string, ObservedConnectionState | null>;
  adapterPresent?: (id: string) => boolean;
} = {}) {
  const entries = projectCatalogEntries(config, options.overlays ?? []);
  const connections = new Map<string, UserConnectionView | null>();
  for (const entry of entries) {
    connections.set(entry.id, projectUserConnection(config, entry.id));
  }
  const observed = options.observed ?? new Map<string, ObservedConnectionState | null>();
  for (const entry of entries) {
    if (observed.has(entry.id)) continue;
    const conn = connections.get(entry.id);
    const adapterOk = options.adapterPresent ? options.adapterPresent(entry.id) : entry.executable;
    const available = Boolean(conn?.configured && conn.enabled && adapterOk);
    let reason: string | null = null;
    if (!conn) reason = "catalog_only_not_executable";
    else if (!conn.configured) reason = "not_configured";
    else if (!conn.enabled) reason = "disabled";
    else if (!adapterOk) reason = "missing_adapter";
    observed.set(entry.id, projectObservedState({
      providerId: entry.id,
      available,
      reason,
      supportLevel: entry.supportLevel,
      models: conn?.models ?? entry.models,
    }));
  }
  return {
    catalogRevision: 1,
    basis: "local_configuration_and_admission" as const,
    entries,
    connections: Object.fromEntries([...connections.entries()].filter(([, v]) => v !== null)),
    observed: Object.fromEntries([...observed.entries()].filter(([, v]) => v !== null)),
    routingCombos: projectRoutingCombos(config),
    searchableNonExecutableCount: entries.filter((e) => !e.executable).length,
  };
}

