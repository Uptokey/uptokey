import { t } from "./i18n.ts";
﻿/**
 * Uptokey TUI — Accessibility support.
 * Screen reader announcements, focus management, and high contrast mode.
 */

export interface AccessibilityOptions {
  screenReader: boolean;
  highContrast: boolean;
  reducedMotion: boolean;
  announceDelay: number;
}

const DEFAULT_OPTIONS: AccessibilityOptions = {
  screenReader: false,
  highContrast: false,
  reducedMotion: false,
  announceDelay: 100,
};

/** Queue of pending announcements for screen readers. */
const announcementQueue: string[] = [];
let announceTimer: ReturnType<typeof setTimeout> | null = null;

/**
 * Announce a message to screen readers.
 * Uses terminal bell and text output for screen reader compatibility.
 */
export function announce(message: string, options: Partial<AccessibilityOptions> = {}): void {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  if (!opts.screenReader) return;

  announcementQueue.push(message);

  if (announceTimer) return;
  announceTimer = setTimeout(() => {
    const pending = announcementQueue.splice(0);
    if (pending.length > 0) {
      // Use OSC 52 for clipboard (some terminals support this for screen readers)
      // Fall back to stderr for screen reader tools
      process.stderr.write(`\x1b]0;${pending.join(". ")}\x07`);
    }
    announceTimer = null;
  }, opts.announceDelay);
}

/**
 * Generate ARIA-like role descriptions for TUI elements.
 */
export function roleDescription(role: string, label: string, state?: Record<string, string | number | boolean>): string {
  const parts = [`${role}: ${label}`];
  if (state) {
    for (const [key, value] of Object.entries(state)) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(", ");
}

/**
 * Format a keyboard shortcut for screen reader announcement.
 */
export function describeShortcut(keys: string[], action: string): string {
  return `${keys.join("+")} — ${action}`;
}

/**
 * Generate focus navigation landmarks for the TUI.
 */
export function landmarks(): Array<{ id: string; label: string; shortcut: string }> {
  return [
    { id: "status", label: t('focus_status'), shortcut: "F1" },
    { id: "chat", label: t('focus_chat'), shortcut: "F2" },
    { id: "composer", label: t('focus_composer'), shortcut: "F3" },
    { id: "sidebar", label: t('focus_sidebar'), shortcut: "F4" },
  ];
}

/**
 * Create high-contrast color mappings.
 */
export function highContrastColors(): Record<string, string> {
  return {
    primary: "white",
    secondary: "yellow",
    success: "green",
    error: "red",
    warning: "yellow",
    info: "cyan",
    muted: "white",
    background: "black",
    border: "white",
    cursor: "white",
    selection: "yellow",
  };
}
