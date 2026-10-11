/** Bracketed paste parsing and chip thresholds, independent of a renderer. */
/** ESC sequences wrapping bracketed paste payloads. */
export const PASTE_START = "\x1b[200~";
export const PASTE_END = "\x1b[201~";

/** Minimum lines or chars that turns a paste into a "chip" (no auto-send). */
export const PASTE_CHIP_MIN_LINES = 2;
export const PASTE_CHIP_MIN_CHARS = 400;

/**
 * Detect whether a string looks like a large paste that should not be
 * auto-submitted (it could contain an embedded newline that would trigger
 * Enter, so we intercept before the composer's submit logic).
 */
export function isPasteChip(text: string): boolean {
  const lines = text.split("\n").length;
  return lines >= PASTE_CHIP_MIN_LINES || text.length >= PASTE_CHIP_MIN_CHARS;
}

/**
 * Extract the content of a bracketed paste sequence from raw terminal input.
 * Returns the paste content string, or null if the input does not contain a
 * complete bracketed paste.
 */
export function extractBracketedPaste(raw: string): string | null {
  const start = raw.indexOf(PASTE_START);
  const end = raw.indexOf(PASTE_END);
  if (start === -1 || end === -1 || end <= start) return null;
  return raw.slice(start + PASTE_START.length, end);
}
