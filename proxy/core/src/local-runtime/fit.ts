import type { HardwareProfile } from "./hardware-profile.ts";

export type FitLabel = "great_fit" | "good_fit" | "may_be_slow" | "not_recommended" | "unknown";

export interface ModelFitEstimate {
  label: FitLabel;
  reason: string;
  basis: "estimate";
}

export function estimateModelFit(hardware: HardwareProfile, model: { sizeBytes?: number; sizeRangeBytes?: readonly [number, number]; estimatedMemoryBytes?: number }): ModelFitEstimate {
  const range = model.sizeRangeBytes;
  const upperBound = range && range.length === 2 && range.every(value => Number.isFinite(value) && value > 0) && range[0] <= range[1] ? range[1] : undefined;
  // A published range is an estimate of alternate formats. Use its upper
  // bound for a conservative host comparison; measured exact weights win.
  const weights = model.sizeBytes ?? upperBound;
  const required = model.estimatedMemoryBytes ?? (weights === undefined ? undefined : Math.ceil(weights * 1.25));
  if (!required || !Number.isFinite(required) || required <= 0) return { label: "unknown", reason: "model_memory_unknown", basis: "estimate" };
  const available = hardware.availableMemoryBytes ?? hardware.totalMemoryBytes;
  if (!Number.isFinite(available) || available <= 0) return { label: "unknown", reason: "hardware_memory_unknown", basis: "estimate" };
  if (required <= available * 0.25) return { label: "great_fit", reason: "low_memory_estimate", basis: "estimate" };
  if (required <= available * 0.5) return { label: "good_fit", reason: "within_memory_estimate", basis: "estimate" };
  if (required <= available * 0.8) return { label: "may_be_slow", reason: "high_memory_estimate", basis: "estimate" };
  return { label: "not_recommended", reason: "memory_exceeds_safe_estimate", basis: "estimate" };
}
