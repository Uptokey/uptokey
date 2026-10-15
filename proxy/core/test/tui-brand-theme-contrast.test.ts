import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const palette = JSON.parse(readFileSync(new URL("../src/tui/frontend/vendor/opencode-tui/theme/assets/uptokey.json", import.meta.url), "utf8")) as {
  defs: Record<string, string>;
  theme: Record<string, { light: string; dark: string }>;
};

function color(token: string): string {
  const value = palette.theme[token]?.light;
  assert.ok(value, `Missing light theme token: ${token}`);
  const resolved = palette.defs[value] ?? value;
  assert.match(resolved, /^#[a-f\d]{6}$/i);
  return resolved;
}

function luminance(hex: string): number {
  const channels = hex.slice(1).match(/../g)!.map((value) => {
    const channel = parseInt(value, 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return channels[0]! * 0.2126 + channels[1]! * 0.7152 + channels[2]! * 0.0722;
}

function readable(foreground: string, background: string): void {
  const a = luminance(color(foreground));
  const b = luminance(color(background));
  const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
  assert.ok(ratio >= 4.5, `${foreground} on ${background}: ${ratio.toFixed(2)}:1, requires 4.5:1 for terminal text`);
}

test("light terminal text remains readable on each normal UI surface", () => {
  const tokens = [
    "primary", "secondary", "accent", "error", "warning", "success", "info", "text", "textMuted",
    ...Object.keys(palette.theme).filter((key) => /^(markdown|syntax)/.test(key) && key !== "markdownHorizontalRule"),
  ];
  for (const token of tokens) {
    for (const background of ["background", "backgroundPanel", "backgroundElement"]) readable(token, background);
  }
});

test("light diff text remains readable on its actual addition and deletion backgrounds", () => {
  for (const token of ["diffAdded", "diffHighlightAdded"]) readable(token, "diffAddedBg");
  for (const token of ["diffRemoved", "diffHighlightRemoved"]) readable(token, "diffRemovedBg");
  readable("diffContext", "diffContextBg");
  for (const background of ["diffContextBg", "diffAddedLineNumberBg", "diffRemovedLineNumberBg"]) readable("diffLineNumber", background);
  readable("diffHunkHeader", "backgroundElement");
});
