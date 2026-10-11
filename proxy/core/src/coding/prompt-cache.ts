import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, renameSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const PROMPT_BLOCK_ORDER = ["SYSTEM", "REPO_MAP", "FILES", "HISTORY", "USER_TURN"] as const;
export type PromptBlockId = (typeof PROMPT_BLOCK_ORDER)[number];
export type CacheTtl = "ephemeral" | "5min" | "1h";
export type ChatRole = "system" | "user" | "assistant";

export const PROMPT_BLOCK_TTL: Readonly<Record<PromptBlockId, CacheTtl>> = {
  SYSTEM: "1h",
  REPO_MAP: "5min",
  FILES: "5min",
  HISTORY: "ephemeral",
  USER_TURN: "ephemeral",
};
export const CACHEABLE_BLOCK_IDS = ["SYSTEM", "REPO_MAP", "FILES"] as const;
export type CacheableBlockId = (typeof CACHEABLE_BLOCK_IDS)[number];

export const CACHE_HINT_HEADER = "x-uptokey-cache-hint";
export const CACHE_HINT_VERSION = 1;
export const CACHE_HINT_MAX_BYTES = 1024;
export const CODING_METRICS_FILE = "turns.jsonl";
export const CODING_METRICS_MAX_BYTES = 10 * 1024 * 1024;
export const QUOTE_INPUT_USD_PER_MTOK = 3;
export const CACHE_WRITE_MULTIPLIER = 1.25;
export const CACHE_READ_MULTIPLIER = 0.1;
const CACHE_TTL_MS: Readonly<Record<Exclude<CacheTtl, "ephemeral">, number>> = { "5min": 300_000, "1h": 3_600_000 };

export interface CacheableBlock {
  id: string;
  content: string;
  ttl: CacheTtl;
}

export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface AnthropicCacheControl {
  type: "ephemeral";
  ttl?: "1h";
}

export interface CacheHint {
  blockId: CacheableBlockId;
  ttl: CacheTtl;
  sha256: string;
  tokens: number;
  anthropic: { cache_control: AnthropicCacheControl };
  gateway: { header: typeof CACHE_HINT_HEADER; value: string };
}

export interface AssembledBlock {
  id: PromptBlockId;
  ttl: CacheTtl;
  sha256: string;
  tokens: number;
  bytes: number;
}

export interface CachedPromptAssembly {
  blocks: readonly AssembledBlock[];
  messages: readonly ChatMessage[];
  cacheHints: readonly CacheHint[];
  gatewayHeader: { name: typeof CACHE_HINT_HEADER; value: string };
}

export interface AnthropicTextBlock {
  type: "text";
  text: string;
  cache_control?: AnthropicCacheControl;
}

export interface AnthropicPromptPayload {
  system: readonly AnthropicTextBlock[];
  messages: ReadonlyArray<{ role: "user" | "assistant"; content: readonly AnthropicTextBlock[] }>;
}

export interface TurnBlockMetric {
  id: PromptBlockId;
  sha256: string;
  ttl: CacheTtl;
  tokens: number;
  cached: boolean;
}

export interface TurnMetricRecord {
  version: 1;
  ts: string;
  turn: number;
  conversationId: string;
  prompt_bytes: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  input_tokens: number;
  cost_usd: number;
  cache_hit_ratio: number;
  blocks: readonly TurnBlockMetric[];
}

export interface CachedTurn {
  assembly: CachedPromptAssembly;
  record: TurnMetricRecord;
}

const sha256 = (value: string): string => createHash("sha256").update(value, "utf8").digest("hex");

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

function invalid(reason: string): never {
  throw new Error(reason);
}

function validateBlocks(blocks: readonly CacheableBlock[]): ReadonlyArray<Readonly<{ id: PromptBlockId; content: string; ttl: CacheTtl }>> {
  if (!Array.isArray(blocks) || blocks.length !== PROMPT_BLOCK_ORDER.length) invalid("prompt_block_order_invalid");
  const validated: Array<Readonly<{ id: PromptBlockId; content: string; ttl: CacheTtl }>> = [];
  for (let index = 0; index < PROMPT_BLOCK_ORDER.length; index++) {
    const expected = PROMPT_BLOCK_ORDER[index]!;
    const block = blocks[index];
    if (!block || typeof block !== "object" || (block as { id?: unknown }).id !== expected) invalid("prompt_block_order_invalid");
    if (typeof block.content !== "string") invalid("prompt_block_content_invalid");
    if (block.ttl !== PROMPT_BLOCK_TTL[expected]) invalid("prompt_block_ttl_invalid");
    validated.push(Object.freeze({ id: expected, content: block.content, ttl: block.ttl }));
  }
  return validated;
}

