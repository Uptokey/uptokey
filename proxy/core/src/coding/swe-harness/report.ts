/**
 * C6 — SWE-Bench-format report.
 *
 * `generateReport` produces the harness summary (total/resolved/unresolved and
 * per-task detail) plus `predictions` in the exact object shape the SWE-Bench
 * evaluator consumes (`{instance_id, model_name_or_path, model_patch}`);
 * `toPredictionsJsonl` serializes those lines for the official tooling. The
 * unified diff body is a best-effort view for humans — the evaluator only
 * needs the patch text per instance.
 */
import type { PatchSet } from "./patcher.ts";
import type { ValidationResult } from "./validator.ts";

export interface TaskResult {
  instance_id: string;
  resolved: boolean;
  patch: string | null;
  validation: Pick<ValidationResult, "attempts" | "exit" | "pass"> & { failureText?: string };
  localizedFiles: string[];
  usage: { inputTokens: number; outputTokens: number };
  durationMs: number;
}

export interface SweBenchReport {
  schema: "swe-bench-report-v1";
  generatedAt: string;
  dataset: string;
  total_count: number;
  resolved_count: number;
  unresolved_count: number;
  resolved_ids: string[];
  unresolved_ids: string[];
  results: TaskResult[];
  /** SWE-Bench evaluator input objects, one per task. */
  predictions: Array<{ instance_id: string; model_name_or_path: string; model_patch: string | null }>;
}

export function generateReport(input: {
  dataset: string;
  coderModel: string;
  results: TaskResult[];
  generatedAt?: string;
}): SweBenchReport {
  const results = input.results;
  const resolved = results.filter((result) => result.resolved);
  return {
    schema: "swe-bench-report-v1",
    generatedAt: input.generatedAt ?? new Date().toISOString(),
    dataset: input.dataset,
    total_count: results.length,
    resolved_count: resolved.length,
    unresolved_count: results.length - resolved.length,
    resolved_ids: resolved.map((result) => result.instance_id),
    unresolved_ids: results.filter((result) => !result.resolved).map((result) => result.instance_id),
    results,
    predictions: results.map((result) => ({
      instance_id: result.instance_id,
      model_name_or_path: input.coderModel,
      model_patch: result.patch,
    })),
  };
}

/** JSONL string in the SWE-Bench evaluator's expected per-line format. */
export function toPredictionsJsonl(report: SweBenchReport): string {
  return report.predictions
    .map((prediction) => JSON.stringify(prediction))
    .join("\n") + "\n";
}

/** Minimal unified diff view between the original and patched content (per file). */
export function summarizePatch(patchSet: PatchSet): string {
  return patchSet.patches
    .map((file) => `--- a/${file.path}\n+++ b/${file.path}\n(${Buffer.byteLength(file.after, "utf-8")} bytes finais)`)
    .join("\n");
}
