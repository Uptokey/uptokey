import { PROTOCOL_CAPABILITY_MATRIX } from "@uptokey/sync-contract/client-keys";
import type { ChatCompletionRequest } from "./types.ts";
import { readReportedUsage } from './usage-meter.ts';

export { PROTOCOL_CAPABILITY_MATRIX };
export const TOKENIZER_ID = "uptokey-chars4-v1";
export const TOKENIZER_VERSION = "2026-09-20";

const CHAT_ALLOWLIST = new Set([
  "model", "messages", "stream", "stream_options", "temperature", "top_p",
  "max_tokens", "max_completion_tokens", "stop", "seed", "user",
  "tools", "tool_choice", "parallel_tool_calls", "response_format",
  "uptookey_require_model", "uptookey_provider", "uptookey_routing_combo",
  "uptokey_require_model", "uptokey_provider", "uptokey_routing_combo",
  // Public account identity only; the router resolves and revalidates its local credential.
  "uptokey_account",
  // Valor de Uso V2: cost preference, validated by the inference policy and stripped before dispatch.
  "uptokey_cost_mode", "uptokey_cost_limit_micros",
  // Valor de Uso V4: explicit input-capability requirement, validated and stripped before dispatch.
  "uptokey_require_input",
]);

const ANTHROPIC_ALLOWLIST = new Set([
  "model", "messages", "system", "max_tokens", "stream", "temperature", "top_p", "stop_sequences", "tools", "tool_choice",
]);
const ANTHROPIC_EXPLICITLY_REJECTED = new Set([
  "parallel_tool_calls", "response_format", "logprobs", "seed", "reasoning", "thinking",
]);

const RESPONSES_ALLOWLIST = new Set([
  "model", "input", "instructions", "temperature", "top_p", "max_output_tokens", "stream",
  "tools", "tool_choice", "parallel_tool_calls", "store", "text",
]);
const RESPONSES_EXPLICITLY_REJECTED = new Set(["response_format", "reasoning", "previous_response_id"]);

const COMPLETIONS_ALLOWLIST = new Set([
  "model", "prompt", "max_tokens", "temperature", "top_p", "stop", "seed", "stream", "stream_options", "user",
]);

// Same roots as hasForbiddenInferenceCredentialField: they fail with 400 there, not 422 here.
const FORBIDDEN_INFERENCE_ROOTS = new Set([
  "apikey", "authorization", "accesstoken", "providertoken", "byok", "secret", "credential", "credentials",
]);

export function firstUnsupportedField(body: Record<string, unknown>, allowlist: Set<string>): string | undefined {
  for (const key of Object.keys(body)) {
    if (!allowlist.has(key)) return key;
  }
  return undefined;
}

/** Chat Completions: unknown fields fail explicitly; never silently drop tools/schema. */
export function validateChatBody(body: unknown): { ok: true } | { ok: false; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "(body)" };
  const record = body as Record<string, unknown>;
  for (const key of Object.keys(record)) {
    if (CHAT_ALLOWLIST.has(key)) continue;
    // Credential-looking roots stay visible to the dedicated 400 credential check.
    if (FORBIDDEN_INFERENCE_ROOTS.has(key.toLowerCase().replace(/[-_]/g, ""))) continue;
    return { ok: false, field: key };
  }
  return { ok: true };
}

export function validateAnthropicBody(body: unknown): { ok: true } | { ok: false; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "(body)" };
  const record = body as Record<string, unknown>;
  for (const rejected of ANTHROPIC_EXPLICITLY_REJECTED) {
    if (record[rejected] !== undefined) return { ok: false, field: rejected };
  }
  const field = firstUnsupportedField(record, ANTHROPIC_ALLOWLIST);
  if (field) return { ok: false, field };
  return { ok: true };
}

export function validateResponsesBody(body: unknown): { ok: true; streamTrue: boolean } | { ok: false; field: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { ok: false, field: "(body)" };
  const record = body as Record<string, unknown>;
  if (record.stream !== undefined && typeof record.stream !== "boolean") return { ok: false, field: "stream" };
  for (const rejected of RESPONSES_EXPLICITLY_REJECTED) {
    if (record[rejected] !== undefined) return { ok: false, field: rejected };
  }
  // The gateway keeps no server-side response state: store:true cannot be honored.
  if (record.store !== undefined && record.store !== false) return { ok: false, field: "store" };
  if (record.text && typeof record.text === "object" && !Array.isArray(record.text)) {
    const field = firstUnsupportedField(record.text as Record<string, unknown>, new Set(["format"]));
    if (field) return { ok: false, field: `text.${field}` };
  }
  const field = firstUnsupportedField(record, RESPONSES_ALLOWLIST);
  if (field) return { ok: false, field };
  return { ok: true, streamTrue: record.stream === true };
}

