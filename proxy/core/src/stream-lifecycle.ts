export function cancelStream(stream: { cancel(reason?: unknown): Promise<unknown> } | null | undefined, reason?: unknown): void {
  try { void Promise.resolve(stream?.cancel(reason)).catch(() => undefined); } catch { /* cancelamento best-effort */ }
}

export async function cancelStreamWithin(stream: { cancel(reason?: unknown): Promise<unknown> } | null | undefined, timeoutMs = 250, reason?: unknown): Promise<boolean> {
  if (!stream) return true;
  let cancellation: Promise<unknown>;
  try { cancellation = Promise.resolve(stream.cancel(reason)); } catch { return true; }
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      cancellation.then(() => true, () => true),
      new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); })
    ]);
  } finally { if (timer !== undefined) clearTimeout(timer); }
}
