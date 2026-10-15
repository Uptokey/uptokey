/**
 * Batches consecutive text deltas within a configurable window to reduce
 * render work while preserving event order. The default window is 60 ms.
 */

/** Default batching window for subsequent streaming text. */
export const STREAM_COALESCE_MS = 60;

export interface CoalescedTextEvent {
  type: "text";
  data: string;
}

export interface CoalescedDoneEvent {
  type: "done";
}

export interface CoalescedErrorEvent {
  type: "error";
  data: string;
}

export type CoalescedStreamEvent =
  | CoalescedTextEvent
  | CoalescedDoneEvent
  | CoalescedErrorEvent;

export interface StreamCoalescerOptions {
  /** Coalescing window in ms. Defaults to {@link STREAM_COALESCE_MS}. */
  windowMs?: number;
  /** Deliver the first nonempty text immediately, then batch subsequent text. Defaults to false. */
  leading?: boolean;
  /** Called when a coalesced batch is ready. */
  onFlush: (event: CoalescedStreamEvent) => void;
}

export interface StreamCoalescer {
  /** Feed a raw stream event into the coalescer. */
  push(event: CoalescedStreamEvent): void;
  /**
   * Flush any pending text immediately (call at turn boundaries:
   * done/error/cancel so no content is lost).
   */
  flushNow(): void;
  /** Drop pending text without flushing (used when aborting a turn). */
  discard(): void;
}

export function createStreamCoalescer(
  options: StreamCoalescerOptions,
): StreamCoalescer {
  const windowMs = options.windowMs ?? STREAM_COALESCE_MS;
  const { onFlush } = options;
  let firstText = true;

  let pendingText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;

  const cancelTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const flushText = (): void => {
    cancelTimer();
    if (pendingText.length > 0) {
      onFlush({ type: "text", data: pendingText });
      pendingText = "";
    }
  };

  return {
    push(event: CoalescedStreamEvent): void {
      if (event.type === "text") {
        if (!event.data) return;
        if (options.leading && firstText) {
          firstText = false;
          onFlush(event);
          return;
        }
        firstText = false;
        pendingText += event.data;
        if (timer === null) {
          timer = setTimeout(flushText, windowMs);
        }
        return;
      }
      // Non-text events (done/error) flush pending text first, then pass through.
      flushText();
      onFlush(event);
    },

    flushNow(): void {
      flushText();
    },

    discard(): void {
      cancelTimer();
      pendingText = "";
    },
  };
}