export interface LegacyCompletion {
  model?: string;
  promptText: string;
  max_tokens?: number;
  temperature?: number;
  top_p?: number;
  stop?: string | string[];
  seed?: number;
  stream?: boolean;
  stream_options?: { include_usage: boolean };
  user?: string;
}

/** Legacy /v1/completions: prompt-only surface; never an alias that drops chat fields. */
export function parseLegacyCompletions(body: unknown): LegacyCompletion | { error: string; field?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_request" };
  const record = body as Record<string, unknown>;
  const field = firstUnsupportedField(record, COMPLETIONS_ALLOWLIST);
  if (field) return { error: "protocol_field_unsupported", field };
  const prompt = record.prompt;
  let promptText: string | undefined;
  if (typeof prompt === "string") promptText = prompt;
  else if (Array.isArray(prompt) && prompt.every((p) => typeof p === "string")) {
    if (prompt.length > 1) return { error: "protocol_field_unsupported", field: "prompt" };
    promptText = prompt[0];
  }
  if (promptText === undefined || promptText.length < 1 || promptText.length > 128_000) return { error: "invalid_request" };
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length < 1 || record.model.length > 200)) return { error: "invalid_request" };
  if (record.stream !== undefined && typeof record.stream !== "boolean") return { error: "invalid_request" };
  const out: LegacyCompletion = { promptText };
  if (typeof record.model === "string") out.model = record.model;
  for (const key of ["max_tokens", "temperature", "top_p", "seed"] as const) {
    if (record[key] !== undefined) {
      if (typeof record[key] !== "number" || !Number.isFinite(record[key] as number)) return { error: "invalid_request" };
      (out as unknown as Record<string, unknown>)[key] = record[key];
    }
  }
  if (record.stop !== undefined) {
    if (!(typeof record.stop === "string" || (Array.isArray(record.stop) && record.stop.every((s) => typeof s === "string")))) return { error: "invalid_request" };
    out.stop = record.stop as string | string[];
  }
  if (record.stream !== undefined) out.stream = record.stream as boolean;
  if (record.seed !== undefined && !Number.isSafeInteger(record.seed)) return { error: "invalid_request" };
  if (record.max_tokens !== undefined && (!Number.isSafeInteger(record.max_tokens) || Number(record.max_tokens) < 1)) return { error: 'invalid_request' };
  if (record.user !== undefined) {
    if (typeof record.user !== 'string' || record.user.length > 256) return { error: 'invalid_request' };
    out.user = record.user;
  }
  if (record.stream_options !== undefined) {
    const options = record.stream_options as Record<string, unknown>;
    if (record.stream !== true || !options || typeof options !== 'object' || Array.isArray(options) ||
        Object.keys(options).some(key => key !== 'include_usage') || typeof options.include_usage !== 'boolean') return { error: 'invalid_request' };
    out.stream_options = { include_usage: options.include_usage };
  }
  return out;
}

export function legacyToChatRequest(parsed: LegacyCompletion): ChatCompletionRequest {
  const request: ChatCompletionRequest = { messages: [{ role: "user", content: parsed.promptText }] };
  if (parsed.model !== undefined) request.model = parsed.model;
  if (parsed.max_tokens !== undefined) request.max_tokens = parsed.max_tokens;
  if (parsed.temperature !== undefined) request.temperature = parsed.temperature;
  if (parsed.top_p !== undefined) request.top_p = parsed.top_p;
  if (parsed.stop !== undefined) request.stop = parsed.stop;
  if (parsed.stream !== undefined) request.stream = parsed.stream;
  if (parsed.seed !== undefined) request.seed = parsed.seed;
  if (parsed.user !== undefined) request.user = parsed.user;
  if (parsed.stream_options !== undefined) request.stream_options = { ...parsed.stream_options };
  return request;
}

/** A reported usage envelope is optional, but malformed counts are never forwarded as valid usage. */
export function isTextCompletionUsage(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const usage = value as Record<string, unknown>;
  return ['prompt_tokens', 'completion_tokens', 'total_tokens'].every(key => Object.hasOwn(usage, key) && usage[key] !== undefined)
    && readReportedUsage({ usage }) !== undefined;
}

