/**
 * E2-15-BR / E2-15-B — destination catalog and plans.
 * local_export ≠ openrouter_broadcast. Future entries stay honest (not pretend-available).
 * Management keys never surface to PWA payloads.
 */

import { createHash, randomUUID } from "node:crypto";
import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import {
  ObservabilityError,
  QUERY_LIMITS,
  type DestinationCatalogEntry,
  type DestinationConfigPublic,
  type DestinationMode,
} from "./usage-observability-types.ts";

const BROADCAST_SOURCE =
  "https://openrouter.ai/docs/guides/features/broadcast/overview";
const BROADCAST_API =
  "https://openrouter.ai/docs/api/api-reference/observability/create-observability-destination";

/** Catalog observed 2026-09-20 + announced-future (honest support states). */
export const DESTINATION_CATALOG: readonly DestinationCatalogEntry[] = Object.freeze([
  // Available / requires credential — Broadcast current
  ...[
    "Arize AX",
    "Braintrust",
    "ClickHouse",
    "Comet Opik",
    "Datadog",
    "Grafana Cloud",
    "Langfuse",
    "LangSmith",
    "New Relic",
    "OpenTelemetry Collector",
    "PostHog",
    "Raindrop",
    "Ramp",
    "S3/S3-compatible",
    "Sentry",
    "Snowflake",
    "W&B Weave",
    "Webhook",
  ].map((name) =>
    Object.freeze({
      typeId: slug(name),
      displayName: name,
      mode: "openrouter_broadcast" as const,
      protocol: name === "OpenTelemetry Collector" ? ("otlp_http_json" as const) : name === "Webhook" ? ("webhook" as const) : name.startsWith("S3") ? ("s3" as const) : ("openrouter_api" as const),
      support: "requires_credential" as const,
      sourceUrl: BROADCAST_SOURCE,
      notes: "OpenRouter Broadcast connector; management key required for remote create; privacy_mode must be sent true explicitly",
    }),
  ),
  // Native local_export paths (Uptokey, no OpenRouter account)
  Object.freeze({
    typeId: "uptokey_collector_local",
    displayName: "Uptokey Collector (loopback OTLP)",
    mode: "local_export" as const,
    protocol: "otlp_http_json" as const,
    support: "available" as const,
    sourceUrl: "proxy/integracoes/observability",
    notes: "Reuses telemetry-collector.ts collector-local profile; no credentials",
  }),
  Object.freeze({
    typeId: "uptokey_langfuse_loopback",
    displayName: "Langfuse loopback OTLP",
    mode: "local_export" as const,
    protocol: "otlp_http_json" as const,
    support: "requires_credential" as const,
    sourceUrl: "proxy/core/src/workspace/telemetry-exporter.ts",
    notes: "Existing Langfuse-shaped exporter on 127.0.0.1 only",
  }),
  Object.freeze({
    typeId: "google_bigquery",
    displayName: "Google BigQuery",
    mode: "local_export" as const,
    protocol: "unknown" as const,
    support: "unavailable" as const,
    sourceUrl: "capturas produto / pendente verificação contrato",
    notes: "Candidate native destination; support/contract/license still unverified — honest unavailable",
  }),
  // Future announced — must not fake availability
  ...[
    "AWS Firehose",
    "Dynatrace",
    "Evidently",
    "Fiddler",
    "Galileo",
    "Helicone",
    "HoneyHive",
    "Keywords AI",
    "Middleware",
    "Mona",
    "OpenInference",
    "Phoenix",
    "Portkey",
    "Supabase",
    "WhyLabs",
  ].map((name) =>
    Object.freeze({
      typeId: slug(name),
      displayName: name,
      mode: "openrouter_broadcast" as const,
      protocol: "unknown" as const,
      support: "future_announced" as const,
      sourceUrl: BROADCAST_SOURCE,
      notes: "Announced as future in Broadcast overview; no guessed endpoint",
    }),
  ),
]);

function slug(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_|_$/g, "");
}

export function listDestinationCatalog(): readonly DestinationCatalogEntry[] {
  return DESTINATION_CATALOG;
}

export function getCatalogEntry(typeId: string): DestinationCatalogEntry | undefined {
  return DESTINATION_CATALOG.find((e) => e.typeId === typeId);
}

export interface DestinationPlanInput {
  readonly action: "create" | "update" | "test" | "enable" | "disable" | "delete";
  readonly principalId: string;
  readonly expectedRevision?: number;
  readonly destinationId?: string;
  readonly typeId: string;
  readonly mode: DestinationMode;
  readonly credentialRef?: string | null;
  /** Management key for OpenRouter remote — NEVER returned in public config / PWA. */
  readonly managementKey?: string | null;
  readonly filters?: Readonly<Record<string, string>>;
  readonly privacyMode?: boolean;
  readonly sampleRate?: number;
  readonly enabled?: boolean;
}

export interface DestinationPlanResult {
  readonly planId: string;
  readonly receiptRef: string;
  readonly destinationId: string;
  readonly status: DestinationConfigPublic["status"];
  readonly errorCode: string | null;
  readonly publicConfig: DestinationConfigPublic | null;
  /** Explicit: test never enables broadcast. */
  readonly broadcastEnabled: boolean;
}

function publicSanitize(cfg: DestinationConfigPublic): DestinationConfigPublic {
  // Strip any accidental secret-shaped fields
  const hint = cfg.publicEndpointHint;
  if (hint && /key|secret|token|password/i.test(hint)) {
    return { ...cfg, publicEndpointHint: "[redacted]" };
  }
  return cfg;
}

