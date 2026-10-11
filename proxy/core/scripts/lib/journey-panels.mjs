/** Panels opened by Uptokey commands show the controller's real state (project, files, context, git, usage, diagnostics). */
import assert from "node:assert/strict";

const ENTER = "\r";
const ESC = "\x1b";

async function openCommand(term, command, expected, message) {
  await term.send(command);
  await term.until(() => term.screen().includes(command), "the command is not typed", 5000);
  await term.send(ENTER);
  // The slash list may need a second Enter: first completes, second runs.
  await new Promise((resolve) => setTimeout(resolve, 300));
  if (!expected.test(term.screen())) await term.send(ENTER);
  await term.until(() => expected.test(term.screen()), message, 15000);
}

async function close(term) {
  await term.send(ESC);
  await term.until(() => !/esc\s*$/m.test(term.screen().split("\n").slice(8, 16).join("\n")), "panel did not close", 2000);
  await new Promise((resolve) => setTimeout(resolve, 250));
}

export async function panelsJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);

  await openCommand(term, "/projetos", /Projeto .*project|Vincular outra pasta/, "projects panel did not open");
  assert.ok(/Vincular outra pasta/.test(term.screen()), "the link-another-folder action is offered");
  checks.projectsPanel = true;
  capture("1. projetos");
  await close(term);

  await openCommand(term, "/arquivos", /math\.js/, "files panel did not list the project files");
  checks.filesPanelListsProjectFiles = true;
  capture("2. arquivos");
  await term.send(ENTER);
  await new Promise((resolve) => setTimeout(resolve, 500));

  await openCommand(term, "/contexto", /math\.js/, "context panel did not show the added file");
  checks.contextPanelShowsAddedFile = true;
  capture("3. contexto");
  await close(term);

  await openCommand(term, "/git", /não é um repositório Git|not a Git repository|Git ·/, "git panel did not open");
  checks.gitPanel = true;
  capture("4. git");
  await close(term);

  await openCommand(term, "/uso", /Tokens estimados|Estimated tokens/, "usage panel did not open");
  checks.usagePanel = true;
  await close(term);

  await openCommand(term, "/doctor", /Conectado e pronto|Connected and ready/, "diagnostics summary did not open");
  checks.doctorAuthenticatedSummary = true;
  assert.ok(/Detalhes|Details/.test(term.screen()), "diagnostics offer the detailed state");
  await term.send(ENTER);
  await term.until(() => /Destino de inferência|Inference destination/.test(term.screen()), "diagnostics details did not open");
  assert.ok(term.screen().includes("custom-fixture") && term.screen().includes("fixture-coder"), "diagnostics name the exact destination");
  checks.doctorPanelNamesDestination = true;
  capture("5. diagnostico");
  assert.ok(info.cwd.length > 0);
}
