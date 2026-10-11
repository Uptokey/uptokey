import { createParser } from "eventsource-parser";
import { isDataRecord } from "@uptokey/sync-contract/plain-data";
import type { ProviderName } from "./types.ts";

// SSE framing is reused from eventsource-parser 4.1.0 (MIT), inspected 2026-09-13:
// https://github.com/rexxars/eventsource-parser. No provider SDK or response logging.
export interface ReportedTokenUsage { inputTokens: number; outputTokens: number; totalTokens: number; reasoningTokens?: number | null; }
export type CacheUsage = { cachedInputTokens: number | null; cacheWriteInputTokens: number | null; reasoningTokens: number | null };
export interface ProviderUsageMetrics extends ReportedTokenUsage {
  provider: ProviderName;
  responsesStarted: number;
  responsesInFlight: number;
  responsesWithUsage: number;
  responsesWithoutUsage: number;
  interruptedResponses: number;
}
export interface UsageMetrics {
  basis: "provider_reported";
  scope: "successful_router_responses_this_process";
  tokenTotals: "reported_subset_only";
  excludedDispatchPaths: readonly ["workspace_gateway"];
  persisted: false;
  providers: ProviderUsageMetrics[];
}
export interface UsageObservation {
  /** Parsed provider-reported usage, or null when none was reported/parseable. */
  readonly usage: (ReportedTokenUsage & CacheUsage) | null;
  /** True when the response was interrupted (cancel/timeout/stream failure). */
  readonly interrupted: boolean;
}
export interface UsageObserver { chunk(bytes: Uint8Array): void; complete(): void; interrupt(): void; }
const MAX_USAGE_BUFFER = 1_048_576;

export class UsageMeter {
  private readonly providers = new Map<ProviderName, ProviderUsageMetrics>();
  private readonly promptCache=new Map<ProviderName,Omit<CacheUsage,'reasoningTokens'>&{responsesReported:number}>();
  promptCacheSnapshot(){return {basis:'provider_reported' as const,scope:'successful_router_responses_this_process' as const,providers:[...this.promptCache].map(([provider,metrics])=>({provider,...metrics})),costSavings:null};}

  snapshot(): UsageMetrics {
    return { basis: "provider_reported", scope: "successful_router_responses_this_process", tokenTotals: "reported_subset_only",
      excludedDispatchPaths: ["workspace_gateway"], persisted: false, providers: structuredClone([...this.providers.values()]) };
  }

  observe(provider: ProviderName, streaming: boolean, onUsage?: (usage: ReportedTokenUsage & CacheUsage) => void, onClose?: (observation: UsageObservation) => void): UsageObserver {
    let metrics = this.providers.get(provider);
    if (!metrics) {
      metrics = { provider, responsesStarted: 0, responsesInFlight: 0, responsesWithUsage: 0, responsesWithoutUsage: 0, interruptedResponses: 0, inputTokens: 0, outputTokens: 0, totalTokens: 0 };
      this.providers.set(provider, metrics);
    }
    const counters = metrics;
    counters.responsesStarted += 1;
    counters.responsesInFlight += 1;
    let usage: (ReportedTokenUsage&CacheUsage) | undefined;
    let buffered = "";
    let disabled = false;
    let settled = false;
    let streamDone = false;
    const decoder = new TextDecoder();
    const parse = (text: string) => {
      try {
        const value = JSON.parse(text);
        const next = readReportedUsage(value);
        if (next) usage = next; // Streaming usage is cumulative, never sum its frames.
      } catch { /* Missing/malformed metadata is unavailable; the response is unchanged. */ }
    };
    const parser = streaming ? createParser({
      maxBufferSize: MAX_USAGE_BUFFER,
      onEvent: ({ data }) => {
        if (streamDone) return;
        if (data.length > MAX_USAGE_BUFFER) { disabled = true; usage = undefined; }
        if (data === "[DONE]") streamDone = true;
        else if (!disabled) parse(data);
      },
      onError: (error) => { if (error.type === "max-buffer-size-exceeded") { disabled = true; usage = undefined; } }
    }) : undefined;
    const feed = (text: string) => {
      if (disabled) return;
      if (parser) {
        // Feed bounded pieces so one large network chunk cannot bypass parser buffering limits.
        try { for (let offset = 0; offset < text.length && !disabled; offset += 16_384) parser.feed(text.slice(offset, offset + 16_384)); }
        catch { disabled = true; usage = undefined; }
      } else if (buffered.length + text.length <= MAX_USAGE_BUFFER) buffered += text;
      else { disabled = true; buffered = ""; }
    };
    const settle = (interrupted: boolean) => {
      if (settled) return;
      settled = true;
      counters.responsesInFlight -= 1;
      let closed: (ReportedTokenUsage & CacheUsage) | undefined;
      if (interrupted) {
        counters.interruptedResponses += 1;
        // Cumulative usage frames seen before the interruption remain valid observations of
        // what the provider reported so far; absence of any frame stays null (never zero).
        if (usage && !disabled) closed = usage;
      }
      else {
        feed(decoder.decode());
        if (!streaming && !disabled) parse(buffered);
        if (usage && !disabled && (!streaming || streamDone) && [counters.inputTokens + usage.inputTokens, counters.outputTokens + usage.outputTokens, counters.totalTokens + usage.totalTokens].every(Number.isSafeInteger)) {
          counters.responsesWithUsage += 1;
          counters.inputTokens += usage.inputTokens;
          counters.outputTokens += usage.outputTokens;
          counters.totalTokens += usage.totalTokens;
          if(usage.cachedInputTokens!==null||usage.cacheWriteInputTokens!==null){const current=this.promptCache.get(provider)??{responsesReported:0,cachedInputTokens:null,cacheWriteInputTokens:null};current.responsesReported++;for(const key of ['cachedInputTokens','cacheWriteInputTokens'] as const)if(usage[key]!==null){const total=(current[key]??0)+usage[key]!;current[key]=Number.isSafeInteger(total)?total:null;}this.promptCache.set(provider,current);}
          // Observability hook: fires only with provider-reported numeric usage; observers
          // must never throw into the meter (calibration and dashboard wiring depend on it).
          closed = usage;
          if (onUsage) { try { onUsage(usage); } catch { /* metrics hook is best-effort */ } }
        } else counters.responsesWithoutUsage += 1;
      }
      if (onClose) { try { onClose({ usage: closed ?? null, interrupted }); } catch { /* settlement hook is best-effort */ } }
      buffered = "";
      usage = undefined;
      parser?.reset();
    };
    return {
      chunk: (bytes) => { if (!settled && !disabled) feed(decoder.decode(bytes, { stream: true })); },
      complete: () => settle(false),
      interrupt: () => settle(true)
    };
  }
}

