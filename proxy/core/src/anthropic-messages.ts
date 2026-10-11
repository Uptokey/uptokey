import { createParser } from "eventsource-parser";
import type { ChatCompletionRequest } from "./types.ts";
import { isDataRecord as record } from "@uptokey/sync-contract/plain-data";
import { cancelStream } from "./stream-lifecycle.ts";

const ANTHROPIC_ROLES = new Set(["user", "assistant"]);
const MAX_SSE_EVENT_BUFFER = 1_048_576;
const MAX_SSE_TRANSFORM_BYTES = 16 * 1024 * 1024;

/** Parse Anthropic Messages API request → OpenAI-shaped ChatCompletionRequest. */
export function anthropicMessagesToChatCompletion(value: unknown): ChatCompletionRequest | { error: string } {
  if (!record(value)) return { error: "invalid_request" };
  if (value.stream !== undefined && typeof value.stream !== "boolean") return { error: "invalid_request" };
  if (typeof value.max_tokens !== "number" || !Number.isFinite(value.max_tokens) || value.max_tokens < 1 || value.max_tokens > 1_000_000) {
    return { error: "invalid_request" };
  }
  if (!Array.isArray(value.messages) || value.messages.length < 1 || value.messages.length > 4_096) return { error: "invalid_request" };
  if (value.model !== undefined && (typeof value.model !== "string" || value.model.length < 1 || value.model.length > 200)) {
    return { error: "invalid_request" };
  }

const messages: ChatCompletionRequest["messages"] = [];

  try {
    const systemText = anthropicSystemToString(value.system);
    if (systemText !== undefined) messages.push({ role: "system", content: systemText });
    const pending = new Set<string>();
    for (const item of value.messages) {
      if (!record(item) || typeof item.role !== "string" || !ANTHROPIC_ROLES.has(item.role)) invalidTool();
      if (item.role === 'assistant') {
        if (pending.size) invalidTool();
        const parsed = anthropicAssistant(item.content);
        for (const call of parsed.tool_calls ?? []) pending.add(call.id);
        messages.push({ role: 'assistant', content: parsed.content, ...(parsed.tool_calls ? { tool_calls: parsed.tool_calls } : {}) } as WireMessage);
      } else if (typeof item.content === 'string') {
        if (pending.size) invalidTool();
        messages.push({ role: 'user', content: item.content });
      } else {
        if (!Array.isArray(item.content)) invalidTool();
        const parts: unknown[] = [];
        for (const block of item.content) {
          if (!record(block)) invalidTool();
          if (block.type === 'tool_result') {
            if (parts.length || !validId(block.tool_use_id) || !pending.delete(block.tool_use_id)) invalidTool();
            // OpenAI has no error-result flag. Refuse it instead of claiming success.
            if (block.is_error === true) unsupportedTool();
            if (block.is_error !== undefined && block.is_error !== false) invalidTool();
            const content = block.content === undefined ? '' : strictAnthropicText(block.content);
            messages.push({ role: 'tool', tool_call_id: block.tool_use_id, content } as WireMessage);
          } else {
            if (pending.size) invalidTool();
            parts.push(block);
          }
        }
        if (parts.length || item.content.length === 0) messages.push({ role: 'user', content: strictAnthropicText(parts) });
      }
    }
  } catch (error) { return conversionFailure(error); }

  const request: ChatCompletionRequest = {
    messages,
    max_tokens: Math.floor(value.max_tokens),
  };
  // Known scalar fields with a wrong type are rejected, never silently dropped or coerced.
  for (const key of ["temperature", "top_p"] as const) {
    const scalar = value[key];
    if (scalar === undefined || scalar === null) continue;
    if (typeof scalar !== "number" || !Number.isFinite(scalar)) return { error: "invalid_request" };
  }
  if (value.stop_sequences !== undefined && value.stop_sequences !== null &&
      (!Array.isArray(value.stop_sequences) || !value.stop_sequences.every((s) => typeof s === "string"))) {
    return { error: "invalid_request" };
  }
  if (typeof value.model === "string") request.model = value.model;
  if (typeof value.temperature === "number") request.temperature = value.temperature;
  if (typeof value.top_p === "number") request.top_p = value.top_p;
  if (Array.isArray(value.stop_sequences)) {
    request.stop = value.stop_sequences;
  }
  if (value.stream === true) request.stream = true;
  if (value.stream === false) request.stream = false;
  try { Object.assign(request, anthropicToolsToOpenAI(value)); }
  catch (error) { return conversionFailure(error); }
  return request;
}

