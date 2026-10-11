/**
 * E2-16 → E2-15 projection helpers (filter chips). Exclusive module; no W0 edit.
 */

import type { UsageClassificationRecord } from "./usage-classification.ts";

export interface UsageFilterChip {
  dimension: string;
  labelId: string;
  source: string;
  correctionRef?: string;
}

/** Build filter chips from a persisted usage classification (no prompt text). */
export function toUsageFilterChips(row: UsageClassificationRecord): UsageFilterChip[] {
  return row.labels.map((l) => ({
    dimension: l.dimension,
    labelId: l.labelId,
    source: l.source,
    ...(row.correctionRef ? { correctionRef: row.correctionRef } : {}),
  }));
}

/** AND-filter records by selected label ids (E2-15 consumer contract). */
export function filterByLabels(
  rows: UsageClassificationRecord[],
  requiredLabelIds: string[],
): UsageClassificationRecord[] {
  if (requiredLabelIds.length === 0) return rows;
  const need = new Set(requiredLabelIds);
  return rows.filter((row) => {
    const have = new Set(row.labels.map((l) => l.labelId));
    for (const id of need) if (!have.has(id)) return false;
    return true;
  });
}
