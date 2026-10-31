import {parseHostedProviderReplay} from './hosted-provider-replay.js';
function record(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function integer(value, max) {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value > 0 &&
    value <= max
  );
}
const TOOL_NAME = /^[A-Za-z_][A-Za-z0-9_-]{0,63}$/;
const CALL_ID = /^[A-Za-z0-9_.:-]{1,200}$/;
const invalid = () => { throw new Error("hosted_request_invalid"); };

/** Function tools declared by the client. Execution never happens in the hosted service. */
function parseTools(value) {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length < 1 || value.length > 128) invalid();
  const names = new Set();
  const tools = value.map((tool) => {
    if (!record(tool) || Object.keys(tool).some((key) => !["type", "function"].includes(key)) || tool.type !== "function" || !record(tool.function)) invalid();
    const fn = tool.function;
    if (Object.keys(fn).some((key) => !["name", "description", "parameters"].includes(key)) || typeof fn.name !== "string" || !TOOL_NAME.test(fn.name) || names.has(fn.name) ||
      (fn.description !== undefined && (typeof fn.description !== "string" || fn.description.length > 2048)) || !record(fn.parameters)) invalid();
    names.add(fn.name);
    let parameters;
    try { parameters = JSON.parse(JSON.stringify(fn.parameters)); } catch { invalid(); }
    if (!record(parameters)) invalid();
    return Object.freeze({ type: "function", function: Object.freeze({ name: fn.name, ...(fn.description !== undefined ? { description: fn.description } : {}), parameters }) });
  });
  if (new TextEncoder().encode(JSON.stringify(tools)).byteLength > 64_000) throw new Error("hosted_request_too_large");
  return Object.freeze(tools);
}

export function parseHostedRequest(value) {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        ![
          "requestId",
          "model",
          "messages",
          "maxOutputTokens",
          "expectedPriceVersion",
          "tools",
        ].includes(key),
    ) ||
    (value.expectedPriceVersion !== undefined &&
      (typeof value.expectedPriceVersion !== "string" ||
        !/^[A-Za-z0-9._-]{1,80}$/.test(value.expectedPriceVersion))) ||
    typeof value.requestId !== "string" ||
    !/^[A-Za-z0-9:_-]{1,160}$/.test(value.requestId) ||
    typeof value.model !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:/-]{0,199}$/.test(value.model) ||
    !Array.isArray(value.messages) ||
    value.messages.length < 1 ||
    value.messages.length > 100 ||
    (value.maxOutputTokens !== undefined &&
      !integer(value.maxOutputTokens, 1_000_000))
  )
    throw new Error("hosted_request_invalid");
  const tools = parseTools(value.tools);
  let bytes = 0;
  const count = (text) => {
    bytes += new TextEncoder().encode(text).byteLength;
    if (bytes > 256_000) throw new Error("hosted_request_too_large");
  };
  const messages = value.messages.map((message) => {
    const allowed = message?.role === "assistant" ? ["role", "content", "tool_calls", "providerReplay"] : message?.role === "tool" ? ["role", "content", "tool_call_id"] : ["role", "content"];
    if (
      !record(message) ||
      Object.keys(message).some((key) => !allowed.includes(key)) ||
      !["system", "user", "assistant", "tool"].includes(String(message.role)) ||
      typeof message.content !== "string" ||
      message.content.length > 128_000
    )
      throw new Error("hosted_request_invalid");
    count(message.content);
    // Tool exchanges exist only in a request that declares tools.
    if (message.role === "tool") {
      if (!tools || typeof message.tool_call_id !== "string" || !CALL_ID.test(message.tool_call_id)) invalid();
      return Object.freeze({ role: "tool", content: message.content, tool_call_id: message.tool_call_id });
    }
    if (message.role === "assistant" && message.tool_calls !== undefined) {
      if (!tools || !Array.isArray(message.tool_calls) || message.tool_calls.length < 1 || message.tool_calls.length > 8) invalid();
      const calls = message.tool_calls.map((call) => {
        if (!record(call) || Object.keys(call).some((key) => !["id", "type", "function"].includes(key)) || call.type !== "function" ||
          typeof call.id !== "string" || !CALL_ID.test(call.id) || !record(call.function) ||
          Object.keys(call.function).some((key) => !["name", "arguments"].includes(key)) ||
          typeof call.function.name !== "string" || !TOOL_NAME.test(call.function.name) ||
          typeof call.function.arguments !== "string" || call.function.arguments.length > 65_536) invalid();
        count(call.function.arguments);
        return Object.freeze({ id: call.id, type: "function", function: Object.freeze({ name: call.function.name, arguments: call.function.arguments }) });
      });
      const replay=parseHostedProviderReplay(message.providerReplay,message.content,calls.map(c=>({id:c.id,name:c.function.name,arguments:c.function.arguments})),true);
      if(replay===null)invalid();if(replay)count(JSON.stringify(replay));
      return Object.freeze({ role: "assistant", content: message.content, tool_calls: Object.freeze(calls),...(replay?{providerReplay:replay}:{}) });
    }
    if(message.role==='assistant'&&message.providerReplay!==undefined){const replay=parseHostedProviderReplay(message.providerReplay,message.content,undefined,true);if(!replay)invalid();count(JSON.stringify(replay));return Object.freeze({role:'assistant',content:message.content,providerReplay:replay});}
    return Object.freeze({ role: message.role, content: message.content });
  });
  if (
    !messages.some(
      (message) => message.role === "user" && message.content.trim(),
    )
  )
    throw new Error("hosted_request_invalid");
  return {
    requestId: value.requestId,
    model: value.model,
    messages: Object.freeze(messages),
    ...(value.expectedPriceVersion !== undefined
      ? { expectedPriceVersion: value.expectedPriceVersion }
      : {}),
    ...(value.maxOutputTokens !== undefined
      ? { maxOutputTokens: value.maxOutputTokens }
      : {}),
    ...(tools ? { tools } : {}),
  };
}