/** Convert OpenAI chat.completion JSON → Anthropic Messages response shape. */
export function chatCompletionToAnthropicMessage(body: unknown, fallbackModel?: string): Record<string, unknown> | undefined {
  if (!record(body)) return undefined;
  const choices = Array.isArray(body.choices) ? body.choices : undefined;
  const first = choices?.[0];
  if (!record(first)) return undefined;
  const message = record(first.message) ? first.message : undefined;
  if (!message) return undefined;
  let content: Record<string, unknown>[];
  try { content = openAIAssistantBlocks(message); } catch { return undefined; }
  const usage = record(body.usage) ? body.usage : undefined;
  const prompt = typeof usage?.prompt_tokens === "number" ? usage.prompt_tokens : 0;
  const completion = typeof usage?.completion_tokens === "number" ? usage.completion_tokens : 0;
  const finish = typeof first.finish_reason === "string" ? first.finish_reason : "stop";
  if (finish === 'tool_calls' && !content.some(block => block.type === 'tool_use')) return undefined;
  return {
    id: typeof body.id === "string" ? body.id : `msg_${Date.now()}`,
    type: "message",
    role: "assistant",
    model: typeof body.model === "string" ? body.model : (fallbackModel ?? "unknown"),
    content,
    stop_reason: typeof message.refusal === 'string' && message.refusal ? 'refusal' : openAIFinishToAnthropic(finish),
    stop_sequence: null,
    usage: openAIUsageToAnthropic(usage, prompt, completion),
  };
}

/** OpenAI ChatCompletionRequest → Anthropic Messages API request body (upstream). */
export function chatCompletionToAnthropicRequest(request: ChatCompletionRequest): Record<string, unknown> {
  const systemParts: string[] = [];
  const messages: Array<{ role: string; content: unknown }> = [];
  const pending = new Set<string>();
  for (const rawMessage of request.messages) {
    const message: WireMessage = rawMessage;
    if (!record(message)) invalidTool();
    if (message.role === "system" || message.role === "developer") {
      if (pending.size) invalidTool();
      const text = strictOpenAIText(message.content);
      if (text) systemParts.push(text);
      continue;
    }
    if (message.role === 'tool') {
      if (!validId(message.tool_call_id) || !pending.delete(message.tool_call_id)) invalidTool();
      const block = { type: 'tool_result', tool_use_id: message.tool_call_id, content: strictOpenAIText(message.content) };
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content)) last.content.push(block);
      else messages.push({ role: 'user', content: [block] });
      continue;
    }
    if (pending.size) invalidTool();
    if (message.role === 'assistant') {
      const blocks = openAIAssistantBlocks(message);
      for (const block of blocks) if (block.type === 'tool_use') pending.add(String(block.id));
      messages.push({ role: 'assistant', content: blocks });
    } else if (message.role === 'user') {
      const text = strictOpenAIText(message.content);
      const last = messages.at(-1);
      if (last?.role === 'user' && Array.isArray(last.content) && last.content.some(block => record(block) && block.type === 'tool_result')) last.content.push({ type: 'text', text });
      else messages.push({ role: 'user', content: text });
    } else unsupportedTool();
  }
  if (messages.length === 0) messages.push({ role: "user", content: "" });

  const maxTokens = typeof request.max_tokens === "number" && Number.isFinite(request.max_tokens) && request.max_tokens >= 1
    ? Math.floor(request.max_tokens)
    : typeof request.max_completion_tokens === "number" && Number.isFinite(request.max_completion_tokens) && request.max_completion_tokens >= 1
      ? Math.floor(request.max_completion_tokens)
      : 4096;

  const body: Record<string, unknown> = {
    model: request.model,
    messages,
    max_tokens: maxTokens,
  };
  if (systemParts.length > 0) body.system = systemParts.join("\n\n");
  if (typeof request.temperature === "number") body.temperature = request.temperature;
  if (typeof request.top_p === "number") body.top_p = request.top_p;
  if (request.stop !== undefined) {
    body.stop_sequences = Array.isArray(request.stop) ? request.stop : [request.stop];
  }
  if (request.stream === true) body.stream = true;
  Object.assign(body, openAIToolsToAnthropic(request));
  return body;
}

/** Anthropic Messages JSON → OpenAI chat.completion shape (upstream response). */
export function anthropicResponseToChatCompletion(body: unknown): Record<string, unknown> | undefined {
  if (!record(body)) return undefined;
  let message: ReturnType<typeof anthropicAssistant>;
  try { message = anthropicAssistant(body.content); } catch { return undefined; }
  if (body.stop_reason === 'tool_use' && !message.tool_calls?.length) return undefined;
  const usage = record(body.usage) ? body.usage : undefined;
  const cached = reportedCacheCount(usage?.cache_read_input_tokens),written=reportedCacheCount(usage?.cache_creation_input_tokens);
  const input = (typeof usage?.input_tokens === "number" ? usage.input_tokens : 0)+(cached??0)+(written??0);
  const output = typeof usage?.output_tokens === "number" ? usage.output_tokens : 0;
  return {
    id: typeof body.id === "string" ? body.id : `chatcmpl_${Date.now()}`,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: typeof body.model === "string" ? body.model : "unknown",
    choices: [{
      index: 0,
      message: { role: "assistant", ...message },
      finish_reason: anthropicStopToOpenAI(typeof body.stop_reason === "string" ? body.stop_reason : "end_turn"),
    }],
    usage: {
      prompt_tokens: input,
      completion_tokens: output,
      total_tokens: input + output,
      ...(cached!==null?{prompt_tokens_details:{cached_tokens:cached}}:{}),
      ...(written!==null?{cache_creation_input_tokens:written}:{}),
    },
  };
}

