/**
 * Uptokey TUI — grapheme and terminal-cell measurement.
 *
 * Editing, wrapping and cursor movement operate on extended grapheme clusters
 * (Intl.Segmenter) and terminal cell widths, never on UTF-16 `length`. A
 * composed emoji, a CJK ideograph or a letter with combining accents is one
 * cursor step; wide clusters occupy two cells.
 */

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const wordSegmenter = new Intl.Segmenter(undefined, { granularity: "word" });

export function graphemes(text: string): string[] {
  const out: string[] = [];
  for (const { segment } of segmenter.segment(text)) out.push(segment);
  return out;
}

/** East Asian Wide/Fullwidth ranges (Unicode 15) that render as two cells. */
const WIDE_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0x1100, 0x115f], [0x231a, 0x231b], [0x2329, 0x232a], [0x23e9, 0x23ec], [0x23f0, 0x23f0], [0x23f3, 0x23f3],
  [0x25fd, 0x25fe], [0x2614, 0x2615], [0x2648, 0x2653], [0x267f, 0x267f], [0x2693, 0x2693], [0x26a1, 0x26a1],
  [0x26aa, 0x26ab], [0x26bd, 0x26be], [0x26c4, 0x26c5], [0x26ce, 0x26ce], [0x26d4, 0x26d4], [0x26ea, 0x26ea],
  [0x26f2, 0x26f3], [0x26f5, 0x26f5], [0x26fa, 0x26fa], [0x26fd, 0x26fd], [0x2705, 0x2705], [0x270a, 0x270b],
  [0x2728, 0x2728], [0x274c, 0x274c], [0x274e, 0x274e], [0x2753, 0x2755], [0x2757, 0x2757], [0x2795, 0x2797],
  [0x27b0, 0x27b0], [0x27bf, 0x27bf], [0x2b1b, 0x2b1c], [0x2b50, 0x2b50], [0x2b55, 0x2b55], [0x2e80, 0x303e],
  [0x3041, 0x33ff], [0x3400, 0x4dbf], [0x4e00, 0x9fff], [0xa000, 0xa4cf], [0xa960, 0xa97f], [0xac00, 0xd7a3],
  [0xf900, 0xfaff], [0xfe10, 0xfe19], [0xfe30, 0xfe6f], [0xff00, 0xff60], [0xffe0, 0xffe6], [0x16fe0, 0x16fe4],
  [0x17000, 0x187f7], [0x18800, 0x18cd5], [0x1b000, 0x1b2fb], [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf],
  [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a], [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248],
  [0x1f250, 0x1f251], [0x1f260, 0x1f265], [0x1f300, 0x1f64f], [0x1f680, 0x1f6ff], [0x1f7e0, 0x1f7eb],
  [0x1f90c, 0x1f9ff], [0x1fa70, 0x1faff], [0x20000, 0x2fffd], [0x30000, 0x3fffd],
];

function isWideCodePoint(cp: number): boolean {
  let lo = 0, hi = WIDE_RANGES.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const [start, end] = WIDE_RANGES[mid]!;
    if (cp < start) hi = mid - 1;
    else if (cp > end) lo = mid + 1;
    else return true;
  }
  return false;
}

const EMOJI_PRESENTATION = /\p{Emoji_Presentation}/u;
const PICTOGRAPHIC = /\p{Extended_Pictographic}/u;
const ZERO_WIDTH_RANGES: ReadonlyArray<readonly [number, number]> = [[0x200b, 0x200f], [0x2028, 0x202e], [0x2060, 0x206f], [0xfe00, 0xfe0f]];
const COMBINING = /^[\p{Mn}\p{Me}\p{Cf}]$/u;
const VS16 = String.fromCodePoint(0xfe0f);
const ZWJ = String.fromCodePoint(0x200d);

function isZeroWidthCluster(cluster: string): boolean {
  for (const ch of cluster) {
    const cp = ch.codePointAt(0)!;
    if (COMBINING.test(ch)) continue;
    if (ZERO_WIDTH_RANGES.some(([a, b]) => cp >= a && cp <= b)) continue;
    return false;
  }
  return true;
}

/** Terminal cells for one grapheme cluster (0, 1 or 2). */
export function graphemeWidth(cluster: string): number {
  if (!cluster) return 0;
  if (cluster === "\t") return 4;
  const cp = cluster.codePointAt(0)!;
  if (cp < 0x20 || (cp >= 0x7f && cp < 0xa0)) return 0;
  if (isZeroWidthCluster(cluster)) return 0;
  // Emoji sequences (ZWJ, keycap, VS16, flags) render as a single wide cell pair.
  if (cluster.includes(VS16) || cluster.includes(ZWJ) || EMOJI_PRESENTATION.test(cluster)) return 2;
  if (/^[\u{1f1e6}-\u{1f1ff}]{2}$/u.test(cluster)) return 2;
  if (isWideCodePoint(cp)) return 2;
  if (PICTOGRAPHIC.test(cluster) && cp > 0x1f000) return 2;
  return 1;
}

export function stringWidth(text: string): number {
  let width = 0;
  for (const { segment } of segmenter.segment(text)) width += graphemeWidth(segment);
  return width;
}

/** Truncates to at most `max` cells, appending an ellipsis when cut. */
export function truncateCells(text: string, max: number, ellipsis = "…"): string {
  if (max <= 0) return "";
  if (stringWidth(text) <= max) return text;
  const room = Math.max(0, max - stringWidth(ellipsis));
  let used = 0;
  let out = "";
  for (const { segment } of segmenter.segment(text)) {
    const w = graphemeWidth(segment);
    if (used + w > room) break;
    out += segment;
    used += w;
  }
  return out + ellipsis;
}

export function padCells(text: string, width: number): string {
  const w = stringWidth(text);
  return w >= width ? text : text + " ".repeat(width - w);
}

/**
 * Wraps one logical line to `width` cells, preferring word boundaries and
 * breaking inside a word only when it alone exceeds the width. Tabs expand to
 * spaces so the measured width equals what the terminal shows.
 */
export function wrapLine(line: string, width: number): string[] {
  const safeWidth = Math.max(1, width);
  const expanded = line.includes("\t") ? line.replace(/\t/g, "    ") : line;
  if (stringWidth(expanded) <= safeWidth) return [expanded];
  const out: string[] = [];
  let current = "";
  let currentWidth = 0;
  const pushWord = (word: string) => {
    const w = stringWidth(word);
    if (currentWidth + w <= safeWidth) { current += word; currentWidth += w; return; }
    if (/^\s+$/.test(word)) { out.push(current); current = ""; currentWidth = 0; return; }
    if (current) { out.push(current.replace(/\s+$/, "")); current = ""; currentWidth = 0; }
    if (w <= safeWidth) { current = word; currentWidth = w; return; }
    for (const g of graphemes(word)) {
      const gw = graphemeWidth(g);
      if (currentWidth + gw > safeWidth) { out.push(current); current = ""; currentWidth = 0; }
      current += g; currentWidth += gw;
    }
  };
  for (const { segment } of wordSegmenter.segment(expanded)) pushWord(segment);
  if (current || out.length === 0) out.push(current);
  return out;
}

/** Word boundaries in grapheme indices, used for Ctrl/Alt word movement. */
export function wordStarts(text: string): number[] {
  const starts: number[] = [];
  let index = 0;
  for (const part of wordSegmenter.segment(text)) {
    if (part.isWordLike) starts.push(index);
    index += graphemes(part.segment).length;
  }
  return starts;
}
