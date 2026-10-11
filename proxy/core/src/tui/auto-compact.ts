/**
 * Classifies estimated context usage using configurable suggestion,
 * automatic-compaction and forced-compaction thresholds.
 */
import { estimateTokens } from "./context-window.ts";
import type { ContextMessage } from "./context-window.ts";

export type CompactionUrgency = "none" | "suggest" | "auto" | "force";

export interface CompactionStatus {
  urgency: CompactionUrgency;
  usedTokens: number;
  maxTokens: number;
  percentage: number;
  message: string;
}

export interface AutoCompactionOptions {
  /** Maximum context tokens for the model. Default: 128000. */
  maxTokens?: number;
  /** Suggest compaction at this percentage. Default: 0.70. */
  suggestThreshold?: number;
  /** Auto-compact at this percentage. Default: 0.85. */
  autoThreshold?: number;
  /** Force compact at this percentage. Default: 0.95. */
  forceThreshold?: number;
}

/**
 * Check if compaction is needed based on current context size.
 */
export function checkCompactionStatus(
  messages: Array<{ content: string; role: string }>,
  options?: AutoCompactionOptions,
): CompactionStatus {
  const maxTokens = options?.maxTokens ?? 128_000;
  const suggestAt = options?.suggestThreshold ?? 0.70;
  const autoAt = options?.autoThreshold ?? 0.85;
  const forceAt = options?.forceThreshold ?? 0.95;

  const usedTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0);
  const percentage = usedTokens / maxTokens;

  if (percentage >= forceAt) {
    return {
      urgency: "force",
      usedTokens, maxTokens, percentage,
      message: `⚠ Contexto crítico (${Math.round(percentage * 100)}%). Compactação obrigatória.`,
    };
  }

  if (percentage >= autoAt) {
    return {
      urgency: "auto",
      usedTokens, maxTokens, percentage,
      message: `⟲ Compactando automaticamente (${Math.round(percentage * 100)}%)…`,
    };
  }

  if (percentage >= suggestAt) {
    return {
      urgency: "suggest",
      usedTokens, maxTokens, percentage,
      message: `Contexto em ${Math.round(percentage * 100)}%. Use /compact para otimizar.`,
    };
  }

  return {
    urgency: "none",
    usedTokens, maxTokens, percentage,
    message: "",
  };
}

/**
 * Get model-specific context limits.
 */
export function getModelContextLimit(modelId: string): number {
  const id = modelId.toLowerCase();
  if (id.includes("gpt-4o") || id.includes("gpt-4.1")) return 128_000;
  if (id.includes("gpt-4-turbo")) return 128_000;
  if (id.includes("claude-3.5") || id.includes("claude-4")) return 200_000;
  if (id.includes("claude-3-opus")) return 200_000;
  if (id.includes("gemini-2") || id.includes("gemini-1.5-pro")) return 1_000_000;
  if (id.includes("deepseek")) return 128_000;
  if (id.includes("llama")) return 128_000;
  if (id.includes("mistral-large")) return 128_000;
  if (id.includes("qwen")) return 128_000;
  // Conservative default
  return 32_000;
}

/**
 * Format context usage for status bar display.
 */
export function formatContextUsage(status: CompactionStatus): string {
  const pct = Math.round(status.percentage * 100);
  const used = status.usedTokens > 1000 ? `${(status.usedTokens / 1000).toFixed(1)}k` : String(status.usedTokens);
  const max = status.maxTokens > 1000 ? `${(status.maxTokens / 1000).toFixed(0)}k` : String(status.maxTokens);

  const bar = "█".repeat(Math.round(pct / 10)) + "░".repeat(10 - Math.round(pct / 10));
  const color = status.urgency === "force" ? "\x1b[31m" : status.urgency === "auto" ? "\x1b[33m" : status.urgency === "suggest" ? "\x1b[33m" : "\x1b[32m";

  return `${color}${bar}\x1b[0m ${used}/${max} (${pct}%)`;
}
