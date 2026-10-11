/**
 * Adapts the text coalescing window to measured render time within configured
 * bounds, and reports frame-rate diagnostics.
 */

export interface AdaptiveStreamOptions {
  onFlush: (text: string) => void;
  /** Minimum window in ms. Default: 16 (60fps). */
  minWindowMs?: number;
  /** Maximum window in ms. Default: 200. */
  maxWindowMs?: number;
  /** Smoothing factor for EWMA. Default: 0.3. */
  alpha?: number;
}

export interface AdaptiveStream {
  push(text: string): void;
  flushNow(): void;
  discard(): void;
  /** Report how long the last render took (call from React effect). */
  reportRenderTime(ms: number): void;
  /** Current adaptive window in ms. */
  readonly windowMs: number;
  /** Exponentially weighted average render time. */
  readonly avgRenderMs: number;
  /** Frames flushed in the last second. */
  readonly fps: number;
}

export function createAdaptiveStream(options: AdaptiveStreamOptions): AdaptiveStream {
  const minWindow = options.minWindowMs ?? 16;
  const maxWindow = options.maxWindowMs ?? 200;
  const alpha = options.alpha ?? 0.3;
  const { onFlush } = options;

  let currentWindow = minWindow;
  let ewmaRender = 8; // optimistic start
  let pending = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let flushCount = 0;
  let fpsWindow = 0;
  let fpsTimer: ReturnType<typeof setInterval> | null = null;

  // FPS counter: reset every second
  fpsTimer = setInterval(() => {
    fpsWindow = flushCount;
    flushCount = 0;
  }, 1000);

  // Prevent timer from keeping process alive
  if (fpsTimer && typeof fpsTimer === "object" && "unref" in fpsTimer) {
    (fpsTimer as NodeJS.Timeout).unref();
  }

  const cancelTimer = (): void => {
    if (timer !== null) { clearTimeout(timer); timer = null; }
  };

  const flush = (): void => {
    cancelTimer();
    if (pending.length > 0) {
      onFlush(pending);
      pending = "";
      flushCount++;
    }
  };

  return {
    push(text: string): void {
      pending += text;
      if (timer === null) {
        timer = setTimeout(flush, currentWindow);
      }
    },

    flushNow(): void { flush(); },

    discard(): void {
      cancelTimer();
      pending = "";
    },

    reportRenderTime(ms: number): void {
      ewmaRender = alpha * ms + (1 - alpha) * ewmaRender;
      // Target: window >= render time so we don't queue faster than render
      const target = Math.max(minWindow, Math.min(maxWindow, Math.ceil(ewmaRender * 1.2)));
      // Smooth transition
      currentWindow = Math.round(currentWindow * 0.7 + target * 0.3);
    },

    get windowMs() { return currentWindow; },
    get avgRenderMs() { return Math.round(ewmaRender * 100) / 100; },
    get fps() { return fpsWindow; },
  };
}