export function chatCompletionToTextCompletion(openaiBody: unknown): Record<string, unknown> | undefined {
  if (!openaiBody || typeof openaiBody !== "object" || Array.isArray(openaiBody)) return undefined;
  const body = openaiBody as Record<string, unknown>;
  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const first = choices?.[0] as Record<string, unknown> | undefined;
  if (choices?.length !== 1 || !first || typeof first !== "object" || Array.isArray(first) ||
      typeof body.id !== 'string' || !body.id || typeof body.model !== 'string' || !body.model ||
      !Number.isSafeInteger(body.created) || Number(body.created) < 0 ||
      (body.system_fingerprint != null && typeof body.system_fingerprint !== 'string') ||
      (first.index !== undefined && first.index !== 0) || !['stop', 'length', 'content_filter'].includes(first.finish_reason as string)) return undefined;
  const message = (first.message && typeof first.message === "object" ? first.message : undefined) as Record<string, unknown> | undefined;
  if (!message || Array.isArray(message) || typeof message.content !== 'string' ||
      (message.role !== undefined && message.role !== 'assistant') || message.function_call != null ||
      (message.tool_calls != null && (!Array.isArray(message.tool_calls) || message.tool_calls.length > 0)) ||
      (message.refusal != null && message.refusal !== '')) return undefined;
  const text = message.content;
  if (body.usage != null && !isTextCompletionUsage(body.usage)) return undefined;
  const usage = body.usage as Record<string, unknown> | undefined;
  return {
    id: body.id.replace(/^chatcmpl[-_]?/, "cmpl-"),
    object: "text_completion",
    created: body.created,
    model: body.model,
    ...(body.system_fingerprint !== undefined ? { system_fingerprint: body.system_fingerprint } : {}),
    choices: [{ text, index: 0, finish_reason: first.finish_reason }],
    // Preserve upstream usage when present; never fabricate a missing count.
    ...(usage ? { usage } : { usage: null }),
  };
}

export interface CountTokensInput {
  model?: string;
  messageText: string;
}

/** Anthropic count_tokens: parse without dispatch; estimate is labelled, never official. */
export function parseCountTokens(body: unknown): CountTokensInput | { error: string; field?: string } {
  if (!body || typeof body !== "object" || Array.isArray(body)) return { error: "invalid_request" };
  const record = body as Record<string, unknown>;
  const allowed = new Set(["model", "messages", "system"]);
  const field = firstUnsupportedField(record, allowed);
  if (field) return { error: "protocol_field_unsupported", field };
  if (record.model !== undefined && (typeof record.model !== "string" || record.model.length < 1 || record.model.length > 200)) return { error: "invalid_request" };
  if (!Array.isArray(record.messages) || record.messages.length < 1 || record.messages.length > 4096) return { error: "invalid_request" };
  let text = "";
  if (typeof record.system === "string") text += record.system;
  else if (Array.isArray(record.system)) {
    for (const block of record.system) {
      if (block && typeof block === "object" && (block as Record<string, unknown>).type === "text" && typeof (block as Record<string, unknown>).text === "string") {
        text += String((block as Record<string, unknown>).text);
      }
    }
  } else if (record.system !== undefined) return { error: "invalid_request" };
  for (const message of record.messages as unknown[]) {
    if (!message || typeof message !== "object") return { error: "invalid_request" };
    const item = message as Record<string, unknown>;
    const content = item.content;
    if (typeof content === "string") text += content;
    else if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === "object" && typeof (block as Record<string, unknown>).text === "string") text += String((block as Record<string, unknown>).text);
        else if (typeof block === "string") text += block;
      }
    } else return { error: "invalid_request" };
  }
  return { model: typeof record.model === "string" ? record.model : undefined, messageText: text };
}

export function estimateTokensFor(text: string, model?: string): Record<string, unknown> {
  const inputTokens = Math.max(1, Math.ceil(text.length / 4));
  return {
    input_tokens: inputTokens,
    estimate: true,
    basis: { tokenizer: TOKENIZER_ID, version: TOKENIZER_VERSION, ...(model ? { model } : {}) },
  };
}

/** Post-header failures must use a valid protocol event, then close the stream. */
export function sseErrorEnvelope(protocol: "openai" | "anthropic", type: string): string {
  if (protocol === "anthropic") {
    return `event: error\ndata: ${JSON.stringify({ type: "error", error: { type } })}\n\n`;
  }
  return `data: ${JSON.stringify({ error: { type } })}\n\ndata: [DONE]\n\n`;
}
