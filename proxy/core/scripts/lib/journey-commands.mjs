/** Slash commands from the Uptokey registry are listed, completed and executed through the new frontend. */
const ENTER = "\r";

export async function commandsJourney({ term, checks, capture }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("/modelos");
  await term.until(() => /modelos/.test(term.screen()), "command list did not show the Uptokey command", 15000);
  checks.uptokeyCommandListed = true;
  capture("1. autocompletar /modelos");
  await term.send(ENTER);
  await term.send(ENTER);
  await term.until(() => /fixture-small/.test(term.screen()), "the models dialog did not open from /modelos", 20000);
  checks.modelsDialogOpened = true;
  capture("2. dialogo de modelos");
  // A command answered by the controller on the home screen (no conversation yet) still gives visible feedback.
  await term.send("\x1b");
  await term.until(() => !/fixture-small/.test(term.screen()), "the models dialog did not close", 10000);
  await new Promise((done) => setTimeout(done, 200));
  await term.send("/processamento local");
  await new Promise((done) => setTimeout(done, 400));
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 300));
  if (/processamento local/.test(term.screen())) await term.send(ENTER);
  await term.until(() => /somente locais/.test(term.screen()), "the notice of a command run on the home screen was not shown", 15000);
  checks.homeNoticeShown = true;
  capture("3. aviso na tela inicial");
}
