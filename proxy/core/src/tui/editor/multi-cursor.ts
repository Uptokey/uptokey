/**
 * This file incorporates code from Helix (https://github.com/helix-editor/helix),
 * which is licensed under the Mozilla Public License 2.0 (MPL-2.0).
 * 
 * Algorithm for coalescing overlapping/touching selection ranges.
 */
export interface Position { line: number; col: number }
export interface Selection { anchor: Position; head: Position }

export function coalesceSelections(
  selections: readonly Selection[],
  offsetAt: (pos: Position) => number,
  positionAt: (offset: number) => Position
): Selection[] {
  if (!selections.length) return [];
  
  const ranges = selections.map(s => {
    const a = offsetAt(s.anchor);
    const b = offsetAt(s.head);
    return {
      from: Math.min(a, b),
      to: Math.max(a, b),
      reverse: a > b
    };
  }).sort((a, b) => a.from - b.from || a.to - b.to);

  const normalized: typeof ranges = [];
  for (const r of ranges) {
    const last = normalized.at(-1);
    if (last && (r.from < last.to || r.from === last.from || (r.from === last.to && r.from === r.to))) {
      last.to = Math.max(last.to, r.to);
    } else {
      normalized.push({ ...r });
    }
  }

  return normalized.map(r => ({
    anchor: positionAt(r.reverse ? r.to : r.from),
    head: positionAt(r.reverse ? r.from : r.to)
  }));
}
