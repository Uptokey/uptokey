/**
 * Derives layout breakpoints and display density from terminal width and
 * height, including compact, normal and wide presentations.
 */

export type LayoutBreakpoint = "compact" | "normal" | "wide";
export type HeightBreakpoint = "short" | "normal" | "tall";

export interface LayoutConfig {
  width: LayoutBreakpoint;
  height: HeightBreakpoint;
  cols: number;
  rows: number;
  /** Available height for main content (minus status + composer). */
  contentHeight: number;
  /** Whether sidebar should be visible. */
  showSidebar: boolean;
  /** Whether to show extended status info. */
  extendedStatus: boolean;
  /** Maximum width for message content. */
  messageMaxWidth: number;
  /** Whether to show line numbers in editor. */
  showLineNumbers: boolean;
  /** Number of context lines in diff view. */
  diffContext: number;
  /** Whether to use compact message format. */
  compactMessages: boolean;
}

export function computeLayout(cols: number, rows: number): LayoutConfig {
  const width: LayoutBreakpoint =
    cols < 60 ? "compact" : cols > 120 ? "wide" : "normal";
  const height: HeightBreakpoint =
    rows < 16 ? "short" : rows > 40 ? "tall" : "normal";

  // Status bar: 1 line compact, 2 lines normal, 2 lines wide
  const statusLines = width === "compact" ? 1 : 2;
  // Composer: 1 line compact, 3 lines normal
  const composerLines = width === "compact" ? 1 : 3;
  // Banner area: 0-1 line
  const bannerLines = height === "short" ? 0 : 1;

  const contentHeight = Math.max(3, rows - statusLines - composerLines - bannerLines);

  return {
    width,
    height,
    cols,
    rows,
    contentHeight,
    showSidebar: width === "wide" && height !== "short",
    extendedStatus: width !== "compact" && height !== "short",
    messageMaxWidth: width === "compact" ? cols - 2 : Math.min(cols - 4, 100),
    showLineNumbers: width !== "compact",
    diffContext: width === "compact" ? 1 : width === "normal" ? 3 : 5,
    compactMessages: width === "compact" || height === "short",
  };
}

/**
 * React hook-compatible layout change detection.
 * Returns a stable layout config that updates on terminal resize.
 */
export function createLayoutTracker(
  onChange: (layout: LayoutConfig) => void,
): { current: LayoutConfig; destroy: () => void } {
  let current = computeLayout(
    process.stdout.columns || 80,
    process.stdout.rows || 24,
  );

  const handler = (): void => {
    const next = computeLayout(
      process.stdout.columns || 80,
      process.stdout.rows || 24,
    );

    // Only notify if breakpoint changed (avoid noise)
    if (next.width !== current.width || next.height !== current.height || next.contentHeight !== current.contentHeight) {
      current = next;
      onChange(current);
    }
  };

  process.stdout.on("resize", handler);

  return {
    get current() { return current; },
    destroy() { process.stdout.off("resize", handler); },
  };
}

/**
 * Truncate text to fit width, with ellipsis.
 * Respects ANSI escape sequences (doesn't count them as width).
 */
export function fitWidth(text: string, maxWidth: number, ellipsis: string = "…"): string {
  // Strip ANSI for width measurement
  const stripped = text.replace(/\x1b\[[0-9;]*m/g, "");
  if (stripped.length <= maxWidth) return text;

  // Naive truncation (doesn't handle wide chars perfectly)
  const cutAt = maxWidth - ellipsis.length;
  if (cutAt <= 0) return ellipsis.slice(0, maxWidth);

  // Walk through original text, counting visible characters
  let visible = 0;
  let i = 0;
  while (i < text.length && visible < cutAt) {
    if (text[i] === "\x1b") {
      // Skip ANSI sequence
      const end = text.indexOf("m", i);
      if (end >= 0) { i = end + 1; continue; }
    }
    visible++;
    i++;
  }

  return text.slice(0, i) + "\x1b[0m" + ellipsis;
}
