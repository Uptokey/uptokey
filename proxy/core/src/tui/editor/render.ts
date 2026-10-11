import { graphemeWidth } from "../unicode.ts";
import type { Buffer, Selection } from "./buffer.ts";
import type { Token } from "./highlight.ts";
export interface EditorSpan { text: string; color: string; selected: boolean; cursor: boolean }
export const visibleGrapheme = (g: string): string => g.replace(/[\x00-\x1f\x7f-\x9f\u202a-\u202e\u2066-\u2069]/g, "�");
/** Clip by terminal cells, retaining complete graphemes and exposing controls safely. */
export function editorLine(buffer: Buffer, line: number, tokens: readonly Token[], selections: readonly Selection[], column: number, width: number): EditorSpan[] {
  const spans: EditorSpan[] = [], gs = buffer.lineGraphemes(line), lineStart = buffer.offsetAt({ line, col: 0 });
  const ranges = selections.map(s => buffer.range(s));
  let units = 0, cell = 0, tokenIndex = 0, tokenEnd = tokens[0]?.text.length ?? 0;
  for (let col = 0; col <= gs.length; col++) {
    const g = gs[col] ?? " ";
    while (tokenEnd <= units && tokenIndex < tokens.length - 1) tokenEnd += tokens[++tokenIndex]!.text.length;
    const cursor = selections.some(s => s.head.line === line && s.head.col === col);
    if (col === gs.length && !cursor && !ranges.some(r => r.from <= lineStart + units && r.to > lineStart + units)) break;
    const text = g === "\t" ? " ".repeat(4 - cell % 4) : visibleGrapheme(g);
    const cells = g === "\t" ? text.length : graphemeWidth(text);
    const selected = ranges.some(r => r.from <= lineStart + units && r.to > lineStart + units);
    if (cell + cells > column && cell < column + width) {
      const partial = cell < column || cell + cells > column + width;
      const piece = partial ? " ".repeat(Math.max(0, Math.min(cell + cells, column + width) - Math.max(cell, column))) : text;
      const style = { color: tokens[tokenIndex]?.color ?? "white", selected, cursor };
      const last = spans.at(-1);
      if (last && last.color === style.color && last.selected === selected && last.cursor === cursor) last.text += piece;
      else spans.push({ text: piece, ...style });
    }
    cell += cells; units += g.length;
    if (cell >= column + width) break;
  }
  return spans;
}
export function cursorCell(buffer: Buffer, line: number, col: number): number {
  let cell = 0; for (const g of buffer.lineGraphemes(line).slice(0, col)) cell += g === "\t" ? 4 - cell % 4 : graphemeWidth(visibleGrapheme(g)); return cell;
}
