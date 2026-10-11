/** Source-anchored selection. Ctrl+C/Escape priority follows OpenCode's MIT
 * util/selection.ts (reference b471c2b4); layout remains Uptokey's Ink renderer. */
import type { Line, Span, TranscriptItem } from "./transcript.ts";
import { graphemes, graphemeWidth } from "./unicode.ts";
import { sanitizeForDisplay } from "./sanitize.ts";

export interface SelectionAnchor { itemId: string; offset: number }
export interface SelectionState {
  anchor: SelectionAnchor;
  focus: SelectionAnchor;
  /** Prefixes detect replacement; append-only streaming keeps the selection. */
  sources: Record<string, string>;
  keyboard: boolean;
  dragging: boolean;
}
export interface SourceCell { from: number; to: number; column: number; width: number }
export function selectionSource(item: TranscriptItem): string | null {
  return item.kind === "assistant" || item.kind === "user" ? sanitizeForDisplay(item.text) : null;
}
export function sourceCells(line: Line): SourceCell[] {
  let column = 0;
  const cells: SourceCell[] = [];
  for (const span of line.spans) {
    if (span.sourceAtomic && span.sourceStart !== undefined && span.sourceEnd !== undefined) {
      const width = graphemes(span.text).reduce((sum, g) => sum + graphemeWidth(g), 0);
      cells.push({ from: span.sourceStart, to: span.sourceEnd, column, width }); column += width; continue;
    }
    let offset = span.sourceStart;
    for (const g of graphemes(span.text)) {
      const width = graphemeWidth(g);
      if (offset !== undefined) cells.push({ from: offset, to: offset + g.length, column, width });
      column += width;
      if (offset !== undefined) offset += g.length;
    }
  }
  return cells;
}
export function selectionHit(line: Line | undefined, column: number, end = false): SelectionAnchor | null {
  if (!line?.itemId) return null;
  const cells = sourceCells(line);
  if (!cells.length) return null;
  const cell = cells.find(c => column < c.column + Math.max(1, c.width)) ?? cells.at(-1)!;
  return { itemId: line.itemId, offset: end || column >= cell.column + cell.width ? cell.to : cell.from };
}
export function createSelection(items: readonly TranscriptItem[], anchor: SelectionAnchor, keyboard = false): SelectionState {
  return extendSelection({ anchor, focus: anchor, sources: {}, keyboard, dragging: !keyboard }, items, anchor);
}
export function extendSelection(selection: SelectionState, items: readonly TranscriptItem[], focus: SelectionAnchor): SelectionState {
  const next = { ...selection, focus, sources: { ...selection.sources } };
  const a = items.findIndex(item => item.id === next.anchor.itemId), b = items.findIndex(item => item.id === focus.itemId);
  if (a < 0 || b < 0) return selection;
  for (const item of items.slice(Math.min(a, b), Math.max(a, b) + 1)) {
    const text = selectionSource(item);
    if (text !== null && (next.sources[item.id] === undefined || text.startsWith(next.sources[item.id]!))) next.sources[item.id] = text;
  }
  return next;
}
export function selectionRanges(selection: SelectionState, items: readonly TranscriptItem[]): Map<string, { from: number; to: number }> | null {
  let a = items.findIndex(item => item.id === selection.anchor.itemId), b = items.findIndex(item => item.id === selection.focus.itemId);
  if (a < 0 || b < 0) return null;
  let start = selection.anchor, end = selection.focus;
  if (a > b || (a === b && start.offset > end.offset)) { [a, b] = [b, a]; [start, end] = [end, start]; }
  const ranges = new Map<string, { from: number; to: number }>();
  for (const item of items.slice(a, b + 1)) {
    const text = selectionSource(item), captured = selection.sources[item.id];
    if (text === null) continue;
    if (captured === undefined) return null;
    const from = item.id === start.itemId ? start.offset : 0, to = item.id === end.itemId ? end.offset : captured.length;
    if (from < 0 || to > captured.length || text.slice(0, to) !== captured.slice(0, to)) return null;
    ranges.set(item.id, { from, to });
  }
  return ranges;
}
/** Exact bounded source slice, independent of viewport and chrome. */
export function extractSelection(items: readonly TranscriptItem[], selection: SelectionState): string | null {
  const ranges = selectionRanges(selection, items);
  return ranges ? [...ranges].map(([id, range]) => selection.sources[id]!.slice(range.from, range.to)).join("\n\n") : null;
}
export function applySelectionToLines(lines: readonly Line[], selection: SelectionState | null, items: readonly TranscriptItem[], caretVisible = true): Line[] {
  if (!selection) return [...lines];
  const ranges = selectionRanges(selection, items);
  if (!ranges) return [...lines];
  const collapsed = selection.anchor.itemId === selection.focus.itemId && selection.anchor.offset === selection.focus.offset;
  const caret = collapsed ? locateSelection(lines, selection.focus) : null;
  return lines.map((line, row) => {
    const range = line.itemId ? ranges.get(line.itemId) : undefined;
    if (!range) return line;
    const spans: Span[] = [];
    for (const span of line.spans) {
      if (span.sourceAtomic && span.sourceStart !== undefined && span.sourceEnd !== undefined) {
        spans.push({ ...span, inverse: span.sourceStart < range.to && span.sourceEnd > range.from || collapsed && selection.keyboard && caretVisible && span.sourceStart === range.from }); continue;
      }
      let offset = span.sourceStart;
      for (const g of graphemes(span.text)) {
        const end = offset === undefined ? undefined : offset + g.length;
        const selected = offset !== undefined && end !== undefined && (offset < range.to && end > range.from || collapsed && selection.keyboard && caretVisible && offset === range.from);
        spans.push({ ...span, text: g, sourceStart: offset, sourceEnd: end, inverse: selected || span.inverse }); offset = end;
      }
    }
    if (collapsed && selection.keyboard && caretVisible && caret?.row === row && sourceCells(line).at(-1)?.to === range.from) spans.push({ text: " ", inverse: true });
    return { ...line, spans };
  });
}
export function locateSelection(lines: readonly Line[], point: SelectionAnchor): { row: number; column: number } | null {
  let fallback: { row: number; column: number } | null = null;
  for (let row = 0; row < lines.length; row++) {
    const line = lines[row]!;
    if (line.itemId !== point.itemId) continue;
    for (const cell of sourceCells(line)) {
      if (point.offset < cell.to || cell.from >= point.offset) return { row, column: cell.column };
      fallback = { row, column: cell.column + cell.width };
    }
  }
  return fallback;
}
export function moveSelection(selection: SelectionState, items: readonly TranscriptItem[], lines: readonly Line[], direction: string, extend: boolean, pageRows: number): SelectionState {
  const position = locateSelection(lines, selection.focus);
  if (!position) return selection;
  const rows = lines.map((line, row) => ({ line, row })).filter(({ line }) => sourceCells(line).length > 0);
  let target: SelectionAnchor | null = null;
  if (direction === "left" || direction === "right") {
    const item = items.find(item => item.id === selection.focus.itemId);
    const source = item ? selectionSource(item) : null;
    if (source !== null) {
      const bounds = [0]; for (const g of graphemes(source)) bounds.push(bounds.at(-1)! + g.length);
      const offset = direction === "left" ? [...bounds].reverse().find(n => n < selection.focus.offset) : bounds.find(n => n > selection.focus.offset);
      if (offset !== undefined) target = { itemId: selection.focus.itemId, offset };
    }
  } else if (direction === "start" || direction === "finish") {
    const row = direction === "start" ? rows[0] : rows.at(-1);
    target = selectionHit(row?.line, direction === "start" ? 0 : Number.MAX_SAFE_INTEGER);
  } else {
    const index = rows.findIndex(row => row.row === position.row);
    const delta = direction === "up" ? -1 : direction === "down" ? 1 : direction === "pageup" ? -pageRows : direction === "pagedown" ? pageRows : 0;
    const row = rows[Math.max(0, Math.min(rows.length - 1, index + delta))];
    target = selectionHit(row?.line, direction === "home" ? 0 : direction === "end" ? Number.MAX_SAFE_INTEGER : position.column);
  }
  if (!target) return selection;
  return extendSelection({ ...selection, anchor: extend ? selection.anchor : target, keyboard: true, dragging: false }, items, target);
}
