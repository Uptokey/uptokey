import { createParser } from "eventsource-parser";
import type { ChatCompletionRequest } from "./types.ts";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { cancelStream } from "./stream-lifecycle.ts";

const MAX_SSE_EVENT_BUFFER = 1_048_576;
const MAX_SSE_TRANSFORM_BYTES = 16 * 1024 * 1024;
const MAX_TOOLS = 128;
const TOOL_NAME = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_CALL_ID = 256;

function responseUsage(value: unknown): { input_tokens: number; output_tokens: number; total_tokens: number } | null {
  if (!record(value)) return null;
  const valid = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
  if (!valid(value.prompt_tokens) || !valid(value.completion_tokens)) return null;
  const total = value.total_tokens === undefined ? value.prompt_tokens + value.completion_tokens : value.total_tokens;
  if (!valid(total) || total < value.prompt_tokens + value.completion_tokens) return null;
  return { input_tokens: value.prompt_tokens, output_tokens: value.completion_tokens, total_tokens: total };
}

type ChatMessage = ChatCompletionRequest["messages"][number];
type ResponseMessagePart =
  | { type: "output_text"; text: string; annotations: unknown[] }
  | { type: "refusal"; refusal: string };

function responseMessageParts(message: Record<string, unknown>): ResponseMessagePart[] | undefined {
  if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== "string") return undefined;
  const text = typeof message.content === "string" ? message.content
    : Array.isArray(message.content) ? openAIPartsToText(message.content) : "";
  let contentRefusal = "";
  if (Array.isArray(message.content)) {
    for (const part of message.content) {
      if (!record(part) || part.type !== "refusal") continue;
      if (typeof part.refusal !== "string") return undefined;
      contentRefusal += part.refusal;
    }
  }
  const refusal = typeof message.refusal === "string" && message.refusal.length > 0 ? message.refusal : contentRefusal;
  // Some compatible upstreams expose the same refusal in both representations. Keep it
  // once; disagreement is invalid rather than inventing an order or discarding content.
  if (contentRefusal && refusal !== contentRefusal) return undefined;
  return [
    ...(text.length > 0 ? [{ type: "output_text" as const, text, annotations: [] }] : []),
    ...(refusal.length > 0 ? [{ type: "refusal" as const, refusal }] : []),
  ];
}

/**
 * OpenAI Responses body → ChatCompletionRequest. Function tools, tool_choice and the
 * function_call / function_call_output input items map onto Chat Completions tool calling;
 * unsupported tool types or items fail explicitly instead of being dropped.
 */
export function responsesRequestToChatCompletion(value: unknown): ChatCompletionRequest | { error: string } {
  if (!record(value)) return { error: "invalid_request" };
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 200)) {
    return { error: "invalid_request" };
  }

  const messages: ChatCompletionRequest["messages"] = [];
  if (value.instructions !== undefined && value.instructions !== null) {
    if (typeof value.instructions !== "string") return { error: "invalid_request" };
    if (value.instructions.length > 0) messages.push({ role: "system", content: value.instructions });
  }

  const inputMessages = responsesInputToMessages(value.input);
  if ("error" in inputMessages) return inputMessages;
  messages.push(...inputMessages.messages);
  if (messages.length < 1 || messages.length > 4_096) return { error: "invalid_request" };

  const request: ChatCompletionRequest = { messages };
  if (typeof value.model === "string") request.model = value.model;
  // Known scalar fields with a wrong type are rejected, never silently dropped or coerced.
  for (const key of ["temperature", "top_p"] as const) {
    const scalar = value[key];
    if (scalar === undefined || scalar === null) continue;
    if (typeof scalar !== "number" || !Number.isFinite(scalar)) return { error: "invalid_request" };
    request[key] = scalar;
  }
  if (value.max_output_tokens !== undefined && value.max_output_tokens !== null) {
    if (typeof value.max_output_tokens !== "number" || !Number.isFinite(value.max_output_tokens) || value.max_output_tokens < 1) return { error: "invalid_request" };
    request.max_tokens = Math.floor(value.max_output_tokens);
  }
  if (typeof value.stream === "boolean") request.stream = value.stream;
  if (value.tools !== undefined) {
    const tools = responsesToolsToChat(value.tools);
    if ("error" in tools) return tools;
    if (tools.tools.length > 0) request.tools = tools.tools;
  }
  if (value.tool_choice !== undefined) {
    const choice = responsesToolChoiceToChat(value.tool_choice);
    if (choice === undefined) return { error: "unsupported_tool_choice" };
    request.tool_choice = choice;
  }
  if (value.parallel_tool_calls !== undefined && value.parallel_tool_calls !== null) {
    if (typeof value.parallel_tool_calls !== "boolean") return { error: "invalid_request" };
    request.parallel_tool_calls = value.parallel_tool_calls;
  }
  if (value.text !== undefined) {
    if (!record(value.text) || Object.keys(value.text).some(key => key !== "format")) return { error: "invalid_request" };
    if (value.text.format !== undefined) {
      const format = value.text.format;
      if (!record(format)) return { error: "invalid_request" };
      if (format.type === "text" || format.type === "json_object") {
        if (Object.keys(format).some(key => key !== "type")) return { error: "invalid_request" };
        request.response_format = { type: format.type };
      } else if (format.type === "json_schema") {
        if (Object.keys(format).some(key => !["type", "name", "schema", "strict", "description"].includes(key)) ||
            typeof format.name !== "string" || !TOOL_NAME.test(format.name) || !record(format.schema) ||
            format.description !== undefined && typeof format.description !== "string" ||
            format.strict !== undefined && format.strict !== null && typeof format.strict !== "boolean") return { error: "invalid_request" };
        // Only move the protocol envelope. Schema semantics and supported keywords belong
        // to the chosen provider; do not rewrite its schema or invent a strict default.
        const { type, ...json_schema } = format;
        request.response_format = { type, json_schema };
      } else return { error: "invalid_request" };
    }
  }
  return request;
}

