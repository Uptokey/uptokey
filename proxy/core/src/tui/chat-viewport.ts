/**
 * Uptokey TUI — Chat viewport window (pure logic, U1).
 *
 * The transcript is a virtualized window over the message list. The user
 * position is expressed as `scrollFromEnd` (0 = showing the latest messages)
 * so appending new messages never shifts the window while reading, and the
 * view follows the tail only while `followTail` is true.
 */

export interface ChatWindow {
  /** Index of the first visible message (inclusive). */
  start: number;
  /** Index one past the last visible message (exclusive). */
  end: number;
  followTail: boolean;
}

export interface ChatWindowInput {
  total: number;
  /** How many messages back from the end the window starts at. */
  scrollFromEnd: number;
  /** Approximate viewport size in messages. */
  rows: number;
  /** Whether the view is currently following the tail. */
  followTail: boolean;
}

export const MIN_CHAT_WINDOW = 10;

export function computeChatWindow(input: ChatWindowInput): ChatWindow {
  const { total, rows, followTail } = input;
  const visible = Math.max(Math.min(Math.max(rows, MIN_CHAT_WINDOW), Math.max(total, 1)), 1);

  if (followTail || total <= visible) {
    return { start: Math.max(0, total - visible), end: total, followTail: true };
  }

  const end = Math.max(Math.min(total - Math.max(0, input.scrollFromEnd), total), visible);
  const start = end - visible;
  return { start, end, followTail: false };
}

/** New scrollFromEnd after a PageUp (scroll further back). */
export function scrollUp(scrollFromEnd: number, total: number, rows: number): { scrollFromEnd: number; followTail: boolean } {
  const visible = Math.max(Math.min(Math.max(rows, MIN_CHAT_WINDOW), Math.max(total, 1)), 1);
  const next = Math.min(scrollFromEnd + visible, Math.max(0, total - visible));
  return { scrollFromEnd: next, followTail: next === 0 };
}

/** New scrollFromEnd after a PageDown (scroll towards the tail). */
export function scrollDown(scrollFromEnd: number, rows: number): { scrollFromEnd: number; followTail: boolean } {
  const next = Math.max(0, scrollFromEnd - Math.max(rows, MIN_CHAT_WINDOW));
  return { scrollFromEnd: next, followTail: next === 0 };
}
