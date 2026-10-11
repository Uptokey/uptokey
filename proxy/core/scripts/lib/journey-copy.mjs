/** J08: selecting text with the mouse copies exactly the logical text (Unicode, CJK, ZWJ emoji), even after a resize. */
import assert from "node:assert/strict";
import { readSystemClipboard, writeSystemClipboard } from "./system-clipboard.mjs";

const ENTER = "\r";
const EXPECTED = "Texto: Olá, 世界! café 👨‍👩‍👧 fim";

export async function copyJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("UNICODE por favor");
  await term.send(ENTER);
  await term.until(() => term.screen().includes("Texto:") && term.screen().includes("fim"), "the answer did not render", 30000);
  const locate = () => {
    const rows = term.screen().split("\n");
    const row = rows.findIndex((line) => line.includes("Texto:"));
    return { row, column: row >= 0 ? rows[row].indexOf("Texto:") : -1 };
  };
  let { row, column } = locate();
  assert.ok(row >= 0, "answer row found");
  capture("1. resposta unicode");
  // Drag across the whole row (SGR mouse: press, motion, release) in two different terminal sizes.
  for (const [cols, rows] of [[120, 36], [92, 30]]) {
    await writeSystemClipboard(`uptokey-copy-before-${cols}`);
    if (cols !== 120) {
      const beforeResize = term.raw().length;
      term.resize(cols, rows);
      await term.until(() => term.raw().length > beforeResize && term.screen().includes("Texto:"), "answer did not redraw after resize");
      await term.send("", 400);
      ({ row, column } = locate());
    }
    const y = row + 1;
    const startX = column + 1;
    const endX = cols - 2;
    await term.send(`\x1b[<0;${startX};${y}M`, 180);
    await term.send(`\x1b[<32;${Math.floor((startX + endX) / 2)};${y}M`, 180);
    await term.send(`\x1b[<32;${endX};${y}M`, 180);
    await term.send(`\x1b[<0;${endX};${y}m`, 180);
    await term.until(async () => (await readSystemClipboard()).equals(Buffer.from(EXPECTED, "utf8")), `native clipboard bytes differ after the drag at ${cols} columns`, 8000);
    assert.deepEqual(await readSystemClipboard(), Buffer.from(EXPECTED, "utf8"), `copied Unicode bytes differ at ${cols} columns`);
    checks[`copiedLogicalTextAt${cols}Columns`] = true;
  }
  capture("2. copiado");
  // The terminal is resized in the middle of a drag: whatever is copied must be the logical text the person chose,
  // with whole graphemes (never half of 世, of é or of the family emoji), or nothing at all.
  const sentinel = "uptokey-copy-before-resize-during-drag";
  await writeSystemClipboard(sentinel);
  ({ row, column } = locate());
  await term.send(`\x1b[<0;${column + 1};${row + 1}M`, 180);
  await term.send(`\x1b[<32;${column + 10};${row + 1}M`, 180);
  const beforeResize = term.raw().length;
  term.resize(110, 34);
  await term.until(() => term.raw().length > beforeResize && term.screen().includes("Texto:"), "answer did not redraw after the resize during the drag");
  await term.send("", 400);
  ({ row, column } = locate());
  await term.send(`\x1b[<32;${108};${row + 1}M`, 180);
  await term.send(`\x1b[<0;${108};${row + 1}m`, 180);
  await new Promise((done) => setTimeout(done, 1500));
  const clipboard = (await readSystemClipboard()).toString("utf8");
  const after = clipboard === sentinel ? [] : [clipboard];
  const graphemes = (text) => [...new Intl.Segmenter("pt", { granularity: "grapheme" }).segment(text)].map((part) => part.segment);
  const whole = new Set(graphemes(EXPECTED));
  for (const copied of after) {
    assert.ok(EXPECTED.includes(copied), `the copy after a resize during the drag is not text the person chose: ${JSON.stringify(copied)}`);
    assert.ok(graphemes(copied).every((grapheme) => whole.has(grapheme)), "a grapheme was split by the resize");
  }
  checks.resizeDuringDrag = after.length ? { copied: after.at(-1), exact: after.at(-1) === EXPECTED } : { copied: null, note: "selection cancelled by the resize; nothing was copied" };
  capture("3. redimensionado durante o arrasto");
}
