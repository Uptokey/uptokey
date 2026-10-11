/**
 * E2-15-X — CSV/JSON export of authorized usage rows.
 * Formula injection guarded; interrupted export reports partial.
 */

import { createHash } from "node:crypto";
import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import { queryUsage } from "./usage-query.ts";
import {
  ObservabilityError,
  QUERY_LIMITS,
  type UsageQueryInput,
  type UsageQueryRow,
} from "./usage-observability-types.ts";

export type ExportFormat = "csv" | "json" | "otlp_artifact_ref";

export interface ExportResult {
  readonly artifactRef: string;
  readonly format: ExportFormat;
  readonly status: "complete" | "partial";
  readonly rowCount: number;
  readonly byteLength: number;
  readonly sha256: string;
  readonly body: string;
  readonly errorCode: string | null;
}

function csvEscape(cell: string): string {
  // Neutralize formula injection (=, +, -, @, tab, CR) by prefixing single quote when needed.
  let v = cell;
  if (/^[=+\-@\t\r]/.test(v)) v = "'" + v;
  if (/[",\n\r]/.test(v)) return `"${v.replace(/"/g, '""')}"`;
  return v;
}

function rowsToCsv(rows: readonly UsageQueryRow[]): string {
  if (rows.length === 0) return "dimensions,metrics\n";
  const dimKeys = Object.keys(rows[0]!.dimensions);
  const metricKeys = Object.keys(rows[0]!.metrics);
  const header = [...dimKeys, ...metricKeys, "cost_kind_notes"].map(csvEscape).join(",");
  const lines = [header];
  for (const row of rows) {
    const cells = [
      ...dimKeys.map((k) => csvEscape(row.dimensions[k] ?? "")),
      ...metricKeys.map((k) => {
        const v = row.metrics[k];
        return csvEscape(v === null || v === undefined ? "" : String(v));
      }),
      csvEscape(
        Object.entries(row.costKinds)
          .map(([k, kind]) => `${k}=${kind}`)
          .join(";"),
      ),
    ];
    lines.push(cells.join(","));
  }
  return lines.join("\n") + "\n";
}

function rowsToJson(rows: readonly UsageQueryRow[], meta: Record<string, unknown>): string {
  return JSON.stringify({ ...meta, rows }, null, 0);
}

export function exportUsage(
  store: UsageObservabilityStore,
  input: {
    principalId: string;
    query?: UsageQueryInput;
    viewRef?: string;
    format: ExportFormat;
    destinationRef?: string | null;
    /** Simulate interruption after N rows for partial proof. */
    interruptAfterRows?: number;
    maxBytes?: number;
  },
): ExportResult {
  let query = input.query;
  if (input.viewRef) {
    const view = store.getView(input.principalId, input.viewRef);
    if (!view) throw new ObservabilityError("unauthorized");
    query = view.query;
  }
  if (!query || query.principalId !== input.principalId) {
    throw new ObservabilityError("scope_mismatch");
  }

  const result = queryUsage(store, { ...query, limit: query.limit ?? QUERY_LIMITS.maxRowsPerPage });
  let rows = [...result.rows];
  let status: "complete" | "partial" = "complete";
  let errorCode: string | null = null;

  if (input.interruptAfterRows !== undefined && rows.length > input.interruptAfterRows) {
    rows = rows.slice(0, input.interruptAfterRows);
    status = "partial";
    errorCode = "export_partial";
  }

  let body: string;
  if (input.format === "csv") {
    body = rowsToCsv(rows);
  } else if (input.format === "json") {
    body = rowsToJson(rows, {
      coverage: result.coverage,
      source: result.source,
      measuredAt: result.measuredAt,
      status,
    });
  } else {
    // OTLP artifact ref only — does not encode a parallel OTLP serializer
    body = JSON.stringify({
      kind: "otlp_artifact_ref",
      rowCount: rows.length,
      note: "reuse workspace telemetry-exporter / collector-local; no parallel encoder",
      destinationRef: input.destinationRef ?? null,
    });
  }

  const maxBytes = input.maxBytes ?? QUERY_LIMITS.exportMaxBytes;
  if (Buffer.byteLength(body, "utf8") > maxBytes) {
    // Truncate rows until under limit
    status = "partial";
    errorCode = "export_partial";
    while (rows.length > 0 && Buffer.byteLength(body, "utf8") > maxBytes) {
      rows.pop();
      body = input.format === "csv" ? rowsToCsv(rows) : rowsToJson(rows, { status: "partial", truncated: true });
    }
  }

  const sha256 = createHash("sha256").update(body).digest("hex");
  const artifactRef = `export_${sha256.slice(0, 16)}`;

  if (input.destinationRef) {
    const dest = store.getDestination(input.destinationRef);
    if (!dest || !dest.enabled) {
      // Export artifact still produced locally; delivery separate
    }
  }

  return {
    artifactRef,
    format: input.format,
    status,
    rowCount: rows.length,
    byteLength: Buffer.byteLength(body, "utf8"),
    sha256,
    body,
    errorCode,
  };
}

/** Detect whether CSV body contains an unescaped formula-leading cell (should be none after escape). */
export function csvHasUnescapedFormula(body: string): boolean {
  for (const line of body.split("\n").slice(1)) {
    if (!line) continue;
    for (const cell of splitCsvLine(line)) {
      if (/^[=+\-@]/.test(cell)) return true;
    }
  }
  return false;
}

function splitCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQ) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') inQ = false;
      else cur += ch;
    } else if (ch === '"') inQ = true;
    else if (ch === ",") {
      out.push(cur);
      cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out;
}
