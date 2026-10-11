/**
 * Uptokey TUI — semantic colours for the renderer.
 *
 * Components ask for a tone (accent, danger, …), never a raw colour. NO_COLOR
 * removes colours but keeps bold/inverse so focus and state never depend on
 * colour alone; high contrast drops dim text.
 */
import type { Tone } from "./transcript.ts";

export type ThemeName = "dark" | "light" | "high-contrast" | "mono";

export interface UiTheme {
  name: ThemeName;
  color(tone: Tone | undefined): string | undefined;
  /** Whether secondary text may use the terminal's dim attribute. */
  dim: boolean;
}

const DARK: Record<Tone, string | undefined> = {
  plain: "#F2F2F7", user: "#0A84FF", assistant: "#5E5CE6", muted: "#98989D", accent: "#FF9F0A",
  success: "#32D74B", warning: "#FFD60A", danger: "#FF453A", code: "#FF375F", heading: "#FFFFFF", link: "#0A84FF",
};
const LIGHT: Record<Tone, string | undefined> = {
  plain: "#1C1C1E", user: "#007AFF", assistant: "#5856D6", muted: "#8E8E93", accent: "#FF9500",
  success: "#34C759", warning: "#FFCC00", danger: "#FF3B30", code: "#FF2D55", heading: "#000000", link: "#007AFF",
};
const HIGH: Record<Tone, string | undefined> = {
  plain: "whiteBright", user: "cyanBright", assistant: "whiteBright", muted: "white", accent: "yellowBright",
  success: "greenBright", warning: "yellowBright", danger: "redBright", code: "whiteBright", heading: "yellowBright", link: "cyanBright",
};

export function resolveThemeName(requested: string | undefined, env: NodeJS.ProcessEnv = process.env): ThemeName {
  // The desktop launcher may set NO_COLOR globally for logs.  The interactive
  // TUI opts back into its accessible colour system unless the user explicitly
  // selects `UPTOKEY_TUI_COLOR=0` or a monochrome theme.
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "" && env.UPTOKEY_TUI_COLOR !== "1") return "mono";
  const value = (requested ?? env.UPTOKEY_TUI_THEME ?? "auto").toLowerCase();
  if (value === "mono" || value === "sem-cor") return "mono";
  if (value.startsWith("alto") || value === "high-contrast") return "high-contrast";
  if (value === "claro" || value === "light") return "light";
  if (value === "escuro" || value === "dark") return "dark";
  // Default to light for Apple-style aesthetic if requested, but respect terminal background.
  // COLORFGBG "15;0" = light text on dark background (the common default).
  const bg = Number((env.COLORFGBG ?? "").split(";").at(-1));
  return Number.isFinite(bg) && bg >= 7 && bg !== 8 ? "light" : "dark";
}

export function createTheme(name: ThemeName): UiTheme {
  const table = name === "light" ? LIGHT : name === "high-contrast" ? HIGH : DARK;
  return {
    name,
    color: (tone) => (name === "mono" ? undefined : table[tone ?? "plain"]),
    dim: name !== "high-contrast",
  };
}