function responsesToolsToChat(value: unknown): { tools: Array<Record<string, unknown>> } | { error: string } {
  if (!Array.isArray(value) || value.length > MAX_TOOLS) return { error: "invalid_request" };
  const tools: Array<Record<string, unknown>> = [];
  for (const tool of value) {
    if (!record(tool)) return { error: "invalid_request" };
    // Hosted tools (web_search, file_search, computer_use, mcp…) run inside OpenAI; a gateway
    // in front of arbitrary providers cannot honor them, so they are refused, not dropped.
    if (tool.type !== "function") return { error: "unsupported_tool_type" };
    if (typeof tool.name !== "string" || !TOOL_NAME.test(tool.name)) return { error: "invalid_request" };
    if (tool.parameters !== undefined && tool.parameters !== null && !record(tool.parameters)) return { error: "invalid_request" };
    tools.push({
      type: "function",
      function: {
        name: tool.name,
        ...(typeof tool.description === "string" ? { description: tool.description } : {}),
        ...(record(tool.parameters) ? { parameters: tool.parameters } : {}),
        ...(typeof tool.strict === "boolean" ? { strict: tool.strict } : {}),
      },
    });
  }
  return { tools };
}

function responsesToolChoiceToChat(value: unknown): unknown {
  if (value === "auto" || value === "none" || value === "required") return value;
  if (record(value) && value.type === "function" && typeof value.name === "string" && TOOL_NAME.test(value.name)) {
    return { type: "function", function: { name: value.name } };
  }
  return undefined;
}

/** Convert OpenAI chat.completion JSON → Responses API shape (text, refusals and function calls). */
export function chatCompletionToResponses(body: unknown, fallbackModel?: string): Record<string, unknown> | undefined {
  if (!record(body)) return undefined;
  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const first = choices?.[0];
  if (!record(first)) return undefined;
  const message = record(first.message) ? first.message : undefined;
  if (!message) return undefined;
  if (message.tool_calls !== undefined && !Array.isArray(message.tool_calls)) return undefined;
  const content = responseMessageParts(message);
  if (!content) return undefined;
  const usage = responseUsage(body.usage);
  const id = typeof body.id === "string" && body.id.length > 0
    ? (body.id.startsWith("resp_") ? body.id : `resp_${body.id.replace(/^chatcmpl_?/, "")}`)
    : `resp_${Date.now()}`;
  const calls = Array.isArray(message.tool_calls) ? message.tool_calls : [];
  if (calls.length > MAX_TOOLS || (first.finish_reason === "tool_calls" && calls.length === 0)) return undefined;
  const callIds = new Set<string>();
  for (const call of calls) {
    if (!record(call) || call.type !== "function" || typeof call.id !== "string" || call.id.length < 1 || call.id.length > MAX_CALL_ID || callIds.has(call.id) ||
        !record(call.function) || typeof call.function.name !== "string" || !TOOL_NAME.test(call.function.name) || typeof call.function.arguments !== "string") return undefined;
    callIds.add(call.id);
  }
  const items: Array<Record<string, unknown>> = [];
  if (content.length > 0 || calls.length === 0) {
    items.push({ type: "message", id: `msg_${id.replace(/^resp_/, "")}`, status: "completed", role: "assistant", content: content.length > 0 ? content : [{ type: "output_text", text: "", annotations: [] }] });
  }
  for (const call of calls) {
    const fn = call.function;
    const callId = call.id;
    items.push({
      type: "function_call", id: `fc_${callId}`, call_id: callId, status: "completed",
      name: fn.name,
      arguments: fn.arguments,
    });
  }
  const incomplete = first.finish_reason === "length" || first.finish_reason === "content_filter";
  return {
    id,
    object: "response",
    created_at: typeof body.created === "number" ? body.created : Math.floor(Date.now() / 1000),
    status: incomplete ? "incomplete" : "completed",
    ...(incomplete ? { incomplete_details: { reason: first.finish_reason === "length" ? "max_output_tokens" : "content_filter" } } : {}),
    model: typeof body.model === "string" ? body.model : (fallbackModel ?? "unknown"),
    output: items,
    usage,
  };
}

