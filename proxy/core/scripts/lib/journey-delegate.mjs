/** J13 slice: delegate one objective across two exact models; the plan needs approval; children run; the task is visible. */
import assert from "node:assert/strict";

const ENTER = "\r";
const DOWN = "\x1b[B";

export async function delegateJourney({ term, checks, capture, info, relaunch }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send("/delegar-modelos");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await term.send(ENTER);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await term.send(ENTER);
  await term.until(() => /Delegar entre modelos/.test(term.screen()) && /fixture-coder/.test(term.screen()), "the delegation panel did not open", 20000);
  checks.delegationPanelOpened = true;
  capture("1. painel de delegacao");
  // Rows: Continue, fixture-coder, fixture-small (order may vary): toggle the two model rows.
  await term.send(DOWN);
  await term.send(ENTER);
  await term.send(DOWN);
  await term.send(ENTER);
  await term.until(() => (term.screen().match(/☑/g) ?? []).length === 2, "two models were not selected");
  checks.twoModelsSelected = true;
  capture("2. dois modelos");
  // Back to the first row (Continue) and go on.
  await term.send("\x1b[A");
  await term.send("\x1b[A");
  await term.send(ENTER);
  await term.until(() => /Delegar entre modelos/.test(term.screen()) && /Objetivo/.test(term.screen()), "objective prompt did not appear", 10000);
  await term.send("Resumir o projeto");
  await term.send(ENTER);
  await term.until(() => /Limite em USD/.test(term.screen()), "budget prompt did not appear", 10000);
  await term.send("0.50");
  await term.send(ENTER);
  await term.until(() => /subtarefa por modelo/.test(term.screen()), "subtasks prompt did not appear", 10000);
  await term.send("Resumir arquivos | Listar riscos");
  await term.send(ENTER);
  await term.until(() => /Aprovação necessária|Approval required/.test(term.screen()), "the plan approval was not requested", 40000);
  checks.planNeedsApproval = true;
  capture("3. aprovacao do plano");
  const before = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).length;
  await term.send(ENTER);
  await term.until(() => term.screen().includes("2/2 modelos responderam"), "the delegation result was not reported", 90000);
  await term.until(() => /Resposta do modelo fixture-coder para: Resumir arquivos/.test(term.screen()) && /Resposta do modelo fixture-small para: Listar riscos/.test(term.screen()), "each model's answer to its own subtask is not shown", 15000);
  checks.delegatedTaskVisible = true;
  checks.eachModelAnsweredItsSubtask = true;
  capture("4. tarefa delegada");
  // Exactly one call per member reached the upstream, each to the model chosen for it (single execution).
  const calls = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).slice(before);
  checks.upstreamCalls = calls;
  assert.deepEqual(calls.map((call) => call.model).sort(), ["fixture-coder", "fixture-small"], "delegation did not call each chosen model exactly once");
  checks.singleExecutionPerMember = true;
  // The run is persisted by the core and survives a new window.
  const headers = { authorization: `Bearer ${info.token}` };
  const runsOf = async () => {
    const projects = await (await fetch(`${info.baseUrl}/v1/workspace/projects`, { headers })).json();
    const all = [];
    for (const project of projects.projects ?? []) all.push(...((await (await fetch(`${info.baseUrl}/v1/workspace/projects/${project.id}/multimodel-runs`, { headers })).json()).runs ?? []));
    return all;
  };
  const runs = await runsOf();
  assert.equal(runs.length, 1, "more than one delegated run exists");
  assert.equal(runs[0].status, "succeeded");
  assert.deepEqual(runs[0].branches.map((branch) => branch.actualModel).sort(), ["fixture-coder", "fixture-small"]);
  checks.persistedRun = { status: runs[0].status, branches: runs[0].branches.map((branch) => ({ model: branch.actualModel, status: branch.status, artifacts: branch.artifactRefs.length })) };
  await term.send("\x03");
  await term.until(() => term.exited().exited, "window did not exit", 10000).catch(() => {});
  const second = await relaunch();
  await second.until(() => second.screen().includes("fixture-coder"), "second window did not open", 30000);
  const after = await runsOf();
  assert.equal(after.length, 1, "reopening created or repeated a run");
  assert.equal(after[0].id, runs[0].id);
  checks.sameRunAfterReopen = true;
  const callsAfter = (await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).slice(before);
  assert.equal(callsAfter.length, 2, "reopening re-executed a member");
  checks.notReexecutedAfterReopen = true;
  // The results stay reachable in the new window: /comparacoes lists the run, /comparacoes <id> shows each answer.
  await second.send("/comparacoes");
  await new Promise((resolve) => setTimeout(resolve, 400));
  await second.send(ENTER);
  await new Promise((resolve) => setTimeout(resolve, 300));
  await second.send(ENTER);
  await second.until(() => second.screen().includes(runs[0].id) && /concluída/.test(second.screen()), "the run is not listed after reopening", 20000);
  checks.listedAfterReopen = true;
  await second.send(`/comparacoes ${runs[0].id}`);
  await new Promise((resolve) => setTimeout(resolve, 400));
  await second.send(ENTER);
  await second.until(() => /Resposta do modelo fixture-coder para: Resumir arquivos/.test(second.screen()) && /Resposta do modelo fixture-small para: Listar riscos/.test(second.screen()), "the answers are not shown after reopening", 20000);
  checks.answersAfterReopen = true;
  assert.equal((await (await fetch(`http://127.0.0.1:${info.upstreamPort}/__requests`)).json()).slice(before).length, 2, "showing the results re-executed a member");
  checks.viewingDoesNotReexecute = true;
}
