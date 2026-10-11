/**
 * J17 (Git slice) — a real Git repository in the fixture project: /git lists the changed file, the diff view shows
 * the changed line, and staging goes through the core (intention + W5 run) and changes the real index.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";

const ENTER = "\r";
const DOWN = "\x1b[B";

function git(cwd, ...args) {
  return execFileSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "commit.gpgsign=false", "-c", "core.autocrlf=false", ...args], { cwd, encoding: "utf8", windowsHide: true }).trim();
}

export function prepareGitFixture(cwd) {
  git(cwd, "init", "-q");
  git(cwd, "add", "-A");
  git(cwd, "commit", "-q", "-m", "fixture");
}

export async function gitJourney({ term, checks, capture, info }) {
  prepareGitFixture(info.cwd);
  await writeFile(join(info.cwd, "README.md"), "# Projeto de teste\n\nMarcador FIXTURE_MARKER_7731.\nLinha alterada GIT_CHANGE_4471.\n");
  assert.equal(git(info.cwd, "status", "--porcelain"), "M README.md");
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("/git");
  await term.until(() => /\bgit\b/.test(term.screen()), "command list did not show /git", 10000);
  await term.send(ENTER);
  await new Promise((done) => setTimeout(done, 200));
  await term.send(ENTER);
  await term.until(() => term.screen().includes("README.md"), "the Git panel does not list the changed file", 20000);
  checks.changedFileListed = true;
  capture("1. painel Git");
  // Choose the changed file, then the diff action.
  for (let attempt = 0; attempt < 6 && !/GIT_CHANGE_4471/.test(term.screen()); attempt++) {
    await term.send(ENTER);
    await new Promise((done) => setTimeout(done, 400));
    if (/README\.md/.test(term.screen()) && !/GIT_CHANGE_4471/.test(term.screen())) {
      await term.send(ENTER);
      await new Promise((done) => setTimeout(done, 600));
    }
    if (!/GIT_CHANGE_4471/.test(term.screen())) {
      await term.send("\x1b");
      await new Promise((done) => setTimeout(done, 300));
      await term.send(DOWN);
    }
  }
  assert.match(term.screen(), /GIT_CHANGE_4471/, "the diff view does not show the changed line");
  checks.diffShowsChange = true;
  capture("2. diff do arquivo");
  checks.indexBeforeStage = git(info.cwd, "diff", "--cached", "--name-only");
  assert.equal(checks.indexBeforeStage, "", "the index changed before staging was chosen");
  // Back to the panel: stage the file through the core (intention + W5 plan + receipt), then commit the same way.
  const reopenPanel = async () => {
    for (let attempt = 0; attempt < 4 && !/Git · /.test(term.screen()); attempt++) {
      await term.send("\x1b");
      await new Promise((done) => setTimeout(done, 300));
    }
    if (!/Git · /.test(term.screen())) {
      await term.send("/git");
      await new Promise((done) => setTimeout(done, 300));
      await term.send(ENTER);
      await new Promise((done) => setTimeout(done, 600));
      // The first Enter may only complete the command in the list; a second one runs it.
      if (!/Git · /.test(term.screen())) await term.send(ENTER);
    }
    await term.until(() => /Git · /.test(term.screen()), "the Git panel did not come back", 20000);
    await new Promise((done) => setTimeout(done, 300));
  };
  await reopenPanel();
  await term.send("README");
  await new Promise((done) => setTimeout(done, 300));
  await term.send(ENTER);
  await term.until(() => /preparar \(stage\)/.test(term.screen()), "the file menu did not offer staging", 10000);
  await term.send("preparar");
  await new Promise((done) => setTimeout(done, 300));
  await term.send(ENTER);
  await term.until(() => git(info.cwd, "diff", "--cached", "--name-only") === "README.md", "staging did not reach the real index", 60000);
  checks.stagedThroughCore = true;
  capture("3. arquivo preparado");
  await reopenPanel();
  await term.send("commit");
  await new Promise((done) => setTimeout(done, 300));
  await term.send(ENTER);
  await term.until(() => /Mensagem do commit/.test(term.screen()), "the commit message prompt did not open", 10000);
  await term.send("Atualiza README pela TUI");
  await term.send(ENTER);
  await term.until(() => { try { return git(info.cwd, "log", "-1", "--format=%s") === "Atualiza README pela TUI"; } catch { return false; } }, "the commit was not recorded", 60000);
  assert.equal(git(info.cwd, "status", "--porcelain"), "", "the working tree is not clean after the commit");
  checks.committedThroughCore = true;
  capture("4. commit registrado");
}