function responsesInputToMessages(input: unknown): { messages: ChatCompletionRequest["messages"] } | { error: string } {
  if (typeof input === "string") {
    return { messages: [{ role: "user", content: input }] };
  }
  if (!Array.isArray(input) || input.length < 1 || input.length > 4_096) return { error: "invalid_request" };
  const messages: ChatCompletionRequest["messages"] = [];
  for (const item of input) {
    if (!record(item)) return { error: "invalid_request" };
    const type = item.type === undefined ? "message" : item.type;
    if (type === "function_call") {
      if (typeof item.call_id !== "string" || item.call_id.length < 1 || item.call_id.length > MAX_CALL_ID) return { error: "invalid_request" };
      if (typeof item.name !== "string" || !TOOL_NAME.test(item.name) || typeof item.arguments !== "string") return { error: "invalid_request" };
      const call = { id: item.call_id, type: "function", function: { name: item.name, arguments: item.arguments } };
      // Consecutive calls of one model turn become one assistant message (parallel tool calls).
      const previous = messages.at(-1) as (ChatMessage & { tool_calls?: unknown[] }) | undefined;
      if (previous?.role === "assistant" && Array.isArray(previous.tool_calls)) previous.tool_calls.push(call);
      else messages.push({ role: "assistant", content: null, tool_calls: [call] } as ChatMessage);
      continue;
    }
    if (type === "function_call_output") {
      if (typeof item.call_id !== "string" || item.call_id.length < 1 || item.call_id.length > MAX_CALL_ID) return { error: "invalid_request" };
      // Chat Completions does not carry image/file tool results on this route.
      // Refuse unsupported parts instead of stripping them from the caller's context.
      if (Array.isArray(item.output) && item.output.some(part => !record(part) || !["input_text", "output_text", "text"].includes(String(part.type)) || typeof part.text !== "string")) {
        return { error: "unsupported_input_item" };
      }
      const output = typeof item.output === "string" ? item.output : Array.isArray(item.output) ? openAIPartsToText(item.output) : undefined;
      if (output === undefined) return { error: "invalid_request" };
      messages.push({ role: "tool", tool_call_id: item.call_id, content: output } as ChatMessage);
      continue;
    }
    if (type !== "message") return { error: "unsupported_input_item" };
    if (typeof item.role !== "string" || !["system", "developer", "user", "assistant"].includes(item.role)) return { error: "invalid_request" };
    if (typeof item.content === "string") {
      messages.push({ role: item.role, content: item.content });
      continue;
    }
    if (Array.isArray(item.content)) {
      const content = responsesPartsToChat(item.content);
      if (content === undefined) return { error: "unsupported_input_item" };
      messages.push({ role: item.role, content });
      continue;
    }
    return { error: "invalid_request" };
  }
  return { messages };
}

