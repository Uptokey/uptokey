/** J05: a folder named in ordinary text is offered, confirmed, bound, and its file is really read by the model's tool. */
import assert from "node:assert/strict";

const ENTER = "\r";

export async function folderJourney({ term, checks, capture, info }) {
  await term.until(() => term.screen().includes("fixture-coder"), "model is not visible", 30000);
  await term.send(`Trabalhe nesta pasta: ${info.cwdB} PASTA_B e leia o arquivo de notas`);
  await term.send(ENTER);
  await term.until(() => /Trabalhar na pasta|Work in the folder/.test(term.screen()), "the folder confirmation did not appear", 20000);
  checks.folderConfirmationShown = true;
  capture("1. confirmacao da pasta");
  await term.send(ENTER);
  await term.until(() => /Marcador lido pela ferramenta: MARKER_B_4410/.test(term.screen()), "the model did not read the marker through the bound folder", 60000);
  checks.markerReadThroughBoundFolder = true;
  capture("2. marcador lido");
  assert.ok(!info.cwdB.includes("MARKER_B_4410"), "the marker is not part of the request");
  const projects = await (await fetch(`${info.baseUrl}/v1/workspace/projects`, { headers: { authorization: `Bearer ${info.token}` } })).json();
  assert.ok((projects.projects ?? []).length >= 2, "the second folder became a project");
  checks.secondProjectCreated = true;
}
