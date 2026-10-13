/** Bounded JSON for hosted messages; the caller supplies the total request deadline. */
export async function readHostedJson(body, maximum, signal) {
  if (
    !body ||
    !Number.isSafeInteger(maximum) ||
    maximum < 1 ||
    maximum > 24_100_000 ||
    !signal
  )
    throw new Error("hosted_request_invalid");
  const reader = body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => {
    void reader.cancel().catch(() => {});
  };
  signal.addEventListener("abort", cancel, { once: true });
  let size = 0,
    text = "";
  try {
    signal.throwIfAborted();
    for (;;) {
      const part = await reader.read();
      signal.throwIfAborted();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maximum) throw new Error("hosted_request_too_large");
      text += decoder.decode(part.value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    signal.removeEventListener("abort", cancel);
    cancel();
    reader.releaseLock();
  }
}