function anthropicControl(ttl: CacheTtl): AnthropicCacheControl {
  return ttl === "1h" ? { type: "ephemeral", ttl: "1h" } : { type: "ephemeral" };
}

function hintValue(parts: ReadonlyArray<readonly [CacheableBlockId, string, CacheTtl]>): string {
  const encoded = parts.map(([id, digest, ttl]) => `${id}=${digest.slice(0, 12)}@${ttl === "1h" ? "1h" : "5m"}`).join(";");
  const value = `v${CACHE_HINT_VERSION};${encoded}`;
  if (Buffer.byteLength(value, "utf8") > CACHE_HINT_MAX_BYTES) invalid("prompt_cache_hint_overflow");
  return value;
}

const BLOCK_ROLE: Readonly<Record<PromptBlockId, ChatRole>> = {
  SYSTEM: "system",
  REPO_MAP: "system",
  FILES: "system",
  HISTORY: "user",
  USER_TURN: "user",
};

export function assembleCachedPrompt(blocks: readonly CacheableBlock[], turn: string): CachedPromptAssembly {
  if (typeof turn !== "string") invalid("prompt_turn_invalid");
  const validated = validateBlocks(blocks);
  const turnBlock = validated[4]!;
  if (turnBlock.content !== "" && turnBlock.content !== turn) invalid("prompt_turn_mismatch");
  const assembled: AssembledBlock[] = [];
  const messages: ChatMessage[] = [];
  const hints: CacheHint[] = [];
  const hintParts: Array<readonly [CacheableBlockId, string, CacheTtl]> = [];
  for (const block of validated) {
    const content = block.id === "USER_TURN" ? turn : block.content;
    const digest = sha256(content);
    const tokens = estimateTokens(content);
    assembled.push(Object.freeze({ id: block.id, ttl: block.ttl, sha256: digest, tokens, bytes: Buffer.byteLength(content, "utf8") }));
    messages.push(Object.freeze({ role: BLOCK_ROLE[block.id], content }));
    if ((CACHEABLE_BLOCK_IDS as readonly string[]).includes(block.id)) {
      const blockId = block.id as CacheableBlockId;
      hintParts.push([blockId, digest, block.ttl]);
      hints.push(Object.freeze({
        blockId,
        ttl: block.ttl,
        sha256: digest,
        tokens,
        anthropic: Object.freeze({ cache_control: Object.freeze(anthropicControl(block.ttl)) }),
        gateway: Object.freeze({ header: CACHE_HINT_HEADER, value: "" }),
      }));
    }
  }
  const value = hintValue(hintParts);
  const gatewayHeader = Object.freeze({ name: CACHE_HINT_HEADER as typeof CACHE_HINT_HEADER, value });
  const boundHints = hints.map((hint) => Object.freeze({ ...hint, gateway: Object.freeze({ header: CACHE_HINT_HEADER as typeof CACHE_HINT_HEADER, value }) }));
  return Object.freeze({
    blocks: Object.freeze(assembled),
    messages: Object.freeze(messages),
    cacheHints: Object.freeze(boundHints),
    gatewayHeader,
  });
}

export function anthropicPromptPayload(assembly: CachedPromptAssembly): AnthropicPromptPayload {
  const system: AnthropicTextBlock[] = [];
  const messages: Array<{ role: "user" | "assistant"; content: AnthropicTextBlock[] }> = [];
  for (let index = 0; index < assembly.blocks.length; index++) {
    const block = assembly.blocks[index]!;
    const message = assembly.messages[index]!;
    const hint = assembly.cacheHints.find((item) => item.blockId === block.id);
    const text: AnthropicTextBlock = hint
      ? Object.freeze({ type: "text" as const, text: message.content, cache_control: hint.anthropic.cache_control })
      : Object.freeze({ type: "text" as const, text: message.content });
    if (message.role === "system") {
      system.push(text);
      continue;
    }
    const last = messages[messages.length - 1];
    if (last && last.role === message.role) last.content.push(text);
    else messages.push({ role: message.role, content: [text] });
  }
  return Object.freeze({
    system: Object.freeze(system),
    messages: Object.freeze(messages.map((item) => Object.freeze({ role: item.role, content: Object.freeze(item.content) }))),
  });
}

