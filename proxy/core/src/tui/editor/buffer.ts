/** Selection-first in-memory editor. Independent TypeScript implementation informed by
 * Helix's MPL-2.0 transaction/selection model (helix-core/src/{transaction,selection}.rs).
 * Positions are grapheme columns; parser/transaction offsets are UTF-16. No disk effects. */
import { graphemes, graphemeWidth } from "../unicode.ts";
import { coalesceSelections } from "./multi-cursor.ts";
export interface Position { line: number; col: number }
export interface Selection { anchor: Position; head: Position }
export interface Change { from: Position; to: Position; insert: string; deleted: string }
export interface OffsetChange { from: number; to: number; insert: string }
export interface Transaction { id: string; timestamp: number; changes: Change[]; selections: Selection[]; previousSelections: Selection[] }
interface HistoryEntry extends Transaction { forward: OffsetChange[]; inverse: OffsetChange[]; bytes: number }
export type EditorMode = "normal" | "insert" | "select";
export type Direction = "left" | "right" | "up" | "down" | "home" | "end" | "pageup" | "pagedown";
const copy = (ss: readonly Selection[]): Selection[] => ss.map(s => ({ anchor: { ...s.anchor }, head: { ...s.head } }));
const word = (g: string) => /[\p{L}\p{N}_$]/u.test(g);
export class Buffer {
  readonly path: string;
  private text: string;
  private savedText: string;
  private lines: string[] = [];
  private starts: number[] = [];
  private clusters = new Map<number, string[]>();
  private _selections: Selection[] = [{ anchor: { line: 0, col: 0 }, head: { line: 0, col: 0 } }];
  private _mode: EditorMode = "normal";
  private _version = 0;
  private undoStack: HistoryEntry[] = [];
  private redoStack: HistoryEntry[] = [];
  private historyBytes = 0;
  private structuralHistory: Selection[][] = [];
  private desiredColumns: number[] = [];
  constructor(path: string, content: string) { this.path = path; this.text = content; this.savedText = content; this.index(); }
  get modified(): boolean { return this.text !== this.savedText; }
  get mode(): EditorMode { return this._mode; }
  get version(): number { return this._version; }
  get lineCount(): number { return this.lines.length; }
  get selections(): readonly Selection[] { return copy(this._selections); }
  get primarySelection(): Selection { return copy(this._selections)[0]!; }
  setMode(mode: EditorMode): void { this._mode = mode; }
  /** Confirm submitted content even when newer unsaved edits exist. */
  markSaved(content = this.text): void { this.savedText = content; }
  confirmSavedContent(content: string): void { this.savedText = content; }
  getLine(n: number): string { return this.lines[n] ?? ""; }
  getText(): string { return this.text; }
  lineGraphemes(line: number): readonly string[] {
    let gs = this.clusters.get(line);
    if (!gs) { gs = graphemes(this.getLine(line)); this.clusters.set(line, gs); }
    return gs;
  }
  private index(): void {
    const parts = this.text.split(/(\r?\n)/); this.lines = []; this.starts = []; this.clusters.clear();
    let offset = 0;
    for (let i = 0; i < parts.length; i += 2) { const line = parts[i]!; this.lines.push(line); this.starts.push(offset); offset += line.length + (parts[i + 1]?.length ?? 0); }
  }
  clamp(pos: Position): Position {
    const line = Math.max(0, Math.min(this.lineCount - 1, Math.trunc(pos.line) || 0));
    return { line, col: Math.max(0, Math.min(this.lineGraphemes(line).length, Math.trunc(pos.col) || 0)) };
  }
  offsetAt(pos: Position): number { const p = this.clamp(pos); return this.starts[p.line]! + this.lineGraphemes(p.line).slice(0, p.col).join("").length; }
  positionAt(offset: number): Position {
    offset = Math.max(0, Math.min(this.text.length, offset));
    let lo = 0, hi = this.starts.length - 1;
    while (lo < hi) { const mid = Math.ceil((lo + hi) / 2); if (this.starts[mid]! <= offset) lo = mid; else hi = mid - 1; }
    let units = this.starts[lo]!, col = 0;
    for (const g of this.lineGraphemes(lo)) { if (units >= offset) break; units += g.length; col++; }
    return { line: lo, col };
  }
  range(s: Selection): { from: number; to: number } { const a = this.offsetAt(s.anchor), b = this.offsetAt(s.head); return { from: Math.min(a, b), to: Math.max(a, b) }; }
  getContent(from: Position, to: Position): string { return this.text.slice(this.offsetAt(from), this.offsetAt(to)); }
  selectedTexts(): string[] { return this._selections.map(s => { const r = this.range(s); return this.text.slice(r.from, r.to); }); }
  setCursor(pos: Position): void { this.setSelections([{ anchor: pos, head: pos }]); }
  setSelections(ss: readonly Selection[], structural = false): void {
    if (!ss.length) return;
    if (!structural) this.structuralHistory = [];
    this.desiredColumns = [];
    this._selections = coalesceSelections(ss, p => this.offsetAt(p), o => this.positionAt(o));
  }
  keepPrimarySelection(): void { this.setSelections([this.primarySelection]); }
  collapseSelections(at: "start" | "end" | "head" = "head"): void {
    this.setSelections(this._selections.map(s => { const r = this.range(s), p = at === "head" ? s.head : this.positionAt(at === "start" ? r.from : r.to); return { anchor: p, head: p }; }));
  }
  private applyRaw(changes: readonly OffsetChange[]): void {
    let last = 0, next = "";
    for (const c of changes) { next += this.text.slice(last, c.from) + c.insert; last = c.to; }
    this.text = next + this.text.slice(last); this.index();
  }
  /** All ranges refer to the same original document, validated before mutation. */
  applyChanges(changes: readonly Change[]): void {
    for (const c of changes) if (this.offsetAt(c.from) > this.offsetAt(c.to) || this.getContent(c.from, c.to) !== c.deleted) throw new Error("Alteração divergente do buffer; nenhuma edição aplicada.");
    this.applyOffsetChanges(changes.map(c => ({ from: this.offsetAt(c.from), to: this.offsetAt(c.to), insert: c.insert })));
  }
  applyOffsetChanges(changes: readonly OffsetChange[]): void {
    if (!changes.length) return;
    const ordered = changes.map(c => ({ ...c })).sort((a, b) => a.from - b.from || a.to - b.to);
    for (let i = 0; i < ordered.length; i++) {
      const c = ordered[i]!, p = ordered[i - 1];
      if (!Number.isInteger(c.from) || !Number.isInteger(c.to) || c.from < 0 || c.to < c.from || c.to > this.text.length || this.offsetAt(this.positionAt(c.from)) !== c.from || this.offsetAt(this.positionAt(c.to)) !== c.to || (p && (c.from < p.to || c.from === p.from))) throw new Error("Intervalos inválidos ou sobrepostos; nenhuma edição aplicada.");
    }
    if (ordered.every(c => this.text.slice(c.from, c.to) === c.insert)) return;
    const previousSelections = copy(this._selections), inverse: OffsetChange[] = [], forwardChanges: Change[] = [], cursors: number[] = [];
    let delta = 0;
    for (const c of ordered) {
      const deleted = this.text.slice(c.from, c.to), from = c.from + delta;
      inverse.push({ from, to: from + c.insert.length, insert: deleted });
      forwardChanges.push({ from: this.positionAt(c.from), to: this.positionAt(c.to), insert: c.insert, deleted });
      cursors.push(from + c.insert.length); delta += c.insert.length - (c.to - c.from);
    }
    this.applyRaw(ordered); this.setSelections(cursors.map(o => { const p = this.positionAt(o); return { anchor: p, head: p }; }));
    const bytes = forwardChanges.reduce((sum, c) => sum + 2 * (c.insert.length + c.deleted.length) + 128, 0);
    this.undoStack.push({ id: `txn-${++this._version}`, timestamp: Date.now(), changes: forwardChanges, previousSelections, selections: copy(this._selections), forward: ordered, inverse, bytes });
    this.historyBytes += bytes; this.redoStack = [];
    while (this.undoStack.length > 1 && (this.undoStack.length > 1000 || this.historyBytes > 16 * 1024 * 1024)) this.historyBytes -= this.undoStack.shift()!.bytes;
  }
  insert(text: string | readonly string[]): void { this.applyOffsetChanges(this._selections.map((s, i) => ({ ...this.range(s), insert: typeof text === "string" ? text : text[i % text.length] ?? "" }))); }
  private step(pos: Position, direction: Direction, pageSize = 20): Position {
    const p = this.clamp(pos), size = this.lineGraphemes(p.line).length;
    switch (direction) {
      case "left": return p.col > 0 ? { line: p.line, col: p.col - 1 } : p.line > 0 ? { line: p.line - 1, col: this.lineGraphemes(p.line - 1).length } : p;
      case "right": return p.col < size ? { line: p.line, col: p.col + 1 } : p.line < this.lineCount - 1 ? { line: p.line + 1, col: 0 } : p;
      case "home": return { line: p.line, col: 0 };
      case "end": return { line: p.line, col: size };
      case "up": return this.clamp({ line: p.line - 1, col: p.col });
      case "down": return this.clamp({ line: p.line + 1, col: p.col });
      case "pageup": return this.clamp({ line: p.line - pageSize, col: p.col });
      case "pagedown": return this.clamp({ line: p.line + pageSize, col: p.col });
    }
  }
  moveCursor(direction: Direction, extend = false, pageSize = 20): void {
    const vertical = ["up", "down", "pageup", "pagedown"].includes(direction);
    const desired = this._selections.map((s, i) => {
      if (this.desiredColumns[i] !== undefined) return this.desiredColumns[i]!;
      let cells = 0;
      for (const g of this.lineGraphemes(s.head.line).slice(0, s.head.col)) cells += g === "\t" ? 4 - cells % 4 : graphemeWidth(g);
      return cells;
    });
    this.setSelections(this._selections.map((s, i) => {
      const head = this.step(s.head, direction, pageSize);
      if (vertical) {
        let cells = 0, col = 0;
        for (const g of this.lineGraphemes(head.line)) { const width = g === "\t" ? 4 - cells % 4 : graphemeWidth(g); if (cells + width > desired[i]!) break; cells += width; col++; }
        head.col = col;
      }
      return { anchor: extend ? s.anchor : head, head };
    }));
    if (vertical) this.desiredColumns = desired;
  }
  private deleteTowards(direction: "left" | "right"): void {
    const original = copy(this._selections), version = this.version;
    this.setSelections(this._selections.map(s => { const r = this.range(s); return r.from === r.to ? { anchor: s.anchor, head: this.step(s.head, direction) } : s; }));
    this.insert(""); if (this.version !== version) this.undoStack.at(-1)!.previousSelections = original;
  }
  backspace(): void { this.deleteTowards("left"); }
  deleteForward(): void { this.deleteTowards("right"); }
  undo(): boolean {
    const txn = this.undoStack.pop(); if (!txn) return false;
    this.applyRaw(txn.inverse); this._selections = copy(txn.previousSelections); this.redoStack.push(txn); this.historyBytes -= txn.bytes; this._version++; this.structuralHistory = []; return true;
  }
  redo(): boolean {
    const txn = this.redoStack.pop(); if (!txn) return false;
    this.applyRaw(txn.forward); this._selections = copy(txn.selections); this.undoStack.push(txn); this.historyBytes += txn.bytes; this._version++; this.structuralHistory = []; return true;
  }
  private wordRange(pos: Position): Selection {
    const p = this.clamp(pos), gs = this.lineGraphemes(p.line); let from = Math.min(p.col, Math.max(0, gs.length - 1)), to = from;
    if (word(gs[from] ?? "")) { while (from > 0 && word(gs[from - 1]!)) from--; while (to < gs.length && word(gs[to]!)) to++; }
    else to = Math.min(gs.length, from + 1);
    return { anchor: { line: p.line, col: from }, head: { line: p.line, col: to } };
  }
  wordAtCursor(): string { const s = this.wordRange(this.primarySelection.head); return this.getContent(s.anchor, s.head); }
  selectWord(extend = false): void { this.setSelections(this._selections.map(s => { const range = this.wordRange(s.head); return extend ? { anchor: s.anchor, head: range.head } : range; })); }
  selectLine(): void {
    this.setSelections(this._selections.map(s => { const r = this.range(s), from = this.positionAt(r.from), to = this.positionAt(r.to), last = to.col === 0 && to.line > from.line ? to.line - 1 : to.line;
      return { anchor: { line: from.line, col: 0 }, head: last < this.lineCount - 1 ? { line: last + 1, col: 0 } : { line: last, col: this.lineGraphemes(last).length } };
    }));
  }
  private wordPosition(pos: Position, forward: boolean): Position {
    const p = this.clamp(pos), gs = this.lineGraphemes(p.line); let col = p.col;
    if (forward) {
      if (col === gs.length) return this.step(p, "right");
      const wasWord = word(gs[col]!); col++;
      while (col < gs.length && word(gs[col]!) === wasWord && !/\s/u.test(gs[col]!)) col++;
      while (col < gs.length && /\s/u.test(gs[col]!)) col++;
    } else {
      if (!col) return this.step(p, "left");
      col--; while (col > 0 && /\s/u.test(gs[col]!)) col--;
      const wasWord = word(gs[col]!);
      while (col > 0 && word(gs[col - 1]!) === wasWord && !/\s/u.test(gs[col - 1]!)) col--;
    }
    return { line: p.line, col };
  }
  moveWordForward(extend = false): void { this.moveWord(true, extend); }
  moveWordBackward(extend = false): void { this.moveWord(false, extend); }
  private moveWord(forward: boolean, extend: boolean): void { this.setSelections(this._selections.map(s => { const head = this.wordPosition(s.head, forward); return { anchor: extend ? s.anchor : head, head }; })); }
  deleteWordBackward(): string {
    const original = copy(this._selections), version = this.version;
    this.setSelections(this._selections.map(s => this.range(s).from !== this.range(s).to ? s : { anchor: s.anchor, head: this.wordPosition(s.head, false) }));
    const deleted = this.selectedTexts().join("\n"); this.insert(""); if (this.version !== version) this.undoStack.at(-1)!.previousSelections = original; return deleted;
  }
  selectAll(): void { this.setSelections([{ anchor: { line: 0, col: 0 }, head: this.positionAt(this.text.length) }]); }
  /** Literal search avoids executing untrusted regex; matches cannot bisect graphemes. */
  find(query: string, from = 0): Selection | null {
    if (!query) return null;
    const findAfter = (start: number, end: number) => {
      let i = this.text.indexOf(query, start);
      while (i >= 0 && i < end) { const a = this.positionAt(i), b = this.positionAt(i + query.length);
        if (this.offsetAt(a) === i && this.offsetAt(b) === i + query.length) return { anchor: a, head: b };
        i = this.text.indexOf(query, i + 1);
      }
      return null;
    };
    return findAfter(from, this.text.length + 1) ?? findAfter(0, from);
  }
  selectMatches(query: string): number {
    if (!query) return 0;
    const found: Selection[] = []; let offset = 0;
    while (offset <= this.text.length && found.length < 1000) { const s = this.find(query, offset); if (!s) break; const r = this.range(s); if (r.from < offset) break; found.push(s); offset = r.to; }
    if (found.length) this.setSelections(found); return found.length;
  }
  addNextMatch(): boolean {
    if (!this.selectedTexts()[0]) this.selectWord();
    const query = this.selectedTexts()[0] ?? ""; let from = this.range(this._selections.at(-1)!).to;
    for (let n = 0; n <= this._selections.length; n++) { const s = this.find(query, from); if (!s) return false; const r = this.range(s);
      if (!this._selections.some(e => this.range(e).from === r.from && this.range(e).to === r.to)) { this.setSelections([...this._selections, s]); return true; } from = r.to;
    }
    return false;
  }
  expandSelections(expand: (from: number, to: number) => { from: number; to: number } | null): boolean {
    let changed = false;
    const next = this._selections.map(s => { const r = this.range(s), n = expand(r.from, r.to); if (!n || (n.from === r.from && n.to === r.to)) return s; changed = true; return { anchor: this.positionAt(n.from), head: this.positionAt(n.to) }; });
    if (changed) { this.structuralHistory.push(copy(this._selections)); this.setSelections(next, true); } return changed;
  }
  shrinkSelections(): boolean { const previous = this.structuralHistory.pop(); if (!previous) return false; this.setSelections(previous, true); return true; }

  addCursorUp(): void {
    const first = this._selections[0];
    if (!first) return;
    const p = this.clamp({ line: first.head.line - 1, col: first.head.col });
    this.setSelections([{ anchor: p, head: p }, ...this._selections]);
  }

  addCursorDown(): void {
    const last = this._selections[this._selections.length - 1];
    if (!last) return;
    const p = this.clamp({ line: last.head.line + 1, col: last.head.col });
    this.setSelections([...this._selections, { anchor: p, head: p }]);
  }
}
