/**
 * Mouse clicks never leave the keyboard on nothing: after a click on the logo, on the prompt's padding, on its text
 * line and on empty space, typed text still reaches the prompt (a click on the padding used to drop every key).
 */
const pause = (ms) => new Promise((done) => setTimeout(done, ms));

export async function clickJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  const rows = term.screen().split("\n");
  const promptRow = rows.findIndex((line) => /┃/.test(line));
  const textRow = rows.findIndex((line, index) => index > promptRow && /┃\s+\S/.test(line));
  if (promptRow < 0 || textRow < 0) throw new Error("the prompt box was not found");
  const column = rows[textRow].indexOf("┃") + 10;
  const targets = { logo: [60, 3], padding: [column, promptRow + 1], text: [column, textRow + 1], empty: [5, rows.length - 4] };
  for (const [name, [x, y]] of Object.entries(targets)) {
    await term.send(`\x1b[<0;${x};${y}M`);
    await term.send(`\x1b[<0;${x};${y}m`);
    await pause(400);
    const word = `clk${name}`;
    await term.send(word);
    await term.until(() => term.screen().includes(word), `typing after a click on the ${name} was dropped`, 5000);
    for (let i = 0; i < word.length; i++) await term.send("\x7f", 20);
    checks[`typedAfter_${name}`] = true;
  }
  capture("clicks never take the keyboard away");
}
