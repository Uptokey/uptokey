/**
 * Uptokey TUI — connections and models as the core observes them.
 *
 * Reads `/v1/connections` (configuration, admission, health, catalog) and
 * `/v1/models`; nothing here is inferred from a provider's name. Secrets are
 * never typed into the terminal transcript: configuring a provider opens the
 * core's own local page (`/ui?provider=…`, served on loopback), where the key
 * goes straight to the core vault. The terminal only shows the result.
 */
import { spawn } from "node:child_process";
import type { TuiClient } from "./client.ts";
import { isUserDefinedProvider } from "../provider-registry.ts";
import { t } from "./i18n.ts";
import { operationText, safeDiagnosticCode } from "./operation-ui.ts";

export interface ProviderView {
  id: string;
  displayName: string;
  kind: string;
  supportLevel: string;
  configured: boolean;
  enabled: boolean;
  eligible: boolean;
  reason: string | null;
  models: string[];
  defaultModel: string | null;
  health: string;
  capabilities: string[];
  helpUrl: string | null;
  executable: boolean;
}

export interface ModelView {
  id: string;
  ownedBy: string;
  contextWindow: number | null;
  providers: string[];
  available: boolean;
}

export interface ConnectionItemView {
  id: string;
  revision?: number;
  providerId: string;
  label: string;
  models: string[];
  enabled: boolean;
  eligible: boolean;
}

export interface ComparisonCandidate {
  key: string;
  modelId: string;
  connectionId: string;
  providerId: string;
  label: string;
}

export interface ConnectionsSnapshot {
  providers: ProviderView[];
  connections?: ConnectionItemView[];
  models: ModelView[];
  combos: Array<{ id: string; label: string }>;
  observedAt: string | null;
}

export function reasonText(reason: string | null): string {
  if (!reason) return t("reason_available");
  const key = `reason_${reason}`;
  const localized = t(key);
  return localized !== key ? localized : operationText("unavailable", { code: safeDiagnosticCode(reason) });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}

export function comparisonCandidates(snapshot?: ConnectionsSnapshot | null): ComparisonCandidate[] {
  if (!snapshot) return [];
  if (Array.isArray(snapshot.connections) && snapshot.connections.length > 0) {
    return snapshot.connections
      .filter((c) => c.eligible)
      .flatMap((c) => c.models.map((modelId) => ({
        key: `${c.id}:${modelId}`,
        modelId,
        connectionId: c.id,
        providerId: c.providerId,
        label: c.label ? `${c.label} (${c.providerId})` : c.providerId,
      })));
  }
  return (snapshot.providers ?? [])
    .filter((p) => p.eligible)
    .flatMap((p) => p.models.map((modelId) => ({
      key: `${p.id}:${modelId}`,
      modelId,
      connectionId: p.id,
      providerId: p.id,
      label: p.displayName,
    })));
}

