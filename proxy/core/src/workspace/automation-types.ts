/**
 * E2-13 — shared automation types (exclusive modules; W0 deltas remain coordinator-owned).
 * Path: config → prep → approval → execution → receipt → UI snapshot → reload.
 */

export type AutomationPhase =
  | "config"
  | "prep"
  | "approval"
  | "execution"
  | "receipt"
  | "ui"
  | "reload";

export type Clock = { now(): Date };

export class SystemClock implements Clock {
  now(): Date {
    return new Date();
  }
}

/** Deterministic clock for scheduler/idempotency tests. */
export class FakeClock implements Clock {
  private ms: number;
  constructor(isoOrMs: string | number = "2026-09-20T12:00:00.000-03:00") {
    this.ms = typeof isoOrMs === "number" ? isoOrMs : Date.parse(isoOrMs);
    if (!Number.isFinite(this.ms)) throw new Error("fake_clock_invalid");
  }
  now(): Date {
    return new Date(this.ms);
  }
  advance(ms: number): void {
    if (!Number.isFinite(ms) || ms < 0) throw new Error("fake_clock_advance_invalid");
    this.ms += ms;
  }
  set(iso: string): void {
    const next = Date.parse(iso);
    if (!Number.isFinite(next)) throw new Error("fake_clock_set_invalid");
    this.ms = next;
  }
}

export function isId(input: unknown): input is string {
  return typeof input === "string" && /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(input);
}

export class AutomationError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status = 400, message?: string) {
    super(message ?? code);
    this.name = "AutomationError";
    this.code = code;
    this.status = status;
  }
}