/** Text parts join into a string; images become image_url parts; other kinds are refused. */
function responsesPartsToChat(parts: unknown[]): string | Array<Record<string, unknown>> | undefined {
  const out: Array<Record<string, unknown>> = [];
  let hasImage = false;
  for (const part of parts) {
    if (!record(part)) return undefined;
    if ((part.type === "input_text" || part.type === "output_text" || part.type === "text") && typeof part.text === "string") {
      out.push({ type: "text", text: part.text });
    } else if (part.type === "input_image" && typeof part.image_url === "string" && /^(https:|data:image\/)/.test(part.image_url)) {
      hasImage = true;
      out.push({ type: "image_url", image_url: { url: part.image_url, ...(typeof part.detail === "string" ? { detail: part.detail } : {}) } });
    } else {
      return undefined;
    }
  }
  return hasImage ? out : out.map((part) => String(part.text)).join("");
}

function openAIPartsToText(parts: unknown[]): string {
  const texts: string[] = [];
  for (const part of parts) {
    if (record(part) && (part.type === "text" || part.type === "input_text" || part.type === "output_text") && typeof part.text === "string") {
      texts.push(part.text);
    }
  }
  return texts.join("");
}

type StreamItem =
  | { kind: "message"; outputIndex: number; id: string }
  | { kind: "function_call"; outputIndex: number; id: string; callId: string; name: string; arguments: string; added: boolean };

/**
 * Transform OpenAI chat.completion.chunk SSE → Responses API SSE (text, refusals and function calls).
 * Items get output indexes in order of first appearance. The terminal event is emitted only
 * after an upstream terminal (finish_reason followed by [DONE] or a clean end). An upstream
 * that ends without finish_reason yields `response.failed` with the partial output
 * preserved — never a fabricated `response.completed`.
 */
