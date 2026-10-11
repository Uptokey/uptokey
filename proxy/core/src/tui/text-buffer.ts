/**
 * Models multiline composer text by grapheme index with transactional undo,
 * Unicode word movement and bounded paste chips. Expanding a paste chip
 * restores its exact source content for submission.
 */
import { graphemes, graphemeWidth, stringWidth, wordStarts } from "./unicode.ts";

export const PASTE_CHIP_MIN_CHARS = 400;
export const PASTE_CHIP_MIN_LINES = 3;
const UNDO_LIMIT = 200;
const COALESCE_MS = 800;

interface Snapshot { text: string; cursor: number }

export interface BufferView {
  /** Visual rows after wrapping at the given width. */
  rows: string[];
  cursorRow: number;
  /** Cursor column in terminal cells within `cursorRow`. */
  cursorCol: number;
}

export class TextBuffer {
  private g: string[] = [];
  private cursorIndex = 0;
  private preferredCol: number | null = null;
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];
  private lastTypingAt = 0;
  private typingOpen = false;
  private pastes = new Map<string, string>();
  private pasteCounter = 0;

  private readonly now: () => number;

  constructor(initial = "", now: () => number = Date.now) {
    this.now = now;
    this.g = graphemes(initial);
    this.cursorIndex = this.g.length;
  }

  get text(): string { return this.g.join(""); }
  get cursor(): number { return this.cursorIndex; }
  get isEmpty(): boolean { return this.g.length === 0 && this.pastes.size === 0; }
  get lineCount(): number { return this.text.split("\n").length; }

  /** Text with paste placeholders replaced by the exact pasted content. */
  expanded(): string {
    let out = this.text;
    for (const [token, content] of this.pastes) out = out.split(token).join(content);
    return out;
  }

  /** Placeholders still present in the text (removed chips are forgotten). */
  pasteSummary(): Array<{ token: string; lines: number; chars: number }> {
    const text = this.text;
    return [...this.pastes].filter(([token]) => text.includes(token))
      .map(([token, content]) => ({ token, lines: content.split("\n").length, chars: content.length }));
  }

  setText(text: string, cursorAtEnd = true): void {
    this.checkpoint(false);
    this.g = graphemes(text);
    this.cursorIndex = cursorAtEnd ? this.g.length : 0;
    this.preferredCol = null;
    this.gcPastes();
  }

  clear(): void {
    if (this.g.length === 0 && this.pastes.size === 0) return;
    this.checkpoint(false);
    this.g = [];
    this.cursorIndex = 0;
    this.pastes.clear();
    this.preferredCol = null;
  }

  insert(text: string): void {
    if (!text) return;
    const parts = graphemes(text);
    const typing = parts.length === 1 && parts[0] !== "\n";
    this.checkpoint(typing);
    this.g.splice(this.cursorIndex, 0, ...parts);
    this.cursorIndex += parts.length;
    this.preferredCol = null;
  }

  newline(): void { this.insert("\n"); }

  /** Inserts pasted content; large content becomes a placeholder chip. */
  insertPaste(content: string): void {
    const normalized = content.replace(/\r\n?/g, "\n");
    const lines = normalized.split("\n").length;
    if (normalized.length >= PASTE_CHIP_MIN_CHARS || lines >= PASTE_CHIP_MIN_LINES) {
      const token = `[colado #${++this.pasteCounter}: ${lines} linha${lines === 1 ? "" : "s"}]`;
      this.pastes.set(token, normalized);
      this.insert(token);
      this.typingOpen = false;
      return;
    }
    this.insert(normalized);
    this.typingOpen = false;
  }

  backspace(): void {
    if (this.cursorIndex === 0) return;
    // Deleting into a chip removes the whole placeholder.
    const chip = this.chipEndingAt(this.cursorIndex);
    this.checkpoint(false);
    const count = chip ?? 1;
    this.g.splice(this.cursorIndex - count, count);
    this.cursorIndex -= count;
    this.preferredCol = null;
    this.gcPastes();
  }

  deleteForward(): void {
    if (this.cursorIndex >= this.g.length) return;
    this.checkpoint(false);
    this.g.splice(this.cursorIndex, 1);
    this.preferredCol = null;
    this.gcPastes();
  }

  deleteWordBackward(): void {
    if (this.cursorIndex === 0) return;
    const target = this.previousWordStart();
    this.checkpoint(false);
    this.g.splice(target, this.cursorIndex - target);
    this.cursorIndex = target;
    this.preferredCol = null;
    this.gcPastes();
  }

  deleteToLineStart(): void {
    const start = this.lineStart(this.cursorIndex);
    if (start === this.cursorIndex) { if (this.cursorIndex > 0) this.backspace(); return; }
    this.checkpoint(false);
    this.g.splice(start, this.cursorIndex - start);
    this.cursorIndex = start;
    this.gcPastes();
  }

  deleteToLineEnd(): void {
    const end = this.lineEnd(this.cursorIndex);
    if (end === this.cursorIndex) { this.deleteForward(); return; }
    this.checkpoint(false);
    this.g.splice(this.cursorIndex, end - this.cursorIndex);
    this.gcPastes();
  }

  left(): void { this.closeTyping(); if (this.cursorIndex > 0) this.cursorIndex--; this.preferredCol = null; }
  right(): void { this.closeTyping(); if (this.cursorIndex < this.g.length) this.cursorIndex++; this.preferredCol = null; }
  home(): void { this.closeTyping(); this.cursorIndex = this.lineStart(this.cursorIndex); this.preferredCol = null; }
  end(): void { this.closeTyping(); this.cursorIndex = this.lineEnd(this.cursorIndex); this.preferredCol = null; }
  docStart(): void { this.closeTyping(); this.cursorIndex = 0; }
  docEnd(): void { this.closeTyping(); this.cursorIndex = this.g.length; }

  wordLeft(): void { this.closeTyping(); this.cursorIndex = this.previousWordStart(); this.preferredCol = null; }
  wordRight(): void {
    this.closeTyping();
    const text = this.text;
    const starts = wordStarts(text);
    const next = starts.find((s) => s > this.cursorIndex);
    this.cursorIndex = next ?? this.g.length;
    this.preferredCol = null;
  }

  /** Moves between logical lines keeping the preferred cell column. Returns false at the edge. */
  up(): boolean { return this.vertical(-1); }
  down(): boolean { return this.vertical(1); }

  isOnFirstLine(): boolean { return this.lineStart(this.cursorIndex) === 0; }
  isOnLastLine(): boolean { return this.lineEnd(this.cursorIndex) === this.g.length; }

  undo(): boolean {
    const previous = this.undoStack.pop();
    if (!previous) return false;
    this.redoStack.push({ text: this.text, cursor: this.cursorIndex });
    this.restore(previous);
    return true;
  }

  redo(): boolean {
    const next = this.redoStack.pop();
    if (!next) return false;
    this.undoStack.push({ text: this.text, cursor: this.cursorIndex });
    this.restore(next);
    return true;
  }

  /** Wraps the text at `width` cells and locates the cursor in the wrapped rows. */
  view(width: number): BufferView {
    const safe = Math.max(4, width);
    const rows: string[] = [];
    let cursorRow = 0;
    let cursorCol = 0;
    let lineStart = 0;
    for (let i = 0; i <= this.g.length; i++) {
      if (i < this.g.length && this.g[i] !== "\n") continue;
      const line = this.g.slice(lineStart, i);
      for (const [from, to] of wrapSegments(line, safe)) {
        const absFrom = lineStart + from;
        const absTo = lineStart + to;
        const lastOfLine = to === line.length;
        if (this.cursorIndex >= absFrom && (this.cursorIndex < absTo || (lastOfLine && this.cursorIndex === absTo))) {
          cursorRow = rows.length;
          cursorCol = stringWidth(line.slice(from, this.cursorIndex - lineStart).join(""));
        }
        rows.push(line.slice(from, to).join("").replace(/\t/g, "    "));
      }
      lineStart = i + 1;
    }
    if (cursorCol >= safe) { cursorRow += 1; cursorCol = 0; if (cursorRow >= rows.length) rows.push(""); }
    return { rows, cursorRow, cursorCol };
  }

  // ─── internals ──────────────────────────────────────────────────────────

  private vertical(direction: -1 | 1): boolean {
    this.closeTyping();
    const start = this.lineStart(this.cursorIndex);
    const col = this.preferredCol ?? this.cellCol(start, this.cursorIndex);
    if (direction < 0) {
      if (start === 0) return false;
      const prevStart = this.lineStart(start - 1);
      this.cursorIndex = this.indexAtCol(prevStart, start - 1, col);
    } else {
      const end = this.lineEnd(this.cursorIndex);
      if (end === this.g.length) return false;
      const nextStart = end + 1;
      this.cursorIndex = this.indexAtCol(nextStart, this.lineEnd(nextStart), col);
    }
    this.preferredCol = col;
    return true;
  }

  private cellCol(from: number, to: number): number {
    let w = 0;
    for (let i = from; i < to; i++) w += graphemeWidth(this.g[i]!);
    return w;
  }

  private indexAtCol(from: number, to: number, col: number): number {
    let w = 0;
    for (let i = from; i < to; i++) {
      const gw = graphemeWidth(this.g[i]!);
      if (w + gw > col) return i;
      w += gw;
    }
    return to;
  }

  private lineStart(index: number): number {
    let i = index;
    while (i > 0 && this.g[i - 1] !== "\n") i--;
    return i;
  }

  private lineEnd(index: number): number {
    let i = index;
    while (i < this.g.length && this.g[i] !== "\n") i++;
    return i;
  }

  private previousWordStart(): number {
    const starts = wordStarts(this.text);
    let target = 0;
    for (const s of starts) { if (s < this.cursorIndex) target = s; else break; }
    return target;
  }

  private chipEndingAt(index: number): number | null {
    const before = this.g.slice(0, index).join("");
    for (const token of this.pastes.keys()) {
      if (before.endsWith(token)) return graphemes(token).length;
    }
    return null;
  }

  private gcPastes(): void {
    if (!this.pastes.size) return;
    const text = this.text;
    for (const token of [...this.pastes.keys()]) if (!text.includes(token)) this.pastes.delete(token);
  }

  private closeTyping(): void { this.typingOpen = false; }

  private checkpoint(typing: boolean): void {
    const now = this.now();
    if (typing && this.typingOpen && now - this.lastTypingAt < COALESCE_MS) {
      this.lastTypingAt = now;
      return;
    }
    this.undoStack.push({ text: this.text, cursor: this.cursorIndex });
    if (this.undoStack.length > UNDO_LIMIT) this.undoStack.shift();
    this.redoStack = [];
    this.typingOpen = typing;
    this.lastTypingAt = now;
  }

  private restore(snapshot: Snapshot): void {
    this.g = graphemes(snapshot.text);
    this.cursorIndex = Math.min(snapshot.cursor, this.g.length);
    this.preferredCol = null;
    this.typingOpen = false;
  }
}

/**
 * Splits one logical line (graphemes) into [from, to) rows of at most `width`
 * cells. Every grapheme belongs to exactly one row (spaces stay at the end of
 * the row they follow), so cursor positions map without loss.
 */
export function wrapSegments(line: readonly string[], width: number): Array<[number, number]> {
  if (line.length === 0) return [[0, 0]];
  const segments: Array<[number, number]> = [];
  let start = 0;
  let used = 0;
  let lastBreak = -1; // index after the last space in the current row
  for (let i = 0; i < line.length; i++) {
    const g = line[i]!;
    const w = g === "\t" ? 4 : graphemeWidth(g);
    if (used + w > width && i > start) {
      const cut = lastBreak > start ? lastBreak : i;
      segments.push([start, cut]);
      start = cut;
      used = 0;
      for (let j = start; j < i; j++) used += line[j] === "\t" ? 4 : graphemeWidth(line[j]!);
      lastBreak = -1;
    }
    used += w;
    if (/^\s$/.test(g)) lastBreak = i + 1;
  }
  segments.push([start, line.length]);
  return segments;
}
