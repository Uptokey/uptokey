import { cancelStreamWithin } from "./stream-lifecycle.ts";

export const DEFAULT_MAX_CONCURRENT_INFERENCE = 16;

export class RequestAdmission {
  private active = 0;
  readonly maximum: number;
  constructor(maximum = DEFAULT_MAX_CONCURRENT_INFERENCE) {
    if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 256) throw new Error("invalid_concurrency_limit");
    this.maximum = maximum;
  }

  tryAcquire(): (() => void) | undefined {
    if (this.active >= this.maximum) return undefined;
    this.active += 1;
    let held = true;
    return () => {
      if (!held) return;
      held = false;
      this.active -= 1;
    };
  }

  status(): { active: number; maximum: number } { return { active: this.active, maximum: this.maximum }; }
}

export function releaseWithResponse(response: Response, release: () => void, signal?: AbortSignal): Response {
  if (!response.body) { release(); return responseWithoutStatusText(response); }
  const reader = response.body.getReader();
  let settled = false;
  const abort = () => { void cancelStreamWithin(reader, 250, signal?.reason).finally(settle); };
  const settle = () => {
    if (settled) return;
    settled = true;
    signal?.removeEventListener("abort", abort);
    release();
  };
  if (signal?.aborted) {
    abort();
    return responseWithoutStatusText(response, null);
  }
  signal?.addEventListener("abort", abort, { once: true });
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const chunk = await reader.read();
        if (chunk.done) { settle(); controller.close(); return; }
        controller.enqueue(chunk.value);
      } catch (error) { settle(); controller.error(error); }
    },
    async cancel(reason) { try { await cancelStreamWithin(reader, 250, reason); } finally { settle(); } }
  });
  return responseWithoutStatusText(response, body);
}

function responseWithoutStatusText(response: Response, body: BodyInit | null = null): Response {
  return new Response(body, { status: response.status, headers: response.headers });
}
