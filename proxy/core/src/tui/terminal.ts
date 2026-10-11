/**
 * Uptokey TUI — Terminal utilities.
 * Handles resize events, scrollback, alternate screen, mouse support,
 * and graceful cleanup including ephemeral session teardown.
 */

export interface TerminalSize {
  rows: number;
  cols: number;
}

/**
 * Get current terminal size.
 */
export function getTerminalSize(): TerminalSize {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Listen for terminal resize events.
 */
export function onResize(callback: (size: TerminalSize) => void): () => void {
  const handler = (): void => {
    callback(getTerminalSize());
  };
  process.stdout.on("resize", handler);
  return () => {
    process.stdout.off("resize", handler);
  };
}

/**
 * Enter alternate screen buffer (preserves main terminal content).
 */
export function enterAlternateScreen(): void {
  process.stdout.write("\x1b[?1049h");
}

/**
 * Leave alternate screen buffer.
 */
export function leaveAlternateScreen(): void {
  process.stdout.write("\x1b[?1049l");
}

type TerminalOutput = { isTTY?: boolean; write: (data: string) => unknown };

/** Paste markers let the input parser distinguish paste from coalesced keys. */
export function enableBracketedPaste(output: TerminalOutput = process.stdout): boolean {
  if (!output.isTTY) return false;
  output.write("\x1b[?2004h");
  return true;
}

/** Restore ordinary input before leaving the TUI or handing control to an editor. */
export function disableBracketedPaste(output: TerminalOutput = process.stdout): void {
  if (output.isTTY) output.write("\x1b[?2004l");
}

/**
 * Enable mouse tracking.
 */
export function enableMouse(output: TerminalOutput = process.stdout): boolean {
  if (!output.isTTY) return false;
  // Button-event mouse reporting (motion while held) + SGR coordinates.
  output.write("\x1b[?1002h\x1b[?1006h");
  return true;
}

/**
 * Disable mouse tracking.
 */
export function disableMouse(output: TerminalOutput = process.stdout): void {
  if (output.isTTY) output.write("\x1b[?1006l\x1b[?1015l\x1b[?1002l\x1b[?1000l");
}

/**
 * Set terminal title.
 */
export function setTitle(title: string): void {
  process.stdout.write(`\x1b]0;${title}\x07`);
}

/**
 * Clear screen.
 */
export function clearScreen(): void {
  process.stdout.write("\x1b[2J\x1b[H");
}

/**
 * Hide cursor.
 */
export function hideCursor(): void {
  process.stdout.write("\x1b[?25l");
}

/**
 * Show cursor.
 */
export function showCursor(): void {
  process.stdout.write("\x1b[?25h");
}

/**
 * Cleanup callback type: runs during graceful shutdown.
 */
export type CleanupFn = () => void | Promise<void>;

export interface CleanupRuntime {
  events: { on(event: string, handler: (...args: any[]) => void): unknown; removeListener(event: string, handler: (...args: any[]) => void): unknown };
  restore: (mouse: boolean) => void;
  exit: (code: number) => void;
  report: (message: string) => void;
}

/**
 * Graceful cleanup on exit. Handles SIGPIPE for pipe mode,
 * ephemeral session teardown, and terminal state restoration.
 */
export function setupCleanup(options: {
  mouse?: boolean;
  ephemeral?: boolean | (() => boolean);
  /** Only resources owned by this live session. Never pass legacy disk-cache removal. */
  cacheCleanup?: CleanupFn;
  onCleanup?: CleanupFn;
} = {}, runtime: CleanupRuntime = {
  events: process,
  restore: mouse => { if (process.stdout.isTTY) { disableBracketedPaste(); if (mouse) disableMouse(); showCursor(); leaveAlternateScreen(); } },
  exit: code => { process.exit(code); },
  report: message => { process.stderr.write(`${message}\n`); },
}): { cleanup: () => Promise<void>; dispose: () => void } {
  let pending: Promise<void> | undefined;
  let stopping = false;
  const cleanup = (): Promise<void> => {
    if (pending) return pending;
    const work: Promise<unknown>[] = [];
    // Invoke callbacks synchronously as well: process 'exit' cannot await, while
    // graceful signals and unmount can await/reuse the same teardown promise.
    const invoke = (callback: CleanupFn | undefined) => {
      try { work.push(Promise.resolve(callback?.())); } catch (error) { work.push(Promise.reject(error)); }
    };
    runtime.restore(!!options.mouse);
    invoke(options.onCleanup);
    if (typeof options.ephemeral === "function" ? options.ephemeral() : options.ephemeral) invoke(options.cacheCleanup);
    pending = Promise.allSettled(work).then(results => {
      if (results.some(result => result.status === "rejected")) runtime.report("Não foi possível concluir a limpeza dos recursos temporários desta sessão.");
    });
    return pending;
  };
  const stop = (code: number) => {
    if (stopping) return;
    stopping = true;
    void cleanup().finally(() => runtime.exit(code));
  };
  const handlers: Record<string, (...args: any[]) => void> = {
    exit: () => { void cleanup(); },
    SIGPIPE: () => stop(141),
    SIGINT: () => stop(130),
    SIGTERM: () => stop(0),
    uncaughtException: () => { runtime.report("Erro fatal na TUI."); stop(1); },
  };
  for (const [event, handler] of Object.entries(handlers)) runtime.events.on(event, handler);
  return { cleanup, dispose: () => { for (const [event, handler] of Object.entries(handlers)) runtime.events.removeListener(event, handler); } };
}