function costUsd(inputTokens: number, writeTokens: number, readTokens: number): number {
  const micros = inputTokens * QUOTE_INPUT_USD_PER_MTOK +
    writeTokens * QUOTE_INPUT_USD_PER_MTOK * CACHE_WRITE_MULTIPLIER +
    readTokens * QUOTE_INPUT_USD_PER_MTOK * CACHE_READ_MULTIPLIER;
  return Math.round(micros) / 1_000_000;
}

export class PromptCacheTracker {
  private readonly now: () => Date;
  private readonly conversationId: string;
  private readonly cache = new Map<CacheableBlockId, { sha256: string; ttl: Exclude<CacheTtl, "ephemeral">; writtenAt: number; tokens: number }>();
  private turn = 0;

  constructor(options: { conversationId?: string; now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
    this.conversationId = typeof options.conversationId === "string" && options.conversationId ? options.conversationId : "local";
  }

  get turns(): number {
    return this.turn;
  }

  reset(): void {
    this.cache.clear();
    this.turn = 0;
  }

  beginTurn(blocks: readonly CacheableBlock[], turn: string): CachedTurn {
    const assembly = assembleCachedPrompt(blocks, turn);
    const at = this.now().getTime();
    this.turn += 1;
    for (const [id, entry] of this.cache) if (at - entry.writtenAt > CACHE_TTL_MS[entry.ttl]) this.cache.delete(id);
    let prefixIntact = true;
    let inputTokens = 0;
    let writeTokens = 0;
    let readTokens = 0;
    const blockMetrics: TurnBlockMetric[] = [];
    for (const block of assembly.blocks) {
      const cacheable = (CACHEABLE_BLOCK_IDS as readonly string[]).includes(block.id) && block.ttl !== "ephemeral";
      if (!cacheable) {
        inputTokens += block.tokens;
        blockMetrics.push(Object.freeze({ id: block.id, sha256: block.sha256, ttl: block.ttl, tokens: block.tokens, cached: false }));
        continue;
      }
      const id = block.id as CacheableBlockId;
      const known = this.cache.get(id);
      const ttl = block.ttl as Exclude<CacheTtl, "ephemeral">;
      const hit = prefixIntact && known !== undefined && known.sha256 === block.sha256 && at - known.writtenAt <= CACHE_TTL_MS[known.ttl];
      if (hit) {
        readTokens += block.tokens;
        known!.writtenAt = at;
        blockMetrics.push(Object.freeze({ id, sha256: block.sha256, ttl: block.ttl, tokens: block.tokens, cached: true }));
        continue;
      }
      inputTokens += block.tokens;
      if (block.tokens > 0) {
        writeTokens += block.tokens;
        this.cache.set(id, { sha256: block.sha256, ttl, writtenAt: at, tokens: block.tokens });
      }
      prefixIntact = false;
      blockMetrics.push(Object.freeze({ id, sha256: block.sha256, ttl: block.ttl, tokens: block.tokens, cached: false }));
    }
    const total = readTokens + inputTokens;
    const record: TurnMetricRecord = Object.freeze({
      version: 1,
      ts: this.now().toISOString(),
      turn: this.turn,
      conversationId: this.conversationId,
      prompt_bytes: assembly.blocks.reduce((sum, block) => sum + block.bytes, 0),
      cache_read_tokens: readTokens,
      cache_write_tokens: writeTokens,
      input_tokens: inputTokens,
      cost_usd: costUsd(inputTokens, writeTokens, readTokens),
      cache_hit_ratio: total > 0 ? Math.round((readTokens / total) * 10_000) / 10_000 : 0,
      blocks: Object.freeze(blockMetrics),
    });
    return Object.freeze({ assembly, record });
  }
}

export function resolveCodingMetricsDir(): string {
  const override = process.env.UPTOKEY_CODING_METRICS_DIR;
  if (typeof override === "string" && override.trim()) return resolve(override.trim());
  let current = resolve(process.cwd());
  for (let depth = 0; depth < 8; depth++) {
    if (existsSync(join(current, "proxy", "core", "package.json"))) return join(current, "output", "coding-metrics");
    const parent = dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return resolve(process.cwd(), "output", "coding-metrics");
}

export function logTurnMetric(record: TurnMetricRecord, dir: string = resolveCodingMetricsDir()): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, CODING_METRICS_FILE);
  const line = `${JSON.stringify(record)}\n`;
  if (existsSync(file) && statSync(file).size + Buffer.byteLength(line, "utf8") > CODING_METRICS_MAX_BYTES) {
    renameSync(file, join(dir, `turns.${record.ts.replace(/[:.]/g, "-")}.jsonl`));
  }
  appendFileSync(file, line, "utf8");
  return file;
}
