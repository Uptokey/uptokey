/**
 * Uptokey identity for the terminal: the icon mark (Dodger #017AFF over Neon #6C47FF, drawn in half-cells after the
 * official icon) and a legible "UPTOKEY" wordmark in the theme's text colours.
 */
import { RGBA, TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { For, Show } from "solid-js"
import { useTheme } from "../vendor/opencode-tui/context/theme"

export const BRAND = {
  dodger: RGBA.fromHex("#017AFF"),
  neon: RGBA.fromHex("#6C47FF"),
}

// The Uptokey icon in half-cells: hexagonal silhouette, the left column joined to the central stem by the bowl,
// the flag at the top of the stem and the right column under the sloped roof.
const MARK = [
  "          █████▀",
  "    ▄▄██  ██   ██▄▄",
  "  ██████  ██   ██████",
  "  ██████  ██   ██████",
  "  ██████  ██   ██████",
  "  ██████  ██   ██████",
  "  ▀█████████   █████▀",
  "     ▀▀▀▀▀▀    ▀▀▀",
]

const FONT: Record<string, string[]> = {
  U: ["10001", "10001", "10001", "10001", "10001", "11011", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
}

/** Packs two bitmap rows into one terminal row with half blocks. */
export function wordmarkRows(word: string): string[] {
  const letters = [...word].map((letter) => FONT[letter] ?? FONT.U!)
  const rows = Array.from({ length: 7 }, (_, row) => letters.map((glyph) => glyph[row]).join("0"))
  const packed: string[] = []
  for (let row = 0; row < rows.length; row += 2) {
    const top = rows[row]!
    const bottom = rows[row + 1] ?? "".padEnd(top.length, "0")
    packed.push(
      [...top]
        .map((cell, column) => {
          const above = cell === "1"
          const below = bottom[column] === "1"
          return above && below ? "█" : above ? "▀" : below ? "▄" : " "
        })
        .join(""),
    )
  }
  return packed
}

export const WORDMARK = wordmarkRows("UPTOKEY")
// Lines are centred one by one: the same width keeps the mark's columns aligned.
const MARK_WIDTH = Math.max(...MARK.map((line) => line.length))

export function UptokeyLogo() {
  const { theme } = useTheme()
  const dimensions = useTerminalDimensions()
  const showMark = () => dimensions().height >= 30
  return (
    <box alignItems="center">
      <Show when={showMark()}>
        <For each={MARK.map((line) => line.padEnd(MARK_WIDTH))}>
          {(line, index) => (
            <text fg={index() < 4 ? BRAND.dodger : BRAND.neon} selectable={false}>
              {line}
            </text>
          )}
        </For>
        <box height={1} />
      </Show>
      <For each={WORDMARK}>
        {(line) => (
          <text fg={theme.text} attributes={TextAttributes.BOLD} selectable={false}>
            {line}
          </text>
        )}
      </For>
    </box>
  )
}