/** Transform Anthropic Messages SSE → OpenAI chat.completion.chunk SSE (ends with [DONE]). */
export function anthropicSseToOpenAiSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let emittedRole = false;
  let finished = false;
  let totalBytes = 0;
  let messageId = `chatcmpl_${Date.now()}`;
  let model = "unknown";
  let created = Math.floor(Date.now() / 1000);
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  let cachedTokens:number|null=null,writtenTokens:number|null=null;
  const blocks = new Map<number, { type: 'text' | 'tool_use'; stopped: boolean; toolIndex?: number; input?: string; fragments?: string; hasFragments?: boolean }>();
  const toolIds = new Set<string>();
  let toolCount = 0;

  const emitOpenAi = (payload: Record<string, unknown>): Uint8Array =>
    encoder.encode(`data: ${JSON.stringify(payload)}\n\n`);
  const emitDone = (): Uint8Array => encoder.encode("data: [DONE]\n\n");

  const openAiChunk = (delta: Record<string, unknown>, finish: string | null = null, usage?: Record<string, unknown>): Record<string, unknown> => {
    const payload: Record<string, unknown> = {
      id: messageId,
      object: "chat.completion.chunk",
      created,
      model,
      choices: [{ index: 0, delta, finish_reason: finish }],
    };
    if (usage) payload.usage = usage;
    return payload;
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      const failClosed = () => {
        if (closed) return;
        closed = true;
        cancelStream(reader);
        try { controller.error(new Error("anthropic_sse_transform_failed")); } catch { /* already closed */ }
      };
      const closeOk = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const enqueue = (bytes: Uint8Array) => {
        if (closed) return;
        if (totalBytes > MAX_SSE_TRANSFORM_BYTES) { failClosed(); return; }
        controller.enqueue(bytes);
      };

      const parser = createParser({
        maxBufferSize: MAX_SSE_EVENT_BUFFER,
        onEvent: ({ event, data }) => {
          if (closed || finished) return;
          if (data.length > MAX_SSE_EVENT_BUFFER) { failClosed(); return; }
          const type = event || (safeJson(data)?.type as string | undefined);
          if (type === "ping") return;
          if (type === "error") { failClosed(); return; }

          const parsed = safeJson(data);
          if (!parsed) { failClosed(); return; }
          if (event && parsed.type !== undefined && parsed.type !== event) { failClosed(); return; }

          if (type === "message_start") {
            if (emittedRole) { failClosed(); return; }
            const message = record(parsed.message) ? parsed.message : undefined;
            if (message) {
              if (typeof message.id === "string" && message.id.length > 0) {
                messageId = message.id.startsWith("chatcmpl_") ? message.id : `chatcmpl_${message.id}`;
              }
              if (typeof message.model === "string") model = message.model;
              const usage = record(message.usage) ? message.usage : undefined;
              if (typeof usage?.input_tokens === "number") promptTokens = usage.input_tokens;
              cachedTokens=reportedCacheCount(usage?.cache_read_input_tokens);writtenTokens=reportedCacheCount(usage?.cache_creation_input_tokens);
            }
            if (!emittedRole) {
              emittedRole = true;
              enqueue(emitOpenAi(openAiChunk({ role: "assistant" })));
            }
            return;
          }

          if (type === 'content_block_start') {
            const block = record(parsed.content_block) ? parsed.content_block : undefined;
            if (!Number.isSafeInteger(parsed.index) || Number(parsed.index) < 0 || blocks.has(Number(parsed.index)) || !block) { failClosed(); return; }
            const index = Number(parsed.index);
            if (block.type === 'text' && typeof block.text === 'string') {
              blocks.set(index, { type: 'text', stopped: false });
              if (block.text) enqueue(emitOpenAi(openAiChunk({ content: block.text })));
            } else if (block.type === 'tool_use') {
              if (!validId(block.id) || toolIds.has(block.id) || !validName(block.name) || !record(block.input) || toolCount >= MAX_TOOLS) { failClosed(); return; }
              const toolIndex = toolCount++;
              toolIds.add(block.id);
              const input = JSON.stringify(toolInput(block.input));
              blocks.set(index, { type: 'tool_use', stopped: false, toolIndex, input, fragments: '', hasFragments: false });
              enqueue(emitOpenAi(openAiChunk({ tool_calls: [{ index: toolIndex, id: block.id, type: 'function', function: { name: block.name, arguments: input === '{}' ? '' : input } }] })));
            } else failClosed();
            return;
          }

          if (type === 'content_block_stop') {
            const block = blocks.get(Number(parsed.index));
            if (!block || block.stopped) { failClosed(); return; }
            if (block.type === 'tool_use') {
              const hasJson = Boolean(block.fragments?.length);
              try { toolArguments(hasJson ? block.fragments : block.input); }
              catch { failClosed(); return; }
              if (!hasJson && block.input === '{}') enqueue(emitOpenAi(openAiChunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: '{}' } }] })));
            }
            block.stopped = true;
            return;
          }

          if (type === "content_block_delta") {
            const delta = record(parsed.delta) ? parsed.delta : undefined;
            const block = blocks.get(Number(parsed.index));
            if (delta?.type === 'input_json_delta') {
              if (!block || block.type !== 'tool_use' || block.stopped || block.input !== '{}' || typeof delta.partial_json !== 'string') { failClosed(); return; }
              block.hasFragments = true;
              block.fragments += delta.partial_json;
              enqueue(emitOpenAi(openAiChunk({ tool_calls: [{ index: block.toolIndex, function: { arguments: delta.partial_json } }] })));
              return;
            }
            if (!delta || delta.type !== 'text_delta' || block && (block.type !== 'text' || block.stopped)) { failClosed(); return; }
            const text = delta && typeof delta.text === "string" ? delta.text
              : delta && delta.type === "text_delta" && typeof delta.text === "string" ? delta.text
              : undefined;
            if (typeof text === "string" && text.length > 0) {
              if (!emittedRole) {
                emittedRole = true;
                enqueue(emitOpenAi(openAiChunk({ role: "assistant" })));
              }
              enqueue(emitOpenAi(openAiChunk({ content: text })));
            }
            return;
          }

          if (type === "message_delta") {
            const delta = record(parsed.delta) ? parsed.delta : undefined;
            if (delta && typeof delta.stop_reason === "string") {
              finishReason = anthropicStopToOpenAI(delta.stop_reason);
            }
            const usage = record(parsed.usage) ? parsed.usage : undefined;
            if (typeof usage?.output_tokens === "number") completionTokens = usage.output_tokens;
            if (typeof usage?.input_tokens === "number") promptTokens = usage.input_tokens;
            cachedTokens=reportedCacheCount(usage?.cache_read_input_tokens)??cachedTokens;writtenTokens=reportedCacheCount(usage?.cache_creation_input_tokens)??writtenTokens;
            return;
          }

          if (type === "message_stop") {
            if ([...blocks.values()].some(block => !block.stopped) || toolCount > 0 && !['tool_calls', 'length', 'content_filter'].includes(finishReason ?? '') || finishReason === 'tool_calls' && toolCount === 0) { failClosed(); return; }
            finished = true;
            if (!emittedRole) {
              emittedRole = true;
              enqueue(emitOpenAi(openAiChunk({ role: "assistant" })));
            }
            const usage = {
              prompt_tokens: promptTokens+(cachedTokens??0)+(writtenTokens??0),
              completion_tokens: completionTokens,
              total_tokens: promptTokens + completionTokens+(cachedTokens??0)+(writtenTokens??0),
              ...(cachedTokens!==null?{prompt_tokens_details:{cached_tokens:cachedTokens}}:{}),
              ...(writtenTokens!==null?{cache_creation_input_tokens:writtenTokens}:{}),
            };
            enqueue(emitOpenAi(openAiChunk({}, finishReason ?? "stop", usage)));
            enqueue(emitDone());
            closeOk();
            cancelStream(reader);
            return;
          }

        },
        onError: () => { failClosed(); },
      });

      const pump = async () => {
        try {
          for (;;) {
            if (closed) return;
            const part = await reader!.read();
            if (part.done) {
              decoder.decode();
              if (!finished && !closed) {
                // Upstream ended without message_stop — fail closed rather than inventing completion.
                failClosed();
              }
              return;
            }
            if (!part.value || part.value.byteLength === 0) continue;
            totalBytes += part.value.byteLength;
            if (totalBytes > MAX_SSE_TRANSFORM_BYTES) { failClosed(); return; }
            const text = decoder.decode(part.value, { stream: true });
            for (let offset = 0; offset < text.length && !closed; offset += 16_384) {
              parser.feed(text.slice(offset, offset + 16_384));
            }
          }
        } catch {
          failClosed();
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

/** Transform OpenAI chat.completion.chunk SSE → Anthropic Messages SSE. */
export function openAiSseToAnthropicSse(body: ReadableStream<Uint8Array>): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const decoder = new TextDecoder('utf-8', { fatal: true });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  let closed = false;
  let started = false;
  let blockStarted = false;
  let finished = false;
  let finishReason: string | undefined;
  let totalBytes = 0;
  let messageId = `msg_${Date.now()}`;
  let model = "unknown";
  let inputTokens = 0;
  let inputReported = false;
  let outputTokens = 0;
  let usageSnapshot: Record<string, unknown> = {};
  let refusal = false;
  const tools = new Map<number, { id: string; name: string; fragments: string[] }>();

  const emitAnthropic = (event: string, payload: Record<string, unknown>): Uint8Array =>
    encoder.encode(`event: ${event}\ndata: ${JSON.stringify(payload)}\n\n`);

  const ensureStarted = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    if (started || closed) return;
    started = true;
    controller.enqueue(emitAnthropic("message_start", {
      type: "message_start",
      message: {
        id: messageId,
        type: "message",
        role: "assistant",
        model,
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: openAIUsageToAnthropic(usageSnapshot, inputTokens, 0),
      },
    }));
  };

  const ensureBlock = (controller: ReadableStreamDefaultController<Uint8Array>) => {
    ensureStarted(controller);
    if (blockStarted || closed) return;
    blockStarted = true;
    controller.enqueue(emitAnthropic("content_block_start", {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "" },
    }));
  };

  return new ReadableStream<Uint8Array>({
    start(controller) {
      reader = body.getReader();
      const failClosed = () => {
        if (closed) return;
        closed = true;
        cancelStream(reader);
        // This surface speaks Anthropic SSE: propagate even a transport failure
        // as an observable error event, never a clean EOF or message_stop.
        try {
          controller.enqueue(emitAnthropic('error', { type: 'error', error: { type: 'api_error', message: 'Upstream stream could not be converted.' } }));
          controller.close();
        } catch { /* already closed */ }
      };
      const closeOk = () => {
        if (closed) return;
        closed = true;
        try { controller.close(); } catch { /* already closed */ }
      };
      const finish = (stopReason: string) => {
        if (finished || closed) return;
        const calls = [...tools.entries()].sort(([left], [right]) => left - right);
        const ids = new Set<string>();
        try {
          if (calls.length > 0 && !['tool_use', 'max_tokens', 'refusal'].includes(stopReason) || calls.length === 0 && stopReason === 'tool_use') invalidTool();
          for (const [[index, tool], position] of calls.map((entry, position) => [entry, position] as const)) {
            if (index !== position || !validId(tool.id) || ids.has(tool.id) || !validName(tool.name)) invalidTool();
            ids.add(tool.id);
            toolArguments(tool.fragments.join(''));
          }
        } catch { interrupted(); return; }
        finished = true;
        if (!calls.length) ensureBlock(controller); else ensureStarted(controller);
        if (blockStarted) controller.enqueue(emitAnthropic("content_block_stop", { type: "content_block_stop", index: 0 }));
        // OpenAI may interleave parallel tool deltas. Anthropic SDK callbacks
        // require contiguous blocks, so flush validated calls one at a time.
        for (const [position, [, tool]] of calls.entries()) {
          const index = position + (blockStarted ? 1 : 0);
          controller.enqueue(emitAnthropic('content_block_start', { type: 'content_block_start', index, content_block: { type: 'tool_use', id: tool.id, name: tool.name, input: {} } }));
          for (const fragment of tool.fragments) controller.enqueue(emitAnthropic('content_block_delta', { type: 'content_block_delta', index, delta: { type: 'input_json_delta', partial_json: fragment } }));
          controller.enqueue(emitAnthropic('content_block_stop', { type: 'content_block_stop', index }));
        }
        const finalUsage = openAIUsageToAnthropic(usageSnapshot, inputTokens, outputTokens);
        if (!inputReported) delete finalUsage.input_tokens;
        controller.enqueue(emitAnthropic("message_delta", {
          type: "message_delta",
          delta: { stop_reason: stopReason, stop_sequence: null },
          // Usage usually arrives after the text (stream_options.include_usage); the start event
          // cannot know it, so the final message_delta carries the reported input as well.
          // Anthropic SDK 0.68.0 MessageDeltaUsage/MessageStream applies these cumulative
          // input tokens to the final message snapshot (it does not add them to start usage).
          usage: finalUsage,
        }));
        controller.enqueue(emitAnthropic("message_stop", { type: "message_stop" }));
        closeOk();
        cancelStream(reader);
      };
      // Upstream ended without finish_reason: surface an Anthropic `error` event instead of a fabricated end_turn.
      const interrupted = () => {
        if (finished || closed) return;
        finished = true;
        if (!started) { failClosed(); return; }
        controller.enqueue(emitAnthropic("error", { type: "error", error: { type: "api_error", message: "Upstream stream ended without a terminal event." } }));
        closeOk();
        cancelStream(reader);
      };
      const terminal = () => { if (finishReason) finish(refusal ? 'refusal' : openAIFinishToAnthropic(finishReason)); else interrupted(); };

      const parser = createParser({
        maxBufferSize: MAX_SSE_EVENT_BUFFER,
        onEvent: ({ data }) => {
          if (closed || finished) return;
          if (data.length > MAX_SSE_EVENT_BUFFER) { failClosed(); return; }
          if (data === "[DONE]") { terminal(); return; }
          const parsed = safeJson(data);
          if (!parsed) { failClosed(); return; }
          if (parsed.error) { failClosed(); return; }

          if (typeof parsed.id === "string" && parsed.id.length > 0) {
            messageId = parsed.id.startsWith("msg_") ? parsed.id : `msg_${parsed.id.replace(/^chatcmpl_?/, "")}`;
          }
          if (typeof parsed.model === "string") model = parsed.model;

          const usage = record(parsed.usage) ? parsed.usage : undefined;
          if (usage) usageSnapshot = { ...usageSnapshot, ...usage };
          if (typeof usage?.prompt_tokens === "number" && Number.isSafeInteger(usage.prompt_tokens) && usage.prompt_tokens >= 0) { inputTokens = usage.prompt_tokens; inputReported = true; }
          if (typeof usage?.completion_tokens === "number" && Number.isSafeInteger(usage.completion_tokens) && usage.completion_tokens >= 0) outputTokens = usage.completion_tokens;

          const choices = Array.isArray(parsed.choices) ? parsed.choices : [];
          const first = record(choices[0]) ? choices[0] : undefined;
          if (!first) return;
          const delta = record(first.delta) ? first.delta : undefined;
          if (delta) {
            if (delta.function_call !== undefined) { failClosed(); return; }
            if (delta.content !== undefined && delta.content !== null && typeof delta.content !== 'string') { failClosed(); return; }
            if (typeof delta.role === "string") ensureStarted(controller);
            if (delta.tool_calls !== undefined) {
              if (!Array.isArray(delta.tool_calls) || finishReason) { failClosed(); return; }
              ensureStarted(controller);
              for (const call of delta.tool_calls) {
                if (!record(call) || !Number.isSafeInteger(call.index) || Number(call.index) < 0 || Number(call.index) >= MAX_TOOLS || call.type !== undefined && call.type !== 'function' || call.function !== undefined && !record(call.function)) { failClosed(); return; }
                const tool = tools.get(Number(call.index)) ?? { id: '', name: '', fragments: [] };
                const fn = record(call.function) ? call.function : undefined;
                if (call.id !== undefined) { if (typeof call.id !== 'string') { failClosed(); return; } tool.id += call.id; }
                if (fn?.name !== undefined) { if (typeof fn.name !== 'string') { failClosed(); return; } tool.name += fn.name; }
                if (fn?.arguments !== undefined) { if (typeof fn.arguments !== 'string') { failClosed(); return; } tool.fragments.push(fn.arguments); }
                tools.set(Number(call.index), tool);
              }
            }
            if (delta.refusal !== undefined && delta.refusal !== null && typeof delta.refusal !== 'string') { failClosed(); return; }
            if (typeof delta.refusal === 'string' && delta.refusal) refusal = true;
            const text = (typeof delta.content === 'string' ? delta.content : '') + (typeof delta.refusal === 'string' ? delta.refusal : '');
            if (text) {
              if (finishReason) { failClosed(); return; }
              ensureBlock(controller);
              controller.enqueue(emitAnthropic("content_block_delta", {
                type: "content_block_delta",
                index: 0,
                delta: { type: "text_delta", text },
              }));
            }
          }
          // Terminal waits for [DONE]/end so a trailing usage-only chunk is reflected in message_delta.
          if (typeof first.finish_reason === "string" && first.finish_reason.length > 0) finishReason = first.finish_reason;
        },
        onError: () => { failClosed(); },
      });

      const pump = async () => {
        try {
          for (;;) {
            if (closed) return;
            const part = await reader!.read();
            if (part.done) {
              decoder.decode();
              if (!finished && !closed) terminal();
              return;
            }
            if (!part.value || part.value.byteLength === 0) continue;
            totalBytes += part.value.byteLength;
            if (totalBytes > MAX_SSE_TRANSFORM_BYTES) { failClosed(); return; }
            const text = decoder.decode(part.value, { stream: true });
            for (let offset = 0; offset < text.length && !closed; offset += 16_384) {
              parser.feed(text.slice(offset, offset + 16_384));
            }
          }
        } catch {
          failClosed();
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

function safeJson(data: string): Record<string, unknown> | undefined {
  try {
    const value = JSON.parse(data) as unknown;
    return record(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

type FunctionCall = { id: string; type: 'function'; function: { name: string; arguments: string } };
type WireMessage = { role: string; content: unknown; [key: string]: unknown };
const MAX_TOOLS = 128;
function invalidTool(): never { throw new Error('anthropic_tool_invalid'); }
function unsupportedTool(): never { throw new Error('anthropic_tool_unsupported'); }
function conversionFailure(error: unknown): { error: string } {
  return { error: error instanceof Error && error.message === 'anthropic_tool_unsupported' ? 'unsupported_tool_type' : 'invalid_request' };
}
function validName(value: unknown): value is string { return typeof value === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(value); }
function validId(value: unknown): value is string { return typeof value === 'string' && value.length > 0 && value.length <= 200 && !/[\x00-\x20]/.test(value); }
function toolInput(value: unknown): Record<string, unknown> {
  if (!record(value)) invalidTool();
  // JSON.parse accepts overflowing number literals as Infinity; JSON.stringify
  // would silently replace those arguments with null at the provider boundary.
  const pending: Array<{ value: unknown; leave?: boolean }> = [{ value }];
  const seen = new Set<object>();
  while (pending.length) {
    const next = pending.pop()!;
    const part = next.value;
    if (next.leave) { seen.delete(part as object); continue; }
    if (part === null || typeof part === 'string' || typeof part === 'boolean') continue;
    if (typeof part === 'number') { if (!Number.isFinite(part)) invalidTool(); continue; }
    if (!part || typeof part !== 'object' || seen.has(part) || !Array.isArray(part) && !record(part)) invalidTool();
    seen.add(part);
    pending.push({ value: part, leave: true });
    for (const child of Object.values(part)) pending.push({ value: child });
  }
  try { return structuredClone(value); } catch { return invalidTool(); }
}
function toolArguments(value: unknown): Record<string, unknown> {
  if (typeof value !== 'string' || value.length > MAX_SSE_TRANSFORM_BYTES) invalidTool();
  try { return toolInput(JSON.parse(value)); } catch { return invalidTool(); }
}
function strictOpenAIText(content: unknown): string {
  if (content === null || content === undefined) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) unsupportedTool();
  return content.map(part => {
    if (!record(part) || !['text', 'input_text'].includes(String(part.type)) || typeof part.text !== 'string') unsupportedTool();
    return part.text;
  }).join('');
}
function strictAnthropicText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) invalidTool();
  return content.map(block => {
    if (!record(block) || block.type !== 'text' || typeof block.text !== 'string') unsupportedTool();
    if (block.cache_control !== undefined || block.citations !== undefined) unsupportedTool();
    return block.text;
  }).join('');
}
function openAIAssistantBlocks(message: Record<string, unknown>): Record<string, unknown>[] {
  if (message.function_call !== undefined) unsupportedTool();
  const text = strictOpenAIText(message.content);
  if (message.refusal !== undefined && message.refusal !== null && typeof message.refusal !== 'string') invalidTool();
  const blocks: Record<string, unknown>[] = text ? [{ type: 'text', text }] : [];
  if (typeof message.refusal === 'string' && message.refusal) blocks.push({ type: 'text', text: message.refusal });
  if (message.tool_calls !== undefined) {
    if (!Array.isArray(message.tool_calls) || message.tool_calls.length > MAX_TOOLS) invalidTool();
    const ids = new Set<string>();
    for (const call of message.tool_calls) {
      if (!record(call) || call.type !== 'function') unsupportedTool();
      if (!validId(call.id) || ids.has(call.id) || !record(call.function) || !validName(call.function.name)) invalidTool();
      ids.add(call.id);
      blocks.push({ type: 'tool_use', id: call.id, name: call.function.name, input: toolArguments(call.function.arguments) });
    }
  }
  return blocks.length ? blocks : [{ type: 'text', text: '' }];
}
function anthropicAssistant(content: unknown): { content: string | null; tool_calls?: FunctionCall[] } {
  if (typeof content === 'string') return { content };
  if (!Array.isArray(content)) invalidTool();
  let text = '';
  const calls: FunctionCall[] = [];
  const ids = new Set<string>();
  for (const block of content) {
    if (!record(block)) invalidTool();
    if (block.type === 'text') text += strictAnthropicText([block]);
    else if (block.type === 'tool_use') {
      if (!validId(block.id) || ids.has(block.id) || !validName(block.name) || calls.length >= MAX_TOOLS) invalidTool();
      ids.add(block.id);
      calls.push({ id: block.id, type: 'function', function: { name: block.name, arguments: JSON.stringify(toolInput(block.input)) } });
    } else unsupportedTool();
  }
  return { content: text || (calls.length ? null : ''), ...(calls.length ? { tool_calls: calls } : {}) };
}
function openAIToolsToAnthropic(request: Record<string, unknown>): Record<string, unknown> {
  if (request.functions !== undefined || request.function_call !== undefined) unsupportedTool();
  const output: Record<string, unknown> = {};
  const names = new Set<string>();
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > MAX_TOOLS) invalidTool();
    output.tools = request.tools.map(tool => {
      if (!record(tool) || tool.type !== 'function' || !record(tool.function)) unsupportedTool();
      const fn = tool.function;
      if (!validName(fn.name) || names.has(fn.name) || fn.description !== undefined && typeof fn.description !== 'string') invalidTool();
      names.add(fn.name);
      if (fn.strict !== undefined && typeof fn.strict !== 'boolean') invalidTool();
      return { name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), input_schema: fn.parameters === undefined ? { type: 'object', properties: {} } : toolInput(fn.parameters), ...(fn.strict !== undefined ? { strict: fn.strict } : {}) };
    });
  }
  if (request.parallel_tool_calls !== undefined && typeof request.parallel_tool_calls !== 'boolean') invalidTool();
  const choice = request.tool_choice;
  let mapped: Record<string, unknown> | undefined;
  if (choice === 'auto' || choice === 'none' || choice === 'required') mapped = { type: choice === 'required' ? 'any' : choice };
  else if (choice !== undefined) {
    if (!record(choice) || choice.type !== 'function' || !record(choice.function) || !validName(choice.function.name) || !names.has(choice.function.name)) invalidTool();
    mapped = { type: 'tool', name: choice.function.name };
  }
  if (request.parallel_tool_calls !== undefined && mapped?.type !== 'none') mapped = { ...(mapped ?? { type: 'auto' }), disable_parallel_tool_use: !request.parallel_tool_calls };
  if (mapped) output.tool_choice = mapped;
  return output;
}
function anthropicToolsToOpenAI(request: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  const names = new Set<string>();
  if (request.tools !== undefined) {
    if (!Array.isArray(request.tools) || request.tools.length > MAX_TOOLS) invalidTool();
    output.tools = request.tools.map(tool => {
      if (!record(tool) || tool.type !== undefined && tool.type !== null && tool.type !== 'custom') unsupportedTool();
      if (!validName(tool.name) || names.has(tool.name) || tool.description !== undefined && typeof tool.description !== 'string') invalidTool();
      if (tool.cache_control !== undefined || tool.defer_loading !== undefined || tool.allowed_callers !== undefined || tool.input_examples !== undefined) unsupportedTool();
      if (tool.strict !== undefined && typeof tool.strict !== 'boolean') invalidTool();
      names.add(tool.name);
      return { type: 'function', function: { name: tool.name, ...(tool.description !== undefined ? { description: tool.description } : {}), parameters: toolInput(tool.input_schema), ...(tool.strict !== undefined ? { strict: tool.strict } : {}) } };
    });
  }
  if (request.tool_choice !== undefined) {
    const choice = request.tool_choice;
    if (!record(choice) || !['auto', 'any', 'tool', 'none'].includes(String(choice.type))) invalidTool();
    if (choice.type === 'tool') {
      if (!validName(choice.name) || !names.has(choice.name)) invalidTool();
      output.tool_choice = { type: 'function', function: { name: choice.name } };
    } else output.tool_choice = choice.type === 'any' ? 'required' : choice.type;
    if (choice.disable_parallel_tool_use !== undefined) {
      if (typeof choice.disable_parallel_tool_use !== 'boolean' || choice.type === 'none') invalidTool();
      output.parallel_tool_calls = !choice.disable_parallel_tool_use;
    }
  }
  return output;
}
function openAIUsageToAnthropic(usage: Record<string, unknown> | undefined, prompt: number, completion: number): Record<string, unknown> {
  const details = record(usage?.prompt_tokens_details) ? usage.prompt_tokens_details : undefined;
  const cached = reportedCacheCount(details?.cached_tokens), written = reportedCacheCount(usage?.cache_creation_input_tokens);
  return { input_tokens: Math.max(0, prompt - (cached ?? 0) - (written ?? 0)), output_tokens: completion,
    ...(cached !== null ? { cache_read_input_tokens: cached } : {}), ...(written !== null ? { cache_creation_input_tokens: written } : {}) };
}

function anthropicSystemToString(system: unknown): string | undefined {
  if (system === undefined || system === null) return undefined;
  if (typeof system === "string") return system;
  if (!Array.isArray(system)) invalidTool();
  const parts: string[] = [];
  for (const block of system) {
    if (typeof block === "string") { parts.push(block); continue; }
    // Non-text blocks and prompt-caching hints are not represented in this conversion;
    // refuse them rather than silently dropping model context.
    if (!record(block) || block.type !== "text" || typeof block.text !== "string") invalidTool();
    if (block.cache_control !== undefined || block.citations !== undefined) unsupportedTool();
    parts.push(block.text);
  }
  return parts.length > 0 ? parts.join("\n\n") : undefined;
}

function openAIFinishToAnthropic(finish: string): string {
  if (finish === "length") return "max_tokens";
  if (finish === "tool_calls" || finish === "function_call") return "tool_use";
  if (finish === "content_filter") return "refusal";
  return "end_turn";
}

function anthropicStopToOpenAI(stop: string): string {
  if (stop === "max_tokens") return "length";
  if (stop === "tool_use") return "tool_calls";
  if (stop === "refusal") return "content_filter";
  return "stop";
}

function reportedCacheCount(value:unknown):number|null{return typeof value==='number'&&Number.isSafeInteger(value)&&value>=0?value:null;}
