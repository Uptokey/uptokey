/**
 * E2-16 — versioned usage taxonomy (deterministic, no inference).
 * Shared W0 catalog types remain pending coordinator reservation.
 */

export const TAXONOMY_ID = "uptokey.usage.v1" as const;
export const TAXONOMY_VERSION = "1.0.0" as const;

export type TaxonomyDimension =
  | "modality"
  | "client"
  | "error_kind"
  | "task_intent"
  | "instrument"
  | "workspace_scope";

export interface TaxonomyLabel {
  id: string;
  dimension: TaxonomyDimension;
  description: string;
  parentId?: string;
}

export interface Taxonomy {
  id: typeof TAXONOMY_ID | string;
  version: string;
  unknownLabel: string;
  dimensions: readonly TaxonomyDimension[];
  labels: readonly TaxonomyLabel[];
}

export type TaxonomyParseError =
  | "taxonomy_invalid"
  | "duplicate_label"
  | "unknown_parent"
  | "cycle"
  | "missing_unknown";

export class TaxonomyValidationError extends Error {
  readonly code: TaxonomyParseError;
  constructor(code: TaxonomyParseError, message: string) {
    super(message);
    this.name = "TaxonomyValidationError";
    this.code = code;
  }
}

/** Minimal pilot taxonomy. Changing meaning requires a new version string. */
export const USAGE_TAXONOMY_V1: Taxonomy = {
  id: TAXONOMY_ID,
  version: TAXONOMY_VERSION,
  unknownLabel: "unknown",
  dimensions: [
    "modality",
    "client",
    "error_kind",
    "task_intent",
    "instrument",
    "workspace_scope",
  ],
  labels: [
    { id: "unknown", dimension: "task_intent", description: "No match / abstain" },
    { id: "no_match", dimension: "task_intent", description: "Explicit no semantic match" },
    { id: "modality.text", dimension: "modality", description: "Text chat / completion" },
    { id: "modality.image", dimension: "modality", description: "Image generation or edit" },
    { id: "modality.video", dimension: "modality", description: "Video generation" },
    { id: "modality.audio", dimension: "modality", description: "Speech / transcription / TTS" },
    { id: "modality.embeddings", dimension: "modality", description: "Embedding / RAG vectors" },
    { id: "modality.tool", dimension: "modality", description: "Tool / instrument call" },
    { id: "client.pwa", dimension: "client", description: "Uptokey PWA / template" },
    { id: "client.cli", dimension: "client", description: "CLI / local control" },
    { id: "client.extension", dimension: "client", description: "Editor extension" },
    { id: "client.api", dimension: "client", description: "HTTP API client" },
    { id: "client.unknown", dimension: "client", description: "Unrecognized client" },
    { id: "error.auth", dimension: "error_kind", description: "Auth failure" },
    { id: "error.forbidden", dimension: "error_kind", description: "Forbidden" },
    { id: "error.billing", dimension: "error_kind", description: "Billing / quota paywall" },
    { id: "error.timeout", dimension: "error_kind", description: "Timeout / deadline" },
    { id: "error.rate_limit", dimension: "error_kind", description: "Rate limited" },
    { id: "error.server", dimension: "error_kind", description: "Upstream 5xx" },
    { id: "error.client", dimension: "error_kind", description: "Client 4xx" },
    { id: "error.connection", dimension: "error_kind", description: "Transport / DNS" },
    { id: "error.unknown", dimension: "error_kind", description: "Unclassified error" },
    { id: "intent.chat", dimension: "task_intent", description: "Conversational ask" },
    { id: "intent.research", dimension: "task_intent", description: "Lookup / web / news" },
    { id: "intent.media", dimension: "task_intent", description: "Media production" },
    { id: "intent.files", dimension: "task_intent", description: "Filesystem / documents" },
    { id: "intent.api", dimension: "task_intent", description: "External API instrument" },
    { id: "intent.automation", dimension: "task_intent", description: "Saved flow / agent" },
    { id: "instrument.suggest", dimension: "instrument", description: "Suggested instrument only" },
    { id: "instrument.none", dimension: "instrument", description: "No instrument suggested" },
    { id: "scope.project", dimension: "workspace_scope", description: "Project-bound" },
    { id: "scope.personal", dimension: "workspace_scope", description: "Personal / default" },
    { id: "scope.unknown", dimension: "workspace_scope", description: "Scope not observed" },
  ],
};

