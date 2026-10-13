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
  let bytes = 0;
  const messages = value.messages.map((message) => {
    if (
      !record(message) ||
      Object.keys(message).some((key) => !["role", "content"].includes(key)) ||
      !["system", "user", "assistant"].includes(String(message.role)) ||
      typeof message.content !== "string" ||
      message.content.length > 128_000
    )
      throw new Error("hosted_request_invalid");
    bytes += new TextEncoder().encode(message.content).byteLength;
    if (bytes > 256_000) throw new Error("hosted_request_too_large");
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
  };
}