export async function loadConnections(client: TuiClient): Promise<ConnectionsSnapshot> {
  const [connectionsRes, modelsRes] = await Promise.all([
    client.fetchRaw("/v1/connections"),
    client.fetchRaw("/v1/models"),
  ]);
  const connections = connectionsRes.ok ? record(await connectionsRes.json()) : {};
  const modelsBody = modelsRes.ok ? record(await modelsRes.json()) : {};
  const catalog = record(connections.catalog);
  const entries = new Map<string, Record<string, unknown>>();
  for (const entry of Array.isArray(catalog.entries) ? catalog.entries : []) {
    const e = record(entry);
    if (typeof e.id === "string") entries.set(e.id, e);
  }
  const providers: ProviderView[] = (Array.isArray(connections.providers) ? connections.providers : []).map((raw) => {
    const p = record(raw);
    const id = String(p.id ?? "");
    const entry = entries.get(id) ?? {};
    const admission = record(p.admission);
    // A stale control-plane grace does not revoke a user-owned API key. The
    // local router explicitly permits BYOK inference in this state; reflect
    // that real capability in the TUI instead of presenting a dead provider.
    const locallyUsable = p.configured === true && p.enabled === true && admission.reason === "offline_grace_expired";
    return {
      id,
      displayName: typeof entry.displayName === "string" ? entry.displayName : id,
      kind: String(p.kind ?? "provider"),
      supportLevel: String(p.supportLevel ?? entry.supportLevel ?? ""),
      configured: p.configured === true,
      enabled: p.enabled === true,
      eligible: admission.eligible === true || locallyUsable,
      reason: locallyUsable ? null : (typeof admission.reason === "string" ? admission.reason : null),
      models: strings(p.models),
      defaultModel: typeof p.defaultModel === "string" ? p.defaultModel : null,
      health: String(p.health ?? "not_checked"),
      capabilities: strings(entry.capabilities),
      helpUrl: typeof entry.helpUrl === "string" ? entry.helpUrl : null,
      executable: entry.executable !== false,
    };
  }).filter((p) => p.id);
  // Catalog-only entries (searchable, not executable here) stay visible and honest.
  for (const [id, entry] of entries) {
    if (providers.some((p) => p.id === id)) continue;
    providers.push({ id, displayName: typeof entry.displayName === "string" ? entry.displayName : id, kind: "catalog", supportLevel: String(entry.supportLevel ?? ""),
      configured: false, enabled: false, eligible: false, reason: entry.executable === false ? "catalog_only_not_executable" : "not_configured",
      models: strings(entry.models), defaultModel: null, health: "not_checked", capabilities: strings(entry.capabilities), helpUrl: typeof entry.helpUrl === "string" ? entry.helpUrl : null, executable: entry.executable !== false });
  }
  providers.sort((a, b) => Number(b.eligible) - Number(a.eligible) || Number(b.configured) - Number(a.configured) || a.id.localeCompare(b.id));

  const rawConnections = Array.isArray(connections.connections) ? connections.connections : [];
  const connItems: ConnectionItemView[] = rawConnections.map((raw) => {
    const c = record(raw);
    const id = String(c.id ?? "");
    const providerId = String(c.providerId ?? id);
    return {
      id,
      ...(Number.isSafeInteger(c.revision) && Number(c.revision) >= 1 ? { revision: Number(c.revision) } : {}),
      providerId,
      label: typeof c.label === "string" ? c.label : providerId,
      models: strings(c.models),
      enabled: c.enabled !== false,
      eligible: c.eligible === true,
    };
  }).filter((c) => c.id);
  if (connItems.length === 0) {
    for (const p of providers) {
      connItems.push({
        id: p.id,
        providerId: p.id,
        label: p.displayName,
        models: [...p.models],
        enabled: p.enabled,
        eligible: p.eligible,
      });
    }
  }

  const byModel = new Map<string, string[]>();
  for (const p of providers) for (const m of p.models) byModel.set(m, [...(byModel.get(m) ?? []), p.id]);
  const models: ModelView[] = (Array.isArray(modelsBody.data) ? modelsBody.data : []).map((raw) => {
    const m = record(raw);
    const id = String(m.id ?? "");
    const owners = byModel.get(id) ?? [];
    const routed = String(m.owned_by ?? "") === "uptokey";
    return {
      id, ownedBy: String(m.owned_by ?? ""),
      contextWindow: typeof m.context_window === "number" ? m.context_window : null,
      providers: owners,
      available: routed || owners.some((o) => providers.find((p) => p.id === o)?.eligible),
    };
  }).filter((m) => m.id);
  // Some daemon revisions temporarily return an empty `/v1/models` while
  // the provider inventory already contains a configured, observed model.
  // Preserve that real observation so the TUI does not render a misleading
  // “0 modelos” state or force a second credential entry.
  if (models.length === 0) {
    const observed = new Map<string, ModelView>();
    for (const provider of providers) {
      if (!provider.eligible) continue;
      for (const id of provider.models) observed.set(id, {
        id, ownedBy: provider.id, contextWindow: null, providers: [provider.id], available: true,
      });
    }
    models.push(...observed.values());
  }
  const combos = (Array.isArray(connections.routingCombos) ? connections.routingCombos : []).map((raw) => {
    const c = record(raw);
    return { id: String(c.id ?? ""), label: String(c.label ?? c.name ?? c.id ?? "") };
  }).filter((c) => c.id);
  return { providers, connections: connItems, models, combos, observedAt: typeof connections.observedAt === "string" ? connections.observedAt : null };
}

/** Loopback page of the core where a provider is configured (key goes to the core vault). */
export function providerSetupUrl(baseUrl: string, providerId: string): string {
  const url = new URL("/ui", baseUrl);
  if (isUserDefinedProvider(providerId)) {
    url.searchParams.set("setup", "connection");
    url.searchParams.set("provider", providerId);
    url.hash = "user-defined-provider-form";
  } else {
    url.searchParams.set("setup", "provider");
    url.searchParams.set("provider", providerId);
  }
  return url.toString();
}

/**
 * Opens a loopback URL built by the TUI (never text from a model) in the
 * default browser. Returns false when no opener is available.
 */
export function openLoopbackUrl(url: string): boolean {
  const target = new URL(url);
  if (target.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(target.hostname)) return false;
  const href = target.toString();
  const [command, args] = process.platform === "win32"
    ? ["rundll32", ["url.dll,FileProtocolHandler", href]]
    : process.platform === "darwin" ? ["open", [href]] : ["xdg-open", [href]];
  try {
    const child = spawn(command, args as string[], { detached: true, stdio: "ignore", windowsHide: true });
    child.on("error", () => undefined);
    child.unref();
    return true;
  } catch { return false; }
}