export function parseTaxonomy(input: unknown): Taxonomy {
  if (!input || typeof input !== "object") {
    throw new TaxonomyValidationError("taxonomy_invalid", "taxonomy must be an object");
  }
  const raw = input as Record<string, unknown>;
  if (typeof raw.id !== "string" || raw.id.length < 1) {
    throw new TaxonomyValidationError("taxonomy_invalid", "id required");
  }
  if (typeof raw.version !== "string" || raw.version.length < 1) {
    throw new TaxonomyValidationError("taxonomy_invalid", "version required");
  }
  if (typeof raw.unknownLabel !== "string" || raw.unknownLabel.length < 1) {
    throw new TaxonomyValidationError("missing_unknown", "unknownLabel required");
  }
  if (!Array.isArray(raw.dimensions) || raw.dimensions.length < 1) {
    throw new TaxonomyValidationError("taxonomy_invalid", "dimensions required");
  }
  if (!Array.isArray(raw.labels) || raw.labels.length < 1) {
    throw new TaxonomyValidationError("taxonomy_invalid", "labels required");
  }

  const seen = new Set<string>();
  const byId = new Map<string, TaxonomyLabel>();
  const labels: TaxonomyLabel[] = [];

  for (const item of raw.labels) {
    if (!item || typeof item !== "object") {
      throw new TaxonomyValidationError("taxonomy_invalid", "label must be object");
    }
    const L = item as Record<string, unknown>;
    if (typeof L.id !== "string" || typeof L.dimension !== "string" || typeof L.description !== "string") {
      throw new TaxonomyValidationError("taxonomy_invalid", "label fields incomplete");
    }
    if (seen.has(L.id)) {
      throw new TaxonomyValidationError("duplicate_label", `duplicate label id: ${L.id}`);
    }
    seen.add(L.id);
    const label: TaxonomyLabel = {
      id: L.id,
      dimension: L.dimension as TaxonomyDimension,
      description: L.description,
      ...(typeof L.parentId === "string" ? { parentId: L.parentId } : {}),
    };
    labels.push(label);
    byId.set(label.id, label);
  }

  if (!byId.has(raw.unknownLabel as string)) {
    throw new TaxonomyValidationError("missing_unknown", "unknownLabel must exist in labels");
  }

  for (const label of labels) {
    if (label.parentId) {
      if (!byId.has(label.parentId)) {
        throw new TaxonomyValidationError("unknown_parent", `missing parent ${label.parentId}`);
      }
      // cycle detection
      const visited = new Set<string>();
      let cur: string | undefined = label.id;
      while (cur) {
        if (visited.has(cur)) {
          throw new TaxonomyValidationError("cycle", `cycle at ${cur}`);
        }
        visited.add(cur);
        cur = byId.get(cur)?.parentId;
      }
    }
  }

  return {
    id: raw.id as string,
    version: raw.version as string,
    unknownLabel: raw.unknownLabel as string,
    dimensions: raw.dimensions as TaxonomyDimension[],
    labels,
  };
}

export function labelExists(taxonomy: Taxonomy, labelId: string): boolean {
  return taxonomy.labels.some((l) => l.id === labelId);
}

export function assertLabelInTaxonomy(taxonomy: Taxonomy, labelId: string): void {
  if (!labelExists(taxonomy, labelId)) {
    throw new TaxonomyValidationError("taxonomy_invalid", `label not in taxonomy: ${labelId}`);
  }
}
