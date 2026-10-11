/**
 * Queues follow-up instructions for insertion at a later tool boundary
 * without changing the current in-flight request.
 */

export interface SteerMessage {
  id: string;
  text: string;
  timestamp: number;
  injected: boolean;
}

export interface SteerQueue {
  /** Queue a steer message. */
  enqueue(text: string): void;
  /** Get the next pending steer, marking it as injected. */
  dequeue(): SteerMessage | null;
  /** Peek at pending steers without consuming. */
  peek(): readonly SteerMessage[];
  /** Clear all pending steers. */
  clear(): void;
  /** Number of pending steers. */
  readonly pending: number;
}

export function createSteerQueue(): SteerQueue {
  const queue: SteerMessage[] = [];
  let counter = 0;

  return {
    enqueue(text: string): void {
      if (!text.trim()) return;
      queue.push({
        id: `steer-${++counter}`,
        text: text.trim(),
        timestamp: Date.now(),
        injected: false,
      });
    },

    dequeue(): SteerMessage | null {
      const next = queue.find((m) => !m.injected);
      if (next) next.injected = true;
      return next ?? null;
    },

    peek(): readonly SteerMessage[] {
      return queue.filter((m) => !m.injected);
    },

    clear(): void {
      queue.length = 0;
    },

    get pending(): number {
      return queue.filter((m) => !m.injected).length;
    },
  };
}

/**
 * Determine the best injection point for a steer message.
 * Returns true if now is a good time to inject (tool boundary, long pause).
 */
export function shouldInjectSteer(
  lastEventTimestamp: number,
  isToolCallBoundary: boolean,
  pauseThresholdMs: number = 2000,
): boolean {
  // Always inject at tool call boundaries (between tool calls)
  if (isToolCallBoundary) return true;

  // Inject if the model has been silent for a while (thinking)
  if (Date.now() - lastEventTimestamp > pauseThresholdMs) return true;

  return false;
}