export function planDestination(store: UsageObservabilityStore, input: DestinationPlanInput): DestinationPlanResult {
  const entry = getCatalogEntry(input.typeId);
  if (!entry) {
    return {
      planId: `plan_${randomUUID().slice(0, 8)}`,
      receiptRef: "none",
      destinationId: input.destinationId ?? "unknown",
      status: "error",
      errorCode: "destination_unavailable",
      publicConfig: null,
      broadcastEnabled: false,
    };
  }

  if (entry.support === "future_announced" || entry.support === "unavailable" || entry.support === "parser_unknown") {
    if (input.action === "create" || input.action === "enable") {
      return {
        planId: `plan_${randomUUID().slice(0, 8)}`,
        receiptRef: "none",
        destinationId: input.destinationId ?? entry.typeId,
        status: "unavailable",
        errorCode: "destination_unavailable",
        publicConfig: null,
        broadcastEnabled: false,
      };
    }
  }

  if (input.mode !== entry.mode) {
    throw new ObservabilityError("scope_mismatch");
  }

  if (entry.mode === "openrouter_broadcast" && (input.action === "create" || input.action === "update") && !input.managementKey) {
    throw new ObservabilityError("management_key_required");
  }

  const sample = input.sampleRate ?? 1;
  if (sample < QUERY_LIMITS.sampleMin || sample > QUERY_LIMITS.sampleMax) {
    throw new ObservabilityError("limit_exceeded");
  }

  // Unknown parser fail-closed: protocol unknown → refuse enable without crashing caller
  if (entry.protocol === "unknown" && (input.action === "enable" || input.action === "create")) {
    return {
      planId: `plan_${randomUUID().slice(0, 8)}`,
      receiptRef: "none",
      destinationId: input.destinationId ?? entry.typeId,
      status: "unavailable",
      errorCode: "destination_unavailable",
      publicConfig: null,
      broadcastEnabled: false,
    };
  }

  const id = input.destinationId ?? `dest_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  const existing = store.getDestination(id);

  if (input.action === "test") {
    // Synthetic event only — does not enable
    const publicConfig = existing
      ? publicSanitize(existing)
      : publicSanitize({
          id,
          typeId: entry.typeId,
          mode: entry.mode,
          enabled: false,
          privacyMode: input.privacyMode ?? true,
          sampleRate: sample,
          revision: 0,
          credentialRef: input.credentialRef ?? null,
          filters: input.filters ?? {},
          status: "testing",
          errorCode: null,
          publicEndpointHint: entry.mode === "local_export" ? "127.0.0.1" : BROADCAST_API,
        });
    return {
      planId: `test_${createHash("sha256").update(id + ":synth").digest("hex").slice(0, 12)}`,
      receiptRef: `synth_${Date.now()}`,
      destinationId: id,
      status: "testing",
      errorCode: null,
      publicConfig,
      broadcastEnabled: false,
    };
  }

  let enabled = existing?.enabled ?? false;
  let status: DestinationConfigPublic["status"] = existing?.status ?? "configured";
  if (input.action === "create" || input.action === "update") {
    enabled = input.enabled === true;
    // Defaults differ upstream: force privacy_mode true unless caller sets false explicitly after consent
    status = enabled ? "configured" : "disabled";
  } else if (input.action === "enable") {
    enabled = true;
    status = "configured";
  } else if (input.action === "disable" || input.action === "delete") {
    enabled = false;
    status = "disabled";
  }

  const cfg: DestinationConfigPublic = {
    id,
    typeId: entry.typeId,
    mode: entry.mode,
    enabled,
    privacyMode: input.privacyMode ?? true,
    sampleRate: sample,
    revision: existing?.revision ?? 0,
    credentialRef: input.credentialRef ?? null,
    filters: Object.freeze({ ...(input.filters ?? {}) }),
    status,
    errorCode: null,
    publicEndpointHint: entry.mode === "local_export" ? "127.0.0.1" : null,
  };

  // Management key must never be written into store public config
  const mgmt = input.managementKey;
  if (mgmt && JSON.stringify(cfg).includes(mgmt)) {
    throw new Error("management_key_leak_guard");
  }

  const saved =
    input.action === "delete"
      ? store.upsertDestination({ ...cfg, enabled: false, status: "disabled" }, input.principalId, input.expectedRevision)
      : store.upsertDestination(cfg, input.principalId, input.expectedRevision);

  const publicConfig = publicSanitize(saved);
  if (mgmt && JSON.stringify(publicConfig).includes(mgmt)) {
    throw new Error("management_key_leak_guard");
  }

  return {
    planId: `plan_${randomUUID().slice(0, 8)}`,
    receiptRef: `rcpt_${saved.revision}`,
    destinationId: saved.id,
    status: saved.status,
    errorCode: null,
    publicConfig,
    broadcastEnabled: saved.enabled && saved.mode === "openrouter_broadcast",
  };
}

/** PWA-safe projection: no management key, no secret credential material. */
export function toPwaDestinationCard(cfg: DestinationConfigPublic): Record<string, unknown> {
  return {
    id: cfg.id,
    typeId: cfg.typeId,
    mode: cfg.mode,
    enabled: cfg.enabled,
    privacyMode: cfg.privacyMode,
    sampleRate: cfg.sampleRate,
    revision: cfg.revision,
    status: cfg.status,
    errorCode: cfg.errorCode,
    hasCredentialRef: cfg.credentialRef !== null,
    publicEndpointHint: cfg.publicEndpointHint,
  };
}
