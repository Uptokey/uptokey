/** Uptokey's two-module mark, drawn in terminal cells from the official silhouette. */
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { useTheme } from "../vendor/opencode-tui/context/theme"

export const BRAND = {
  dodger: RGBA.fromHex("#017AFF"),
  neon: RGBA.fromHex("#6C47FF"),
}

// Each module keeps one colour: the ascending U and the returning channel.
// Fixed-width rows keep the negative space intact across terminal fonts.
export const MARK = [
  ["         ▄▄▄    ", "                "],
  ["        ███     ", "                "],
  [" ▄▄██   █       ", "           ▄██▄ "],
  ["█████   █       ", "           █████"],
  ["█████████       ", "           █████"],
  [" ▀█████▀        ", "        ▄▄███▀▀ "],
  ["                ", "      ▀██▀▀     "],
] as const

const FONT: Record<string, string[]> = {
  U: ["1001", "1001", "1001", "1001", "1001", "1001", "0110"],
  P: ["1110", "1001", "1001", "1110", "1000", "1000", "1000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  O: ["0110", "1001", "1001", "1001", "1001", "1001", "0110"],
  K: ["1001", "1001", "1010", "1100", "1010", "1001", "1001"],
  E: ["1111", "1000", "1000", "1110", "1000", "1000", "1111"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
}

/** Packs two bitmap rows into one terminal row with half blocks. */
export function wordmarkRows(word: string): string[] {
  const letters = [...word.toUpperCase()].map((letter) => FONT[letter] ?? FONT.U!)
  const rows = Array.from({ length: 7 }, (_, row) => letters.map((glyph) => glyph[row]).join("0"))
  const packed: string[] = []
  for (let row = 0; row < rows.length; row += 2) {
    const top = rows[row]!
    const bottom = rows[row + 1] ?? "".padEnd(top.length, "0")
    packed.push(
      [...top].map((cell, column) => {
        const above = cell === "1"
        const below = bottom[column] === "1"
        return above && below ? "█" : above ? "▀" : below ? "▄" : " "
      }).join(""),
    )
  }
  return packed
}

export const WORDMARK = wordmarkRows("UPTOKEY")

const MARK_WIDTH = MARK[0][0].length
const LOCKUP_WIDTH = MARK_WIDTH + 3 + WORDMARK[0]!.length
const MARK_ROWS = MARK.map(([left, right]) => {
  const spans: { text: string; colour: "dodger" | "neon" }[] = []
  for (let column = 0; column < MARK_WIDTH; column++) {
    const colour = left[column] !== " " ? "dodger" : "neon"
    const cell = left[column] !== " " ? left[column]! : right[column]!
    const last = spans[spans.length - 1]
    if (last?.colour === colour) last.text += cell
    else spans.push({ text: cell, colour })
  }
  return spans
})

/** Leave room for the composer and never clip a wordmark in a narrow split. */
export function brandLayout(width: number, height: number): "wordmark" | "name" | "compact" {
  if (height < 24 || width < 30) return "compact"
  return width >= LOCKUP_WIDTH + 4 ? "wordmark" : "name"
}

function Symbol() {
  return (
    <box width={MARK_WIDTH} height={MARK.length} flexShrink={0}>
      <For each={MARK_ROWS}>
        {(spans) => (
          <text height={1} selectable={false}>
            <For each={spans}>
              {(span) => <span style={{ fg: BRAND[span.colour] }}>{span.text}</span>}
            </For>
          </text>
        )}
      </For>
    </box>
  )
}

export function UptokeyLogo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const layout = () => brandLayout(dimensions().width, dimensions().height)
  return (
    <box alignItems="center" flexShrink={0}>
      <Show when={layout() !== "compact"} fallback={
        <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>Uptokey</text>
      }>
        <box flexDirection="row" alignItems="center" gap={3}>
          <Symbol />
          <Show when={layout() === "wordmark"} fallback={
            <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>Uptokey</text>
          }>
            <box>
              <For each={WORDMARK}>
                {(line) => <text height={1} fg={theme.text} selectable={false}>{line}</text>}
              </For>
            </box>
          </Show>
        </box>
      </Show>
    </box>
  )
}
