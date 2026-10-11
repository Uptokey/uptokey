/**
 * E2-15 — console/stream observation with cursor + backpressure.
 * Reconnect does not generate inference or reopen a completed export.
 * Events sanitized at origin — no executable links/HTML from untrusted text.
 */

import type { UsageObservabilityStore } from "./usage-observability-store.ts";
import { scrubCanaries } from "./private-logging.ts";

export interface ConsoleEvent {
  readonly id: number;
  readonly at: string;
  readonly level: "info" | "warn" | "error";
  readonly message: string;
  readonly runId: string | null;
}

export class ObservabilityConsole {
  private events: ConsoleEvent[] = [];
  private nextId = 1;
  private readonly maxBuffer: number;

  constructor(maxBuffer = 256) {
    this.maxBuffer = maxBuffer;
  }

  append(input: {
    level: ConsoleEvent["level"];
    message: string;
    runId?: string | null;
    at?: string;
  }): ConsoleEvent {
    const scrubbed = scrubCanaries(input.message).text;
    // Strip HTML / javascript: / data: URLs from untrusted console text
    const safe = scrubbed
      .replace(/<\/?[a-z][^>]*>/gi, "")
      .replace(/(?:javascript|data|vbscript):/gi, "[blocked]:");
    const ev: ConsoleEvent = Object.freeze({
      id: this.nextId++,
      at: input.at ?? new Date().toISOString(),
      level: input.level,
      message: safe.slice(0, 2048),
      runId: input.runId ?? null,
    });
    this.events.push(ev);
    if (this.events.length > this.maxBuffer) {
      this.events = this.events.slice(-this.maxBuffer);
    }
    return ev;
  }

  /**
   * Read page after cursor with backpressure (max page size).
   * Does not touch store inference / outbox / export.
   */
  readAfter(
    store: UsageObservabilityStore,
    after: number,
    limit = 32,
  ): { events: ConsoleEvent[]; nextCursor: number; done: boolean } {
    void store; // observation only — store presence documents no side-effect coupling
    const page = this.events.filter((e) => e.id > after).slice(0, Math.min(limit, 64));
    const nextCursor = page.length ? page.at(-1)!.id : after;
    return {
      events: page,
      nextCursor,
      done: page.length === 0 || page.length < limit,
    };
  }

  /** Simulate SSE reconnect: same cursor, zero inference. */
  reconnect(
    store: UsageObservabilityStore,
    cursor: number,
  ): { page: ReturnType<ObservabilityConsole["readAfter"]>; inferenceDispatches: number } {
    const before = store.getInferenceDispatchCount();
    const page = this.readAfter(store, cursor);
    const after = store.getInferenceDispatchCount();
    if (after !== before) throw new Error("console_reconnect_dispatched_inference");
    return { page, inferenceDispatches: after };
  }
}