export function readReportedUsage(value: unknown): (ReportedTokenUsage & CacheUsage) | undefined {
  if (!isDataRecord(value)) return undefined;

  let input: number | undefined;
  let output: number | undefined;
  let total: number | undefined;
  let cachedRead: number | null = null;
  let cachedWrite: number | null = null;
  let reasoning: number | null = null;

  if (isDataRecord(value.usageMetadata)) {
    const meta = value.usageMetadata;
    if (!tokenCount(meta.promptTokenCount) || !tokenCount(meta.candidatesTokenCount)) return undefined;
    input = meta.promptTokenCount;
    output = meta.candidatesTokenCount;
    if (meta.totalTokenCount !== undefined) {
      if (!tokenCount(meta.totalTokenCount)) return undefined;
      total = meta.totalTokenCount;
    }
    if (meta.cachedContentTokenCount !== undefined && tokenCount(meta.cachedContentTokenCount)) {
      cachedRead = meta.cachedContentTokenCount;
    }
  }

  const raw = isDataRecord(value.usage)
    ? value.usage
    : isDataRecord(value.x_groq) && isDataRecord(value.x_groq.usage)
    ? value.x_groq.usage
    : undefined;

  if (raw) {
    if (raw.prompt_tokens !== undefined || raw.completion_tokens !== undefined) {
      if (!tokenCount(raw.prompt_tokens) || !tokenCount(raw.completion_tokens)) {
        return undefined;
      }
      input = raw.prompt_tokens;
      output = raw.completion_tokens;
      if (raw.total_tokens !== undefined) {
        if (!tokenCount(raw.total_tokens)) return undefined;
        total = raw.total_tokens;
      }
    } else if (raw.input_tokens !== undefined || raw.output_tokens !== undefined) {
      if (!tokenCount(raw.input_tokens) || !tokenCount(raw.output_tokens)) return undefined;
      input = raw.input_tokens;
      output = raw.output_tokens;
      if (raw.total_tokens !== undefined) {
        if (!tokenCount(raw.total_tokens)) return undefined;
        total = raw.total_tokens;
      }
    }

    const details = isDataRecord(raw.prompt_tokens_details) ? raw.prompt_tokens_details : undefined;
    if (tokenCount(details?.cached_tokens)) cachedRead = details.cached_tokens;
    else if (tokenCount(raw.cache_read_input_tokens)) cachedRead = raw.cache_read_input_tokens;

    if (tokenCount(raw.cache_creation_input_tokens)) cachedWrite = raw.cache_creation_input_tokens;

    const compDetails = isDataRecord(raw.completion_tokens_details) ? raw.completion_tokens_details : undefined;
    if (tokenCount(compDetails?.reasoning_tokens)) reasoning = compDetails.reasoning_tokens;
  }

  if (input === undefined || output === undefined) return undefined;
  if (total === undefined) total = input + output;
  if (!Number.isSafeInteger(total) || total < input + output) return undefined;

  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: total,
    cachedInputTokens: tokenCount(cachedRead) && cachedRead <= input ? cachedRead : null,
    cacheWriteInputTokens: tokenCount(cachedWrite) && cachedWrite <= input ? cachedWrite : null,
    reasoningTokens: tokenCount(reasoning) && reasoning <= output ? reasoning : null,
  };
}
function tokenCount(value: unknown): value is number { return typeof value === "number" && Number.isSafeInteger(value) && value >= 0; }
