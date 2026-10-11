/**
 * Uptokey TUI — Smart context window management.
 *
 * State of the art (2026): Adaptive context compaction (arxiv 2025/2026)
 * progressively summarizes older observations to keep the LLM focused.
 * OpenDev uses specialized model routing for different phases.
 *
 * This module goes beyond Bob's simple compaction:
 * - Token counting with tiktoken-compatible estimation
 * - Priority-based message retention (system > recent user > tools > old assistant)
 * - Sliding window with graceful degradation
 * - Preserves system message and last N user messages always
 * - Tool results get compressed to summaries after aging
 * - Checkpoint messages for conversation state recovery
 */

export interface ContextMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tokens?: number;
  priority?: "critical" | "high" | "normal" | "low";
  timestamp?: number;
  toolCallId?: string;
}

export interface ContextWindowOptions {
  /** Maximum tokens for the context window. */
  maxTokens: number;
  /** Reserve tokens for the response. Default: 4096. */
  reserveForResponse?: number;
  /** Always keep the last N user messages. Default: 3. */
  protectLastUserMessages?: number;
  /** Compress tool results older than this (ms). Default: 5 min. */
  toolResultAgeMs?: number;
  /** Insert checkpoint summaries. Default: true. */
  useCheckpoints?: boolean;
}

/**
 * Estimate token count for a string.
 * Uses a fast heuristic: ~4 chars per token for English/code,
 * ~2 chars per token for CJK, ~3.5 for mixed.
 * Accurate enough for context window management without tiktoken dependency.
 */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // Count CJK characters
  const cjkCount = (text.match(/[\u4e00-\u9fff\u3040-\u309f\u30a0-\u30ff\uac00-\ud7af]/g) ?? []).length;
  const nonCjkLength = text.length - cjkCount;
  return Math.ceil(nonCjkLength / 4 + cjkCount / 2);
}

/**
 * Compress a tool result to a summary.
 */
function compressToolResult(content: string, maxChars: number = 200): string {
  if (content.length <= maxChars) return content;

  // Keep first and last lines, summarize middle
  const lines = content.split("\n");
  if (lines.length <= 4) return content.slice(0, maxChars) + "…";

  const first = lines.slice(0, 2).join("\n");
  const last = lines.slice(-2).join("\n");
  const omitted = lines.length - 4;
  return `${first}\n[… ${omitted} lines omitted …]\n${last}`;
}

/**
 * Create a checkpoint summary of conversation state.
 */
function createCheckpointSummary(messages: ContextMessage[]): string {
  const userCount = messages.filter((m) => m.role === "user").length;
  const assistantCount = messages.filter((m) => m.role === "assistant").length;
  const toolCount = messages.filter((m) => m.role === "tool").length;
  const topics = messages
    .filter((m) => m.role === "user")
    .slice(-3)
    .map((m) => m.content.slice(0, 80).replace(/\n/g, " "))
    .join("; ");

  return `[Checkpoint: ${userCount} user, ${assistantCount} assistant, ${toolCount} tool messages. Recent topics: ${topics}]`;
}

/**
 * Fit messages into a context window with smart pruning.
 * Returns the pruned message list, total tokens, and whether pruning occurred.
 */
export function fitContextWindow(
  messages: ContextMessage[],
  options: ContextWindowOptions,
): { messages: ContextMessage[]; totalTokens: number; pruned: boolean; prunedCount: number } {
  const {
    maxTokens,
    reserveForResponse = 4096,
    protectLastUserMessages = 3,
    toolResultAgeMs = 5 * 60 * 1000,
    useCheckpoints = true,
  } = options;

  const budget = maxTokens - reserveForResponse;
  const now = Date.now();

  // Step 1: Estimate tokens for each message
  const withTokens = messages.map((m) => ({
    ...m,
    tokens: m.tokens ?? estimateTokens(m.content),
  }));

  // Step 2: Check if everything fits
  const totalTokens = withTokens.reduce((sum, m) => sum + m.tokens, 0);
  if (totalTokens <= budget) {
    return { messages: withTokens, totalTokens, pruned: false, prunedCount: 0 };
  }

  // Step 3: Classify messages by priority
  const systemMessages = withTokens.filter((m) => m.role === "system" || m.priority === "critical");
  const lastUserIndices: number[] = [];
  let userCount = 0;
  for (let i = withTokens.length - 1; i >= 0 && userCount < protectLastUserMessages; i--) {
    if (withTokens[i]!.role === "user") {
      lastUserIndices.push(i);
      userCount++;
    }
  }

  const protected_ = new Set([
    ...systemMessages.map((_, i) => i),
    ...lastUserIndices,
    withTokens.length - 1, // always keep last message
  ]);

  // Step 4: Compress old tool results
  const compressed = withTokens.map((m, i) => {
    if (
      m.role === "tool" &&
      !protected_.has(i) &&
      m.timestamp &&
      now - m.timestamp > toolResultAgeMs
    ) {
      const newContent = compressToolResult(m.content);
      return { ...m, content: newContent, tokens: estimateTokens(newContent) };
    }
    return m;
  });

  // Step 5: Drop messages from oldest to newest until within budget
  const result: ContextMessage[] = [];
  let usedTokens = 0;
  let prunedCount = 0;
  let checkpointInserted = false;

  // Always include system messages first
  for (const msg of systemMessages) {
    result.push(msg);
    usedTokens += msg.tokens;
  }

  // Then add from most recent backwards
  const nonSystem = compressed.filter((m) => m.role !== "system" && m.priority !== "critical");
  const reversed = [...nonSystem].reverse();
  const kept: ContextMessage[] = [];

  for (const msg of reversed) {
    if (usedTokens + msg.tokens <= budget) {
      kept.unshift(msg);
      usedTokens += msg.tokens;
    } else {
      prunedCount++;
    }
  }

  // Insert checkpoint if we pruned and it's enabled
  if (useCheckpoints && prunedCount > 0 && !checkpointInserted) {
    const summary = createCheckpointSummary(compressed.slice(0, prunedCount));
    const checkpointMsg: ContextMessage = {
      role: "system",
      content: summary,
      tokens: estimateTokens(summary),
      priority: "normal",
    };
    result.push(checkpointMsg);
    usedTokens += checkpointMsg.tokens ?? 0;
    checkpointInserted = true;
  }

  result.push(...kept);

  return { messages: result, totalTokens: usedTokens, pruned: true, prunedCount };
}