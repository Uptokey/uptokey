/** Editor coordinates are zero-based UTF-16 positions, matching the LSP/editor contract. */
export interface ContextRange {
  start: { line: number; character: number }
  end: { line: number; character: number }
}

export function contextRanges(value: unknown): ContextRange[] | null {
  if (!Array.isArray(value) || !value.length || value.length > 8) return null
  const result: ContextRange[] = []
  for (const item of value) {
    if (!item || typeof item !== "object") return null
    const range = "selection" in item ? item.selection : item
    if (!range || typeof range !== "object" || !("start" in range) || !("end" in range)) return null
    const positions = [range.start, range.end]
    if (positions.some((position) => !position || typeof position !== "object" || !("line" in position) || !("character" in position)
      || !Number.isSafeInteger(position.line) || Number(position.line) < 0 || !Number.isSafeInteger(position.character) || Number(position.character) < 0)) return null
    const start = range.start as ContextRange["start"]
    const end = range.end as ContextRange["end"]
    if (end.line < start.line || end.line === start.line && end.character <= start.character) return null
    result.push({ start: { line: start.line, character: start.character }, end: { line: end.line, character: end.character } })
  }
  return result
}

/** Uses the core's verified text, never the editor's untrusted supplied excerpt. */
export function selectedContextText(text: string, ranges: readonly ContextRange[]): string {
  const lines = text.split(/\r?\n/)
  return ranges.map(({ start, end }) => {
    if (start.line >= lines.length || end.line >= lines.length || start.character > lines[start.line]!.length || end.character > lines[end.line]!.length) throw new Error("context_range_invalid")
    const selected = lines.slice(start.line, end.line + 1)
    if (start.line === end.line) selected[0] = selected[0]!.slice(start.character, end.character)
    else { selected[0] = selected[0]!.slice(start.character); selected[selected.length - 1] = selected[selected.length - 1]!.slice(0, end.character) }
    return `#${start.line + 1}:${start.character + 1}-${end.line + 1}:${end.character + 1}\n${selected.join("\n")}`
  }).join("\n\n")
}