export function openAiSseToResponsesSse(body: ReadableStream<Uint8Array>, fallbackModel?: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder();
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let started = false;
  let finished = false;
  let finishReason: string | undefined;
  let totalBytes = 0;
  let sequence = 0;
  let responseId = `resp_${Date.now()}`;
  let model = fallbackModel ?? "unknown";
  const createdAt = Math.floor(Date.now() / 1000);
  const contentParts: ResponseMessagePart[] = [];
  let usage: { input_tokens: number; output_tokens: number; total_tokens: number } | null = null;
  let messageItem: Extract<StreamItem, { kind: "message" }> | undefined;
  const calls = new Map<number, Extract<StreamItem, { kind: "function_call" }>>();
  let nextOutputIndex = 0;

  const emit = (controller: ReadableStreamDefaultController<Uint8Array>, type: string, payload: Record<string, unknown>) => {
    controller.enqueue(encoder.encode(`event: ${type}\ndata: ${JSON.stringify({ type, sequence_number: sequence++, ...payload })}\n\n`));
  };
  const messageView = (status: string) => ({
    id: messageItem!.id, type: "message", status, role: "assistant",
    content: contentParts.map(part => ({ ...part })),
  });
  const callView = (call: Extract<StreamItem, { kind: "function_call" }>, status: string) => ({
    id: call.id, type: "function_call", status, call_id: call.callId, name: call.name, arguments: call.arguments,
  });
  const outputView = (status: string) => {
    const items: Array<{ index: number; view: Record<string, unknown> }> = [];
    if (messageItem) items.push({ index: messageItem.outputIndex, view: messageView(status) });
    for (const call of calls.values()) if (call.added) items.push({ index: call.outputIndex, view: callView(call, status) });
    return items.sort((a, b) => a.index - b.index).map((item) => item.view);
  };
  const snapshot = (status: string, extra: Record<string, unknown> = {}) => ({
    id: responseId, object: "response", created_at: createdAt, status, model,
    output: outputView(status === "completed" ? "completed" : "incomplete"),
    usage, ...extra,
  });
  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (started || closed) return;
    started = true;
    emit(controller, "response.created", { response: { ...snapshot("in_progress"), output: [], usage: null } });
    emit(controller, "response.in_progress", { response: { ...snapshot("in_progress"), output: [], usage: null } });
  };
  const ensureMessage = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    ensureStarted(controller);
    if (messageItem || closed) return;
    messageItem = { kind: "message", outputIndex: nextOutputIndex++, id: `msg_${responseId.replace(/^resp_/, "")}` };
    emit(controller, "response.output_item.added", { output_index: messageItem.outputIndex, item: { id: messageItem.id, type: "message", status: "in_progress", role: "assistant", content: [] } });
  };
  const ensureContent = (controller: ReadableStreamDefaultController<Uint8Array>, type: ResponseMessagePart["type"]) => {
    ensureMessage(controller);
    const existing = contentParts.findIndex(part => part.type === type);
    if (existing >= 0) return existing;
    const contentIndex = contentParts.length;
    const part: ResponseMessagePart = type === "output_text" ? { type, text: "", annotations: [] } : { type, refusal: "" };
    contentParts.push(part);
    emit(controller, "response.content_part.added", { item_id: messageItem!.id, output_index: messageItem!.outputIndex, content_index: contentIndex, part });
    return contentIndex;
  };
  const onContentDelta = (controller: ReadableStreamDefaultController<Uint8Array>, type: ResponseMessagePart["type"], delta: string) => {
    const contentIndex = ensureContent(controller, type);
    const part = contentParts[contentIndex]!;
    if (part.type === "output_text") part.text += delta;
    else part.refusal += delta;
    emit(controller, type === "output_text" ? "response.output_text.delta" : "response.refusal.delta", {
      item_id: messageItem!.id, output_index: messageItem!.outputIndex, content_index: contentIndex, delta,
    });
  };
  /** Tool-call fragments: added once the name is known; argument fragments stream as deltas. */
  const onToolDelta = (controller: ReadableStreamDefaultController<Uint8Array>, fragment: Record<string, unknown>) => {
    const index = fragment.index;
    if (typeof index !== "number" || !Number.isSafeInteger(index) || index < 0 || index >= MAX_TOOLS) throw new Error("upstream_tool_call_invalid");
    if (fragment.type !== undefined && fragment.type !== "function") throw new Error("upstream_tool_call_invalid");
    if (fragment.function !== undefined && !record(fragment.function)) throw new Error("upstream_tool_call_invalid");
    const fn = record(fragment.function) ? fragment.function : {};
    if (fn.arguments !== undefined && typeof fn.arguments !== "string") throw new Error("upstream_tool_call_invalid");
    if (fn.name !== undefined && (typeof fn.name !== "string" || !TOOL_NAME.test(fn.name))) throw new Error("upstream_tool_call_invalid");
    if (fragment.id !== undefined && (typeof fragment.id !== "string" || fragment.id.length < 1 || fragment.id.length > MAX_CALL_ID)) throw new Error("upstream_tool_call_invalid");
    let call = calls.get(index);
    if (!call) {
      call = { kind: "function_call", outputIndex: -1, id: "", callId: "", name: "", arguments: "", added: false };
      calls.set(index, call);
    }
    if (typeof fragment.id === "string") {
      if (call.callId && call.callId !== fragment.id) throw new Error("upstream_tool_call_invalid");
      if ([...calls.values()].some(other => other !== call && other.callId === fragment.id)) throw new Error("upstream_tool_call_invalid");
      call.callId = fragment.id;
      call.id = `fc_${fragment.id}`;
    }
    if (typeof fn.name === "string") {
      if (call.name && call.name !== fn.name) throw new Error("upstream_tool_call_invalid");
      call.name = fn.name;
    }
    const argumentDelta = typeof fn.arguments === "string" ? fn.arguments : "";
    if (!call.added && call.name.length > 0 && call.callId.length > 0) {
      ensureStarted(controller);
      call.added = true;
      call.outputIndex = nextOutputIndex++;
      emit(controller, "response.output_item.added", { output_index: call.outputIndex, item: { ...callView(call, "in_progress"), arguments: "" } });
      if (call.arguments.length > 0) emit(controller, "response.function_call_arguments.delta", { item_id: call.id, output_index: call.outputIndex, delta: call.arguments });
    }
    if (argumentDelta.length > 0) {
      call.arguments += argumentDelta;
      if (call.added) emit(controller, "response.function_call_arguments.delta", { item_id: call.id, output_index: call.outputIndex, delta: argumentDelta });
    }
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      const close = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
        cancelStream(reader);
      };
      const fail = (code: string) => {
        if (closed || finished) return;
        finished = true;
        ensureStarted(controller);
        emit(controller, "response.failed", { response: snapshot("failed", { error: { code, message: "Upstream stream ended without a terminal event." } }) });
        close();
      };
      const complete = () => {
        if (closed || finished) return;
        if ([...calls.values()].some(call => !call.added) || (finishReason === "tool_calls" && calls.size === 0)) {
          fail("upstream_tool_call_invalid"); return;
        }
        finished = true;
        const addedCalls = [...calls.values()].filter((call) => call.added);
        if (addedCalls.length === 0 && contentParts.length === 0) ensureContent(controller, "output_text");
        const incomplete = finishReason === "length" || finishReason === "content_filter";
        const itemStatus = incomplete ? "incomplete" : "completed";
        const closing: Array<{ index: number; run: () => void }> = [];
        if (messageItem) {
          const item = messageItem;
          closing.push({ index: item.outputIndex, run: () => {
            for (const [contentIndex, part] of contentParts.entries()) {
              const identity = { item_id: item.id, output_index: item.outputIndex, content_index: contentIndex };
              if (part.type === "output_text") emit(controller, "response.output_text.done", { ...identity, text: part.text });
              else emit(controller, "response.refusal.done", { ...identity, refusal: part.refusal });
              emit(controller, "response.content_part.done", { ...identity, part });
            }
            emit(controller, "response.output_item.done", { output_index: item.outputIndex, item: messageView(itemStatus) });
          } });
        }
        for (const call of addedCalls) {
          closing.push({ index: call.outputIndex, run: () => {
            emit(controller, "response.function_call_arguments.done", { item_id: call.id, output_index: call.outputIndex, arguments: call.arguments });
            emit(controller, "response.output_item.done", { output_index: call.outputIndex, item: callView(call, itemStatus) });
          } });
        }
        for (const entry of closing.sort((a, b) => a.index - b.index)) entry.run();
        if (incomplete) {
          const reason = finishReason === "length" ? "max_output_tokens" : "content_filter";
          emit(controller, "response.incomplete", { response: snapshot("incomplete", { incomplete_details: { reason } }) });
        } else {
          emit(controller, "response.completed", { response: snapshot("completed") });
        }
        close();
      };

      const parser = createParser({
        maxBufferSize: MAX_SSE_EVENT_BUFFER,
        onEvent: ({ data }) => {
          if (closed || finished) return;
          if (data === "[DONE]") { if (finishReason) complete(); else fail("stream_interrupted"); return; }
          let parsed: Record<string, unknown> | undefined;
          try { const value = JSON.parse(data) as unknown; parsed = record(value) ? value : undefined; } catch { parsed = undefined; }
          if (!parsed || parsed.error) { fail("upstream_stream_error"); return; }
          if (!started && typeof parsed.id === "string" && parsed.id.length > 0) {
            responseId = parsed.id.startsWith("resp_") ? parsed.id : `resp_${parsed.id.replace(/^chatcmpl[_-]?/, "")}`;
          }
          if (typeof parsed.model === "string" && parsed.model.length > 0) model = parsed.model;
          const reported = responseUsage(parsed.usage);
          if (reported !== null) usage = reported;
          const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
          const first = record(choices[0]) ? choices[0] : undefined;
          const delta = first && record(first.delta) ? first.delta : undefined;
          let observed = false;
          if (delta && delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== "string") {
            fail("upstream_refusal_invalid"); return;
          }
          if (delta && typeof delta.content === "string" && delta.content.length > 0) {
            onContentDelta(controller, "output_text", delta.content);
            observed = true;
          }
          if (delta && typeof delta.refusal === "string" && delta.refusal.length > 0) {
            onContentDelta(controller, "refusal", delta.refusal);
            observed = true;
          }
          if (delta && delta.tool_calls !== undefined) {
            if (!Array.isArray(delta.tool_calls)) { fail("upstream_tool_call_invalid"); return; }
            for (const fragment of delta.tool_calls) {
              if (!record(fragment)) { fail("upstream_tool_call_invalid"); return; }
              try { onToolDelta(controller, fragment); } catch { fail("upstream_tool_call_invalid"); return; }
            }
            observed = true;
          }
          if (!observed) ensureStarted(controller);
          // Terminal waits for [DONE]/end so a trailing usage-only chunk is not lost.
          if (first && typeof first.finish_reason === "string" && first.finish_reason.length > 0) finishReason = first.finish_reason;
        },
        onError: () => { fail("upstream_stream_error"); },
      });

      const pump = async () => {
        try {
          for (;;) {
            if (closed) return;
            const part = await reader!.read();
            if (part.done) {
              parser.feed(decoder.decode());
              if (!finished) { if (finishReason) complete(); else fail("stream_interrupted"); }
              return;
            }
            if (!part.value || part.value.byteLength === 0) continue;
            totalBytes += part.value.byteLength;
            if (totalBytes > MAX_SSE_TRANSFORM_BYTES) { fail("stream_too_large"); return; }
            parser.feed(decoder.decode(part.value, { stream: true }));
          }
        } catch {
          fail("stream_interrupted");
        }
      };
      void pump();
    },
    cancel(reason) {
      closed = true;
      cancelStream(reader, reason);
    },
  });
}
